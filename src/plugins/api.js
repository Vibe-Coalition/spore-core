/**
 * plugins/api.js — Plugin API
 *
 * The object passed to plugin.register(api). Provides methods for
 * registering context engines, tools, gateways, worker hooks, and middleware.
 */

class PluginAPI {
  constructor(pluginId, manifest, appContext, log, pluginPath = null, manager = null) {
    this.pluginId = pluginId;
    this.manifest = manifest;
    this.pluginPath = pluginPath;
    this._appContext = appContext;
    this._log = log;
    this._manager = manager;

    this._contextEngines = [];
    this._tools = [];
    this._gateways = [];
    this._workerHooks = new Map();
    this._middleware = new Map();
    this._promptSections = [];
    this._referenceNodes = null;
    this._settingsPane = null;
    this._dockItems = [];
    this._webRoutes = [];
    this._wsHandlers = new Map();
    this._configChangeFn = null;
    this._shutdownFn = null;
  }

  /**
   * Register a context engine. Factory receives { config, graph, sessions }.
   * The returned engine should implement the lifecycle hooks:
   *   bootstrap(), ingest(message), assemble(budget), compact(),
   *   afterTurn(turn), prepareSubagentSpawn(), onSubagentEnded()
   */
  registerContextEngine(name, factory) {
    const { config, graph, sessions } = this._appContext;
    const engine = factory({ config, graph, sessions });
    this._contextEngines.push({ name, engine });
    this._log.debug(`[plugin:${this.pluginId}] Registered context engine: ${name}`);
  }

  /**
   * Register a tool. Definition must include:
   *   { description: string, inputSchema: object, execute: async (input, ctx) => result }
   *
   * By default the tool is exposed to the agent as `plugin_<pluginId>_<name>`
   * so plugins can't collide. Set `definition.namespaced = false` to keep the
   * bare name — used when extracting a built-in tool to preserve its public
   * name (e.g. `email_send` stays `email_send`). Bare-name collisions across
   * plugins are rejected at runtime by the manager's tool dispatcher.
   */
  registerTool(name, definition) {
    if (!definition.description || !definition.inputSchema || typeof definition.execute !== 'function') {
      throw new Error(`Tool "${name}" must have description, inputSchema, and execute function`);
    }
    const exposedName = definition.namespaced === false ? name : `plugin_${this.pluginId}_${name}`;
    this._tools.push({ name: exposedName, definition });
    this._log.debug(`[plugin:${this.pluginId}] Registered tool: ${exposedName}`);
  }

  /**
   * Register a gateway. Factory receives { config, log, agent }.
   * The returned gateway should implement connect(), disconnect(), getStatus().
   */
  registerGateway(name, factory) {
    const { config, log, agent } = this._appContext;
    const gateway = factory({ config, log, agent });
    this._gateways.push({ name, gateway });

    const { gateways } = this._appContext;
    if (gateways?.set) {
      gateways.set(`plugin:${name}`, gateway);
    }

    this._log.debug(`[plugin:${this.pluginId}] Registered gateway: ${name}`);
  }

  /**
   * Register a worker hook. Events: afterLearn, beforeLearn, afterMaintain.
   */
  registerWorkerHook(event, handler) {
    if (!this._workerHooks.has(event)) this._workerHooks.set(event, []);
    this._workerHooks.get(event).push(handler);
    this._log.debug(`[plugin:${this.pluginId}] Registered worker hook: ${event}`);
  }

  /**
   * Register middleware. Hooks: beforeInference, afterInference,
   * beforeToolExec, afterToolExec, beforeIngest, afterIngest.
   */
  registerMiddleware(hook, handler) {
    if (!this._middleware.has(hook)) this._middleware.set(hook, []);
    this._middleware.get(hook).push(handler);
    this._log.debug(`[plugin:${this.pluginId}] Registered middleware: ${hook}`);
  }

  /**
   * Register a shutdown handler for cleanup.
   */
  onShutdown(fn) {
    this._shutdownFn = fn;
  }

