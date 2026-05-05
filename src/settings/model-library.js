/**
 * settings/model-library.js — CRUD for the centralized model library.
 *
 * The library replaces the old `config.modelLimits` blob plus the
 * per-tier free-text inputs. Each row pairs a provider with a model
 * id and carries the metadata the agent loop needs (context window,
 * reasoning effort, capabilities). Tier strings stored in the
 * settings registry (`models.casual` etc.) are looked up against
 * this library at runtime.
 *
 * Rows are added one of three ways:
 *   - 'manual'    — operator types it in
 *   - 'auto'      — discovered via plugin.listModels and explicitly
 *                   added by the operator (we never auto-insert
 *                   suggestions; that requires opt-in per the design)
 *   - 'migration' — seeded from legacy `modelLimits` / tier strings
 *                   on first boot of this release
 *
 * Source matters because:
 *   - 'manual' / 'auto' rows can be reset-to-vendor (re-pull metadata)
 *   - 'migration' rows are placeholder until the operator confirms or
 *     overrides them (UI shows a "from legacy config — review" badge)
 */

'use strict';

const dbModule = require('./db');

function _now() { return Date.now(); }

/**
 * Compose a library row id from provider + modelId. Mirrors the
 * convention used in tier strings: implicit-anthropic models drop
 * the prefix.
 */
function composeId(provider, modelId) {
  if (!modelId) return null;
  const p = String(provider || '').trim().toLowerCase();
  const m = String(modelId).trim();
  if (!m) return null;
  if (!p || p === 'anthropic') return m;
  return `${p}/${m}`;
}

/**
 * Inverse of composeId — split a stored tier string into
 * { provider, modelId }.
 */
function parseId(id) {
  if (!id) return null;
  const s = String(id).trim();
  const slash = s.indexOf('/');
  if (slash > 0) {
    return {
      provider: s.slice(0, slash).toLowerCase(),
      modelId: s.slice(slash + 1),
    };
  }
  return { provider: 'anthropic', modelId: s };
}

function _serialize(entry) {
  const id = entry.id || composeId(entry.provider, entry.modelId || entry.model_id);
  if (!id) throw new Error('model library entry needs id or provider+modelId');
  return {
    id,
    provider: String(entry.provider || parseId(id).provider).toLowerCase(),
    model_id: entry.modelId || entry.model_id || parseId(id).modelId,
    label: entry.label || null,
    family: entry.family || null,
    context_window: Number.isFinite(entry.contextWindow) ? entry.contextWindow
                  : Number.isFinite(entry.context_window) ? entry.context_window : null,
    max_output: Number.isFinite(entry.maxOutput) ? entry.maxOutput
              : Number.isFinite(entry.max_output) ? entry.max_output : null,
    compact_at: Number.isFinite(entry.compactAt) ? entry.compactAt
              : Number.isFinite(entry.compact_at) ? entry.compact_at : null,
    capabilities_json: entry.capabilities ? JSON.stringify(entry.capabilities) : null,
    reasoning_effort_default: entry.reasoningEffortDefault || entry.reasoning_effort_default || null,
    reasoning_effort_levels: Array.isArray(entry.reasoningEffortLevels) ? JSON.stringify(entry.reasoningEffortLevels)
                          : Array.isArray(entry.reasoning_effort_levels) ? JSON.stringify(entry.reasoning_effort_levels)
                          : null,
    metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
    source: entry.source || 'manual',
    user_overrides_json: Array.isArray(entry.userOverrides) ? JSON.stringify(entry.userOverrides)
                      : Array.isArray(entry.user_overrides) ? JSON.stringify(entry.user_overrides)
                      : null,
    enabled: entry.enabled === false ? 0 : 1,
  };
}

function _deserialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    label: row.label,
    family: row.family,
    contextWindow: row.context_window,
    maxOutput: row.max_output,
    compactAt: row.compact_at,
    capabilities: _parseJsonSafe(row.capabilities_json) || {},
    reasoningEffortDefault: row.reasoning_effort_default,
    reasoningEffortLevels: _parseJsonSafe(row.reasoning_effort_levels) || [],
    metadata: _parseJsonSafe(row.metadata_json) || {},
    source: row.source,
    userOverrides: _parseJsonSafe(row.user_overrides_json) || [],
    enabled: !!row.enabled,
    addedAt: row.added_at,
    refreshedAt: row.refreshed_at,
  };
}

function _parseJsonSafe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── CRUD ──────────────────────────────────────────────────────────

function _db() {
  const inst = dbModule.instance();
  if (!inst) throw new Error('[model-library] settings DB not open — call loader.boot() first');
  return inst.db;
}

/**
 * Insert a new library entry, or no-op if an entry with the same id
 * already exists. Use update() to modify an existing row.
 *
 * @returns {{ id: string, created: boolean }}
 */
