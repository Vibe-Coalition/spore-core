/**
 * plugins/api.js — Plugin API
 *
 * The object passed to plugin.register(api). Provides methods for
 * registering context engines, tools, gateways, worker hooks, and middleware.
 */

class PluginAPI {
  constructor(pluginId, manifest, appContext, log) {
    this.pluginId = pluginId;
    this.manifest = manifest;
    this._appContext = appContext;
    this._log = log;

    this._contextEngines = [];
    this._tools = [];
    this._gateways = [];
    this._workerHooks = new Map();
    this._middleware = new Map();
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
   */
  registerTool(name, definition) {
    if (!definition.description || !definition.inputSchema || typeof definition.execute !== 'function') {
      throw new Error(`Tool "${name}" must have description, inputSchema, and execute function`);
    }
    this._tools.push({ name: `plugin_${this.pluginId}_${name}`, definition });
    this._log.debug(`[plugin:${this.pluginId}] Registered tool: ${name}`);
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

  getConfig() {
    const allPluginConfig = this._appContext.config.plugins || {};
    return allPluginConfig[this.pluginId] || {};
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
