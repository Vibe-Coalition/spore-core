// anthropic-provider plugin — Anthropic Claude chat completions.
//
// Last vendor extraction. After this plugin is loaded, core's
// `src/providers/index.js` has zero in-tree backends — every model
// string routes through a plugin. The walker's anthropic fallback
// is preserved for safety while the plugin is uninstalled, but with
// the plugin installed it always wins (longest-prefix rule).
//
// Owns @anthropic-ai/sdk in its own package.json (this plugin's
// node_modules). Core's package.json drops the dep entirely.

const { createAnthropicClient } = require('./lib/anthropic-client');

// Per-family metadata. Anthropic's /v1/models doesn't expose context_window,
// max output, or per-model modalities, so we augment with this table.
// Longest-prefix-wins — `claude-opus-4-7` more specific than `claude-opus-4`.
//
// All Claude 3+/4+ models accept image input (vision: true). None of the
// chat-completion models accept audio or video as user content via the
// standard messages API; opus-4-7 supports video via the Files API but
// that's a separate ingest path, not a chat-message modality.
//
// Sources: api.anthropic.com/docs/models, 1M-context beta header for
// opus-4-7. maxOutput is the standard default (extended-output beta
// raises it on some Sonnet 4.x — kept conservative).
const _CLAUDE_MULTIMODAL = { tools: true, vision: true, audio: false, video: false };
const _ANTHROPIC_MODEL_META = [
  { prefix: 'claude-opus-4-7',    contextLength: 1000000, maxOutput: 32000, family: 'opus',   capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-opus-4-1',    contextLength: 200000,  maxOutput: 32000, family: 'opus',   capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-opus-4',      contextLength: 200000,  maxOutput: 32000, family: 'opus',   capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-sonnet-4-6',  contextLength: 200000,  maxOutput: 64000, family: 'sonnet', capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-sonnet-4-5',  contextLength: 200000,  maxOutput: 64000, family: 'sonnet', capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-sonnet-4',    contextLength: 200000,  maxOutput: 64000, family: 'sonnet', capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-haiku-4-5',   contextLength: 200000,  maxOutput: 8192,  family: 'haiku',  capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-haiku-4',     contextLength: 200000,  maxOutput: 8192,  family: 'haiku',  capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-3-5-sonnet',  contextLength: 200000,  maxOutput: 8192,  family: 'sonnet', capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-3-5-haiku',   contextLength: 200000,  maxOutput: 8192,  family: 'haiku',  capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-3-opus',      contextLength: 200000,  maxOutput: 4096,  family: 'opus',   capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-3-sonnet',    contextLength: 200000,  maxOutput: 4096,  family: 'sonnet', capabilities: _CLAUDE_MULTIMODAL },
  { prefix: 'claude-3-haiku',     contextLength: 200000,  maxOutput: 4096,  family: 'haiku',  capabilities: _CLAUDE_MULTIMODAL },
];

// Anthropic extended-thinking config translator. Two flavors:
//   - Adaptive (opus 4.6 / 4.7): { thinking: { type: 'adaptive' } } plus
//     top-level { output_config: { effort: 'low' | 'medium' | 'high' } }.
//   - Budget (everything else with thinking — sonnet 4.x, opus 4.0/4.1/4.5,
//     haiku 4.x): { thinking: { type: 'enabled', budget_tokens: N } }.
//
// Adaptive-only models reject the budget shape ("thinking.type.enabled
// is not supported for this model"); budget-only models reject adaptive
// ("adaptive thinking is not supported on this model"). Verified against
// api.anthropic.com 2026-04 across all 9 currently-listed Claude models.
function applyAnthropicReasoningEffort(req, model, effort) {
  const m = String(model || '').toLowerCase();
  // Skip any model that isn't a thinking-capable Claude.
  if (!/sonnet|opus|haiku-4/i.test(m) || /3-5|3\.5/i.test(m)) return req;
  const out = { ...req };
  if (effort === 'off') {
    out.thinking = { type: 'disabled' };
    return out;
  }
  const isAdaptive = /^claude-opus-4-[67](-|$)/i.test(m);
  if (isAdaptive) {
    const efMap = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high' };
    const ef = efMap[effort] || 'medium';
    out.thinking = { type: 'adaptive' };
    out.output_config = { ...(out.output_config || {}), effort: ef };
    return out;
  }
  const budgets = { minimal: 1024, low: 2048, medium: 10000, high: 24000, max: 32000 };
  const budget = budgets[effort] || 10000;
  if ((out.max_tokens || 0) < budget + 1024) out.max_tokens = budget + 1024;
  out.thinking = { type: 'enabled', budget_tokens: budget };
  return out;
}

function _resolveAnthropicMeta(modelId) {
  if (!modelId) return null;
  // Longest match wins so `claude-opus-4-7-20251010` picks the 1M entry,
  // not the generic `claude-opus-4` 200K row.
  let best = null;
  for (const meta of _ANTHROPIC_MODEL_META) {
    if (modelId.startsWith(meta.prefix)) {
      if (!best || meta.prefix.length > best.prefix.length) best = meta;
    }
  }
  return best;
}

async function _listAnthropicModels({ apiKey }) {
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return { ok: false, error: 'missing apiKey' };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    if (!d || !Array.isArray(d.data)) return { ok: false, error: 'no `data` array in response' };
    const models = d.data.map(m => {
      const id = m.id || '';
      if (!id) return null;
      const meta = _resolveAnthropicMeta(id);
      return {
        id,
        contextLength: meta?.contextLength || null,
        maxOutput: meta?.maxOutput || null,
        family: meta?.family || null,
        // capabilities = INTERSECTION of (what model supports) AND (what
        // our client transports). The Anthropic SDK natively handles
        // image content blocks; audio/video aren't a chat-message
        // modality on api.anthropic.com (Files API is a separate ingest
        // path) so we don't claim them.
        capabilities: meta?.capabilities || null,
        displayName: m.display_name || null,
      };
    }).filter(Boolean);
    // Sort opus first, then sonnet, then haiku, alphabetically inside family.
    const familyOrder = { opus: 0, sonnet: 1, haiku: 2 };
    models.sort((a, b) => {
      const fa = familyOrder[a.family] ?? 99;
      const fb = familyOrder[b.family] ?? 99;
      if (fa !== fb) return fa - fb;
      return b.id.localeCompare(a.id); // newer-first inside family (date suffix)
    });
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const apiKey = host?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    api.setConfig({ apiKey })
      .catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info('Migrated legacy ANTHROPIC_API_KEY into plugins.anthropic-provider.apiKey');
  }
}

