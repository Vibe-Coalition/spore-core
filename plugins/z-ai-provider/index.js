// z-ai-provider plugin — Z.ai cloud chat completions (GLM-4.x / GLM-Z1).
//
// Wraps the canonical OAICompatClient from local-oai-provider with
// Z.ai's defaults. Claims the 'zai' model prefix — refs look like
// 'zai/glm-4.6', 'zai/glm-4.5-air', 'zai/glm-z1-flash', etc.
//
// Z.ai's API at https://api.z.ai/api/paas/v4 is OpenAI-compatible at
// /chat/completions and /models. Reasoning-capable models (the Z1
// family + glm-zero) accept reasoning_effort; non-reasoning models
// silently ignore it (same forgiving behavior as OpenRouter).

const { OAICompatClient, listOaiCompatModels } = require('../local-oai-provider/lib/oai-compat-client');

const Z_AI_PREFIX = 'zai';
const Z_AI_DEFAULT_BASE = 'https://api.z.ai/api/paas/v4';

// Reasoning models on Z.ai. The Z1 family (glm-z1-*) and glm-zero are
// thinking-capable; everything else (glm-4.x, charglm, emohaa) treats
// reasoning_effort as a no-op. Match conservatively — if a model slips
// in that we don't recognize, send the field anyway; Z.ai ignores it.
const Z_AI_REASONING_RE = /(^|\/)(glm-z\d|glm-zero|.*-thinking)/i;