  /**
   * Register reference-node SQL bundles tied to this plugin's lifecycle.
   *
   * @param {object} opts
   * @param {string|{sql:string}} opts.install
   *   Path (relative to plugin dir) of an idempotent SQL file, or `{sql}` raw.
   *   Plugin SQL MUST tag every inserted row with `extracted_with = '{{plugin_id}}'`
   *   so uninstall can find them. The token is substituted by the manager.
   * @param {string|{sql:string}} [opts.uninstall]
   *   Path or raw SQL for teardown. If omitted, the manager auto-generates a
   *   cascading `DELETE WHERE extracted_with = '<pluginId>'` across nodes,
   *   aspects, attributes, and edges.
   * @param {number} [opts.schemaVersion=1]
   *   Bump to force re-install on plugin upgrade.
   */
  registerReferenceNodes({ install, uninstall = null, schemaVersion = 1 }) {
    if (!install) {
      throw new Error(`registerReferenceNodes requires an 'install' SQL source`);
    }
    this._referenceNodes = { install, uninstall, schemaVersion };
    this._log.debug(`[plugin:${this.pluginId}] Registered reference-node bundle (v${schemaVersion})`);
  }

  getReferenceNodes() {
    return this._referenceNodes;
  }

  /**
   * Register a prompt section for a given PROMPT_MODES key (e.g. 'chat', 'full'),
   * or '*' to attach to every mode. The renderFn is called every time the prompt
   * is built and should return a string (or null/empty to skip).
   *
   *   renderFn({ mode, db, config, opts }) → string | null
   *
   * The returned text is appended after built-in sections, capped by the
   * shared `plugin` budget. Sections are rebuilt per call — they don't share
   * the static-prompt cache, so dynamic content is fine.
   */
  registerPromptSection(modeName, sectionName, renderFn) {
    if (typeof renderFn !== 'function') {
      throw new Error(`registerPromptSection requires a render function`);
    }
    this._promptSections.push({ modeName, sectionName, renderFn });
    this._log.debug(`[plugin:${this.pluginId}] Registered prompt section: ${modeName}.${sectionName}`);
  }

  getPromptSections() {
    return this._promptSections;
  }

  getConfig() {
    const allPluginConfig = this._appContext.config.plugins || {};
    return allPluginConfig[this.pluginId] || {};
  }

  /**
   * Read-only access to the full host config. Useful for one-time backfills
   * of legacy top-level keys into the plugin's namespace during register.
   * Plugins MUST NOT mutate the returned object — use setConfig for writes.
   */
  getHostConfig() {
    return this._appContext?.config || {};
  }

  /**
   * Persist a partial config update into config.plugins[<pluginId>] and the
   * on-disk config. Triggers onConfigChange (own plugin only) on success.
   * Backed by the same `_persistSettingsPatch` used by the settings UI.
   */
  async setConfig(partial) {
    if (!this._manager?.persistPluginConfig) {
      throw new Error('Plugin config persistence not wired into manager');
    }
    return this._manager.persistPluginConfig(this.pluginId, partial);
  }

  /**
   * Register a callback fired when this plugin's config slot changes
   * (via the settings UI or another caller). Receives `(newConfig, oldConfig)`.
   */
  onConfigChange(fn) {
    if (typeof fn !== 'function') throw new Error('onConfigChange requires a function');
    this._configChangeFn = fn;
  }

  /** @internal — invoked by manager.dispatchConfigChange */
  _fireConfigChange(newConfig, oldConfig) {
    if (this._configChangeFn) {
      try {
        return this._configChangeFn(newConfig, oldConfig);
      } catch (e) {
        this._log.warn(`[plugin:${this.pluginId}] onConfigChange threw: ${e.message}`);
      }
    }
  }

  /**
   * Register a settings pane that the frontend renders inside the settings
   * modal. Schema-driven by default; pass `{ html, onMount }` for custom UI.
   *
   * @param {object} pane
   * @param {string} pane.title           — visible heading (e.g. "Email")
   * @param {string} [pane.tab]           — settings tab id to file under;
   *                                        defaults to a new "plugins" tab
   * @param {Array}  [pane.schema]        — [{ key, label, type, default, secret?, options?, help? }, ...]
   *                                        types: 'text' | 'password' | 'number' | 'toggle' | 'select' | 'textarea'
   * @param {string} [pane.html]          — raw HTML body (escape hatch)
   * @param {string} [pane.description]   — optional intro text rendered above fields
   */
  registerSettingsPane(pane) {
    if (!pane?.title) throw new Error('registerSettingsPane requires a title');
    if (!pane.schema && !pane.html) throw new Error('registerSettingsPane requires either schema or html');
    this._settingsPane = {
      title: pane.title,
      tab: pane.tab || 'plugins',
      description: pane.description || null,
      schema: Array.isArray(pane.schema) ? pane.schema : null,
      html: typeof pane.html === 'string' ? pane.html : null,
    };
    this._log.debug(`[plugin:${this.pluginId}] Registered settings pane: ${pane.title} (tab=${this._settingsPane.tab})`);
  }

