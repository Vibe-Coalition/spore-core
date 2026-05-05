/**
 * settings/db.js — settings.db handle, schema bootstrap, migration
 * runner.
 *
 * Uses node:sqlite (DatabaseSync) — same as the rest of spore-core.
 * The DB file is small (single-digit KB); WAL is enabled for safety
 * against concurrent reads from a future inspection CLI.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

class SettingsDb {
  constructor(dbPath) {
    if (!dbPath) throw new Error('SettingsDb requires a dbPath');
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this._runMigrations();
  }

  _runMigrations() {
    // Bootstrap the meta table itself before we can read schema_version.
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings_meta (
      k TEXT PRIMARY KEY NOT NULL,
      v TEXT
    )`);

    const current = this._getMeta('schema_version');
    const currentN = current ? parseInt(current, 10) : 0;

    if (!fs.existsSync(MIGRATIONS_DIR)) return;
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /^\d+_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const m = file.match(/^(\d+)_/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n <= currentN) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this._setMeta('schema_version', String(n));
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`[settings/db] migration ${file} failed: ${e.message}`);
      }
    }
  }

  // ── meta ──────────────────────────────────────────────────────────

  _getMeta(k) {
    const row = this.db.prepare('SELECT v FROM settings_meta WHERE k = ?').get(k);
    return row ? row.v : null;
  }

  _setMeta(k, v) {
    this.db.prepare('INSERT INTO settings_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  }

  getMeta(k) { return this._getMeta(k); }
  setMeta(k, v) { this._setMeta(k, v); }

  // ── settings rows ─────────────────────────────────────────────────

  /** @returns {Array<{key,value,type,updated_at,updated_by}>} */
  all() {
    return this.db.prepare('SELECT key, value, type, updated_at, updated_by FROM settings').all();
  }

  get(key) {
    return this.db.prepare('SELECT key, value, type, updated_at, updated_by FROM settings WHERE key = ?').get(key) || null;
  }

  /**
   * Apply a set of upserts and deletes inside one transaction.
   *   upserts: [{ key, value, type, updatedBy }]
   *   deletes: [key]
   * Throws on any error; caller surfaces to API.
   */
  applyTx({ upserts = [], deletes = [], updatedBy = 'unknown' } = {}) {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(`
        INSERT INTO settings(key, value, type, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          type = excluded.type,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `);
      const del = this.db.prepare('DELETE FROM settings WHERE key = ?');

      for (const row of upserts) {
        upsert.run(row.key, row.value, row.type, now, row.updatedBy || updatedBy);
      }
      for (const key of deletes) {
        del.run(key);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

let _instance = null;

function open(dbPath) {
  if (_instance) return _instance;
  _instance = new SettingsDb(dbPath);
  return _instance;
}

function instance() { return _instance; }

/** @internal — for tests only */
function _reset() {
  if (_instance) _instance.close();
  _instance = null;
}

module.exports = { SettingsDb, open, instance, _reset };
