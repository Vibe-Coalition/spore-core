// compute-cluster plugin — SLURM cluster integration over SSH (and
// usually over a tailnet, though the plugin itself doesn't depend on
// the tailscale plugin being installed).
//
// Routes:
//   GET  /api/cluster/settings          — current cluster config
//   POST /api/cluster/settings          — save cluster config
//   POST /api/cluster/hosts             — replace additional clusters list
//   POST /api/cluster/test-ssh          — try SSH'ing to the configured login host
//   GET  /api/cluster/ssh-key           — current key + public + fingerprint
//   POST /api/cluster/ssh-key           — paste a private key
//   POST /api/cluster/ssh-key/generate  — mint a fresh ed25519 key
//   DELETE /api/cluster/ssh-key         — remove the key
//
// Path-aliased: /api/cluster/* rewrites to /api/plugins/compute-cluster/*
// via registerPathAlias so the existing UI keeps working.
//
// Reference node ref-compute-cluster carries the agent-facing docs.

const routes = require('./lib/cluster-routes');

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  api.registerPathAlias('cluster', { notFoundCode: 'CLUSTER_ROUTE_NOT_FOUND' });

  api.registerWebRoute('GET',    '/settings',          (req, res) => routes.getSettings(api, req, res));
  api.registerWebRoute('POST',   '/settings',          (req, res) => routes.postSettings(api, req, res));
  api.registerWebRoute('POST',   '/hosts',             (req, res) => routes.postHosts(api, req, res));
  api.registerWebRoute('POST',   '/test-ssh',          (req, res) => routes.postTestSsh(api, req, res));
  api.registerWebRoute('GET',    '/ssh-key',           (req, res) => routes.getSshKey(api, req, res));
  api.registerWebRoute('POST',   '/ssh-key',           (req, res) => routes.postSshKey(api, req, res));
  api.registerWebRoute('POST',   '/ssh-key/generate',  (req, res) => routes.postSshKeyGenerate(api, req, res));
  api.registerWebRoute('DELETE', '/ssh-key',           (req, res) => routes.deleteSshKey(api, req, res));

  // Settings pane in the Plugins tab. Markup is a thin mount-point;
  // static/cluster-settings.js (loaded via registerFrontendAsset)
  // populates it on the spore-plugin-panes-rendered event.
  api.registerSettingsPane({
    title: 'Compute Cluster',
    description: 'SLURM cluster access over SSH (typically over a tailnet).',
    html: '<div data-plugin-mount="compute-cluster">Loading…</div>',
  });
  api.registerFrontendAsset('cluster-settings.js');

  api.getLogger().info('Plugin ready — /api/cluster/{settings,hosts,test-ssh,ssh-key,ssh-key/generate} + ref-compute-cluster + settings pane + frontend asset registered.');
};
