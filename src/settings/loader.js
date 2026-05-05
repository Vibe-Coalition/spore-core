/**
 * settings/loader.js — boot-time assembly of the in-memory store.
 *
 * Order:
 *   1. Bootstrap env reads (dataDir, paths, ports).
 *   2. Open settings.db (run schema + pending migrations).
 *   3. (Phase 2) one-time spore.json + .env seed migrations.
 *   4. Apply registry defaults to the store.
 *   5. Override with rows from settings.db (provenance='db').
 *   6. Override with process.env values (provenance='env', envLocked=true).
 *
 * Phase 1: this runs alongside loadConfigFresh() and the assertion
 * helper compares snapshots. The DB is created but the legacy code
 * path remains the writer of record until Phase 2.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const registry = require('./registry');
const store = require('./store');
const dbModule = require('./db');
const { deserializeFromDb, deserializeFromEnv, serializeForDb } = require('./validators');

// Ensure all core defs are registered (side-effect import).
require('./defs.core');

function _resolveDataDir() {
  if (process.env.SPORE_DATA_DIR) return process.env.SPORE_DATA_DIR;
  if (process.env.GRAPH_DB_PATH) return path.dirname(process.env.GRAPH_DB_PATH);
  return path.join(__dirname, '..', 'data');
}

function _resolveSettingsDbPath(dataDir) {
  if (process.env.SETTINGS_DB_PATH) return process.env.SETTINGS_DB_PATH;
  return path.join(dataDir, 'settings.db');
}

let _booted = false;

/**
 * Boot the in-memory store. Idempotent.
 *   opts.dataDir         — overrides env-derived data dir (tests)
 *   opts.settingsDbPath  — overrides DB path (tests)
 *   opts.skipDb          — skip DB open (tests / pure-default scenarios)
 */
function boot(opts = {}) {
  if (_booted && !opts.force) return store;

  const dataDir = opts.dataDir || _resolveDataDir();
  const dbPath = opts.settingsDbPath || _resolveSettingsDbPath(dataDir);

  // ── 1. registry defaults ─────────────────────────────────────────
  for (const def of registry.all()) {
    store.seed(def.key, def.default, 'default', false);
  }

  // ── 2. open DB (created on first boot) ───────────────────────────
  let db = null;
  if (!opts.skipDb) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = dbModule.open(dbPath);

    // ── 3a. one-time spore.json migration ─────────────────────────
    // Reads the legacy file (in dataDir or src/), writes every known
    // key into settings.db with provenance='migration', and renames
    // the file to spore.json.migrated.<ts>. Gated by a meta flag so
    // it runs exactly once per data dir. Skipped under opts.skipLegacy
    // (tests).
    if (!opts.skipLegacy) _migrateSporeJson(dataDir, db);

    // ── 3b. one-time .env seed migration ─────────────────────────
    // For every registry key with an envVar present in process.env
    // and no row in settings.db, write that env value to the DB.
    // Lets `.env` keep working as a Docker / k8s override while the
    // DB becomes canonical. Gated by meta.env_seeded_at.
    if (!opts.skipLegacy) _seedEnvIntoDb(db);

    // ── 3c. DB rows override defaults + spore.json read-through ───
    for (const row of db.all()) {
      const def = registry.get(row.key);
      if (!def) continue;     // unknown key: ignore (forward-compat with registry shrinks)
      const value = deserializeFromDb(def, row.value);
      store.seed(def.key, value, 'db', false);
    }

    // ── 3d. one-time model library seed ─────────────────────────
    // Walks legacy modelLimits + tier strings now that the store is
    // hydrated. Creates placeholder rows so the operator can refine
    // them in the UI. Idempotent via meta.model_library_seeded_at.
    if (!opts.skipLegacy) _seedModelLibrary(db);
  }

  // ── 4. env overrides ─────────────────────────────────────────────
  for (const def of registry.all()) {
    const envNames = [def.envVar, ...(def.legacyAlias || [])].filter(Boolean);
    let raw;
    let usedName = null;
    for (const name of envNames) {
      if (process.env[name] !== undefined && process.env[name] !== '') {
        raw = process.env[name];
        usedName = name;
        break;
      }
    }
    if (raw === undefined) continue;
    const value = deserializeFromEnv(def, raw);
    if (value === undefined) continue;     // bad parse: skip silently (matches legacy behavior)
    store.seed(def.key, value, 'env', true);
    void usedName;
  }

  // ── 5. derived defaults (post-merge fixups) ──────────────────────
  // displayName falls back to a prettified agentId
  if (!store.get('displayName')) {
    const agentId = store.get('agentId') || 'spore';
    const derived = agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    store.seed('displayName', derived, store.provenance('displayName'), store.isEnvLocked('displayName'));
  }
  // tailscaleHostname falls back to spore-<agentId>
  if (!store.get('tailscaleHostname')) {
    const agentId = store.get('agentId') || 'agent';
    store.seed('tailscaleHostname', `spore-${agentId}`, 'default', false);
  }
  // sharedGraphsDir / sharedSkillsDir derive from dataDir
  if (!store.get('sharedGraphsDir')) {
    store.seed('sharedGraphsDir', path.join(dataDir, 'shared', 'graphs'), 'default', false);
  }
  if (!store.get('sharedSkillsDir')) {
    store.seed('sharedSkillsDir', path.join(dataDir, 'shared', 'skills'), 'default', false);
  }
  // dataDir itself goes into the store at the resolved value
  if (!store.get('dataDir')) {
    store.seed('dataDir', dataDir, 'default', false);
  }
  // model-tier legacy: SPORE_MODEL → models.planner already handled
  // via legacyAlias on models.planner.
  // (graphBackupDir intentionally not derived here — backup worker
  // owns the fallback when value is null; matches legacy.)

  _booted = true;
  return store;
}

