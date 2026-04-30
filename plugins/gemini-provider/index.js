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

// Gemini's /v1beta/models is shaped differently from OAI-compat — it
// returns `{ models: [{ name: 'models/gemini-X', inputTokenLimit,
// outputTokenLimit, supportedGenerationMethods }] }`. We strip the
// `models/` prefix from the returned id and filter to entries that
// support generateContent (drops embedding-only and tuning models).
// Gemini 2.5 / 3.x extended-thinking config — generationConfig.thinkingConfig.thinkingBudget.
// Categorical effort → token budget (matches the rest of the providers'
// off/minimal/low/medium/high/max scale). Older Gemini (1.5, 2.0) doesn't
// support thinkingBudget — silently no-op for those.
function applyGeminiReasoningEffort(req, model, effort) {
  if (!/^gemini\/.*2\.5|^gemini\/.*3\.|gemini[-/]?2\.5|gemini[-/]?3/.test(String(model || '').toLowerCase())) return req;
  const out = { ...req };
  const budgets = { off: 0, minimal: 256, low: 2000, medium: 8000, high: 24000, max: 32000 };
  const bud = budgets[effort] ?? -1;
  out.generationConfig = {
    ...(out.generationConfig || {}),
    thinkingConfig: { thinkingBudget: bud },
  };
  return out;
}

async function _listGeminiModels({ apiKey }) {
  if (!apiKey) return { ok: false, error: 'missing apiKey' };
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    if (!d || !Array.isArray(d.models)) return { ok: false, error: 'no `models` array in response' };
    const models = d.models.map(m => {
      const name = String(m.name || ''); // e.g. "models/gemini-2.5-flash"
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      if (!id) return null;
      // Filter to text/multimodal Gemini chat models. /v1beta/models also
      // returns image-gen (imagen, nano-banana), audio-gen (lyria), video-gen
      // (veo), and embedding (embedding-001) entries that all happen to
      // declare generateContent support. Operator wants tier-routable
      // chat-shaped models only.
      if (!/^gemini-/.test(id)) return null;
      // Drop specialty variants — TTS, image-gen, computer-use, robotics —
      // they declare generateContent support but aren't general chat
      // models. Keep `pro`, `flash`, `flash-lite` core lines.
      if (/(?:^|-)(tts|image|embedding|computer-use|robotics)(?:-|$)/.test(id)) return null;
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) return null;
      // capabilities — Gemini 1.5+, 2.x, 3.x are all natively multimodal:
      // image + audio + video + tools. GeminiClient now converts
      // Anthropic-shape image/audio/video/file blocks to inline_data parts,
      // so the client transports what the model accepts.
      const family = id.split('-').slice(0, 2).join('-') || null; // "gemini-2.5", "gemini-1.5", etc.
      return {
        id,
        contextLength: Number(m.inputTokenLimit) > 0 ? Math.floor(Number(m.inputTokenLimit)) : null,
        maxOutput: Number(m.outputTokenLimit) > 0 ? Math.floor(Number(m.outputTokenLimit)) : null,
        family,
        capabilities: { tools: true, vision: true, audio: true, video: true },
        displayName: m.displayName || null,
      };
    }).filter(Boolean);
    // Newer first within each family.
    models.sort((a, b) => b.id.localeCompare(a.id));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

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
    label: 'Gemini',
    capabilities: { tools: true, vision: true, audio: true, video: true },
    isConfigured: (config) => {
      const slot = config?.plugins?.['gemini-provider'] || {};
      return !!(process.env.GEMINI_API_KEY || config?.geminiApiKey || slot.apiKey);
    },
    // /v1beta/models exposes inputTokenLimit + outputTokenLimit directly,
    // so no per-vendor table needed. Filter to generateContent-capable
    // entries — embedding/tuning-only models would fill the dropdown
    // with non-routable ids.
    listModels: async (body) => {
      const host = api.getHostConfig();
      const slot = api.getConfig();
      const apiKey = (body?.apiKey || '').trim()
        || process.env.GEMINI_API_KEY
        || host?.geminiApiKey
        || slot?.apiKey
        || '';
      return _listGeminiModels({ apiKey });
    },
    applyReasoningEffort: applyGeminiReasoningEffort,
    // /v1beta/models GET probe.
    probe: async (body) => {
      const apiKey = (body?.apiKey || '').trim()
        || process.env.GEMINI_API_KEY
        || api.getHostConfig()?.geminiApiKey
        || api.getConfig()?.apiKey
        || '';
      if (!apiKey) return { ok: false, error: 'missing apiKey' };
      try {
        const t0 = Date.now();
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json().catch(() => ({}));
        const count = Array.isArray(d?.models) ? d.models.length : 0;
        return { ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    },
  });

  api.registerSettingsPane({
    tab: 'providers',
    title: 'Google Gemini',
    description: 'Gemini chat models (multimodal: vision, audio, video) — and the shared API key for the gemini-embedder plugin if installed. Use model strings like `gemini/gemini-2.5-flash` in tier routing.',
    schema: [
      { key: 'apiKey', label: 'GEMINI_API_KEY', type: 'password', secret: true,
        envFallback: 'GEMINI_API_KEY',
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
