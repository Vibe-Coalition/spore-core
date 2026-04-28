// openai-provider plugin — OpenAI chat completions.
//
// Wraps the canonical OAICompatClient from local-oai-provider with
// OpenAI's defaults (api.openai.com, Bearer auth). Claims the 'openai'
// model prefix.

const { OAICompatClient } = require('../local-oai-provider/lib/oai-compat-client');

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const patch = {};
  if (host?.openaiApiKey) patch.apiKey = host.openaiApiKey;
  if (host?.openaiBaseUrl) patch.baseUrl = host.openaiBaseUrl;
  if (Object.keys(patch).length > 0) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated legacy openaiApiKey/baseUrl into plugins.openai-provider.${Object.keys(patch).join(', ')}`);
  }
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider('openai', (config) => {
    const slot = config?.plugins?.['openai-provider'] || {};
    const apiKey = slot.apiKey || config.openaiApiKey || process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('OpenAI provider: no API key (set plugins.openai-provider.apiKey or OPENAI_API_KEY)');
    return new OAICompatClient({
      baseURL: slot.baseUrl || config.openaiBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey,
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['openai'],
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['openai-provider'] || {};
      return !!(slot.apiKey || config?.openaiApiKey || process.env.OPENAI_API_KEY);
    },
    defaultBaseUrl: 'https://api.openai.com/v1',
  });

  api.registerSettingsPane({
    title: 'OpenAI',
    description: 'GPT-4o, GPT-4.1, etc. Use model strings like `openai/gpt-4o-mini` in tier routing.',
    schema: [
      { key: 'apiKey', label: 'OPENAI_API_KEY', type: 'password', secret: true,
        help: 'Standard OpenAI API key (sk-…). Also used by the whisper plugin\'s server-side STT fallback.' },
      { key: 'baseUrl', label: 'Base URL (optional)', type: 'text',
        help: 'Default https://api.openai.com/v1. Override for proxy / Azure-routed deployments.' },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Only mirror NON-EMPTY values. Empty form input = "leave alone",
    // not "clear" — prevents the regression where saving the plugin
    // pane with default/empty fields wipes the wizard's persisted env.
    const host = api.getHostConfig();
    const upd = {};
    if (newCfg.apiKey)  { host.openaiApiKey = newCfg.apiKey;   upd.OPENAI_API_KEY = newCfg.apiKey; }
    if (newCfg.baseUrl) { host.openaiBaseUrl = newCfg.baseUrl; upd.OPENAI_BASE_URL = newCfg.baseUrl; }
    if (Object.keys(upd).length === 0) return;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') gw._applyEnvUpdates(upd);
    } catch (e) { api.getLogger().warn('OPENAI env mirror failed: ' + e.message); }
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = slot.apiKey || host.openaiApiKey || process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const r = await fetch((slot.baseUrl || host.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models', {
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

  api.getLogger().info(`Plugin ready — provider 'openai' (prefix: openai) registered.`);
};
