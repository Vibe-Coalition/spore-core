// embedder-gemma plugin — local text embeddings via EmbeddingGemma-300M.
//
// Runs in-process via Transformers.js + onnxruntime-node. No API key,
// no external service. Models cache to <dataDir>/transformers-cache so
// they survive container rebuilds via the /data bind mount. First
// embed() call downloads ~150MB at q4; subsequent calls are warm.
//
// When uninstalled:
//   • The 'gemma-300m' embedder is no longer registered → graph
//     indexing falls through to whichever embedder plugin is still
//     installed (gemini-embedder), or no-ops if none.

const { GemmaEmbedder } = require('./lib/gemma-embedder');

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  api.registerEmbedder('gemma-300m', (config) => new GemmaEmbedder(config, api), {
    dim: 768,
    isConfigured: () => true, // no key required; model downloads on first use
  });

  api.registerSettingsPane({
    title: 'Local Embedder (Gemma)',
    description: 'EmbeddingGemma-300M (Apache 2.0) running locally via Transformers.js. No API key. First embed downloads ~150 MB; subsequent calls are ~10–30 ms on CPU. With both this and gemini-embedder installed, set the active provider in Advanced (config.embedder).',
    schema: [
      { key: 'dtype', label: 'Quantization', type: 'select', default: 'q4',
        options: [
          { value: 'q4',   label: 'q4 (smallest, fastest, recommended)' },
          { value: 'q8',   label: 'q8 (balanced)' },
          { value: 'fp32', label: 'fp32 (highest quality, ~600 MB)' },
        ],
        help: 'EmbeddingGemma activations do not support fp16. Pick q4 unless you have a specific reason; quality differences are small for retrieval workloads.',
      },
      { key: 'dim', label: 'Output dimension', type: 'select', default: 768,
        options: [
          { value: 768, label: '768 (full, best recall)' },
          { value: 512, label: '512 (Matryoshka)' },
          { value: 256, label: '256 (Matryoshka, ~3× faster cosine search)' },
          { value: 128, label: '128 (Matryoshka, fastest, lower recall)' },
        ],
        help: 'EmbeddingGemma supports Matryoshka truncation: smaller dims = faster cosine search, slightly lower recall. 256 is a good tradeoff for graph-scale workloads.',
      },
    ],
  });

  // Self-test — ensures the runtime is wired and embeds the string
  // "hello", returning the dim and load time. First call may take
  // 10-30s while the model downloads.
  api.registerWebRoute('POST', '/test', async (req, res) => {
    try {
      const cfg = api.getHostConfig();
      const embedder = new GemmaEmbedder(cfg, api);
      const t0 = Date.now();
      const vec = await embedder.embed('hello');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, dim: vec.length, dtype: embedder.dtype }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  api.getLogger().info('Plugin ready — embedder "gemma-300m" (EmbeddingGemma-300M, 768-dim Matryoshka, local) + capability registered.');
};
