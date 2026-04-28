/**
 * providers/index.js — Provider walker + per-model client cache.
 *
 * Post-extraction core: zero vendor-specific code. Every provider lives
 * in its own plugin under plugins/<vendor>-provider/, registered via
 * `api.registerProvider(name, factory, opts)`. This file is purely
 * dispatch:
 *
 *   - createClientForModel(model, config) walks the plugin manager and
 *     calls the factory of whichever provider claims the model's prefix.
 *   - MultiProvider caches one client per model string and adapts each
 *     request based on per-model capabilities (declared by each plugin
 *     via listModels; persisted into config.modelLimits[].capabilities;
 *     read here via _inferCapabilities).
 *   - applyReasoningEffortViaPlugin / getDefaultReasoningEffort delegate
 *     to the owning plugin so vendor-specific request-shape translation
 *     (Anthropic adaptive vs budget thinking, OpenAI reasoning_effort,
 *     Gemini thinkingBudget, etc.) lives next to the client that talks
 *     that vendor's wire protocol.
 *
 * Every backend exposes the same public interface:
 *
 *   client.messages.create({ model, max_tokens, system, messages, tools? })
 *     → { content: [...], usage: {input_tokens, output_tokens}, stop_reason }
 */

'use strict';

// ---------------------------------------------------------------------------
// Plugin walker — set by app.js after pluginManager.initAll().
// ---------------------------------------------------------------------------

let _providerManager = null;

function setProviderManager(manager) {
  _providerManager = manager;
}

// Resolve a slash-prefixed model string to a plugin entry, or null.
function _resolvePluginProvider(model) {
  if (!_providerManager?.resolveProviderForModel) return null;
  try {
    return _providerManager.resolveProviderForModel(model);
  } catch (e) {
    console.error('[providers] resolveProviderForModel threw:', e.message);
    return null;
  }
}

// Resolve via detectBackend's answer, including bare names like
// 'claude-opus-4-7' that resolveProviderForModel doesn't handle (it
// only walks slash-prefixed forms).
function _resolvePluginByBackend(model) {
  if (!_providerManager?.getProviders) return null;
  try {
    const backendName = detectBackend(model);
    return _providerManager.getProviders().find(p => p.name === backendName) || null;
  } catch (e) {
    console.error('[providers] _resolvePluginByBackend threw:', e.message);
    return null;
  }
}

// Apply categorical reasoning effort via the model's owning plugin.
// Returns the modified request when a plugin handles it; returns null
// when no plugin claims the model so the caller can fall through.
function applyReasoningEffortViaPlugin(req, model, effort) {
  const entry = _resolvePluginByBackend(model);
  if (!entry?.applyReasoningEffort) return null;
  try {
    return entry.applyReasoningEffort(req, model, effort);
  } catch (e) {
    console.error(`[providers] applyReasoningEffort(${entry.name}) threw:`, e.message);
    return null;
  }
}

// Resolve operator's host-config-driven default reasoning effort via
// the owning plugin. Each plugin knows which host-config field is
// its knob (anthropic→thinkingBudget, openai→openaiReasoningEffort).
function getDefaultReasoningEffort(model, hostConfig) {
  const entry = _resolvePluginByBackend(model);
  if (!entry?.getDefaultReasoningEffort) return null;
  try {
    return entry.getDefaultReasoningEffort(model, hostConfig) || null;
  } catch (e) {
    console.error(`[providers] getDefaultReasoningEffort(${entry.name}) threw:`, e.message);
    return null;
  }
}

// Wrap the system prompt for a model via the owning plugin's hook.
// Used by every system-prompt builder (agent loop, tools, workers) so
// vendor-specific prefix requirements (e.g. Anthropic's Claude Code
// identity line for OAuth tokens) live next to the plugin instead of
// scattered as inline `if (config._isOAuth) [{...}, ...]` patterns.
function wrapSystemPromptForModel(system, model, hostConfig) {
  const entry = _resolvePluginByBackend(model);
  if (!entry?.wrapSystemPrompt) return system;
  try {
    return entry.wrapSystemPrompt(system, model, hostConfig);
  } catch (e) {
    console.error(`[providers] wrapSystemPrompt(${entry.name}) threw:`, e.message);
    return system;
  }
}

