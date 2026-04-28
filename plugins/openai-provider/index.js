// openai-provider plugin — OpenAI chat completions.
//
// Wraps the canonical OAICompatClient from local-oai-provider with
// OpenAI's defaults (api.openai.com, Bearer auth). Claims the 'openai'
// model prefix.

const { OAICompatClient, listOaiCompatModels, resolveByPrefix } = require('../local-oai-provider/lib/oai-compat-client');

// OpenAI's /v1/models has no context_window field or modality info, so
// augment via this table. Longest-prefix-wins. Reasoning models
// (o-series) carry max-output limits the agent loop reads via maxTokens
// override at chat time.
//
// capabilities = (model supports it) ∧ (our OAICompatClient transports it):
//   - vision: gpt-4o, gpt-4.1, gpt-4-turbo, o1, o3, o4 — yes. gpt-3.5,
//     legacy gpt-4 (8K/32K), o1-mini, o1-preview — no.
//   - audio: NO across the board. gpt-4o-audio-preview is the only OAI
//     model that takes audio input, and our chat-completion filter
//     drops it (see _OPENAI_NON_CHAT_TOKEN). Real-time audio uses a
//     different endpoint we don't speak.
//   - video: NO. OpenAI doesn't accept video on /v1/chat/completions.
const _VIS = { tools: true, vision: true, audio: false, video: false };
const _TXT = { tools: true, vision: false, audio: false, video: false };
const _OPENAI_MODEL_META = [
  // GPT-5 line (rumored / staged — assume modern multimodal until docs say otherwise)
  { prefix: 'gpt-5',           contextLength: 128000, maxOutput: 16000, family: 'gpt',       capabilities: _VIS },
  // o-series (reasoning) — o1 and o3+/o4+ are vision-capable; o1-mini
  // and o1-preview are text-only.
  { prefix: 'o4-mini',         contextLength: 200000, maxOutput: 100000, family: 'reasoning', capabilities: _VIS },
  { prefix: 'o4',              contextLength: 200000, maxOutput: 100000, family: 'reasoning', capabilities: _VIS },
  { prefix: 'o3-mini',         contextLength: 200000, maxOutput: 100000, family: 'reasoning', capabilities: _VIS },
  { prefix: 'o3',              contextLength: 200000, maxOutput: 100000, family: 'reasoning', capabilities: _VIS },
  { prefix: 'o1-mini',         contextLength: 128000, maxOutput: 65536,  family: 'reasoning', capabilities: _TXT },
  { prefix: 'o1-preview',      contextLength: 128000, maxOutput: 32768,  family: 'reasoning', capabilities: _TXT },
  { prefix: 'o1',              contextLength: 200000, maxOutput: 100000, family: 'reasoning', capabilities: _VIS },
  // GPT-4.1 (1M context)
  { prefix: 'gpt-4.1-nano',    contextLength: 1000000, maxOutput: 32768, family: 'gpt', capabilities: _VIS },
  { prefix: 'gpt-4.1-mini',    contextLength: 1000000, maxOutput: 32768, family: 'gpt', capabilities: _VIS },
  { prefix: 'gpt-4.1',         contextLength: 1000000, maxOutput: 32768, family: 'gpt', capabilities: _VIS },
  // GPT-4o
  { prefix: 'gpt-4o-mini',     contextLength: 128000, maxOutput: 16384, family: 'gpt', capabilities: _VIS },
  { prefix: 'gpt-4o',          contextLength: 128000, maxOutput: 16384, family: 'gpt', capabilities: _VIS },
  { prefix: 'chatgpt-4o',      contextLength: 128000, maxOutput: 16384, family: 'gpt', capabilities: _VIS },
  // GPT-4 turbo (vision in turbo-2024-04-09+) / classic gpt-4 (text-only)
  { prefix: 'gpt-4-turbo',     contextLength: 128000, maxOutput: 4096,  family: 'gpt', capabilities: _VIS },
  { prefix: 'gpt-4-32k',       contextLength: 32768,  maxOutput: 8192,  family: 'gpt', capabilities: _TXT },
  { prefix: 'gpt-4',           contextLength: 8192,   maxOutput: 8192,  family: 'gpt', capabilities: _TXT },
  // GPT-3.5 (text-only)
  { prefix: 'gpt-3.5-turbo',   contextLength: 16385,  maxOutput: 4096,  family: 'gpt', capabilities: _TXT },
];

