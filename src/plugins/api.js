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
    this._lifecycleHooks = new Map();
    this._promptSections = [];
    this._referenceNodes = null;
    this._settingsPane = null;
    this._dockItems = [];
    this._webRoutes = [];
    this._wsHandlers = new Map();
    this._pathAliases = [];
    this._sttProviders = [];
    this._ttsProviders = [];
    this._embedders = [];
    this._llmProviders = [];
    this._frontendAssets = [];
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
   * Register an agent-loop lifecycle hook. Distinct from middleware (which
   * fires around tool exec / inference) and worker hooks (which fire from
   * learner/maintainer): lifecycle hooks fire from the agent loop on a
   * per-turn basis. Currently supported events:
   *
   *   • 'afterTurn'  — fires at the end of a completed turn. Receives
   *                    `{ opts, finalText, toolLog, learner, log }`. Used for
   *                    failure-capture and round-checkpointing without core
   *                    needing to know which plugin owns the behavior.
   *   • 'beforeRound' — fires at the top of _runLoop before the first
   *                     inference. Receives `{ opts, learner, log }`.
   *
   * Handlers are sync-or-async; errors are caught at the loop boundary.
   */
  registerLifecycleHook(event, handler) {
    if (typeof handler !== 'function') throw new Error('registerLifecycleHook requires a function');
    if (!this._lifecycleHooks.has(event)) this._lifecycleHooks.set(event, []);
    this._lifecycleHooks.get(event).push(handler);
    this._log.debug(`[plugin:${this.pluginId}] Registered lifecycle hook: ${event}`);
  }

  getLifecycleHooks(event) {
    return this._lifecycleHooks.get(event) || [];
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
   * Routes are auth-gated by default (any signed-in user). Pass
   * `{ public: true }` for routes that ARE the auth boundary (e.g. an
   * acorn-cli `/auth` endpoint that issues Bearer tokens). Public routes
   * MUST do their own validation before handing out credentials.
   *
   * @param {string} method   — 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
   * @param {string} routePath — must start with '/'; e.g. '/status'
   * @param {Function|object} handlerOrOpts — async (req, res, parsedUrl) => void,
   *                            or `{ handler, public }` for opt-out auth.
   * @param {Function} [handler] — when handlerOrOpts is an object, the handler.
   */
  registerWebRoute(method, routePath, handlerOrOpts, handler) {
    let opts = {};
    let fn = handlerOrOpts;
    if (typeof handlerOrOpts === 'object' && handlerOrOpts !== null) {
      opts = handlerOrOpts;
      fn = handler || handlerOrOpts.handler;
    }
    if (typeof fn !== 'function') throw new Error('registerWebRoute requires a handler function');
    if (!routePath?.startsWith('/')) throw new Error('routePath must start with "/"');
    this._webRoutes.push({
      method: String(method).toUpperCase(),
      path: routePath,
      handler: fn,
      public: !!opts.public,
    });
    this._log.debug(`[plugin:${this.pluginId}] Registered web route: ${method} ${routePath}${opts.public ? ' [public]' : ''}`);
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
    return this._wsHandlers;
  }

  /**
   * Register a public-URL alias for the plugin's `/api/plugins/<pluginId>/`
   * namespace. After this, requests to `/api/<prefix>/<rest>` are
   * rewritten to `/api/plugins/<pluginId>/<rest>` and dispatched to the
   * plugin's web routes.
   *
   * Use this for plugins that have a legacy or external wire-protocol
   * URL contract — e.g. acorn-cli's Go binaries hardcode `/api/acorn/auth`,
   * so the plugin registers `acorn` as an alias prefix and core does
   * the rewrite on its behalf. When the plugin is uninstalled, the
   * alias disappears and `/api/<prefix>/*` simply 404s like any other
   * unknown path.
   *
   * Options:
   *   cors      — `true` to send permissive CORS headers (Access-Control-
   *               Allow-Origin: *, Allow-Methods: GET, POST, OPTIONS,
   *               Allow-Headers: Content-Type, Authorization). Use for
   *               cross-origin clients (web apps + native binaries).
   *               Default: false.
   *   notFoundCode — string code to return when the alias matches but
   *               no specific route under it does (e.g. 'ACORN_NOT_FOUND').
   *               Default: undefined (returns generic 404).
   *
   * @param {string} prefix — URL segment after /api/, no leading slash.
   * @param {object} [opts]
   */
  registerPathAlias(prefix, opts = {}) {
    if (!prefix || typeof prefix !== 'string') throw new Error('registerPathAlias requires a string prefix');
    if (prefix.includes('/')) throw new Error('Path alias prefix must be a single URL segment (no slashes)');
    this._pathAliases.push({
      prefix,
      cors: !!opts.cors,
      notFoundCode: opts.notFoundCode || null,
    });
    this._log.debug(`[plugin:${this.pluginId}] Registered path alias: /api/${prefix}/* → /api/plugins/${this.pluginId}/*${opts.cors ? ' [cors]' : ''}`);
  }

  getPathAliases() {
    return this._pathAliases;
  }

  /**
   * Register a Speech-to-Text provider. Used by core's voice pipeline
   * to discover available STT backends without core knowing which
   * cloud APIs (Deepgram, OpenAI Whisper, etc.) are wired up.
   *
   *   factory(config) → { transcribe(audioBuffer, mimeType): Promise<{text, confidence}> }
   *
   * `name` is the value `config.voice.sttProvider` matches against
   * (e.g. 'deepgram', 'openai'). `opts.isConfigured(config) → bool`
   * lets the plugin signal whether its credentials are populated;
   * default = always-true. Manager aggregates all plugins' providers
   * into a flat list that core walks at VoicePipeline init time.
   *
   * @param {string} name
   * @param {Function} factory
   * @param {object} [opts]
   * @param {Function} [opts.isConfigured]
   */
  registerSTTProvider(name, factory, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('registerSTTProvider requires a string name');
    if (typeof factory !== 'function') throw new Error('registerSTTProvider requires a factory function');
    const isConfigured = typeof opts.isConfigured === 'function' ? opts.isConfigured : () => true;
    this._sttProviders.push({ name, factory, isConfigured });
    this._log.debug(`[plugin:${this.pluginId}] Registered STT provider: ${name}`);
  }

  getSTTProviders() {
    return this._sttProviders;
  }

  /**
   * Register a Text-to-Speech provider. Mirror of registerSTTProvider.
   * Used by core's voice pipeline to discover available TTS backends.
   *
   *   factory(config) → { synthesize(text, opts): Promise<Buffer>, synthesizeOgg(text): Promise<Buffer> }
   *
   * `name` is the value `config.voice.ttsProvider` matches against
   * (e.g. 'elevenlabs', 'openai', 'edge'). `opts.isConfigured(config)`
   * lets the plugin signal whether its credentials are populated.
   */
  registerTTSProvider(name, factory, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('registerTTSProvider requires a string name');
    if (typeof factory !== 'function') throw new Error('registerTTSProvider requires a factory function');
    const isConfigured = typeof opts.isConfigured === 'function' ? opts.isConfigured : () => true;
    this._ttsProviders.push({ name, factory, isConfigured });
    this._log.debug(`[plugin:${this.pluginId}] Registered TTS provider: ${name}`);
  }

  getTTSProviders() {
    return this._ttsProviders;
  }

  /**
   * Register a text-embedding provider. Used by core's graph indexing
   * (tools.graph_update, learner extraction, maintainer sweeper) and
   * by retrieval.vectorSearch / hybridSearch at query time. With no
   * embedder plugin installed, vector search returns [] and hybrid
   * degrades to keyword search — same behavior as the legacy
   * `GEMINI_API_KEY not set` fallback.
   *
   *   factory(config) → { embed(text): Promise<float[]> }
   *
   * `opts.dim` is the embedding dimension (must match what factory
   * produces); core stores it alongside each vector so switching
   * providers with different dims is safe — vectorSearch filters by
   * the active provider's name+dim, and the maintainer sweeper
   * re-embeds rows whose stored provider/dim no longer matches.
   * `opts.isConfigured(config) → bool` lets the plugin signal
   * credential presence; default = always-true.
   *
   * @param {string} name
   * @param {Function} factory
   * @param {object} opts
   * @param {number} opts.dim       — REQUIRED: embedding dimension
   * @param {Function} [opts.isConfigured]
   */
  registerEmbedder(name, factory, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('registerEmbedder requires a string name');
    if (typeof factory !== 'function') throw new Error('registerEmbedder requires a factory function');
    if (typeof opts.dim !== 'number' || opts.dim <= 0) throw new Error('registerEmbedder requires opts.dim (positive integer)');
    const isConfigured = typeof opts.isConfigured === 'function' ? opts.isConfigured : () => true;
    this._embedders.push({ name, factory, isConfigured, dim: opts.dim });
    this._log.debug(`[plugin:${this.pluginId}] Registered embedder: ${name} (dim=${opts.dim})`);
  }

  getEmbedders() {
    return this._embedders;
  }

  /**
   * Register an LLM chat-completion provider. Used by core's
   * `createClientForModel` walker — when the operator sends a model
   * string like `'openai/gpt-4o-mini'`, the manager finds the provider
   * plugin whose `prefixes` claim that prefix and instantiates its
   * client. With no provider plugins installed, the legacy in-tree
   * branches in `src/providers/index.js` keep working (transitional
   * fallback that goes away in Phase E of the extraction).
   *
   *   factory(config) → { messages: { create({model, max_tokens, system?, messages, tools?}) → AnthropicShape, stream?(...): AsyncIterator } }
   *
   * `prefixes` is the list of model-string prefixes this plugin claims
   * (e.g. `['openai']` for any model starting `'openai/...'`). Plugins
   * MUST NOT claim a prefix that core already routes to a different
   * backend; the manager rejects collisions at registration time.
   *
   * `capabilities` is declared statically here so the agent loop's
   * sync `getCapabilities(backend)` lookup keeps working without an
   * extra round-trip into the plugin.
   *
   * `isConfigured(config)` lets the plugin signal whether its
   * credentials are populated (default = true). The wizard's
   * Provider step reads this to decide whether to mark the plugin's
   * card as ready.
   *
   * @param {string} name
   * @param {Function} factory
   * @param {object} opts
   * @param {string[]} opts.prefixes  — REQUIRED: model-string prefixes
   * @param {object} [opts.capabilities] — { tools, vision, audio, video }; defaults all false except tools
   * @param {Function} [opts.isConfigured]
   * @param {string} [opts.defaultBaseUrl]
   * @param {Function} [opts.listModels] — async ({apiKey, baseUrl, authHeader, ...}) =>
   *   { ok, models: [{ id, contextLength?, maxOutput?, family? }], error? }.
   *   Lets the wizard's "populate models" button hit a vendor-aware probe
   *   that returns ctx + max-output where the vendor doesn't expose it
   *   (e.g. Anthropic /v1/models has no context_window field; the plugin
   *   augments via an internal prefix table). Without this, the wizard
   *   falls back to core's _listModelsForProvider which only knows the
   *   raw OAI-compat fields.
   *
   * @param {Function} [opts.applyReasoningEffort] — (req, model, effort) => req.
   *   Translates a categorical reasoning effort
   *   (off/minimal/low/medium/high/max) into the vendor-specific
   *   request-shape knob: Anthropic's `thinking.type='adaptive'` +
   *   `output_config.effort` (opus 4.6/4.7) vs `thinking.type='enabled'`
   *   + `budget_tokens` (everything else with thinking); OpenAI's
   *   `reasoning_effort` field; Gemini's
   *   `generationConfig.thinkingConfig.thinkingBudget`; etc. Without
   *   this, core falls back to its in-tree vendor switch — keeping the
   *   per-vendor logic next to the client that has to talk that vendor's
   *   wire shape.
   */
  registerProvider(name, factory, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('registerProvider requires a string name');
    if (typeof factory !== 'function') throw new Error('registerProvider requires a factory function');
    if (!Array.isArray(opts.prefixes) || opts.prefixes.length === 0) {
      throw new Error('registerProvider requires opts.prefixes (non-empty string array)');
    }
    const prefixes = opts.prefixes.map(p => String(p));
    const capabilities = Object.assign(
      { tools: true, vision: false, audio: false, video: false },
      opts.capabilities || {}
    );
    const isConfigured = typeof opts.isConfigured === 'function' ? opts.isConfigured : () => true;
    const listModels = typeof opts.listModels === 'function' ? opts.listModels : null;
    const applyReasoningEffort = typeof opts.applyReasoningEffort === 'function' ? opts.applyReasoningEffort : null;
    // (model, hostConfig) → 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | null
    // Lets a plugin declare its host-config-driven default effort for a
    // given model so the agent loop doesn't need to hardcode the
    // vendor-specific config-field name (anthropic uses thinkingBudget,
    // openai uses openaiReasoningEffort, etc.).
    const getDefaultReasoningEffort = typeof opts.getDefaultReasoningEffort === 'function' ? opts.getDefaultReasoningEffort : null;
    // (body) → { ok, latency_ms?, model?, excerpt?, error? }.
    // Smoke-test the provider — run a tiny chat call (or /models GET for
    // local backends) so the wizard's "test" button gets a real
    // round-trip. The `body` is whatever the wizard posts —
    // typically { apiKey, baseUrl, authHeader }.
    const probe = typeof opts.probe === 'function' ? opts.probe : null;
    // (system, model, hostConfig) → system. Lets a plugin wrap the
    // system prompt for its model — Anthropic prepends the Claude Code
    // identity line when an OAuth token is active, others pass through.
    // Called once per request build by the agent loop / tool runners /
    // workers (replaces the inline `if (config._isOAuth) [{...}, ...]`
    // pattern that used to live in those callsites).
    const wrapSystemPrompt = typeof opts.wrapSystemPrompt === 'function' ? opts.wrapSystemPrompt : null;
    this._llmProviders.push({
      name,
      factory,
      prefixes,
      capabilities,
      isConfigured,
      listModels,
      applyReasoningEffort,
      getDefaultReasoningEffort,
      probe,
      wrapSystemPrompt,
      defaultBaseUrl: opts.defaultBaseUrl || null,
    });
    this._log.debug(`[plugin:${this.pluginId}] Registered LLM provider: ${name} (prefixes: ${prefixes.join(', ')})`);
  }

  getProviders() {
    return this._llmProviders;
  }

  /**
   * Declare a JS file under `plugins/<pluginId>/static/<filename>` that
   * `graph-viewer.html` should load when this plugin is installed.
   *
   * On boot, the frontend fetches `/api/plugins/frontend-assets`,
   * receives a list of `{ pluginId, filename, url }`, and inserts a
   * `<script src=url>` for each. When the plugin uninstalls, the entry
   * disappears from the list and the script no longer loads on
   * subsequent page loads. The plugin manager auto-serves files under
   * `static/` for any plugin that calls this — no separate
   * `registerWebRoute` needed.
   *
   * @param {string} filename — must be a single segment, no slashes.
   */
  registerFrontendAsset(filename) {
    if (!filename || typeof filename !== 'string') throw new Error('registerFrontendAsset requires a string filename');
    if (filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
      throw new Error('Frontend asset filename must be a single segment (no slashes, no leading dot)');
    }
    this._frontendAssets.push(filename);
    this._log.debug(`[plugin:${this.pluginId}] Registered frontend asset: ${filename}`);
  }

  getFrontendAssets() {
    return this._frontendAssets;
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
