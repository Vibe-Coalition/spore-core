// gemini-embedder plugin — Google Gemini text embeddings.
//
// Now depends on `gemini-provider` for the API key (Google's key
// covers chat + embeddings; we don't ask the operator to enter it
// twice). The plugin manager skips this embedder if gemini-provider
// is missing/disabled — see plugins/manager.js:initAll's depends-
// satisfaction check. Reading from gemini-provider's slot also means
// rotating the key in one place updates both at once.
//
// With this plugin and embedder-gemma both installed, operators pick
// the active embedder via config.embedder; if neither is registered,
// vectorSearch returns [] and hybridSearch degrades to keyword.

const { GeminiEmbedder } = require('./lib/gemini-embedder');

// Read the apiKey from gemini-provider. Env wins over slot so a
// Settings-pane Save with stale defaults can't override what the
// wizard / .env wrote (same precedence rule the LLM provider plugins
// use — single source of truth in env).
function _resolveApiKey(config) {
  const providerSlot = config?.plugins?.['gemini-provider'] || {};
  return process.env.GEMINI_API_KEY || config?.geminiApiKey || providerSlot.apiKey || '';
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 2, // bumped: ref-api-keys row no longer owned here (gemini-provider owns it now)
  });

  api.registerEmbedder('gemini', (config) => {
    // Inject the resolved key into the embedder's config view so the
    // existing GeminiEmbedder constructor (which reads
    // config.plugins['gemini-embedder'].apiKey) keeps working without
    // a wider refactor. Synthesize a slot that points at the provider's key.
    const apiKey = _resolveApiKey(config);
    const synthesized = {
      ...config,
      plugins: {
        ...(config.plugins || {}),
        'gemini-embedder': {
          ...(config.plugins?.['gemini-embedder'] || {}),
          apiKey,
        },
      },
    };
    return new GeminiEmbedder(synthesized);
  }, {
    dim: 768, // gemini-embedding-2-preview default
    isConfigured: (config) => !!_resolveApiKey(config),
  });

  api.registerSettingsPane({
    title: 'Gemini Embedder',
    description: 'Text embeddings via Google Gemini (gemini-embedding-2-preview, 768-dim). Reads the API key from the Google Gemini provider plugin (`gemini-provider`) — configure the key there, both chat and embeddings pick it up. With embedder-gemma also installed, set the active embedder in Advanced.',
    schema: [
      { key: 'model', label: 'Model', type: 'text', default: 'gemini-embedding-2-preview',
        help: 'Default = gemini-embedding-2-preview (768-dim). If you change to a model with a different dim, also bump the dim declared in this plugin\'s registerEmbedder call.' },
    ],
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    try {
      const cfg = api.getHostConfig();
      const apiKey = _resolveApiKey(cfg);
      if (!apiKey) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No API key — configure it in the Google Gemini plugin pane' }));
        return;
      }
      const synthesized = {
        ...cfg,
        plugins: { ...(cfg.plugins || {}), 'gemini-embedder': { ...(cfg.plugins?.['gemini-embedder'] || {}), apiKey } },
      };
      const embedder = new GeminiEmbedder(synthesized);
      const t0 = Date.now();
      const vec = await embedder.embed('hello');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, dim: vec.length, model: embedder.model }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  api.getLogger().info('Plugin ready — embedder "gemini" (gemini-embedding-2-preview, 768-dim, reads key from gemini-provider) registered.');
};
