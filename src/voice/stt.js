/**
 * voice/stt.js — Speech-to-Text factory
 *
 * STT providers (Deepgram, OpenAI Whisper, future…) are registered by
 * plugins via api.registerSTTProvider(name, factory, opts). This file
 * just walks the plugin registry and instantiates the right one based
 * on `config.voice.sttProvider`. When no plugin is installed (or none
 * is configured), STT is unavailable and the VoicePipeline disables
 * itself.
 *
 * Browser-side STT is similarly plugin-driven: graph-viewer.html boots
 * up by fetching /api/plugins/frontend-assets and inserting <script>
 * tags for each plugin asset (e.g. plugins/whisper/static/whisper-stt.js).
 */

/**
 * Build an STT instance.
 * @param {object} config — runtime config, including config.voice.sttProvider
 * @param {object} manager — plugin manager (from VoicePipeline constructor)
 * @returns {object|null} { transcribe(buf, mime) → {text, confidence} } or null
 */
function createSTT(config, manager) {
  if (!manager?.getSTTProviders) return null;
  const preferred = config?.voice?.sttProvider;
  const providers = manager.getSTTProviders();

  if (preferred) {
    const named = providers.find(p => p.name === preferred && p.configured);
    if (named) {
      try { return named.factory(config); } catch { /* fall through */ }
    }
  }
  const firstConfigured = providers.find(p => p.configured);
  if (firstConfigured) {
    try { return firstConfigured.factory(config); } catch { /* fall through */ }
  }
  return null;
}

module.exports = { createSTT };
