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
  // Patches the ref-api-keys catalog so the agent sees DEEPGRAM_API_KEY
  // listed as available only when this plugin is installed. No
  // dedicated ref node — the SDK interface is generic enough.
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  api.registerSTTProvider('deepgram', (config) => new DeepgramSTT(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.deepgram || {};
      return !!(slot.apiKey || config?.deepgramApiKey);
    },
  });

  api.getLogger().info('Plugin ready — STT provider "deepgram" (Nova-3) + catalog entry registered.');
};