function applyZAIReasoningEffort(req, model, effort) {
  if (!/^zai\//i.test(String(model || ''))) return req;
  const out = { ...req };
  if (effort === 'off') { delete out.reasoning_effort; return out; }
  // OAI-style effort vocabulary — Z.ai accepts low/medium/high.
  const v = effort === 'minimal' ? 'low' : (effort === 'max' ? 'high' : effort);
  out.reasoning_effort = v;
  return out;
}

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  // Honor a pre-existing host-level config.zaiApiKey (none ships today,
  // but mirror the openrouter-provider pattern so any future migration
  // from a top-level key happens automatically on first install).
  const host = api.getHostConfig();
  const patch = {};
  if (host?.zaiApiKey) patch.apiKey = host.zaiApiKey;
  if (host?.zaiBaseUrl) patch.baseUrl = host.zaiBaseUrl;
  if (Object.keys(patch).length > 0) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated legacy zai* keys into plugins.z-ai-provider.${Object.keys(patch).join(', ')}`);
  }
}

function _resolveApiKey(api, body) {
  const slot = api.getConfig() || {};
  const host = api.getHostConfig() || {};
  return (body?.apiKey && body.apiKey !== '***hidden***' ? body.apiKey.trim() : '')
    || process.env.ZAI_API_KEY
    || host.zaiApiKey
    || slot.apiKey
    || '';
}

function _resolveBaseUrl(api, body) {
  const slot = api.getConfig() || {};
  const host = api.getHostConfig() || {};
  return (body?.baseUrl || '').trim()
    || process.env.ZAI_BASE_URL
    || host.zaiBaseUrl
    || slot.baseUrl
    || Z_AI_DEFAULT_BASE;
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider(Z_AI_PREFIX, (config) => {
    const slot = config?.plugins?.['z-ai-provider'] || {};
    // Env wins over slot (matches openrouter-provider rationale).
    const apiKey = process.env.ZAI_API_KEY || config.zaiApiKey || slot.apiKey || '';
    if (!apiKey) throw new Error("Z.ai provider: no API key (set plugins.z-ai-provider.apiKey or ZAI_API_KEY)");
    return new OAICompatClient({
      baseURL: process.env.ZAI_BASE_URL || config.zaiBaseUrl || slot.baseUrl || Z_AI_DEFAULT_BASE,
      apiKey,
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: [Z_AI_PREFIX],
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['z-ai-provider'] || {};
      return !!(process.env.ZAI_API_KEY || config?.zaiApiKey || slot.apiKey);
    },
    defaultBaseUrl: Z_AI_DEFAULT_BASE,
    // Z.ai's /models endpoint returns OpenAI-shape data. Beyond id, the
    // payload is sparse — most entries lack context_length, so we lean
    // on the OAICompatClient transform to fall back to the per-id
    // heuristic table (see CONTEXT_HINTS below) until the API exposes
    // proper metadata.
    listModels: async (body) => {
      const apiKey = _resolveApiKey(api, body);
      const baseUrl = _resolveBaseUrl(api, body);
      if (!apiKey) return { ok: false, error: 'missing apiKey' };
      const r = await listOaiCompatModels({
        baseUrl, apiKey, authHeader: 'bearer',
        transform: (m, base) => {
          const id = String(m.id || base.id || '');
          const lower = id.toLowerCase();
          // Per-family ctx hints — Z.ai's /models doesn't expose
          // context_length yet. Numbers are from the public model
          // table (z.ai/docs). Used only when the API doesn't supply
          // a number directly.
          let ctx = base.contextLength || 0;
          let maxOut = base.maxOutput || 0;
          if (!ctx) {
            if (/glm-4\.6/.test(lower))             ctx = 200000;
            else if (/glm-4\.5/.test(lower))        ctx = 131072;
            else if (/glm-z1.*flash/.test(lower))   ctx = 131072;
            else if (/glm-z1/.test(lower))          ctx = 131072;
            else if (/glm-zero/.test(lower))        ctx = 32768;
            else if (/glm-4-long/.test(lower))      ctx = 1000000;
            else if (/glm-4-air/.test(lower))       ctx = 131072;
            else if (/glm-4(-flash|-plus)?/.test(lower)) ctx = 131072;
            else if (/charglm/.test(lower))         ctx = 8192;
            else if (/emohaa/.test(lower))          ctx = 8192;
          }
          if (!maxOut) {
            if (/glm-z1|glm-zero/.test(lower))  maxOut = 32768;  // reasoning models — long output budgets
            else if (/glm-4\.6|glm-4\.5/.test(lower)) maxOut = 8192;
            else                                     maxOut = 4096;
          }
          const isReasoning = Z_AI_REASONING_RE.test(lower);
          return {
            ...base,
            displayName: base.displayName || id,
            family: 'glm',
            contextLength: ctx,
            maxOutput: maxOut,
            capabilities: {
              tools: true,
              // GLM-4.5V / GLM-4V / GLM-4-Vision are vision-capable;
              // others not. Match conservatively on -v / vision suffixes.
              vision: /(^|-)(v|vision)(-|$)/i.test(lower) || /-4v\b/.test(lower),
              audio: false,
              video: false,
            },
            reasoning: isReasoning,
          };
        },
      });
      return r;
    },
    applyReasoningEffort: applyZAIReasoningEffort,
    // Per-model default reasoning effort. Z1 family + glm-zero are
    // thinking models; light flash variants get 'low' to keep latency
    // reasonable, the rest auto-medium. Non-reasoning families return
    // null so the loop sends no reasoning_effort field at all.
    getDefaultReasoningEffort: (model /* hostConfig unused */) => {
      const lower = String(model || '').toLowerCase();
      if (!Z_AI_REASONING_RE.test(lower)) return null;
      if (/flash/.test(lower)) return 'low';
      return 'medium';
    },
    // /api/providers/zai/test — Settings → Providers → Z.ai → "test"
    // button hits this. Hits Z.ai's /models with the provided/saved
    // key. Same shape as openrouter-provider.probe.
    probe: async (body) => {
      const apiKey = _resolveApiKey(api, body);
      const baseUrl = _resolveBaseUrl(api, body);
      if (!apiKey) return { ok: false, error: 'missing apiKey' };
      try {
        const t0 = Date.now();
        const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
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

  api.registerSettingsPane({
    title: 'Z.ai (GLM)',
    description: "Z.ai cloud chat completions (GLM-4.6 / GLM-Z1 / charglm). Use model strings like `zai/glm-4.6` in tier routing. Reasoning-capable models (GLM-Z1 family) honor reasoning_effort; others ignore it.",
    schema: [
      { key: 'apiKey', label: 'ZAI_API_KEY', type: 'password', secret: true,
        help: 'Z.ai API key — get one at z.ai → Account → API Keys.' },
      { key: 'baseUrl', label: 'Base URL (optional)', type: 'text',
        help: `Default ${Z_AI_DEFAULT_BASE}. Override for self-hosted Bigmodel proxies.` },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Mirror non-empty values to host-level legacy fields + .env so a
    // future deinstall + reinstall doesn't lose the key.
    const host = api.getHostConfig();
    const upd = {};
    if (newCfg.apiKey)  { host.zaiApiKey = newCfg.apiKey;   upd.ZAI_API_KEY = newCfg.apiKey; }
    if (newCfg.baseUrl) { host.zaiBaseUrl = newCfg.baseUrl; upd.ZAI_BASE_URL = newCfg.baseUrl; }
    if (Object.keys(upd).length === 0) return;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') gw._applyEnvUpdates(upd);
    } catch (e) { api.getLogger().warn('ZAI env mirror failed: ' + e.message); }
  });

  // Plugin-scoped /test endpoint — settings pane "Test connection"
  // button posts here. Hits Z.ai's /models with the saved key.
  api.registerWebRoute('POST', '/test', async (req, res) => {
    const apiKey = _resolveApiKey(api, null);
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    const baseUrl = _resolveBaseUrl(api, null);
    try {
      const t0 = Date.now();
      const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
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

  api.getLogger().info(`Plugin ready — provider 'zai' (prefix: ${Z_AI_PREFIX}) registered.`);
};