// OpenAI reasoning-effort translator — categorical effort → reasoning_effort
// field on the request. gpt-5 family accepts 'minimal' as a value; the
// o-series (o1/o3/o4) does not, so collapse minimal→low for those.
// 'off' deletes the field so the request looks like a non-reasoning chat.
function applyOpenAIReasoningEffort(req, model, effort) {
  const m = String(model || '').toLowerCase();
  if (!(/^openai\//.test(m) || /^(o1|o3|o4|gpt-5)/.test(m))) return req;
  const out = { ...req };
  if (effort === 'off') { delete out.reasoning_effort; return out; }
  const supportsMinimal = /gpt-5/.test(m);
  let v = effort;
  if (v === 'max') v = 'high';
  if (v === 'minimal' && !supportsMinimal) v = 'low';
  out.reasoning_effort = v;
  return out;
}

// Filter: tier-routable chat-completion models only.
// Drop embedding/audio/image/moderation lines AND specialty variants
// (deep-research, realtime, audio, image, search-preview, transcribe,
// tts, instruct/base legacy) that aren't useful for general agent
// routing. Without this filter, OpenAI's /v1/models returns 100+ ids
// — the tier dropdown becomes unusable.
const _OPENAI_NON_CHAT_PREFIX = /^(text-embedding-|tts-|whisper-|dall-e-|omni-moderation-|babbage-|davinci-|computer-use-|codex-|chatgpt-image-)/;
// Substring patterns — these tokens make a model non-chat regardless
// of their position in the id (gpt-image-X, gpt-4o-realtime-Y, etc.).
const _OPENAI_NON_CHAT_TOKEN = /(?:^|-)(realtime|audio|image|transcribe|tts|deep-research|search-preview|search-api|instruct|base)(?:-|$)/;
function _isOpenAIChatModel(id) {
  if (!id) return false;
  if (_OPENAI_NON_CHAT_PREFIX.test(id)) return false;
  if (_OPENAI_NON_CHAT_TOKEN.test(id)) return false;
  return /^(gpt-|o\d|chatgpt-)/i.test(id);
}

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
    // Env wins over slot — Settings-pane Save with stale defaults must
    // not poison what the wizard / .env wrote.
    const apiKey = process.env.OPENAI_API_KEY || config.openaiApiKey || slot.apiKey || '';
    if (!apiKey) throw new Error('OpenAI provider: no API key (set plugins.openai-provider.apiKey or OPENAI_API_KEY)');
    return new OAICompatClient({
      baseURL: process.env.OPENAI_BASE_URL || config.openaiBaseUrl || slot.baseUrl || 'https://api.openai.com/v1',
      apiKey,
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['openai'],
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['openai-provider'] || {};
      return !!(process.env.OPENAI_API_KEY || config?.openaiApiKey || slot.apiKey);
    },
    defaultBaseUrl: 'https://api.openai.com/v1',
    // Wizard "populate models" hits this. /v1/models gives id + nothing
    // useful for sizing — augment via the meta table. Filters out
    // non-chat assets (embeddings, audio, image, moderation) so the
    // tier dropdowns aren't drowned in 100+ irrelevant ids.
    listModels: async (body) => {
      const host = api.getHostConfig();
      const slot = api.getConfig();
      const apiKey = (body?.apiKey || '').trim()
        || process.env.OPENAI_API_KEY
        || host?.openaiApiKey
        || slot?.apiKey
        || '';
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.OPENAI_BASE_URL
        || host?.openaiBaseUrl
        || slot?.baseUrl
        || 'https://api.openai.com/v1';
      const r = await listOaiCompatModels({
        baseUrl, apiKey, authHeader: 'bearer',
        transform: (m, base) => {
          if (!_isOpenAIChatModel(base.id)) return null;
          const meta = resolveByPrefix(base.id, _OPENAI_MODEL_META);
          if (!meta) return base;
          return {
            ...base,
            contextLength: base.contextLength || meta.contextLength,
            maxOutput: base.maxOutput || meta.maxOutput,
            family: meta.family,
            capabilities: meta.capabilities || null,
          };
        },
      });
      if (!r.ok) return r;
      // Strip nulls left by transform's filter, sort newest-first.
      const models = r.models.filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
      return { ok: true, models };
    },
    applyReasoningEffort: applyOpenAIReasoningEffort,
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
    const apiKey = process.env.OPENAI_API_KEY || host.openaiApiKey || slot.apiKey || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const r = await fetch((process.env.OPENAI_BASE_URL || host.openaiBaseUrl || slot.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models', {
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
