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
   */
  async initAll(appContext) {
    this._appContext = appContext;

    for (const [id, plugin] of this.plugins) {
      try {
        const api = new PluginAPI(id, plugin.manifest, appContext, this.log);
        await plugin.registerFn(api);
        plugin.instance = api;
        this.log.info(`[plugins] Initialized ${id}`);
      } catch (e) {
        this.log.error(`[plugins] Failed to init ${id}: ${e.message}`);
      }
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
