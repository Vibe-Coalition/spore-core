// embedder.js — shared single-node embedding utility
// Used by tools.js (graph_update) and learner.js (extract) to index nodes in real-time.
// No external deps: node:sqlite + native fetch() only.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function graphDbPath() {
  return process.env.GRAPH_DB_PATH || path.join(__dirname, 'data', 'graph.db');
}
const DEFAULT_MODEL = 'gemini-embedding-2-preview';

/**
 * Embed a single piece of text via Gemini embedding API.
 * Returns a float array (the embedding vector).
 */
async function embedText(text, apiKey, model = DEFAULT_MODEL) {
  // Send the API key as a header rather than a URL query param so it
  // doesn't leak into fetch error messages (undici TypeErrors include
  // the URL in the cause chain) or any URL-bearing log.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: text.slice(0, 2048) }] }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini embedding ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.embedding.values;
}

/**
 * Build the text to embed for a node: label + description + aspect attributes.
 * Richer text = better semantic retrieval.
 */
function buildNodeText(db, nodeId) {
  const node = db.prepare('SELECT label, description FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return null;

  const parts = [`${node.label}: ${node.description || ''}`];

  // Pull aspect attributes for richer embedding surface
  const aspects = db.prepare('SELECT a.name, attr.content, attr.event_date FROM aspects a JOIN attributes attr ON attr.aspect_id = a.id WHERE a.node_id = ?').all(nodeId);
  for (const row of aspects) {
    const dateSuffix = row.event_date ? ` [${row.event_date}]` : '';
    parts.push(`${row.name}: ${row.content}${dateSuffix}`);
  }

  return parts.join(' | ').slice(0, 2048);
}

/**
 * Embed a single node by ID and write the vector back to the DB.
 * Ensures the embedding column exists first.
 * Fire-and-forget safe — errors are logged, never thrown.
 *
 * @param {string} nodeId
 * @param {DatabaseSync|null} db  — pass existing db instance or null to open one
 */
async function embedNode(nodeId, db = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[embedder] GEMINI_API_KEY not set — skipping embed for', nodeId);
    return;
  }

  const ownDb = !db;
  if (ownDb) db = new DatabaseSync(graphDbPath());

  try {
    // Ensure column exists (idempotent)
    try {
      db.exec(`ALTER TABLE nodes ADD COLUMN embedding TEXT`);
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }

    const text = buildNodeText(db, nodeId);
    if (!text) {
      console.error('[embedder] Node not found:', nodeId);
      return;
    }

    const vec = await embedText(text, apiKey);
    db.prepare('UPDATE nodes SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), nodeId);
    // Uncomment for verbose logging:
    // console.log(`[embedder] Embedded ${nodeId} (${vec.length}d)`);
  } catch (e) {
    console.error(`[embedder] Failed to embed ${nodeId}:`, e.message);
  } finally {
    if (ownDb) db.close();
  }
}

/**
 * Fire-and-forget wrapper — call this from synchronous write paths.
 * Swallows the promise so it never blocks or throws.
 */
function embedNodeAsync(nodeId, db = null) {
  embedNode(nodeId, db).catch(e => console.error('[embedder] async error:', e.message));
}

module.exports = { embedNode, embedNodeAsync, embedText, buildNodeText };