function add(entry, opts = {}) {
  const row = _serialize(entry);
  const db = _db();
  const now = _now();
  const existing = db.prepare('SELECT 1 FROM model_library WHERE id = ?').get(row.id);
  if (existing && !opts.upsert) return { id: row.id, created: false };
  if (existing && opts.upsert) {
    return update(row.id, entry);
  }
  db.prepare(`
    INSERT INTO model_library (
      id, provider, model_id, label, family, context_window, max_output,
      compact_at, capabilities_json, reasoning_effort_default,
      reasoning_effort_levels, metadata_json, source, user_overrides_json,
      enabled, added_at, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.provider, row.model_id, row.label, row.family,
    row.context_window, row.max_output, row.compact_at, row.capabilities_json,
    row.reasoning_effort_default, row.reasoning_effort_levels, row.metadata_json,
    row.source, row.user_overrides_json, row.enabled, now,
    row.source === 'auto' ? now : null
  );
  return { id: row.id, created: true };
}

/** Bulk add — returns {added: [...], existing: [...]}. */
function addMany(entries, opts = {}) {
  const added = [];
  const existing = [];
  for (const e of entries || []) {
    const r = add(e, opts);
    (r.created ? added : existing).push(r.id);
  }
  return { added, existing };
}

/**
 * Patch an existing entry. Only provided fields are updated; null
 * clears that field. The `userOverrides` array tracks which fields
 * have been explicitly overridden so resetMetadata() knows what to
 * preserve vs re-pull from vendor.
 */
function update(id, patch) {
  if (!id) throw new Error('update requires id');
  const db = _db();
  const cur = db.prepare('SELECT * FROM model_library WHERE id = ?').get(id);
  if (!cur) return { id, updated: false };

  const merged = _deserialize(cur);
  const overrideTracking = new Set(merged.userOverrides || []);
  const sets = [];
  const vals = [];

  const trackable = ['label', 'family', 'contextWindow', 'maxOutput', 'compactAt',
                     'capabilities', 'reasoningEffortDefault', 'reasoningEffortLevels',
                     'metadata', 'enabled'];

  for (const f of trackable) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    overrideTracking.add(f);
    const v = patch[f];
    switch (f) {
      case 'label': sets.push('label = ?'); vals.push(v); break;
      case 'family': sets.push('family = ?'); vals.push(v); break;
      case 'contextWindow': sets.push('context_window = ?'); vals.push(v); break;
      case 'maxOutput': sets.push('max_output = ?'); vals.push(v); break;
      case 'compactAt': sets.push('compact_at = ?'); vals.push(v); break;
      case 'capabilities': sets.push('capabilities_json = ?'); vals.push(v ? JSON.stringify(v) : null); break;
      case 'reasoningEffortDefault': sets.push('reasoning_effort_default = ?'); vals.push(v); break;
      case 'reasoningEffortLevels': sets.push('reasoning_effort_levels = ?'); vals.push(Array.isArray(v) ? JSON.stringify(v) : null); break;
      case 'metadata': sets.push('metadata_json = ?'); vals.push(v ? JSON.stringify(v) : null); break;
      case 'enabled': sets.push('enabled = ?'); vals.push(v ? 1 : 0); break;
    }
  }
  if (!sets.length) return { id, updated: false };
  sets.push('user_overrides_json = ?');
  vals.push(JSON.stringify([...overrideTracking]));
  vals.push(id);
  db.prepare(`UPDATE model_library SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { id, updated: true };
}

function remove(id) {
  if (!id) throw new Error('remove requires id');
  const db = _db();
  const r = db.prepare('DELETE FROM model_library WHERE id = ?').run(id);
  return { id, removed: r.changes > 0 };
}

function get(id) {
  const db = _db();
  const row = db.prepare('SELECT * FROM model_library WHERE id = ?').get(id);
  return _deserialize(row);
}

function list(opts = {}) {
  const db = _db();
  const where = [];
  const args = [];
  if (opts.provider) { where.push('provider = ?'); args.push(String(opts.provider).toLowerCase()); }
  if (opts.enabledOnly) { where.push('enabled = 1'); }
  const sql = `SELECT * FROM model_library${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY provider, model_id`;
  return db.prepare(sql).all(...args).map(_deserialize);
}

/** Number of rows. Useful for the wizard's "is library populated?" check. */
function count(opts = {}) {
  const db = _db();
  if (opts.provider) {
    return db.prepare('SELECT COUNT(*) c FROM model_library WHERE provider = ?').get(String(opts.provider).toLowerCase()).c;
  }
  return db.prepare('SELECT COUNT(*) c FROM model_library').get().c;
}

function _entryFromModelRef(ref, metadata = {}, source = 'auto') {
  if (!ref || typeof ref !== 'string') return null;
  const parsed = parseId(ref);
  if (!parsed?.modelId) return null;
  return {
    id: composeId(parsed.provider, parsed.modelId),
    provider: parsed.provider,
    modelId: parsed.modelId,
    contextWindow: metadata.contextWindow || metadata.contextLength || null,
    compactAt: metadata.compactAt || null,
    maxOutput: metadata.maxOutput || metadata.maxTokens || null,
    capabilities: metadata.capabilities || {},
    source,
  };
}

/**
 * Ensure every routed model in the current settings snapshot has a
 * library row. This is the reliable server-side counterpart to the
 * wizard UI's best-effort seeding: if onboarding/settings saves a
 * route, the Models pane can immediately offer that model without a
 * manual "Discover" pass.
 */
function ensureFromSettingsSnapshot(snapshot = {}, opts = {}) {
  const source = opts.source || 'auto';
  const refs = new Map();
  const addRef = (ref, metadata = {}) => {
    const entry = _entryFromModelRef(ref, metadata, source);
    if (!entry?.id) return;
    refs.set(entry.id, { ...(refs.get(entry.id) || {}), ...entry });
  };

  for (const ref of Object.values(snapshot.models || {})) {
    if (typeof ref === 'string' && ref.trim()) addRef(ref);
  }
  const limits = snapshot.modelLimits || {};
  if (limits && typeof limits === 'object') {
    for (const [ref, metadata] of Object.entries(limits)) {
      addRef(ref, metadata || {});
    }
  }

  const added = [];
  const existing = [];
  for (const entry of refs.values()) {
    const cur = get(entry.id);
    if (!cur) {
      const r = add(entry);
      (r.created ? added : existing).push(r.id);
      continue;
    }
    existing.push(entry.id);
    const vendorFields = {};
    for (const key of ['contextWindow', 'compactAt', 'maxOutput', 'capabilities']) {
      const value = entry[key];
      if (value === null || value === undefined) continue;
      if (key === 'capabilities' && Object.keys(value || {}).length === 0) continue;
      vendorFields[key] = value;
    }
    if (Object.keys(vendorFields).length) applyVendorRefresh(entry.id, vendorFields);
  }
  return { added, existing };
}

/**
 * Update vendor-derived fields from a fresh /models response, keeping
 * the operator's explicit overrides intact. Fields the operator
 * never touched (not in user_overrides_json) get the new values; the
 * rest are preserved.
 *
 * @param id           library row id
 * @param vendorFields { contextWindow, maxOutput, family, capabilities, … }
 */
function applyVendorRefresh(id, vendorFields) {
  const cur = get(id);
  if (!cur) return { id, updated: false };
  const overrides = new Set(cur.userOverrides || []);
  const patch = {};
  for (const [k, v] of Object.entries(vendorFields || {})) {
    if (overrides.has(k)) continue;        // operator pinned this — don't clobber
    patch[k] = v;
  }
  if (!Object.keys(patch).length) {
    _db().prepare('UPDATE model_library SET refreshed_at = ? WHERE id = ?').run(_now(), id);
    return { id, updated: false };
  }
  // Bypass override tracking — refresh-from-vendor shouldn't mark fields as
  // user-overridden.
  const row = _serialize({ ...cur, ...patch });
  _db().prepare(`
    UPDATE model_library
    SET label = ?, family = ?, context_window = ?, max_output = ?,
        compact_at = ?, capabilities_json = ?, reasoning_effort_default = ?,
        reasoning_effort_levels = ?, metadata_json = ?, refreshed_at = ?
    WHERE id = ?
  `).run(
    row.label, row.family, row.context_window, row.max_output,
    row.compact_at, row.capabilities_json, row.reasoning_effort_default,
    row.reasoning_effort_levels, row.metadata_json, _now(), id
  );
  return { id, updated: true };
}

/**
 * Reset a row to vendor defaults: clears the override list and
 * re-applies vendorFields across all trackable keys.
 */
function resetMetadata(id, vendorFields) {
  const cur = get(id);
  if (!cur) return { id, updated: false };
  const row = _serialize({ ...cur, ...vendorFields, userOverrides: [] });
  _db().prepare(`
    UPDATE model_library
    SET label = ?, family = ?, context_window = ?, max_output = ?,
        compact_at = ?, capabilities_json = ?, reasoning_effort_default = ?,
        reasoning_effort_levels = ?, metadata_json = ?,
        user_overrides_json = NULL, refreshed_at = ?
    WHERE id = ?
  `).run(
    row.label, row.family, row.context_window, row.max_output,
    row.compact_at, row.capabilities_json, row.reasoning_effort_default,
    row.reasoning_effort_levels, row.metadata_json, _now(), id
  );
  return { id, updated: true };
}

module.exports = {
  composeId, parseId,
  add, addMany, update, remove, get, list, count,
  ensureFromSettingsSnapshot,
  applyVendorRefresh, resetMetadata,
};
