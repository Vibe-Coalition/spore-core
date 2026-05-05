/**
 * settings/store.js — in-memory typed store with provenance + glob
 * subscriptions.
 *
 * The store is the runtime view of settings. Values flow in from the
 * loader at boot (defaults → DB rows → env overrides) and from the
 * transport at write time. Long-lived consumers subscribe to glob
 * patterns and get notified after the patch commits.
 */

'use strict';

const { EventEmitter } = require('events');
const { matchGlob, setAtPath, deleteAtPath } = require('./paths');

class SettingsStore {
  constructor() {
    this._values = new Map();           // key → typed value
    this._provenance = new Map();       // key → 'default'|'db'|'env'
    this._envLocked = new Set();        // keys whose effective value comes from env
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0);
    this._subs = [];                    // [{ pattern, handler }]
  }

  // ── reads ──────────────────────────────────────────────────────────

  has(key) { return this._values.has(key); }

  get(key) {
    return this._values.has(key) ? this._values.get(key) : undefined;
  }

  provenance(key) { return this._provenance.get(key) || 'default'; }
  isEnvLocked(key) { return this._envLocked.has(key); }

  /**
   * Build a flat snapshot { 'voice.silenceThresholdMs': 400, ... }.
   * Useful for tests and the legacy config Proxy.
   */
  snapshotFlat() {
    const out = {};
    for (const [k, v] of this._values) out[k] = v;
    return out;
  }

  /**
   * Build a nested-object snapshot — the shape the rest of the app
   * has historically seen (config.voice.silenceThresholdMs).
   */
  snapshotNested() {
    const out = {};
    for (const [k, v] of this._values) setAtPath(out, k, v);
    return out;
  }

  // ── seed (boot path; bypasses event emission) ──────────────────────

  /**
   * Used by the loader to seed an initial value with provenance. Does
   * NOT emit change events.
   */
  seed(key, value, provenance = 'default', envLocked = false) {
    this._values.set(key, value);
    this._provenance.set(key, provenance);
    if (envLocked) this._envLocked.add(key);
    else this._envLocked.delete(key);
  }

  /** Strip a key entirely — used when DB row is deleted and no env override exists. */
  unseed(key) {
    this._values.delete(key);
    this._provenance.delete(key);
    this._envLocked.delete(key);
  }

  // ── writes (transport path; coalesced events) ──────────────────────

  /**
   * Apply a set of changes atomically and emit events once at the end.
   *   changes: [{ key, value, provenance? }]
   *   removals: [key]
   * Returns the set of changed keys (for the transport to surface in
   * its response).
   */
  applyPatch(changes = [], removals = []) {
    const touched = new Set();
    const oldValues = new Map();

    for (const { key } of changes) oldValues.set(key, this._values.get(key));
    for (const key of removals) oldValues.set(key, this._values.get(key));

    for (const change of changes) {
      const { key, value, provenance, envLocked } = change;
      this._values.set(key, value);
      this._provenance.set(key, provenance || 'db');
      if (envLocked) this._envLocked.add(key);
      else this._envLocked.delete(key);
      touched.add(key);
    }
    for (const key of removals) {
      this._values.delete(key);
      this._provenance.delete(key);
      this._envLocked.delete(key);
      touched.add(key);
    }

    // Coalesced event emission: one event per distinct subscriber match,
    // even if multiple keys in this patch matched the same pattern.
    const fired = new Set();
    for (const sub of this._subs) {
      const matches = [];
      for (const key of touched) {
        if (matchGlob(sub.pattern, key)) matches.push(key);
      }
      if (!matches.length) continue;
      if (fired.has(sub)) continue;
      fired.add(sub);
      try {
        const changeSet = matches.map(k => ({
          key: k,
          newValue: this._values.has(k) ? this._values.get(k) : undefined,
          oldValue: oldValues.get(k),
        }));
        sub.handler(changeSet);
      } catch (e) {
        // subscribers must not crash the transport; surface to console
        // since the store has no logger reference.
        // eslint-disable-next-line no-console
        console.warn(`[settings/store] subscriber for ${sub.pattern} threw: ${e.message}`);
      }
    }

    return touched;
  }

  // ── subscriptions ──────────────────────────────────────────────────

  subscribe(pattern, handler) {
    if (typeof handler !== 'function') throw new Error('subscribe(pattern, handler) requires a function');
    const sub = { pattern, handler };
    this._subs.push(sub);
    return () => {
      const i = this._subs.indexOf(sub);
      if (i >= 0) this._subs.splice(i, 1);
    };
  }

  /** @internal — for tests only */
  _reset() {
    this._values.clear();
    this._provenance.clear();
    this._envLocked.clear();
    this._subs.length = 0;
  }
}

const _instance = new SettingsStore();

module.exports = _instance;
module.exports.SettingsStore = SettingsStore;
