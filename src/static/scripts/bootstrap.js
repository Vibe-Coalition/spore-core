// bootstrap.js — small inline-bootstrap block from graph-viewer.html (lines
// 743-789 in the pre-split monolith). Loaded BEFORE app.js.

// ── Plugin frontend-asset loader ──
// Plugins declare browser JS via api.registerFrontendAsset(filename).
// Core serves the file at /api/plugins/<id>/static/<filename> and
// exposes the registry at /api/plugins/frontend-assets. We fetch the
// list synchronously-ish (fire-and-forget; assets attach to globals
// like window.WhisperSTT and the rest of the app reads those globals
// lazily). When a plugin is uninstalled the entry disappears from the
// list; on next page load no <script> is created.
(function loadPluginFrontendAssets() {
  try {
    fetch((window.location.pathname.replace(/\/graph\/?$/, '') || '') + '/api/plugins/frontend-assets')
      .then(r => r.ok ? r.json() : { assets: [] })
      .then(({ assets }) => {
        for (const a of (assets || [])) {
          const s = document.createElement('script');
          s.src = a.url;
          s.async = false; // Preserve declared order; later assets may depend on earlier ones.
          s.dataset.pluginAsset = a.pluginId + '/' + a.filename;
          document.head.appendChild(s);
        }
      })
      .catch(() => { /* silent: best-effort; missing assets just mean missing features */ });
  } catch { /* silent: best-effort */ }
})();

// ── Browser-side Whisper STT ──
// Lives in plugins/whisper/static/whisper-stt.js and is loaded at boot
// by the plugin frontend-asset loader above when the whisper plugin is
// installed. Attaches to `window.WhisperSTT`.
//
// We seed `window.WhisperSTT` with a noop placeholder on script-parse
// so existing call sites that reference the bare `WhisperSTT`
// identifier (which resolves to `window.WhisperSTT` in browser scope)
// don't throw before the async plugin script finishes loading. The
// plugin script overwrites `window.WhisperSTT` with the real impl
// when it loads. If the plugin isn't installed, the noop stays put
// and `WhisperSTT.isReady()` returns false — no Whisper code runs.
if (typeof window !== 'undefined' && !window.WhisperSTT) {
  window.WhisperSTT = {
    init: async () => {},
    transcribe: async () => null,
    isReady: () => false,
    isLoading: () => false,
  };
}
