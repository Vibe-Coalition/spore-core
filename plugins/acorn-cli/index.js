// Acorn CLI plugin.
//
// Phase 2.3a (this commit) ships the SQL ref-node bundle only. Subsequent
// sub-phases will fold in:
//   • note_discovery tool         (was src/tools/tools.js _noteDiscoveryTool)
//   • acorn settings pane + key   (was src/static/graph-viewer.html acorn UI
//                                   + src/gateways/web.js acornKey persistence
//                                   + /api/acorn/auth + /api/acorn/sessions)
//   • acorn-specific prompt text  (was src/graph/prompt-sections.js Project
//                                   Context block, ~130 lines of platform-
//                                   conditional text)
//
// Stays in core: src/graph/sessions.js, src/graph/projects.js, the loop.js
// graphcorn helpers, the learner's discovered_in edge creation. These are
// general graph-anchoring infrastructure; the plugin gates the user-facing
// capability layer, not the underlying machinery.
module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  api.getLogger().info('Plugin ready — ref-acorn-context bundle registered.');
};
