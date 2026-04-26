// elevenlabs plugin — TTS via ElevenLabs.
// Server-side only. Generic enough to be usable by any voice surface
// (web, telegram, discord) — VoicePipeline walks the plugin TTS
// registry at boot.

const { ElevenLabsTTS } = require('./lib/elevenlabs-tts');

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    // v2 adds the ref-api-keys catalog patch (XI_API_KEY entry).
    schemaVersion: 2,
  });

  api.registerTTSProvider('elevenlabs', (config) => new ElevenLabsTTS(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.elevenlabs || {};
      return !!(slot.apiKey || config?.xiApiKey);
    },
  });

  api.getLogger().info('Plugin ready — TTS provider "elevenlabs" + ref-elevenlabs-api node registered.');
};
