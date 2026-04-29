// Anthropic Claude client wrapper. Lifts the OAuth + standard-key
// dispatch from the legacy Anthropic-default branch in core's
// src/providers/index.js (lines 1177-1191 pre-extraction).
//
// The Anthropic SDK already returns the "Anthropic-shape" message
// envelope every other provider plugin produces — no adapter layer
// needed. This file is just the constructor + auth-dispatch logic.

const Anthropic = require('@anthropic-ai/sdk');

// Per-model param compatibility filter. Anthropic deprecated certain
// chat-completion params for newer models (opus-4-7 currently rejects
// `temperature` with HTTP 400 `temperature is deprecated for this model`).
// Other Claude families (sonnet 4.x, haiku 4.x, opus 4.0/4.1/4.5/4.6,
// 3.x line) still accept the legacy params. Keep this filter table
// next to the client so callers (workers, recall, agent) can keep
// sending the legacy params unchanged.
const _UNSUPPORTED_PARAMS = [
  // matcher returns array of param names to strip from the request
  { test: (m) => /^claude-opus-4-7(-|$)/i.test(m), strip: ['temperature', 'top_p', 'top_k'] },
];

function _filterParams(params) {
  if (!params?.model) return params;
  const out = { ...params };
  for (const rule of _UNSUPPORTED_PARAMS) {
    if (rule.test(params.model)) {
      for (const k of rule.strip) {
        if (k in out) delete out[k];
      }
    }
  }
  return out;
}

function createAnthropicClient({ apiKey, displayName, apiTimeoutMs }) {
  if (!apiKey) throw new Error('Anthropic provider: no API key (set plugins.anthropic-provider.apiKey or ANTHROPIC_API_KEY)');

  // OAuth tokens (sk-ant-oat-…) come from Claude.ai's Pro / Max creator
  // credentials and need a different auth shape than standard API keys:
  //   - authToken: <token> (not apiKey: …)
  //   - mandatory anthropic-beta header for the OAuth grant scope
  //   - claude-cli user-agent the OAuth flow expects
  const isOAuth = apiKey.includes('sk-ant-oat');
  const opts = isOAuth
    ? {
        authToken: apiKey,
        apiKey: null,
        defaultHeaders: {
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'user-agent': 'claude-cli/2.1.75',
          'x-app': 'cli',
        },
      }
    : { apiKey };

  if (apiTimeoutMs) opts.timeout = apiTimeoutMs;

  // Wrap the SDK so messages.create / messages.stream silently strip
  // params the active model doesn't accept. Without this, callers who
  // pass `temperature: 0` (a common nudge for deterministic JSON
  // output, used by recall / rerank / decompose) crash on opus-4-7.
  const sdk = new Anthropic(opts);
  return {
    ...sdk,
    messages: {
      ...sdk.messages,
      create: (params, opts2) => sdk.messages.create(_filterParams(params), opts2),
      stream: (params, opts2) => sdk.messages.stream(_filterParams(params), opts2),
    },
  };
}

module.exports = { createAnthropicClient };
