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

// One-time backfill: legacy spore.json files put the key at top-level
// `deepgramApiKey`. Hoist it into the plugin's slot. Drop this shim
// after one release.
function _backfill(api) {
  const config = api.getHostConfig?.() || api._appContext?.config || null;
  if (!config) return;
  const legacy = config.deepgramApiKey;
  if (!legacy) return;
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.deepgram) config.plugins.deepgram = {};
  if (!config.plugins.deepgram.apiKey) {
    config.plugins.deepgram.apiKey = legacy;
    api.getLogger().warn(
      '[plugin:deepgram] Migrated legacy config.deepgramApiKey -> config.plugins.deepgram.apiKey. ' +
      'Update your spore.json to remove the top-level deepgramApiKey field.',
    );
  }
}

module.exports = function register(api) {
  // Patches the ref-api-keys catalog so the agent sees DEEPGRAM_API_KEY
  // listed as available only when this plugin is installed. No
  // dedicated ref node — the SDK interface is generic enough.
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  _backfill(api);

  api.registerSTTProvider('deepgram', (config) => new DeepgramSTT(config), {
    isConfigured: (config) => {
      const slot = config?.plugins?.deepgram || {};
      return !!(slot.apiKey || process.env.DEEPGRAM_API_KEY);
    },
  });

  api.getLogger().info('Plugin ready — STT provider "deepgram" (Nova-3) + catalog entry registered.');
};
