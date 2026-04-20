#!/usr/bin/env node
/**
 * gateway.js — Compatibility wrapper
 *
 * Historically this was the main entrypoint. The richer multi-platform boot
 * flow now lives in `app.js`, but this file remains so old commands, scripts,
 * and systemd units keep working.
 */

const { boot } = require('./app');

boot().catch(e => {
  console.error('SPORE boot failed:', e);
  process.exit(1);
});
