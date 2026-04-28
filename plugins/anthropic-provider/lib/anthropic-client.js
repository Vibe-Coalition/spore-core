// Anthropic Claude client wrapper. Lifts the OAuth + standard-key
// dispatch from the legacy Anthropic-default branch in core's
// src/providers/index.js (lines 1177-1191 pre-extraction).
//
// The Anthropic SDK already returns the "Anthropic-shape" message
// envelope every other provider plugin produces — no adapter layer
// needed. This file is just the constructor + auth-dispatch logic.

const Anthropic = require('@anthropic-ai/sdk');

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

  return new Anthropic(opts);
}

module.exports = { createAnthropicClient };
