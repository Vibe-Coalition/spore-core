// elevenlabs plugin — TTS via ElevenLabs.
// Server-side only. Generic enough to be usable by any voice surface
// (web, telegram, discord) — VoicePipeline walks the plugin TTS
// registry at boot.

const { ElevenLabsTTS } = require('./lib/elevenlabs-tts');

// One-time backfill: legacy spore.json files put the key at top-level
// `xiApiKey`. Hoist it into the plugin's slot so future code paths
// only need to look in one place. Drop this shim after one release.
function _backfill(api) {
  const config = api.getHostConfig?.() || api._appContext?.config || null;
  if (!config) return;
  const legacy = config.xiApiKey;
  if (!legacy) return;
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.elevenlabs) config.plugins.elevenlabs = {};
  if (!config.plugins.elevenlabs.apiKey) {
    config.plugins.elevenlabs.apiKey = legacy;
    api.getLogger().warn(
      '[plugin:elevenlabs] Migrated legacy config.xiApiKey -> config.plugins.elevenlabs.apiKey. ' +
      'Update your spore.json to remove the top-level xiApiKey field.',
    );
  }
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    // v3 adds the spore→ref-elevenlabs-api `documents` edge that used
    // to live in seed-graph.sql.
    schemaVersion: 3,
  });

  _backfill(api);

  api.registerTTSProvider('elevenlabs', (config) => new ElevenLabsTTS(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.elevenlabs || {};
      return !!(slot.apiKey || process.env.XI_API_KEY);
    },
  });

  api.getLogger().info('Plugin ready — TTS provider "elevenlabs" + ref-elevenlabs-api node registered.');
};