// ---------------------------------------------------------------------------
// Model-string utilities
// ---------------------------------------------------------------------------

let _customProviderNames = new Set();

/** Strip provider prefix from model string: "openrouter/x/y" → "x/y", "together/llama" → "llama".
 *  Walks plugin-registered prefixes plus the legacy customProviders set. */
function stripPrefix(model) {
  const slash = model.indexOf('/');
  if (slash === -1) return model;
  const prefix = model.substring(0, slash);
  if (_customProviderNames.has(prefix)) return model.substring(slash + 1);
  if (_providerManager?.getProviders) {
    for (const entry of _providerManager.getProviders()) {
      if (entry.prefixes.includes(prefix)) return model.substring(slash + 1);
    }
  }
  return model;
}

/** Detect which backend a model string targets. Plugin-registered
 *  providers win first via slash-prefix match (resolveProviderForModel)
 *  or longest-prefix bare-name match (the fallback walker below). */
function detectBackend(model) {
  if (!model) return 'none';
  const pluginEntry = _resolvePluginProvider(model);
  if (pluginEntry) return pluginEntry.name;
  // Bare names — walk plugins and match the longest prefix.
  // anthropic-provider declares prefixes:['claude'], so 'claude-opus-4-7'
  // and 'claude-haiku-4-5' route here.
  if (_providerManager?.getProviders) {
    let best = null;
    for (const entry of _providerManager.getProviders()) {
      for (const p of entry.prefixes) {
        if (model.startsWith(p) && (!best || p.length > best.matchLen)) {
          best = { entry, matchLen: p.length };
        }
      }
    }
    if (best) return best.entry.name;
  }
  // Last-resort fallback for the pre-plugins boot window — treat
  // unprefixed strings as Anthropic (the historical default).
  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Content-type detectors (used by MultiProvider._adaptRequest's
// vision/audio/video fallback logic).
// ---------------------------------------------------------------------------

function _hasImages(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image') return true;
    }
  }
  return false;
}

function _hasAudio(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'audio' || block.type === 'input_audio') return true;
    }
  }
  return false;
}

function _hasVideo(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'video') return true;
    }
  }
  return false;
}

function _hasTools(params) {
  return params.tools && params.tools.length > 0;
}

// ---------------------------------------------------------------------------
// Capability inference & cache
// ---------------------------------------------------------------------------

// Last-resort regex patterns for unclaimed backends. Plugin-registered
// providers should populate config.modelLimits[].capabilities (most
// authoritative) or declare provider-blanket capabilities (mid). These
// only fire when neither path applies.
const _VISION_PATTERNS = /\bvl\b|vision|pixtral|4o|4v/i;
const _AUDIO_PATTERNS  = /audio|realtime|4o-audio/i;
const _VIDEO_PATTERNS  = /\bvl\b|video/i;

/**
 * Resolve capabilities for a model. Three-tier preference:
 *   1. Per-model override from config.modelLimits[model].capabilities —
 *      populated by each plugin's listModels at wizard finish and on
 *      every settings save. Reflects model ∧ client transport.
 *   2. Plugin-declared blanket via registerProvider({ capabilities }).
 *   3. Last-resort regex heuristic.
 */
