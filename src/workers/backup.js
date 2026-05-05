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
const { DatabaseSync } = require('node:sqlite');

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
  constructor(config, log, db, graphDbPath, registry = null) {
    this.config = config;
    this.log = log;
    this.db = db;
    this.graphDbPath = graphDbPath;
    this.registry = registry;
    this._running = false;
    this._timer = null;
    this._lastHash = null;
    this._lastHashes = {};
    this._graphBackupLocks = new Set();
    this.stats = {
      runs: 0, snapshots: 0, skipped: 0, rotated: 0, restores: 0, errors: 0,
      lastRunAt: null, lastSnapshotAt: null,
    };
  }

  _backupDir(graphDbPath = this.graphDbPath) {
    const configured = this.config.graphBackupDir;
    if (configured) return configured;
    return path.join(path.dirname(graphDbPath || this.graphDbPath), 'backups');
  }

  _ensureDir(graphDbPath = this.graphDbPath) {
    const dir = this._backupDir(graphDbPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    return dir;
  }

  _baseName(graphDbPath = this.graphDbPath) {
    return path.basename(graphDbPath, path.extname(graphDbPath));
  }

  _registrySnapshot() {
    if (!this.registry) return null;
    const entries = {};
    try {
      for (const graph of this.registry.list?.() || []) {
        const { dbPath, ...meta } = graph;
        entries[meta.slug] = meta;
      }
    } catch {
      try {
        for (const [slug, graph] of Object.entries(this.registry._registry || {})) {
          entries[slug] = { ...graph };
        }
      } catch { /* best effort */ }
    }
    return {
      activeSlug: this.registry.getActiveSlug?.() || null,
      graphs: entries,
    };
  }

  _writeManifest(file, { slug = null, graphDbPath = this.graphDbPath, note = null, size = null } = {}) {
    try {
      const registry = this._registrySnapshot();
      const graph = slug && registry?.graphs ? registry.graphs[slug] : null;
      const manifest = {
        format: 'spore-graph-backup-manifest',
        version: 1,
        createdAt: new Date().toISOString(),
        backupFile: path.basename(file),
        graphDbFile: path.basename(graphDbPath || ''),
        slug: slug || graph?.slug || this.registry?.getActiveSlug?.() || null,
        note,
        size,
        graph,
        activeSlug: registry?.activeSlug || null,
        registry: registry?.graphs || null,
      };
      fs.writeFileSync(file + '.json', JSON.stringify(manifest, null, 2));
      return manifest;
    } catch (e) {
      this.log.warn(`[backup] manifest failed for ${path.basename(file)}: ${e.message}`);
      return null;
    }
  }

  _readManifest(fullPath) {
    try {
      const manifestPath = fullPath + '.json';
      if (!fs.existsSync(manifestPath)) return null;
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return null;
    }
  }

  _graphsForBackups() {
    if (!this.registry?.list) {
      return [{
        slug: this.registry?.getActiveSlug?.() || 'default',
        name: 'Active graph',
        role: 'active',
        active: true,
        dbPath: this.graphDbPath,
      }];
    }
    return (this.registry.list() || []).map(g => ({
      ...g,
      dbPath: this.registry.getDbPath?.(g.slug) || g.dbPath,
      active: g.slug === this.registry.getActiveSlug?.(),
    }));
  }

  _inferGraphForBackup(filename, preferredSlug = null) {
    const graphs = this._graphsForBackups();
    if (preferredSlug) {
      const graph = graphs.find(g => g.slug === preferredSlug);
      if (!graph) return { error: `graph "${preferredSlug}" not found` };
      return { graph };
    }
    const matches = graphs.filter(g => {
      const dbPath = g.dbPath || this.registry?.getDbPath?.(g.slug);
      return dbPath && filename.startsWith(this._baseName(dbPath) + '.');
    });
    if (matches.length === 1) return { graph: matches[0] };
    if (matches.length > 1) return { error: 'backup filename matches multiple graphs; pass slug' };
    const active = graphs.find(g => g.active) || graphs[0] || null;
    return active ? { graph: active } : { error: 'no graphs available' };
  }

  _assertBackupMatchesGraph(filename, graph) {
    const dbPath = graph?.dbPath || this.registry?.getDbPath?.(graph?.slug) || this.graphDbPath;
    const prefix = this._baseName(dbPath) + '.';
    if (!filename.startsWith(prefix)) {
      return `backup "${filename}" does not belong to graph "${graph?.slug || this._baseName(dbPath)}"`;
    }
    return null;
  }

  _currentSignature(db = this.db) {
    try {
      const counts = [];
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();
      for (const t of tables) {
        try {
          const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c;
          counts.push(`${t.name}:${c}`);
        } catch (e) { this.log.warn('[backup] db.prepare failed: ' + e.message); }
      }
      let maxUpdated = null;
      for (const col of ['updated', 'updated_at', 'deleted_at', 'created']) {
        try {
          const r = db.prepare(`SELECT MAX(${col}) AS m FROM nodes`).get();
          if (r?.m) { maxUpdated = r.m; break; }
        } catch (e) { this.log.warn('[backup] db.prepare failed: ' + e.message); }
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
      this.runBackups().catch(e => this.log.error('[backup] tick error:', e.message));
    }, ms);
    this.log.info(`[backup] Scheduled every ${mins}m, retention=${this.config.graphBackupRetention || 20}, dir=${this._backupDir()}`);
    // Also take a boot snapshot a couple minutes after start so there's always at least one
    setTimeout(() => {
      this.runBackups({ force: false }).catch(e => this.log.error('[backup] boot snapshot error:', e.message));
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
    try {
      return await this._runBackupFile({
        db: this.db,
        graphDbPath: this.graphDbPath,
        key: this.registry?.getActiveSlug?.() || 'active',
        force,
        note,
      });
    } catch (e) {
      this.stats.errors++;
      this.log.error('[backup] runBackup:', e.message);
      return { ok: false, error: e.message };
    } finally {
      this._running = false;
    }
  }

  async runBackups({ force = false, note = null } = {}) {
    if (!this.registry) return this.runBackup({ force, note });
    if (this._running) return { ok: false, error: 'already running' };
    if (this.config.graphBackupEnabled === false && !force) return { ok: false, error: 'disabled' };

    this._running = true;
    const graphs = this.registry.list?.() || [];
    const results = [];
    try {
      for (const graph of graphs) {
        const dbPath = this.registry.getDbPath?.(graph.slug);
        if (!dbPath || !fs.existsSync(dbPath)) {
          results.push({ slug: graph.slug, ok: false, error: 'db missing' });
          continue;
        }
        results.push(await this.runBackupForGraph({ slug: graph.slug, dbPath, force, note }));
      }
      return { ok: true, graphs: results };
    } finally {
      this._running = false;
    }
  }

  async runBackupForGraph({ slug, dbPath, force = false, note = null } = {}) {
    if (!dbPath) return { ok: false, error: 'dbPath required' };
    if (this.config.graphBackupEnabled === false && !force) return { ok: false, error: 'disabled' };
    const key = slug || dbPath;
    if (this._graphBackupLocks.has(key)) return { slug, ok: false, error: 'already running' };

    this._graphBackupLocks.add(key);
    let db = null;
    try {
      db = dbPath === this.graphDbPath && this.db ? this.db : new DatabaseSync(dbPath);
      return await this._runBackupFile({ db, graphDbPath: dbPath, key, force, note, slug });
    } catch (e) {
      this.stats.errors++;
      this.log.error(`[backup] runBackupForGraph ${key}:`, e.message);
      return { slug, ok: false, error: e.message };
    } finally {
      if (db && db !== this.db) {
        try { db.close(); } catch {}
      }
      this._graphBackupLocks.delete(key);
    }
  }

  async _runBackupFile({ db, graphDbPath, key, force = false, note = null, slug = null }) {
    this.stats.runs++;
    this.stats.lastRunAt = new Date().toISOString();

    const sig = this._currentSignature(db);
    const prevHash = this._lastHashes[key] || (key === 'active' ? this._lastHash : null);
    if (!force && this.config.graphBackupOnChangeOnly !== false && sig && prevHash && sig === prevHash) {
      this.stats.skipped++;
      this.log.debug(`[backup] Skipping ${slug || key} — graph unchanged since last snapshot`);
      return { slug, ok: true, skipped: true };
    }

    const dir = this._ensureDir(graphDbPath);
    const suffix = note ? `-${String(note).replace(/[^a-z0-9-]/gi, '').slice(0, 24)}` : '';
    const file = path.join(dir, `${this._baseName(graphDbPath)}.${ts()}${suffix}.bak`);
    const escaped = file.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);

    const sz = fs.statSync(file).size;
    this._lastHashes[key] = sig;
    if (key === 'active') this._lastHash = sig;
    this.stats.snapshots++;
    this.stats.lastSnapshotAt = new Date().toISOString();
    this._writeManifest(file, { slug, graphDbPath, note, size: sz });
    this.log.info(`[backup] Snapshot ${path.basename(file)} (${(sz/1024).toFixed(1)} KB)${slug ? ` graph=${slug}` : ''}${note ? ` note=${note}` : ''}`);
    this._rotate(graphDbPath);
    return { slug, ok: true, file, size: sz };
  }

  _rotate(graphDbPath = this.graphDbPath) {
    try {
      const keep = Math.max(1, Number(this.config.graphBackupRetention) || 20);
      const dir = this._ensureDir(graphDbPath);
      const prefix = this._baseName(graphDbPath) + '.';
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
        .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const toDelete = files.slice(keep);
      for (const f of toDelete) {
        try {
          fs.unlinkSync(f.full);
          try { if (fs.existsSync(f.full + '.json')) fs.unlinkSync(f.full + '.json'); } catch {}
          this.stats.rotated++;
        } catch (e) { this.log.warn(`[backup] rotate failed ${f.name}: ${e.message}`); }
      }
    } catch (e) {
      this.log.warn('[backup] rotate error:', e.message);
    }
  }

  _listBackupFilesForGraph(graph) {
    const dbPath = graph?.dbPath || this.registry?.getDbPath?.(graph?.slug) || this.graphDbPath;
    const dir = this._ensureDir(dbPath);
    const prefix = this._baseName(dbPath) + '.';
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
      .map(f => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        const m = f.match(/\.(\d{8}-\d{6})(?:-([a-z0-9-]+))?\.bak$/i);
        const manifest = this._readManifest(full);
        return {
          file: f,
          slug: graph?.slug || manifest?.slug || null,
          graphName: graph?.name || manifest?.graph?.name || null,
          graphRole: graph?.role || manifest?.graph?.role || null,
          size: st.size,
          mtime: st.mtimeMs,
          created: st.mtime.toISOString(),
          tag: m?.[2] || manifest?.note || null,
          manifest: manifest ? path.basename(full) + '.json' : null,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  listBackups({ all = false } = {}) {
    try {
      const dir = this._ensureDir();
      const graphs = this._graphsForBackups().map(graph => {
        let files = [];
        try { files = this._listBackupFilesForGraph(graph); }
        catch (e) { return { slug: graph.slug, name: graph.name, role: graph.role, active: !!graph.active, files: [], error: e.message }; }
        return {
          slug: graph.slug,
          name: graph.name,
          role: graph.role,
          active: !!graph.active,
          files,
        };
      });
      const files = (all ? graphs.flatMap(g => g.files) : (graphs.find(g => g.active)?.files || []))
        .sort((a, b) => b.mtime - a.mtime);
      return {
        dir,
        activeSlug: this.registry?.getActiveSlug?.() || null,
        registry: this._registrySnapshot(),
        graphs,
        files,
      };
    } catch (e) {
      return { dir: this._backupDir(), files: [], error: e.message };
    }
  }

  deleteBackup(filename, { slug = null } = {}) {
    if (!filename || filename.includes('/') || filename.includes('..')) return { ok: false, error: 'invalid filename' };
    try {
      const inferred = this._inferGraphForBackup(filename, slug);
      if (inferred.error) return { ok: false, error: inferred.error };
      const graph = inferred.graph;
      const graphDbPath = graph?.dbPath || this.registry?.getDbPath?.(graph?.slug) || this.graphDbPath;
      const mismatch = this._assertBackupMatchesGraph(filename, graph);
      if (mismatch) return { ok: false, error: mismatch };
      const dir = this._ensureDir(graphDbPath);
      const full = path.join(dir, filename);
      if (!fs.existsSync(full)) return { ok: false, error: 'not found' };
      fs.unlinkSync(full);
      try { if (fs.existsSync(full + '.json')) fs.unlinkSync(full + '.json'); } catch {}
      return { ok: true, slug: graph?.slug || null };
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
  async restoreBackup(filename, { slug = null } = {}) {
    if (!this.db && !this.registry) return { ok: false, error: 'no db' };
    if (!filename || filename.includes('/') || filename.includes('..')) return { ok: false, error: 'invalid filename' };

    const inferred = this._inferGraphForBackup(filename, slug);
    if (inferred.error) return { ok: false, error: inferred.error };
    const graph = inferred.graph;
    const graphDbPath = graph?.dbPath || this.registry?.getDbPath?.(graph?.slug) || this.graphDbPath;
    const mismatch = this._assertBackupMatchesGraph(filename, graph);
    if (mismatch) return { ok: false, error: mismatch };

    const dir = this._ensureDir(graphDbPath);
    const full = path.join(dir, filename);
    if (!fs.existsSync(full)) return { ok: false, error: 'backup file not found' };

    // Pre-restore safety snapshot
    const pre = await this.runBackupForGraph({
      slug: graph?.slug,
      dbPath: graphDbPath,
      force: true,
      note: 'pre-restore',
    });
    if (!pre.ok && !pre.skipped) {
      return { ok: false, error: 'pre-restore snapshot failed: ' + (pre.error || 'unknown') };
    }

    const targetIsActiveHandle = graphDbPath === this.graphDbPath && this.db;
    let targetDb = null;
    let attached = false;
    try {
      targetDb = targetIsActiveHandle ? this.db : new DatabaseSync(graphDbPath);
      const escaped = full.replace(/'/g, "''");
      targetDb.exec(`ATTACH DATABASE '${escaped}' AS bak`);
      attached = true;

      const baseTables = targetDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name"
      ).all().map(r => r.name);
      const bakTables = targetDb.prepare(
        "SELECT name FROM bak.sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name"
      ).all().map(r => r.name);
      const bakSet = new Set(bakTables);
      const ftsTables = targetDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL%' AND sql LIKE '%fts%'"
      ).all().map(r => r.name);

      let tablesRestored = 0, rowsRestored = 0, tablesSkipped = 0;

      const prevFk = targetDb.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0;
      targetDb.exec('PRAGMA foreign_keys = OFF');
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        for (const t of baseTables) {
          if (!bakSet.has(t)) {
            tablesSkipped++;
            continue;
          }
          const liveCols = targetDb.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
          const bakCols = targetDb.prepare(`PRAGMA bak.table_info("${t}")`).all().map(c => c.name);
          const shared = liveCols.filter(c => bakCols.includes(c));
          if (!shared.length) { tablesSkipped++; continue; }

          targetDb.exec(`DELETE FROM "${t}"`);
          const colList = shared.map(c => `"${c}"`).join(', ');
          targetDb.exec(`INSERT INTO "${t}" (${colList}) SELECT ${colList} FROM bak."${t}"`);
          // exec() doesn't return row count on node:sqlite; estimate via count
          try {
            const c = targetDb.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
            rowsRestored += c;
          } catch (e) { this.log.warn('[backup] db.prepare failed: ' + e.message); }
          tablesRestored++;
        }
        targetDb.exec('COMMIT');
      } catch (e) {
        targetDb.exec('ROLLBACK');
        throw e;
      } finally {
        try { targetDb.exec(`PRAGMA foreign_keys = ${prevFk ? 'ON' : 'OFF'}`); } catch (e) { this.log.warn('[backup] db.exec failed: ' + e.message); }
      }

      // Rebuild FTS indices from restored base tables
      for (const f of ftsTables) {
        try { targetDb.exec(`INSERT INTO "${f}"("${f}") VALUES('rebuild')`); } catch (e) {
          this.log.warn(`[backup] rebuild FTS ${f}: ${e.message}`);
        }
      }

      try { this.registry?.refreshStats?.(graph?.slug); } catch {}
      this.stats.restores++;
      this.log.info(`[backup] Restored ${graph?.slug || 'graph'} from ${filename} — ${tablesRestored} tables, ${rowsRestored} rows, ${tablesSkipped} skipped, FTS rebuilt: ${ftsTables.length}`);
      return { ok: true, slug: graph?.slug || null, tablesRestored, rowsRestored, tablesSkipped, ftsRebuilt: ftsTables.length, preRestoreSnapshot: pre.file };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[backup] restore failed:', e.message);
      return { ok: false, slug: graph?.slug || null, error: e.message, preRestoreSnapshot: pre.file };
    } finally {
      if (attached) {
        try { targetDb?.exec('DETACH DATABASE bak'); } catch (e) { this.log.warn('[backup] db.exec failed: ' + e.message); }
      }
      if (targetDb && targetDb !== this.db) {
        try { targetDb.close(); } catch {}
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
