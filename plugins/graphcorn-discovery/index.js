// Graphcorn Discovery Workflow plugin.
//
// Pure reference-node bundle. Adds the `discovery_workflow` aspect with 4
// attributes onto the existing `ref-acorn-context` node so acorn agents
// know when to call note_discovery vs graph_update and how the session
// graph anchors knowledge captured during a conversation.
//
// Depends on `acorn-cli` because the parent node `ref-acorn-context` is
// created by that plugin's install SQL. Until acorn-cli is extracted as
// its own plugin, the in-tree migration creates the parent node at boot.
module.exports = function register(api) {
  api.registerReferenceNodes({
    install: './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });
};