  getSettingsPane() {
    return this._settingsPane;
  }

  /**
   * Register a dock item (bottom-dock button) contributed by this plugin.
   * The frontend fetches dock items via /api/plugins/ui and renders them
   * after the built-in dock entries.
   *
   * @param {object} item
   * @param {string} item.id      — unique id within this plugin
   * @param {string} item.label   — tooltip text
   * @param {string} item.icon    — inline SVG markup (preferred for theme matching)
   * @param {string} [item.action] — opaque token the frontend dispatches via
   *                                /api/plugins/<id>/dock (the plugin's web route
   *                                handles the click). If omitted, the frontend
   *                                fires a custom event for the plugin's own JS.
   */
  registerDockItem(item) {
    if (!item?.id || !item?.label) throw new Error('registerDockItem requires id and label');
    this._dockItems.push({
      id: item.id,
      label: String(item.label),
      icon: typeof item.icon === 'string' ? item.icon : null,
      action: item.action || null,
    });
    this._log.debug(`[plugin:${this.pluginId}] Registered dock item: ${item.id}`);
  }

  getDockItems() {
    return this._dockItems;
  }

  /**
   * Register an HTTP route exposed under `/api/plugins/<pluginId>/<route>`.
   * Handler receives (req, res, parsedUrl) — same shape as built-in handlers.
   * The pluginId namespace prevents collisions with core routes.
   *
   * @param {string} method   — 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
   * @param {string} routePath — must start with '/'; e.g. '/status'
   * @param {Function} handler — async (req, res, parsedUrl) => void
   */
  registerWebRoute(method, routePath, handler) {
    if (typeof handler !== 'function') throw new Error('registerWebRoute requires a handler function');
    if (!routePath?.startsWith('/')) throw new Error('routePath must start with "/"');
    this._webRoutes.push({
      method: String(method).toUpperCase(),
      path: routePath,
      handler,
    });
    this._log.debug(`[plugin:${this.pluginId}] Registered web route: ${method} ${routePath}`);
  }

  getWebRoutes() {
    return this._webRoutes;
  }

  /**
   * Register a WebSocket message handler. Frontend sends `{ type: 'plugin:<pluginId>:<msgType>', ... }`.
   * Handler receives (ws, msg, ctx).
   */
  registerWsHandler(msgType, handler) {
    if (typeof handler !== 'function') throw new Error('registerWsHandler requires a handler function');
    this._wsHandlers.set(msgType, handler);
    this._log.debug(`[plugin:${this.pluginId}] Registered WS handler: ${msgType}`);
  }

  getWsHandler(msgType) {
    return this._wsHandlers.get(msgType);
  }

  getWsHandlers() {
    return Array.from(this._wsHandlers.entries()).map(([type, handler]) => ({ type, handler }));
  }

  getLogger() {
    const base = this._log;
    const prefix = `[plugin:${this.pluginId}]`;
    return {
      debug: (...args) => base.debug(prefix, ...args),
      info: (...args) => base.info(prefix, ...args),
      warn: (...args) => base.warn(prefix, ...args),
      error: (...args) => base.error(prefix, ...args),
    };
  }

  getGraphContext() {
    return this._appContext.graph;
  }

  getSessions() {
    return this._appContext.sessions;
  }

  getRegisteredTools() {
    return this._tools;
  }

  getRegisteredContextEngines() {
    return this._contextEngines;
  }

  getRegisteredGateways() {
    return this._gateways;
  }

  getWorkerHooks(event) {
    return this._workerHooks.get(event) || [];
  }

  getMiddleware(hook) {
    return this._middleware.get(hook) || [];
  }

  async shutdown() {
    if (this._shutdownFn) await this._shutdownFn();
  }
}

module.exports = { PluginAPI };
