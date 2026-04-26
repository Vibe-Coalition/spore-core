/**
 * web.js — Web Control Panel Gateway
 *
 * HTTP server, WebSocket control panel, REST API routes,
 * terminal/SSH handlers, and voice pipeline for the web UI.
 *
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const graphEvents = require('../graph/events');

/** Pick the newer of two file paths (by mtime). Skips null/missing paths. */
function _newerFile(a, b) {
  const aOk = a && fs.existsSync(a);
  const bOk = b && fs.existsSync(b);
  if (aOk && bOk) {
    return fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b;
  }
  return aOk ? a : b;
}

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Compact theme table — kept in sync with THEMES in graph-viewer.html. Only the
// subset of vars needed by the login overlay is inlined; the viewer's JS applies
// the full set once `applyGraphTheme` runs post-auth.
// Two themes only — `dark` (Petri warm-earth baseline; vars are empty so the
// graph-viewer.html :root defaults take effect) and `light` (Petri warm-paper
// palette). The compact var set here is the subset used by the pre-auth
// login overlay; full-fat vars + node colors live in graph-viewer.html's
// THEMES object and apply post-auth via applyGraphTheme().
const _THEME_VARS = {
  dark: {},
  light: {
    '--bg': '#f3efe6', '--surface': '#fbf8f0', '--panel': '#ede7d8',
    '--border': '#e6e0d2',
    '--text': '#3c3a35', '--text-dim': '#9a948a', '--text-bright': '#1f1d1a',
    '--accent': '#c2542d', '--accent2': '#3e6b47', '--danger': '#b8341c',
  },
};

// Mirror of the client-side normalizer in graph-viewer.html. Maps any
// legacy theme name (midnight, paper, terminal, ember, arctic, neon,
// forest, anything else) onto the surviving two — `paper`/`arctic` →
// `light`, everything else → `dark`. Used everywhere a stored theme
// name might come back from preferences.json.
function _normalizeThemeName(name) {
  if (name === 'light' || name === 'paper' || name === 'arctic') return 'light';
  return 'dark';
}

function _readServerTheme(dataDir) {
  // The login overlay reflects the OPERATOR's theme — never a webapp user's
  // pick — so guests don't impose their pastel obsession on everyone.
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
    let creatorUsernames = [];
    try {
      const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'webapp-users.json'), 'utf8'));
      creatorUsernames = users.filter(u => u?.role === 'creator').map(u => u.username);
    } catch { /* silent: malformed JSON → fallback */ }
    for (const u of creatorUsernames) {
      if (prefs[u]?.theme) return _normalizeThemeName(prefs[u].theme);
    }
    // No creator theme yet (fresh install pre-onboarding) → fall back to the
    // legacy _lastUsed marker so the operator's wizard pick still lands.
    if (prefs._lastUsed?.theme) return _normalizeThemeName(prefs._lastUsed.theme);
  } catch { /* silent: malformed JSON → fallback */ }
  return 'dark';
}

function _buildThemeInlineStyle(dataDir) {
  const name = _readServerTheme(dataDir);
  const vars = _THEME_VARS[name] || {};
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}

function _acornKeyMatches(typed, stored) {
  if (!typed || !stored) return false;
  const a = Buffer.from(String(typed));
  const b = Buffer.from(String(stored));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function _isOnboardingNeeded(dataDir, config) {
  const prefsPath = path.join(dataDir, 'preferences.json');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }
  if (prefs.onboardingCompleted === true) return false;
  if (prefs.onboardingCompleted === false) return true;
  // Auto-backfill for pre-existing installs: if the instance already has
  // webapp users or a usable model+provider configured, treat it as already
  // onboarded so we don't ambush returning operators with the wizard.
  if (config) {
    let hasUsers = false;
    try { hasUsers = JSON.parse(fs.readFileSync(path.join(dataDir, 'webapp-users.json'), 'utf8')).length > 0; } catch { /* silent: malformed JSON → fallback */ }
    const hasProvider = !!(
      config.anthropicApiKey || config.openaiApiKey || config.openrouterApiKey ||
      config.geminiApiKey || config.localModelBaseUrl ||
      (config.customProviders && Object.keys(config.customProviders).length > 0)
    );
    const hasModel = !!(config.plannerModel || config.normalModel || config.casualModel);
    // Both signals required. A lone user (created mid-wizard at step 4) or a
    // lone provider isn't enough — only treat as "already onboarded" when the
    // install can actually serve a request.
    if (hasUsers && hasProvider && hasModel) {
      try {
        prefs.onboardingCompleted = true;
        prefs.onboardingBackfilledAt = Date.now();
        const tmp = prefsPath + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
        fs.renameSync(tmp, prefsPath);
      } catch (e) { console.warn('[web] _backfillOnboardingFlag write failed: ' + e.message); }
      return false;
    }
  }
  return true;
}

function _writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── Provider / model smoke-test helpers ──
function _readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 256 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Build an ephemeral config object suitable for createClientForModel from
// posted form values, so the test uses what the user just typed (not what's saved).
function _ephemeralConfig(formProviders = {}) {
  const cp = {};
  for (const p of (formProviders.custom || [])) {
    if (p?.name && p?.url) cp[p.name] = { url: p.url, key: p.key || '', authHeader: p.authHeader || 'bearer' };
  }
  return {
    anthropicApiKey: formProviders.anthropic?.apiKey || '',
    openaiApiKey: formProviders.openai?.apiKey || '',
    openaiBaseUrl: formProviders.openai?.baseUrl || '',
    openrouterApiKey: formProviders.openrouter?.apiKey || '',
    openrouterBaseUrl: formProviders.openrouter?.baseUrl || '',
    openrouterReferer: formProviders.openrouter?.referer || '',
    localModelBaseUrl: formProviders.local?.baseUrl || '',
    localModelApiKey: formProviders.local?.apiKey || '',
    geminiApiKey: formProviders.gemini?.apiKey || '',
    customProviders: cp,
    apiTimeoutMs: 240000,
  };
}

