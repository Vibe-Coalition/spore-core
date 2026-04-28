// Re-export the existing GeminiClient from core (transitional). Phase E
// of the provider extraction will move the implementation into this
// plugin and core will require it from here. Until then this thin shim
// gives the plugin a stable import path while the contract settles.

const { GeminiClient } = require('../../../providers');

module.exports = { GeminiClient };
