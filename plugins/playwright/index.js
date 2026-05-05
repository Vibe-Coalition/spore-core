'use strict';

// playwright plugin — registers a 'playwright' browser backend with
// browser-core. Standard Playwright Chromium driving; live screencast
// preview on by default. Less stealth-hardened than zendriver.

const PlaywrightBrowserBackend = require('./lib/backend');

module.exports = function register(api) {
  const log = api.getLogger ? api.getLogger() : console;

  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 2,
  });

  api.registerBrowserBackend('playwright', (ctx) => new PlaywrightBrowserBackend({
    log: ctx.log || log,
    broadcast: ctx.broadcast,
    config: ctx.config,
  }), {
    label: 'Playwright',
    aliases: ['pw'],
    capabilities: { stealth: false, screencast: true },
    isAvailable: () => true,
  });

  log.info('[plugin:playwright] Plugin ready — browser backend "playwright" registered.');
};
