/**
 * settings/registry.js — typed setting definitions, indexed by key.
 *
 * Every setting in spore-core is declared here exactly once. Consumers
 * (loader, transport, UI snapshot, wizard) read from this registry
 * rather than re-declaring defaults, env-var names, or fallback chains
 * at the read sites.
 *
 * Plugins extend the registry at register() time via
 * api.registerSetting / api.registerSettings (see src/plugins/api.js).
 * Plugin keys are auto-namespaced under `plugins.<pluginId>.<key>`.
 */

'use strict';

const { isValidType } = require('./validators');

/** @typedef {Object} SettingDef
 *  @property {string} key
 *  @property {string} type
 *  @property {*}      default
 *  @property {string} [envVar]
 *  @property {Array}  [enum]
 *  @property {Function}[validate]
 *  @property {Function}[coerce]
 *  @property {boolean}[secret]
 *  @property {boolean}[structuredSecret] // true when a json value carries nested secrets
 *  @property {string[]}[scope]   // 'server'|'wizard'|'settings'|'runtime'|'bootstrap'
 *  @property {string} [group]
 *  @property {string} [label]
 *  @property {string} [help]
 *  @property {string} [placeholder]
 *  @property {boolean}[reactive]
 *  @property {string[]}[fallbackChain]
 *  @property {string[]}[legacyAlias]
 *  @property {string} [pluginId]
 *  @property {Function}[onApply]
 */

const _registry = new Map();
let _frozen = false;

function _err(msg) { throw new Error(`[settings/registry] ${msg}`); }

function _normalize(def) {
  if (!def || typeof def !== 'object') _err('def must be an object');
  if (typeof def.key !== 'string' || !def.key) _err('def.key required');
  if (!isValidType(def.type)) _err(`def.type invalid: ${def.type} (key=${def.key})`);
  const out = {
    key: def.key,
    type: def.type,
    default: def.default === undefined ? null : def.default,
    envVar: def.envVar || null,
    enum: Array.isArray(def.enum) ? def.enum : null,
    validate: typeof def.validate === 'function' ? def.validate : null,
    coerce: typeof def.coerce === 'function' ? def.coerce : null,
    secret: !!def.secret || def.type === 'secret',
    structuredSecret: !!def.structuredSecret,
    scope: Array.isArray(def.scope) && def.scope.length ? [...def.scope] : ['server', 'settings'],
    group: def.group || null,
    label: def.label || null,
    help: def.help || null,
    placeholder: def.placeholder || null,
    reactive: def.reactive !== false,
    fallbackChain: Array.isArray(def.fallbackChain) ? [...def.fallbackChain] : null,
    legacyAlias: Array.isArray(def.legacyAlias) ? [...def.legacyAlias] : null,
    pluginId: def.pluginId || null,
    onApply: typeof def.onApply === 'function' ? def.onApply : null,
    // Model-tier classifier consumed by the wizard's tier-row renderer:
    // 'main' (chat / planning / recall / etc.) vs 'vlm' (image / video /
    // audio multimodal). Other groups can extend this freely.
    tierKind: def.tierKind || null,
  };
  if (out.type === 'enum' && (!out.enum || !out.enum.length)) _err(`enum type requires non-empty enum (key=${out.key})`);
  if (out.type === 'enum' && out.default !== null && !out.enum.includes(out.default)) {
    _err(`enum default ${JSON.stringify(out.default)} not in enum (key=${out.key})`);
  }
  return out;
}

function register(def) {
  if (_frozen) _err(`registry frozen — cannot add ${def && def.key}`);
  const normalized = _normalize(def);
  if (_registry.has(normalized.key)) _err(`duplicate key: ${normalized.key}`);
  if (normalized.envVar) {
    for (const existing of _registry.values()) {
      if (existing.envVar === normalized.envVar) {
        _err(`envVar ${normalized.envVar} already claimed by ${existing.key} (offending key=${normalized.key})`);
      }
    }
  }
  _registry.set(normalized.key, normalized);
  return normalized;
}

function registerMany(defs) {
  return defs.map(register);
}

function get(key) { return _registry.get(key) || null; }

function has(key) { return _registry.has(key); }

function all() { return [..._registry.values()]; }

function listByGroup(group) {
  return all().filter(d => d.group === group);
}

function listByScope(scope) {
  return all().filter(d => d.scope.includes(scope));
}

function listByPlugin(pluginId) {
  return all().filter(d => d.pluginId === pluginId);
}

function freeze() { _frozen = true; }
function isFrozen() { return _frozen; }

/** @internal — for tests only */
function _reset() {
  _registry.clear();
  _frozen = false;
}

module.exports = {
  register, registerMany,
  get, has, all,
  listByGroup, listByScope, listByPlugin,
  freeze, isFrozen,
  _reset,
};
