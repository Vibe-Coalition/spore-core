/**
 * settings/routing-presets.js — CRUD for named model-routing presets.
 *
 * Each preset is a named snapshot of the current model-routing
 * configuration (tier assignments + model limits) that the user
 * can save and restore from the Settings UI.
 *
 * Follows the same module pattern as model-library.js.
 */

const db = require('./db');

// ── helpers ──────────────────────────────────────────────

function _now() { return Date.now(); }

function _serialize(name, config) {
  return {
    name,
    config_json: JSON.stringify(config),
    created_at: _now(),
    updated_at: _now(),
  };
}

function _deserialize(row) {
  if (!row) return null;
  return {
    name: row.name,
    config: JSON.parse(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _summary(row) {
  if (!row) return null;
  return {
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── public API ───────────────────────────────────────────

function list() {
  const d = db.instance();
  const rows = d.prepare(
    'SELECT name, created_at, updated_at FROM routing_presets ORDER BY updated_at DESC'
  ).all();
  return rows.map(_summary);
}

function get(name) {
  const d = db.instance();
  const row = d.prepare(
    'SELECT * FROM routing_presets WHERE name = ?'
  ).get(name);
  return _deserialize(row);
}

function save(name, config) {
  const d = db.instance();
  // Preserve created_at on REPLACE so updates don't reset it
  const existing = d.prepare(
    'SELECT created_at FROM routing_presets WHERE name = ?'
  ).get(name);
  const createdAt = existing ? existing.created_at : _now();
  d.prepare(
    `INSERT OR REPLACE INTO routing_presets (name, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(name, JSON.stringify(config), createdAt, _now());
  return get(name);
}

function remove(name) {
  const d = db.instance();
  const info = d.prepare('DELETE FROM routing_presets WHERE name = ?').run(name);
  return info.changes > 0;
}

module.exports = { list, get, save, remove };
