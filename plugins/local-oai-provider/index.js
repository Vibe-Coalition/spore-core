// local-oai-provider plugin — canonical OAI-compatible LLM provider.
//
// Owns the "custom OAI-compatible endpoint" provider. Each configured
// endpoint in config.customProviders claims its own prefix, so
// groq/llama, local/qwen, bfl/model, etc. all route through this plugin
// without duplicating vendor code in core.
//
// Reference contract for sibling provider plugins (openai-provider,
// openrouter-provider): they import `OAICompatClient` from
// `../../local-oai-provider/lib/oai-compat-client` and instantiate it
// with their own baseURL + apiKey shape.

const { OAICompatClient, listOaiCompatModels } = require('./lib/oai-compat-client');

// Reasoning-effort translator for OAI-compatible backends. Each
// upstream model family has its own knob; we dispatch by model-id
// pattern. Lives here because the local-oai plugin is the catch-all
// for OAI-compat custom prefixes (xai/grok, qwen/, glm/, deepseek/,
// vendor-specific tunnels) and operators routing through it expect
// the right vendor flag to land on the wire.
function applyOaiCompatReasoningEffort(req, model, effort) {
  const m = String(model || '').toLowerCase();
  const out = { ...req };

  // xAI Grok: grok-4 reasons unconditionally and rejects the knob;
  // grok-3-mini accepts low/high.
  if (/grok-4/.test(m)) return out;
  if (/^xai\//.test(m) || /grok/.test(m)) {
    if (effort === 'off') { delete out.reasoning_effort; return out; }
    out.reasoning_effort = (effort === 'high' || effort === 'max') ? 'high' : 'low';
    return out;
  }

  // Qwen 3 — chat_template_kwargs.enable_thinking
  if (/qwen-?3|qwen3/.test(m)) {
    out.chat_template_kwargs = { ...(out.chat_template_kwargs || {}), enable_thinking: effort !== 'off' };
    return out;
  }

  // Zhipu GLM 4.5 / 4.6 — thinking.type
  if (/^glm[-/]|glm-?4\.[56]/.test(m)) {
    out.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' };
    return out;
  }

  // DeepSeek vLLM-style
  if (/deepseek/.test(m)) {
    out.chat_template_kwargs = { ...(out.chat_template_kwargs || {}), thinking: effort !== 'off' };
    return out;
  }

  // Generic OAI-compat — try reasoning_effort passthrough.
  if (effort && effort !== 'off') {
    const v = effort === 'minimal' ? 'low' : (effort === 'max' ? 'high' : effort);
    out.reasoning_effort = v;
  } else if (effort === 'off') {
    delete out.reasoning_effort;
  }
  return out;
}

function _legacyLocalConfig(config) {
  const slot = config?.plugins?.['local-oai-provider'] || {};
  const url = process.env.LOCAL_MODEL_BASE_URL
    || config.localModelBaseUrl
    || slot.baseUrl
    || '';
  if (!url) return null;
  return {
    url,
    key: process.env.LOCAL_MODEL_API_KEY
    || config.localModelApiKey
    || slot.apiKey
    || '',
    authHeader: process.env.LOCAL_MODEL_AUTH_HEADER
    || config.localModelAuthHeader
    || slot.authHeader
    || 'bearer',
  };
}

function _oaiCompatProviders(config) {
  const out = { ...(config.customProviders || {}) };
  if (!out.local) {
    const legacy = _legacyLocalConfig(config);
    if (legacy?.url) out.local = legacy;
  }
  return out;
}

function _resolveEndpointConfig(config, prefix) {
  const prov = _oaiCompatProviders(config)?.[prefix];
  if (!prov?.url) throw new Error(`Custom OAI-compatible endpoint '${prefix}' has no URL. Configure it in Providers -> OAI-compatible endpoints.`);
  return new OAICompatClient({
    baseURL: prov.url,
    apiKey: prov.key || '',
    authHeader: prov.authHeader || 'bearer',
    timeoutMs: config.apiTimeoutMs || 120000,
  });
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  api.registerProvider('custom', (config) => {
    // Return a thin proxy that routes each call by the model prefix
    // (`prefix/model-id`). Each prefix maps to one configured
    // OpenAI-compatible endpoint in config.customProviders.
    const cache = new Map();
    const proxyClient = {
      messages: {
        create: (params, opts) => {
          const slash = (params.model || '').indexOf('/');
          const prefix = slash > 0 ? params.model.substring(0, slash) : '';
          if (!cache.has(prefix)) cache.set(prefix, _resolveEndpointConfig(config, prefix));
          return cache.get(prefix).messages.create(params, opts);
        },
        stream: (params, opts) => {
          const slash = (params.model || '').indexOf('/');
          const prefix = slash > 0 ? params.model.substring(0, slash) : '';
          if (!cache.has(prefix)) cache.set(prefix, _resolveEndpointConfig(config, prefix));
          return cache.get(prefix).messages.stream(params, opts);
        },
      },
    };
    return proxyClient;
  }, {
    // The plugin manager expands this placeholder with the live
    // config.customProviders keys on every getProviders() call. Keeping
    // one always-registered provider lets a new endpoint start working
    // after a Settings save without a process restart.
    prefixes: ['custom'],
    label: 'Custom OAI-compatible',
    modelsPlaceholder: 'glm-5.1-fp8, llama-3.1-8b',
    capabilities: { tools: true, vision: false, audio: false, video: false },
    isConfigured: (config) => Object.values(_oaiCompatProviders(config)).some(p => p?.url),
    defaultBaseUrl: 'http://localhost:11434/v1',
    listModels: async (body) => {
      const host = api.getHostConfig() || {};
      const endpointName = String(body?.name || (body?.kind && body.kind !== 'custom' ? body.kind : '') || '').trim().toLowerCase();
      const saved = endpointName ? _oaiCompatProviders(host)[endpointName] : null;
      return listOaiCompatModels({
        baseUrl: (body?.baseUrl || body?.url || saved?.url || '').trim(),
        apiKey: (body?.apiKey || body?.key || saved?.key || '').trim(),
        authHeader: (body?.authHeader || saved?.authHeader || 'bearer').trim() || 'bearer',
      });
    },
    probe: async (body) => {
      const host = api.getHostConfig() || {};
      const endpointName = String(body?.name || (body?.kind && body.kind !== 'custom' ? body.kind : '') || '').trim().toLowerCase();
      const saved = endpointName ? _oaiCompatProviders(host)[endpointName] : null;
      const baseUrl = (body?.baseUrl || body?.url || saved?.url || '').trim();
      const apiKey = (body?.apiKey || body?.key || saved?.key || '').trim();
      const authHeader = (body?.authHeader || saved?.authHeader || 'bearer').trim() || 'bearer';
      if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
      try {
        const t0 = Date.now();
        const models = await listOaiCompatModels({ baseUrl, apiKey, authHeader });
        if (!models.ok) return models;
        return { ok: true, latency_ms: Date.now() - t0, model: `${(models.models || []).length} models listed` };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    },
    applyReasoningEffort: applyOaiCompatReasoningEffort,
  });

  const cfg = api.getHostConfig();
  const prefixes = Object.keys(_oaiCompatProviders(cfg || {}));
  api.getLogger().info(`Plugin ready — provider 'custom' registered${prefixes.length ? ` (endpoints: ${prefixes.join(', ')})` : ''}.`);
};