function isBooted() { return _booted; }

/**
 * Read & flatten any keys present in `parsed` (the JSON object loaded
 * from a legacy spore.json) into a list of { key, def, value } rows
 * keyed by registry key. Returns rows ready to upsert into settings.db.
 */
function _flattenLegacyJsonForDb(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];

  // Mirrors the inverse of the dual-run mapping in src/config.js.
  const legacyToRegistry = {
    casualModel: 'models.casual',
    normalModel: 'models.normal',
    plannerModel: 'models.planner',
    subagentModel: 'models.subagent',
    learnerModel: 'models.learner',
    imageVlmModel: 'models.imageVlm',
    videoVlmModel: 'models.videoVlm',
    audioVlmModel: 'models.audioVlm',
    recallModel: 'models.recall',
    visionFallbackModel: 'models.visionFallback',
    audioFallbackModel: 'models.audioFallback',
    videoFallbackModel: 'models.videoFallback',
    anthropicApiKey: 'providers.anthropic.apiKey',
    openaiApiKey: 'providers.openai.apiKey',
    openaiBaseUrl: 'providers.openai.baseUrl',
    openrouterApiKey: 'providers.openrouter.apiKey',
    openrouterBaseUrl: 'providers.openrouter.baseUrl',
    openrouterReferer: 'providers.openrouter.referer',
    localModelApiKey: 'providers.local.apiKey',
    localModelBaseUrl: 'providers.local.baseUrl',
    localModelAuthHeader: 'providers.local.authHeader',
    geminiApiKey: 'providers.gemini.apiKey',
    embedder: 'embedder',
    searxngUrl: 'webSearch.searxngUrl',
    searxngApiKey: 'webSearch.searxngApiKey',
    braveApiKey: 'webSearch.braveApiKey',
    telegramBotToken: 'channels.telegram.botToken',
    slackBotToken: 'channels.slack.botToken',
    slackAppToken: 'channels.slack.appToken',
    discordToken: 'channels.discord.token',
    discordAdmins: 'channels.discord.admins',
    maxMessageLength: 'channels.discord.maxMessageLength',
    typingInterval: 'channels.discord.typingInterval',
    maxQueuePerChannel: 'channels.discord.maxQueuePerChannel',
    messageDebounceMs: 'channels.discord.messageDebounceMs',
  };

  const rows = [];
  for (const [legacyKey, value] of Object.entries(parsed)) {
    // Nested groups handled separately below.
    if (legacyKey === 'voice' || legacyKey === 'proactive' || legacyKey === 'channels') continue;
    const registryKey = legacyToRegistry[legacyKey] || legacyKey;
    const def = registry.get(registryKey);
    if (!def) continue;
    if (value == null) continue;
    rows.push({ key: registryKey, def, value });
  }

  // Nested objects in spore.json: voice, proactive, channels.{telegram,slack}.
  const flattenInto = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const key = `${prefix}.${k}`;
      const def = registry.get(key);
      if (!def) continue;
      if (v == null) continue;
      rows.push({ key, def, value: v });
    }
  };
  flattenInto(parsed.voice, 'voice');
  flattenInto(parsed.proactive, 'proactive');
  flattenInto(parsed.channels?.telegram, 'channels.telegram');
  flattenInto(parsed.channels?.slack, 'channels.slack');

  return rows;
}

