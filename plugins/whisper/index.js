// whisper plugin — server-side OpenAI Whisper STT + browser-side
// local Whisper (Transformers.js, whisper-tiny.en). Generic enough
// to be usable by any voice surface (web, telegram, discord) — STT
// providers register with core via api.registerSTTProvider; the
// VoicePipeline walks the registry at boot.
//
// When uninstalled:
//   • The 'openai' STT provider is no longer registered → server-side
//     calls fall back to deepgram (if configured) or return null.
//   • The browser-side WhisperSTT script no longer loads →
//     window.WhisperSTT is undefined → graph-viewer.html's voice
//     flow uses server STT only.

const { OpenAIWhisperSTT } = require('./lib/openai-whisper');

module.exports = function register(api) {
  // Register the server-side OpenAI Whisper STT provider. The
  // VoicePipeline picks this when config.voice.sttProvider === 'openai'
  // (or when it's the only configured option).
  api.registerSTTProvider('openai', (config) => new OpenAIWhisperSTT(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.whisper || {};
      return !!(slot.apiKey || config?.openaiApiKey);
    },
  });

  // Browser-side local Whisper — graph-viewer.html dynamically loads
  // this file at boot. The script attaches `window.WhisperSTT` so
  // existing call sites in graph-viewer.html keep working.
  api.registerFrontendAsset('whisper-stt.js');

  api.getLogger().info('Plugin ready — STT provider "openai" + browser-side WhisperSTT (whisper-tiny.en) registered.');
};
