// local-oai-provider plugin — canonical OAI-compatible LLM provider.
//
// Claims the 'local' model prefix (config: SPORE_LOCAL_MODEL_BASE_URL,
// SPORE_LOCAL_MODEL_API_KEY). Also dynamically registers a provider
// for each entry in `config.customProviders` (the legacy
// SPORE_PROVIDER_<NAME>_* env-var format), so e.g. SPORE_PROVIDER_BFL_URL
// makes 'bfl/<model>' route through this plugin without per-vendor
// extraction.
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

function buildLocalClient(config) {
  const slot = config?.plugins?.['local-oai-provider'] || {};
  // Env wins over slot. The wizard writes to env (.env file, persisted
  // outside the image), and a Settings-panel Save with unedited form
  // defaults must NOT poison what the wizard set. Slot is the fallback
  // for ops who edit via the UI before any env value exists.
  const baseURL = process.env.LOCAL_MODEL_BASE_URL
    || config.localModelBaseUrl
    || slot.baseUrl
    || 'http://localhost:11434/v1';
  const apiKey = process.env.LOCAL_MODEL_API_KEY
    || config.localModelApiKey
    || slot.apiKey
    || 'local';
  const authHeader = process.env.LOCAL_MODEL_AUTH_HEADER
    || config.localModelAuthHeader
    || slot.authHeader
    || 'bearer';
  return new OAICompatClient({
    baseURL,
    apiKey,
    authHeader,
    timeoutMs: config.apiTimeoutMs || 120000,
  });
}

