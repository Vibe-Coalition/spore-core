// deepgram plugin — Deepgram Nova-3 STT.
// Server-side only; no browser-side counterpart. Generic enough to be
// usable by any voice surface (web, telegram, discord) — VoicePipeline
// walks the plugin STT registry at boot.
//
// When uninstalled:
//   • The 'deepgram' STT provider is no longer registered → server-
//     side calls fall back to whisper (if installed and configured)
//     or return null (voice disabled).

const { DeepgramSTT } = require('./lib/deepgram-stt');

module.exports = function register(api) {
  api.registerSTTProvider('deepgram', (config) => new DeepgramSTT(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.deepgram || {};
      return !!(slot.apiKey || config?.deepgramApiKey);
    },
  });

  api.getLogger().info('Plugin ready — STT provider "deepgram" (Nova-3) registered.');
};
