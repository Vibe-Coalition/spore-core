// Reference contract: OAI-compatible chat-completion client.
//
// Phase B of the provider extraction re-exports the existing
// OAICompatClient from core's `src/providers/index.js`. Phase E will
// move the implementation into this plugin and core will require it
// from here. Until then, this file is a thin shim — its purpose is to
// give other provider plugins (openai-provider, openrouter-provider)
// a stable import path that survives the eventual code move.
//
// Usage from a sibling provider plugin:
//   const { OAICompatClient } = require('../../local-oai-provider/lib/oai-compat-client');

const { OAICompatClient } = require('../../../providers');

module.exports = { OAICompatClient };