/**
 * One-time migration from legacy spore.json into settings.db.
 *
 * Idempotent via meta.spore_json_migrated_at: if the flag is set, this
 * function returns immediately. After migration the file is renamed
 * to spore.json.migrated.<ts> so a future loader pass won't reprocess.
 */
function _migrateSporeJson(dataDir, db) {
  if (!db) return;
  if (db.getMeta('spore_json_migrated_at')) return;

  const candidates = [
    path.join(dataDir, 'spore.json'),
  ];
  // Do not treat the image-bundled src/spore.json as operator
  // configuration on fresh installs. It carries example/default
  // Anthropic routes and pollutes settings.db/model_library before the
  // wizard has a chance to save the provider the operator actually
  // chose. Operators migrating an old source-tree config can opt in by
  // pointing SPORE_LEGACY_CONFIG_PATH at that file.
  if (process.env.SPORE_LEGACY_CONFIG_PATH) {
    candidates.push(process.env.SPORE_LEGACY_CONFIG_PATH);
  }
  let parsed = null;
  let sourcePath = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      sourcePath = p;
      break;
    } catch { /* ignore unreadable / invalid JSON */ }
  }

  if (!parsed) {
    db.setMeta('spore_json_migrated_at', String(Date.now()));
    return;
  }

  const rows = _flattenLegacyJsonForDb(parsed);
  if (rows.length) {
    db.applyTx({
      upserts: rows.map(r => ({
        key: r.key,
        value: serializeForDb(r.def, r.value),
        type: r.def.type,
        updatedBy: 'migration:spore.json',
      })),
      deletes: [],
    });
  }

  // Rename the source file so future boots don't reprocess it. If the
  // file lives outside dataDir (a legacy bind-mount), we leave it
  // alone but still flip the meta flag — subsequent boots in this
  // dataDir will skip migration.
  try {
    if (sourcePath && sourcePath.startsWith(dataDir)) {
      const renamed = sourcePath + '.migrated.' + Date.now();
      fs.renameSync(sourcePath, renamed);
    }
  } catch { /* fs renames can fail on read-only mounts; the meta flag
                still prevents reprocessing */ }

  db.setMeta('spore_json_migrated_at', String(Date.now()));
  db.setMeta('spore_json_source', sourcePath || '');
  db.setMeta('spore_json_rows_migrated', String(rows.length));
}

/**
 * One-time seed of process.env values into settings.db. For every
 * registry key with an envVar present in process.env and NO row in
 * settings.db, deserialize and write a row. Subsequent boots find
 * the row and skip env (env still acts as a runtime override above).
 *
 * Idempotent via meta.env_seeded_at — runs exactly once per dataDir.
 */
function _seedEnvIntoDb(db) {
  if (!db) return;
  if (db.getMeta('env_seeded_at')) return;

  const upserts = [];
  for (const def of registry.all()) {
    if (def.scope.includes('bootstrap')) continue;       // paths/ports stay in env
    if (db.get(def.key)) continue;                        // row already exists
    const envNames = [def.envVar, ...(def.legacyAlias || [])].filter(Boolean);
    let raw;
    for (const name of envNames) {
      if (process.env[name] !== undefined && process.env[name] !== '') {
        raw = process.env[name];
        break;
      }
    }
    if (raw === undefined) continue;
    const value = deserializeFromEnv(def, raw);
    if (value === undefined) continue;
    upserts.push({
      key: def.key,
      value: serializeForDb(def, value),
      type: def.type,
      updatedBy: 'migration:env',
    });
  }

  if (upserts.length) {
    db.applyTx({ upserts, deletes: [], updatedBy: 'migration:env' });
  }
  db.setMeta('env_seeded_at', String(Date.now()));
  db.setMeta('env_rows_seeded', String(upserts.length));
}

