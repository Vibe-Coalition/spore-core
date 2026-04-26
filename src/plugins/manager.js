/**
 * plugins/manager.js — Plugin Manager
 *
 * Discovers, validates, loads, and lifecycle-manages plugins.
 * Supports both native SPORE plugins (spore.plugin.json) and
 * OpenClaw-compatible plugins (openclaw.plugin.json).
 */

const fs = require('fs');
const path = require('path');
const { PluginAPI } = require('./api');

const VALID_KINDS = new Set([
  'context-engine',
  'tool',
  'gateway',
  'worker-hook',
  'middleware',
]);

class PluginManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.plugins = new Map();
    this._appContext = null;
    this._configPersister = null;
    // Discovery roots set by app.js. Bundled lives in the docker image,
    // user lives in the workspace bind mount.
    this._discoveryDirs = { bundled: null, user: null };
  }

  setDiscoveryDirs({ bundled = null, user = null } = {}) {
    this._discoveryDirs = { bundled, user };
  }

  getDiscoveryDirs() {
    return { ...this._discoveryDirs };
  }

  /**
   * Wire a function that persists plugin config and triggers live reaction.
   * Called by gateways/web.js once the settings persistence path is up.
   * Signature: `async (pluginId, partial) => newConfig`.
   */
  setConfigPersister(fn) {
    this._configPersister = fn;
  }

  /**
   * Persist a plugin's config via the registered persister and dispatch the
   * onConfigChange callback. Used by both PluginAPI.setConfig and the
   * settings-save endpoint.
   */
  async persistPluginConfig(pluginId, partial) {
    const oldConfig = { ...(this._appContext?.config?.plugins?.[pluginId] || {}) };
    let newConfig;
    if (this._configPersister) {
      newConfig = await this._configPersister(pluginId, partial);
    } else {
      // No persister registered yet (e.g. plugin's register-time backfill runs
      // before the web gateway wires its lazy persister). Apply in memory so
      // getConfig() reflects the change immediately; the next user-driven
      // settings save will serialize the merged state to disk.
      const cfg = this._appContext?.config;
      if (!cfg) throw new Error('No appContext config available for in-memory write');
      if (!cfg.plugins) cfg.plugins = {};
      cfg.plugins[pluginId] = { ...oldConfig, ...partial };
      newConfig = { ...cfg.plugins[pluginId] };
    }
    await this.dispatchConfigChange(pluginId, oldConfig, newConfig);
    return newConfig;
  }

  /**
   * Scan a plugin directory and load every subdirectory that contains a
   * valid manifest. Each loaded plugin is tagged with `source` so the UI
   * can show where it came from (bundled vs user).
   *
   * Note: the bundled dir is shipped with the docker image; the user dir
   * is operator-writable inside the workspace bind mount. Both are
   * operator-trusted by virtue of opting into SPORE_PLUGINS_ENABLED.
   */
  async loadAll(pluginsDir, opts = {}) {
    const source = opts.source || 'unknown';
    if (!pluginsDir || !fs.existsSync(pluginsDir)) {
      this.log.debug(`[plugins] No plugins directory at ${pluginsDir} (${source})`);
      return;
    }

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());

    for (const dir of dirs) {
      const pluginPath = path.join(pluginsDir, dir.name);
      try {
        const manifest = this._readManifest(pluginPath);
        if (!manifest) {
          this.log.debug(`[plugins] Skipping ${dir.name} — no manifest found`);
          continue;
        }

        if (!VALID_KINDS.has(manifest.kind)) {
          this.log.warn(`[plugins] Skipping ${manifest.id} — unknown kind "${manifest.kind}"`);
          continue;
        }

        const entryFile = path.join(pluginPath, manifest.entry || './index.js');
        if (!fs.existsSync(entryFile)) {
          this.log.warn(`[plugins] Skipping ${manifest.id} — entry file not found: ${entryFile}`);
          continue;
        }

        const entryModule = require(entryFile);
        const registerFn = entryModule.default || entryModule.register || entryModule;

        if (typeof registerFn !== 'function' && typeof registerFn?.register !== 'function') {
          this.log.warn(`[plugins] Skipping ${manifest.id} — entry does not export a function or { register }`);
          continue;
        }

        this.plugins.set(manifest.id, {
          manifest,
          path: pluginPath,
          source,
          registerFn: typeof registerFn === 'function' ? registerFn : registerFn.register,
          instance: null,
        });

        this.log.info(`[plugins] Loaded ${manifest.id} (${manifest.kind}, ${source})${manifest.openclawCompat ? ' [OpenClaw compat]' : ''}`);
      } catch (e) {
        this.log.error(`[plugins] Failed to load ${dir.name}: ${e.message}`);
      }
    }

    // Dependency ordering
    this._sortByDependencies();
  }

  /**
   * Read manifest from either spore.plugin.json or openclaw.plugin.json.
   */
  _readManifest(pluginPath) {
    const animaManifest = path.join(pluginPath, 'spore.plugin.json');
    const openclawManifest = path.join(pluginPath, 'openclaw.plugin.json');

    if (fs.existsSync(animaManifest)) {
      const raw = JSON.parse(fs.readFileSync(animaManifest, 'utf8'));
      return {
        id: raw.id,
        name: raw.name || raw.id,
        version: raw.version || '0.0.0',
        kind: raw.kind,
        entry: raw.entry || './index.js',
        depends: raw.depends || [],
        configSchema: raw.config_schema || {},
        openclawCompat: false,
      };
    }

    if (fs.existsSync(openclawManifest)) {
      const raw = JSON.parse(fs.readFileSync(openclawManifest, 'utf8'));
      return {
        id: raw.id,
        name: raw.name || raw.id,
        version: raw.version || '0.0.0',
        kind: raw.kind || 'context-engine',
        entry: raw.entry || './index.js',
        depends: raw.depends || [],
        configSchema: raw.config_schema || {},
        openclawCompat: true,
      };
    }

    // Also check package.json for an "spore" or "openclaw" field
    const pkgPath = path.join(pluginPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const meta = pkg.spore || pkg.openclaw;
      if (meta?.kind) {
        return {
          id: meta.id || pkg.name,
          name: meta.name || pkg.name,
          version: pkg.version || '0.0.0',
          kind: meta.kind,
          entry: meta.entry || pkg.main || './index.js',
          depends: meta.depends || [],
          configSchema: meta.config_schema || {},
          openclawCompat: !!pkg.openclaw,
        };
      }
    }

    return null;
  }

  /**
   * Topological sort plugins by `depends` field.
   */
  _sortByDependencies() {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        this.log.warn(`[plugins] Circular dependency detected involving ${id}`);
        return;
      }
      visiting.add(id);
      const plugin = this.plugins.get(id);
      if (plugin) {
        for (const dep of plugin.manifest.depends) {
          if (this.plugins.has(dep)) visit(dep);
        }
      }
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const id of this.plugins.keys()) visit(id);

    const reordered = new Map();
    for (const id of sorted) {
      reordered.set(id, this.plugins.get(id));
    }
    this.plugins = reordered;
  }

  /**
   * Initialize all loaded plugins by calling their register functions with a PluginAPI.
   * After registration, runs reference-node install SQL for any plugin that
   * hasn't yet been installed at its current schemaVersion.
   */
  async initAll(appContext) {
    this._appContext = appContext;

    for (const [id, plugin] of this.plugins) {
      try {
        const api = new PluginAPI(id, plugin.manifest, appContext, this.log, plugin.path, this);
        await plugin.registerFn(api);
        plugin.instance = api;
        this.log.info(`[plugins] Initialized ${id}`);
      } catch (e) {
        this.log.error(`[plugins] Failed to init ${id}: ${e.message}`);
      }
    }

    this._runReferenceNodeInstalls();
  }

  /**
   * Ensure the bookkeeping table that records which plugins have run their
   * reference-node install SQL at which schemaVersion.
   */
  _ensurePluginInstallsTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_installs (
      plugin_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      manifest_version TEXT
    )`);
  }

  /**
   * Resolve a plugin's install/uninstall SQL source (path or {sql}) to raw text.
   */
  _resolveSqlSource(api, source) {
    if (!source) return null;
    if (typeof source === 'object' && typeof source.sql === 'string') return source.sql;
    if (typeof source === 'string') {
      const resolved = path.isAbsolute(source) ? source : path.join(api.pluginPath, source);
      if (!fs.existsSync(resolved)) {
        throw new Error(`SQL source not found: ${resolved}`);
      }
      return fs.readFileSync(resolved, 'utf8');
    }
    throw new Error(`Invalid SQL source: ${typeof source}`);
  }

  /**
   * Substitute the `{{plugin_id}}` token so plugin SQL can tag rows with
   * `extracted_with = '{{plugin_id}}'` without hard-coding their own id.
   * Plugin ids are validated at load time so injection is not a concern.
   */
  _substituteTokens(sql, pluginId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
      throw new Error(`Plugin id contains invalid chars: ${pluginId}`);
    }
    return sql.replace(/\{\{plugin_id\}\}/g, pluginId);
  }

  /**
   * Default uninstall: remove every row this plugin owns by `extracted_with`.
   * Order matters because edges.source/target reference nodes.id without
   * ON DELETE CASCADE — any edge pointing at a plugin-owned node must go
   * before the node DELETE, even if the edge itself was created by the
   * maintainer / another plugin / user activity. The first DELETE handles
   * that defensively by purging any edge whose source OR target is a
   * plugin-owned node, regardless of who tagged the edge.
   */
  _runAutoUninstall(db, pluginId) {
    const ownedNodeIds = db.prepare('SELECT id FROM nodes WHERE extracted_with = ?').all(pluginId).map(r => r.id);
    if (ownedNodeIds.length > 0) {
      // Drop any edge referencing a node we're about to delete.
      const placeholders = ownedNodeIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`)
        .run(...ownedNodeIds, ...ownedNodeIds);
    }
    const stmts = [
      'DELETE FROM attributes WHERE extracted_with = ?',
      'DELETE FROM aspects    WHERE extracted_with = ?',
      'DELETE FROM edges      WHERE extracted_with = ?',
      'DELETE FROM nodes      WHERE extracted_with = ?',
    ];
    for (const s of stmts) db.prepare(s).run(pluginId);
  }

  /**
   * Safety net for plugins shipping a custom uninstall.sql that forgets to
   * clean up edges referencing their owned nodes. Called AFTER custom
   * uninstall SQL runs, BEFORE the bookkeeping row is removed. Idempotent:
   * if the custom SQL handled it, this is a no-op.
   */
  _purgeOrphanEdgesForPluginNodes(db, pluginId) {
    const ownedNodeIds = db.prepare('SELECT id FROM nodes WHERE extracted_with = ?').all(pluginId).map(r => r.id);
    if (ownedNodeIds.length === 0) return;
    const placeholders = ownedNodeIds.map(() => '?').join(',');
    const purged = db.prepare(`DELETE FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`)
      .run(...ownedNodeIds, ...ownedNodeIds);
    if (purged.changes > 0) {
      this.log.debug(`[plugins] Purged ${purged.changes} orphan edge(s) referencing ${pluginId}'s nodes`);
    }
  }

  /**
   * Iterate plugins that registered reference nodes; for each, run install SQL
   * exactly once per (pluginId, schemaVersion). Idempotent across boots.
   *
   * Run-once semantics: if `plugin_installs` already records the current
   * schema_version, the install is skipped on subsequent boots. Plugin
   * data is expected to persist between boots; a missing node means
   * something deleted it out-of-band, which is the operator's call to
   * uninstall + reinstall (or restore from backup) — we don't auto-heal.
   *
   * Schema-version bumps trigger the uninstall-then-install path so a
   * fresh install of the new version doesn't race idempotency guards
   * against stale rows.
   */
  _runReferenceNodeInstalls() {
    const graph = this._appContext?.graph;
    const db = graph?.db;
    if (!db) {
      this.log.debug('[plugins] No graph DB available — skipping reference-node installs');
      return;
    }

    this._ensurePluginInstallsTable(db);

    for (const [id, plugin] of this.plugins) {
      const api = plugin.instance;
      if (!api) continue;
      const refs = api.getReferenceNodes();
      if (!refs) continue;

      try {
        const existing = db.prepare(
          'SELECT schema_version FROM plugin_installs WHERE plugin_id = ?'
        ).get(id);

        if (existing && existing.schema_version >= refs.schemaVersion) {
          this.log.debug(`[plugins] ${id} ref nodes already at v${existing.schema_version}`);
          continue;
        }

        if (existing && existing.schema_version < refs.schemaVersion) {
          this.log.info(`[plugins] ${id} ref nodes upgrading v${existing.schema_version} → v${refs.schemaVersion}`);
          this._executeUninstallFor(id, api, db);
        }

        const sql = this._substituteTokens(this._resolveSqlSource(api, refs.install), id);
        db.exec('BEGIN');
        try {
          db.exec(sql);
          db.prepare(
            'INSERT OR REPLACE INTO plugin_installs (plugin_id, schema_version, installed_at, manifest_version) VALUES (?, ?, CURRENT_TIMESTAMP, ?)'
          ).run(id, refs.schemaVersion, plugin.manifest.version || null);
          db.exec('COMMIT');
          this.log.info(`[plugins] Installed ref nodes for ${id} (v${refs.schemaVersion})`);
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } catch (e) {
        this.log.error(`[plugins] Failed to install ref nodes for ${id}: ${e.message}`);
      }
    }
  }

  /**
   * Execute the uninstall SQL for a single plugin. Used by both schema upgrades
   * (during _runReferenceNodeInstalls) and hot uninstall (Phase 1.2).
   */
  _executeUninstallFor(pluginId, api, db) {
    const refs = api?.getReferenceNodes?.();
    db.exec('BEGIN');
    try {
      if (refs && refs.uninstall) {
        const sql = this._substituteTokens(this._resolveSqlSource(api, refs.uninstall), pluginId);
        db.exec(sql);
        // Safety net: purge any edges still pointing at this plugin's nodes
        // in case the custom SQL forgot. No-op if it didn't.
        this._purgeOrphanEdgesForPluginNodes(db, pluginId);
      } else {
        this._runAutoUninstall(db, pluginId);
      }
      db.prepare('DELETE FROM plugin_installs WHERE plugin_id = ?').run(pluginId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Return all PluginAPI instances of a given kind.
   */
  getPlugins(kind) {
    const result = [];
    for (const [, plugin] of this.plugins) {
      if (plugin.manifest.kind === kind && plugin.instance) {
        result.push(plugin.instance);
      }
    }
    return result;
  }

  /**
   * Collect all tool definitions registered by tool plugins.
   */
  getToolDefinitions() {
    const defs = [];
    for (const api of this.getPlugins('tool')) {
      defs.push(...api.getRegisteredTools().map(t => ({
        name: t.name,
        description: t.definition.description,
        input_schema: t.definition.inputSchema,
        _pluginExecute: t.definition.execute,
      })));
    }
    return defs;
  }

  /**
   * Execute a plugin-registered tool by name. Returns null if not a plugin tool.
   */
  async executePluginTool(name, input, ctx) {
    for (const api of this.getPlugins('tool')) {
      const tool = api.getRegisteredTools().find(t => t.name === name);
      if (tool) return await tool.definition.execute(input, ctx);
    }
    return null;
  }

  /**
   * Get all context engine instances (both native and OpenClaw-adapted).
   */
  getContextEngines() {
    const engines = [];
    for (const api of this.getPlugins('context-engine')) {
      engines.push(...api.getRegisteredContextEngines());
    }
    return engines;
  }

  /**
   * Get all middleware hooks of a given type. Walks every loaded plugin —
   * not just plugins of kind 'middleware' — because middleware can be
   * registered alongside any primary kind (e.g. the acorn-cli 'tool'
   * plugin registers an afterToolExec middleware).
   */
  getMiddleware(hook) {
    const handlers = [];
    for (const [, plugin] of this.plugins) {
      const list = plugin.instance?.getMiddleware?.(hook);
      if (list && list.length) handlers.push(...list);
    }
    return handlers;
  }

  /**
   * Get all agent-loop lifecycle hooks for an event ('afterTurn' / 'beforeRound').
   * Walks every loaded plugin; lifecycle hooks aren't tied to a plugin kind.
   */
  getLifecycleHooks(event) {
    const handlers = [];
    for (const [, plugin] of this.plugins) {
      const list = plugin.instance?.getLifecycleHooks?.(event);
      if (list && list.length) handlers.push(...list);
    }
    return handlers;
  }

  /**
   * Collect every plugin's dock items for the frontend to render alongside
   * built-in dock entries.
   */
  getDockItems() {
    const out = [];
    for (const [pluginId, plugin] of this.plugins) {
      const api = plugin.instance;
      if (!api?.getDockItems) continue;
      for (const item of api.getDockItems()) {
        out.push({ pluginId, ...item });
      }
    }
    return out;
  }

  /**
   * Resolve an HTTP request to a plugin web route.
   * Routes are namespaced under /api/plugins/<pluginId>/<routePath>.
   * Returns { handler, pluginId } or null when no route matches.
   */
  resolveWebRoute(method, urlPath) {
    const PREFIX = '/api/plugins/';
    if (!urlPath.startsWith(PREFIX)) return null;
    const rest = urlPath.slice(PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const pluginId = rest.slice(0, slash);
    const routePath = rest.slice(slash);
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.instance?.getWebRoutes) return null;
    const upper = String(method).toUpperCase();
    for (const route of plugin.instance.getWebRoutes()) {
      if (route.method === upper && route.path === routePath) {
        return { pluginId, handler: route.handler, public: !!route.public };
      }
    }
    return null;
  }

  /**
   * Resolve a WS message type of the form `plugin:<pluginId>:<msgType>` to
   * its handler. Returns { handler, pluginId } or null.
   */
  resolveWsHandler(messageType) {
    if (!messageType?.startsWith?.('plugin:')) return null;
    const rest = messageType.slice('plugin:'.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) return null;
    const pluginId = rest.slice(0, colon);
    const msgType = rest.slice(colon + 1);
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.instance?.getWsHandler) return null;
    const handler = plugin.instance.getWsHandler(msgType);
    return handler ? { pluginId, handler } : null;
  }

  /**
   * Collect every plugin's settings pane (if registered) along with its
   * current config slot, masked for secret fields. Used by the settings UI.
   */
  getSettingsPanes() {
    const out = [];
    for (const [pluginId, plugin] of this.plugins) {
      const api = plugin.instance;
      if (!api?.getSettingsPane) continue;
      const pane = api.getSettingsPane();
      if (!pane) continue;
      const slot = (this._appContext?.config?.plugins?.[pluginId]) || {};
      const values = {};
      const meta = {};
      if (pane.schema) {
        for (const field of pane.schema) {
          const v = slot[field.key];
          if (field.secret) {
            values[field.key] = '';
            meta[field.key] = { isSet: v !== undefined && v !== null && v !== '' };
          } else {
            values[field.key] = v !== undefined ? v : (field.default !== undefined ? field.default : null);
          }
        }
      }
      out.push({
        pluginId,
        title: pane.title,
        tab: pane.tab,
        description: pane.description,
        schema: pane.schema,
        html: pane.html,
        values,
        meta,
      });
    }
    return out;
  }

  /**
   * Fire a single plugin's onConfigChange callback. Called by the settings
   * persistence path after a successful patch. Errors are caught at the API
   * boundary so a misbehaving plugin can't break settings.save.
   */
  async dispatchConfigChange(pluginId, oldConfig, newConfig) {
    const plugin = this.plugins.get(pluginId);
    const api = plugin?.instance;
    if (!api?._fireConfigChange) return;
    try {
      await Promise.resolve(api._fireConfigChange(newConfig, oldConfig));
    } catch (e) {
      this.log.warn(`[plugins] ${pluginId} config-change handler failed: ${e.message}`);
    }
  }

  /**
   * Collect all prompt sections registered by any plugin for the given mode.
   * Sections registered with modeName === '*' are returned for every mode.
   * Returns an array of { pluginId, sectionName, renderFn }.
   */
  getPromptSections(modeName) {
    const out = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (!plugin.instance?.getPromptSections) continue;
      for (const ps of plugin.instance.getPromptSections()) {
        if (ps.modeName === modeName || ps.modeName === '*') {
          out.push({ pluginId, sectionName: ps.sectionName, renderFn: ps.renderFn });
        }
      }
    }
    return out;
  }

  /**
   * Fire a worker hook event (e.g. afterLearn, beforeLearn). Walks every
   * loaded plugin instead of only kind='worker-hook' plugins — same
   * rationale as getMiddleware/getLifecycleHooks: worker hooks can be
   * registered alongside any primary kind (e.g. acorn-cli is kind 'tool'
   * but registers an afterLearn handler).
   */
  async fireWorkerHook(event, data) {
    for (const [, plugin] of this.plugins) {
      const handlers = plugin.instance?.getWorkerHooks?.(event) || [];
      for (const handler of handlers) {
        try {
          await handler(data);
        } catch (e) {
          this.log.error(`[plugins] Worker hook error (${event}): ${e.message}`);
        }
      }
    }
  }

  /**
   * Validate a path is acceptable for hot install. The path must be inside
   * one of the configured discovery roots (bundled or user) — operators can
   * only install plugins they've intentionally placed in those dirs.
   */
  _validatePluginPath(pluginPath) {
    const resolved = path.resolve(pluginPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Plugin path is not a directory: ${resolved}`);
    }
    const roots = [this._discoveryDirs.bundled, this._discoveryDirs.user]
      .filter(Boolean)
      .map(d => path.resolve(d));
    if (roots.length > 0) {
      const inRoot = roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
      if (!inRoot) {
        throw new Error(`Plugin path is outside configured plugin dirs (${roots.join(', ')})`);
      }
    }
    return resolved;
  }

  /**
   * Resolve a plugin id to its on-disk path by searching both discovery dirs.
   * User dir is preferred over bundled when an id collides, so a user-supplied
   * override of a bundled plugin takes effect.
   */
  _resolveIdToPath(pluginId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
      throw new Error(`Invalid plugin id: ${pluginId}`);
    }
    const dirs = [this._discoveryDirs.user, this._discoveryDirs.bundled].filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, pluginId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
    throw new Error(`Plugin "${pluginId}" not found in any discovery dir`);
  }

  /**
   * Hot-install a plugin from a directory path. Validates manifest, runs
   * register, executes reference-node install SQL, registers tools/gateways/
   * middleware. Returns the plugin's manifest on success.
   *
   * Caveat: due to Node's module cache, *upgrading* a plugin that was
   * previously loaded in this process still requires a restart. Installing
   * a previously-uninstalled plugin works hot.
   */
  async installPlugin(pathOrOpts) {
    if (!this._appContext) {
      throw new Error('Plugin manager not initialized; cannot hot-install');
    }

    // Accepts either a string path (legacy) or { id } / { path }.
    let pluginPath;
    if (typeof pathOrOpts === 'string') {
      pluginPath = pathOrOpts;
    } else if (pathOrOpts?.path) {
      pluginPath = pathOrOpts.path;
    } else if (pathOrOpts?.id) {
      pluginPath = this._resolveIdToPath(pathOrOpts.id);
    } else {
      throw new Error('installPlugin requires a path string, {path}, or {id}');
    }

    const resolved = this._validatePluginPath(pluginPath);

    const manifest = this._readManifest(resolved);
    if (!manifest) throw new Error(`No plugin manifest found at ${resolved}`);
    if (!VALID_KINDS.has(manifest.kind)) throw new Error(`Unknown plugin kind: ${manifest.kind}`);
    if (this.plugins.has(manifest.id)) throw new Error(`Plugin ${manifest.id} is already installed`);

    const entryFile = path.join(resolved, manifest.entry || './index.js');
    if (!fs.existsSync(entryFile)) throw new Error(`Entry file not found: ${entryFile}`);

    const entryModule = require(entryFile);
    const registerFn = entryModule.default || entryModule.register || entryModule;
    if (typeof registerFn !== 'function' && typeof registerFn?.register !== 'function') {
      throw new Error(`Plugin entry does not export a function or { register }`);
    }

    const source = this._sourceForPath(resolved);

    const plugin = {
      manifest,
      path: resolved,
      source,
      registerFn: typeof registerFn === 'function' ? registerFn : registerFn.register,
      instance: null,
    };
    this.plugins.set(manifest.id, plugin);

    try {
      const api = new PluginAPI(manifest.id, manifest, this._appContext, this.log, resolved, this);
      await plugin.registerFn(api);
      plugin.instance = api;

      if (api.getReferenceNodes()) {
        this._runReferenceNodeInstalls();
      }

      if (this._appContext.tools?.reloadPluginTools) {
        this._appContext.tools.reloadPluginTools();
      }

      this.log.info(`[plugins] Hot-installed ${manifest.id} (${manifest.kind})`);
      return manifest;
    } catch (e) {
      this.plugins.delete(manifest.id);
      throw new Error(`Plugin install failed for ${manifest.id}: ${e.message}`);
    }
  }

  /**
   * Hot-uninstall a plugin: shutdown handler → remove gateways/tools → run
   * uninstall SQL → drop from manager. Returns counts of removed entities.
   */
  async uninstallPlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed`);

    const api = plugin.instance;
    const removed = { tools: 0, gateways: 0, refNodes: 0 };

    try {
      if (api?.shutdown) await api.shutdown();
    } catch (e) {
      this.log.warn(`[plugins] ${pluginId} shutdown handler threw: ${e.message}`);
    }

    if (api) {
      removed.tools = api.getRegisteredTools().length;
      const gws = api.getRegisteredGateways();
      removed.gateways = gws.length;
      const gatewayMap = this._appContext?.gateways;
      if (gatewayMap?.delete) {
        for (const { name } of gws) gatewayMap.delete(`plugin:${name}`);
      }
    }

    const db = this._appContext?.graph?.db;
    if (db && api?.getReferenceNodes?.()) {
      removed.refNodes = db.prepare(
        'SELECT COUNT(*) as c FROM nodes WHERE extracted_with = ?'
      ).get(pluginId)?.c || 0;
      this._executeUninstallFor(pluginId, api, db);
    } else if (db) {
      // No registered ref bundle, but plugin may still have left rows behind.
      this._runAutoUninstall(db, pluginId);
    }

    this.plugins.delete(pluginId);

    if (this._appContext?.tools?.reloadPluginTools) {
      this._appContext.tools.reloadPluginTools();
    }

    this.log.info(`[plugins] Hot-uninstalled ${pluginId} (tools=${removed.tools}, gateways=${removed.gateways}, refNodes=${removed.refNodes})`);
    return { pluginId, ...removed };
  }

  /**
   * Tell whether a resolved path lives inside the bundled or user discovery
   * dir. Used to tag plugins with their origin in the manager UI.
   */
  _sourceForPath(resolved) {
    const r = path.resolve(resolved);
    const userDir = this._discoveryDirs.user ? path.resolve(this._discoveryDirs.user) : null;
    const bundledDir = this._discoveryDirs.bundled ? path.resolve(this._discoveryDirs.bundled) : null;
    if (userDir && (r === userDir || r.startsWith(userDir + path.sep))) return 'user';
    if (bundledDir && (r === bundledDir || r.startsWith(bundledDir + path.sep))) return 'bundled';
    return 'unknown';
  }

  /**
   * List currently-loaded plugins for the manager UI.
   */
  listInstalled() {
    const out = [];
    for (const [id, plugin] of this.plugins) {
      out.push({
        id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        kind: plugin.manifest.kind,
        source: plugin.source || 'unknown',
        openclawCompat: !!plugin.manifest.openclawCompat,
        depends: plugin.manifest.depends || [],
        hasReferenceNodes: !!plugin.instance?.getReferenceNodes?.(),
        toolCount: plugin.instance?.getRegisteredTools?.().length || 0,
        gatewayCount: plugin.instance?.getRegisteredGateways?.().length || 0,
      });
    }
    return out;
  }

  /**
   * Scan both discovery dirs and return the union with installed status.
   * This is what the Plugins settings tab consumes — every on-disk plugin
   * appears, even ones that aren't currently loaded.
   */
  listAvailable() {
    const out = new Map();
    const installedIds = new Set(this.plugins.keys());

    for (const [src, dir] of [['user', this._discoveryDirs.user], ['bundled', this._discoveryDirs.bundled]]) {
      if (!dir || !fs.existsSync(dir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        this.log.warn(`[plugins] Cannot scan ${src} dir ${dir}: ${e.message}`);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path.join(dir, entry.name);
        const manifest = this._readManifest(pluginPath);
        if (!manifest) continue;
        // User overrides bundled when ids collide; first one wins via Map.set
        // semantics, and we iterate user first.
        if (out.has(manifest.id)) continue;
        const installed = this.plugins.get(manifest.id);
        out.set(manifest.id, {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          kind: manifest.kind,
          source: src,
          path: pluginPath,
          depends: manifest.depends || [],
          openclawCompat: !!manifest.openclawCompat,
          isInstalled: installedIds.has(manifest.id),
          hasReferenceNodes: !!installed?.instance?.getReferenceNodes?.(),
          toolCount: installed?.instance?.getRegisteredTools?.().length || 0,
          gatewayCount: installed?.instance?.getRegisteredGateways?.().length || 0,
        });
      }
    }
    return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Clone a plugin from a git repository into the user discovery dir.
   * Returns the manifest of the freshly-cloned plugin (caller decides
   * whether to install it next). Refuses if the user dir isn't configured
   * or the target id collides with an existing on-disk plugin.
   *
   * @param {string} repoUrl  — git clone URL (https or git@host:repo)
   * @param {object} [opts]
   * @param {string} [opts.name] — override the directory name; defaults
   *                               to the repo's basename minus `.git`.
   * @param {string} [opts.ref]  — branch/tag/commit to check out.
   * @param {number} [opts.timeoutMs=120000]
   */
  async cloneFromGit(repoUrl, opts = {}) {
    const userDir = this._discoveryDirs.user;
    if (!userDir) {
      throw new Error('No user plugins dir configured (set SPORE_PLUGINS_USER_DIR).');
    }
    if (typeof repoUrl !== 'string' || !repoUrl.trim()) {
      throw new Error('repoUrl is required');
    }
    if (!/^(https?:\/\/|git@)[\w.@:\/_-]+\.git?$/.test(repoUrl) && !/^https?:\/\/[\w.@:\/_-]+$/.test(repoUrl)) {
      // Loose validation — git itself is the real authority — but reject
      // shell-metachar tricks.
      if (/[;&|`$<>"']/.test(repoUrl)) {
        throw new Error('Invalid characters in repoUrl');
      }
    }

    const baseName = opts.name || repoUrl.replace(/\.git$/, '').split('/').pop() || '';
    if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) {
      throw new Error(`Cannot derive a safe directory name from "${repoUrl}"; pass opts.name`);
    }

    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const target = path.join(userDir, baseName);
    if (fs.existsSync(target)) {
      throw new Error(`Plugin directory already exists: ${target}`);
    }

    const { spawn } = require('child_process');
    const args = ['clone', '--depth', '1'];
    if (opts.ref) args.push('--branch', String(opts.ref));
    args.push('--', repoUrl, target);

    await new Promise((resolve, reject) => {
      const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`git clone timed out after ${opts.timeoutMs || 120000}ms`));
      }, opts.timeoutMs || 120000);
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim().slice(0, 500)}`));
      });
    });

    const manifest = this._readManifest(target);
    if (!manifest) {
      // Failed to parse a manifest — clean up so the user doesn't have a
      // half-cloned dir littering their plugins folder.
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { this.log.warn(`[plugins] cleanup of ${target} failed: ${e.message}`); }
      throw new Error(`Cloned repo has no spore.plugin.json or openclaw.plugin.json manifest`);
    }
    this.log.info(`[plugins] Cloned ${manifest.id} (v${manifest.version}) from ${repoUrl} → ${target}`);
    return { manifest, path: target };
  }

  /**
   * Graceful shutdown of all plugins.
   */
  async shutdownAll() {
    for (const [id, plugin] of this.plugins) {
      try {
        if (plugin.instance?.shutdown) {
          await plugin.instance.shutdown();
        }
        this.log.info(`[plugins] Shut down ${id}`);
      } catch (e) {
        this.log.warn(`[plugins] Error shutting down ${id}: ${e.message}`);
      }
    }
  }
}

module.exports = { PluginManager };
