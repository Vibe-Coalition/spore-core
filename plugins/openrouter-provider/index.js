// openrouter-provider plugin — OpenRouter chat completions.
//
// Wraps the canonical OAICompatClient from local-oai-provider with
// OpenRouter's defaults. Adds the HTTP-Referer + X-Title headers
// OpenRouter uses for attribution. Claims the 'openrouter' model prefix.

const { OAICompatClient, listOaiCompatModels } = require('../local-oai-provider/lib/oai-compat-client');

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const patch = {};
  if (host?.openrouterApiKey) patch.apiKey = host.openrouterApiKey;
  if (host?.openrouterBaseUrl) patch.baseUrl = host.openrouterBaseUrl;
  if (host?.openrouterReferer) patch.referer = host.openrouterReferer;
  if (Object.keys(patch).length > 0) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated legacy openrouter* keys into plugins.openrouter-provider.${Object.keys(patch).join(', ')}`);
  }
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider('openrouter', (config) => {
    const slot = config?.plugins?.['openrouter-provider'] || {};
    // Env wins over slot — Settings-pane Save with stale defaults must
    // not poison what the wizard / .env wrote.
    const apiKey = process.env.OPENROUTER_API_KEY || config.openrouterApiKey || slot.apiKey || '';
    if (!apiKey) throw new Error('OpenRouter provider: no API key (set plugins.openrouter-provider.apiKey or OPENROUTER_API_KEY)');
    return new OAICompatClient({
      baseURL: process.env.OPENROUTER_BASE_URL || config.openrouterBaseUrl || slot.baseUrl || 'https://openrouter.ai/api/v1',
      apiKey,
      headers: {
        'HTTP-Referer': process.env.OPENROUTER_REFERER || config.openrouterReferer || slot.referer || 'https://spore.local',
        'X-Title': config.openrouterTitle || slot.title || (config.displayName || 'SPORE'),
      },
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['openrouter'],
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['openrouter-provider'] || {};
      return !!(process.env.OPENROUTER_API_KEY || config?.openrouterApiKey || slot.apiKey);
    },
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    // OpenRouter ships rich metadata in /v1/models — context_length AND
    // top_provider.context_length AND top_provider.max_completion_tokens.
    // listOaiCompatModels reads all three; the transform here just adds
    // displayName and family hints so the wizard can group/sort.
    listModels: async (body) => {
      const host = api.getHostConfig();
      const slot = api.getConfig();
      const apiKey = (body?.apiKey || '').trim()
        || process.env.OPENROUTER_API_KEY
        || host?.openrouterApiKey
        || slot?.apiKey
        || '';
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.OPENROUTER_BASE_URL
        || host?.openrouterBaseUrl
        || slot?.baseUrl
        || 'https://openrouter.ai/api/v1';
      const r = await listOaiCompatModels({
        baseUrl, apiKey, authHeader: 'bearer',
        transform: (m, base) => ({
          ...base,
          displayName: m.name || base.displayName,
          family: (m.id || '').split('/')[0] || null, // anthropic / openai / meta-llama / etc.
        }),
      });
      return r;
    },
  });

  api.registerSettingsPane({
    title: 'OpenRouter',
    description: 'Single key, hundreds of models. Use model strings like `openrouter/anthropic/claude-haiku-4-5` in tier routing.',
    schema: [
      { key: 'apiKey', label: 'OPENROUTER_API_KEY', type: 'password', secret: true,
        help: 'OpenRouter API key (sk-or-…).' },
      { key: 'baseUrl', label: 'Base URL (optional)', type: 'text',
        help: 'Default https://openrouter.ai/api/v1.' },
      { key: 'referer', label: 'HTTP-Referer (attribution)', type: 'text',
        help: 'OpenRouter requires a Referer for free-tier; defaults to https://spore.local.' },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Only mirror NON-EMPTY values — same reasoning as in
    // local-oai-provider's onConfigChange.
    const host = api.getHostConfig();
    const upd = {};
    if (newCfg.apiKey)  { host.openrouterApiKey = newCfg.apiKey;   upd.OPENROUTER_API_KEY = newCfg.apiKey; }
    if (newCfg.baseUrl) { host.openrouterBaseUrl = newCfg.baseUrl; upd.OPENROUTER_BASE_URL = newCfg.baseUrl; }
    if (newCfg.referer) { host.openrouterReferer = newCfg.referer; }
    if (Object.keys(upd).length === 0) return;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') gw._applyEnvUpdates(upd);
    } catch (e) { api.getLogger().warn('OPENROUTER env mirror failed: ' + e.message); }
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || host.openrouterApiKey || slot.apiKey || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const r = await fetch((process.env.OPENROUTER_BASE_URL || host.openrouterBaseUrl || slot.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json().catch(() => ({}));
      const count = Array.isArray(d?.data) ? d.data.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  api.getLogger().info(`Plugin ready — provider 'openrouter' (prefix: openrouter) registered.`);
};
