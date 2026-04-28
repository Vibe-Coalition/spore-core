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

const { OAICompatClient } = require('./lib/oai-compat-client');

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
