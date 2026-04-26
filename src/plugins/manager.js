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
    if (!this._configPersister) {
      throw new Error('No config persister registered. Wire it from gateways/web.js.');
    }
    const oldConfig = { ...(this._appContext?.config?.plugins?.[pluginId] || {}) };
    const newConfig = await this._configPersister(pluginId, partial);
    await this.dispatchConfigChange(pluginId, oldConfig, newConfig);
    return newConfig;
  }

  /**
   * Scan pluginsDir for plugin directories, validate manifests, require entries.
   * Each subdirectory must contain spore.plugin.json or openclaw.plugin.json.
   */
  async loadAll(pluginsDir) {
    if (!pluginsDir || !fs.existsSync(pluginsDir)) {
      this.log.debug(`[plugins] No plugins directory at ${pluginsDir}`);
      return;
    }

    // Refuse to load plugins from inside the agent-writable workspace —
    // a compromised agent run could otherwise drop a plugin and gain RCE
    // at the next boot. Plugins must live in an operator-managed location.
    const workspacePath = this.config.workspacePath ? path.resolve(this.config.workspacePath) : null;
    if (workspacePath) {
      const resolvedPlugins = path.resolve(pluginsDir);
      if (resolvedPlugins === workspacePath || resolvedPlugins.startsWith(workspacePath + path.sep)) {
        this.log.error(`[plugins] Refusing to load: pluginsDir (${resolvedPlugins}) is inside workspace (${workspacePath}). Plugins must live outside agent-writable paths.`);
        return;
      }
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
          registerFn: typeof registerFn === 'function' ? registerFn : registerFn.register,
          instance: null,
        });

        this.log.info(`[plugins] Loaded ${manifest.id} (${manifest.kind})${manifest.openclawCompat ? ' [OpenClaw compat]' : ''}`);
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
   * Cascades through aspects/attributes/edges; FK ON DELETE CASCADE handles
   * dependent rows in node_sources, edge_sources, aliases, gaps, etc.
   * Uses prepared statements so the plugin id never enters SQL as a literal.
   */
  _runAutoUninstall(db, pluginId) {
    const stmts = [
      'DELETE FROM attributes WHERE extracted_with = ?',
      'DELETE FROM aspects    WHERE extracted_with = ?',
      'DELETE FROM edges      WHERE extracted_with = ?',
      'DELETE FROM nodes      WHERE extracted_with = ?',
    ];
    for (const s of stmts) db.prepare(s).run(pluginId);
  }

  /**
   * Iterate plugins that registered reference nodes; for each, run install SQL
   * exactly once per (pluginId, schemaVersion). Idempotent across boots.
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
          // Schema upgrade: tear down old data first so the new install SQL
          // doesn't race idempotency guards against stale rows.
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
   * Get all middleware hooks of a given type.
   */
  getMiddleware(hook) {
    const handlers = [];
    for (const api of this.getPlugins('middleware')) {
      handlers.push(...api.getMiddleware(hook));
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
        return { pluginId, handler: route.handler };
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
   * Fire a worker hook event (e.g. afterLearn, beforeLearn).
   */
  async fireWorkerHook(event, data) {
    for (const api of this.getPlugins('worker-hook')) {
      for (const handler of api.getWorkerHooks(event)) {
        try {
          await handler(data);
        } catch (e) {
          this.log.error(`[plugins] Worker hook error (${event}): ${e.message}`);
        }
      }
    }
  }

  /**
   * Validate a path is acceptable for hot install — refuses paths inside the
   * agent-writable workspace, mirroring the boot-time check in `loadAll`.
   */
  _validatePluginPath(pluginPath) {
    const resolved = path.resolve(pluginPath);
    const workspacePath = this.config.workspacePath ? path.resolve(this.config.workspacePath) : null;
    if (workspacePath && (resolved === workspacePath || resolved.startsWith(workspacePath + path.sep))) {
      throw new Error(`Plugin path is inside agent-writable workspace (${workspacePath}); refusing for security`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Plugin path is not a directory: ${resolved}`);
    }
    return resolved;
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
  async installPlugin(pluginPath) {
    if (!this._appContext) {
      throw new Error('Plugin manager not initialized; cannot hot-install');
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

    const plugin = {
      manifest,
      path: resolved,
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
   * List installed plugins (id, kind, version, openclawCompat) for the manager UI.
   */
  listInstalled() {
    const out = [];
    for (const [id, plugin] of this.plugins) {
      out.push({
        id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        kind: plugin.manifest.kind,
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
