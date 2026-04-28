// embedder.js — plugin walker for graph node embeddings.
//
// Plugins register concrete embedders via `registerEmbedder(name, factory,
// { dim, isConfigured })`. This module resolves the active embedder at
// call time, caches the instance, and exposes the same external API the
// rest of the graph code already calls: `embedNode`, `embedNodeAsync`,
// `embedText`, `buildNodeText`. With no embedder plugin installed, every
// call no-ops gracefully (vectorSearch returns [], hybrid degrades to
// keyword) — same behavior as the legacy "GEMINI_API_KEY not set" path.
//
// Stored vectors are tagged with provider name + dim, so toggling
// embedders is safe: vectorSearch filters by the active provider/dim and
// the maintainer's sweeper re-embeds rows whose stored tags don't match.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function graphDbPath() {
  return process.env.GRAPH_DB_PATH || path.join(__dirname, 'data', 'graph.db');
}

let _manager = null;
let _log = null;   // structured logger captured from manager — drives verbose embed logs
let _cache = null; // { name, dim, instance }

/**
 * Wire the plugin manager. Called from src/app.js after pluginManager.initAll().
 * The walker resolves lazily, so callers don't need to wait for this to land
 * — they'll just no-op until it does.
 *
 * Also ensures the per-row provider/dim tagging columns exist on the live
 * graph DB. retrieval.vectorSearch and the maintainer sweeper both
 * reference them; running the idempotent ALTER once here avoids a "no
 * such column" race on first startup after upgrade.
 */
function setManager(manager) {
  _manager = manager;
  _log = manager?.log || null;
  _cache = null; // any prior cache (unlikely) is now stale
  const db = manager?._appContext?.graph?.db;
  if (db) {
    try { _ensureEmbeddingColumns(db); } catch (e) {
      (_log?.error || console.error)('[embedder] setManager: column ensure failed: ' + e.message);
    }
  }
}

/**
 * Pick the active embedder. Preference order:
 *   1. config.embedder === provider.name (operator-set)
 *   2. first configured provider in registration order
 *   3. null (no embedder available — caller must no-op)
 *
 * Cached by provider name; re-resolves automatically when a different
 * provider would now win (plugin install/uninstall, config change).
 */
function _resolveActive() {
  if (!_manager) return null;
  const cfg = _manager._appContext?.config || {};
  const providers = _manager.getEmbedders();
  if (!providers.length) { _cache = null; return null; }

  const preferred = cfg.embedder || null;
  let pick = null;
  if (preferred) pick = providers.find(p => p.name === preferred && p.configured);
  if (!pick) pick = providers.find(p => p.configured);
  if (!pick) { _cache = null; return null; }

  if (_cache && _cache.name === pick.name && _cache.dim === pick.dim) return _cache;

  let instance;
  try {
    instance = pick.factory(cfg);
  } catch (e) {
    (_log?.error || console.error)(`[embedder] Factory for ${pick.name} threw: ${e.message}`);
    _cache = null;
    return null;
  }
  if (!instance || typeof instance.embed !== 'function') {
    (_log?.error || console.error)(`[embedder] Provider ${pick.name} returned an invalid instance (no embed() method)`);
    _cache = null;
    return null;
  }
  _cache = { name: pick.name, dim: pick.dim, instance };
  return _cache;
}

/** Tell callers what's currently active (for retrieval filtering). */
function getActive() {
  return _resolveActive();
}

/**
 * Embed a single piece of text via the active provider.
 * Returns a float array (the embedding vector), or null if no provider.
 *
 * `opts.intent` ('query' | 'document', default 'query') tells the provider
 * which prompt template to apply. Models like EmbeddingGemma use
 * asymmetric prefixes for retrieval — queries get one template, documents
 * another — and using the wrong one collapses similarity into a narrow
 * band. retrieval.js passes 'query'; embedNode passes 'document'.
 */