/**
 * Seed the model_library table with placeholder rows for legacy
 * tier strings (settings.casual / .normal / etc.) and any per-model
 * entries in `modelLimits`. Source='migration' so the UI flags them
 * as "from legacy config — review"; the operator can edit, refresh
 * from vendor, or remove.
 *
 * Idempotent via meta.model_library_seeded_at.
 */
function _seedModelLibrary(db) {
  if (!db) return;
  if (db.getMeta('model_library_seeded_at')) return;

  const lib = require('./model-library');
  const seen = new Set();
  // 1. Each tier string (casual / normal / planner / subagent /
  //    learner / recall / *Vlm) becomes a library row.
  const tierKeys = registry.all()
    .filter(d => d.group === 'models')
    .map(d => d.key);
  for (const key of tierKeys) {
    const v = store.get(key);
    if (!v || typeof v !== 'string') continue;
    const id = lib.composeId(_inferProvider(v), _inferModelId(v));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    lib.add({
      id,
      provider: _inferProvider(v),
      modelId: _inferModelId(v),
      source: 'migration',
    });
  }
  // 2. modelLimits — JSON map keyed by full ref.
  const limits = store.get('modelLimits') || {};
  if (limits && typeof limits === 'object') {
    for (const [ref, params] of Object.entries(limits)) {
      const id = lib.composeId(_inferProvider(ref), _inferModelId(ref));
      if (!id) continue;
      lib.add({
        id,
        provider: _inferProvider(ref),
        modelId: _inferModelId(ref),
        contextWindow: params?.contextWindow || null,
        compactAt: params?.compactAt || null,
        maxOutput: params?.maxTokens || params?.maxOutput || null,
        source: 'migration',
      });
      // applyVendorRefresh-style merge if the row already exists with
      // tier-only data — fill in the params we just discovered.
      if (seen.has(id) && (params?.contextWindow || params?.compactAt)) {
        lib.update(id, {
          contextWindow: params.contextWindow || null,
          compactAt: params.compactAt || null,
        });
      }
      seen.add(id);
    }
  }

  db.setMeta('model_library_seeded_at', String(Date.now()));
  db.setMeta('model_library_rows_seeded', String(seen.size));
}

/**
 * Best-effort provider classification from a tier string.
 *   "claude-opus-4-7" → "anthropic"  (no slash; default)
 *   "openai/gpt-4o"   → "openai"     (left of slash)
 *   "gpt-4o"          → "openai"     (heuristic by prefix)
 */
function _inferProvider(ref) {
  if (!ref) return 'anthropic';
  const s = String(ref).trim();
  const slash = s.indexOf('/');
  if (slash > 0) return s.slice(0, slash).toLowerCase();
  // Prefix-based heuristics for slash-less tier strings. Anthropic
  // is the implicit default; the rest infer from common families.
  const lower = s.toLowerCase();
  if (lower.startsWith('claude') || lower.startsWith('opus') || lower.startsWith('sonnet') || lower.startsWith('haiku')) return 'anthropic';
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('chatgpt')) return 'openai';
  if (lower.startsWith('gemini')) return 'gemini';
  if (lower.startsWith('glm')) return 'zai';
  return 'anthropic';
}

function _inferModelId(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  const slash = s.indexOf('/');
  if (slash > 0) return s.slice(slash + 1);
  return s;
}

/**
 * Walk the legacy spore.json (if it exists in dataDir, or at an
 * explicit SPORE_LEGACY_CONFIG_PATH) and seed registry-known keys into the store WITHOUT
 * persisting to disk. Used as a fallback only — Phase 2 replaces
 * this with _migrateSporeJson which writes to settings.db.
 *
 * Kept around for the rare case where the migration ran but the DB
 * was wiped (e.g. operator deleted settings.db); next boot finds the
 * `.migrated` file too and seeds from it again. (Optional — not
 * currently called from boot.)
 */