async function _probeProvider(name, body) {
  const { createClientForModel } = require('../providers');
  const cfg = _ephemeralConfig({ [name]: body, ...body.providers || {} });
  if (name === 'gemini') {
    const apiKey = body.apiKey;
    if (!apiKey) return { ok: false, error: 'missing apiKey' };
    const { embedText } = require('../graph/embedder');
    const t0 = Date.now();
    const vec = await embedText('hello', apiKey).catch(e => { throw new Error('Gemini: ' + (e?.message || e)); });
    if (!Array.isArray(vec) || !vec.length) return { ok: false, error: 'empty embedding response' };
    return { ok: true, latency_ms: Date.now() - t0, model: 'gemini-embedding-2-preview', excerpt: `${vec.length}-dim vector` };
  }
  // Pick a probe model per provider
  let probeModel;
  if (name === 'anthropic') { if (!cfg.anthropicApiKey) return { ok: false, error: 'missing apiKey' }; probeModel = 'claude-haiku-4-5-20251001'; }
  else if (name === 'openai') { if (!cfg.openaiApiKey) return { ok: false, error: 'missing apiKey' }; probeModel = 'openai/gpt-4o-mini'; }
  else if (name === 'openrouter') { if (!cfg.openrouterApiKey) return { ok: false, error: 'missing apiKey' }; probeModel = 'openrouter/anthropic/claude-haiku-4-5'; }
  else if (name === 'local') {
    if (!cfg.localModelBaseUrl) return { ok: false, error: 'missing baseUrl' };
    // Probe /models endpoint — lighter than a chat call and doesn't need a model name
    const url = (cfg.localModelBaseUrl.replace(/\/$/, '')) + '/models';
    const t0 = Date.now();
    const headers = cfg.localModelApiKey ? { Authorization: `Bearer ${cfg.localModelApiKey}` } : {};
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const d = await r.json().catch(() => ({}));
      const count = Array.isArray(d?.data) ? d.data.length : 0;
      return { ok: true, latency_ms: Date.now() - t0, model: `${count} models listed`, excerpt: (d.data?.[0]?.id || '').slice(0, 60) };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  } else {
    // Custom provider: probe by name
    const custom = cfg.customProviders?.[name];
    if (!custom) return { ok: false, error: 'unknown provider' };
    probeModel = `${name}/`; // bare prefix — expects user to provide a real model via route-level tests
    return { ok: false, error: 'custom providers: use a Model Tier test instead' };
  }
  // Chat probe
  const t0 = Date.now();
  try {
    const client = createClientForModel(probeModel, cfg);
    const response = await client.messages.create({
      model: probeModel,
      max_tokens: 64,
      messages: [{ role: 'user', content: "Respond with a single word: ok" }],
    });
    const text = (response.content || []).find(b => b.type === 'text')?.text || '';
    return { ok: true, latency_ms: Date.now() - t0, model: probeModel, excerpt: text.slice(0, 80) };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

// Anthropic doesn't surface context length on /v1/models, so we keep a small
// table of public model families. Matched by prefix.
const _ANTHROPIC_CTX = [
  ['claude-opus-4-7-1m', 1000000],
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-1', 200000],
  ['claude-sonnet-4-6', 200000],
  ['claude-sonnet-4', 200000],
  ['claude-haiku-4-5', 200000],
  ['claude-3-5-sonnet', 200000],
  ['claude-3-5-haiku', 200000],
  ['claude-3-opus', 200000],
  ['claude-3-sonnet', 200000],
  ['claude-3-haiku', 200000],
];
function _resolveContextLength(rawModel, kind) {
  if (!rawModel) return null;
  // Common OAI-compatible fields, in order of preference.
  // `max_model_len` is what vLLM returns. The rest cover OpenAI / OpenRouter /
  // llama.cpp / various adapters.
  const fields = ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'max_position_embeddings', 'max_input_tokens'];
  for (const f of fields) {
    const v = Number(rawModel[f]);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  // Some providers nest under `top_provider` (OpenRouter does this for some models).
  const tp = rawModel.top_provider;
  if (tp) {
    for (const f of fields) {
      const v = Number(tp[f]);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  // Anthropic fallback table by id prefix.
  if (kind === 'anthropic' && rawModel.id) {
    for (const [prefix, ctx] of _ANTHROPIC_CTX) {
      if (rawModel.id.startsWith(prefix)) return ctx;
    }
  }
  return null;
}

// For every tier-routed model in `models`, if `modelLimits` doesn't already
// have a contextWindow entry, probe the relevant provider's /models endpoint
// and fill it in. Guarantees per-model ctx is captured even if the wizard UI
// didn't pre-fill correctly. Probes each provider at most once per save.
async function _enrichModelLimits(modelLimits, models, providers) {
  const out = { ...(modelLimits || {}) };
  const tierEntries = Object.values(models || {}).filter(t => t?.model);
  if (!tierEntries.length) return out;
  const probedProviders = new Map(); // providerName → cached models response
  const probeProvider = async (providerName) => {
    if (probedProviders.has(providerName)) return probedProviders.get(providerName);
    const p = providers || {};
    let probeArgs = null;
    if (providerName === 'anthropic' && p.anthropic?.apiKey) probeArgs = { kind: 'anthropic', apiKey: p.anthropic.apiKey };
    else if (providerName === 'openai' && p.openai?.apiKey) probeArgs = { kind: 'openai', apiKey: p.openai.apiKey, baseUrl: p.openai.baseUrl };
    else if (providerName === 'openrouter' && p.openrouter?.apiKey) probeArgs = { kind: 'openrouter', apiKey: p.openrouter.apiKey, baseUrl: p.openrouter.baseUrl };
    else {
      const c = (p.custom || []).find(x => x?.name === providerName);
      if (c?.url) probeArgs = { kind: 'custom', baseUrl: c.url, apiKey: c.key, authHeader: c.authHeader };
    }
    if (!probeArgs) { probedProviders.set(providerName, null); return null; }
    const res = await _listModelsForProvider(probeArgs).catch(() => null);
    probedProviders.set(providerName, res);
    return res;
  };

  for (const tier of tierEntries) {
    const provider = tier.provider || 'anthropic';
    const model = tier.model;
    const key = (provider && provider !== 'anthropic') ? `${provider}/${model}` : model;
    if (out[key]?.contextWindow > 0) continue;
    const probed = await probeProvider(provider);
    if (!probed?.ok) continue;
    // Fold in EVERY model with a known ctx so we have a ready cache for future
    // tier changes too — not just the active one.
    for (const m of (probed.models || [])) {
      if (!m?.contextLength) continue;
      const k = (provider && provider !== 'anthropic') ? `${provider}/${m.id}` : m.id;
      if (!out[k]?.contextWindow) out[k] = { ...(out[k] || {}), contextWindow: m.contextLength };
    }
  }
  return out;
}

// List models for a given provider (used by the onboarding wizard's Populate button).
// Hits the provider's /models endpoint server-side so we sidestep CORS.
async function _listModelsForProvider({ kind, baseUrl, apiKey, authHeader }) {
  if (!kind) return { ok: false, error: 'missing kind' };
  let url, headers = {};
  if (kind === 'anthropic') {
    if (!apiKey) return { ok: false, error: 'missing apiKey' };
    url = 'https://api.anthropic.com/v1/models';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (kind === 'openai') {
    if (!apiKey) return { ok: false, error: 'missing apiKey' };
    url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models';
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (kind === 'openrouter') {
    url = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/models';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (kind === 'gemini') {
    return { ok: false, error: 'Gemini is embeddings-only' };
  } else if (kind === 'custom' || kind === 'local') {
    if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
    url = baseUrl.replace(/\/$/, '') + '/models';
    if (apiKey) {
      if (authHeader === 'x-api-key') headers['x-api-key'] = apiKey;
      else if (authHeader === 'x-key') headers['x-key'] = apiKey;
      else headers['Authorization'] = `Bearer ${apiKey}`;
    }
  } else {
    return { ok: false, error: `unsupported kind: ${kind}` };
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    if (!d) return { ok: false, error: 'invalid JSON response' };
    const arr = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.models) ? d.models : null);
    if (!arr) return { ok: false, error: 'no `data` or `models` array in response' };
    const models = arr.map(m => {
      if (typeof m === 'string') return { id: m, contextLength: null };
      const id = m.id || m.name || '';
      if (!id) return null;
      return { id, contextLength: _resolveContextLength(m, kind) };
    }).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

const _TIER_PROMPTS = {
  casual: { system: '', user: 'What is 2+2? Answer with just the number.', expectText: /\b4\b/ },
  normal: { system: '', user: 'Respond with EXACTLY this JSON and nothing else: {"ok":true}', expectJson: v => v?.ok === true },
  planner: { system: 'You are a planning assistant.', user: 'Plan a 3-step approach for: "Investigate and fix a unit test failure". Output a numbered list with 3 items only.', expectText: /3[\.\)]|three/i },
  subagent: { system: '', user: 'Respond with EXACTLY this JSON: {"task":"noted"}', expectJson: v => v?.task === 'noted' },
  learner: {
    system: 'You are a knowledge extraction system. Extract entities/facts/relationships from the given conversation as JSON.',
    user: 'Conversation:\nUser: I bought a red Tesla Model 3 last Tuesday at the Palo Alto showroom for $52k.\n\nReturn JSON of form {"entities":[{"id":"...","type":"...","label":"..."}]} with at least one entity.',
    expectJson: v => Array.isArray(v?.entities) && v.entities.length >= 1,
  },
};

async function _probeModelTier(tier, body, appConfig) {
  const { createClientForModel, detectBackend } = require('../providers');
  const { provider, model, providers } = body || {};
  if (!model) return { ok: false, error: 'missing model' };

  // Merge config with posted form values so the ephemeral client honors current keys
  const cfg = { ...(appConfig || {}), ..._ephemeralConfig(providers || {}) };

  // Compose the effective model id (provider prefix + model).
  // The /api/settings API returns the model split into provider + model where
  // `model` can itself contain slashes (e.g. "/shared/home/.../GLM-5.1-FP8").
  // So "includes('/')" is NOT a safe proxy for "already prefixed". Prepend
  // whenever the model doesn't START with "${provider}/" (or the provider
  // isn't anthropic, which has no prefix).
  let effectiveModel = model;
  if (provider && provider !== 'anthropic' && !model.startsWith(provider + '/')) {
    effectiveModel = `${provider}/${model}`;
  }

  if (tier === 'imageVlm' || tier === 'videoVlm' || tier === 'audioVlm') {
    return await _probeVLMTier(tier, effectiveModel, cfg);
  }

  const spec = _TIER_PROMPTS[tier];
  if (!spec) return { ok: false, error: `unknown tier: ${tier}` };

  const t0 = Date.now();
  try {
    const client = createClientForModel(effectiveModel, cfg);
    const messages = [{ role: 'user', content: spec.user }];
    // Honor a per-model maxTokens override. Priority:
    //   1. body.maxTokens (what the operator just typed in the tier row,
    //      lets them test before saving)
    //   2. config.modelLimits[<ref>].maxTokens (saved value)
    //   3. 8K default — enough for reasoning models (Qwen/GLM/Kimi) to
    //      finish thinking and still produce a final-answer block.
    const limits = cfg?.modelLimits || {};
    const savedLimKey = limits[effectiveModel]
      ? effectiveModel
      : Object.keys(limits).find(k => k.endsWith('/' + effectiveModel)) ||
        Object.keys(limits).find(k => {
          const slash = k.indexOf('/');
          return slash > 0 && k.slice(slash + 1) === effectiveModel;
        }) || null;
    const savedLim = savedLimKey ? limits[savedLimKey] : null;
    const perModelMax =
      Number(body?.maxTokens) ||
      Number(savedLim?.maxTokens) ||
      0;
    let params = { model: effectiveModel, max_tokens: perModelMax > 0 ? perModelMax : 8192, messages };
    // Reasoning effort: prefer body override (live UI value), else saved.
    const effort = body?.reasoningEffort || savedLim?.reasoningEffort || null;
    if (effort && effort !== 'auto') {
      try {
        const { AgentLoop } = require('../agent/loop');
        params = AgentLoop.applyReasoningEffort(params, effectiveModel, effort);
      } catch (e) { console.warn('[web] applyReasoningEffort failed: ' + e.message); }
    }
    if (spec.system) params.system = spec.system;

    let text = '';
    let ttft = null;
    let reasoningOnly = false;
    // Prefer streaming so nginx tunnels don't 504 on slow models
    const stream = (typeof client.messages.stream === 'function') ? client.messages.stream(params) : null;
    const extractText = (blocks) => {
      const t = (blocks || []).find(b => b.type === 'text')?.text || '';
      if (t) return { text: t, reasoningOnly: false };
      // Reasoning-only fallback: if the model emitted only thinking blocks
      // (typical when max_tokens cut it off mid-reasoning), surface that so
      // the probe at least sees SOMETHING. Common on Qwen3/GLM-style models.
      const thinking = (blocks || []).find(b => b.type === 'thinking')?.thinking
                    || (blocks || []).find(b => b.type === 'thinking')?.text || '';
      if (thinking) return { text: thinking, reasoningOnly: true };
      return { text: '', reasoningOnly: false };
    };
    if (stream && typeof stream.on === 'function' && typeof stream.finalMessage === 'function') {
      stream.on('text', chunk => { if (ttft == null) ttft = Date.now() - t0; });
      const result = await stream.finalMessage();
      ({ text, reasoningOnly } = extractText(result?.content));
    } else {
      const r = await client.messages.create(params);
      ({ text, reasoningOnly } = extractText(r?.content));
    }

    // Check expectation
    let matched = true;
    if (spec.expectText) matched = spec.expectText.test(text);
    else if (spec.expectJson) {
      try {
        const m = text.match(/[\{\[][\s\S]*[\}\]]/);
        const j = JSON.parse((m ? m[0] : text).trim().replace(/^```json\s*|```\s*$/g, ''));
        matched = !!spec.expectJson(j);
      } catch { matched = false; }
    }
    return {
      ok: matched,
      latency_ms: Date.now() - t0,
      ttft_ms: ttft,
      model: effectiveModel,
      excerpt: text.slice(0, 200),
      reasoningOnly,
      error: matched ? undefined : (
        reasoningOnly
          ? 'model returned only reasoning (no final answer) — likely cut off by max_tokens. Bump max_tokens or pick a non-reasoning model for the casual tier.'
          : (text ? 'response did not match expected format' : 'model returned empty response')
      ),
    };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

async function _probeVLMTier(tier, effectiveModel, cfg) {
  const { createClientForModel } = require('../providers');
  const mapping = {
    imageVlm: { file: 'test-image.png', mime: 'image/png', prompt: 'What color is the main shape in this image? Answer with one word.' },
    videoVlm: { file: 'test-video.mp4', mime: 'video/mp4', prompt: 'Briefly describe what this video shows in one sentence.' },
    audioVlm: { file: 'test-audio.mp3', mime: 'audio/mp3', prompt: 'Briefly describe what you hear in one sentence.' },
  };
  const spec = mapping[tier];
  const filePath = path.join(__dirname, '..', 'static', 'test-assets', spec.file);
  let b64 = '';
  try { b64 = fs.readFileSync(filePath).toString('base64'); }
  catch (e) { return { ok: false, error: `test asset missing: ${spec.file}` }; }

  // Build content — use image block for imageVlm; for video/audio, Anthropic does not
  // support those content blocks directly, so fall back to a text-only smoke test that
  // states a file was sent (lets us at least verify connectivity on the routed model).
  let content;
  if (tier === 'imageVlm') {
    content = [
      { type: 'image', source: { type: 'base64', media_type: spec.mime, data: b64 } },
      { type: 'text', text: spec.prompt },
    ];
  } else {
    // video / audio — most providers don't accept raw media as a content block here.
    // Do a text-only reachability probe; real analysis happens via the analyze tool.
    content = spec.prompt + ' (Note: smoke test — this tier is used by the analyze_' + (tier === 'videoVlm' ? 'video' : 'audio') + ' tool.)';
  }

  const t0 = Date.now();
  try {
    const client = createClientForModel(effectiveModel, cfg);
    const params = { model: effectiveModel, max_tokens: 1024, messages: [{ role: 'user', content }] };
    const r = await client.messages.create(params);
    const text = (r.content || []).find(b => b.type === 'text')?.text || '';
    return { ok: true, latency_ms: Date.now() - t0, model: effectiveModel, excerpt: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

class WebGateway {
  constructor(toolSystem) {
    this.tools = toolSystem;
    this.config = toolSystem.config;
    this.log = toolSystem.log;
    this.graph = toolSystem.graph;
    this.skills = toolSystem.skills;

    this._server = null;
    this._serverDir = null;
    this._wss = null;
    this._sshManager = null;
    this._voicePipeline = null;
    this._webSessions = new Map();
    // Session client registry: sessionId -> Set<{ws, role:'origin'|'observer'}>
    this._sessionClients = new Map();
  }

  _settingsConfigPath() {
    return path.resolve(__dirname, '..', 'spore.json');
  }

  _settingsEnvPath() {
    return path.resolve(__dirname, '..', '.env');
  }

  // Wipes all user-data tables in the graph DB, then re-applies the
  // seeded reference nodes. Synchronous-ish — runs inside one BEGIN
  // / COMMIT on the live db handle. Always backs up first; backup
  // path is returned to the caller. Throws on any failure (the API
  // wrapper turns that into a 500 + ROLLBACK has already happened).
  //
  // Tables wiped: all tables that hold user-derived state (nodes,
  // aspects, attributes, edges, gaps, episodes, hints, derived facts,
  // reflections, audit/recycle data, FTS shadows). The schema stays —
  // only data is deleted. After wipe we re-apply
  // /app/reference-nodes.sql + every /app/migrate-ref-*.sql so the
  // ref-* nodes come back fresh per the seed contract.
  async _resetGraphToSeeds() {
    const db = this.graph?.db;
    if (!db) throw new Error('graph db not initialized');
    const dbPath = this.config.graphDbPath;
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error('graph db path missing on disk');

    // Backup first so the action is recoverable.
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '').slice(0, 19);
    const backup = dbPath + '.pre-reset.' + ts;
    fs.copyFileSync(dbPath, backup);

    const before = {
      nodes:    db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
      aspects:  db.prepare('SELECT COUNT(*) c FROM aspects').get().c,
      attrs:    db.prepare('SELECT COUNT(*) c FROM attributes').get().c,
      edges:    db.prepare('SELECT COUNT(*) c FROM edges').get().c,
      episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    };

    // Tables that hold user state. Order doesn't matter with FKs off
    // but we list children first as a sanity-check shape. Wrapped in
    // try so a missing table on an older schema doesn't abort the
    // whole reset — e.g. derived_facts didn't exist in early builds.
    const userTables = [
      'edges', 'attribute_history', 'attributes', 'aspects', 'gaps',
      'hints', 'derived_facts', 'reflections', 'quality_audits',
      'recycle_bin', 'node_sources', 'edge_sources', 'aliases',
      'node_group_members', 'node_groups', 'episodes', 'meta',
      'nodes',
    ];
    const ftsTables = ['attr_fts', 'episodes_fts', 'hints_fts'];

    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN TRANSACTION');
    try {
      for (const t of userTables) {
        try { db.exec(`DELETE FROM ${t}`); } catch (e) { this.log.debug(`[reset-graph] skipping ${t}: ${e.message}`); }
      }
      // Rebuild FTS indexes — they're contentless tables linked to
      // their content tables; after we delete the content rows the
      // FTS shadow has stale index entries until we tell it to
      // rebuild.
      for (const fts of ftsTables) {
        try { db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`); } catch (e) { this.log.warn('[web] db.exec failed: ' + e.message); }
      }

      // Re-apply seeds in order:
      //   1. seed-graph.sql — agent self-node + identity / voice / rules
      //      AND the original ref-* nodes from the install era (FLUX,
      //      ElevenLabs, web architecture, etc.). Templated with the
      //      AGENT_ID / AGENT_NAME placeholders the same way
      //      seedGraph() does at first boot.
      //   2. migrate-ref-*.sql — newer ref nodes (ssh, tailscale,
      //      cluster, search-tools, email) + additive aspects on
      //      existing refs. All idempotent (WHERE NOT EXISTS guards)
      //      so re-running is safe.
      //
      // Notably we do NOT apply reference-nodes.sql here even though
      // it exists on disk. It's a near-duplicate of the ref-* sections
      // already inside seed-graph.sql; applying both creates duplicate
      // attributes (the INSERTs in those files lack OR IGNORE because
      // attributes have no unique constraint to defer to). The janitor
      // catches the dupes eventually but that's wasteful — better to
      // not create them in the first place. seed-graph.sql is the
      // canonical seed; reference-nodes.sql sits as a historical
      // alternate that no boot path actually reads.
      const appDir = path.resolve(__dirname, '..');
      const seedGraphPath = path.join(appDir, 'seed-graph.sql');
      if (fs.existsSync(seedGraphPath)) {
        const agentId = this.config.agentId || 'spore';
        const agentName = this.config.displayName ||
          agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        let sg = fs.readFileSync(seedGraphPath, 'utf8');
        sg = sg.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);
        db.exec(sg);
      } else {
        this.log.warn('[reset-graph] seed-graph.sql missing — agent self-node will not be restored');
      }
      for (const f of fs.readdirSync(appDir).filter(x => x.startsWith('migrate-ref-') && x.endsWith('.sql')).sort()) {
        const fp = path.join(appDir, f);
        if (fs.existsSync(fp)) db.exec(fs.readFileSync(fp, 'utf8'));
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys=ON');
      throw e;
    }
    db.exec('PRAGMA foreign_keys=ON');

    const after = {
      nodes:    db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
      aspects:  db.prepare('SELECT COUNT(*) c FROM aspects').get().c,
      attrs:    db.prepare('SELECT COUNT(*) c FROM attributes').get().c,
      edges:    db.prepare('SELECT COUNT(*) c FROM edges').get().c,
      episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    };

    this.log.warn(`[reset-graph] graph reset complete; backup at ${backup}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    return { backup, before, after };
  }

  _readSettingsConfigFile() {
    const filePath = this._settingsConfigPath();
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _writeSettingsConfigFile(nextConfig) {
    fs.writeFileSync(this._settingsConfigPath(), `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  _applyEnvUpdates(envUpdates) {
    const envPath = this._settingsEnvPath();
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const lines = raw ? raw.split(/\r?\n/) : [];
    const pending = new Map(Object.entries(envUpdates || {}));
    const seen = new Set();
    const nextLines = [];

    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) {
        nextLines.push(line);
        continue;
      }
      const key = m[1];
      if (!pending.has(key)) {
        nextLines.push(line);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const value = pending.get(key);
      pending.delete(key);
      if (value === null || value === undefined || value === '') continue;
      nextLines.push(`${key}=${String(value)}`);
    }

    for (const [key, value] of pending.entries()) {
      if (value === null || value === undefined || value === '') continue;
      nextLines.push(`${key}=${String(value)}`);
    }

    const normalized = nextLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
    fs.writeFileSync(envPath, normalized);

    for (const [key, value] of Object.entries(envUpdates || {})) {
      if (value === null || value === undefined || value === '') delete process.env[key];
      else process.env[key] = String(value);
    }
  }

  _deriveDisplayName(agentId) {
    return (agentId || 'spore')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  _normalizeSettingsModelRef(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return { raw: '', provider: 'anthropic', model: '' };
    const slash = raw.indexOf('/');
    if (slash <= 0) return { raw, provider: 'anthropic', model: raw };
    return {
      raw,
      provider: raw.slice(0, slash).trim().toLowerCase() || 'anthropic',
      model: raw.slice(slash + 1).trim(),
    };
  }

  _composeSettingsModelRef(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed || null;
    }
    const provider = String(value.provider || 'anthropic').trim().toLowerCase() || 'anthropic';
    const model = String(value.model || value.name || '').trim();
    if (!model) return null;
    return provider === 'anthropic' ? model : `${provider}/${model}`;
  }

  _currentCustomProviderNames() {
    const names = new Set(Object.keys(this.config.customProviders || {}));
    const providerRe = /^SPORE_PROVIDER_([A-Z0-9_]+)_(URL|KEY|AUTH_HEADER)$/;
    for (const key of Object.keys(process.env)) {
      const m = key.match(providerRe);
      if (m) names.add(m[1].toLowerCase());
    }
    return [...names];
  }

  _normalizeSettingsCustomProviders(rawProviders) {
    const builtins = new Set(['anthropic', 'openai', 'openrouter', 'local', 'gemini']);
    const providers = [];
    const seen = new Set();
    for (const entry of Array.isArray(rawProviders) ? rawProviders : []) {
      const name = String(entry?.name || '').trim().toLowerCase();
      if (!name) continue;
      if (builtins.has(name)) {
        throw new Error(`Custom provider "${name}" conflicts with a built-in provider name`);
      }
      if (!/^[a-z0-9_]+$/.test(name)) {
        throw new Error(`Custom provider "${name}" must use lowercase letters, numbers, and underscores only`);
      }
      if (seen.has(name)) continue;
      seen.add(name);
      providers.push({
        name,
        url: String(entry?.url || '').trim(),
        key: String(entry?.key || '').trim(),
        authHeader: String(entry?.authHeader || 'bearer').trim() || 'bearer',
      });
    }
    return providers;
  }

  _normalizeBrowserBackendSetting(rawValue) {
    const raw = String(rawValue || '').trim().toLowerCase();
    if (!raw || raw === 'zd') return 'zendriver';
    if (raw === 'pw') return 'playwright';
    if (!['zendriver', 'playwright'].includes(raw)) {
      throw new Error(`Unknown browser backend "${rawValue}". Use zendriver or playwright.`);
    }
    return raw;
  }

  _getSettingsState() {
    const fileConfig = this._readSettingsConfigFile();
    const envDisplay = !!process.env.SPORE_DISPLAY_NAME;
    const envNicknames = !!process.env.SPORE_NICKNAMES;
    const envVoice = [
      'SPORE_VOICE_ENABLED',
      'SPORE_STT_PROVIDER',
      'SPORE_TTS_PROVIDER',
      'SPORE_TTS_VOICE',
      'SPORE_TTS_MODEL',
      'SPORE_TTS_EDGE_VOICE',
    ].some(k => !!process.env[k]);
    const envProactive = [
      'SPORE_PROACTIVE_ENABLED',
      'SPORE_PROACTIVE_COOLDOWN',
      'SPORE_PROACTIVE_MAX_DAY',
      'SPORE_PROACTIVE_CHANNELS',
    ].some(k => !!process.env[k]);
    const sttConfigured = !!(this.config.deepgramApiKey || this.config.openaiApiKey);
    const pipeline = this._ensureVoicePipeline();
    const customProviders = Object.entries(this.config.customProviders || {})
      .map(([name, provider]) => ({
        name,
        url: provider?.url || '',
        key: provider?.key || '',
        authHeader: provider?.authHeader || 'bearer',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      identity: {
        agentId: this.config.agentId,
        displayName: this.config.displayName || this._deriveDisplayName(this.config.agentId),
        nicknames: Array.isArray(this.config.nicknames) ? this.config.nicknames : [],
      },
      memory: {
        enhancedRecall: !!this.config.enhancedRecall,
      },
      proactive: {
        enabled: !!this.config.proactive?.enabled,
        cooldownMinutes: Number(this.config.proactive?.cooldownMinutes || 60),
        maxPerDay: Number(this.config.proactive?.maxPerDay || 5),
        channels: Array.isArray(this.config.proactive?.channels) ? this.config.proactive.channels : [],
      },
      voice: {
        enabled: !!this.config.voice?.enabled,
        sttProvider: this.config.voice?.sttProvider || 'deepgram',
        ttsProvider: this.config.voice?.ttsProvider || '',
        ttsVoice: this.config.voice?.ttsVoice || '',
        ttsModel: this.config.voice?.ttsModel || '',
        edgeVoice: this.config.voice?.edgeVoice || 'en-US-AriaNeural',
        ready: !!pipeline,
        sttConfigured,
        note: sttConfigured
          ? (pipeline ? 'Voice pipeline is ready.' : 'Voice is enabled but the pipeline is not ready.')
          : 'Voice needs an STT key (Deepgram or OpenAI) to become active.',
      },
      runtime: {
        publicUrl: this.config.publicUrl || null,
        webPort: this.config.webPort || null,
        workspacePath: this.config.workspacePath || process.cwd(),
        dataDir: this.config.dataDir || null,
      },
      models: {
        casual: this._normalizeSettingsModelRef(this.config.casualModel),
        normal: this._normalizeSettingsModelRef(this.config.normalModel),
        planner: this._normalizeSettingsModelRef(this.config.plannerModel),
        subagent: this._normalizeSettingsModelRef(this.config.subagentModel),
        learner: this._normalizeSettingsModelRef(this.config.learnerModel),
        imageVlm: this._normalizeSettingsModelRef(this.config.imageVlmModel),
        videoVlm: this._normalizeSettingsModelRef(this.config.videoVlmModel),
        audioVlm: this._normalizeSettingsModelRef(this.config.audioVlmModel),
      },
      providers: {
        anthropic: {
          apiKey: this.config.anthropicApiKey || '',
          apiKeySet: !!this.config.anthropicApiKey,
        },
        openai: {
          apiKey: this.config.openaiApiKey || '',
          apiKeySet: !!this.config.openaiApiKey,
          baseUrl: this.config.openaiBaseUrl || '',
        },
        openrouter: {
          apiKey: this.config.openrouterApiKey || '',
          apiKeySet: !!this.config.openrouterApiKey,
          baseUrl: this.config.openrouterBaseUrl || '',
          referer: this.config.openrouterReferer || '',
        },
        local: {
          apiKey: this.config.localModelApiKey || '',
          apiKeySet: !!this.config.localModelApiKey,
          baseUrl: this.config.localModelBaseUrl || '',
        },
        gemini: {
          apiKey: this.config.geminiApiKey || '',
          apiKeySet: !!this.config.geminiApiKey,
        },
        custom: customProviders,
      },
      acorn: {
        enabled: !!this.config.acornKey,
        key: this.config.acornKey || '',
      },
      webSearch: {
        searxngUrl: this.config.searxngUrl || '',
        searxngApiKey: this.config.searxngApiKey ? '***hidden***' : '',
        searxngApiKeySet: !!this.config.searxngApiKey,
        braveApiKey: this.config.braveApiKey ? '***hidden***' : '',
        braveApiKeySet: !!this.config.braveApiKey,
      },
      modelLimits: this.config.modelLimits || {},
      budgets: (() => {
        // System-prompt section budgets (graph/context.js GraphContext).
        // Surface the current effective values + class defaults so the UI
        // can show "default: N" alongside each input. The UI exposes
        // runtime + total as headline knobs; an "all 18 sections"
        // expander uses sections + sectionDefaults.
        const G = this.graph?.constructor;
        const sectionDefaults = G ? { ...G.SECTION_BUDGETS } : {};
        const totalDefault = G ? G.TOTAL_BUDGET : 40000;
        const sections = this.graph?._sectionBudgets ? { ...this.graph._sectionBudgets } : { ...sectionDefaults };
        const total = this.graph?._totalBudget ?? totalDefault;
        return {
          runtime: sections.runtime ?? sectionDefaults.runtime ?? null,
          total,
          sections,
          sectionDefaults,
          totalDefault,
        };
      })(),
      browser: {
        backend: this.config.browserBackend || 'zendriver',
        availableBackends: ['zendriver', 'playwright'],
      },
      sources: {
        displayName: envDisplay ? 'env' : (fileConfig.displayName ? 'file' : 'derived'),
        nicknames: envNicknames ? 'env' : ((Array.isArray(fileConfig.nicknames) && fileConfig.nicknames.length) ? 'file' : 'derived'),
        proactive: envProactive ? 'env' : (fileConfig.proactive ? 'file' : 'default'),
        voice: envVoice ? 'env' : (fileConfig.voice ? 'file' : 'default'),
        enhancedRecall: Object.prototype.hasOwnProperty.call(fileConfig, 'enhancedRecall') ? 'file' : 'default',
        models: 'env',
        providers: 'env',
        acorn: this.config.acornKey ? 'env' : 'disabled',
        browser: process.env.SPORE_BROWSER_BACKEND ? 'env' : (fileConfig.browserBackend ? 'file' : 'default'),
      },
      plugins: this._buildPluginsSettingsBlock(),
    };
  }

  /**
   * Collect installed plugins' settings panes for the settings UI. Returns
   * `{ enabled, hotReload, panes: [{ pluginId, title, tab, schema, values, meta, ... }] }`.
   * Secret fields are masked: `meta[key].isSet` is the only signal the UI gets.
   */
  _buildPluginsSettingsBlock() {
    const mgr = this.tools?._pluginManager;
    if (!mgr?.getSettingsPanes) {
      return { enabled: !!this.config.pluginsEnabled, hotReload: !!this.config.pluginsHotReload, panes: [], dockItems: [], available: [], dirs: { bundled: null, user: null } };
    }
    const dirs = mgr.getDiscoveryDirs?.() || {};
    return {
      enabled: !!this.config.pluginsEnabled,
      hotReload: !!this.config.pluginsHotReload,
      dirs: { bundled: dirs.bundled || null, user: dirs.user || null },
      panes: mgr.getSettingsPanes(),
      dockItems: mgr.getDockItems?.() || [],
      available: mgr.listAvailable?.() || [],
    };
  }

  /**
   * Wire `pluginManager.setConfigPersister` so plugin code calling
   * `api.setConfig(partial)` flows through the same _persistSettingsPatch
   * path the settings UI uses. Idempotent — registered once per process.
   */
  _ensurePluginConfigPersister() {
    const mgr = this.tools?._pluginManager;
    if (!mgr?.setConfigPersister) return;
    if (mgr._configPersister) return; // already wired
    mgr.setConfigPersister(async (pluginId, partial) => {
      this._persistSettingsPatch({ plugins: { [pluginId]: partial } });
      return { ...(this.config.plugins?.[pluginId] || {}) };
    });
  }

  _persistSettingsPatch(body = {}) {
    this._ensurePluginConfigPersister();
    const fileConfig = this._readSettingsConfigFile();
    const nextConfig = {
      ...fileConfig,
      proactive: { ...(fileConfig.proactive || this.config.proactive || {}) },
      voice: { ...(fileConfig.voice || this.config.voice || {}) },
    };
    const envUpdates = {};
    const runtimePatch = {};
    let voiceTouched = false;
    let modelTouched = false;
    let providerTouched = false;

    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
      const displayName = String(body.displayName || '').trim();
      if (displayName) {
        nextConfig.displayName = displayName;
        runtimePatch.displayName = displayName;
        envUpdates.SPORE_DISPLAY_NAME = displayName;
      } else {
        delete nextConfig.displayName;
        runtimePatch.displayName = this._deriveDisplayName(this.config.agentId);
        envUpdates.SPORE_DISPLAY_NAME = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'nicknames')) {
      const raw = Array.isArray(body.nicknames)
        ? body.nicknames
        : String(body.nicknames || '').split(',');
      const nicknames = raw.map(v => String(v).toLowerCase().trim()).filter(Boolean);
      nextConfig.nicknames = nicknames;
      runtimePatch.nicknames = nicknames;
      envUpdates.SPORE_NICKNAMES = nicknames.length ? nicknames.join(',') : null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'enhancedRecall')) {
      const enabled = !!body.enhancedRecall;
      nextConfig.enhancedRecall = enabled;
      runtimePatch.enhancedRecall = enabled;
    }

    if (body.proactive && typeof body.proactive === 'object') {
      const nextProactive = { ...(nextConfig.proactive || {}) };
      if (Object.prototype.hasOwnProperty.call(body.proactive, 'enabled')) {
        nextProactive.enabled = !!body.proactive.enabled;
        envUpdates.SPORE_PROACTIVE_ENABLED = nextProactive.enabled ? 'true' : 'false';
      }
      if (Object.prototype.hasOwnProperty.call(body.proactive, 'cooldownMinutes')) {
        nextProactive.cooldownMinutes = Math.max(1, parseInt(body.proactive.cooldownMinutes, 10) || 60);
        envUpdates.SPORE_PROACTIVE_COOLDOWN = String(nextProactive.cooldownMinutes);
      }
      if (Object.prototype.hasOwnProperty.call(body.proactive, 'maxPerDay')) {
        nextProactive.maxPerDay = Math.max(1, parseInt(body.proactive.maxPerDay, 10) || 5);
        envUpdates.SPORE_PROACTIVE_MAX_DAY = String(nextProactive.maxPerDay);
      }
      if (Object.prototype.hasOwnProperty.call(body.proactive, 'channels')) {
        const raw = Array.isArray(body.proactive.channels)
          ? body.proactive.channels
          : String(body.proactive.channels || '').split(',');
        nextProactive.channels = raw.map(v => String(v).trim()).filter(Boolean);
        envUpdates.SPORE_PROACTIVE_CHANNELS = nextProactive.channels.length ? nextProactive.channels.join(',') : null;
      }
      nextConfig.proactive = nextProactive;
      runtimePatch.proactive = {
        ...(this.config.proactive || {}),
        ...nextProactive,
      };
    }

    if (body.voice && typeof body.voice === 'object') {
      const nextVoice = { ...(nextConfig.voice || {}) };
      const runtimeVoice = { ...(this.config.voice || {}) };
      if (Object.prototype.hasOwnProperty.call(body.voice, 'enabled')) {
        nextVoice.enabled = !!body.voice.enabled;
        runtimeVoice.enabled = !!body.voice.enabled;
        envUpdates.SPORE_VOICE_ENABLED = nextVoice.enabled ? 'true' : null;
        voiceTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(body.voice, 'sttProvider')) {
        const sttProvider = String(body.voice.sttProvider || 'deepgram').trim() || 'deepgram';
        nextVoice.sttProvider = sttProvider;
        runtimeVoice.sttProvider = sttProvider;
        envUpdates.SPORE_STT_PROVIDER = sttProvider;
        voiceTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(body.voice, 'ttsProvider')) {
        const ttsProvider = String(body.voice.ttsProvider || '').trim();
        nextVoice.ttsProvider = ttsProvider || null;
        runtimeVoice.ttsProvider = ttsProvider || null;
        envUpdates.SPORE_TTS_PROVIDER = ttsProvider || null;
        voiceTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(body.voice, 'ttsVoice')) {
        const ttsVoice = String(body.voice.ttsVoice || '').trim();
        nextVoice.ttsVoice = ttsVoice || null;
        runtimeVoice.ttsVoice = ttsVoice || null;
        envUpdates.SPORE_TTS_VOICE = ttsVoice || null;
        voiceTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(body.voice, 'ttsModel')) {
        const ttsModel = String(body.voice.ttsModel || '').trim();
        nextVoice.ttsModel = ttsModel || null;
        runtimeVoice.ttsModel = ttsModel || null;
        envUpdates.SPORE_TTS_MODEL = ttsModel || null;
        voiceTouched = true;
      }
      if (Object.prototype.hasOwnProperty.call(body.voice, 'edgeVoice')) {
        const edgeVoice = String(body.voice.edgeVoice || '').trim();
        nextVoice.edgeVoice = edgeVoice || 'en-US-AriaNeural';
        runtimeVoice.edgeVoice = edgeVoice || 'en-US-AriaNeural';
        envUpdates.SPORE_TTS_EDGE_VOICE = edgeVoice || null;
        voiceTouched = true;
      }
      Object.keys(nextVoice).forEach(key => {
        if (nextVoice[key] === null || nextVoice[key] === undefined || nextVoice[key] === '') delete nextVoice[key];
      });
      nextConfig.voice = nextVoice;
      runtimePatch.voice = runtimeVoice;
    }

    if (body.models && typeof body.models === 'object') {
      const modelFields = [
        ['casual', 'casualModel', 'SPORE_CASUAL_MODEL'],
        ['normal', 'normalModel', 'SPORE_NORMAL_MODEL'],
        ['planner', 'plannerModel', 'SPORE_PLANNER_MODEL'],
        ['subagent', 'subagentModel', 'SPORE_SUBAGENT_MODEL'],
        ['learner', 'learnerModel', 'SPORE_LEARNER_MODEL'],
        ['imageVlm', 'imageVlmModel', 'SPORE_IMAGE_VLM_MODEL'],
        ['videoVlm', 'videoVlmModel', 'SPORE_VIDEO_VLM_MODEL'],
        ['audioVlm', 'audioVlmModel', 'SPORE_AUDIO_VLM_MODEL'],
      ];
      for (const [bodyKey, configKey, envKey] of modelFields) {
        if (!Object.prototype.hasOwnProperty.call(body.models, bodyKey)) continue;
        const rawModel = this._composeSettingsModelRef(body.models[bodyKey]);
        envUpdates[envKey] = rawModel || null;
        runtimePatch[configKey] = rawModel || null;
        modelTouched = true;
      }
      if (modelTouched) envUpdates.SPORE_MODEL = null;
    }

    if (body.providers && typeof body.providers === 'object') {
      const providers = body.providers;
      const assignProviderField = (bodyValue, envKey, runtimeKey) => {
        const nextValue = String(bodyValue || '').trim();
        envUpdates[envKey] = nextValue || null;
        runtimePatch[runtimeKey] = nextValue || '';
        providerTouched = true;
      };

      if (providers.anthropic && typeof providers.anthropic === 'object') {
        if (Object.prototype.hasOwnProperty.call(providers.anthropic, 'apiKey')) {
          assignProviderField(providers.anthropic.apiKey, 'ANTHROPIC_API_KEY', 'anthropicApiKey');
        }
      }

      if (providers.openai && typeof providers.openai === 'object') {
        if (Object.prototype.hasOwnProperty.call(providers.openai, 'apiKey')) {
          assignProviderField(providers.openai.apiKey, 'OPENAI_API_KEY', 'openaiApiKey');
        }
        if (Object.prototype.hasOwnProperty.call(providers.openai, 'baseUrl')) {
          assignProviderField(providers.openai.baseUrl, 'OPENAI_BASE_URL', 'openaiBaseUrl');
        }
      }

      if (providers.openrouter && typeof providers.openrouter === 'object') {
        if (Object.prototype.hasOwnProperty.call(providers.openrouter, 'apiKey')) {
          assignProviderField(providers.openrouter.apiKey, 'OPENROUTER_API_KEY', 'openrouterApiKey');
        }
        if (Object.prototype.hasOwnProperty.call(providers.openrouter, 'baseUrl')) {
          assignProviderField(providers.openrouter.baseUrl, 'OPENROUTER_BASE_URL', 'openrouterBaseUrl');
        }
        if (Object.prototype.hasOwnProperty.call(providers.openrouter, 'referer')) {
          assignProviderField(providers.openrouter.referer, 'OPENROUTER_REFERER', 'openrouterReferer');
        }
      }

      if (providers.local && typeof providers.local === 'object') {
        if (Object.prototype.hasOwnProperty.call(providers.local, 'apiKey')) {
          assignProviderField(providers.local.apiKey, 'LOCAL_MODEL_API_KEY', 'localModelApiKey');
        }
        if (Object.prototype.hasOwnProperty.call(providers.local, 'baseUrl')) {
          assignProviderField(providers.local.baseUrl, 'LOCAL_MODEL_BASE_URL', 'localModelBaseUrl');
        }
      }

      if (providers.gemini && typeof providers.gemini === 'object') {
        if (Object.prototype.hasOwnProperty.call(providers.gemini, 'apiKey')) {
          assignProviderField(providers.gemini.apiKey, 'GEMINI_API_KEY', 'geminiApiKey');
        }
      }

      if (Object.prototype.hasOwnProperty.call(providers, 'custom')) {
        const normalizedProviders = this._normalizeSettingsCustomProviders(providers.custom);
        const currentNames = this._currentCustomProviderNames();
        for (const name of currentNames) {
          const upper = name.toUpperCase();
          envUpdates[`SPORE_PROVIDER_${upper}_URL`] = null;
          envUpdates[`SPORE_PROVIDER_${upper}_KEY`] = null;
          envUpdates[`SPORE_PROVIDER_${upper}_AUTH_HEADER`] = null;
        }
        const nextCustomProviders = {};
        for (const provider of normalizedProviders) {
          const upper = provider.name.toUpperCase();
          envUpdates[`SPORE_PROVIDER_${upper}_URL`] = provider.url || null;
          envUpdates[`SPORE_PROVIDER_${upper}_KEY`] = provider.key || null;
          envUpdates[`SPORE_PROVIDER_${upper}_AUTH_HEADER`] = provider.authHeader || null;
          nextCustomProviders[provider.name] = {
            name: provider.name,
            url: provider.url || '',
            key: provider.key || '',
            authHeader: provider.authHeader || 'bearer',
          };
        }
        runtimePatch.customProviders = nextCustomProviders;
        providerTouched = true;
      }
    }

    if (body.acorn && typeof body.acorn === 'object') {
      const enabled = !!body.acorn.enabled;
      const requestedKey = String(body.acorn.key || '').trim();
      let nextKey = '';
      let generated = false;
      if (enabled) {
        if (requestedKey) {
          nextKey = requestedKey;
        } else if (this.config.acornKey) {
          nextKey = this.config.acornKey;
        } else {
          // First-time enable with no key supplied → mint a fresh team key.
          nextKey = crypto.randomUUID();
          generated = true;
        }
      }
      envUpdates.SPORE_ACORN_KEY = nextKey || null;
      runtimePatch.acornKey = nextKey || null;
      if (generated) runtimePatch._acornKeyGenerated = true;
    }

    if (body.browser && typeof body.browser === 'object'
      && Object.prototype.hasOwnProperty.call(body.browser, 'backend')) {
      const backend = this._normalizeBrowserBackendSetting(body.browser.backend);
      envUpdates.SPORE_BROWSER_BACKEND = backend;
      runtimePatch.browserBackend = backend;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'publicUrl')) {
      const raw = String(body.publicUrl || '').trim().replace(/\/+$/, '');
      envUpdates.SPORE_PUBLIC_URL = raw || null;
      runtimePatch.publicUrl = raw || null;
    }

    if (body.modelLimits && typeof body.modelLimits === 'object') {
      const validEfforts = new Set(['off','minimal','low','medium','high','max']);
      const cleaned = {};
      for (const [model, lim] of Object.entries(body.modelLimits)) {
        if (!model) continue;
        const ctx = Number(lim?.contextWindow);
        const cmp = Number(lim?.compactAt);
        const mxo = Number(lim?.maxTokens);
        const eff = String(lim?.reasoningEffort || '').toLowerCase();
        const entry = {};
        if (Number.isFinite(ctx) && ctx > 0) entry.contextWindow = Math.floor(ctx);
        if (Number.isFinite(cmp) && cmp > 0) entry.compactAt = Math.floor(cmp);
        if (Number.isFinite(mxo) && mxo > 0) entry.maxTokens = Math.floor(mxo);
        if (validEfforts.has(eff)) entry.reasoningEffort = eff;
        if (Object.keys(entry).length) cleaned[model] = entry;
      }
      const json = Object.keys(cleaned).length ? JSON.stringify(cleaned) : null;
      envUpdates.SPORE_MODEL_LIMITS = json;
      runtimePatch.modelLimits = cleaned;
    }

    if (body.budgets && typeof body.budgets === 'object') {
      // System-prompt budget overrides — persist to spore.json +
      // SPORE_SECTION_BUDGETS / SPORE_TOTAL_BUDGET env, AND mutate the
      // live GraphContext so the change takes effect on the very next
      // turn (no restart). Validation mirrors the constructor: only
      // known keys, only positive integers; everything else dropped.
      const G = this.graph?.constructor;
      const knownSectionKeys = new Set(G ? Object.keys(G.SECTION_BUDGETS) : []);
      let sectionsCleaned = null;
      if (body.budgets.sections && typeof body.budgets.sections === 'object') {
        sectionsCleaned = {};
        for (const [k, v] of Object.entries(body.budgets.sections)) {
          if (!knownSectionKeys.has(k)) continue;
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) continue;
          sectionsCleaned[k] = Math.floor(n);
        }
      }
      // Headline runtime knob — merge into sectionsCleaned if provided
      // separately. Lets the UI send just {runtime: N} without echoing
      // the entire 18-section map back.
      if (Object.prototype.hasOwnProperty.call(body.budgets, 'runtime')) {
        const n = Number(body.budgets.runtime);
        if (Number.isFinite(n) && n > 0) {
          sectionsCleaned = sectionsCleaned || {};
          sectionsCleaned.runtime = Math.floor(n);
        }
      }
      if (sectionsCleaned !== null) {
        const json = Object.keys(sectionsCleaned).length ? JSON.stringify(sectionsCleaned) : null;
        envUpdates.SPORE_SECTION_BUDGETS = json;
        nextConfig.sectionBudgets = Object.keys(sectionsCleaned).length ? sectionsCleaned : undefined;
        runtimePatch.sectionBudgets = sectionsCleaned;
      }
      if (Object.prototype.hasOwnProperty.call(body.budgets, 'total')) {
        const n = Number(body.budgets.total);
        if (Number.isFinite(n) && n > 0) {
          envUpdates.SPORE_TOTAL_BUDGET = String(Math.floor(n));
          nextConfig.totalPromptBudget = Math.floor(n);
          runtimePatch.totalPromptBudget = Math.floor(n);
        } else {
          envUpdates.SPORE_TOTAL_BUDGET = null;
          delete nextConfig.totalPromptBudget;
          runtimePatch.totalPromptBudget = null;
        }
      }
    }

    if (body.webSearch && typeof body.webSearch === 'object') {
      if (Object.prototype.hasOwnProperty.call(body.webSearch, 'searxngUrl')) {
        const u = String(body.webSearch.searxngUrl || '').trim();
        envUpdates.SEARXNG_URL = u || null;
        runtimePatch.searxngUrl = u || '';
      }
      if (Object.prototype.hasOwnProperty.call(body.webSearch, 'searxngApiKey')) {
        const k = String(body.webSearch.searxngApiKey || '').trim();
        if (k && k !== '***hidden***') {
          envUpdates.SEARXNG_API_KEY = k;
          runtimePatch.searxngApiKey = k;
        } else if (!k) {
          envUpdates.SEARXNG_API_KEY = null;
          runtimePatch.searxngApiKey = '';
        }
      }
      if (Object.prototype.hasOwnProperty.call(body.webSearch, 'braveApiKey')) {
        const k = String(body.webSearch.braveApiKey || '').trim();
        if (k && k !== '***hidden***') {
          envUpdates.BRAVE_API_KEY = k;
          runtimePatch.braveApiKey = k;
        } else if (!k) {
          envUpdates.BRAVE_API_KEY = null;
          runtimePatch.braveApiKey = '';
        }
      }
    }

    // Plugins config branch — body.plugins = { [pluginId]: { ...partialPatch } }.
    // Each pluginId's patch is shallow-merged into nextConfig.plugins[id] and,
    // after the file write, this.config.plugins[id]. We collect the list of
    // touched plugin ids so we can fire onConfigChange callbacks AFTER the
    // file write (so any plugin reacting to its config sees the persisted state).
    const pluginsTouched = [];
    if (body.plugins && typeof body.plugins === 'object' && !Array.isArray(body.plugins)) {
      const nextPlugins = { ...(nextConfig.plugins || {}) };
      for (const pluginId of Object.keys(body.plugins)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) continue;
        const patch = body.plugins[pluginId];
        if (!patch || typeof patch !== 'object') continue;
        const before = { ...(nextPlugins[pluginId] || {}) };
        const next = { ...before };
        for (const key of Object.keys(patch)) {
          const v = patch[key];
          if (v === null) delete next[key];
          else next[key] = v;
        }
        nextPlugins[pluginId] = next;
        pluginsTouched.push({ pluginId, before, after: next });
      }
      nextConfig.plugins = nextPlugins;
    }

    this._writeSettingsConfigFile(nextConfig);
    this._applyEnvUpdates(envUpdates);

    // Apply plugin config to the live config object, then dispatch onConfigChange
    // hooks. We don't await — plugin reactors are best-effort and shouldn't block
    // the HTTP response.
    if (pluginsTouched.length > 0) {
      if (!this.config.plugins) this.config.plugins = {};
      const mgr = this.tools?._pluginManager;
      for (const { pluginId, before, after } of pluginsTouched) {
        this.config.plugins[pluginId] = after;
        if (mgr?.dispatchConfigChange) {
          mgr.dispatchConfigChange(pluginId, before, after).catch(e => {
            this.log.warn(`[settings] plugin ${pluginId} config-change failed: ${e?.message}`);
          });
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'displayName')) this.config.displayName = runtimePatch.displayName;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'nicknames')) this.config.nicknames = runtimePatch.nicknames;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'enhancedRecall')) this.config.enhancedRecall = runtimePatch.enhancedRecall;
    if (runtimePatch.proactive) this.config.proactive = runtimePatch.proactive;
    if (runtimePatch.voice) this.config.voice = runtimePatch.voice;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'casualModel')) this.config.casualModel = runtimePatch.casualModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'normalModel')) this.config.normalModel = runtimePatch.normalModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'plannerModel')) this.config.plannerModel = runtimePatch.plannerModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'subagentModel')) this.config.subagentModel = runtimePatch.subagentModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'learnerModel')) this.config.learnerModel = runtimePatch.learnerModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'imageVlmModel')) this.config.imageVlmModel = runtimePatch.imageVlmModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'videoVlmModel')) this.config.videoVlmModel = runtimePatch.videoVlmModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'audioVlmModel')) this.config.audioVlmModel = runtimePatch.audioVlmModel;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'anthropicApiKey')) this.config.anthropicApiKey = runtimePatch.anthropicApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'openaiApiKey')) this.config.openaiApiKey = runtimePatch.openaiApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'openaiBaseUrl')) this.config.openaiBaseUrl = runtimePatch.openaiBaseUrl;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'openrouterApiKey')) this.config.openrouterApiKey = runtimePatch.openrouterApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'openrouterBaseUrl')) this.config.openrouterBaseUrl = runtimePatch.openrouterBaseUrl;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'openrouterReferer')) this.config.openrouterReferer = runtimePatch.openrouterReferer;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'localModelApiKey')) this.config.localModelApiKey = runtimePatch.localModelApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'localModelBaseUrl')) this.config.localModelBaseUrl = runtimePatch.localModelBaseUrl;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'geminiApiKey')) this.config.geminiApiKey = runtimePatch.geminiApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'customProviders')) this.config.customProviders = runtimePatch.customProviders;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'acornKey')) this.config.acornKey = runtimePatch.acornKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'browserBackend')) this.config.browserBackend = runtimePatch.browserBackend;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'publicUrl')) this.config.publicUrl = runtimePatch.publicUrl;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'searxngUrl')) this.config.searxngUrl = runtimePatch.searxngUrl;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'searxngApiKey')) this.config.searxngApiKey = runtimePatch.searxngApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'braveApiKey')) this.config.braveApiKey = runtimePatch.braveApiKey;
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'modelLimits')) this.config.modelLimits = runtimePatch.modelLimits;
    // Live-apply budget overrides to the running GraphContext so the
    // next assembled system prompt picks them up without a restart.
    // Falls back to class defaults when the override is empty/null
    // (matches what GraphContext's constructor does).
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'sectionBudgets')) {
      this.config.sectionBudgets = runtimePatch.sectionBudgets || {};
      const G = this.graph?.constructor;
      if (this.graph && G) {
        this.graph._sectionBudgets = { ...G.SECTION_BUDGETS, ...(runtimePatch.sectionBudgets || {}) };
      }
    }
    if (Object.prototype.hasOwnProperty.call(runtimePatch, 'totalPromptBudget')) {
      this.config.totalPromptBudget = runtimePatch.totalPromptBudget;
      const G = this.graph?.constructor;
      if (this.graph && G) {
        this.graph._totalBudget = runtimePatch.totalPromptBudget || G.TOTAL_BUDGET;
      }
    }
    this.config.model = this.config.plannerModel || this.config.normalModel || this.config.casualModel || null;
    this.config._isOAuth = !!(this.config.anthropicApiKey && String(this.config.anthropicApiKey).includes('sk-ant-oat'));
    if (voiceTouched) this._voicePipeline = null;
    if (providerTouched || modelTouched) {
      this.tools?.anthropicClient?.clearCache?.();
      // (Re)initialize the agent loop. On a fresh install the loop boots with
      // no model and `client` is never set; once the operator saves a real
      // provider+model via the wizard or settings pane, we need to wire it up
      // without forcing a container restart.
      const agent = this.tools?._agent;
      if (agent) {
        try {
          // Force a fresh MultiProvider so it picks up the new config.
          agent.client = null;
          if (typeof agent.init === 'function') agent.init();
        } catch (e) { this.log.warn(`[settings] agent re-init failed: ${e.message}`); }
      }
    }

    const state = this._getSettingsState();
    if (runtimePatch._acornKeyGenerated) state._acornKeyGenerated = true;
    return state;
  }

  _applyOnboardingToGraph(db, payload = {}) {
    let agentId = this.config.agentId;
    // If the configured agentId doesn't match a node, fall back to the first type='self' node.
    let selfRow = agentId && db.prepare('SELECT id FROM nodes WHERE id = ?').get(agentId);
    if (!selfRow) selfRow = db.prepare("SELECT id FROM nodes WHERE type = 'self' LIMIT 1").get();
    if (!selfRow) { this.log.warn(`[onboarding] no self node found; skipping graph sync`); return; }
    agentId = selfRow.id;

    const run = () => {
      const displayName = String(payload.displayName || '').trim();
      const nicknames = Array.isArray(payload.nicknames) ? payload.nicknames.map(s => String(s).trim()).filter(Boolean) : [];

      if (displayName) {
        const pitch = nicknames.length
          ? `${displayName} — known as ${nicknames.join(', ')}. Configured via the first-run wizard.`
          : `${displayName}. Configured via the first-run wizard.`;
        db.prepare("UPDATE nodes SET label = ?, description = ?, updated = datetime('now') WHERE id = ?")
          .run(displayName, pitch, agentId);
      }

      if (nicknames.length) {
        db.prepare('DELETE FROM aliases WHERE node_id = ?').run(agentId);
        const ins = db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)');
        for (const a of nicknames) ins.run(agentId, a);
      }

      const ensureAspect = (nodeId, name, weight) => {
        const existing = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, name);
        if (existing) return existing.id;
        return db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?,?,?,?)')
          .run(nodeId, name, weight, 'onboarding').lastInsertRowid;
      };
      const upsertAttr = (aspectId, content, importance) => {
        const existing = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(aspectId, content);
        if (existing) return;
        db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?,?,?,?,?)')
          .run(aspectId, content, importance, 'onboarding', 'onboarding');
      };

      // Providers — attach to ref-api-keys if present, else to self
      const providers = payload.providers || {};
      const configuredProviders = [];
      if (providers.anthropic?.apiKey) configuredProviders.push('Anthropic (ANTHROPIC_API_KEY)');
      if (providers.openai?.apiKey) configuredProviders.push('OpenAI (OPENAI_API_KEY)');
      if (providers.openrouter?.apiKey) configuredProviders.push('OpenRouter (OPENROUTER_API_KEY)');
      if (providers.local?.apiKey || providers.local?.baseUrl) configuredProviders.push('Local OAI-compatible (LOCAL_MODEL_*)');
      if (providers.gemini?.apiKey) configuredProviders.push('Gemini Embedder (GEMINI_API_KEY)');
      if (Array.isArray(providers.custom)) {
        for (const p of providers.custom) {
          if (p?.name && (p.key || p.url)) configuredProviders.push(`Custom provider: ${p.name}`);
        }
      }
      if (configuredProviders.length) {
        const refApiKeys = db.prepare("SELECT id FROM nodes WHERE id = 'ref-api-keys'").get();
        const targetNode = refApiKeys ? 'ref-api-keys' : agentId;
        const aspId = ensureAspect(targetNode, 'configured_providers', 8);
        for (const line of configuredProviders) upsertAttr(aspId, `${line} — configured during onboarding`, 7);
      }

      // Models
      const models = payload.models || {};
      const modelLines = [];
      for (const [tier, ref] of Object.entries(models)) {
        if (!ref) continue;
        const provider = ref.provider || '';
        const name = (ref.model || '').trim();
        if (!name) continue;
        const full = provider && provider !== 'anthropic' ? `${provider}/${name}` : name;
        modelLines.push(`${tier}: ${full}`);
      }
      if (modelLines.length) {
        const aspId = ensureAspect(agentId, 'model_routing', 7);
        for (const line of modelLines) upsertAttr(aspId, line, 6);
      }

      // Voice
      const voice = payload.voice || {};
      if (voice.enabled) {
        const aspId = ensureAspect(agentId, 'voice_pipeline', 6);
        const parts = [];
        if (voice.sttProvider) parts.push(`STT: ${voice.sttProvider}`);
        if (voice.ttsProvider) parts.push(`TTS: ${voice.ttsProvider}`);
        if (voice.ttsVoice) parts.push(`voice: ${voice.ttsVoice}`);
        upsertAttr(aspId, `Voice enabled — ${parts.join(', ') || 'defaults'}`, 6);
      }

      // Web search
      const ws = payload.webSearch || {};
      if (ws.searxngUrl || ws.braveApiKey) {
        const refApiKeys = db.prepare("SELECT id FROM nodes WHERE id = 'ref-api-keys'").get();
        const targetNode = refApiKeys ? 'ref-api-keys' : agentId;
        const aspId = ensureAspect(targetNode, 'web_search', 7);
        if (ws.searxngUrl) upsertAttr(aspId, `SearXNG configured (primary): ${ws.searxngUrl}`, 7);
        if (ws.braveApiKey && ws.braveApiKey !== '***hidden***') upsertAttr(aspId, 'Brave Search configured (fallback)', 6);
      }

      // Browser backend
      const browserBackend = payload.browser?.backend;
      if (browserBackend) {
        const aspId = ensureAspect(agentId, 'tooling_preferences', 5);
        upsertAttr(aspId, `Browser backend: ${browserBackend}`, 5);
      }

      // Theme
      if (payload.theme) {
        const aspId = ensureAspect(agentId, 'operator_preferences', 4);
        upsertAttr(aspId, `UI theme: ${payload.theme}`, 4);
      }
    };

    try {
      db.exec('BEGIN');
      run();
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  get server() { return this._server; }
  get wss() { return this._wss; }

  handleAction(action, dir, opts = {}) {
    if (action === 'status') return this._status();
    if (action === 'stop') return this._stop();
    if (action === 'start') return this._start(dir);
    if (action === 'backend') return this._startWithBackend(dir, opts);
    return { error: `Unknown action: ${action}` };
  }

  broadcast(msg) {
    if (!this._wss) return;
    const data = JSON.stringify(msg);
    const creatorOnly = msg.type && msg.type.startsWith('benchmark:');
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (creatorOnly && client._role !== 'admin') continue;
      try { client.send(data); } catch (e) { this.log.warn('[web] client.send failed: ' + e.message); }
    }
  }

  // ── Session client registry (for observer mode) ─────────────────────

  _registerSessionClient(sessionId, ws, role = 'origin') {
    if (!this._sessionClients.has(sessionId)) {
      this._sessionClients.set(sessionId, new Set());
    }
    const set = this._sessionClients.get(sessionId);
    // Remove any existing entry for this ws OR same user+role (handles reconnect
    // where the old WebSocket hasn't fired 'close' yet — prevents ghost clients
    // that echo messages back to the reconnected client)
    const toRemove = [];
    for (const entry of set) {
      if (entry.ws === ws) { toRemove.push(entry); continue; }
      if (entry.role === role && entry.ws._user && entry.ws._user === ws._user) {
        toRemove.push(entry);
      }
    }
    for (const entry of toRemove) set.delete(entry);
    set.add({ ws, role });

    // Re-send orphaned tools from a previous CLI that disconnected mid-execution
    if (role === 'origin' && this._orphanedTools?.has(sessionId)) {
      const orphaned = this._orphanedTools.get(sessionId);
      this._orphanedTools.delete(sessionId);
      if (orphaned?.length) {
        this.log.info(`[ws] Re-sending ${orphaned.length} orphaned tool(s) to reconnected CLI for ${sessionId}`);
        if (!ws._pendingTools) ws._pendingTools = new Map();
        for (const tool of orphaned) {
          // The original tool:request data isn't saved (we only have the Promise),
          // so we can't re-send the exact request. Instead, reject the pending
          // promises with a retryable error — the agent loop will retry the tool.
          clearTimeout(tool.timeout);
          tool.reject(new Error(`CLI reconnected — tool execution interrupted. Retry.`));
        }
      }
    }
  }

  _unregisterSessionClient(sessionId, ws) {
    const set = this._sessionClients.get(sessionId);
    if (!set) return;
    for (const entry of set) {
      if (entry.ws === ws) { set.delete(entry); break; }
    }
    if (set.size === 0) this._sessionClients.delete(sessionId);
  }

  /**
   * Forward a message to all OTHER clients in the same session as the sender.
   * Uses msg.sessionId if present (reliable), falls back to membership search.
   */
  _forwardToSessionPeers(ws, msg) {
    const targetSid = msg.sessionId;
    if (targetSid) {
      const clients = this._sessionClients.get(targetSid);
      if (clients) {
        const data = JSON.stringify(msg);
        let count = 0;
        for (const entry of clients) {
          if (entry.ws !== ws && entry.ws.readyState === 1) {
            try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
          }
        }
        return count;
      }
    }
    // Fallback: search all sessions for this ws
    for (const [sid, clients] of this._sessionClients) {
      let isMember = false;
      for (const entry of clients) { if (entry.ws === ws) { isMember = true; break; } }
      if (isMember) {
        const data = JSON.stringify(msg);
        let count = 0;
        for (const entry of clients) {
          if (entry.ws !== ws && entry.ws.readyState === 1) {
            try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
          }
        }
        return count;
      }
    }
    return 0;
  }

  /**
   * Broadcast a payload to every WS client that belongs to this agent-loop
   * session. Used by ask_user + plan-mode proposals so the picker card /
   * approve buttons reach the right operator's tabs only.
   *
   * Routing:
   *   'dm:<userId>'               — webapp DM: every WS with ws._user===userId
   *   'shared:dm:web:<userId>'    — same (multi-platform buildKey form)
   *   'channel:web:control-panel' — shared; route to every web creator
   *   '<mode>-<ts>-<rand>' (merge/link/child/wakeup/etc.) — route to operator
   *   acorn session ids           — route via _sessionClients (sessionId keyed)
   */
  _broadcastToSessionKey(sessionKey, payload) {
    if (!sessionKey) return 0;
    const data = JSON.stringify(payload);

    // Acorn + shared-channel path: `_sessionClients` is keyed by bare sessionId
    // (e.g. "abc123"), but the agent-loop sessionKey format wraps it as
    // "channel:abc123" via buildKey(sessionId, isDm=false). Try both keys.
    for (const tryKey of [sessionKey, sessionKey.replace(/^(?:shared:|private:)?channel:(?:[a-z]+:)?/, '')]) {
      const set = this._sessionClients?.get(tryKey);
      if (!set) continue;
      let count = 0;
      for (const entry of set) {
        if (entry.ws.readyState === 1) {
          try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
        }
      }
      if (count) return count;
    }

    // DM path: resolve the userId from the key and match every WS client
    // (all of that user's tabs).
    let targetUser = null;
    const dmMatch = sessionKey.match(/^(?:shared:|private:)?dm:(?:[a-z]+:)?(.+)$/);
    if (dmMatch) targetUser = dmMatch[1];
    else if (/^(merge|link|child|wakeup)[-_]/.test(sessionKey)) targetUser = 'operator';
    if (!targetUser) return 0;
    let count = 0;
    for (const wsClient of this._wss?.clients || []) {
      if (wsClient.readyState !== 1) continue;
      if (wsClient._user === targetUser) {
        try { wsClient.send(data); count++; } catch (e) { this.log.warn('[web] wsClient.send failed: ' + e.message); }
      }
    }
    return count;
  }

  _removeClientFromAllSessions(ws) {
    for (const [sessionId, set] of this._sessionClients) {
      for (const entry of set) {
        if (entry.ws === ws) { set.delete(entry); break; }
      }
      if (set.size === 0) this._sessionClients.delete(sessionId);
    }
  }

  _sendToSession(sessionId, payload) {
    const clients = this._sessionClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const data = JSON.stringify(payload);
    for (const { ws: c } of clients) {
      try { if (c.readyState === 1) c.send(data); } catch (e) { this.log.warn('[web] c.send failed: ' + e.message); }
    }
  }

  _getOriginClient(sessionId) {
    const clients = this._sessionClients.get(sessionId);
    if (!clients) return null;
    for (const entry of clients) {
      if (entry.role === 'origin') return entry.ws;
    }
    return null;
  }

  broadcastBinary(buffer) {
    if (!this._wss) return;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try { client.send(buffer); } catch (e) { this.log.warn('[web] client.send failed: ' + e.message); }
    }
  }

  hasConnectedClients() {
    if (!this._wss) return false;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  _getActiveWebUser() {
    if (!this._wss) return 'operator';
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN && client._user) return client._user;
    }
    return 'operator';
  }

  // hasOperatorConnected — true when at least one connected WS client
  // has a creator/admin role (i.e. the actual instance owner viewing the
  // web panel). Used to gate proactive outreach: webapp guests and
  // acorn CLI sessions don't get unsolicited 'thinking out loud'
  // messages, only the operator does.
  hasOperatorConnected() {
    if (!this._wss) return false;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client._role === 'creator' || client._role === 'admin') return true;
    }
    return false;
  }

  getActiveChannelIds() {
    // Only return the web chat channel when an OPERATOR (creator/admin)
    // is currently viewing it. Without this, the proactive maintainer
    // would also fire when only a webapp guest or an acorn CLI client
    // is connected — which is wrong (proactive thoughts should only
    // ever surface to the instance owner).
    if (!this._wss || !this.hasOperatorConnected()) return [];
    return [{ id: 'web:control-panel', name: 'web chat' }];
  }

  /**
   * Returns active user sessions for use by the webapp_request tool.
   * Filters expired sessions and returns user → sessionId mapping.
   */
  getActiveUserSessions() {
    const results = [];
    const now = Date.now();
    for (const [sid, sess] of this._webSessions) {
      if (now - sess.created >= SESSION_TTL) continue;
      results.push({
        sessionId: sid,
        user: sess.user,
        type: sess.type,
        cookieName: sess.type === 'webapp' ? 'anima_webapp' : 'anima_session',
      });
    }
    return results;
  }

  /**
   * Find a valid session ID for a given username.
   * Prefers creator/admin sessions over webapp sessions.
   */
  getSessionForUser(username) {
    const now = Date.now();
    let best = null;
    const priority = { admin: 3, creator: 2, acorn: 1, webapp: 0 };
    for (const [sid, sess] of this._webSessions) {
      if (now - sess.created >= SESSION_TTL) continue;
      if (sess.user !== username) continue;
      if (!best || (priority[sess.type] || 0) > (priority[best.type] || 0)) {
        best = { sessionId: sid, user: sess.user, type: sess.type, cookieName: sess.type === 'webapp' ? 'anima_webapp' : 'anima_session' };
      }
    }
    return best;
  }

  /** Returns info about the hosted webapp (if any) for prompt context. */
  getWebappStatus() {
    if (!this._server) return null;
    const port = this.config.webPort;
    const hasBackend = !!this._backendChild;
    return {
      active: true,
      port,
      hasBackend,
      users: this.getActiveUserSessions().map(s => ({ user: s.user, type: s.type })),
    };
  }

  injectProactivePrompt(channelId, context, topic) {
    // Gate: ONLY fire when an operator (creator/admin) is viewing the
    // web panel. Webapp guests and acorn CLI sessions should never
    // see unsolicited proactive thoughts. This also stops the agent
    // from talking to itself when nobody's watching.
    if (!this._wss || !this.hasOperatorConnected()) {
      this.log.debug('[proactive:web] No operator connected, skipping');
      return;
    }

    const agent = this.tools?._agent;
    if (!agent) {
      this.log.debug('[proactive:web] Agent not available, skipping');
      return;
    }

    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;
    const sessionId = channelId || 'web:control-panel';
    const activeUser = this._getActiveWebUser();

    if (!this._proactiveQueue) this._proactiveQueue = Promise.resolve();
    this._proactiveQueue = this._proactiveQueue.then(async () => {
      try {
        // Route every stream event to the target session ONLY, not to
        // every connected WS client. Previously the deltas were
        // broadcast() which leaked them into acorn (and any other
        // viewer of any session) — visible as a stray 'NO_REPLY'
        // bubble in the CLI even though the prompt was never posted
        // to the cli session.
        this._sendToSession(sessionId, { type: 'chat:start', sessionId });
        const result = await agent.processMessage({
          content: prompt,
          channelId: sessionId,
          channelName: 'control-panel',
          userId: activeUser,
          userName: 'System',
          trigger: 'proactive',
          platform: 'web',
          isDm: true,
          onTextDelta: (delta) => {
            this._sendToSession(sessionId, { type: 'chat:delta', text: delta });
          },
          onThinkingDelta: (delta) => {
            this._sendToSession(sessionId, { type: 'chat:thinking', text: delta });
          },
          onToolUse: (toolName, toolInput) => {
            this._sendToSession(sessionId, { type: 'chat:tool', tool: toolName, input: toolInput });
          },
          onStatus: (evt) => {
            try {
              if (evt.type?.startsWith('code:')) {
                this._sendToSession(sessionId, evt);
              } else {
                const { type: statusType, ...rest } = evt;
                this._sendToSession(sessionId, { type: 'chat:status', status: statusType, ...rest });
              }
            } catch (e) { this.log.warn('[web] startsWith failed: ' + e.message); }
          },
        });

        const text = result?.text;
        if (!text || text.trim() === 'NO_REPLY' || text.includes('NO_REPLY')) {
          this._sendToSession(sessionId, { type: 'chat:done', text: '' });
          this.log.info('[proactive:web] Agent chose NO_REPLY');
          // Clean up: remove the synthetic prompt from the session DB
          // too, so a refresh doesn't replay [proactive thought: ...]
          // followed by an awkward NO_REPLY pair. The operator never
          // saw the conversation; pretend it didn't happen.
          try {
            const sk = this.tools?._sessions?.constructor?.buildKey?.(sessionId, true, activeUser);
            if (sk) {
              this.tools._sessions.removeLastUserMessage(sk);
              this.tools._sessions.removeLastAssistantNoReply?.(sk);
            }
          } catch (e) {
            this.log.debug(`[proactive:web] cleanup failed: ${e.message}`);
          }
        } else {
          this._sendToSession(sessionId, {
            type: 'chat:done',
            text,
            usage: result.usage,
            iterations: result.iterations,
            toolUsage: result.toolUsage,
          });
          this.log.info(`[proactive:web] Delivered proactive message (${(text || '').length} chars)`);

          try {
            const feed = require('../graph/feed');
            feed.log({
              channelName: 'web:proactive',
              userName: 'System',
              userMessage: prompt,
              myResponse: text,
              trigger: 'proactive',
              usage: result.usage,
              iterations: result.iterations,
            });
          } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
        }
      } catch (e) {
        this.log.warn(`[proactive:web] Failed: ${e.message}`);
        this.broadcast({ type: 'chat:done', text: '' });
      }
    }).catch(e => {
      this.log.warn(`[proactive:web] Queue error: ${e.message}`);
    });
  }

  async _isOAuthEnabled() {
    if (Date.now() - (this._oauthCheckedAt || 0) < 300_000) return this._oauthEnabled || false;
    if (!this.config.managerUrl) return false;
    try {
      const resp = await fetch(`${this.config.managerUrl}/api/auth/google/status`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      this._oauthEnabled = !!data.enabled;
    } catch {
      if (this._oauthEnabled === undefined) this._oauthEnabled = false;
    }
    this._oauthCheckedAt = Date.now();
    return this._oauthEnabled;
  }

  async handleHttp(req, res) {
    return false;
  }

  // ── Status / Stop ──────────────────────────────────────────────────

  _status() {
    const webPort = this.config.webPort;
    let pub = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pub && this.config.ingressDomain) {
      const iP = (this.config.ingressPath || '').replace(/\/$/, '');
      const pr = this.config.ingressHttps ? 'https' : 'http';
      pub = `${pr}://${this.config.ingressDomain}${iP}`;
    }
    if (this._server) {
      const result = { running: true, port: webPort, dir: this._serverDir, url: pub ? `${pub}/` : `http://localhost:${webPort}/`, graphEditor: pub ? `${pub}/graph` : `http://localhost:${webPort}/graph`, publicUrl: pub || null };
      if (this._backendChild) {
        result.backend = { running: true, port: this._backendPort, pid: this._backendChild.pid };
      }
      return result;
    }
    return { running: false, port: webPort || null, note: webPort ? 'Server is not running. Use action:start to launch it.' : 'No web port configured. Set SPORE_WEB_PORT and re-deploy.' };
  }

  _stop() {
    this._stopBackendProcess();
    try { fs.unlinkSync(path.join(this.config.dataDir, '.backend-config.json')); } catch { /* silent: best-effort cleanup */ }
    if (!this._server) return { stopped: false, note: 'Server was not running.' };
    if (this._wss) { this._wss.close(); this._wss = null; }
    this._server.close();
    this._server = null;
    this._serverDir = null;
    this.log.info('[web_serve] Server stopped');
    return { stopped: true };
  }

  // ── Backend Process Management ─────────────────────────────────────

  _stopBackendProcess() {
    if (this._backendChild) {
      try { process.kill(-this._backendChild.pid, 'SIGTERM'); } catch { /* silent: best-effort terminate */ }
      try { this._backendChild.kill('SIGTERM'); } catch (e) { this.log.warn('[web] this._backendChild.kill failed: ' + e.message); }
      this._backendChild = null;
      this._backendPort = null;
      this.log.info('[web_serve] Backend process killed');
    }
    // Also kill anything on the .app-port
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try {
      const port = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10);
      if (port > 0) this._killProcessOnPort(port);
      fs.unlinkSync(appPortFile);
    } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
  }

  _killProcessOnPort(port) {
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          const p = parseInt(pid.trim(), 10);
          if (p > 0 && p !== process.pid) {
            try { process.kill(p, 'SIGTERM'); } catch { /* silent: best-effort terminate */ }
          }
        }
      }
    } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
  }

  _allocateBackendPort() {
    const webPort = this.config.webPort || 18815;
    return webPort + 100;
  }

  _fetchVaultKeys() {
    const managerUrl = this.config.managerUrl || 'http://spore-manager:18900';
    const serviceKey = this.config.managerServiceKey || '';
    const agentId = this.config.agentId || 'unknown';
    const env = {};
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-SPORE-Id: ${agentId}" "${managerUrl}/api/vault/keys" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const rawKeys = JSON.parse(result).keys || [];
      const keyNames = rawKeys.map(k => typeof k === 'string' ? k : k.name).filter(Boolean);
      for (const keyName of keyNames) {
        try {
          const val = execSync(
            `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-SPORE-Id: ${agentId}" "${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}" 2>/dev/null`,
            { encoding: 'utf8', timeout: 5000 }
          );
          const parsed = JSON.parse(val);
          if (parsed.value) env[keyName] = parsed.value;
        } catch (e) { this.log.warn('[web] execSync failed: ' + e.message); }
      }
    } catch (e) {
      this.log.warn(`[backend] Failed to fetch vault keys: ${e.message}`);
    }
    return env;
  }

  _startWithBackend(dir, { command, commandDir } = {}) {
    if (!command) return { error: 'command is required for action:"backend". Provide the command to start your backend (e.g. "node server.js").' };

    // Start the web server for static files
    const startResult = this._start(dir);
    if (startResult.error) return startResult;

    const serveDir = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    const backendPort = this._allocateBackendPort();
    const workDir = commandDir || serveDir;

    // Kill any stale backend
    this._stopBackendProcess();
    this._killProcessOnPort(backendPort);

    // Write .app-port before spawning so the proxy is ready
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try { fs.writeFileSync(appPortFile, String(backendPort)); } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    // Auto-inject vault keys into the backend process env
    const vaultKeys = this._fetchVaultKeys();
    const vaultKeyNames = Object.keys(vaultKeys);

    // Build env: base process env + allocated port + vault keys
    const { spawn } = require('child_process');
    const SENSITIVE_RE = /KEY|TOKEN|SECRET|PASS|CREDENTIALS|AUTH/i;
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!SENSITIVE_RE.test(k)) baseEnv[k] = v;
    }
    const env = {
      ...baseEnv,
      APP_PORT: String(backendPort),
      PORT: String(backendPort),
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...vaultKeys,
    };

    const child = spawn('sh', ['-c', command], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const childPid = child.pid;
    let lastStdout = '';
    let lastStderr = '';
    child.stdout?.on('data', (d) => {
      lastStdout = d.toString().slice(-500);
      this.log.debug(`[backend:stdout] ${lastStdout.trim()}`);
    });
    child.stderr?.on('data', (d) => {
      lastStderr = d.toString().slice(-500);
      this.log.debug(`[backend:stderr] ${lastStderr.trim()}`);
    });

    child.on('exit', (code, signal) => {
      if (this._backendChild === child) {
        this.log.warn(`[backend] Process exited unexpectedly: code=${code} signal=${signal}`);
        this._backendChild = null;
        this._backendPort = null;
      }
    });

    child.unref();
    this._backendChild = child;
    this._backendPort = backendPort;

    // Register with global process tracker if available
    if (this._tools?._trackedPids) this._tools._trackedPids.add(child.pid);

    // Persist backend config so it auto-restores on container restart
    try {
      fs.writeFileSync(path.join(this.config.dataDir, '.backend-config.json'), JSON.stringify({
        dir: serveDir, command, commandDir: workDir,
      }));
    } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    let pubUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pubUrl && this.config.ingressDomain) {
      const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
      const proto = this.config.ingressHttps ? 'https' : 'http';
      pubUrl = `${proto}://${this.config.ingressDomain}${iPath}`;
    }
    const displayUrl = pubUrl || `http://localhost:${this.config.webPort}`;

    this.log.info(`[backend] Started (pid=${childPid}, port=${backendPort}), ${vaultKeyNames.length} vault key(s) injected${vaultKeyNames.length ? ': ' + vaultKeyNames.join(', ') : ''}`);

    return {
      started: true,
      port: this.config.webPort,
      backendPort,
      pid: childPid,
      dir: serveDir,
      commandDir: workDir,
      command,
      url: `${displayUrl}/`,
      publicUrl: pubUrl || null,
      vaultKeysInjected: vaultKeyNames,
      routing: {
        note: 'Traefik strips the path prefix before requests reach your server. Your backend sees paths relative to root.',
        externalBase: pubUrl || displayUrl,
        internalBackendPort: backendPort,
        frontendFetchPattern: `Your frontend HTML is served under ${displayUrl}/. Use RELATIVE fetch paths: fetch('api/generate') or fetch('./api/generate'). The web server proxies /api/* to your backend. For non-/api/ routes, any path that doesn't match a static file is also proxied to the backend.`,
        backendRoutes: `Your backend receives requests with the prefix ALREADY STRIPPED. If your HTML is at ${displayUrl}/myapp/, the backend sees /myapp/endpoint. Match routes like: /myapp/endpoint or /api/endpoint.`,
        vaultKeys: vaultKeyNames.length ? `These vault keys were auto-injected as env vars in your backend process: ${vaultKeyNames.join(', ')}. Access them with process.env.KEY_NAME — no need to use vault_get.` : 'No vault keys found. Add keys via the manager vault UI.',
      },
    };
  }

  // ── Start (HTTP server + all routes) ───────────────────────────────

  _start(dir) {
    const webPort = this.config.webPort;
    if (!webPort) return { error: 'No web port configured. Set SPORE_WEB_PORT in .env and re-deploy the container.' };
    const serveDir_ = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    if (this._server) {
      if (this._serverDir === serveDir_) {
        this.log.info('[web_serve] Server already running for same dir, keeping connections alive');
        return { running: true, port: webPort, dir: this._serverDir, note: 'Server already active — kept existing connections.' };
      }
      if (this._wss) { this._wss.close(); this._wss = null; }
      this._server.close();
      this._server = null;
    }

    const serveDir = dir || path.join(this.config.workspacePath || process.cwd(), 'web');
    try { fs.mkdirSync(serveDir, { recursive: true }); } catch (e) { this.log.warn('[web] fs.mkdirSync failed: ' + e.message); }

    const indexPath = path.join(serveDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const name = this.config.displayName || this.config.agentId || 'SPORE';
      fs.writeFileSync(indexPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif}h1{font-size:2.5rem;opacity:.8}</style></head><body><h1>${name}</h1></body></html>`);
    }

    const MIME = {
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
      '.woff2': 'font/woff2', '.woff': 'font/woff',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.webp': 'image/webp', '.avif': 'image/avif',
      '.pdf': 'application/pdf',
      '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
    };

    function parseMultipart(buf, boundary, destDir, maxFileSize) {
      const sep = Buffer.from('--' + boundary);
      const saved = [];
      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const next = buf.indexOf(sep, start + sep.length);
        if (next === -1) break;
        const part = buf.slice(start + sep.length, next);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { pos = next; continue; }
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        if (!fnMatch) { pos = next; continue; }
        let fileName = fnMatch[1].replace(/[/\\]/g, '_').replace(/\.\./g, '');
        if (!fileName) { pos = next; continue; }
        let body = part.slice(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
          body = body.slice(0, body.length - 2);
        }
        if (body.length > maxFileSize) throw new Error(`File "${fileName}" exceeds size limit`);
        const dest = path.join(destDir, fileName);
        if (!dest.startsWith(destDir)) throw new Error('Invalid path');
        fs.writeFileSync(dest, body);
        saved.push(fileName);
        pos = next;
      }
      return saved;
    }

    const authUser = this.config.webAuthUser;
    const authPass = this.config.webAuthPass;
    const graphDb = this.graph?.db;

    const _sessions = this._webSessions;

    const _loginAttempts = new Map();
    const LOGIN_MAX_ATTEMPTS = 5;
    const LOGIN_WINDOW_MS = 15 * 60 * 1000;

    const _checkLoginRate = (req) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = _loginAttempts.get(ip);
      if (entry) {
        entry.attempts = entry.attempts.filter(t => now - t < LOGIN_WINDOW_MS);
        if (entry.attempts.length >= LOGIN_MAX_ATTEMPTS) return false;
      }
      return true;
    };

    const _recordLoginAttempt = (req) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      if (!_loginAttempts.has(ip)) _loginAttempts.set(ip, { attempts: [] });
      _loginAttempts.get(ip).attempts.push(Date.now());
    };

    const _sessionSweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, sess] of _sessions) {
        if (now - sess.created >= SESSION_TTL) _sessions.delete(sid);
      }
      for (const [ip, entry] of _loginAttempts) {
        entry.attempts = entry.attempts.filter(t => now - t < LOGIN_WINDOW_MS);
        if (entry.attempts.length === 0) _loginAttempts.delete(ip);
      }
    }, 60 * 60 * 1000);
    _sessionSweepInterval.unref();

    const parseCookies = (req) => {
      const obj = {};
      (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
      });
      return obj;
    };

    const managerUrl = process.env.MANAGER_URL;
    const managerKey = process.env.MANAGER_SERVICE_KEY;
    const animaId = this.config.agentId;

    const tryManagerSSO = async (req, res, { webappOnly = false } = {}) => {
      if (!managerUrl || !managerKey) return false;
      const cookies = parseCookies(req);
      const mgrToken = cookies['manager_session'];
      if (!mgrToken) return false;
      try {
        const http_ = require('http');
        const payload = JSON.stringify({ token: mgrToken, animaId, webappOnly });
        const url = new URL(managerUrl + '/api/auth/verify-session');
        const result = await new Promise((resolve, reject) => {
          const r = http_.request({
            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': managerKey, 'Content-Length': Buffer.byteLength(payload) },
            timeout: 3000,
          }, (resp) => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
          });
          r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end(payload);
        });
        if (result.ok && result.username) {
          const sid = crypto.randomBytes(32).toString('hex');
          if (webappOnly) {
            _sessions.set(sid, { type: 'webapp', created: Date.now(), user: result.username, viaSSO: true });
            const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
            res.setHeader('Set-Cookie', `anima_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
            return 'webapp';
          }
          const mgrRole = result.role === 'super' ? 'admin' : 'creator';
          _sessions.set(sid, { type: mgrRole, created: Date.now(), user: result.username, viaSSO: true });
          const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
          res.setHeader('Set-Cookie', `anima_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
          return mgrRole;
        }
      } catch (err) {
        this.log.warn(`[webapp-gate] SSO verify failed: ${err.message}`);
      }
      return false;
    };

    const checkCreatorAuth = (req, res) => {
      if (managerKey && req.headers['x-service-key'] === managerKey) return true;
      const cookies = parseCookies(req);
      const sid = cookies['anima_session'];
      if (sid && _sessions.has(sid)) {
        const sess = _sessions.get(sid);
        if ((sess.type === 'creator' || sess.type === 'admin') && Date.now() - sess.created < SESSION_TTL) {
          if (sess.viaSSO && !cookies['manager_session']) {
            _sessions.delete(sid);
            return false;
          }
          return true;
        }
        if (sess.type === 'creator' || sess.type === 'admin') _sessions.delete(sid);
      }
      // Also accept an anima_webapp session whose user record is role=creator
      // (covers the case where a browser has the webapp-cookie naming scheme
      // but the user was created as a creator during onboarding).
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (sess && Date.now() - sess.created < SESSION_TTL && sess.user) {
          const wu = loadWebappUsers().find(u => u.username === sess.user);
          if (wu && (wu.role === 'creator' || wu.role === 'admin')) return true;
        }
      }
      if (authUser && authPass) {
        const authHeader = req.headers.authorization || '';
        if (authHeader.startsWith('Basic ')) {
          const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
          const [u, ...pParts] = decoded.split(':');
          if (u === authUser && pParts.join(':') === authPass) return true;
        }
      }
      return false;
    };

    const checkCreatorAuthAsync = async (req, res) => {
      if (checkCreatorAuth(req, res)) return true;
      if (await tryManagerSSO(req, res)) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Creator authentication required' }));
      return false;
    };
    const checkAuth = (req, res) => checkCreatorAuthAsync(req, res);

    const WEBAPP_USERS_PATH = path.join(this.config.dataDir, 'webapp-users.json');
    const loadWebappUsers = () => {
      try { return JSON.parse(fs.readFileSync(WEBAPP_USERS_PATH, 'utf8')); } catch { return []; }
    };
    const verifyWebappPassword = (password, salt, storedHash) => {
      const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      if (computed.length !== storedHash.length) return false;
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
    };

    const checkWebappAuthSync = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['anima_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.type === 'creator' && Date.now() - sess.created < SESSION_TTL) return true;
      }
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (sess.type === 'webapp' && Date.now() - sess.created < SESSION_TTL) return true;
        if (sess.type === 'webapp') _sessions.delete(wsid);
      }
      return false;
    };

    const checkWebappAuth = async (req, res) => {
      if (checkWebappAuthSync(req)) return true;
      if (await tryManagerSSO(req, res)) return true;
      const wUsers = loadWebappUsers();
      const needsCreatorAuth = !!(managerUrl || (authUser && authPass));
      if (wUsers.length === 0 && !needsCreatorAuth) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    };

    const isAnyAuth = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['anima_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.viaSSO && !cookies['manager_session']) { _sessions.delete(csid); }
        else if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      const wsid = cookies['anima_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      return null;
    };

    const getSessionFromReq = (req) => {
      const cookies = parseCookies(req);
      const sid = cookies['anima_session'];
      const wsid = cookies['anima_webapp'];
      const sidValid = sid && _sessions.has(sid);
      const wsidValid = wsid && _sessions.has(wsid);
      // When both cookies exist and both are valid, prefer whichever was created
      // more recently. This prevents a stale creator cookie from shadowing a
      // fresh webapp login (or vice versa) when both browsers/tabs share a
      // cookie jar.
      if (sidValid && wsidValid) {
        const sCreated = _sessions.get(sid)?.created || 0;
        const wCreated = _sessions.get(wsid)?.created || 0;
        return wCreated >= sCreated ? wsid : sid;
      }
      if (sidValid) return sid;
      if (wsidValid) return wsid;
      return null;
    };

    const server = http.createServer(async (req, res) => {
      const urlPath = req.url.split('?')[0];

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      if (req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      const origin = req.headers.origin || '';
      let isTrustedOrigin = false;
      try {
        if (origin) {
          const oh = new URL(origin).hostname;
          isTrustedOrigin = oh === 'localhost' || oh === '127.0.0.1' || oh === '::1';
        }
      } catch (e) { this.log.warn('[web] URL failed: ' + e.message); }
      const ingressDomain = this.config.ingressDomain;
      let matchesIngress = false;
      if (ingressDomain && origin) {
        try { matchesIngress = new URL(origin).hostname === ingressDomain; } catch (e) { this.log.warn('[web] URL failed: ' + e.message); }
      }
      const allowedOrigin = (isTrustedOrigin || matchesIngress) ? origin : '';
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Creator auth endpoints (graph viewer SSO via manager) ──
      if (urlPath === '/api/auth/login' && req.method === 'POST') {
        if (!_checkLoginRate(req)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
          return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          try {
            _recordLoginAttempt(req);
            const { username, password } = JSON.parse(body);
            const serviceKey = managerKey;
            let verified = false;
            let verifiedUser = username;

            if (managerUrl && serviceKey) {
              try {
                const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
                const payload = JSON.stringify({ username, password, animaId });
                const result = await new Promise((resolve, reject) => {
                  const url = new URL(managerUrl + '/api/auth/verify-access');
                  const opts = {
                    method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
                    headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey, 'Content-Length': Buffer.byteLength(payload) },
                    timeout: 5000
                  };
                  const r = http_.request(opts, (resp) => {
                    let d = ''; resp.on('data', c => d += c);
                    resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); } catch { reject(new Error('Bad response')); } });
                  });
                  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
                  r.write(payload); r.end();
                });
                if (result.status === 200 && result.body.ok) {
                  verified = true;
                  verifiedUser = result.body.username || username;
                  req._mgrRole = result.body.role;
                } else {
                  res.writeHead(result.status || 401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: result.body?.error || 'Invalid credentials' })); return;
                }
              } catch (e) {
                this.log.warn('[web] Manager SSO unreachable, falling back to local auth:', e.message);
                // Prefer webapp-users.json local record (populated by the
                // onboarding wizard) when the manager is down.
                const wu = loadWebappUsers().find(u => u.username === username);
                if (wu && !wu.blocked && verifyWebappPassword(password, wu.salt, wu.hash)) {
                  verified = true;
                  verifiedUser = username;
                  if (wu.role === 'webapp') req._loginRoleHint = 'webapp';
                } else if (authUser && authPass && username === authUser && password === authPass) {
                  verified = true;
                } else {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
                }
              }
            } else if (authUser && authPass && username === authUser && password === authPass) {
              verified = true;
            } else {
              // Local webapp-users.json (populated by the onboarding wizard or
              // self-registered via /api/webapp/users/self-register).
              const webappUsers = loadWebappUsers();
              const wu = webappUsers.find(u => u.username === username);
              if (wu && wu.blocked) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Your account has been blocked. Contact the operator.' })); return;
              }
              if (wu && verifyWebappPassword(password, wu.salt, wu.hash)) {
                verified = true;
                verifiedUser = username;
                // Honor stored role: creator → loginRole 'creator', webapp → 'webapp'.
                if (wu.role === 'webapp') req._loginRoleHint = 'webapp';
              } else if (authUser && authPass) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
              } else if (webappUsers.length === 0) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Auth not configured' })); return;
              } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
              }
            }

            if (verified) {
              const sid = crypto.randomBytes(32).toString('hex');
              let loginRole;
              if (req._loginRoleHint === 'webapp') loginRole = 'webapp';
              else loginRole = req._mgrRole === 'super' ? 'admin' : 'creator';
              const cookieName = loginRole === 'webapp' ? 'anima_webapp' : 'anima_session';
              _sessions.set(sid, { user: verifiedUser, created: Date.now(), type: loginRole });
              const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
              // Webapp users haven't run the user wizard yet → flag it.
              let wizardNeeded = false;
              if (loginRole === 'webapp') {
                try {
                  const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
                  wizardNeeded = !prefs[verifiedUser]?.wizardCompleted;
                } catch { wizardNeeded = true; }
              }
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
              });
              res.end(JSON.stringify({ ok: true, user: verifiedUser, role: loginRole, wizardNeeded }));
            }
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/auth/logout' && req.method === 'POST') {
        const sid = getSessionFromReq(req);
        if (sid) _sessions.delete(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'anima_session=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/auth/check') {
        let valid = false;
        let role = null;
        let username = null;
        const cookies = parseCookies(req);
        const sid = cookies['anima_session'];
        const sess = sid && _sessions.get(sid);
        if (sess && (sess.type === 'creator' || sess.type === 'admin') && (Date.now() - sess.created < SESSION_TTL)) {
          valid = true;
          role = sess.type;
          username = sess.user || null;
        }
        if (!valid) {
          const wsid = cookies['anima_webapp'];
          const wsess = wsid && _sessions.get(wsid);
          if (wsess && wsess.type === 'webapp' && (Date.now() - wsess.created < SESSION_TTL)) {
            valid = true;
            role = 'webapp';
            username = wsess.user || null;
          }
        }
        if (!valid) {
          const ssoRole = await tryManagerSSO(req, res);
          if (ssoRole) { valid = true; role = ssoRole; }
        }
        const hasWebappUsers = loadWebappUsers().length > 0;
        const needsAuth = !!(managerUrl || (authUser && authPass));
        // wizardNeeded: true if the authenticated user hasn't completed the
        // per-user onboarding wizard yet. Drives the slim post-login wizard
        // that the SPA runs when a fresh webapp user first lands on /graph.
        let wizardNeeded = false;
        if (valid && username && (role === 'webapp' || role === 'creator')) {
          try {
            const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
            wizardNeeded = !prefs[username]?.wizardCompleted;
          } catch { wizardNeeded = role === 'webapp'; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: valid, needsAuth, role, hasWebappUsers, username, wizardNeeded }));
        return;
      }

      // ── Webapp user auth endpoints ──
      if (urlPath === '/api/webapp/login' && req.method === 'POST') {
        if (!_checkLoginRate(req)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
          return;
        }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          _recordLoginAttempt(req);
          try {
            const { username, password } = JSON.parse(body);
            const users = loadWebappUsers();
            if (users.length === 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, user: 'guest', noAuth: true })); return;
            }
            const user = users.find(u => u.username === username);
            if (user?.blocked) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Your account has been blocked. Contact the operator.' })); return;
            }
            if (!user || !verifyWebappPassword(password, user.salt, user.hash)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
            }
            const sid = crypto.randomBytes(32).toString('hex');
            const role = user.role === 'creator' ? 'creator' : 'webapp';
            const cookieName = role === 'creator' ? 'anima_session' : 'anima_webapp';
            const otherCookieName = cookieName === 'anima_session' ? 'anima_webapp' : 'anima_session';
            // Invalidate any lingering session under the other cookie so a user
            // logging in as webapp can't inherit a previous creator identity
            // (which would route chats into the wrong dm:<user> session and
            // show the other user's history).
            const otherCookies = parseCookies(req);
            const otherSid = otherCookies[otherCookieName];
            if (otherSid && _sessions.has(otherSid)) _sessions.delete(otherSid);
            _sessions.set(sid, { user: username, created: Date.now(), type: role });
            const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': [
                `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
                `${otherCookieName}=; Path=/; HttpOnly; Max-Age=0`,
              ],
            });
            res.end(JSON.stringify({ ok: true, user: username, role }));
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/webapp/logout' && req.method === 'POST') {
        const cookies = parseCookies(req);
        const wsid = cookies['anima_webapp'];
        if (wsid && _sessions.has(wsid)) _sessions.delete(wsid);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'anima_webapp=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/webapp/check') {
        const wUsers = loadWebappUsers();
        let authType = isAnyAuth(req);
        if (!authType && await tryManagerSSO(req, res)) authType = 'creator';
        const needsAuth = wUsers.length > 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: !!authType, needsAuth, userType: authType }));
        return;
      }

      // ── First-run onboarding ──
      if (urlPath === '/api/onboarding/state' && req.method === 'GET') {
        const needed = _isOnboardingNeeded(this.config.dataDir, this.config);
        const hasWebappUsers = loadWebappUsers().length > 0;
        const s = this._getSettingsState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          needed,
          hasWebappUsers,
          currentState: {
            identity: s.identity,
            providers: {
              anthropic: { apiKeySet: s.providers.anthropic.apiKeySet },
              openai: { apiKeySet: s.providers.openai.apiKeySet, baseUrl: s.providers.openai.baseUrl },
              openrouter: { apiKeySet: s.providers.openrouter.apiKeySet, baseUrl: s.providers.openrouter.baseUrl },
              local: { apiKeySet: s.providers.local.apiKeySet, baseUrl: s.providers.local.baseUrl },
              gemini: { apiKeySet: s.providers.gemini.apiKeySet },
              custom: s.providers.custom.map(p => ({ name: p.name, url: p.url })),
            },
            models: s.models,
            voice: s.voice,
            webSearch: { searxngUrl: s.webSearch?.searxngUrl || '', braveApiKeySet: !!s.webSearch?.braveApiKeySet },
            browser: s.browser,
          },
        }));
        return;
      }

      if (urlPath === '/api/webapp/users' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const username = String(parsed.username || '').trim();
        const password = String(parsed.password || '');
        if (!username || username.length > 64) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Username must be 1–64 chars' })); return; }
        if (password.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Password must be at least 8 characters' })); return; }
        const existing = loadWebappUsers();
        const onboardingDone = !_isOnboardingNeeded(this.config.dataDir, this.config);
        const isAdmin = !!isAnyAuth(req);
        // Allow user creation when: onboarding still pending (zero users), OR caller is an admin.
        if (existing.length > 0 && onboardingDone && !isAdmin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User creation disabled post-setup' }));
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        // During onboarding, account creation is idempotent: the operator can
        // restart the wizard at any time and re-submit credentials. The user
        // list is reset to just this account. After onboarding completes,
        // duplicate usernames are rejected.
        let next;
        if (!onboardingDone) {
          next = [{ username, hash, salt, created: Date.now(), role: 'creator' }];
        } else {
          if (existing.some(u => u.username === username)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User already exists' })); return;
          }
          next = existing.concat([{ username, hash, salt, created: Date.now(), role: 'webapp' }]);
        }
        _writeJsonAtomic(WEBAPP_USERS_PATH, next);
        const isFirstUser = !onboardingDone;
        const sid = crypto.randomBytes(32).toString('hex');
        const sessType = isFirstUser ? 'creator' : 'webapp';
        const cookieName = isFirstUser ? 'anima_session' : 'anima_webapp';
        const otherCookieName = cookieName === 'anima_session' ? 'anima_webapp' : 'anima_session';
        const otherCookies = parseCookies(req);
        const otherSid = otherCookies[otherCookieName];
        if (otherSid && _sessions.has(otherSid)) _sessions.delete(otherSid);
        _sessions.set(sid, { user: username, created: Date.now(), type: sessType });
        const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            `${otherCookieName}=; Path=/; HttpOnly; Max-Age=0`,
          ],
        });
        res.end(JSON.stringify({ ok: true, user: username, role: sessType }));
        return;
      }

      // Self-register: anyone with the Acorn team key can create a webapp user
      // without operator intervention. Always issues a 'webapp' role session
      // (never creator), regardless of how many users exist.
      if (urlPath === '/api/webapp/users/self-register' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const username = String(parsed.username || '').trim();
        const password = String(parsed.password || '');
        const acornKey = String(parsed.acornKey || '').trim();
        if (!this.config.acornKey) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Self-registration is not enabled on this instance.' })); return;
        }
        if (!username || username.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(username)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username must be 1\u201364 chars, alphanumeric/_.-' })); return;
        }
        if (password.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Password must be at least 8 characters' })); return;
        }
        if (!_acornKeyMatches(acornKey, this.config.acornKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid team key' })); return;
        }
        const existing = loadWebappUsers();
        const dup = existing.find(u => u.username === username);
        if (dup?.blocked) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'That username is blocked.' })); return;
        }
        if (dup) {
          // If creds match the existing record (i.e. an interrupted self-reg
          // where the user is retrying with the same password) just hand them
          // a fresh session + wizard. If the password is wrong, 409.
          if (!verifyWebappPassword(password, dup.salt, dup.hash)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Username already taken' })); return;
          }
          const sid = crypto.randomBytes(32).toString('hex');
          const otherCookies = parseCookies(req);
          if (otherCookies['anima_session'] && _sessions.has(otherCookies['anima_session'])) _sessions.delete(otherCookies['anima_session']);
          _sessions.set(sid, { user: username, created: Date.now(), type: 'webapp' });
          const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [
              `anima_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
              `anima_session=; Path=/; HttpOnly; Max-Age=0`,
            ],
          });
          // Re-show wizard only if it wasn't already completed.
          let wizardNeeded = true;
          try {
            const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
            if (prefs[username]?.wizardCompleted) wizardNeeded = false;
          } catch { /* silent: malformed JSON → fallback */ }
          res.end(JSON.stringify({ ok: true, user: username, role: 'webapp', wizardNeeded, resumed: true }));
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        existing.push({ username, hash, salt, created: Date.now(), role: 'webapp', selfRegistered: true });
        _writeJsonAtomic(WEBAPP_USERS_PATH, existing);
        const sid = crypto.randomBytes(32).toString('hex');
        const otherCookies = parseCookies(req);
        if (otherCookies['anima_session'] && _sessions.has(otherCookies['anima_session'])) _sessions.delete(otherCookies['anima_session']);
        _sessions.set(sid, { user: username, created: Date.now(), type: 'webapp' });
        const secure = process.env.SPORE_INSECURE_COOKIES === 'true' ? '' : '; Secure';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            `anima_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            `anima_session=; Path=/; HttpOnly; Max-Age=0`,
          ],
        });
        res.end(JSON.stringify({ ok: true, user: username, role: 'webapp', wizardNeeded: true }));
        return;
      }

      // ── Admin user-management endpoints (creator-only) ──
      if (urlPath === '/api/webapp/users' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const users = loadWebappUsers().map(u => ({
          username: u.username,
          role: u.role || 'webapp',
          blocked: !!u.blocked,
          selfRegistered: !!u.selfRegistered,
          created: u.created || null,
          passwordUpdatedAt: u.passwordUpdatedAt || null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ users }));
        return;
      }

      if (urlPath.startsWith('/api/webapp/users/') && (req.method === 'PATCH' || req.method === 'DELETE')) {
        if (!(await checkAuth(req, res))) return;
        // Find requesting user (so we can prevent self-demotion / self-delete).
        const cookies = parseCookies(req);
        const sid = cookies['anima_session'];
        const sess = sid && _sessions.get(sid);
        const meUsername = sess?.user || null;
        const target = decodeURIComponent(urlPath.slice('/api/webapp/users/'.length));
        if (target === 'me') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Reserved' })); return; }
        if (target === meUsername) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'You can\u2019t modify your own account here.' })); return; }
        const users = loadWebappUsers();
        const idx = users.findIndex(u => u.username === target);
        if (idx < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No such user' })); return; }

        if (req.method === 'DELETE') {
          // Refuse to delete the last creator.
          if ((users[idx].role || 'webapp') === 'creator') {
            const creatorCount = users.filter(u => (u.role || 'webapp') === 'creator').length;
            if (creatorCount <= 1) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cannot delete the only creator account' })); return; }
          }
          users.splice(idx, 1);
          _writeJsonAtomic(WEBAPP_USERS_PATH, users);
          // Drop any active session for the deleted user.
          for (const [k, v] of _sessions) { if (v?.user === target) _sessions.delete(k); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // PATCH: { role?: 'creator'|'webapp', blocked?: boolean }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const allowedRoles = ['creator', 'webapp'];
        if (Object.prototype.hasOwnProperty.call(parsed, 'role')) {
          if (!allowedRoles.includes(parsed.role)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'role must be creator or webapp' })); return; }
          // Refuse to demote the last creator.
          if ((users[idx].role || 'webapp') === 'creator' && parsed.role !== 'creator') {
            const creatorCount = users.filter(u => (u.role || 'webapp') === 'creator').length;
            if (creatorCount <= 1) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cannot demote the only creator account' })); return; }
          }
          users[idx].role = parsed.role;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, 'blocked')) {
          users[idx].blocked = !!parsed.blocked;
          if (users[idx].blocked) {
            for (const [k, v] of _sessions) { if (v?.user === target) _sessions.delete(k); }
          }
        }
        _writeJsonAtomic(WEBAPP_USERS_PATH, users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { username: users[idx].username, role: users[idx].role, blocked: !!users[idx].blocked } }));
        return;
      }

      // Webapp user changes their own password (any-auth — uses session cookie to identify user)
      if (urlPath === '/api/webapp/users/me/password' && req.method === 'POST') {
        const sessType = isAnyAuth(req);
        if (!sessType) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Authentication required"}'); return; }
        const cookies = parseCookies(req);
        const sid = cookies['anima_session'] || cookies['anima_webapp'];
        const sess = sid && _sessions.get(sid);
        if (!sess?.user) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"No session user"}'); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const currentPassword = String(parsed.currentPassword || '');
        const newPassword = String(parsed.newPassword || '');
        if (newPassword.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'New password must be at least 8 characters' })); return; }
        const users = loadWebappUsers();
        const idx = users.findIndex(u => u.username === sess.user);
        if (idx < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"User record missing"}'); return; }
        if (!verifyWebappPassword(currentPassword, users[idx].salt, users[idx].hash)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current password is incorrect' })); return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(newPassword, salt, 100000, 64, 'sha512').toString('hex');
        users[idx].salt = salt;
        users[idx].hash = hash;
        users[idx].passwordUpdatedAt = Date.now();
        _writeJsonAtomic(WEBAPP_USERS_PATH, users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/onboarding/complete' && req.method === 'POST') {
        const cookies = parseCookies(req);
        const sid = cookies['anima_session'] || cookies['anima_webapp'];
        const sess = sid && _sessions.get(sid);
        if (!sess) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"No session"}'); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        try {
          // 0. Auto-fill any missing per-model ctx by probing the configured providers' /models endpoints.
          parsed.modelLimits = await _enrichModelLimits(parsed.modelLimits, parsed.models, parsed.providers);
          // 1. Persist settings through the existing pipeline
          const newState = this._persistSettingsPatch(parsed);
          // 2. Theme preference
          const PREFS_PATH = path.join(this.config.dataDir, 'preferences.json');
          const VALID_THEMES = ['midnight', 'dark', 'paper', 'terminal', 'ember', 'arctic', 'neon', 'forest'];
          let prefs = {};
          try { prefs = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }
          const theme = VALID_THEMES.includes(parsed.theme) ? parsed.theme : 'midnight';
          if (!prefs[sess.user]) prefs[sess.user] = {};
          prefs[sess.user].theme = theme;
          prefs._lastUsed = { theme, ts: Date.now() };
          prefs.onboardingCompleted = true;
          prefs.onboardingCompletedAt = Date.now();
          _writeJsonAtomic(PREFS_PATH, prefs);
          // 3. Mirror choices into the active graph
          try {
            const graphDb = this.graph?.db;
            if (graphDb) this._applyOnboardingToGraph(graphDb, parsed);
          } catch (e) { this.log.warn(`[onboarding] graph sync skipped: ${e.message}`); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            theme,
            // Surface the freshly-minted Acorn team key so the wizard can show it once.
            acornKey: newState.acorn?.enabled ? newState.acorn.key : null,
            acornKeyGenerated: !!newState._acornKeyGenerated,
          }));
        } catch (e) {
          this.log.warn(`[onboarding] complete failed: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // /graph — serve without auth (HTML has its own login form)
      if (urlPath === '/graph' || urlPath === '/graph/') {
        try {
          const localViewer = path.join(__dirname, '..', 'static', 'graph-viewer.html');
          const sharedStaticDir = process.env.SPORE_SHARED_STATIC || '/app/shared-static';
          const sharedViewer = path.join(sharedStaticDir, 'graph-viewer.html');
          const viewerPath = _newerFile(sharedViewer, localViewer);
          let html = fs.readFileSync(viewerPath, 'utf8');
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          if (fs.existsSync(brandPath)) {
            const inline = `<script>\n${fs.readFileSync(brandPath, 'utf8')}\n</script>`;
            html = html.replace(/<script src="brand\.js"><\/script>/, inline);
          }
          // Inject theme CSS vars into <html> so the login overlay is themed before JS runs
          html = html.replace(/<html\s+lang="en">/, `<html lang="en" style="${_buildThemeInlineStyle(this.config.dataDir)}">`);
          // Inject onboarding flag so the viewer knows to show the wizard before login
          const obFlag = `<script>window.__ONBOARDING__=${JSON.stringify({ needed: _isOnboardingNeeded(this.config.dataDir, this.config) })};</script>`;
          html = html.replace(/<\/head>/, obFlag + '</head>');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
          res.end(html);
        } catch { res.writeHead(500); res.end('Graph viewer not found.'); }
        return;
      }

      if (urlPath === '/' || urlPath === '/index.html') {
        const basePath = (this.config.ingressPath || '').replace(/\/$/, '');
        res.writeHead(302, { 'Location': basePath + '/graph' });
        res.end();
        return;
      }

      if (urlPath === '/brand.js') {
        try {
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(fs.readFileSync(brandPath, 'utf8'));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // Self-hosted fonts (Petri direction). Avoids the external Google Fonts
      // dependency so the redesign actually paints when the user's browser
      // can't reach fonts.googleapis.com.
      if (urlPath.startsWith('/fonts/') && /^\/fonts\/[a-zA-Z0-9_.-]+\.woff2?$/.test(urlPath)) {
        try {
          const fontPath = path.join(__dirname, '..', 'static', urlPath);
          const ext = path.extname(fontPath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': ext === '.woff2' ? 'font/woff2' : 'font/woff',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(fs.readFileSync(fontPath));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // ── CORS for Acorn API endpoints (companion web app) ──
      if (urlPath.startsWith('/api/acorn/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // ── Acorn CLI auth ──
      if (urlPath === '/api/acorn/auth' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const { username, key } = JSON.parse(body);
            const acornKey = this.config.acornKey;
            if (!acornKey) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Acorn not configured on this agent' }));
              return;
            }
            if (!username || typeof username !== 'string' || username.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid username (alphanumeric, max 32 chars)' }));
              return;
            }
            if (!_acornKeyMatches(key, acornKey)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid team key' }));
              return;
            }
            const acornSid = crypto.randomBytes(16).toString('hex');
            const webSessions = this._webSessions;
            webSessions.set(acornSid, { user: username.toLowerCase().trim(), type: 'acorn', created: Date.now() });
            this.log.info(`[acorn] Auth OK for user: ${username}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token: acornSid, user: username }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
          }
        });
        return;
      }

      // ── Acorn: list sessions for authenticated user ──
      if (urlPath === '/api/acorn/sessions' && req.method === 'GET') {
        // Authenticate via Bearer token
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const session = token ? this._webSessions.get(token) : null;
        if (!session || session.type !== 'acorn') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing token' }));
          return;
        }
        const user = session.user;
        const prefix = `channel:cli:${user}@`;
        try {
          const allSessions = this.tools._sessions.listSessions();
          const agent = this.tools._agent;
          const activeKeys = agent ? new Set(agent.activeRuns) : new Set();
          const sessions = allSessions
            .filter(s => s.key.startsWith(prefix) && s.message_count > 0)
            .map(s => {
              // Parse project name from key: channel:cli:user@project-hash-ts
              const afterAt = s.key.slice(prefix.length);
              const parts = afterAt.split('-');
              const project = parts.length >= 3 ? parts.slice(0, parts.length - 2).join('-') : afterAt;
              const hasConnectedClient = this._sessionClients.has(s.key.replace('channel:', ''));
              return {
                key: s.key.replace('channel:', ''),
                project,
                created: s.created,
                updated: s.updated,
                messageCount: s.message_count,
                active: activeKeys.has(s.key) || hasConnectedClient,
              };
            });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessions }));
        } catch (e) {
          this.log.warn(`[acorn] Sessions list failed: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to list sessions' }));
        }
        return;
      }

      if (urlPath === '/api/ws-token') {
        const sid = getSessionFromReq(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: sid || '' }));
        return;
      }

      if (urlPath === '/api/identity') {
        if (!isAnyAuth(req)) {
          if (!(await checkAuth(req, res))) return;
        }
        const displayName = this.config.displayName || this.config.agentId || 'spore';
        const names = [displayName.toLowerCase()];
        if (Array.isArray(this.config.nicknames)) {
          this.config.nicknames.forEach(n => { if (n && !names.includes(n.toLowerCase())) names.push(n.toLowerCase()); });
        }
        try {
          const db = this.graph?.db || graphDb;
          if (db) {
            const agentId = this.config.agentId || 'spore';
            try {
              const aliases = db.prepare("SELECT alias FROM aliases WHERE node_id = ?").all(agentId);
              aliases.forEach(a => { if (a.alias && !names.includes(a.alias.toLowerCase())) names.push(a.alias.toLowerCase()); });
            } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
          }
        } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        const pipeline = this._ensureVoicePipeline();
        const voiceEnabled = !!(pipeline);
        const sttEnabled = !!(pipeline?.stt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: displayName, names, voiceEnabled, sttEnabled }));
        return;
      }

      // ── Chatroom toggle API ──
      if (urlPath === '/api/chatroom/status' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        const connected = !!(gw && gw._ws && gw._ws.readyState === 1);
        const enabled = !gw?._closed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled, connected }));
        return;
      }

      if (urlPath === '/api/chatroom/toggle' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        if (!gw) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No chatroom gateway configured (MANAGER_URL not set)', enabled: false }));
          return;
        }
        const body = await new Promise((resolve) => {
          let d = '';
          req.on('data', c => { d += c; });
          req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        if (body.enabled === false) {
          gw.disconnect();
          this.log.info('[chatroom] Disconnected from chatroom (user toggle)');
        } else {
          gw._closed = false;
          gw.connect();
          this.log.info('[chatroom] Reconnecting to chatroom (user toggle)');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: !gw._closed }));
        return;
      }

      // ── LongMemEval Benchmark API ──
      if (urlPath === '/api/benchmark/longmemeval' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        try {
          if (this.tools._benchmarkRunner && this.tools._benchmarkRunner.phase !== 'done' && this.tools._benchmarkRunner.phase !== 'error' && this.tools._benchmarkRunner.phase !== 'cancelled' && this.tools._benchmarkRunner.phase !== 'idle') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Benchmark already running', phase: this.tools._benchmarkRunner.phase }));
            return;
          }
          let body = {};
          try { body = await new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); } catch (e) { this.log.warn('[web] Promise failed: ' + e.message); }
          const { variant = 'oracle', maxQuestions = 500, skipIngestion = false, forceReeval = false, learnerModel, answerModel, questionTypes } = body;
          const registry = this.tools._graphRegistry;
          if (!registry) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Multi-graph registry not available' })); return; }

          const prevSlug = registry.getActiveSlug();
          let slug;
          if (skipIngestion) {
            slug = prevSlug;
          } else {
            slug = registry.create(`LongMemEval ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, `LongMemEval benchmark (${variant})`);
            this.tools.switchGraph(slug);
            graphEvents.emit('change', { op: 'graph:switched', slug, source: 'benchmark' });
          }

          const { LongMemEvalRunner } = require('../benchmark/longmemeval');
          const runner = new LongMemEvalRunner({
            config: this.config,
            graph: this.graph,
            learner: this.tools.learner,
            maintainer: this.tools._maintainer || null,
            llmClient: this.tools.anthropicClient,
            log: this.log,
            broadcast: this.broadcast.bind(this),
            learnerModel: learnerModel || undefined,
            answerModel: answerModel || undefined,
          });
          this.tools._benchmarkRunner = runner;
          this.tools._benchmarkPrevSlug = prevSlug;

          runner.run({ variant, maxQuestions, skipIngestion, forceReeval, questionTypes: questionTypes || null }).catch(e => {
            this.log.error(`[longmemeval] Runner error: ${e.message}`);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, slug, prevSlug, variant, maxQuestions }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/status' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const status = this.tools._benchmarkRunner ? this.tools._benchmarkRunner.getStatus() : { phase: 'idle' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/results' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        try {
          const graphDir = path.dirname(this.config.graphDbPath);
          const resultsPath = path.join(graphDir, 'longmemeval-results.json');
          const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ empty: true }));
        }
        return;
      }

      if (urlPath === '/api/benchmark/longmemeval/cancel' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (this.tools._benchmarkRunner) {
          this.tools._benchmarkRunner.cancel();
          if (this.tools._benchmarkPrevSlug && this.tools._graphRegistry) {
            try {
              this.tools.switchGraph(this.tools._benchmarkPrevSlug);
              graphEvents.emit('change', { op: 'graph:switched', slug: this.tools._benchmarkPrevSlug, source: 'benchmark-cancel' });
            } catch (e) { this.log.warn(`[longmemeval] Failed to switch back: ${e.message}`); }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Multi-Graph Management API ──
      if (urlPath.startsWith('/api/graphs')) {
        if (!(await checkAuth(req, res))) return;
        await this._handleMultiGraphApi(req, res, urlPath);
        return;
      }

      // Enhanced Recall toggle
      if (urlPath === '/api/enhanced-recall') {
        if (!(await checkAuth(req, res))) return;
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enhancedRecall: !!this.config.enhancedRecall }));
          return;
        }
        if (req.method === 'PUT') {
          const body = await new Promise((resolve, reject) => {
            let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
          });
          this.config.enhancedRecall = !!body.enabled;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enhancedRecall: this.config.enhancedRecall }));
          return;
        }
      }

      if (urlPath === '/api/settings') {
        if (req.method === 'GET') {
          // Any authenticated session can read settings (webapp users see them
          // read-only via the role gating in the UI).
          if (!isAnyAuth(req)) { res.writeHead(401); res.end('{"error":"Authentication required"}'); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this._getSettingsState()));
          return;
        }
        if (!(await checkAuth(req, res))) return;
        if (req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const parsed = body ? JSON.parse(body) : {};
            // Auto-fill missing per-model ctx by probing the configured providers' /models endpoints.
            parsed.modelLimits = await _enrichModelLimits(parsed.modelLimits, parsed.models, parsed.providers);
            const settings = this._persistSettingsPatch(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, settings }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || 'invalid body' }));
          }
          return;
        }
      }

      // ── Reset graph (creator only, destructive) ──────────────────
      // Wipes every user-data table in the graph DB and re-applies the
      // seeded reference nodes from /app/reference-nodes.sql plus every
      // /app/migrate-ref-*.sql. Designed for "I want to start fresh"
      // moments — operator changed their mind about the agent, dev
      // testing, etc. Always backs up the DB first to
      // <dbPath>.pre-reset.<ts> so the action is recoverable.
      //
      // Body: { confirm: "RESET" } — typed-string guard so a stray
      // POST can't trash the graph. Returns before/after counts +
      // backup path on success.
      if (urlPath === '/api/admin/reset-graph') {
        if (!(await checkAuth(req, res))) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        if (parsed.confirm !== 'RESET') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'confirm must be the literal string "RESET"' }));
          return;
        }
        try {
          const result = await this._resetGraphToSeeds();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          this.log.error('[reset-graph] failed:', e?.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'reset failed' }));
        }
        return;
      }

      // Plugins API — list / install / uninstall. Creator-only.
      // Install + uninstall are gated behind config.pluginsHotReload (default
      // off) so an operator must explicitly opt in to runtime plugin lifecycle.
      // List is always available so the settings UI can show what's loaded.
      if (urlPath === '/api/plugins/list' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        const dirs = mgr.getDiscoveryDirs?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: !!this.config.pluginsEnabled,
          hotReload: !!this.config.pluginsHotReload,
          dirs: { bundled: dirs.bundled || null, user: dirs.user || null },
          installed: mgr.listInstalled(),
          available: mgr.listAvailable?.() || [],
        }));
        return;
      }

      if (urlPath === '/api/plugins/install' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Set SPORE_PLUGINS_HOT_RELOAD=true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        // Accept { id } (resolves against discovery dirs) or { path } (legacy).
        const arg = parsed.id ? { id: parsed.id } : (parsed.path ? { path: parsed.path } : null);
        if (!arg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id (preferred) or path is required' }));
          return;
        }
        try {
          const manifest = await mgr.installPlugin(arg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, manifest }));
        } catch (e) {
          this.log.error('[plugins:install] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'install failed' }));
        }
        return;
      }

      // Clone a plugin from a git repo into the user discovery dir.
      // Doesn't auto-install — caller follows up with /api/plugins/install
      // once they've reviewed the cloned manifest. This separation lets the
      // UI show "cloned, not yet installed" state.
      if (urlPath === '/api/plugins/clone' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Set SPORE_PLUGINS_HOT_RELOAD=true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr?.cloneFromGit) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        if (!parsed.repo || typeof parsed.repo !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'repo (git URL) is required' }));
          return;
        }
        try {
          const result = await mgr.cloneFromGit(parsed.repo, {
            name: parsed.name,
            ref: parsed.ref,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, manifest: result.manifest, path: result.path }));
        } catch (e) {
          this.log.error('[plugins:clone] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'clone failed' }));
        }
        return;
      }

      // Plugin-registered HTTP routes — namespaced under /api/plugins/<pluginId>/<route>.
      // Resolved AFTER the built-in /api/plugins/* endpoints (list/install/uninstall)
      // so plugins can't shadow them. Must be authenticated; auth model matches
      // graph endpoints (any signed-in user, not creator-only).
      if (urlPath.startsWith('/api/plugins/') && !urlPath.startsWith('/api/plugins/list') && !urlPath.startsWith('/api/plugins/install') && !urlPath.startsWith('/api/plugins/uninstall')) {
        const mgr = this.tools?._pluginManager;
        const resolved = mgr?.resolveWebRoute?.(req.method, urlPath);
        if (resolved) {
          if (!isAnyAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
          }
          try {
            const query = (() => { try { return new URL(req.url, 'http://x').searchParams; } catch { return new URLSearchParams(); } })();
            await resolved.handler(req, res, { urlPath, query, user: req._user || null });
          } catch (e) {
            this.log.error(`[plugins] route ${resolved.pluginId}${urlPath} failed: ${e?.message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message || 'plugin route failed' }));
            }
          }
          return;
        }
      }

      if (urlPath.startsWith('/api/plugins/uninstall/') && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Set SPORE_PLUGINS_HOT_RELOAD=true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        const pluginId = decodeURIComponent(urlPath.slice('/api/plugins/uninstall/'.length));
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid plugin id' }));
          return;
        }
        try {
          const result = await mgr.uninstallPlugin(pluginId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          this.log.error('[plugins:uninstall] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'uninstall failed' }));
        }
        return;
      }

      // Read-only probe endpoints accept any authenticated session (webapp or creator),
      // so the onboarding wizard can test provider keys / model tiers / web search with
      // only the webapp cookie it just obtained from /api/webapp/users.
      const isTestProbe =
        (urlPath.startsWith('/api/providers/') && urlPath.endsWith('/test')) ||
        (urlPath.startsWith('/api/models/') && urlPath.endsWith('/test')) ||
        urlPath === '/api/providers/list-models' ||
        urlPath === '/api/websearch/test';
      if (isTestProbe) {
        // Allow access either with any session, OR while the wizard is still
        // running (so a restart-orphaned cookie doesn't lock the operator out
        // of the populate / test buttons mid-setup).
        const onboardingNeeded = _isOnboardingNeeded(this.config.dataDir, this.config);
        if (!isAnyAuth(req) && !onboardingNeeded) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      // Graph endpoints accept any authenticated session — webapp users have
      // read/write to the graph + chat by design. Maintainer / providers /
      // models / websearch stay creator-only.
      if (urlPath.startsWith('/api/graph')) {
        if (!isAnyAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      if (urlPath === '/api/tokens' || urlPath.startsWith('/api/maintainer') || urlPath.startsWith('/api/janitor') || urlPath.startsWith('/api/backups') || urlPath.startsWith('/api/tailscale') || urlPath.startsWith('/api/cluster') || urlPath.startsWith('/api/email') || urlPath.startsWith('/api/providers') || urlPath.startsWith('/api/models') || urlPath.startsWith('/api/websearch')) {
        if (!(await checkAuth(req, res))) return;
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      if (urlPath.startsWith('/files/')) {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const relPath = decodeURIComponent(urlPath.slice(7));
        const filePath = path.join(workspace, relPath);
        if (!filePath.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) { res.writeHead(404); res.end('Not a file'); return; }
          const ext = path.extname(filePath).toLowerCase();
          const params = new URL(req.url, 'http://x').searchParams;
          const contentType = MIME[ext] || 'application/octet-stream';
          const baseHeaders = {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'ETag': `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
            'Accept-Ranges': 'bytes',
          };
          if (params.get('download') === '1') {
            baseHeaders['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
          }
          const range = req.headers.range;
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m) {
              let start = m[1] ? parseInt(m[1], 10) : 0;
              let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
              if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
              }
              res.writeHead(206, {
                ...baseHeaders,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': end - start + 1,
              });
              fs.createReadStream(filePath, { start, end }).pipe(res);
              return;
            }
          }
          res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
          fs.createReadStream(filePath).pipe(res);
        } catch { res.writeHead(404); res.end('File not found'); }
        return;
      }

      if (urlPath === '/api/preferences') {
        const PREFS_PATH = path.join(this.config.dataDir, 'preferences.json');
        // Two-theme system. Legacy values (paper, midnight, terminal, ember,
        // arctic, neon, forest) are coerced via _normalizeThemeName() so an
        // old client / saved pref doesn't reject. The PUT path always
        // stores the normalized name; GETs always return one of {dark, light}.
        const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; } };
        const authType = isAnyAuth(req);
        if (!authType) { if (!(await tryManagerSSO(req, res))) { res.writeHead(401); res.end('{}'); return; } }
        const cookies = parseCookies(req);
        let username = 'default';
        const sid = cookies['anima_session'];
        const sess = sid && _sessions.get(sid);
        // Sessions are stored with `user` (legacy code looked at `username`).
        if (sess?.user || sess?.username) username = sess.user || sess.username;
        else {
          const wsid = cookies['anima_webapp'];
          const wsess = wsid && _sessions.get(wsid);
          if (wsess?.user || wsess?.username) username = wsess.user || wsess.username;
        }
        if (req.method === 'GET') {
          const prefs = loadPrefs();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            theme: _normalizeThemeName(prefs[username]?.theme),
            displayName: prefs[username]?.displayName || '',
            username,
          }));
          return;
        }
        if (req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const parsed = JSON.parse(body);
            const prefs = loadPrefs();
            if (!prefs[username]) prefs[username] = {};
            if (Object.prototype.hasOwnProperty.call(parsed, 'theme')) {
              // Coerce any incoming value (including legacy names) to one
              // of the two surviving themes via the shared normalizer.
              const safeTheme = _normalizeThemeName(parsed.theme);
              prefs[username].theme = safeTheme;
              // Only creator-tier sessions can update the global "last used"
              // marker that the login page falls back on.
              const sessRole = sess?.type || (sid && _sessions.get(sid)?.type);
              if (sessRole === 'creator' || sessRole === 'admin') {
                prefs._lastUsed = { theme: safeTheme, ts: Date.now() };
              }
            }
            if (Object.prototype.hasOwnProperty.call(parsed, 'displayName')) {
              const dn = String(parsed.displayName || '').trim().slice(0, 64);
              if (dn) prefs[username].displayName = dn;
              else delete prefs[username].displayName;
            }
            if (parsed.wizardCompleted === true) {
              prefs[username].wizardCompleted = true;
              prefs[username].wizardCompletedAt = Date.now();
            }
            fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              theme: prefs[username].theme,
              displayName: prefs[username].displayName || '',
            }));
          } catch { res.writeHead(400); res.end('{"error":"invalid body"}'); }
          return;
        }
      }

      if (urlPath === '/api/logs') {
        if (!(await checkAuth(req, res))) return;
        const maxLines = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('lines') || '500'), 2000);
        const logRing = this.log._ring || [];
        const output = logRing.slice(-maxLines).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(output || '[no log entries captured yet]');
        return;
      }

      if (urlPath === '/api/workspace') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const entries = fs.readdirSync(target, { withFileTypes: true }).map(e => {
            const stat = (() => { try { return fs.statSync(path.join(target, e.name)); } catch { return null; } })();
            return { name: e.name, isDir: e.isDirectory(), size: stat?.size || 0, modified: stat?.mtime || null };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: subdir || '/', entries }));
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'Directory not found' })); }
        return;
      }

      if (urlPath === '/api/workspace/mkdir' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const params = new URL(req.url, 'http://x').searchParams;
        const parentDir = params.get('path') || '';
        const folderName = params.get('name') || '';
        if (!folderName || folderName.includes('/') || folderName.includes('..')) {
          res.writeHead(400); res.end('Invalid folder name'); return;
        }
        const target = path.join(workspace, parentDir, folderName);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          fs.mkdirSync(target, { recursive: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to create directory: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/file' && req.method === 'DELETE') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to delete: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/save' && req.method === 'PUT') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
        req.on('end', () => {
          try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.concat(chunks));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) { res.writeHead(500); res.end('Save failed: ' + e.message); }
        });
        return;
      }

      if (urlPath === '/api/workspace/upload' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const destDir = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!destDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_UPLOAD = 10 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const boundary = boundaryMatch[1].trim();
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_UPLOAD * 10) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const saved = parseMultipart(buf, boundary, destDir, MAX_UPLOAD);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Upload failed: ' + e.message); }
        });
        return;
      }

      // ── Workspace tree (recursive listing for sync diffing) ──
      if (urlPath === '/api/workspace/tree') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const walkDir = (dir, prefix) => {
          const results = [];
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const rel = prefix ? `${prefix}/${e.name}` : e.name;
              const full = path.join(dir, e.name);
              try {
                const stat = fs.statSync(full);
                if (e.isDirectory()) {
                  results.push(...walkDir(full, rel));
                } else {
                  results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
                }
              } catch (e) { this.log.warn('[web] fs.statSync failed: ' + e.message); }
            }
          } catch (e) { this.log.warn('[web] fs.readdirSync failed: ' + e.message); }
          return results;
        };
        try {
          const files = walkDir(target, '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ root: subdir || '/', files }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        return;
      }

      // ── Batch upload (preserves relative paths for sync) ──
      if (urlPath === '/api/workspace/upload-batch' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const basePath = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const baseDir = path.join(workspace, basePath);
        if (!baseDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_BATCH = 50 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_BATCH) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const boundary = boundaryMatch[1].trim();
            const parts = buf.toString('binary').split('--' + boundary);
            const saved = [];
            for (const part of parts) {
              if (part === '--\r\n' || part === '--' || !part.trim()) continue;
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd === -1) continue;
              const headerStr = part.substring(0, headerEnd);
              const nameMatch = headerStr.match(/name="([^"]+)"/);
              const filenameMatch = headerStr.match(/filename="([^"]+)"/);
              if (!filenameMatch) continue;
              const relPath = nameMatch ? nameMatch[1] : filenameMatch[1];
              let body = part.substring(headerEnd + 4);
              if (body.endsWith('\r\n')) body = body.slice(0, -2);
              const dest = path.join(baseDir, relPath);
              if (!dest.startsWith(baseDir)) continue;
              const dir = path.dirname(dest);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(dest, Buffer.from(body, 'binary'));
              saved.push(relPath);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Batch upload failed: ' + e.message); }
        });
        return;
      }

      // ── Remote (SSH/SFTP) file operations ──
      if (urlPath.startsWith('/api/remote/')) {
        if (!(await checkAuth(req, res))) return;
        const mgr = this._ensureSSHManager();
        if (!mgr) { res.writeHead(503); res.end(JSON.stringify({ error: 'SSH manager not available' })); return; }
        const params = new URL(req.url, 'http://x').searchParams;
        const hostId = params.get('host');
        if (!hostId) { res.writeHead(400); res.end(JSON.stringify({ error: 'host parameter required' })); return; }
        const remotePath = params.get('path') || '/';

        try {
          if (urlPath === '/api/remote/ls') {
            const entries = await mgr.sftpListDir(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: remotePath, entries }));
          } else if (urlPath === '/api/remote/read') {
            const data = await mgr.sftpReadFile(hostId, remotePath);
            const ext = path.extname(remotePath).toLowerCase();
            const MIME_MAP = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
            const headers = { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' };
            if (params.get('download') === '1') {
              headers['Content-Disposition'] = `attachment; filename="${path.basename(remotePath)}"`;
            }
            res.writeHead(200, headers);
            res.end(data);
          } else if (urlPath === '/api/remote/write' && req.method === 'POST') {
            const contentType = req.headers['content-type'] || '';
            if (contentType.includes('multipart/form-data')) {
              const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
              if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const buf = Buffer.concat(chunks);
                  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'sftp-upload-'));
                  const saved = parseMultipart(buf, boundaryMatch[1].trim(), tmpDir, 10 * 1024 * 1024);
                  for (const fileName of saved) {
                    const localPath = path.join(tmpDir, fileName);
                    const content = fs.readFileSync(localPath);
                    const destPath = remotePath.endsWith('/') ? remotePath + fileName : remotePath + '/' + fileName;
                    await mgr.sftpWriteFile(hostId, destPath, content);
                    fs.unlinkSync(localPath);
                  }
                  fs.rmdirSync(tmpDir, { recursive: true });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, files: saved }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            } else {
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const result = await mgr.sftpWriteFile(hostId, remotePath, Buffer.concat(chunks));
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, ...result }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            }
          } else if (urlPath === '/api/remote/mkdir' && req.method === 'POST') {
            const name = params.get('name') || '';
            const target = remotePath.endsWith('/') ? remotePath + name : remotePath + '/' + name;
            await mgr.sftpMkdir(hostId, target);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (urlPath === '/api/remote/file' && req.method === 'DELETE') {
            await mgr.sftpDelete(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown remote endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[remote-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Shared Skills API ──
      if (urlPath.startsWith('/api/skills')) {
        if (!(await checkAuth(req, res))) return;
        try {
          const params = new URL(req.url, 'http://x').searchParams;
          if (urlPath === '/api/skills' && req.method === 'GET') {
            const query = params.get('q') || '';
            const tags = params.get('tags') ? params.get('tags').split(',').map(t => t.trim()) : null;
            const result = this.skills.list(query || undefined, tags || undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/read' && req.method === 'GET') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.read(slug);
            if (result.error) { res.writeHead(404); res.end(JSON.stringify(result)); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/save' && req.method === 'POST') {
            const chunks = [];
            req.on('data', c => { chunks.push(c); });
            req.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const result = this.skills.write(body.slug, {
                  title: body.title, tags: body.tags, author: body.author || 'web-ui',
                  summary: body.summary, content: body.content, mode: body.mode || 'replace',
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
              } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
            });
          } else if (urlPath === '/api/skills/delete' && req.method === 'DELETE') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.remove(slug);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/rebuild' && req.method === 'POST') {
            const index = this.skills._rebuildIndex();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: index.length }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown skills endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[skills-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Secure API Key Proxy ──
      // Agents write /workspace/web/.api-proxy.json to define routes.
      // Frontend calls /api/proxy/<route> and the server injects env keys server-side.
      // Keys never reach the browser.
      if (urlPath.startsWith('/api/proxy/')) {
        const proxyRoute = urlPath.slice('/api/proxy/'.length);
        const proxyConfig = this._loadApiProxyConfig();
        const matched = proxyConfig && this._matchProxyRoute(proxyRoute, proxyConfig, req);
        if (matched) {
          await this._handleApiProxy(req, res, matched, proxyRoute);
          return;
        }
        if (proxyConfig) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No proxy route matched: ${proxyRoute}`, available: Object.keys(proxyConfig.routes || {}) }));
          return;
        }
      }

      // ── User App Proxy ──
      // If /workspace/.app-port exists, proxy unmatched /api/* requests to that port.
      // Accepts creator auth, webapp session, or manager SSO.
      if (urlPath.startsWith('/api/')) {
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const authType = isAnyAuth(req);
          if (!authType && !checkCreatorAuth(req, res) && !(await tryManagerSSO(req, res))) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required for app proxy' }));
            return;
          }
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'x-request-id', 'x-forwarded-for'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: appPort,
            path: req.url,
            method: req.method,
            headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', (e) => {
            this.log.warn(`[app-proxy] Proxy to :${appPort} failed: ${e.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'App backend unavailable' }));
            }
          });
          req.pipe(proxyReq);
          return;
        }
      }

      // ── /login: serve the standalone login page ──
      if (urlPath === '/login' || urlPath === '/login/') {
        try {
          const p = path.join(__dirname, '..', 'static', 'login.html');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
          });
          res.end(fs.readFileSync(p, 'utf8'));
        } catch { res.writeHead(404); res.end('Login page not found.'); }
        return;
      }


      // ── Static files: webapp auth / OAuth gate ──
      {
        const wUsers = loadWebappUsers();
        const oauthEnabled = await this._isOAuthEnabled();
        const requireAuth = wUsers.length > 0 || oauthEnabled;
        if (requireAuth && !isAnyAuth(req)) {
          const cookies = parseCookies(req);
          const hasMgr = !!cookies['manager_session'];
          this.log.info(`[webapp-gate] ${urlPath} — oauth=${oauthEnabled} hasMgrCookie=${hasMgr} wUsers=${wUsers.length}`);
          let ssoResult;
          if (oauthEnabled && (ssoResult = await tryManagerSSO(req, res, { webappOnly: true }))) {
            this.log.info(`[webapp-gate] OAuth SSO succeeded: ${ssoResult}`);
          }
          else if (!oauthEnabled && (ssoResult = await tryManagerSSO(req, res))) {
            this.log.info(`[webapp-gate] Creator SSO succeeded: ${ssoResult}`);
          }
          else if (oauthEnabled) {
            const proto = this.config.ingressHttps ? 'https' : 'http';
            const domain = this.config.ingressDomain;
            const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
            const returnTo = domain ? `${proto}://${domain}${iPath}${urlPath}` : '';
            const managerUrl = returnTo ? `/manager/?returnTo=${encodeURIComponent(returnTo)}` : '/manager/';
            res.writeHead(302, { 'Location': managerUrl });
            res.end(); return;
          }
          else if (urlPath === '/' || urlPath === '/index.html') {
            const basePath = (this.config.ingressPath || '').replace(/\/$/, '');
            res.writeHead(302, { 'Location': basePath + '/login' });
            res.end(); return;
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
          }
        }
      }

      let filePath = path.join(serveDir, urlPath);

      if (!filePath.startsWith(serveDir)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch (e) { this.log.warn('[web] fs.statSync failed: ' + e.message); }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        // If a backend is running, proxy non-file requests to it (SPA routing, etc.)
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch {}
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'cookie'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: req.method, headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', () => {
            if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(`404 Not Found: ${req.url}`); }
          });
          req.pipe(proxyReq);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${req.url}`);
      }
    });

    server.listen(webPort, '0.0.0.0', () => {
      const isWSL = (() => { try { return require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();
      const hostAddr = isWSL
        ? (require('child_process').execSync('hostname -I', { encoding: 'utf8' }).trim().split(/\s+/)[0] || 'localhost')
        : 'localhost';
      this.log.info(`[web_serve] Serving ${serveDir} on port ${webPort}`);
      this.log.info(`[web_serve] URL: http://${hostAddr}:${webPort}`);
    });

    server.on('error', (e) => {
      this.log.error(`[web_serve] Server error: ${e.message}`);
      this._server = null;
    });

    this._server = server;
    this._serverDir = serveDir;

    try { fs.writeFileSync(path.join(this.config.dataDir, '.web-serve-dir'), serveDir); } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    this._setupWebSocket(server, authUser, authPass);

    let pubUrl = this.config.publicUrl ? this.config.publicUrl.replace(/\/+$/, '') : null;
    if (!pubUrl && this.config.ingressDomain) {
      const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
      const proto = this.config.ingressHttps ? 'https' : 'http';
      pubUrl = `${proto}://${this.config.ingressDomain}${iPath}`;
    }
    const displayUrl = pubUrl || `http://localhost:${webPort}`;
    return { started: true, port: webPort, dir: serveDir, url: `${displayUrl}/`, graphEditor: `${displayUrl}/graph`, publicUrl: pubUrl || null, note: pubUrl ? `Public URL: ${pubUrl}/ — files written here are served immediately.` : 'Files written to this directory are served immediately — no restart needed. Graph editor at /graph (auth required).' };
  }

  // ── Voice Pipeline ──────────────────────────────────────────────────

  _ensureVoicePipeline() {
    if (this._voicePipeline) return this._voicePipeline;
    if (!this.config.voice?.enabled) return null;
    try {
      const { VoicePipeline } = require('../voice');
      this._voicePipeline = new VoicePipeline(this.config, this.log);
      return this._voicePipeline.enabled ? this._voicePipeline : null;
    } catch (e) {
      this.log.warn(`[voice] Pipeline init failed: ${e.message}`);
      return null;
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────────

  _setupWebSocket(httpServer, authUser, authPass) {
    const WebSocket = require('ws');

    const wss = new WebSocket.Server({ noServer: true });
    this._wss = wss;

    const PING_INTERVAL = 15000;
    const pingTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (client._missedPongs >= 2) {
          this.log.warn('[ws] Terminating unresponsive client (2 missed pongs)');
          client.terminate();
          continue;
        }
        client._missedPongs = (client._missedPongs || 0) + 1;
        try { client.ping(); } catch (e) { this.log.warn('[web] client.ping failed: ' + e.message); }
      }
    }, PING_INTERVAL);
    wss.on('close', () => clearInterval(pingTimer));

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/ws/app') {
        if (authUser && authPass) {
          const cookies = {};
          (req.headers.cookie || '').split(';').forEach(c => {
            const [k, ...v] = c.trim().split('=');
            if (k) cookies[k.trim()] = v.join('=');
          });
          const sid = cookies['anima_session'];
          const sess = sid && _sessions.get(sid);
          if (!sess || (sess.type !== 'creator' && sess.type !== 'admin') || Date.now() - sess.created >= SESSION_TTL) {
            socket.destroy(); return;
          }
        }
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        const wPort = this.config.webPort;
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== wPort) {
          const safeHeaders = {};
          const allowHeaders = ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
          for (const h of allowHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: 'GET', headers: safeHeaders,
          });
          proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
              Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
              '\r\n\r\n');
            if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
            proxySocket.pipe(socket).pipe(proxySocket);
            proxySocket.on('error', () => socket.destroy());
            socket.on('error', () => proxySocket.destroy());
          });
          proxyReq.on('error', () => socket.destroy());
          proxyReq.end();
          return;
        }
        socket.destroy(); return;
      }

      if (url.pathname !== '/ws') { socket.destroy(); return; }

      const webSessions = this._webSessions || new Map();
      const token = url.searchParams.get('token');
      let wsRole = null;
      if (token && webSessions.has(token)) {
        const sess = webSessions.get(token);
        if (Date.now() - sess.created < SESSION_TTL) {
          wsRole = sess.type || null;
        } else {
          webSessions.delete(token);
          socket.destroy(); return;
        }
      } else if (authUser && authPass && token) {
        const decoded = Buffer.from(token, 'base64').toString();
        const [u, ...pParts] = decoded.split(':');
        if (u !== authUser || pParts.join(':') !== authPass) { socket.destroy(); return; }
        wsRole = 'creator';
      } else if (authUser && authPass) {
        socket.destroy(); return;
      } else if (token) {
        socket.destroy(); return;
      }

      let wsUser = null;
      if (token && webSessions.has(token)) {
        const sess = webSessions.get(token);
        wsUser = sess.user || null;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._role = wsRole;
        ws._user = wsUser;
        ws._sessionToken = token || null;
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      const isAcornClient = ws._role === 'acorn';
      this.log.info(`[ws] Client connected: user=${ws._user || '(anon)'} role=${ws._role || '(none)'}${isAcornClient ? ' [acorn]' : ''}`);
      ws._missedPongs = 0;
      ws._pendingTools = new Map();
      ws.on('pong', () => { ws._missedPongs = 0; });

      // Capability advertisement. acorn checks this to decide whether to
      // send projectContext as a sibling field (new path — routed into
      // system prompt) or fall back to gluing GatherContext onto message
      // content (old path). Sent unconditionally for every client; non-
      // acorn clients ignore unknown frame types.
      try {
        ws.send(JSON.stringify({
          type: 'capabilities',
          projectContext: true,
          sporeVersion: 'v0.1.0',
        }));
      } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }

      // Acorn clients manage their own session history — don't send web panel history
      if (!isAcornClient) {
        try {
          // CRITICAL: never serve DM history to an anonymous socket. Before
          // the user has authenticated, `ws._user` is null — falling back to
          // 'operator' here leaks the operator's entire chat history to any
          // unauthenticated visitor. Silently skip the history block instead;
          // the client will receive history once it reconnects with a valid
          // session token.
          if (this.tools._sessions && ws._user) {
            const sessionKey = this.tools._sessions.constructor.buildKey('web:control-panel', true, ws._user);
            this.log.info(`[ws] history-fetch user=${ws._user} → sessionKey=${sessionKey}`);
            const rows = this.tools._sessions.db.prepare(
              `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
            ).all(sessionKey);
            rows.reverse();
            const history = [];
            // Markers prefixing harness-injected user messages that the
            // operator should never see in the chat scrollback. When one
            // of these is found, ALSO skip the next assistant message \u2014
            // it's the agent's acknowledgement of the cancellation /
            // background task / interjection and reads as orphaned chatter
            // without the prompt that triggered it.
            const INTERNAL_PROMPT_PREFIXES = [
              '[BACKGROUND TASK',
              '[You were working on a task',  // stop / cancel
              '[INTERJECTION]',               // user mid-flight follow-up
              '[TASK COMPLETE',               // delegated-task finish
            ];
            let _swallowNextAssistant = false;
            for (const row of rows) {
              let text = row.content;
              try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                  text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                  if (!text) {
                    const toolResults = parsed.filter(b => b.type === 'tool_result');
                    if (toolResults.length) continue;
                    const toolUses = parsed.filter(b => b.type === 'tool_use');
                    if (toolUses.length) { text = toolUses.map(t => '\u2699 ' + t.name).join(', '); }
                  }
                }
              } catch { /* silent: malformed JSON → fallback */ }
              if (!text || !text.trim()) continue;
              const isInternalPrompt = INTERNAL_PROMPT_PREFIXES.some(p => text.startsWith(p));
              if (isInternalPrompt) {
                _swallowNextAssistant = true;
                continue;
              }
              const role = row.role === 'assistant' ? 'assistant' : row.role === 'notification' ? 'notification' : 'user';
              if (role === 'assistant' && _swallowNextAssistant) {
                _swallowNextAssistant = false;
                continue;
              }
              if (role !== 'assistant') _swallowNextAssistant = false;
              history.push({ role, text: text.substring(0, 2000), ts: row.created });
            }
            if (history.length) {
              ws.send(JSON.stringify({ type: 'chat:history', messages: history }));
            }
          }
        } catch (e) { this.log.warn('[ws] Failed to send chat history:', e.message); }

        // Tell reconnecting web clients if the agent is mid-turn so they restore busy state.
        // Skip anon sockets — they have no session of their own to be busy on,
        // and mapping them to operator would make every anonymous visitor
        // appear "busy" whenever the operator has a run going.
        if (ws._user) {
          try {
            const agent = this.tools._agent;
            const userId = ws._user;
            const activeKeys = agent ? [...agent.activeRuns] : [];
            this.log.info(`[ws] Connect: user=${userId}, activeRuns=${activeKeys.length > 0 ? activeKeys.join(',') : 'none'}`);
            if (agent && activeKeys.length > 0) {
              const myKey = `dm:${userId}`;
              const webBusy = activeKeys.includes(myKey);
              if (webBusy) {
                ws.send(JSON.stringify({ type: 'chat:busy' }));
                this.log.info(`[ws] Sent chat:busy to reconnecting client (own session ${myKey} active)`);
              }
            }
          } catch (e) { this.log.warn('[ws] Busy check failed:', e.message); }
        } else {
          this.log.info(`[ws] Connect: user=(anon), activeRuns=(skipped — not authenticated)`);
        }
      }

      // Graph events only for web panel clients, not Acorn
      const onGraphEvent = isAcornClient ? null : (evt) => {
        try { ws.send(JSON.stringify({ type: 'graph:event', ...evt })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
      };
      if (onGraphEvent) graphEvents.on('change', onGraphEvent);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // Plugin WS dispatch — message types of the form `plugin:<pluginId>:<msgType>`
        // route to handlers registered via api.registerWsHandler. The pluginId
        // namespace prevents collisions with built-in types like 'chat:submit'.
        if (typeof msg.type === 'string' && msg.type.startsWith('plugin:')) {
          const mgr = this.tools?._pluginManager;
          const resolved = mgr?.resolveWsHandler?.(msg.type);
          if (resolved) {
            try {
              await resolved.handler(ws, msg, { user: ws._user, sessionId: msg.sessionId, log: this.log });
            } catch (e) {
              this.log.warn(`[plugins] WS handler ${msg.type} threw: ${e.message}`);
            }
            return;
          }
          // Fall through to default unknown-type handling if nothing matched.
        }

        // graphcorn: session:start fires once per acorn launch right
        // after the WS handshake, before the first chat:submit. We
        // create a session-<id> graph node + edge to the project node
        // so everything captured during the conversation has a graph
        // anchor. Idempotent — flaky reconnects re-firing this just
        // bump mentions on the existing node.
        if (msg.type === 'session:start' && msg.sessionId) {
          try {
            const sessions = require('../graph/sessions');
            const r = sessions.upsertSessionNode(this.tools?.learner, {
              sessionId: msg.sessionId,
              userId:    ws._user || msg.userName || 'anon',
              userName:  msg.userName,
              cwd:       msg.cwd,
              startedAt: msg.startedAt,
              model:     this.config.normalModel || this.config.model,
              ...(msg.projectContext || {}),
            });
            if (r) this.log.info(`[graphcorn] session:start → ${r.id}${r.isNew ? ' (new)' : ''}${r.projectId ? ' part_of ' + r.projectId : ''}`);
          } catch (e) {
            this.log.warn(`[graphcorn] session:start failed: ${e.message}`);
          }
          return;
        }
        if (msg.type === 'session:end' && msg.sessionId) {
          try {
            const sessions = require('../graph/sessions');
            sessions.finalizeSessionNode(this.tools?.learner, msg.sessionId, { endedAt: msg.endedAt });
            this.log.info(`[graphcorn] session:end → session-${msg.sessionId}`);
            // Phase 7 + 8: chain summarize → distill. Both fire-and-forget
            // so they don't block the WS close. distillSession is
            // idempotent (extra.distilled_at marker), so if the WS
            // ALSO drops and re-fires distillation from the close
            // handler below, the second call is a no-op.
            const llmClient = this.tools?.anthropicClient;
            if (llmClient) {
              sessions.summarizeSessionNode(this.tools.learner, llmClient, this.config, msg.sessionId, this.log)
                .then(() => sessions.distillSession(this.tools.learner, llmClient, this.config, msg.sessionId, this.log))
                .catch(e => this.log.warn(`[graphcorn] summary/distill error: ${e.message}`));
            }
          } catch (e) {
            this.log.warn(`[graphcorn] session:end failed: ${e.message}`);
          }
          return;
        }

        if (msg.type === 'ping') {
          ws._missedPongs = 0;
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
          return;
        }

        // Answer to an ask_user tool call — resolves the pending promise on
        // the tools side so the agent's tool_result returns cleanly.
        if (msg.type === 'ask_user_answer' && msg.qid && typeof msg.answer === 'string') {
          const ok = this.tools.answerAskUser(msg.qid, msg.answer);
          try { ws.send(JSON.stringify({ type: 'ask_user_answer_ack', qid: msg.qid, ok })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
          return;
        }

        if (msg.type === 'code:save') {
          try {
            const result = this.tools.executeTool('write_file', { path: msg.path, content: msg.content });
            // executeTool may be sync (write_file is sync) or async
            const handleResult = (r) => {
              if (r && r.error) {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: r.error }));
              } else {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, success: true, bytes: r?.bytes }));
                this.log.info(`[code-viewer] User saved ${msg.path} (${msg.content?.length || 0} chars)`);
              }
            };
            if (result && typeof result.then === 'function') {
              result.then(handleResult).catch(e => {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
              });
            } else {
              handleResult(result);
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
          }
          return;
        }

        // ── Acorn: request history for a specific session ──
        if (msg.type === 'chat:history-request' && msg.sessionId) {
          try {
            if (this.tools._sessions) {
              const isAcorn = ws._role === 'acorn';
              const reqSessionId = msg.sessionId;
              const userId = ws._user || 'operator';
              // Use legacy buildKey format to match how processMessage stores messages
              const historyKey = isAcorn
                ? this.tools._sessions.constructor.buildKey(reqSessionId, false, userId)
                : this.tools._sessions.constructor.buildKey(reqSessionId, true, userId);
              const rows = this.tools._sessions.db.prepare(
                `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
              ).all(historyKey);
              rows.reverse();
              const history = [];
              for (const row of rows) {
                let text = row.content;
                try {
                  const parsed = JSON.parse(text);
                  if (Array.isArray(parsed)) {
                    text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                    if (!text) continue;
                  }
                } catch { /* silent: malformed JSON → fallback */ }
                if (!text || !text.trim()) continue;
                const role = row.role === 'assistant' ? 'assistant' : 'user';
                history.push({ role, text: text.substring(0, 2000), ts: row.created });
              }
              ws.send(JSON.stringify({ type: 'chat:history', messages: history, sessionId: reqSessionId }));
              this.log.info(`[ws] History sent for ${reqSessionId}: ${history.length} messages`);
            }
          } catch (e) { this.log.warn('[ws] History request failed:', e.message); }
          return;
        }

        // ── Acorn: observe/unobserve session (companion app) ──
        if (msg.type === 'session:observe' && msg.sessionId) {
          const reqUser = ws._user || '';
          // Validate user owns this session
          if (!msg.sessionId.startsWith(`cli:${reqUser}@`)) {
            ws.send(JSON.stringify({ type: 'session:observe:error', error: 'Access denied' }));
            return;
          }
          this._registerSessionClient(msg.sessionId, ws, 'observer');
          const agent = this.tools._agent;
          const sessionKey = this.tools._sessions.constructor.buildKey(msg.sessionId, false, reqUser);
          const active = agent ? agent.activeRuns.has(sessionKey) : false;
          // Check if the CLI origin client is connected
          let cliConnected = false;
          const sessionClients = this._sessionClients.get(msg.sessionId);
          if (sessionClients) {
            for (const entry of sessionClients) {
              if (entry.ws !== ws && entry.ws.readyState === 1) { cliConnected = true; break; }
            }
          }
          ws.send(JSON.stringify({ type: 'session:observe:ok', sessionId: msg.sessionId, active, cliConnected }));
          // Ask the CLI for its current perm mode so the observer can sync
          const clients = this._sessionClients.get(msg.sessionId);
          if (clients) {
            for (const entry of clients) {
              if (entry.ws !== ws) {
                try { entry.ws.send(JSON.stringify({ type: 'perm:query', replyTo: msg.sessionId })); } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
              }
            }
          }
          this.log.info(`[ws] ${reqUser} observing session ${msg.sessionId}`);
          return;
        }

        if (msg.type === 'session:unobserve' && msg.sessionId) {
          this._unregisterSessionClient(msg.sessionId, ws);
          this.log.info(`[ws] ${ws._user || '?'} stopped observing ${msg.sessionId}`);
          return;
        }

        // ── Acorn: CLI tells us it's waiting for user to approve a tool ──
        if (msg.type === 'tool:awaiting-approval') {
          // Forward to all session observers so they can show [allow]/[deny]
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws && entry.role === 'origin') {
                this._sendToSession(sid, {
                  type: 'tool:awaiting-approval',
                  name: msg.name,
                  summary: msg.summary,
                  dangerous: !!msg.dangerous,
                });
                this.log.info(`[ws] Tool awaiting approval: ${msg.name} (${msg.summary})`);
                break;
              }
            }
          }
          return;
        }

        // ── Acorn: any session client approves/denies a pending tool ──
        if (msg.type === 'tool:approve') {
          // Find a different client in the same session that has _pendingTools (the CLI)
          for (const [sid, clients] of this._sessionClients) {
            let isMember = false;
            let cliWs = null;
            for (const entry of clients) {
              if (entry.ws === ws) isMember = true;
              // The CLI is the one with pending tools (not the sender)
              if (entry.ws !== ws && entry.ws._pendingTools?.size > 0) cliWs = entry.ws;
            }
            if (isMember && cliWs) {
              try {
                cliWs.send(JSON.stringify({
                  type: 'tool:remote-approve',
                  id: msg.id,
                  allowed: !!msg.allowed,
                }));
              } catch (e) { this.log.warn('[web] cliWs.send failed: ' + e.message); }
              this.log.info(`[ws] Remote ${msg.allowed ? 'approve' : 'deny'} for tool from ${ws._user}`);
              break;
            }
          }
          return;
        }

        // ── Acorn: plan decision (execute/revise/cancel) forwarded to other clients ──
        // ── Generic interactive state broadcast — forward to all other session clients ──
        // ── Forward plan:show-approval and interactive:resolved to other session clients ──
        if (msg.type === 'delegate:config' || msg.type === 'state:questions') {
          this._forwardToSessionPeers(ws, msg);
          return;
        }

        if (msg.type === 'plan:show-approval') {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] plan:show-approval forwarded from ${ws._user} to ${n} client(s)`);
          return;
        }

        if (msg.type === 'interactive:resolved') {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] interactive:resolved kind=${msg.kind} from ${ws._user} forwarded to ${n} client(s)`);
          return;
        }

        if (msg.type === 'plan:decision' || msg.type === 'plan:decided') {
          this._forwardToSessionPeers(ws, msg);
          if (msg.type === 'plan:decision') this.log.info(`[ws] Plan ${msg.action} from ${ws._user}`);
          return;
        }

        // ── Acorn: any session client toggles plan mode ──
        if (msg.type === 'plan:set-mode') {
          this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] Remote plan mode ${msg.enabled ? 'on' : 'off'} from ${ws._user}`);
          return;
        }

        // ── Acorn: CLI responds with its current perm mode ──
        if (msg.type === 'perm:current-mode' && msg.mode) {
          this._forwardToSessionPeers(ws, msg);
          return;
        }

        // ── Acorn: any session client changes CLI permission mode ──
        if (msg.type === 'perm:set-mode' && msg.mode) {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] Remote perm mode change to ${msg.mode} from ${ws._user}, forwarded to ${n} client(s), sessionId=${msg.sessionId || 'none'}`);
          return;
        }

        // ── Acorn: tool result from CLI client ──
        // ── CLI acknowledges it received a tool:request ──
        if (msg.type === 'tool:ack' && msg.id) {
          const pending = ws._pendingTools?.get(msg.id);
          if (pending) {
            pending.acked = true;
            if (pending.ackTimeout) clearTimeout(pending.ackTimeout);
          }
          return;
        }

        if (msg.type === 'tool:result') {
          const pending = ws._pendingTools?.get(msg.id);
          if (pending) {
            if (pending.ackTimeout) clearTimeout(pending.ackTimeout);
            clearTimeout(pending.timeout);
            ws._pendingTools.delete(msg.id);
            pending.resolve(msg.result);
            // Notify observers the tool was resolved
            const denied = msg.result && msg.result.error && /denied|blocked/i.test(msg.result.error);
            // Find which session this ws belongs to, notify observers
            for (const [sid, clients] of this._sessionClients) {
              for (const entry of clients) {
                if (entry.ws === ws) {
                  this._sendToSession(sid, { type: 'tool:resolved', id: msg.id, denied: !!denied });
                  break;
                }
              }
            }
          }
          return;
        }

        if (msg.type === 'chat:stop') {
          if (this.tools._agent) {
            const userId = ws._user || 'operator';
            const sessionId = msg.sessionId || 'web:control-panel';
            const isAcorn = ws._role === 'acorn';
            const stopped = isAcorn
              ? this.tools._agent.abortSession(sessionId, false, userId)
              : this.tools._agent.abortSession('web:control-panel', true, userId);
            this.log.info(`[ws] Stop requested for ${userId} — ${stopped ? 'aborted' : 'no active run'}`);
            if (stopped) {
              try { ws.send(JSON.stringify({ type: 'chat:status', status: 'stopping' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              // Reject any pending tool Promises on the CLI's WebSocket so the
              // agent loop breaks out immediately instead of waiting 3 minutes
              const originWs = isAcorn ? this._getOriginClient(sessionId) : null;
              if (originWs && originWs._pendingTools?.size > 0) {
                for (const [toolId, entry] of originWs._pendingTools) {
                  clearTimeout(entry.timeout);
                  entry.resolve({ error: 'Aborted by user.' });
                }
                originWs._pendingTools.clear();
                this.log.info(`[ws] Rejected pending tool(s) for abort`);
              }
            }
          }
          return;
        }

        if (msg.type === 'chat:clear') {
          if (this.tools._sessions) {
            const userId = ws._user || 'operator';
            const isAcorn = ws._role === 'acorn';
            const clearSessionId = msg.sessionId || 'web:control-panel';
            const clearKey = isAcorn
              ? this.tools._sessions.constructor.buildKey(clearSessionId, false, userId)
              : this.tools._sessions.constructor.buildKey('web:control-panel', true, userId);
            this.tools._sessions.clearSession(clearKey);
            ws.send(JSON.stringify({ type: 'chat:cleared' }));
            this.log.info(`[ws] Chat history cleared by ${userId}${isAcorn ? ` (acorn: ${clearSessionId})` : ''}`);
          }
          return;
        }

        if (msg.type === 'chat') {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'chat:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = msg.sessionId || 'web:control-panel';
          const isAcorn = ws._role === 'acorn';
          // If auth is required (webapp users exist or manager URL is set), refuse
          // anonymous chat — otherwise every user's messages collapse into the same
          // 'dm:operator' session and the agent can't tell them apart.
          let hasWebappUsers = false;
          try {
            const wuPath = path.join(this.config.dataDir, 'webapp-users.json');
            hasWebappUsers = fs.existsSync(wuPath) && JSON.parse(fs.readFileSync(wuPath, 'utf8')).length > 0;
          } catch (e) { this.log.warn('[web] path.join failed: ' + e.message); }
          const requiresChatAuth = hasWebappUsers || !!this.config.managerUrl || !!(this.config.webAuthUser && this.config.webAuthPass);
          if (requiresChatAuth && !isAcorn && !ws._user) {
            this.log.warn(`[ws] chat refused — no authenticated user on this connection (token=${ws._sessionToken ? 'stale' : 'missing'})`);
            ws.send(JSON.stringify({ type: 'chat:error', error: 'Session expired — reload the page and log in again.', code: 'auth-required' }));
            return;
          }
          this.log.info(`[ws] chat from user=${ws._user || '(anon)'} role=${ws._role || '(none)'} displayName=${(msg.userName || '').slice(0, 40)} sessionId=${sessionId}`);

          // Store the client's working directory (sent by Acorn CLI)
          if (msg.cwd && isAcorn) ws._cwd = msg.cwd;

          // Register this client for the session.
          // If the client is already an observer (companion app), keep that role —
          // don't promote to origin or it will evict the CLI's origin registration.
          if (isAcorn) {
            const existingClients = this._sessionClients.get(sessionId);
            let isObserver = false;
            if (existingClients) {
              for (const entry of existingClients) {
                if (entry.ws === ws && entry.role === 'observer') { isObserver = true; break; }
              }
            }
            if (!isObserver) {
              this._registerSessionClient(sessionId, ws, 'origin');
            }
            // Echo user message to all OTHER session clients so observers see it
            // Use displayText (clean user text) if available, not content (which includes context/delegation policy)
            const clients = this._sessionClients.get(sessionId);
            if (clients) {
              const echoPayload = JSON.stringify({
                type: 'chat:user-message',
                text: (msg.displayText || msg.content || '').substring(0, 2000),
                userName: ws._user || msg.userName || 'user',
                sessionId,
              });
              for (const { ws: c } of clients) {
                if (c !== ws && c.readyState === 1) {
                  try { c.send(echoPayload); } catch (e) { this.log.warn('[web] c.send failed: ' + e.message); }
                }
              }
            }
          }

          try {
            // Acorn fans out to all session clients (CLI + observer mobile apps).
            // Web users are isolated — chat:start only goes to the sending socket.
            if (!isAcorn) {
              try { ws.send(JSON.stringify({ type: 'chat:start', sessionId })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
            } else {
              this._sendToSession(sessionId, { type: 'chat:start', sessionId });
            }
            const images = Array.isArray(msg.images) ? msg.images.map(img => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data },
            })) : undefined;
            const media = Array.isArray(msg.files) ? msg.files.flatMap(f => {
              const mediaType = String(f.mediaType || '').toLowerCase();
              if (mediaType.startsWith('audio/')) {
                return [{
                  type: 'audio',
                  source: {
                    type: 'base64',
                    media_type: f.mediaType || 'application/octet-stream',
                    data: f.data,
                    filename: f.name || 'audio-input',
                  },
                }];
              }
              if (mediaType.startsWith('video/')) {
                return [{
                  type: 'video',
                  source: {
                    type: 'base64',
                    media_type: f.mediaType || 'application/octet-stream',
                    data: f.data,
                    filename: f.name || 'video-input',
                  },
                }];
              }
              return [];
            }) : undefined;
            // Save non-image file attachments to disk
            let fileNote = '';
            if (Array.isArray(msg.files) && msg.files.length > 0) {
              const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
              try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { this.log.warn('[web] fs.mkdirSync failed: ' + e.message); }
              const savedFiles = [];
              for (const f of msg.files) {
                try {
                  const safeName = (f.name || `file-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                  const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
                  fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
                  savedFiles.push(filePath);
                  this.log.info(`[upload] Saved file to ${filePath}`);
                } catch (e) { this.log.warn(`[upload] Failed: ${e.message}`); }
              }
              if (savedFiles.length) fileNote = `\n[Attached files saved to disk: ${savedFiles.join(', ')}]`;
            }

            // For Acorn: find the origin CLI client for tool execution.
            // If an observer (mobile app) sends a message, tools still go to the CLI.
            const originWs = isAcorn ? (this._getOriginClient(sessionId) || ws) : null;

            // Debug: log the projectContext.mode acorn sent so we can
            // tell whether "plan mode didn't behave as plan mode" is a
            // client-side bug (mode not sent) or server-side (mode
            // sent but prompt didn't activate).
            if (isAcorn) {
              const mode = msg.projectContext?.mode || '(none)';
              const hasPC = msg.projectContext ? 'yes' : 'no';
              this.log.info(`[acorn-chat] sessionId=${sessionId} projectContext=${hasPC} mode=${mode} content=${JSON.stringify((msg.content || '').slice(0, 80))}`);
            }

            // Plan-mode reminder — when acorn signals plan mode via
            // projectContext.mode='plan', prepend a tiny inline marker
            // onto the user's message. The full PLAN_PREFIX block lives
            // in the system prompt (prompt-sections.js), but the model
            // pays much more attention to instructions adjacent to the
            // user's actual content. Python glued the entire 1KB prefix;
            // we keep that signal-strength advantage with ~150 bytes.
            // The marker also makes it impossible to miss in the
            // session log when debugging "did the agent know it was
            // in plan mode?".
            let userContent = msg.content + fileNote;
            if (isAcorn && msg.projectContext && msg.projectContext.mode === 'plan') {
              userContent = '[PLAN MODE — read ## Plan Mode in your system prompt before responding. Do NOT call write_file/edit_file/exec mutating commands. End with `PLAN_READY` (after PHASE 5) OR a `QUESTIONS:` block (during PHASE 4). Vague request ⇒ ASK.]\n\n' + userContent;
            }

            const agentOpts = {
              content: userContent,
              channelId: sessionId,
              channelName: isAcorn ? `acorn:${ws._user}` : 'control-panel',
              // userId is server-trusted (from the authenticated WS session)
              // to prevent spoofing another user's conversation. The client's
              // msg.userId is ignored — only ws._user matters.
              userId: ws._user || 'operator',
              // userName is a display string only; client-chosen is fine.
              userName: msg.userName || ws._user || 'Operator',
              // Role comes from the WS session (server-trusted). The agent
              // uses this to decide what it will / won't agree to do for
              // non-creator users.
              userRole: ws._role || (isAcorn ? 'acorn' : 'creator'),
              sessionToken: ws._sessionToken || null,
              trigger: 'dm',
              platform: isAcorn ? 'cli' : 'web',
              isDm: !isAcorn,
              clientCwd: ws._cwd || null,
              // projectContext is the structured project metadata acorn sends
              // on every chat:submit. The agent loop routes this into the
              // SYSTEM PROMPT instead of the user message — so the project
              // info doesn't accumulate in messages[] across turns. Old
              // acorn builds don't send this field; we just pass undefined
              // and the prompt builder skips the section.
              projectContext: msg.projectContext || null,
              images,
              media,
              onTextDelta: (delta) => {
                if (isAcorn) {
                  this._sendToSession(sessionId, { type: 'chat:delta', text: delta });
                } else {
                  try { ws.send(JSON.stringify({ type: 'chat:delta', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
                }
              },
              onThinkingDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'chat:thinking', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
              onToolUse: (toolName) => {
                if (isAcorn) {
                  this._sendToSession(sessionId, { type: 'chat:tool', tool: toolName });
                } else {
                  try { ws.send(JSON.stringify({ type: 'chat:tool', tool: toolName })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
                }
              },
              onStatus: (evt) => {
                try {
                  const payload = evt.type?.startsWith('code:') ? evt
                    : { type: 'chat:status', status: evt.type, ...Object.fromEntries(Object.entries(evt).filter(([k]) => k !== 'type')) };
                  if (isAcorn) {
                    this._sendToSession(sessionId, payload);
                  } else {
                    ws.send(JSON.stringify(payload));
                  }
                } catch (e) { this.log.warn('[web] startsWith failed: ' + e.message); }
              },
              // Acorn: forward tool calls to the origin CLI client for local execution.
              // tool:request only goes to origin client. Observers get tool:pending notification.
              onToolExecute: isAcorn ? async (toolName, toolInput, toolId) => {
                // Notify observers that a tool is awaiting approval/execution
                const summary = toolName === 'exec' ? (toolInput?.command || '').substring(0, 120)
                  : toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file' ? (toolInput?.path || '')
                  : toolName === 'web_fetch' ? (toolInput?.url || '').substring(0, 100)
                  : JSON.stringify(toolInput || {}).substring(0, 80);
                this._sendToSession(sessionId, {
                  type: 'tool:pending', id: toolId, name: toolName, summary,
                });

                // Check if CLI is actually reachable before waiting
                if (!originWs || originWs.readyState !== 1) {
                  this.log.warn(`[ws] CLI disconnected, falling back to server for ${toolName}`);
                  return null; // server fallback
                }

                try {
                  originWs.send(JSON.stringify({ type: 'tool:request', id: toolId, name: toolName, input: toolInput }));
                } catch (e) {
                  this.log.warn(`[ws] Failed to send tool:request to CLI: ${e.message}`);
                  return null; // server fallback
                }

                return new Promise((resolve, reject) => {
                  // Hard timeout for the actual tool execution (3 min)
                  // No ack-based server fallback — local tools MUST go through CLI.
                  // The server doesn't have the user's files.
                  const hardTimeout = setTimeout(() => {
                    originWs._pendingTools.delete(toolId);
                    reject(new Error(`Tool ${toolName} timed out (3min)`));
                  }, 180000);

                  originWs._pendingTools.set(toolId, { resolve, reject, timeout: hardTimeout });
                });
              } : undefined,
            };

            let result = await this.tools._agent.processMessage(agentOpts);

            // Handle interjection: session was busy, try to inject into running loop
            if (result.skipped) {
              const userId = ws._user || 'operator';
              const waitKey = this.tools._sessions.constructor.buildKey(
                isAcorn ? sessionId : 'web:control-panel', !isAcorn, userId
              );

              const injected = this.tools._agent.interject(waitKey, msg.content + fileNote);
              if (injected) {
                // Loop will pick it up on next iteration — notify client and return
                this.log.info(`[ws] Interjection accepted for ${sessionId}`);
                const payload = { type: 'chat:status', status: 'interjected' };
                if (isAcorn) { this._sendToSession(sessionId, payload); }
                else { try { ws.send(JSON.stringify(payload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                return; // Don't send chat:done — the running loop handles completion
              }

              // Injection failed (loop is aborting after Ctrl+C) — wait for release + retry
              this.log.info(`[ws] Interjection failed (aborting?), waiting for session release: ${sessionId}`);
              const statusPayload = { type: 'chat:status', status: 'waiting' };
              if (isAcorn) { this._sendToSession(sessionId, statusPayload); }
              else { try { ws.send(JSON.stringify(statusPayload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }

              try {
                await Promise.race([
                  this.tools._agent.waitForSession(waitKey),
                  new Promise((_, rej) => setTimeout(() => rej(new Error('Interjection wait timed out')), 15000)),
                ]);
                // Re-send chat:start for the retry
                if (isAcorn) { this._sendToSession(sessionId, { type: 'chat:start', sessionId }); }
                else { try { ws.send(JSON.stringify({ type: 'chat:start', sessionId })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                result = await this.tools._agent.processMessage(agentOpts);
              } catch (waitErr) {
                this.log.error(`[ws] Interjection wait failed: ${waitErr.message}`);
                const errPayload = { type: 'chat:error', error: 'Session busy — try again in a moment' };
                if (isAcorn) { this._sendToSession(sessionId, errPayload); }
                else { try { ws.send(JSON.stringify(errPayload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                return;
              }
            }

            // Send chat:done to all session clients (CLI + observers)
            const donePayload = {
              type: 'chat:done',
              text: result.text,
              usage: result.usage,
              iterations: result.iterations,
              toolUsage: result.toolUsage,
            };
            if (isAcorn) {
              this._sendToSession(sessionId, donePayload);
            } else {
              ws.send(JSON.stringify(donePayload));
            }
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:chat',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result.text,
                trigger: 'dm',
                usage: result.usage,
                iterations: result.iterations,
              });
            } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          } catch (e) {
            const friendly = e.status === 529 || e.error?.type === 'overloaded_error' ? 'API is overloaded — try again in a moment'
              : e.status === 500 || e.error?.type === 'api_error' ? 'API server error — try again shortly'
                : e.status === 429 ? 'Rate limited — too many requests, wait a moment'
                  : (e.error?.error?.message || e.message || 'Unknown error').substring(0, 200);
            if (isAcorn) {
              this._sendToSession(sessionId, { type: 'chat:error', error: friendly });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', error: friendly }));
            }
          }
        } else if (msg.type === 'voice-chat') {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = 'web:voice-call';
          try {
            ws.send(JSON.stringify({ type: 'voice:user-text', text: msg.content }));
            ws.send(JSON.stringify({ type: 'voice:thinking' }));
            const result = await this.tools._agent.processMessage({
              content: msg.content,
              channelId: sessionId, channelName: 'voice-call',
              userId: ws._user || 'operator',
              userName: msg.userName || ws._user || 'Operator',
              userRole: ws._role || 'creator',
              trigger: 'dm', platform: 'web', isDm: true,
              onTextDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'voice:delta', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
              onToolUse: (toolName) => {
                try { ws.send(JSON.stringify({ type: 'voice:tool', tool: toolName })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
            });
            const resp = {
              type: 'voice:response', transcription: null, text: result?.text,
              usage: result?.usage, toolUsage: result?.toolUsage, iterations: result?.iterations,
            };
            const pipeline = this._ensureVoicePipeline();
            if (pipeline && result?.text && result.text.trim() !== 'NO_REPLY') {
              try {
                const ttsResult = await pipeline.synthesizeOnly(result.text);
                if (ttsResult.audio) {
                  resp.audio = ttsResult.audio.toString('base64');
                  resp.audioMime = 'audio/mp3';
                }
              } catch (e) { this.log.warn('[voice-chat] TTS failed:', e.message); }
            }
            ws.send(JSON.stringify(resp));
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:voice',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result?.text,
                trigger: 'voice',
                usage: result?.usage,
                iterations: result?.iterations,
              });
            } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured (need TTS/STT keys)' }));
            return;
          }
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          try {
            const audioData = Buffer.from(msg.audio, 'base64');
            const mime = msg.mimeType || 'audio/webm';
            ws.send(JSON.stringify({ type: 'voice:transcribing' }));

            if (msg.mode === 'call') {
              const sessionId = 'web:voice-call';
              const sttFirst = await pipeline.transcribeOnly(audioData, mime);
              if (sttFirst.error || !sttFirst.text?.trim()) {
                if (sttFirst.error) ws.send(JSON.stringify({ type: 'voice:error', error: sttFirst.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:user-text', text: sttFirst.text }));
              ws.send(JSON.stringify({ type: 'voice:thinking' }));
              const result = await pipeline.processFromText(sttFirst.text, this.tools._agent, {
                channelId: sessionId, channelName: 'voice-call',
                userId: msg.userId || ws._user || 'operator',
                userName: msg.userName || ws._user || 'Operator',
                userRole: ws._role || 'creator',
                trigger: 'dm', platform: 'web', isDm: true,
              });
              const resp = {
                type: 'voice:response', transcription: null, text: result.responseText,
                usage: result.usage, toolUsage: result.toolUsage, iterations: result.iterations,
              };
              if (result.audioBuffer) {
                resp.audio = result.audioBuffer.toString('base64');
                resp.audioMime = 'audio/mp3';
              }
              if (result.error) resp.error = result.error;
              ws.send(JSON.stringify(resp));
              try {
                const feed = require('../graph/feed');
                feed.log({
                  channelName: 'web:voice',
                  userName: msg.userName || 'Operator',
                  userMessage: sttFirst.text,
                  myResponse: result.responseText,
                  trigger: 'voice',
                  usage: result.usage,
                  iterations: result.iterations,
                });
              } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
            } else if (msg.mode === 'interrupt-check') {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              ws.send(JSON.stringify({ type: 'voice:interrupt-result', text: sttResult.text || '', error: sttResult.error }));
            } else {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              if (sttResult.error) {
                ws.send(JSON.stringify({ type: 'voice:error', error: sttResult.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:transcription', text: sttResult.text }));
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice:tts') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured' }));
            return;
          }
          try {
            const result = await pipeline.synthesizeOnly(msg.text);
            if (result.error || !result.audio) {
              ws.send(JSON.stringify({ type: 'voice:error', error: result.error || 'TTS returned no audio' }));
              return;
            }
            ws.send(JSON.stringify({
              type: 'voice:audio',
              audio: result.audio.toString('base64'),
              audioMime: 'audio/mp3',
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }

          // ── Terminal messages ──────────────────────────────────────────
        } else if (msg.type === 'terminal:open') {
          if (!ws._terminals) ws._terminals = new Map();
          this._handleTerminalOpen(ws, msg);
        } else if (msg.type === 'terminal:data') {
          this._handleTerminalData(ws, msg);
        } else if (msg.type === 'terminal:resize') {
          this._handleTerminalResize(ws, msg);
        } else if (msg.type === 'terminal:close') {
          this._handleTerminalClose(ws, msg);
        } else if (msg.type === 'terminal:hosts:list') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:hosts', hosts: [] })); return; }
          mgr.listHosts().then(hosts => ws.send(JSON.stringify({ type: 'terminal:hosts', hosts })));
        } else if (msg.type === 'terminal:hosts:save') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.saveHost(msg).then(result => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', ...result })))
            .catch(e => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', error: e.message })));
        } else if (msg.type === 'terminal:hosts:delete') {
          const mgr = this._ensureSSHManager();
          if (mgr) mgr.deleteHost(msg.id).then(() => ws.send(JSON.stringify({ type: 'terminal:hosts:deleted', id: msg.id })));
        } else if (msg.type === 'terminal:hosts:test') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.testConnection(msg.id).then(r => {
            ws.send(JSON.stringify({ type: 'terminal:hosts:tested', id: msg.id, ...r }));
          });
        } else if (msg.type === 'terminal:keystore:status') {
          const mgr = this._ensureSSHManager();
          ws.send(JSON.stringify({
            type: 'terminal:keystore:status',
            unlocked: mgr?.keystoreUnlocked || false,
            source: mgr?.keystoreSource || null,
          }));
        } else if (msg.type === 'terminal:keystore:unlock') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          try {
            mgr.unlockKeystore(msg.passphrase);
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: true }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: false, error: e.message }));
          }
        } else if (msg.type === 'terminal:keystore:lock') {
          const mgr = this._ensureSSHManager();
          if (mgr) mgr.lockKeystore();
          ws.send(JSON.stringify({ type: 'terminal:keystore:status', unlocked: false, source: null }));
        }
      });

      ws.on('close', () => {
        // If this CLI had pending tools, save them for re-send on reconnect
        if (ws._role === 'acorn' && ws._pendingTools?.size > 0) {
          const pending = [];
          for (const [toolId, entry] of ws._pendingTools) {
            pending.push({ toolId, resolve: entry.resolve, reject: entry.reject, timeout: entry.timeout });
          }
          // Find which session this ws belongs to
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws) {
                if (!this._orphanedTools) this._orphanedTools = new Map();
                const existing = this._orphanedTools.get(sid) || [];
                existing.push(...pending);
                this._orphanedTools.set(sid, existing);
                this.log.info(`[ws] CLI disconnected with ${pending.length} pending tool(s) for ${sid} — saved for reconnect`);
                break;
              }
            }
          }
        }

        // graphcorn Phase 8: ungraceful close also triggers distillation.
        // The graceful path (session:end frame) sets distilled_at first;
        // distillSession's idempotency guard makes the close-side call a
        // no-op when graceful already ran. For network drop / SIGKILL /
        // alt-tab-and-leave-it, the session:end never arrives and this
        // is the only chance to distill before the 48h janitor sweep.
        if (ws._role === 'acorn') {
          const acornSessionIds = new Set();
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws) acornSessionIds.add(sid);
            }
          }
          if (acornSessionIds.size > 0) {
            const sessions = require('../graph/sessions');
            const llmClient = this.tools?.anthropicClient;
            for (const sid of acornSessionIds) {
              try {
                sessions.finalizeSessionNode(this.tools?.learner, sid, { endedAt: new Date().toISOString() });
                if (llmClient) {
                  // Same chain as the graceful path — summarize, then
                  // distill. Both functions short-circuit if the prior
                  // session:end already ran them.
                  sessions.summarizeSessionNode(this.tools.learner, llmClient, this.config, sid, this.log)
                    .then(() => sessions.distillSession(this.tools.learner, llmClient, this.config, sid, this.log))
                    .catch(e => this.log.warn(`[graphcorn] ws-close distill error: ${e.message}`));
                }
              } catch (e) {
                this.log.warn(`[graphcorn] ws-close finalize failed: ${e.message}`);
              }
            }
          }
        }

        this._removeClientFromAllSessions(ws);
        if (onGraphEvent) graphEvents.off('change', onGraphEvent);
        if (ws._terminals) {
          for (const [, sess] of ws._terminals) {
            if (sess.pty) { try { sess.pty.kill(); } catch (e) { this.log.warn('[web] sess.pty.kill failed: ' + e.message); } }
            if (sess.sshId) { try { this._sshManager?.close(sess.sshId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); } }
          }
          ws._terminals.clear();
        }
        this.log.info('[ws] Client disconnected from control panel');
      });
    });
  }

  // ── SSH Manager ─────────────────────────────────────────────────────

  _ensureSSHManager() {
    if (this._sshManager) return this._sshManager;
    if (this.tools?._sshManager) { this._sshManager = this.tools._sshManager; return this._sshManager; }
    try {
      const { SSHManager } = require('../tools/ssh-manager');
      this._sshManager = new SSHManager(this.config, this.log);
      return this._sshManager;
    } catch (e) {
      this.log.warn(`[ssh] SSHManager init failed: ${e.message}`);
      return null;
    }
  }

  // ── Terminal Handlers ───────────────────────────────────────────────

  _handleTerminalOpen(ws, msg) {
    const hostId = msg.hostId;
    const paneId = msg.paneId || 'default';

    const existing = ws._terminals?.get(paneId);
    if (existing) {
      existing._cancelled = true;
      if (existing.pty) { try { existing.pty.kill(); } catch (e) { this.log.warn('[web] existing.pty.kill failed: ' + e.message); } }
      if (existing.sshId) { try { this._sshManager?.close(existing.sshId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); } }
      ws._terminals.delete(paneId);
    }

    if (!hostId || hostId === 'local') {
      try {
        const pty = require('node-pty');
        const shell = process.env.SHELL || '/bin/bash';
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;
        const term = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: this.config.workspacePath || process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color', HOME: process.env.HOME || process.cwd() },
        });

        ws._terminals.set(paneId, { pty: term, sshId: null });
        this.log.info(`[terminal] Local PTY opened: pane=${paneId} pid=${term.pid}`);
        const mgr = this._ensureSSHManager();
        mgr?.audit(`local_${term.pid}`, 'pty_opened', { shell, paneId });

        term.onData((data) => {
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        });

        term.onExit(({ exitCode }) => {
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: `Shell exited (code ${exitCode})` })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        });

        ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'local', pid: term.pid }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `Failed to open local terminal: ${e.message}` }));
      }
    } else {
      const mgr = this._ensureSSHManager();
      if (!mgr) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: 'SSH manager not available' }));
        return;
      }

      const placeholder = { pty: null, sshId: null, _cancelled: false };
      ws._terminals.set(paneId, placeholder);

      const result = mgr.connect(hostId, {
        onReady: (sessionId) => {
          if (placeholder._cancelled) {
            try { this._sshManager?.close(sessionId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); }
            this.log.info(`[terminal] SSH session ${sessionId} arrived for replaced pane=${paneId}, closing orphan`);
            return;
          }
          placeholder.sshId = sessionId;
          ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'ssh', sessionId, hostId }));
          this.log.info(`[terminal] SSH session opened: pane=${paneId} session=${sessionId}`);
        },
        onData: (data) => {
          if (placeholder._cancelled) return;
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        },
        onClose: () => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'SSH connection closed' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        },
        onError: (error) => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `SSH error: ${error}` }));
        },
      });

      if (result.error) {
        ws._terminals.delete(paneId);
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: result.error }));
      }
    }
  }

  _handleTerminalData(ws, msg) {
    const paneId = msg.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.write(msg.data);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.write(sess.sshId, msg.data);
    }
  }

  _handleTerminalResize(ws, msg) {
    const paneId = msg.paneId || 'default';
    const cols = msg.cols || 80;
    const rows = msg.rows || 24;
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.resize(cols, rows);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.resize(sess.sshId, cols, rows);
    }
  }

  _handleTerminalClose(ws, msg) {
    const paneId = msg?.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (sess) {
      if (sess.pty) { try { sess.pty.kill(); } catch (e) { this.log.warn('[web] sess.pty.kill failed: ' + e.message); } }
      if (sess.sshId && this._sshManager) { this._sshManager.close(sess.sshId); }
      ws._terminals.delete(paneId);
    }
    ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'Closed by user' }));
  }

  // ── Secure API Key Proxy ────────────────────────────────────────────

  _loadApiProxyConfig() {
    const workspace = this.config.workspacePath || process.cwd();
    const configPath = path.join(workspace, 'web', '.api-proxy.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.routes || typeof config.routes !== 'object') return null;
      return config;
    } catch { return null; }
  }

  _matchProxyRoute(proxyRoute, config, req) {
    for (const [name, route] of Object.entries(config.routes)) {
      if (proxyRoute === name || proxyRoute.startsWith(name + '/')) {
        if (route.methods && !route.methods.includes(req.method)) continue;
        return { name, route, remainder: proxyRoute.slice(name.length) };
      }
    }
    return null;
  }

  async _fetchVaultKey(keyName) {
    const managerUrl = this.config.managerUrl;
    const serviceKey = this.config.managerServiceKey;
    if (!managerUrl || !serviceKey) return null;

    if (!this._vaultCache) this._vaultCache = new Map();
    const cached = this._vaultCache.get(keyName);
    if (cached && Date.now() - cached.ts < 300_000) return cached.value;

    try {
      const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
      const val = await new Promise((resolve) => {
        const req = http_.get(`${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}`, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': this.config.agentId || 'unknown' },
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) { resolve(null); return; }
            try { resolve(JSON.parse(data).value || null); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (val) this._vaultCache.set(keyName, { value: val, ts: Date.now() });
      return val;
    } catch { return null; }
  }

  async _handleApiProxy(req, res, matched, proxyRoute) {
    const { name, route, remainder } = matched;
    if (!route.target) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy route "${name}" has no target URL` }));
      return;
    }

    try {
      const targetUrl = new URL(remainder || '/', route.target);

      // Forward query params from original request
      const origUrl = new URL(req.url, 'http://localhost');
      for (const [k, v] of origUrl.searchParams) targetUrl.searchParams.append(k, v);

      // Build headers: start with allowed incoming headers, then inject key headers
      const headers = {};
      const forwardHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding'];
      for (const h of forwardHeaders) { if (req.headers[h]) headers[h] = req.headers[h]; }

      // Inject API keys from vault or env vars — the core security feature
      if (route.headers && typeof route.headers === 'object') {
        for (const [headerName, headerVal] of Object.entries(route.headers)) {
          if (typeof headerVal === 'string' && headerVal.includes('$VAULT:')) {
            const vaultKeyName = headerVal.match(/\$VAULT:([A-Z_][A-Z0-9_]*)/)?.[1];
            if (!vaultKeyName) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Invalid $VAULT reference in proxy route "${name}"` }));
              return;
            }
            const vaultVal = await this._fetchVaultKey(vaultKeyName);
            if (!vaultVal) {
              const envFallback = process.env[vaultKeyName];
              if (!envFallback) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Vault key ${vaultKeyName} not found for proxy route "${name}"` }));
                return;
              }
              headers[headerName] = headerVal.replace(`$VAULT:${vaultKeyName}`, envFallback);
            } else {
              headers[headerName] = headerVal.replace(`$VAULT:${vaultKeyName}`, vaultVal);
            }
          } else if (typeof headerVal === 'string' && headerVal.startsWith('$')) {
            const envKey = headerVal.slice(1);
            const envVal = process.env[envKey];
            if (!envVal) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Env var ${envKey} not set for proxy route "${name}"` }));
              return;
            }
            headers[headerName] = envVal;
          } else {
            headers[headerName] = headerVal;
          }
        }
      }

      // Collect request body for non-GET
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => { chunks.push(c); if (chunks.reduce((s, b) => s + b.length, 0) > 5_000_000) reject(new Error('Body too large')); });
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }

      const fetchOpts = { method: req.method, headers };
      if (body) fetchOpts.body = body;
      fetchOpts.signal = AbortSignal.timeout(route.timeout || 30000);

      const upstream = await fetch(targetUrl.toString(), fetchOpts);

      // Stream response back, stripping CORS (we control it)
      const respHeaders = {};
      for (const [k, v] of upstream.headers) {
        if (k.toLowerCase() !== 'access-control-allow-origin') respHeaders[k] = v;
      }
      respHeaders['access-control-allow-origin'] = '*';
      res.writeHead(upstream.status, respHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        const buf = await upstream.arrayBuffer();
        res.end(Buffer.from(buf));
      }

      this.log.debug(`[api-proxy] ${req.method} ${name}${remainder} → ${upstream.status}`);
    } catch (e) {
      this.log.warn(`[api-proxy] Proxy error for "${name}": ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy failed: ${e.message}` }));
      }
    }
  }

  // ── Graph API Handlers ──────────────────────────────────────────────

  async _handleMultiGraphApi(req, res, urlPath) {
    const registry = this.tools._graphRegistry;
    if (!registry) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Multi-graph registry not available' }));
      return;
    }

    const jsonBody = () => new Promise((resolve, reject) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 65536) { req.destroy(); reject(new Error('Too large')); } });
      req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    const jsonRes = (data, status = 200) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (urlPath === '/api/graphs' && req.method === 'GET') {
      const graphs = registry.list();
      return jsonRes({ graphs });
    }

    if (urlPath === '/api/graphs' && req.method === 'POST') {
      try {
        const { name, description } = await jsonBody();
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return jsonRes({ error: 'Name is required' }, 400);
        }
        const slug = registry.create(name.trim(), description || '');
        return jsonRes({ ok: true, slug, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    const match = urlPath.match(/^\/api\/graphs\/([a-z0-9-]+)(\/(.+))?$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const slug = match[1];
    const action = match[3] || null;

    if (action === 'activate' && req.method === 'POST') {
      try {
        const result = this.tools.switchGraph(slug);
        graphEvents.emit('change', { op: 'graph:switched', slug, source: 'multi-graph' });
        return jsonRes({ ok: true, ...result });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (action === 'duplicate' && req.method === 'POST') {
      try {
        const { name } = await jsonBody();
        if (!name) return jsonRes({ error: 'Name is required' }, 400);
        const newSlug = registry.duplicate(slug, name.trim());
        return jsonRes({ ok: true, slug: newSlug, graph: registry.get(newSlug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'PUT') {
      try {
        const { name, description } = await jsonBody();
        if (name) registry.rename(slug, name.trim());
        if (description !== undefined) registry.describe(slug, description);
        return jsonRes({ ok: true, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'DELETE') {
      try {
        registry.delete(slug);
        return jsonRes({ ok: true });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'GET') {
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      registry.refreshStats(slug);
      return jsonRes({ graph: { ...registry.get(slug), active: slug === registry.getActiveSlug() } });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown multi-graph endpoint' }));
  }

  async _handleGraphApiOnWeb(req, res, urlPath, db) {
    if (!db) { res.writeHead(503); res.end(JSON.stringify({ error: 'Graph database not available' })); return; }

    const MAX_BODY = 1024 * 256;
    const json = () => new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; if (b.length > MAX_BODY) { req.destroy(); reject(new Error('Request body too large')); } }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });

    if (urlPath === '/api/graph' && req.method === 'GET') {
      try {
        const nodes = db.prepare('SELECT * FROM nodes').all();
        const edges = db.prepare('SELECT source, target, type, weight FROM edges').all();
        const aspects = db.prepare('SELECT * FROM aspects').all();
        const attrs = db.prepare('SELECT * FROM attributes').all();
        const aliases = db.prepare('SELECT * FROM aliases').all();
        const attrsByAspect = {};
        for (const a of attrs) { (attrsByAspect[a.aspect_id] ||= []).push({ id: a.id, content: a.content, importance: a.importance, eventDate: a.event_date || null }); }
        const aspectsByNode = {};
        for (const a of aspects) { (aspectsByNode[a.node_id] ||= []).push({ id: a.id, name: a.name, weight: a.weight, attributes: attrsByAspect[a.id] || [] }); }
        const aliasesByNode = {};
        for (const a of aliases) { (aliasesByNode[a.node_id] ||= []).push(a.alias); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          nodes: nodes.map(n => {
            let extra = null;
            try { if (n.extra && n.extra !== '{}') extra = JSON.parse(n.extra); } catch { /* silent: malformed JSON → fallback */ }
            return { id: n.id, label: n.label, type: n.type, description: n.description || '', importance: n.importance, mentions: n.mentions || 0, aliases: aliasesByNode[n.id] || [], aspects: aspectsByNode[n.id] || [], extra };
          }),
          edges: edges.map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight || 1 })),
          meta: { nodeCount: nodes.length, edgeCount: edges.length },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Maintainer on-demand + status ──
    if (urlPath === '/api/maintainer/run' && req.method === 'POST') {
      try {
        const maintainer = this.tools?._maintainer;
        if (!maintainer) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'maintainer not available' }));
          return;
        }
        if (this._maintRunJob && this._maintRunJob.state === 'running') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'running', started: this._maintRunJob.started }));
          return;
        }
        this._maintRunJob = { state: 'running', started: Date.now(), error: null, result: null };
        maintainer.runMaintenance({ force: true })
          .then(r => { this._maintRunJob = { state: 'done', started: this._maintRunJob.started, completed: Date.now(), result: r }; })
          .catch(e => { this._maintRunJob = { state: 'error', started: this._maintRunJob.started, completed: Date.now(), error: e?.message || String(e) }; });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', started: this._maintRunJob.started }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/maintainer/status' && req.method === 'GET') {
      try {
        const maintainer = this.tools?._maintainer;
        const openGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='open'").get()?.c || 0;
        const dormantGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='dormant'").get()?.c || 0;
        const answeredGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='answered'").get()?.c || 0;
        const reflections = db.prepare("SELECT COUNT(*) AS c FROM reflections").get()?.c || 0;
        let derived = 0;
        try { derived = db.prepare("SELECT COUNT(*) AS c FROM derived_facts WHERE invalidated_at IS NULL").get()?.c || 0; } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job: this._maintRunJob || { state: 'idle' },
          last_run_at: maintainer?._lastRunAt || null,
          running: !!maintainer?._running,
          model: maintainer?.model || null,
          stats: maintainer?.stats || {},
          counts: { openGaps, dormantGaps, answeredGaps, reflections, derivedFacts: derived },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Janitor on-demand + status + recycling bin ──
    if (urlPath === '/api/janitor/run' && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        if (this._janitorRunJob && this._janitorRunJob.state === 'running') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'running', started: this._janitorRunJob.started }));
          return;
        }
        this._janitorRunJob = { state: 'running', started: Date.now(), error: null, result: null };
        janitor.runJanitor({ force: true })
          .then(r => { this._janitorRunJob = { state: 'done', started: this._janitorRunJob.started, completed: Date.now(), result: r }; })
          .catch(e => { this._janitorRunJob = { state: 'error', started: this._janitorRunJob.started, completed: Date.now(), error: e?.message || String(e) }; });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', started: this._janitorRunJob.started }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/status' && req.method === 'GET') {
      try {
        const janitor = this.tools?._janitor;
        let binCount = 0;
        try { binCount = db.prepare('SELECT COUNT(*) AS c FROM recycle_bin').get()?.c || 0; } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job: this._janitorRunJob || { state: 'idle' },
          last_run_at: janitor?._lastRunAt || null,
          running: !!janitor?._running,
          model: janitor?.model || null,
          mode: this.config.janitorMode || 'moderate',
          interval_minutes: this.config.janitorIntervalMinutes || 360,
          recycle_bin_ttl_days: this.config.janitorRecycleBinTtlDays || 14,
          enabled: this.config.janitorEnabled !== false,
          stats: janitor?.stats || {},
          counts: { binItems: binCount },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/recycle-bin' && req.method === 'GET') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const u = new URL(req.url, 'http://x');
        const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit') || '100', 10)));
        const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10));
        const out = janitor.listBin({ limit, offset });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/recycle-bin/empty' && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.emptyBin();
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const binRestoreMatch = urlPath.match(/^\/api\/janitor\/restore\/(\d+)$/);
    if (binRestoreMatch && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.restoreItem(binRestoreMatch[1]);
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const binDeleteMatch = urlPath.match(/^\/api\/janitor\/recycle-bin\/(\d+)$/);
    if (binDeleteMatch && req.method === 'DELETE') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.deleteBinItem(binDeleteMatch[1]);
        res.writeHead(out.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/settings' && req.method === 'POST') {
      try {
        const body = await json();
        const mode = String(body.mode || '').toLowerCase();
        if (!['conservative', 'moderate', 'aggressive'].includes(mode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid mode' }));
          return;
        }
        this.config.janitorMode = mode;
        // Persist via _applyEnvUpdates if available
        try {
          if (typeof this._applyEnvUpdates === 'function') {
            this._applyEnvUpdates({ SPORE_JANITOR_MODE: mode });
          }
        } catch (e) { this.log.warn('[janitor-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Graph backup ──
    if (urlPath === '/api/backups' && req.method === 'GET') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(backup.listBackups()));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/run' && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json().catch(() => ({}));
        const note = typeof body.note === 'string' ? body.note : null;
        const out = await backup.runBackup({ force: true, note });
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/status' && req.method === 'GET') {
      try {
        const backup = this.tools?._backup;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: this.config.graphBackupEnabled !== false,
          interval_minutes: this.config.graphBackupIntervalMinutes || 60,
          retention: this.config.graphBackupRetention || 20,
          on_change_only: this.config.graphBackupOnChangeOnly !== false,
          dir: backup?._backupDir?.() || null,
          stats: backup?.stats || {},
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/settings' && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json();
        const changes = backup.applySettings({
          intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
          retention: typeof body.retention === 'number' ? body.retention : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          onChangeOnly: typeof body.onChangeOnly === 'boolean' ? body.onChangeOnly : undefined,
        });
        try {
          if (typeof this._applyEnvUpdates === 'function') {
            const envUpd = {};
            if ('intervalMinutes' in changes) envUpd.SPORE_BACKUP_INTERVAL_MINUTES = String(changes.intervalMinutes);
            if ('retention' in changes) envUpd.SPORE_BACKUP_RETENTION = String(changes.retention);
            if ('enabled' in changes) envUpd.SPORE_BACKUP_ENABLED = changes.enabled ? 'true' : 'false';
            if ('onChangeOnly' in changes) envUpd.SPORE_BACKUP_ON_CHANGE_ONLY = changes.onChangeOnly ? 'true' : 'false';
            if (Object.keys(envUpd).length) this._applyEnvUpdates(envUpd);
          }
        } catch (e) { this.log.warn('[backup-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changes }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const restoreMatch = urlPath.match(/^\/api\/backups\/restore$/);
    if (restoreMatch && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json();
        const filename = String(body.file || body.filename || '').trim();
        if (!filename) { res.writeHead(400); res.end(JSON.stringify({ error: 'file required' })); return; }
        const out = await backup.restoreBackup(filename);
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Graph / settings / providers export + import ─────────────────
    if (urlPath.startsWith('/api/graph/export') && req.method === 'GET') {
      try {
        const { exportGraph, exportProviders, exportSettings } = require('../graph/export-import');
        const u = new URL(req.url, 'http://x');
        const wantGraph = u.searchParams.get('graph') !== '0';
        const wantProviders = u.searchParams.get('providers') === '1';
        const wantSettings = u.searchParams.get('settings') !== '0';
        const includeSecrets = u.searchParams.get('secrets') === '1';

        const bundle = {
          version: 2,
          format: 'spore-export',
          exportedAt: new Date().toISOString(),
          sourceAgent: this.config.agentId ? { id: this.config.agentId, label: this.config.displayName || this.config.agentId } : null,
          includesSecrets: wantProviders && includeSecrets,
          sections: [],
        };
        if (wantGraph) {
          bundle.graph = exportGraph(db, { agentId: this.config.agentId || null });
          bundle.sections.push('graph');
        }
        if (wantProviders) {
          bundle.providers = exportProviders(this.config, { includeSecrets });
          if (bundle.providers) bundle.sections.push('providers');
        }
        if (wantSettings) {
          bundle.settings = exportSettings(this.config);
          if (bundle.settings) bundle.sections.push('settings');
        }

        const filename = `spore-export-${(this.config.agentId || 'agent').replace(/[^a-zA-Z0-9-]/g, '')}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(JSON.stringify(bundle, null, 2));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/import' && req.method === 'POST') {
      // Import is destructive (inserts nodes + edges into the live graph),
      // so gate to creator only — webapp users shouldn't be able to bulk
      // upload arbitrary knowledge. Inline cookie check against _sessions.
      try {
        const cookies = (function parse(h) {
          const out = {}; if (!h) return out;
          for (const c of h.split(';')) { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }
          return out;
        })(req.headers.cookie || '');
        const sid = cookies['anima_session'];
        const sess = sid && this._webSessions.get(sid);
        const isCreator = sess && (sess.type === 'creator' || sess.type === 'admin');
        if (!isCreator) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Import requires creator role.' }));
          return;
        }
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'auth check failed: ' + e.message })); return;
      }
      try {
        // Increase the body cap — exports can be multi-MB for large graphs
        const MAX_IMPORT = 50 * 1024 * 1024;
        const bodyRaw = await new Promise((resolve, reject) => {
          let b = ''; req.on('data', c => {
            b += c; if (b.length > MAX_IMPORT) { req.destroy(); reject(new Error('import too large (>50MB)')); }
          });
          req.on('end', () => resolve(b));
          req.on('error', reject);
        });
        let payload;
        try { payload = JSON.parse(bodyRaw); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
          return;
        }
        // Auto pre-import backup so the operator can undo
        try {
          const backup = this.tools?._backup;
          if (backup) await backup.runBackup({ force: true, note: 'pre-import' });
        } catch (e) { this.log.warn('[import] pre-import backup failed: ' + e.message); }

        const { importGraph, planProviderImport, planSettingsImport } = require('../graph/export-import');
        const u = new URL(req.url, 'http://x');
        const applyGraph = u.searchParams.get('apply_graph') !== '0';
        const applyProviders = u.searchParams.get('apply_providers') === '1';
        const applySettings = u.searchParams.get('apply_settings') !== '0';

        // v2 bundle → has {graph, providers, settings}. v1 format / raw graph →
        // the graph IS the payload (backward compat).
        const isBundle = payload.format === 'spore-export';
        const graphPayload = isBundle ? payload.graph : payload;
        const providersSection = isBundle ? payload.providers : null;
        const settingsSection = isBundle ? payload.settings : null;

        const report = {
          graph: null,
          providers: null,
          settings: null,
        };

        if (applyGraph && graphPayload && graphPayload.format === 'spore-graph-export') {
          report.graph = importGraph(db, graphPayload, { log: this.log });
        } else if (applyGraph && graphPayload) {
          report.graph = { error: 'skipped — not a spore-graph-export payload' };
        }

        let providerTouched = false;
        let modelTouched = false;
        if (applyProviders && providersSection) {
          const plan = planProviderImport(providersSection, this.config);
          try {
            if (typeof this._applyEnvUpdates === 'function' && Object.keys(plan.envUpdates).length) {
              this._applyEnvUpdates(plan.envUpdates);
            }
            Object.assign(this.config, plan.configPatches);
            providerTouched = plan.applied.length > 0;
          } catch (e) {
            this.log.warn('[import] providers apply failed: ' + e.message);
          }
          report.providers = { applied: plan.applied, skipped: plan.skipped };
        }

        if (applySettings && settingsSection) {
          const plan = planSettingsImport(settingsSection);
          try {
            if (typeof this._applyEnvUpdates === 'function' && Object.keys(plan.envUpdates).length) {
              this._applyEnvUpdates(plan.envUpdates);
            }
            Object.assign(this.config, plan.configPatches);
            // If any model tier changed, the agent loop needs to rewire.
            for (const k of ['casualModel', 'normalModel', 'plannerModel', 'subagentModel', 'learnerModel', 'imageVlmModel', 'videoVlmModel', 'audioVlmModel']) {
              if (plan.configPatches[k] != null) { modelTouched = true; break; }
            }
          } catch (e) {
            this.log.warn('[import] settings apply failed: ' + e.message);
          }
          report.settings = { applied: plan.applied };
        }

        // After applying env updates, reset the shared config cache so any
        // other component calling loadConfig() gets fresh values.
        try {
          const { resetConfigCache } = require('../config');
          if (typeof resetConfigCache === 'function') resetConfigCache();
        } catch (e) { this.log.warn('[web] require failed: ' + e.message); }

        // Resolve the top-level `model` pointer (used by detectBackend etc.)
        this.config.model = this.config.plannerModel || this.config.normalModel || this.config.casualModel || null;
        this.config._isOAuth = !!(this.config.anthropicApiKey && String(this.config.anthropicApiKey).includes('sk-ant-oat'));

        // If providers or model tiers changed, rebuild the agent's LLM client
        // so the next chat uses the new provider/model instead of the old one.
        if (providerTouched || modelTouched) {
          try {
            this.tools?.anthropicClient?.clearCache?.();
            const agent = this.tools?._agent;
            if (agent) {
              agent.client = null;
              if (typeof agent.init === 'function') agent.init();
            }
            report.reinitialized = true;
          } catch (e) {
            this.log.warn('[import] agent re-init failed: ' + e.message);
            report.reinitWarning = e.message;
          }
        }

        // Notify viewers to reload
        try {
          const graphEvents = require('../graph/events');
          graphEvents.emit('change', { op: 'graph:import', source: 'import', report });
        } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, report }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const backupDelMatch = urlPath.match(/^\/api\/backups\/([^\/]+)$/);
    if (backupDelMatch && req.method === 'DELETE') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const out = backup.deleteBackup(decodeURIComponent(backupDelMatch[1]));
        res.writeHead(out.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Tailscale ─────────────────────────────────────────────────────
    const TS_SOCKET = '/data/tailscale/ts.sock';
    // The node process runs as unprivileged `spore`. Tailscale's `up` /
    // `logout` / `set` require root (or an already-persisted operator
    // setting, which itself can only be set by root). Sudoers grants
    // passwordless /usr/bin/tailscale to spore — use it unconditionally
    // so we don't depend on the operator-persist side channel.
    const _tsRun = (args, timeoutMs = 10000) => new Promise((resolve) => {
      const { spawn } = require('child_process');
      const proc = spawn('sudo', ['-n', 'tailscale', '--socket', TS_SOCKET, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', c => { out += c.toString(); });
      proc.stderr.on('data', c => { err += c.toString(); });
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { this.log.warn('[web] proc.kill failed: ' + e.message); } }, timeoutMs);
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
    });

    if (urlPath === '/api/tailscale/status' && req.method === 'GET') {
      try {
        const r = await _tsRun(['status', '--json'], 8000);
        if (r.code !== 0) {
          // daemon not running or socket missing
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ backend: 'Stopped', error: (r.stderr || '').trim().slice(0, 300), authUrl: this._tsAuthUrl || null }));
          return;
        }
        let j = null;
        try { j = JSON.parse(r.stdout); } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: 'tailscale status parse: ' + e.message })); return;
        }
        const peers = [];
        for (const key of Object.keys(j.Peer || {})) {
          const p = j.Peer[key];
          peers.push({ hostName: p.HostName, dnsName: p.DNSName, addrs: p.TailscaleIPs || [], online: !!p.Online, os: p.OS, tags: p.Tags || [] });
        }
        peers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          backend: j.BackendState || 'Unknown',
          tailnetIp: (j.Self?.TailscaleIPs || [])[0] || null,
          hostname: j.Self?.HostName || null,
          dnsName: j.Self?.DNSName || null,
          peers,
          peerCount: peers.length,
          onlineCount: peers.filter(p => p.online).length,
          authUrl: (j.BackendState === 'NeedsLogin' ? (this._tsAuthUrl || null) : null),
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/tailscale/login' && req.method === 'POST') {
      this.log.info('[tailscale] login endpoint hit — initiating `tailscale up`');
      try {
        // If already logged in, short-circuit.
        const status = await _tsRun(['status', '--json'], 5000);
        if (status.code === 0) {
          try {
            const j = JSON.parse(status.stdout);
            if (j.BackendState === 'Running') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'already-connected', tailnetIp: (j.Self?.TailscaleIPs || [])[0] || null }));
              return;
            }
          } catch { /* silent: malformed JSON → fallback */ }
        }

        // Spawn `tailscale up` non-blocking, parse out the login URL from stderr.
        const { spawn } = require('child_process');
        const hostname = this.config.tailscaleHostname || `spore-${this.config.agentId || 'agent'}`;
        // `--reset` clears any half-persisted flag state from a previous
        // partial login attempt, so our flag set becomes canonical. Runs
        // under `sudo -n tailscale` because `up` needs root (or a
        // previously-persisted operator, which we don't rely on).
        const args = [
          '-n', 'tailscale',
          '--socket', TS_SOCKET, 'up',
          '--reset',
          '--hostname', hostname,
          '--operator', 'spore',
          '--accept-routes',
          '--ssh',
          '--timeout=0',
        ];
        // Kill any stale previous login attempt
        if (this._tsLoginProc && !this._tsLoginProc.killed) {
          try { this._tsLoginProc.kill('SIGTERM'); } catch (e) { this.log.warn('[web] this._tsLoginProc.kill failed: ' + e.message); }
        }
        this._tsAuthUrl = null;
        const proc = spawn('sudo', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this._tsLoginProc = proc;
        this._tsAuthUrlExpiresAt = Date.now() + 10 * 60_000;

        const urlRegex = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/;
        const capture = (chunk) => {
          const m = chunk.toString().match(urlRegex);
          if (m && !this._tsAuthUrl) {
            this._tsAuthUrl = m[0];
            this.log.info(`[tailscale] login URL captured`);
          }
        };
        proc.stdout.on('data', capture);
        proc.stderr.on('data', capture);
        proc.on('close', (code) => {
          this.log.info(`[tailscale] up process exited ${code}`);
          this._tsLoginProc = null;
          // Clear auth URL once login completes successfully (status will now be Running)
          if (code === 0) this._tsAuthUrl = null;
        });

        // Poll for URL up to 6s
        let waited = 0;
        while (!this._tsAuthUrl && waited < 6000) {
          await new Promise(r => setTimeout(r, 200));
          waited += 200;
        }

        if (!this._tsAuthUrl) {
          // No URL printed — either daemon issue or already connecting
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'no-url-yet', message: 'tailscale up running; poll /api/tailscale/status' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'pending-auth', authUrl: this._tsAuthUrl, expiresAt: this._tsAuthUrlExpiresAt }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/tailscale/logout' && req.method === 'POST') {
      try {
        const r = await _tsRun(['logout'], 15000);
        this._tsAuthUrl = null;
        if (this._tsLoginProc && !this._tsLoginProc.killed) {
          try { this._tsLoginProc.kill('SIGTERM'); } catch (e) { this.log.warn('[web] this._tsLoginProc.kill failed: ' + e.message); }
        }
        res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: r.code === 0, stderr: (r.stderr || '').trim().slice(0, 300) }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Cluster settings ─────────────────────────────────────────────
    if (urlPath === '/api/cluster/settings' && req.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          clusterUsername: this.config.clusterUsername || '',
          clusterLoginHost: this.config.clusterLoginHost || '',
          clusterTmuxPrefix: this.config.clusterTmuxPrefix || 'spore',
          tailscaleHostname: this.config.tailscaleHostname || `spore-${this.config.agentId || 'agent'}`,
          clusterHosts: Array.isArray(this.config.clusterHosts) ? this.config.clusterHosts : [],
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/hosts' && req.method === 'POST') {
      try {
        const body = await json();
        const hosts = Array.isArray(body.hosts) ? body.hosts : [];
        // Sanitize each entry
        const clean = [];
        for (const h of hosts) {
          if (!h || typeof h !== 'object') continue;
          const entry = {
            name: String(h.name || '').trim().slice(0, 64),
            host: String(h.host || '').trim().slice(0, 128),
            username: String(h.username || '').trim().slice(0, 64),
          };
          if (!entry.host && !entry.name) continue;
          if (!entry.name) entry.name = entry.host;
          clean.push(entry);
        }
        this.config.clusterHosts = clean;
        try {
          if (typeof this._applyEnvUpdates === 'function') {
            this._applyEnvUpdates({ SPORE_CLUSTER_HOSTS: JSON.stringify(clean) });
          }
        } catch (e) { this.log.warn('[cluster-hosts] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hosts: clean }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/settings' && req.method === 'POST') {
      try {
        const body = await json();
        const envUpd = {};
        const clean = (v) => (typeof v === 'string' ? v.trim() : '');
        const updates = {};
        if ('clusterUsername' in body) { updates.clusterUsername = clean(body.clusterUsername) || null; envUpd.SPORE_CLUSTER_USERNAME = clean(body.clusterUsername); }
        if ('clusterLoginHost' in body) { updates.clusterLoginHost = clean(body.clusterLoginHost) || null; envUpd.SPORE_CLUSTER_LOGIN_HOST = clean(body.clusterLoginHost); }
        if ('clusterTmuxPrefix' in body) {
          const p = clean(body.clusterTmuxPrefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'spore';
          updates.clusterTmuxPrefix = p;
          envUpd.SPORE_CLUSTER_TMUX_PREFIX = p;
        }
        if ('tailscaleHostname' in body) {
          const h = clean(body.tailscaleHostname).replace(/[^a-zA-Z0-9.-]/g, '') || `spore-${this.config.agentId || 'agent'}`;
          updates.tailscaleHostname = h;
          envUpd.SPORE_TAILSCALE_HOSTNAME = h;
        }
        // Live-patch
        Object.assign(this.config, updates);
        try {
          if (typeof this._applyEnvUpdates === 'function' && Object.keys(envUpd).length) {
            this._applyEnvUpdates(envUpd);
          }
        } catch (e) { this.log.warn('[cluster-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: updates }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Email settings + test ────────────────────────────────────────
    if (urlPath === '/api/email/settings' && req.method === 'GET') {
      try {
        const c = this.config || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          emailProvider: c.emailProvider || '',
          emailAddress: c.emailAddress || '',
          emailSmtpHost: c.emailSmtpHost || '',
          emailSmtpPort: c.emailSmtpPort || 587,
          emailSmtpSecure: !!c.emailSmtpSecure,
          emailSmtpUsername: c.emailSmtpUsername || '',
          emailImapHost: c.emailImapHost || '',
          emailImapPort: c.emailImapPort || 993,
          emailImapSecure: c.emailImapSecure !== false,
          hasPassword: !!c.emailSmtpPassword,
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/email/settings' && req.method === 'POST') {
      try {
        const body = await json();
        const envUpd = {};
        const updates = {};
        const clean = v => typeof v === 'string' ? v.trim() : '';
        if ('emailProvider' in body) {
          const p = clean(body.emailProvider).toLowerCase();
          if (p === '' || ['proton', 'google'].includes(p)) {
            updates.emailProvider = p || null;
            envUpd.SPORE_EMAIL_PROVIDER = p || '';
          }
        }
        if ('emailAddress' in body) { updates.emailAddress = clean(body.emailAddress) || null; envUpd.SPORE_EMAIL_ADDRESS = clean(body.emailAddress); }
        if ('emailSmtpHost' in body) { updates.emailSmtpHost = clean(body.emailSmtpHost) || null; envUpd.SPORE_EMAIL_SMTP_HOST = clean(body.emailSmtpHost); }
        if ('emailSmtpPort' in body) {
          const n = Number(body.emailSmtpPort);
          if (Number.isFinite(n) && n > 0) { updates.emailSmtpPort = n; envUpd.SPORE_EMAIL_SMTP_PORT = String(n); }
        }
        if ('emailSmtpSecure' in body) { updates.emailSmtpSecure = !!body.emailSmtpSecure; envUpd.SPORE_EMAIL_SMTP_SECURE = body.emailSmtpSecure ? 'true' : 'false'; }
        if ('emailSmtpUsername' in body) { updates.emailSmtpUsername = clean(body.emailSmtpUsername) || null; envUpd.SPORE_EMAIL_SMTP_USERNAME = clean(body.emailSmtpUsername); }
        if ('emailImapHost' in body) { updates.emailImapHost = clean(body.emailImapHost) || null; envUpd.SPORE_EMAIL_IMAP_HOST = clean(body.emailImapHost); }
        if ('emailImapPort' in body) {
          const n = Number(body.emailImapPort);
          if (Number.isFinite(n) && n > 0) { updates.emailImapPort = n; envUpd.SPORE_EMAIL_IMAP_PORT = String(n); }
        }
        if ('emailImapSecure' in body) { updates.emailImapSecure = body.emailImapSecure !== false; envUpd.SPORE_EMAIL_IMAP_SECURE = body.emailImapSecure === false ? 'false' : 'true'; }
        if (typeof body.emailSmtpPassword === 'string' && body.emailSmtpPassword.length > 0) {
          // Only write when the client sent a real new value (not a placeholder)
          updates.emailSmtpPassword = body.emailSmtpPassword;
          envUpd.SPORE_EMAIL_SMTP_PASSWORD = body.emailSmtpPassword;
        }
        Object.assign(this.config, updates);
        try {
          if (typeof this._applyEnvUpdates === 'function' && Object.keys(envUpd).length) {
            this._applyEnvUpdates(envUpd);
          }
        } catch (e) { this.log.warn('[email-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/email/test' && req.method === 'POST') {
      try {
        const tools = this.tools;
        if (!tools) { res.writeHead(503); res.end(JSON.stringify({ error: 'tools not ready' })); return; }
        // Round-trip: send a tiny email to the configured address, then IMAP-open
        // the mailbox to confirm credentials. Sending alone doesn't validate IMAP.
        const cfg = this.config || {};
        if (!cfg.emailAddress) { res.writeHead(400); res.end(JSON.stringify({ error: 'emailAddress not set' })); return; }
        const sendRes = await tools._emailSendTool({
          to: cfg.emailAddress,
          subject: 'SPORE email self-test',
          body: `Self-test at ${new Date().toISOString()} — if you see this, SMTP from ${cfg.emailAddress} is working.`,
        });
        if (sendRes.error) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, stage: 'smtp', error: sendRes.error })); return; }
        const imapRes = await tools._emailListTool({ folder: 'INBOX', limit: 1 });
        if (imapRes.error) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, stage: 'imap', error: imapRes.error, smtp: 'ok' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, smtp: 'ok', imap: 'ok', messageId: sendRes.messageId }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/test-ssh' && req.method === 'POST') {
      try {
        const body = await json().catch(() => ({}));
        const user = String(body.user || this.config.clusterUsername || '').trim();
        const host = String(body.host || this.config.clusterLoginHost || '').trim();
        if (!user || !host) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'username and host required (set Cluster settings first)' }));
          return;
        }
        const fsm = require('fs');
        const KEY_PATH = '/data/.ssh/id_cluster';
        const hasKey = fsm.existsSync(KEY_PATH);
        // Route through tailscale's local SOCKS5 proxy so MagicDNS names (like
        // "gb200-login-2") resolve against the tailnet and the outbound
        // connection rides the userspace-networking tailscale stack. Without
        // this, the container has no tailnet DNS and can't reach tailnet IPs
        // from its network namespace.
        const sshArgs = [
          '-o', 'BatchMode=yes',
          '-o', 'ConnectTimeout=12',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'UserKnownHostsFile=/data/.ssh/known_hosts',
          '-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:1055 %h %p',
        ];
        if (hasKey) sshArgs.push('-i', KEY_PATH, '-o', 'IdentitiesOnly=yes');
        sshArgs.push(`${user}@${host}`, 'hostname; which sbatch || echo no-slurm; sinfo --version 2>/dev/null || echo no-sinfo');
        const { spawn } = require('child_process');
        const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        proc.stdout.on('data', c => { out += c.toString(); });
        proc.stderr.on('data', c => { err += c.toString(); });
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { this.log.warn('[web] proc.kill failed: ' + e.message); } }, 20000);
        const code = await new Promise((r) => { proc.on('close', (c) => { clearTimeout(timer); r(c); }); });
        const output = (out || '').trim();
        const stderr = (err || '').trim();
        let hint = null;
        if (code !== 0) {
          if (/could not resolve hostname|getaddrinfo/i.test(stderr)) {
            hint = 'Hostname did not resolve via MagicDNS. Verify tailscale is connected and the cluster peer is online (Settings → Tailscale status).';
          } else if (/Permission denied|publickey/i.test(stderr)) {
            hint = hasKey
              ? 'SSH auth rejected. Make sure the public key (settings → Copy SSH public key) is in ~/.ssh/authorized_keys on the cluster login node.'
              : 'No SSH key installed. Click "Generate SSH key" below, copy the public key, and install it on the cluster (~/.ssh/authorized_keys).';
          } else {
            hint = 'SSH failed. If the hostname is unreachable, verify tailscale is connected. Otherwise check the cluster username and that your public key is authorised.';
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: code === 0,
          code,
          output: output.slice(0, 800),
          stderr: stderr.slice(0, 800),
          usedKey: hasKey ? KEY_PATH : null,
          hint,
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Cluster SSH key management ────────────────────────────────────
    if (urlPath === '/api/cluster/ssh-key' && req.method === 'GET') {
      try {
        const fsm = require('fs');
        const KEY_PATH = '/data/.ssh/id_cluster';
        const PUB_PATH = KEY_PATH + '.pub';
        const hasPrivate = fsm.existsSync(KEY_PATH);
        let publicKey = null, fingerprint = null;
        if (fsm.existsSync(PUB_PATH)) {
          try { publicKey = fsm.readFileSync(PUB_PATH, 'utf8').trim(); } catch (e) { this.log.warn('[web] fsm.readFileSync failed: ' + e.message); }
        }
        if (hasPrivate) {
          try {
            const { execFileSync } = require('child_process');
            fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
          } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hasPrivate, publicKey, fingerprint }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/ssh-key/generate' && req.method === 'POST') {
      try {
        const fsm = require('fs');
        const path = require('path');
        const SSH_DIR = '/data/.ssh';
        const KEY_PATH = path.join(SSH_DIR, 'id_cluster');
        fsm.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
        try { fsm.chmodSync(SSH_DIR, 0o700); } catch (e) { this.log.warn('[web] fsm.chmodSync failed: ' + e.message); }
        // Remove old if present
        try { fsm.unlinkSync(KEY_PATH); } catch (e) { this.log.warn('[web] fsm.unlinkSync failed: ' + e.message); }
        try { fsm.unlinkSync(KEY_PATH + '.pub'); } catch (e) { this.log.warn('[web] fsm.unlinkSync failed: ' + e.message); }
        const { execFileSync } = require('child_process');
        const comment = `spore-cluster-${this.config.agentId || 'agent'}`;
        execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', KEY_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
        try { fsm.chmodSync(KEY_PATH, 0o600); } catch (e) { this.log.warn('[web] fsm.chmodSync failed: ' + e.message); }
        try { fsm.chmodSync(KEY_PATH + '.pub', 0o644); } catch (e) { this.log.warn('[web] fsm.chmodSync failed: ' + e.message); }
        const publicKey = fsm.readFileSync(KEY_PATH + '.pub', 'utf8').trim();
        const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, publicKey, fingerprint }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/ssh-key' && req.method === 'POST') {
      try {
        const body = await json();
        const privateKey = String(body.privateKey || '').trim();
        if (!privateKey.startsWith('-----BEGIN') || !privateKey.includes('PRIVATE KEY-----')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'input does not look like an SSH private key (expected PEM with BEGIN/END PRIVATE KEY markers)' }));
          return;
        }
        const fsm = require('fs');
        const path = require('path');
        const SSH_DIR = '/data/.ssh';
        const KEY_PATH = path.join(SSH_DIR, 'id_cluster');
        fsm.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
        try { fsm.chmodSync(SSH_DIR, 0o700); } catch (e) { this.log.warn('[web] fsm.chmodSync failed: ' + e.message); }
        fsm.writeFileSync(KEY_PATH, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
        try { fsm.chmodSync(KEY_PATH, 0o600); } catch (e) { this.log.warn('[web] fsm.chmodSync failed: ' + e.message); }
        // Derive public key
        let publicKey = null, fingerprint = null;
        try {
          const { execFileSync } = require('child_process');
          publicKey = execFileSync('ssh-keygen', ['-y', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
          fsm.writeFileSync(KEY_PATH + '.pub', publicKey + '\n', { mode: 0o644 });
          fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
        } catch (e) {
          // Key file was written but we couldn't derive public half — probably encrypted
          try { fsm.unlinkSync(KEY_PATH); } catch {}
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not derive public key — is this an encrypted / passphrase-protected key? Decrypt it first (`ssh-keygen -p -f key`) or paste an unencrypted version.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, publicKey, fingerprint }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/cluster/ssh-key' && req.method === 'DELETE') {
      try {
        const fsm = require('fs');
        const KEY_PATH = '/data/.ssh/id_cluster';
        try { fsm.unlinkSync(KEY_PATH); } catch (e) { this.log.warn('[web] fsm.unlinkSync failed: ' + e.message); }
        try { fsm.unlinkSync(KEY_PATH + '.pub'); } catch (e) { this.log.warn('[web] fsm.unlinkSync failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Provider smoke tests ──
    if (urlPath.startsWith('/api/providers/') && urlPath.endsWith('/test') && req.method === 'POST') {
      const name = urlPath.slice('/api/providers/'.length, -'/test'.length);
      const body = await _readJsonBody(req);
      try {
        const result = await _probeProvider(name, body);
        res.writeHead(result.ok ? 200 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── List models from a provider's /models endpoint ──
    if (urlPath === '/api/providers/list-models' && req.method === 'POST') {
      const body = await _readJsonBody(req);
      try {
        const result = await _listModelsForProvider(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Model tier smoke tests ──
    if (urlPath.startsWith('/api/models/') && urlPath.endsWith('/test') && req.method === 'POST') {
      const tier = urlPath.slice('/api/models/'.length, -'/test'.length);
      const body = await _readJsonBody(req);
      try {
        const result = await _probeModelTier(tier, body, this.config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Web search smoke test ──
    if (urlPath === '/api/websearch/test' && req.method === 'POST') {
      const body = await _readJsonBody(req);
      try {
        const { searchWeb } = require('../lib/web-search');
        const searxngUrl = String(body.searxngUrl || this.config.searxngUrl || '').trim();
        let searxngApiKey = String(body.searxngApiKey || '').trim();
        if (!searxngApiKey || searxngApiKey === '***hidden***') searxngApiKey = this.config.searxngApiKey || '';
        let braveApiKey = String(body.braveApiKey || '').trim();
        if (!braveApiKey || braveApiKey === '***hidden***') braveApiKey = this.config.braveApiKey || '';
        if (!searxngUrl && !braveApiKey) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No search provider configured' }));
          return;
        }
        const t0 = Date.now();
        const result = await searchWeb({ query: 'spore web search smoke test', count: 3, searxngUrl, searxngApiKey, braveApiKey, log: this.log });
        const latency = Date.now() - t0;
        if (result?.error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.error, latency_ms: latency }));
          return;
        }
        const results = Array.isArray(result?.results) ? result.results : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          provider: result?.provider || 'unknown',
          result_count: results.length,
          latency_ms: latency,
          excerpt: results[0]?.title || result?.note || '',
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/tokens' && req.method === 'GET') {
      try {
        const feed = require('../graph/feed');
        const summary = feed.readTokenSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary || { error: 'No token data yet' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Plan-mode endpoints ──
    if (urlPath === '/api/plan/mode' && req.method === 'PUT') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const body = await _readJsonBody(req);
        const sessionKey = String(body.sessionKey || '').trim();
        const enabled = body.enabled === true;
        if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionKey required' })); return; }
        const sessions = this.tools._sessions;
        // Ensure the session row exists
        sessions.ensureSession(sessionKey);
        sessions.db.prepare('UPDATE sessions SET plan_mode=? WHERE key=?').run(enabled ? 1 : 0, sessionKey);
        try { this._broadcastToSessionKey(sessionKey, { type: 'plan_mode', enabled }); } catch (e) { this.log.warn('[web] this._broadcastToSessionKey failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, planMode: enabled }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if ((urlPath === '/api/plan/approve' || urlPath === '/api/plan/reject') && req.method === 'POST') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const body = await _readJsonBody(req);
        const sessionKey = String(body.sessionKey || '').trim();
        if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionKey required' })); return; }
        const fn = urlPath.endsWith('/approve') ? 'applyPlanProposals' : 'rejectPlanProposals';
        // Pass sessionKey explicitly — the approve/reject methods take it as
        // an argument and route internal dispatch through _executeToolDirect
        // which bypasses the plan-mode gate anyway.
        const out = await this.tools[fn](sessionKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out || { ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/plan/pending' && req.method === 'GET') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const sessionKey = new URL(req.url, 'http://x').searchParams.get('sessionKey') || '';
        const rows = this.tools.listPendingProposals(sessionKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proposals: rows }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Research selected nodes via the agent ──
    if (urlPath === '/api/graph/research' && req.method === 'POST') {
      try {
        const body = await _readJsonBody(req);
        const ids = Array.isArray(body.nodeIds) ? body.nodeIds.filter(x => typeof x === 'string').slice(0, 12) : [];
        if (!ids.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nodeIds (1-12) required' })); return; }
        const agent = this.tools?._agent;
        if (!agent || !agent.client) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Agent loop not initialised — finish onboarding first.' })); return; }

        // Build a focused brief per node so the agent has concrete context.
        const brief = ids.map(id => {
          const n = db.prepare('SELECT id, label, type, description FROM nodes WHERE id = ?').get(id);
          if (!n) return null;
          const aspects = db.prepare('SELECT id, name FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 6').all(id);
          const aspectLines = aspects.map(a => {
            const attrs = db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 4').all(a.id);
            return `  • ${a.name}: ${attrs.map(at => at.content).join(' | ').slice(0, 220)}`;
          }).join('\n');
          return `- **${n.label}** (\`${n.id}\`, type=${n.type})\n  ${n.description || '_(no description)_'}\n${aspectLines}`;
        }).filter(Boolean).join('\n\n');

        if (!brief) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No matching nodes found' })); return; }

        const prompt = [
          `Research request: bring the following node(s) up to date with the latest information from the web and your own knowledge.`,
          ``,
          brief,
          ``,
          `Steps:`,
          `1. Use **web_search** (and **web_fetch** when you need full article context) to find recent, authoritative info about each node.`,
          `2. Then use **graph_update** to record what you learned: add new attributes to existing aspects, create new aspects on the same node, or create entirely new connected nodes when something genuinely new comes up.`,
          `3. Do NOT delete anything that already exists. Be additive.`,
          `4. When you're done, post a short summary of what you changed.`,
        ].join('\n');

        const sessionKey = `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Fire and forget — the agent's graph_update calls will broadcast via
        // graphEvents and the viewer will pick them up over its existing WS.
        agent.processMessage({
          content: prompt,
          channelId: sessionKey,
          channelName: 'research',
          userId: 'operator',
          userName: 'Operator',
          trigger: 'dm',
          platform: 'web',
          isDm: true,
        }).catch(e => this.log.warn(`[research] agent run failed: ${e.message}`));

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionKey, nodeCount: ids.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/graph/merge' && req.method === 'POST') {
      try {
        const body = await _readJsonBody(req);
        const sourceId = String(body.sourceNodeId || '').trim();
        const targetId = String(body.targetNodeId || '').trim();
        const mode = String(body.mode || 'merge').toLowerCase();
        if (!sourceId || !targetId || sourceId === targetId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sourceNodeId + targetNodeId (different) required' }));
          return;
        }
        const src = db.prepare('SELECT id, label, type, description, importance FROM nodes WHERE id = ?').get(sourceId);
        const tgt = db.prepare('SELECT id, label, type, description, importance FROM nodes WHERE id = ?').get(targetId);
        if (!src || !tgt) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'one or both node ids not found' }));
          return;
        }

        // Fast path: 'child' creates a parent_of edge directly. The graph
        // viewer gives parent_of edges a short, high-strength link so the two
        // nodes visually stick together — that's the "stick under as child"
        // affordance.
        if (mode === 'child') {
          const edgeType = 'parent_of';
          // target → source direction (target becomes parent of source).
          const [s, t] = [targetId, sourceId];
          const dup = db.prepare('SELECT id FROM edges WHERE source=? AND target=? AND type=?').get(s, t, edgeType);
          if (!dup) {
            db.prepare('INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1.0, ?)')
              .run(s, t, edgeType, 'drop-menu');
          }
          try {
            const graphEvents = require('../graph/events');
            graphEvents.emit('change', { op: 'edge:create', edge: { source: s, target: t, type: edgeType }, source: 'drop-menu' });
          } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode, edge: { source: s, target: t, type: edgeType }, created: !dup }));
          return;
        }

        // mode === 'merge' — hand off to the agent with a detailed brief.
        const agent = this.tools?._agent;
        if (!agent || !agent.client) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent loop not initialised — finish onboarding first.' }));
          return;
        }
        const briefFor = (n) => {
          const aspects = db.prepare('SELECT id, name, weight FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 12').all(n.id);
          const aspectLines = aspects.map(a => {
            const attrs = db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 4').all(a.id);
            const attrText = attrs.map(at => at.content).join(' | ').slice(0, 300);
            return `    • ${a.name} (importance=${a.weight}): ${attrText || '_(no attrs)_'}`;
          }).join('\n');
          const outgoing = db.prepare('SELECT target, type FROM edges WHERE source = ? LIMIT 20').all(n.id);
          const incoming = db.prepare('SELECT source, type FROM edges WHERE target = ? LIMIT 20').all(n.id);
          const outLines = outgoing.map(e => `    ${e.type} → ${e.target}`).join('\n');
          const inLines = incoming.map(e => `    ${e.source} --${e.type}--> (this node)`).join('\n');
          const attrCount = db.prepare('SELECT COUNT(*) AS c FROM attributes a JOIN aspects s ON s.id=a.aspect_id WHERE s.node_id=?').get(n.id).c;
          return `- **${n.label}** (\`${n.id}\`, type=${n.type}, importance=${n.importance}, ${aspects.length} aspects / ${attrCount} attrs / ${outgoing.length + incoming.length} edges)\n  ${n.description || '_(no description)_'}\n  Aspects:\n${aspectLines || '    _(none)_'}\n  Outbound edges:\n${outLines || '    _(none)_'}\n  Inbound edges:\n${inLines || '    _(none)_'}`;
        };
        let prompt;
        if (mode === 'link') {
          prompt = [
            `The operator dragged node \`${sourceId}\` onto node \`${targetId}\` in the graph viewer and chose "Link with an edge". Decide whether these two nodes are actually related, and if so what the relationship is.`,
            ``,
            briefFor(src),
            ``,
            briefFor(tgt),
            ``,
            `**Procedure:**`,
            ``,
            `1. Judge the relationship from the content above. Ask: is there a real, specific connection between these two? Examples of real relationships: "uses", "knows", "created_by", "part_of", "depends_on", "located_in", "works_on", "mentions", "authored".`,
            ``,
            `2. If they ARE related, call \`graph_update\` on \`${sourceId}\` with its existing label and type, plus \`edges: [{ target: "${targetId}", type: "<your-chosen-relationship>" }]\`. Pick the tightest, most specific verb you can justify — don't fall back to \`related_to\` unless nothing else fits.`,
            ``,
            `3. If they are NOT meaningfully related, do not create any edge. Just reply with a short sentence explaining that.`,
            ``,
            `4. End with one line: either \`Linked ${sourceId} --<type>--> ${targetId}.\` or \`No meaningful link — <reason>.\``,
            ``,
            `Do not call \`graph_query\` — everything you need is above.`,
          ].join('\n');
        } else {
          // mode === 'merge' (default)
          prompt = [
            `The operator dragged node \`${sourceId}\` onto node \`${targetId}\` in the graph viewer. Merge them into one coherent node.`,
            ``,
            briefFor(src),
            ``,
            briefFor(tgt),
            ``,
            `**Procedure (do NOT skip steps):**`,
            ``,
            `1. **Pick a SURVIVOR and a LOSER.** The survivor should be whichever has richer content, more edges, higher importance, or a cleaner id. If equivalent, pick the shorter/cleaner id.`,
            ``,
            `2. **Call \`graph_update\` on the SURVIVOR** with:`,
            `   - Its existing \`label\` and \`type\` (required fields)`,
            `   - A merged \`description\` that incorporates any useful info from the loser`,
            `   - \`aspects\`: any aspects from the loser that add new facts. Skip aspects whose attributes already exist on the survivor (dedupe).`,
            `   - \`edges\`: for every edge where the LOSER is the source (outbound), add an equivalent edge \`{target, type}\` so it survives on the survivor. Skip duplicates.`,
            ``,
            `3. **For each inbound edge where the LOSER is the target** (listed above under "Inbound edges"), call \`graph_update\` on the OTHER end (the \`source\`) and add \`edges: [{target: "<survivor-id>", type: "<same-type>"}]\` so incoming connections re-home to the survivor.`,
            ``,
            `4. **Call \`graph_delete\` with \`{ nodeId: "<loser-id>" }\`** — this cascades the loser's aspects, attributes, and any remaining edges.`,
            ``,
            `5. **Reply with one line** like: \`Merged \\\`loser-id\\\` into \\\`survivor-id\\\` — kept N aspects, rehomed M edges.\``,
            ``,
            `Do not call \`graph_query\` — everything you need is above. Do not skip step 4 or the two nodes will remain duplicated in the graph.`,
          ].join('\n');
        }

        // Fresh ephemeral channel session per merge/link so this doesn't
        // ride on top of operator's DM history (which can run to hundreds of
        // messages and blow the upstream context → 504 from the LLM proxy).
        // The prompt is self-contained; it doesn't need any prior turns.
        const sessionKey = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        agent.processMessage({
          content: prompt,
          channelId: sessionKey,
          channelName: mode,
          userId: 'operator',
          userName: 'Operator',
          trigger: 'channel',
          platform: 'web',
          isDm: false,
        }).catch(e => this.log.warn(`[${mode}] agent run failed: ${e.message}`));

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionKey, sourceId, targetId }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/graph/node' && req.method === 'POST') {
      json().then(data => {
        const { id, label, type, description, importance } = data;
        if (!id || !label || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'id, label, type required' })); return; }
        const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
        if (existing) db.prepare(`UPDATE nodes SET label=?, type=?, description=?, importance=?, updated=datetime('now') WHERE id=?`).run(label, type, description || '', importance || 5, id);
        else db.prepare('INSERT INTO nodes (id, label, type, description, importance, provenance) VALUES (?,?,?,?,?,?)').run(id, label, type, description || '', importance || 5, 'self');
        graphEvents.emit('change', { op: existing ? 'node:update' : 'node:create', node: { id, label, type, description: description || '' }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, id }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/node/') && req.method === 'DELETE') {
      const nodeId = decodeURIComponent(urlPath.split('/api/graph/node/')[1]);
      try {
        const edges = db.prepare('SELECT source, target, type FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
        db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)').run(nodeId);
        db.prepare('DELETE FROM aspects WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(nodeId, nodeId);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        for (const e of edges) { graphEvents.emit('change', { op: 'edge:delete', edge: e, source: 'editor' }); }
        graphEvents.emit('change', { op: 'node:delete', nodeId, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/aspect' && req.method === 'POST') {
      json().then(data => {
        const { nodeId, name, weight, attributes } = data;
        if (!nodeId || !name) { res.writeHead(400); res.end(JSON.stringify({ error: 'nodeId, name required' })); return; }
        const existing = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=?').get(nodeId, name);
        if (existing) { db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(existing.id); db.prepare('DELETE FROM aspects WHERE id=?').run(existing.id); }
        db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?,?,?,?)').run(nodeId, name, weight || 5, 'graph-viewer');
        const aspectId = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=? ORDER BY id DESC LIMIT 1').get(nodeId, name).id;
        if (attributes?.length) { const stmt = db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?,?,?,?,?)'); for (const a of attributes) stmt.run(aspectId, typeof a === 'string' ? a : a.content, a.importance || 5, 'graph-viewer', 'graph-viewer'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, aspectId }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/aspect/') && req.method === 'DELETE') {
      const aspectId = parseInt(urlPath.split('/api/graph/aspect/')[1]);
      try { db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(aspectId); db.prepare('DELETE FROM aspects WHERE id=?').run(aspectId); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'DELETE') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      try { db.prepare('DELETE FROM attributes WHERE id = ?').run(attrId); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'PUT') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      json().then(data => {
        const { content, importance } = data;
        if (!content) { res.writeHead(400); res.end(JSON.stringify({ error: 'content required' })); return; }
        db.prepare('UPDATE attributes SET content = ?, importance = ? WHERE id = ?').run(content, importance || 5, attrId);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'POST') {
      json().then(data => {
        const { source, target, type, weight } = data;
        if (!source || !target || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'source, target, type required' })); return; }
        const existing = db.prepare('SELECT rowid FROM edges WHERE source=? AND target=? AND type=?').get(source, target, type);
        if (existing) db.prepare('UPDATE edges SET weight=? WHERE source=? AND target=? AND type=?').run(weight || 1, source, target, type);
        else db.prepare('INSERT INTO edges (source, target, type, weight) VALUES (?,?,?,?)').run(source, target, type, weight || 1);
        graphEvents.emit('change', { op: existing ? 'edge:update' : 'edge:create', edge: { source, target, type }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'DELETE') {
      json().then(data => {
        const { source, target, type } = data;
        db.prepare('DELETE FROM edges WHERE source=? AND target=? AND type=?').run(source, target, type);
        graphEvents.emit('change', { op: 'edge:delete', edge: { source, target, type }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  }
}

module.exports = { WebGateway };
