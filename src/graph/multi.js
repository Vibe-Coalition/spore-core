/**
 * multi.js — Multi-Graph Registry & Switching
 *
 * Manages multiple knowledge graphs per spore.
 * Each graph is a separate SQLite DB in /data/graphs/.
 * A registry file tracks metadata; an _active pointer selects the live graph.
 *
 * On first boot, migrates the legacy single graph.db into the registry.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const GRAPHS_DIR_NAME = 'graphs';
const REGISTRY_FILE = '_registry.json';
const ACTIVE_FILE = '_active';

class GraphRegistry {
  constructor(dataDir, config, log) {
    this.dataDir = dataDir; // e.g. /data
    this.graphsDir = path.join(dataDir, GRAPHS_DIR_NAME);
    this.registryPath = path.join(this.graphsDir, REGISTRY_FILE);
    this.activePath = path.join(this.graphsDir, ACTIVE_FILE);
    this.config = config;
    this.log = log;
    this._registry = {};
  }

  /**
   * Initialize the registry, migrating legacy graph.db if needed.
   * Returns the active graph's DB path.
   */
  init() {
    fs.mkdirSync(this.graphsDir, { recursive: true });

    if (fs.existsSync(this.registryPath)) {
      try {
        this._registry = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      } catch {
        this._registry = {};
      }
    }

    // Migrate legacy graph.db on first run
    if (Object.keys(this._registry).length === 0) {
      this._migrateLegacy();
    }

    const activeSlug = this.getActiveSlug();
    if (!activeSlug || !this._registry[activeSlug]) {
      const first = Object.keys(this._registry)[0];
      if (first) {
        this.setActive(first);
      } else {
        // No graphs at all — create a default
        const slug = this.create('Default', 'Initial knowledge graph');
        this.setActive(slug);
      }
    }

    return this.getActiveDbPath();
  }

  _migrateLegacy() {
    const legacyPath = path.join(this.dataDir, 'graph.db');
    const legacyWal = legacyPath + '-wal';
    const legacyShm = legacyPath + '-shm';

    if (fs.existsSync(legacyPath)) {
      const slug = 'default';
      const destPath = path.join(this.graphsDir, `${slug}.db`);

      // Copy (not move) so the legacy path still works until config is updated
      fs.copyFileSync(legacyPath, destPath);
      if (fs.existsSync(legacyWal)) fs.copyFileSync(legacyWal, destPath + '-wal');
      if (fs.existsSync(legacyShm)) fs.copyFileSync(legacyShm, destPath + '-shm');

      let nodeCount = 0;
      try {
        const db = new DatabaseSync(destPath);
        nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
        db.close();
      } catch {}

      this._registry[slug] = {
        slug,
        name: 'Default',
        description: 'Migrated from original graph.db',
        created: new Date().toISOString(),
        nodeCount,
      };
      this._save();
      this.setActive(slug);
      this.log.info(`[multi-graph] Migrated legacy graph.db → graphs/default.db (${nodeCount} nodes)`);
    }
  }

  _save() {
    fs.writeFileSync(this.registryPath, JSON.stringify(this._registry, null, 2));
  }

  /** List all graphs with metadata. */
  list() {
    const activeSlug = this.getActiveSlug();
    return Object.values(this._registry).map(g => ({
      ...g,
      active: g.slug === activeSlug,
      dbPath: path.join(this.graphsDir, `${g.slug}.db`),
    }));
  }

  /** Get a single graph entry. */
  get(slug) {
    return this._registry[slug] || null;
  }

  /** Get the active graph slug. */
  getActiveSlug() {
    try {
      return fs.readFileSync(this.activePath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /** Get the active graph's DB file path. */
  getActiveDbPath() {
    const slug = this.getActiveSlug();
    if (!slug) return null;
    return path.join(this.graphsDir, `${slug}.db`);
  }

  /** Set the active graph. */
  setActive(slug) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    fs.writeFileSync(this.activePath, slug);
  }

  /**
   * Create a new graph, seeded with the standard seed-graph.sql.
   * Returns the slug.
   */
  create(name, description) {
    const slug = this._slugify(name);
    if (this._registry[slug]) throw new Error(`Graph "${slug}" already exists`);

    const dbPath = path.join(this.graphsDir, `${slug}.db`);

    // Seed with standard schema + agent identity
    const seedPath = path.join(__dirname, '..', 'seed-graph.sql');
    if (fs.existsSync(seedPath)) {
      let sql = fs.readFileSync(seedPath, 'utf8');
      const agentId = this.config.agentId || 'spore';
      const agentName = this.config.displayName || agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      sql = sql.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);
      const db = new DatabaseSync(dbPath);
      db.exec(sql);
      db.close();
    } else {
      new DatabaseSync(dbPath).close();
    }

    let nodeCount = 0;
    try {
      const db = new DatabaseSync(dbPath);
      nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      db.close();
    } catch {}

    this._registry[slug] = {
      slug,
      name,
      description: description || '',
      created: new Date().toISOString(),
      nodeCount,
    };
    this._save();
    this.log.info(`[multi-graph] Created graph "${name}" (${slug}) with ${nodeCount} seed nodes`);
    return slug;
  }

  /**
   * Duplicate an existing graph under a new name.
   * Returns the new slug.
   */
  duplicate(sourceSlug, newName) {
    if (!this._registry[sourceSlug]) throw new Error(`Source graph "${sourceSlug}" not found`);
    const newSlug = this._slugify(newName);
    if (this._registry[newSlug]) throw new Error(`Graph "${newSlug}" already exists`);

    const srcPath = path.join(this.graphsDir, `${sourceSlug}.db`);
    const destPath = path.join(this.graphsDir, `${newSlug}.db`);
    fs.copyFileSync(srcPath, destPath);

    let nodeCount = 0;
    try {
      const db = new DatabaseSync(destPath);
      nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      db.close();
    } catch {}

    this._registry[newSlug] = {
      slug: newSlug,
      name: newName,
      description: `Duplicated from "${this._registry[sourceSlug].name}"`,
      created: new Date().toISOString(),
      nodeCount,
    };
    this._save();
    this.log.info(`[multi-graph] Duplicated ${sourceSlug} → ${newSlug} (${nodeCount} nodes)`);
    return newSlug;
  }

  /** Delete a graph. Cannot delete the active graph. */
  delete(slug) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    if (slug === this.getActiveSlug()) throw new Error('Cannot delete the active graph. Switch to another graph first.');

    const dbPath = path.join(this.graphsDir, `${slug}.db`);
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}

    delete this._registry[slug];
    this._save();
    this.log.info(`[multi-graph] Deleted graph "${slug}"`);
  }

  /** Rename a graph. */
  rename(slug, newName) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    this._registry[slug].name = newName;
    this._save();
  }

  /** Update description. */
  describe(slug, description) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    this._registry[slug].description = description;
    this._save();
  }

  /** Refresh node count for a graph from its DB. */
  refreshStats(slug) {
    if (!this._registry[slug]) return;
    const dbPath = path.join(this.graphsDir, `${slug}.db`);
    try {
      const db = new DatabaseSync(dbPath);
      this._registry[slug].nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      this._registry[slug].edgeCount = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
      db.close();
      this._save();
    } catch {}
  }

  _slugify(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 48) || 'graph';
  }
}

module.exports = { GraphRegistry };