function _seedFromLegacySporeJson(dataDir, _db) {
  const candidates = [
    path.join(dataDir, 'spore.json'),
    path.join(__dirname, '..', 'spore.json'),
    path.join(__dirname, '..', 'anima.json'),
  ];
  let parsed = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    catch { /* unreadable / invalid JSON — silent fallback */ }
  }
  if (!parsed) return;

  // Map of legacy flat keys → registry keys (mirrors the inverse of
  // the dual-run mapping in src/config.js). Non-listed keys are read
  // by their literal name from the spore.json (which usually matches
  // the registry key).
  const legacyToRegistry = {
    casualModel: 'models.casual',
    normalModel: 'models.normal',
    plannerModel: 'models.planner',
    subagentModel: 'models.subagent',
    learnerModel: 'models.learner',
    imageVlmModel: 'models.imageVlm',
    videoVlmModel: 'models.videoVlm',
    audioVlmModel: 'models.audioVlm',
    recallModel: 'models.recall',
    visionFallbackModel: 'models.visionFallback',
    audioFallbackModel: 'models.audioFallback',
    videoFallbackModel: 'models.videoFallback',
    anthropicApiKey: 'providers.anthropic.apiKey',
    openaiApiKey: 'providers.openai.apiKey',
    openaiBaseUrl: 'providers.openai.baseUrl',
    openrouterApiKey: 'providers.openrouter.apiKey',
    openrouterBaseUrl: 'providers.openrouter.baseUrl',
    openrouterReferer: 'providers.openrouter.referer',
    localModelApiKey: 'providers.local.apiKey',
    localModelBaseUrl: 'providers.local.baseUrl',
    localModelAuthHeader: 'providers.local.authHeader',
    geminiApiKey: 'providers.gemini.apiKey',
    embedder: 'embedder',
    searxngUrl: 'webSearch.searxngUrl',
    searxngApiKey: 'webSearch.searxngApiKey',
    braveApiKey: 'webSearch.braveApiKey',
    telegramBotToken: 'channels.telegram.botToken',
    slackBotToken: 'channels.slack.botToken',
    slackAppToken: 'channels.slack.appToken',
    discordToken: 'channels.discord.token',
    discordAdmins: 'channels.discord.admins',
    maxMessageLength: 'channels.discord.maxMessageLength',
    typingInterval: 'channels.discord.typingInterval',
    maxQueuePerChannel: 'channels.discord.maxQueuePerChannel',
    messageDebounceMs: 'channels.discord.messageDebounceMs',
  };

  for (const [legacyKey, value] of Object.entries(parsed)) {
    const registryKey = legacyToRegistry[legacyKey] || legacyKey;
    const def = registry.get(registryKey);
    if (!def) continue;
    // Trust the legacy file's shape; the type was implicit before but
    // matches the registry's type for ported keys.
    store.seed(registryKey, value, 'db', false);
  }

  // Nested objects: voice, channels.telegram, channels.slack, proactive
  // were stored as nested objects in spore.json. Walk known-nested
  // groups and flatten into per-leaf store entries.
  _flattenSeed(parsed.voice, 'voice');
  _flattenSeed(parsed.proactive, 'proactive');
  _flattenSeed(parsed.channels?.telegram, 'channels.telegram');
  _flattenSeed(parsed.channels?.slack, 'channels.slack');
  // privacy / sectionBudgets / loopDetection are single json defs;
  // they were handled in the flat-key loop above by registryKey ===
  // legacyKey for those exact names.
}

function _flattenSeed(obj, prefix) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const key = `${prefix}.${k}`;
    if (registry.has(key)) store.seed(key, v, 'db', false);
  }
}

/**
 * Resolve and seed a single key into the store. Used by:
 *   - boot() during initial assembly
 *   - plugin registration that lands AFTER boot (registerSetting)
 *
 * Resolution order: registry default → settings.db row → env override.
 * No-ops if the store already has a non-default value for the key
 * unless `force: true`.
 */
function seedKey(def, opts = {}) {
  if (!def || !def.key) return;
  const db = dbModule.instance();

  // Default first
  store.seed(def.key, def.default, 'default', false);

  // DB row?
  if (db) {
    const row = db.get(def.key);
    if (row) {
      const v = deserializeFromDb(def, row.value);
      store.seed(def.key, v, 'db', false);
    }
  }

  // Env override?
  const envNames = [def.envVar, ...(def.legacyAlias || [])].filter(Boolean);
  for (const name of envNames) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const v = deserializeFromEnv(def, raw);
    if (v === undefined) continue;
    store.seed(def.key, v, 'env', true);
    break;
  }
  void opts;
}

/** @internal — for tests only */
function _reset() {
  _booted = false;
  store._reset();
  dbModule._reset();
  registry._reset();
}

module.exports = { boot, isBooted, seedKey, _reset };
