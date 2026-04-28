// gemini-provider plugin — Google Gemini chat completions.
//
// Owns the Google API key that BOTH this plugin and gemini-embedder use
// (Google's API key is a single token covering chat, embeddings, vision,
// audio, video). The gemini-embedder plugin's spore.plugin.json declares
// `depends: ['gemini-provider']` so it auto-skips when this provider
// isn't installed, and reads `config.plugins['gemini-provider'].apiKey`
// at embed time.
//
// Mirrors the apiKey to host config + GEMINI_API_KEY env on every save
// so any legacy code path still reading from there keeps working
// through the transition.

const { GeminiClient } = require('./lib/gemini-client');

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  // Pull from either the host-level `geminiApiKey` field (set by
  // config.js's GEMINI_API_KEY env reader) OR the gemini-embedder's
  // own slot if the operator configured it there before this provider
  // plugin existed. Whichever has a value wins; the embedder plugin's
  // copy gets cleared on the next page load via its updated isConfigured
  // reading from this plugin's slot.
  const fromEmbedder = host?.plugins?.['gemini-embedder']?.apiKey;
  const apiKey = fromEmbedder || host?.geminiApiKey;
  if (apiKey) {
    api.setConfig({ apiKey })
      .catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated GEMINI_API_KEY from ${fromEmbedder ? 'plugins.gemini-embedder' : 'host.geminiApiKey'} into plugins.gemini-provider.apiKey`);
  }
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider('gemini', (config) => {
    const slot = config?.plugins?.['gemini-provider'] || {};
    // Env wins over slot — Settings-pane Save with stale defaults must
    // not poison what the wizard / .env wrote.
    const apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey || slot.apiKey || '';
    if (!apiKey) throw new Error('Gemini provider: no API key (set plugins.gemini-provider.apiKey or GEMINI_API_KEY)');
    return new GeminiClient({ apiKey, timeoutMs: config.apiTimeoutMs || 120000 });
  }, {
    prefixes: ['gemini'],
    capabilities: { tools: true, vision: true, audio: true, video: true },
    isConfigured: (config) => {
      const slot = config?.plugins?.['gemini-provider'] || {};
      return !!(process.env.GEMINI_API_KEY || config?.geminiApiKey || slot.apiKey);
    },
  });

  api.registerSettingsPane({
    title: 'Google Gemini',
    description: 'Gemini chat models (multimodal: vision, audio, video) — and the shared API key for the gemini-embedder plugin if installed. Use model strings like `gemini/gemini-2.5-flash` in tier routing.',
    schema: [
      { key: 'apiKey', label: 'GEMINI_API_KEY', type: 'password', secret: true,
        help: 'Google AI Studio key. Free tier is plenty for embedding workloads. Used by both this plugin and gemini-embedder if installed — no need to enter it twice.' },
    ],
  });

  // Mirror to host config + env so legacy code paths and gemini-embedder
  // fallback chain see the key. Only mirror NON-EMPTY values — empty
  // form input = "leave alone", not "clear".
  api.onConfigChange((newCfg) => {
    if (!newCfg?.apiKey) return;
    const host = api.getHostConfig();
    host.geminiApiKey = newCfg.apiKey;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') {
        gw._applyEnvUpdates({ GEMINI_API_KEY: newCfg.apiKey });
      }
    } catch (e) { api.getLogger().warn('GEMINI env mirror failed: ' + e.message); }
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = process.env.GEMINI_API_KEY || host.geminiApiKey || slot.apiKey || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json().catch(() => ({}));
      const count = Array.isArray(d?.models) ? d.models.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  api.getLogger().info(`Plugin ready — provider 'gemini' (prefix: gemini, multimodal) registered.`);
};
