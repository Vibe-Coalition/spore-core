/**
 * backup.js — Automated graph DB backups with rolling retention + in-place restore.
 *
 * Snapshots use SQLite's `VACUUM INTO` for an atomic, consistent file copy.
 * Runs on a configurable interval (default 60m) with optional skip-if-unchanged.
 *
 * Restore path avoids closing the live DB by ATTACHing the backup and copying
 * user tables row-by-row. FTS virtual tables are rebuilt from the base tables.
 * A pre-restore snapshot is always created first, so any restore is itself
 * undoable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ts() {
  const d = new Date();
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + '-' +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0');
}

class BackupWorker {
  constructor(config, log, db, graphDbPath) {
    this.config = config;
    this.log = log;
    this.db = db;
    this.graphDbPath = graphDbPath;
    this._running = false;
    this._timer = null;
    this._lastHash = null;
    this.stats = {
      runs: 0, snapshots: 0, skipped: 0, rotated: 0, restores: 0, errors: 0,
      lastRunAt: null, lastSnapshotAt: null,
    };
  }

  _backupDir() {
    const configured = this.config.graphBackupDir;
    if (configured) return configured;
    return path.join(path.dirname(this.graphDbPath), 'backups');
  }

  _ensureDir() {
    const dir = this._backupDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    return dir;
  }

  _baseName() {
    return path.basename(this.graphDbPath, path.extname(this.graphDbPath));
  }

  _currentSignature() {
    try {
      const counts = [];
      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();
      for (const t of tables) {
        try {
          const c = this.db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
          counts.push(`${t.name}:${c}`);
        } catch {}
      }
      let maxUpdated = null;
      for (const col of ['updated', 'updated_at', 'deleted_at', 'created']) {
        try {
          const r = this.db.prepare(`SELECT MAX(${col}) AS m FROM nodes`).get();
          if (r?.m) { maxUpdated = r.m; break; }
        } catch {}
      }
      return crypto.createHash('sha1').update(counts.join('|') + '|' + (maxUpdated || '')).digest('hex').slice(0, 16);
    } catch {
      return null;
    }
  }

  start() {
    if (this.config.graphBackupEnabled === false) {
      this.log.info('[backup] Disabled via config');
      return;
    }
    const mins = Math.max(1, Number(this.config.graphBackupIntervalMinutes) || 60);
    const ms = mins * 60_000;
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this.runBackup().catch(e => this.log.error('[backup] tick error:', e.message));
    }, ms);
    this.log.info(`[backup] Scheduled every ${mins}m, retention=${this.config.graphBackupRetention || 20}, dir=${this._backupDir()}`);
    // Also take a boot snapshot a couple minutes after start so there's always at least one
    setTimeout(() => {
      this.runBackup({ force: false }).catch(e => this.log.error('[backup] boot snapshot error:', e.message));
    }, 120_000);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async runBackup({ force = false, note = null } = {}) {
    if (!this.db) return { ok: false, error: 'no db' };
    if (this._running) return { ok: false, error: 'already running' };
    if (this.config.graphBackupEnabled === false && !force) return { ok: false, error: 'disabled' };
    this._running = true;
    this.stats.runs++;
    this.stats.lastRunAt = new Date().toISOString();

    try {
      const sig = this._currentSignature();
      if (!force && this.config.graphBackupOnChangeOnly !== false && sig && this._lastHash && sig === this._lastHash) {
        this.stats.skipped++;
        this.log.debug('[backup] Skipping — graph unchanged since last snapshot');
        return { ok: true, skipped: true };
      }

      const dir = this._ensureDir();
      const suffix = note ? `-${String(note).replace(/[^a-z0-9-]/gi, '').slice(0, 24)}` : '';
      const file = path.join(dir, `${this._baseName()}.${ts()}${suffix}.bak`);
      const escaped = file.replace(/'/g, "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);

      const sz = fs.statSync(file).size;
      this._lastHash = sig;
      this.stats.snapshots++;
      this.stats.lastSnapshotAt = new Date().toISOString();
      this.log.info(`[backup] Snapshot ${path.basename(file)} (${(sz/1024).toFixed(1)} KB)${note ? ` note=${note}` : ''}`);
      this._rotate();
      return { ok: true, file, size: sz };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[backup] runBackup:', e.message);
      return { ok: false, error: e.message };
    } finally {
      this._running = false;
    }
  }

  _rotate() {
    try {
      const keep = Math.max(1, Number(this.config.graphBackupRetention) || 20);
      const dir = this._ensureDir();
      const prefix = this._baseName() + '.';
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
        .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const toDelete = files.slice(keep);
      for (const f of toDelete) {
        try { fs.unlinkSync(f.full); this.stats.rotated++; } catch (e) { this.log.warn(`[backup] rotate failed ${f.name}: ${e.message}`); }
      }
    } catch (e) {
      this.log.warn('[backup] rotate error:', e.message);
    }
  }

  listBackups() {
    try {
      const dir = this._ensureDir();
      const prefix = this._baseName() + '.';
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
        .map(f => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          const m = f.match(/\.(\d{8}-\d{6})(?:-([a-z0-9-]+))?\.bak$/i);
          return {
            file: f,
            size: st.size,
            mtime: st.mtimeMs,
            created: st.mtime.toISOString(),
            tag: m?.[2] || null,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return { dir, files };
    } catch (e) {
      return { dir: this._backupDir(), files: [], error: e.message };
    }
  }

  deleteBackup(filename) {
    if (!filename || filename.includes('/') || filename.includes('..')) return { ok: false, error: 'invalid filename' };
    try {
      const dir = this._ensureDir();
      const full = path.join(dir, filename);
      if (!fs.existsSync(full)) return { ok: false, error: 'not found' };
      fs.unlinkSync(full);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Restore from a backup file in the backup dir.
   * Strategy: take a pre-restore snapshot first, then ATTACH the backup DB
   * and copy each base table's rows over. FTS virtual tables are rebuilt
   * from their base tables at the end.
   */
  async restoreBackup(filename) {
    if (!this.db) return { ok: false, error: 'no db' };
    if (!filename || filename.includes('/') || filename.includes('..')) return { ok: false, error: 'invalid filename' };

    const dir = this._ensureDir();
    const full = path.join(dir, filename);
    if (!fs.existsSync(full)) return { ok: false, error: 'backup file not found' };

    // Pre-restore safety snapshot
    const pre = await this.runBackup({ force: true, note: 'pre-restore' });
    if (!pre.ok && !pre.skipped) {
      return { ok: false, error: 'pre-restore snapshot failed: ' + (pre.error || 'unknown') };
    }

    let attached = false;
    try {
      const escaped = full.replace(/'/g, "''");
      this.db.exec(`ATTACH DATABASE '${escaped}' AS bak`);
      attached = true;

      const baseTables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name"
      ).all().map(r => r.name);
      const bakTables = this.db.prepare(
        "SELECT name FROM bak.sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name"
      ).all().map(r => r.name);
      const bakSet = new Set(bakTables);
      const ftsTables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL%' AND sql LIKE '%fts%'"
      ).all().map(r => r.name);

      let tablesRestored = 0, rowsRestored = 0, tablesSkipped = 0;

      const prevFk = this.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0;
      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of baseTables) {
          if (!bakSet.has(t)) {
            tablesSkipped++;
            continue;
          }
          const liveCols = this.db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
          const bakCols = this.db.prepare(`PRAGMA bak.table_info("${t}")`).all().map(c => c.name);
          const shared = liveCols.filter(c => bakCols.includes(c));
          if (!shared.length) { tablesSkipped++; continue; }

          this.db.exec(`DELETE FROM "${t}"`);
          const colList = shared.map(c => `"${c}"`).join(', ');
          const res = this.db.exec(`INSERT INTO "${t}" (${colList}) SELECT ${colList} FROM bak."${t}"`);
          // exec() doesn't return row count on node:sqlite; estimate via count
          try {
            const c = this.db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
            rowsRestored += c;
          } catch {}
          tablesRestored++;
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      } finally {
        try { this.db.exec(`PRAGMA foreign_keys = ${prevFk ? 'ON' : 'OFF'}`); } catch {}
      }

      // Rebuild FTS indices from restored base tables
      for (const f of ftsTables) {
        try { this.db.exec(`INSERT INTO "${f}"("${f}") VALUES('rebuild')`); } catch (e) {
          this.log.warn(`[backup] rebuild FTS ${f}: ${e.message}`);
        }
      }

      this.stats.restores++;
      this.log.info(`[backup] Restored from ${filename} — ${tablesRestored} tables, ${rowsRestored} rows, ${tablesSkipped} skipped, FTS rebuilt: ${ftsTables.length}`);
      return { ok: true, tablesRestored, rowsRestored, tablesSkipped, ftsRebuilt: ftsTables.length, preRestoreSnapshot: pre.file };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[backup] restore failed:', e.message);
      return { ok: false, error: e.message, preRestoreSnapshot: pre.file };
    } finally {
      if (attached) {
        try { this.db.exec('DETACH DATABASE bak'); } catch {}
      }
    }
  }

  applySettings({ intervalMinutes, retention, enabled, onChangeOnly } = {}) {
    const changes = {};
    if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes) && intervalMinutes > 0) {
      this.config.graphBackupIntervalMinutes = Math.floor(intervalMinutes);
      changes.intervalMinutes = this.config.graphBackupIntervalMinutes;
    }
    if (typeof retention === 'number' && Number.isFinite(retention) && retention > 0) {
      this.config.graphBackupRetention = Math.floor(retention);
      changes.retention = this.config.graphBackupRetention;
    }
    if (typeof enabled === 'boolean') {
      this.config.graphBackupEnabled = enabled;
      changes.enabled = enabled;
    }
    if (typeof onChangeOnly === 'boolean') {
      this.config.graphBackupOnChangeOnly = onChangeOnly;
      changes.onChangeOnly = onChangeOnly;
    }
    // Restart the timer to pick up new interval
    this.stop();
    if (this.config.graphBackupEnabled !== false) this.start();
    return changes;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = { BackupWorker };