function buildCustomClient(config, prefix) {
  const prov = config.customProviders?.[prefix];
  if (!prov?.url) throw new Error(`Custom provider '${prefix}' has no URL. Set SPORE_PROVIDER_${prefix.toUpperCase()}_URL.`);
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

  // Built-in prefixes the plugin claims via the localModelBaseUrl path:
  //   'local' (legacy)
  //   'oai'   (new canonical) — UNLESS customProviders already has an
  //           'oai' entry from SPORE_PROVIDER_OAI_*, in which case the
  //           custom handler below owns it (operator-configured wins).
  const cfg = api.getHostConfig();
  const localPrefixes = ['local'];
  if (!cfg.customProviders?.oai) localPrefixes.push('oai');
  api.registerProvider('local', (config) => buildLocalClient(config), {
    prefixes: localPrefixes,
    capabilities: { tools: true, vision: false, audio: false, video: false },
    isConfigured: (config) => !!(config.localModelBaseUrl || process.env.LOCAL_MODEL_BASE_URL),
    defaultBaseUrl: 'http://localhost:11434/v1',
    // Wizard "populate models" → plain OAI-compat /models probe. ctx is
    // resolved from the response fields (vLLM's max_model_len,
    // OpenAI-shaped context_length, etc.) — no per-vendor table here
    // because the operator supplied the endpoint, we don't know the vendor.
    listModels: async (body) => {
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.LOCAL_MODEL_BASE_URL
        || api.getHostConfig()?.localModelBaseUrl
        || api.getConfig()?.baseUrl
        || '';
      const apiKey = (body?.apiKey || '').trim()
        || process.env.LOCAL_MODEL_API_KEY
        || api.getHostConfig()?.localModelApiKey
        || api.getConfig()?.apiKey
        || '';
      const authHeader = (body?.authHeader || '').trim()
        || process.env.LOCAL_MODEL_AUTH_HEADER
        || api.getHostConfig()?.localModelAuthHeader
        || api.getConfig()?.authHeader
        || 'bearer';
      return listOaiCompatModels({ baseUrl, apiKey, authHeader });
    },
    applyReasoningEffort: applyOaiCompatReasoningEffort,
    // /models GET probe — same payload as listModels but returns just
    // the latency + count for the wizard's test button.
    probe: async (body) => {
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.LOCAL_MODEL_BASE_URL
        || api.getHostConfig()?.localModelBaseUrl
        || api.getConfig()?.baseUrl
        || '';
      const apiKey = (body?.apiKey || '').trim()
        || process.env.LOCAL_MODEL_API_KEY
        || api.getHostConfig()?.localModelApiKey
        || api.getConfig()?.apiKey
        || '';
      const authHeader = (body?.authHeader || '').trim()
        || process.env.LOCAL_MODEL_AUTH_HEADER
        || api.getHostConfig()?.localModelAuthHeader
        || api.getConfig()?.authHeader
        || 'bearer';
      if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
      try {
        const t0 = Date.now();
        const headers = {};
        if (apiKey) {
          if (authHeader === 'x-api-key')      headers['x-api-key']  = apiKey;
          else if (authHeader === 'x-key')     headers['x-key']      = apiKey;
          else                                 headers['Authorization'] = `Bearer ${apiKey}`;
        }
        const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json().catch(() => ({}));
        const count = Array.isArray(d?.data) ? d.data.length : 0;
        return { ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    },
  });

  // Custom-prefixed providers (legacy SPORE_PROVIDER_<NAME>_*). Register
  // ONE provider entry under name 'custom' that claims ALL configured
  // prefixes — keeps detectBackend()'s return value matching the legacy
  // 'custom' string so downstream callers (_inferCapabilities,
  // _maxOutputTokenField) keep working unchanged. The factory inspects
  // the resolved model's prefix at call time to pick the right config
  // entry.
  const customPrefixes = Object.keys(cfg.customProviders || {});
  if (customPrefixes.length > 0) {
    api.registerProvider('custom', (config) => {
      // Caller passes the full model string via the OAICompatClient's
      // params.model on every messages.create — but the factory itself
      // only sees `config`, not the model. Return a thin proxy that
      // routes per-call by inspecting the model's prefix.
      const cache = new Map();
      const proxyClient = {
        messages: {
          create: (params, opts) => {
            const slash = (params.model || '').indexOf('/');
            const prefix = slash > 0 ? params.model.substring(0, slash) : '';
            if (!cache.has(prefix)) cache.set(prefix, buildCustomClient(config, prefix));
            return cache.get(prefix).messages.create(params, opts);
          },
          stream: (params, opts) => {
            const slash = (params.model || '').indexOf('/');
            const prefix = slash > 0 ? params.model.substring(0, slash) : '';
            if (!cache.has(prefix)) cache.set(prefix, buildCustomClient(config, prefix));
            return cache.get(prefix).messages.stream(params, opts);
          },
        },
      };
      return proxyClient;
    }, {
      prefixes: customPrefixes,
      capabilities: { tools: true, vision: false, audio: false, video: false },
      isConfigured: (config) => customPrefixes.some(p => config.customProviders?.[p]?.url),
      // /api/providers/list-models with kind:'custom' — wizard sends the
      // baseUrl + apiKey + authHeader explicitly. Plain OAI-compat probe.
      listModels: async (body) => {
        return listOaiCompatModels({
          baseUrl: (body?.baseUrl || body?.url || '').trim(),
          apiKey: (body?.apiKey || body?.key || '').trim(),
          authHeader: (body?.authHeader || '').trim() || 'bearer',
        });
      },
      applyReasoningEffort: applyOaiCompatReasoningEffort,
    });
  }

  api.registerSettingsPane({
    title: 'Local OAI-compatible LLM',
    description: 'Connect any OpenAI-compatible chat-completion endpoint — vLLM, LM Studio, Ollama, llama.cpp, self-hosted. Use the model string `oai/<model-id>` (or `local/<model-id>`) in tier routing. Additional custom prefixes (e.g. bfl, glm) come from `customProviders` in spore.json.',
    schema: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'http://localhost:11434/v1',
        help: 'Mirrored to LOCAL_MODEL_BASE_URL.' },
      { key: 'apiKey', label: 'API Key (optional)', type: 'password', secret: true,
        help: 'Most local servers don\'t require auth. Set if your endpoint expects a token.' },
      { key: 'authHeader', label: 'Auth header', type: 'select', default: 'bearer',
        options: [
          { value: 'bearer',     label: 'Authorization (Bearer)' },
          { value: 'x-api-key',  label: 'x-api-key' },
          { value: 'x-key',      label: 'x-key' },
        ],
        help: 'How to send the API key. Most public OAI clones use Authorization Bearer; some self-hosted servers (BFL, certain vLLM tunnels) want x-key.',
      },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Mirror the plugin's slot to the host fields that legacy code
    // paths (the wizard's _ephemeralConfig probe path, MultiProvider
    // cache warm-up) still read. Two rules to avoid the regression
    // where saving the plugin pane with default values clobbers the
    // wizard's persisted config:
    //   1. Only mirror NON-EMPTY values. Empty form input = "leave
    //      this alone", not "clear it". Operators clear by deleting
    //      the env line directly.
    //   2. Only mirror when the value is meaningfully present in the
    //      payload (key exists AND value is non-empty). Default form
    //      values for fields the operator never touched are
    //      indistinguishable from explicit choices, so we keep them
    //      out of env entirely — buildLocalClient's fallback chain
    //      (slot → host config → env → 'bearer') handles the rest.
    const host = api.getHostConfig();
    const upd = {};
    if (newCfg.baseUrl) {
      host.localModelBaseUrl = newCfg.baseUrl;
      upd.LOCAL_MODEL_BASE_URL = newCfg.baseUrl;
    }
    if (newCfg.apiKey) {
      host.localModelApiKey = newCfg.apiKey;
      upd.LOCAL_MODEL_API_KEY = newCfg.apiKey;
    }
    if (newCfg.authHeader) {
      host.localModelAuthHeader = newCfg.authHeader;
      upd.LOCAL_MODEL_AUTH_HEADER = newCfg.authHeader;
    }
    if (Object.keys(upd).length === 0) return;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') gw._applyEnvUpdates(upd);
    } catch (e) { api.getLogger().warn('local-oai env mirror failed: ' + e.message); }
  });

  const customCount = customPrefixes.length;
  api.getLogger().info(`Plugin ready — provider 'local' (prefixes: ${localPrefixes.join(', ')})${customCount ? ` + provider 'custom' (prefixes: ${customPrefixes.join(', ')})` : ''} registered.`);
};