// OAuth token detection — Anthropic's Claude.ai Pro/Max OAuth tokens
// (sk-ant-oat-…) require a different request shape (Claude Code system
// prompt prefix, OAuth headers). Several callsites in core check this
// flag (system-prompt builders in agent/loop, tools, workers/janitor,
// workers/learner). The flag SHAPE stays in host config; the
// DETECTION logic lives here so core has no Anthropic-specific
// string-matching.
function _detectOAuth(api) {
  const host = api.getHostConfig() || {};
  const slot = api.getConfig() || {};
  const key = process.env.ANTHROPIC_API_KEY || host.anthropicApiKey || slot.apiKey || '';
  const isOAuth = !!(key && key.includes('sk-ant-oat'));
  host._isOAuth = isOAuth;
  if (isOAuth) api.getLogger().info('Detected OAuth token — using Claude Code auth headers');
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);
  _detectOAuth(api);

  api.registerProvider('anthropic', (config) => {
    const slot = config?.plugins?.['anthropic-provider'] || {};
    // Env wins over slot — Settings-pane Save with stale defaults must
    // not poison what the wizard / .env wrote. Slot is the fallback for
    // ops who edit via the UI before any env value exists.
    const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey || slot.apiKey || '';
    return createAnthropicClient({
      apiKey,
      displayName: config.displayName || 'Spore Core',
      apiTimeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['claude'],
    label: 'Anthropic / Claude',
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['anthropic-provider'] || {};
      return !!(process.env.ANTHROPIC_API_KEY || config?.anthropicApiKey || slot.apiKey);
    },
    // Wizard "populate models" + tier ctx auto-enrichment hits this. The
    // body { kind: 'anthropic', apiKey } comes either from the wizard's
    // editor or from _enrichModelLimits at save time. apiKey-from-body
    // honored first (operator may be probing a key they haven't saved yet),
    // env / host config / slot as fallbacks.
    listModels: async (body) => {
      const host = api.getHostConfig();
      const slot = api.getConfig();
      const apiKey = (body?.apiKey || '').trim()
        || process.env.ANTHROPIC_API_KEY
        || host?.anthropicApiKey
        || slot?.apiKey
        || '';
      return _listAnthropicModels({ apiKey });
    },
    applyReasoningEffort: applyAnthropicReasoningEffort,
    // host config field is `thinkingBudget` (numeric, kept for backward
    // compat with existing operator setups). Treat any positive value
    // as "operator wants thinking on" and map to medium effort. The
    // applyReasoningEffort translator turns medium → adaptive medium
    // for 4.6/4.7 and budget_tokens=10000 for the budget-shape models.
    getDefaultReasoningEffort: (model, hostConfig) => {
      const m = String(model || '').toLowerCase();
      if (!/sonnet|opus|haiku-4/i.test(m) || /3-5|3\.5/i.test(m)) return null;
      return (hostConfig?.thinkingBudget > 0) ? 'medium' : null;
    },
    // Wizard test-button probe — tiny chat call so an operator gets a
    // real round-trip + latency, not just key validation. Uses haiku
    // for speed.
    // OAuth-token-aware system prompt wrapper. When the active key is
    // an sk-ant-oat token (Claude.ai Pro / Max), Anthropic's API
    // expects the assistant to identify as Claude Code at the very
    // start of the system prompt — same convention claude-cli uses.
    // Standard sk-ant-api03 keys don't need this prefix, neither do
    // any other vendor. The flag is set by _detectOAuth on register +
    // every onConfigChange.
    wrapSystemPrompt: (system, model, hostConfig) => {
      if (!hostConfig?._isOAuth) return system;
      const claudeCodeId = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (Array.isArray(system)) {
        // Already wrapped? leave alone.
        if (system[0]?.text === claudeCodeId) return system;
        return [{ type: 'text', text: claudeCodeId }, ...system];
      }
      if (typeof system === 'string' && system.startsWith(claudeCodeId)) return system;
      // Build the structured form so cache_control etc. on subsequent
      // blocks can be added by callers without losing the prefix.
      return [{ type: 'text', text: claudeCodeId }, { type: 'text', text: system || '' }];
    },
    probe: async (body) => {
      const apiKey = (body?.apiKey || '').trim()
        || process.env.ANTHROPIC_API_KEY
        || api.getHostConfig()?.anthropicApiKey
        || api.getConfig()?.apiKey
        || '';
      if (!apiKey) return { ok: false, error: 'missing apiKey' };
      try {
        const t0 = Date.now();
        const client = createAnthropicClient({ apiKey, apiTimeoutMs: 10000 });
        const resp = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Respond with a single word: ok' }],
        });
        const text = (resp.content || []).find(b => b.type === 'text')?.text || '';
        return { ok: true, latency_ms: Date.now() - t0, model: 'claude-haiku-4-5', excerpt: text.slice(0, 80) };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    },
  });

  api.registerSettingsPane({
    tab: 'providers',
    title: 'Anthropic (Claude)',
    description: 'Claude Opus / Sonnet / Haiku via api.anthropic.com. Use model strings like `claude-haiku-4-5` (no prefix needed) in tier routing. Supports both standard API keys and Claude.ai OAuth tokens (sk-ant-oat-…).',
    schema: [
      { key: 'apiKey', label: 'ANTHROPIC_API_KEY', type: 'password', secret: true,
        envFallback: 'ANTHROPIC_API_KEY',
        help: 'Standard sk-ant-api03-… key OR Claude.ai OAuth token (sk-ant-oat-…) from Pro / Max plans.' },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Only mirror non-empty values. Empty form input = "leave alone".
    if (!newCfg.apiKey) return;
    const host = api.getHostConfig();
    host.anthropicApiKey = newCfg.apiKey;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') {
        gw._applyEnvUpdates({ ANTHROPIC_API_KEY: newCfg.apiKey });
      }
    } catch (e) { api.getLogger().warn('ANTHROPIC env mirror failed: ' + e.message); }
    // Re-detect OAuth flag — operator may have switched between a
    // standard sk-ant-api03 key and an sk-ant-oat OAuth token.
    _detectOAuth(api);
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || host.anthropicApiKey || slot.apiKey || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const client = createAnthropicClient({ apiKey, apiTimeoutMs: 10000 });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Respond with a single word: ok' }],
      });
      const text = (resp.content || []).find(b => b.type === 'text')?.text || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, model: 'claude-haiku-4-5', excerpt: text.slice(0, 80) }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
    }
  });

  api.getLogger().info(`Plugin ready — provider 'anthropic' (prefix: claude) registered.`);
};
