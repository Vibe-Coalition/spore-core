'use strict';

// zendriver plugin — registers a 'zendriver' browser backend with
// browser-core. The actual CDP traffic is in lib/backend.js (Node side)
// and helper/browser_helper.py (Python side). browser-core picks up
// this registration via api.registerBrowserBackend(...) and routes the
// `browser` tool's actions here when zendriver is the selected backend.

const ZendriverBrowserBackend = require('./lib/backend');

module.exports = function register(api) {
  const log = api.getLogger ? api.getLogger() : console;

  // v2: re-installs after browser-core's schema upgrade. browser-core's
  // upgrade path used to nuke the whole ref node; we bump here to
  // restore our aspect on existing graphs.
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 2,
  });

  api.registerBrowserBackend('zendriver', (ctx) => new ZendriverBrowserBackend({
    log: ctx.log || log,
    broadcast: ctx.broadcast,
    config: ctx.config,
  }), {
    label: 'Zendriver (stealth)',
    aliases: ['zd'],
    capabilities: { stealth: true, screencast: false },
    // Always available at runtime — the backend itself surfaces a
    // helpful error if the python `zendriver` package or a Chromium
    // binary is missing on the actual launch attempt.
    isAvailable: () => true,
  });

  log.info('[plugin:zendriver] Plugin ready — browser backend "zendriver" registered.');
};