function _inferCapabilities(model, config) {
  if (!model) return { tools: null, vision: null, audio: null, video: null };

  const override = config?.modelLimits?.[model]?.capabilities;
  if (override && typeof override === 'object') {
    return {
      tools:  typeof override.tools  === 'boolean' ? override.tools  : true,
      vision: typeof override.vision === 'boolean' ? override.vision : false,
      audio:  typeof override.audio  === 'boolean' ? override.audio  : false,
      video:  typeof override.video  === 'boolean' ? override.video  : false,
    };
  }

  const pluginEntry = _resolvePluginByBackend(model);
  if (pluginEntry?.capabilities) {
    return { ...pluginEntry.capabilities };
  }

  const name = stripPrefix(model).toLowerCase();
  return {
    tools:  null,
    vision: _VISION_PATTERNS.test(name) ? true : false,
    audio:  _AUDIO_PATTERNS.test(name)  ? true : false,
    video:  _VIDEO_PATTERNS.test(name)  ? true : false,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate LLM client for a given model string. Pure
 * dispatch — every backend lives in a plugin. Throws with a clear
 * error if no plugin claims the model.
 *
 * @param {string} model   — model identifier (may include prefix)
 * @param {object} config  — full spore config
 * @returns {{ messages: { create: Function, stream?: Function } }}
 */
function createClientForModel(model, config) {
  // Custom-provider name set is still tracked for stripPrefix's
  // legacy customProviders handling. The local-oai-provider plugin
  // reads config.customProviders at register time and claims those
  // prefixes itself; this just keeps our prefix-strip aware of them.
  if (config?.customProviders) {
    _customProviderNames = new Set(Object.keys(config.customProviders));
  }

  // Slash-prefixed forms hit resolveProviderForModel first.
  const pluginEntry = _resolvePluginProvider(model);
  if (pluginEntry) return pluginEntry.factory(config);

  // Bare names like 'claude-opus-4-7' — resolveProviderForModel doesn't
  // handle them (it requires a slash). Walk plugins via detectBackend's
  // longest-prefix-match so anthropic-provider's prefixes:['claude']
  // catches all bare claude-* names.
  if (_providerManager?.getProviders) {
    const backendName = detectBackend(model);
    const entry = _providerManager.getProviders().find(p => p.name === backendName);
    if (entry) return entry.factory(config);
  }

  throw new Error(
    `No provider plugin handles model '${model}'. Install a provider plugin (anthropic-provider, openai-provider, openrouter-provider, local-oai-provider, gemini-provider) and restart, or change the model string to one a registered plugin claims.`
  );
}

// ---------------------------------------------------------------------------
// MultiProvider — per-model client cache + capability adaptation
// ---------------------------------------------------------------------------

/**
 * Routes each call to the right backend based on the model field in the
 * request params. Caches one client per model string. Adapts requests
 * to model capabilities (strip tools if unsupported, swap to vision/
 * audio/video fallback model if the request needs a modality the
 * current model doesn't transport).
 */
class MultiProvider {
  constructor(config) {
    this.config = config;
    this._cache = new Map();
    /** @type {Map<string, {tools:boolean|null, vision:boolean, audio:boolean, video:boolean}>} */
    this._capabilities = new Map();
    if (config?.customProviders) {
      _customProviderNames = new Set(Object.keys(config.customProviders));
    }
  }

  clearCache() {
    this._cache.clear();
    this._capabilities.clear();
    _customProviderNames = new Set(Object.keys(this.config?.customProviders || {}));
  }

  _clientFor(model) {
    if (!this._cache.has(model)) {
      const client = createClientForModel(model, this.config);
      // Duck-typed capability callback — any client that exposes
      // `onCapability` (the OAI-compat client does) gets wired so
      // server-side capability discoveries (e.g. "this model rejects
      // tools") flow back into _capabilities cache. Anthropic SDK and
      // Gemini clients don't have the property and silently no-op.
      if (client && 'onCapability' in client) {
        client.onCapability = (m, cap, val) => this._setCap(m, cap, val);
      }
      this._cache.set(model, client);
    }
    return this._cache.get(model);
  }

  _getCaps(model) {
    if (!this._capabilities.has(model)) {
      this._capabilities.set(model, _inferCapabilities(model, this.config));
    }
    return this._capabilities.get(model);
  }

  _setCap(model, cap, val) {
    const caps = this._getCaps(model);
    caps[cap] = val;
  }

  resolveRequest(params) {
    return this._adaptRequest(params);
  }

  resolveModel(params) {
    return this.resolveRequest(params).model;
  }

  /**
   * Adapt a request based on model capabilities:
   *  - Strip tools if the model rejects them.
   *  - Swap to a fallback model for vision/audio/video if the current
   *    model can't transport that modality (skipped when dedicated VLM
   *    tiers are configured — those tiers handle modality-specific
   *    subcalls explicitly via tools).
   */
  _adaptRequest(params) {
    let adapted = params;
    const hasDedicatedVlmTiers = Boolean(
      this.config?.imageVlmModel
      || this.config?.videoVlmModel
      || this.config?.audioVlmModel
    );
    let caps = this._getCaps(adapted.model);

    if (_hasTools(adapted) && caps.tools === false) {
      const { tools, tool_choice, ...rest } = adapted;
      adapted = rest;
    }

    if (!hasDedicatedVlmTiers && _hasImages(adapted) && caps.vision === false) {
      const fb = this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
      caps = this._getCaps(adapted.model);
    }

    if (!hasDedicatedVlmTiers && _hasAudio(adapted) && caps.audio === false) {
      const fb = this.config.audioFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
      caps = this._getCaps(adapted.model);
    }

    if (!hasDedicatedVlmTiers && _hasVideo(adapted) && caps.video === false) {
      const fb = this.config.videoFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
    }

    return adapted;
  }

  get messages() {
    return {
      create: (params, opts) => {
        const effective = this.resolveRequest(params);
        const client = this._clientFor(effective.model);
        return client.messages.create(effective, opts);
      },
      stream: (params, opts) => {
        const effective = this.resolveRequest(params);
        const client = this._clientFor(effective.model);
        if (typeof client.messages.stream === 'function') {
          return client.messages.stream(effective, opts);
        }
        const result = client.messages.create(effective, opts);
        return { finalMessage: () => result, on: () => {} };
      },
    };
  }

  /**
   * Pull LLM provider configs from the Manager and merge into config.customProviders.
   * Env vars take precedence — manager-provided configs only fill gaps.
   */
  static async populateProvidersFromManager(config, log) {
    const managerUrl = config.managerUrl;
    const serviceKey = config.managerServiceKey;
    if (!managerUrl || !serviceKey) return;

    const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http_.get(`${managerUrl}/api/providers/config`, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': config.agentId || 'unknown' },
          timeout: 5000,
        }, (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) { resolve(null); return; }
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });

      if (data?.providers) {
        if (!config.customProviders) config.customProviders = {};
        let count = 0;
        for (const [name, prov] of Object.entries(data.providers)) {
          if (config.customProviders[name]) continue;
          config.customProviders[name] = {
            name,
            url: prov.url,
            key: prov.key || '',
            authHeader: prov.authHeader || 'bearer',
          };
          count++;
        }
        if (count > 0 && log) log.info(`[providers] Loaded ${count} provider(s) from manager`);
      }
    } catch (e) { console.warn('[providers] populateProvidersFromManager failed: ' + e.message); }
  }

  /**
   * Pre-populate config with API keys from the manager vault for any missing inference keys.
   * Call before constructing the MultiProvider. Non-blocking — silently skips on failure.
   */
  static async populateFromVault(config, log) {
    const managerUrl = config.managerUrl;
    const serviceKey = config.managerServiceKey;
    if (!managerUrl || !serviceKey) return;

    const keyMap = {
      ANTHROPIC_API_KEY: 'anthropicApiKey',
      OPENROUTER_API_KEY: 'openrouterApiKey',
      OPENAI_API_KEY: 'openaiApiKey',
      GEMINI_API_KEY: 'geminiApiKey',
      LOCAL_MODEL_API_KEY: 'localModelApiKey',
      DEEPGRAM_API_KEY: 'deepgramApiKey',
      XI_API_KEY: 'xiApiKey',
      REPLICATE_API_TOKEN: 'replicateApiToken',
      BRAVE_API_KEY: 'braveApiKey',
    };

    const missing = Object.entries(keyMap).filter(([envName, configKey]) => !config[configKey] && !process.env[envName]);
    if (missing.length === 0) return;

    const http_ = managerUrl.startsWith('https') ? require('https') : require('http');

    for (const [envName, configKey] of missing) {
      try {
        const val = await new Promise((resolve, reject) => {
          const req = http_.get(`${managerUrl}/api/vault/key?name=${encodeURIComponent(envName)}`, {
            headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': config.agentId || 'unknown' },
            timeout: 5000,
          }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              if (res.statusCode !== 200) { resolve(null); return; }
              try {
                const parsed = JSON.parse(data);
                resolve(parsed.value || null);
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });

        if (val) {
          config[configKey] = val;
          process.env[envName] = val;
          if (log) log.info(`[vault] Loaded ${envName} from vault`);
        }
      } catch (e) { console.warn('[providers] vault fetch failed: ' + e.message); }
    }
  }
}

module.exports = {
  MultiProvider,
  createClientForModel,
  detectBackend,
  stripPrefix,
  setProviderManager,
  applyReasoningEffortViaPlugin,
  getDefaultReasoningEffort,
  wrapSystemPromptForModel,
  _hasImages,
  _inferCapabilities,
};