async function embedText(text, opts = {}) {
  const active = _resolveActive();
  if (!active) return null;
  try {
    return await active.instance.embed(text, { intent: opts.intent || 'query' });
  } catch (e) {
    (_log?.error || console.error)(`[embedder] ${active.name} embed failed: ${e.message}`);
    return null;
  }
}

/**
 * Build the text to embed for a node: label + description + aspect attributes.
 * Richer text = better semantic retrieval.
 */
function buildNodeText(db, nodeId) {
  const node = db.prepare('SELECT label, description FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return null;

  const parts = [`${node.label}: ${node.description || ''}`];

  const aspects = db.prepare('SELECT a.name, attr.content, attr.event_date FROM aspects a JOIN attributes attr ON attr.aspect_id = a.id WHERE a.node_id = ?').all(nodeId);
  for (const row of aspects) {
    const dateSuffix = row.event_date ? ` [${row.event_date}]` : '';
    parts.push(`${row.name}: ${row.content}${dateSuffix}`);
  }

  return parts.join(' | ').slice(0, 2048);
}

/**
 * Idempotent column ALTER. Older DBs only have `embedding`; newer ones
 * also carry `embedding_provider` + `embedding_dim` so vectorSearch can
 * filter by the active provider's tags safely. Called from embedNode at
 * the top of every write — any `duplicate column` is swallowed.
 */
function _ensureEmbeddingColumns(db) {
  for (const col of [
    'ALTER TABLE nodes ADD COLUMN embedding TEXT',
    'ALTER TABLE nodes ADD COLUMN embedding_provider TEXT',
    'ALTER TABLE nodes ADD COLUMN embedding_dim INTEGER',
  ]) {
    try { db.exec(col); } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
}

/**
 * Embed a single node by ID and write the vector back to the DB.
 * Tags the row with the active provider name + dim. Fire-and-forget safe:
 * errors are logged, never thrown.
 *
 * @param {string} nodeId
 * @param {DatabaseSync|null} db  — pass existing db instance or null to open one
 */
async function embedNode(nodeId, db = null) {
  const active = _resolveActive();
  if (!active) {
    // No embedder plugin installed/configured — silent no-op. Maintainer's
    // sweeper handles backfill once an embedder appears.
    return;
  }

  const ownDb = !db;
  if (ownDb) db = new DatabaseSync(graphDbPath());

  try {
    _ensureEmbeddingColumns(db);

    const text = buildNodeText(db, nodeId);
    if (!text) {
      (_log?.error || console.error)('[embedder] Node not found:', nodeId);
      return;
    }

    let vec;
    const t0 = Date.now();
    try {
      vec = await active.instance.embed(text, { intent: 'document' });
    } catch (e) {
      (_log?.error || console.error)(`[embedder] ${active.name} failed for ${nodeId}: ${e.message}`);
      return;
    }
    if (!Array.isArray(vec) || vec.length === 0) {
      (_log?.error || console.error)(`[embedder] ${active.name} returned empty vector for ${nodeId}`);
      return;
    }
    db.prepare(
      'UPDATE nodes SET embedding = ?, embedding_provider = ?, embedding_dim = ? WHERE id = ?'
    ).run(JSON.stringify(vec), active.name, vec.length, nodeId);
    if (process.env.SPORE_EMBEDDER_VERBOSE === 'true') {
      (_log?.info || console.log)(`[embedder] ${active.name} embedded ${nodeId} (${vec.length}d) in ${Date.now() - t0}ms`);
    }
  } catch (e) {
    (_log?.error || console.error)(`[embedder] Failed to embed ${nodeId}:`, e.message);
  } finally {
    if (ownDb) db.close();
  }
}

/**
 * Fire-and-forget wrapper — call this from synchronous write paths.
 * Swallows the promise so it never blocks or throws.
 */
function embedNodeAsync(nodeId, db = null) {
  embedNode(nodeId, db).catch(e => (_log?.error || console.error)('[embedder] async error:', e.message));
}

module.exports = { setManager, getActive, embedNode, embedNodeAsync, embedText, buildNodeText };
