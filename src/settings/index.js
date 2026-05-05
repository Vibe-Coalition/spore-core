/**
 * settings/index.js — public surface.
 *
 *   const settings = require('./settings');
 *   settings.boot({ dataDir, settingsDbPath });
 *   settings.get('voice.silenceThresholdMs');
 *   settings.modelForTier('planner');
 *   settings.snapshot();           // nested object view
 *   settings.snapshotFlat();
 *   settings.subscribe('voice.*', handler);
 *   settings.applyPatch({ ... }, { actor: 'settings-ui' });
 */

'use strict';

const registry = require('./registry');
const store = require('./store');
const loader = require('./loader');
const transport = require('./transport');
const { matchGlob } = require('./paths');

function get(key) { return store.get(key); }

function has(key) { return store.has(key); }

function provenance(key) { return store.provenance(key); }
function isEnvLocked(key) { return store.isEnvLocked(key); }

/**
 * Resolve a model tier with fallback chain. The chain is declared once
 * on each model SettingDef via `fallbackChain`. Replaces the duplicated
 * `plannerModel || normalModel || casualModel` ladders.
 *
 *   settings.modelForTier('planner')
 *   settings.modelForTier('subagent', { strict: true })
 */
function modelForTier(tier, opts = {}) {
  const key = tier.startsWith('models.') ? tier : `models.${tier}`;
  const def = registry.get(key);
  if (!def) return null;

  const direct = store.get(key);
  if (direct) return direct;
  if (opts.strict) return null;

  if (Array.isArray(def.fallbackChain)) {
    for (const fkey of def.fallbackChain) {
      const v = store.get(fkey);
      if (v) return v;
    }
  }
  return null;
}

function snapshotFlat() { return store.snapshotFlat(); }
function snapshot() { return store.snapshotNested(); }

/**
 * Snapshot suitable for the settings UI: secrets masked, provenance
 * stamped, env-lock flag attached.
 */
function snapshotForUI(opts = {}) {
  const wantScope = opts.scope || null;
  const flat = store.snapshotFlat();
  const out = { values: {}, meta: {} };
  const hasSecretValue = (value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return !!value;
  };
  for (const [key, value] of Object.entries(flat)) {
    const def = registry.get(key);
    if (!def) continue;
    if (wantScope && !def.scope.includes(wantScope)) continue;
    out.values[key] = def.secret ? (hasSecretValue(value) ? '__set__' : null) : value;
    out.meta[key] = {
      provenance: store.provenance(key),
      envLocked: store.isEnvLocked(key),
      envVar: def.envVar || null,
      type: def.type,
      label: def.label || null,
      group: def.group || null,
      secret: !!def.secret,
    };
  }
  return out;
}

function subscribe(pattern, handler) { return store.subscribe(pattern, handler); }

function applyPatch(patch, opts) { return transport.applyPatch(patch, opts); }

/**
 * Translate a legacy nested wizard / settings payload into a flat
 * patch ready for applyPatch. See transport.flattenWizardPayload for
 * the supported input shape.
 */
function flattenWizardPayload(body) { return transport.flattenWizardPayload(body); }

function listByGroup(group) { return registry.listByGroup(group); }
function listByScope(scope) { return registry.listByScope(scope); }
function listByPlugin(pluginId) { return registry.listByPlugin(pluginId); }
function getDef(key) { return registry.get(key); }
function allDefs() { return registry.all(); }

function boot(opts) { return loader.boot(opts); }
function isBooted() { return loader.isBooted(); }

module.exports = {
  // boot
  boot, isBooted,
  // reads
  get, has, provenance, isEnvLocked,
  modelForTier,
  snapshot, snapshotFlat, snapshotForUI,
  // writes + reactivity
  applyPatch, flattenWizardPayload, subscribe,
  // registry introspection
  listByGroup, listByScope, listByPlugin, getDef, allDefs,
  // sub-module access (for tests)
  _registry: registry, _store: store, _loader: loader, _transport: transport,
  matchGlob,
  PatchError: transport.PatchError,
};
