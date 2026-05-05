/**
 * settings/paths.js — dotted-key utilities + glob matching.
 *
 * Registry keys are dotted strings ("voice.silenceThresholdMs",
 * "plugins.deepgram.apiKey"). The store stores them flat by their
 * dotted key; nested-object views are reconstructed on demand for
 * snapshot() and the legacy config.foo Proxy.
 */

'use strict';

function splitPath(key) {
  if (!key || typeof key !== 'string') return [];
  return key.split('.').filter(Boolean);
}

function getAtPath(obj, key) {
  const parts = splitPath(key);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAtPath(obj, key, value) {
  const parts = splitPath(key);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function deleteAtPath(obj, key) {
  const parts = splitPath(key);
  if (!parts.length) return false;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') return false;
    cur = cur[p];
  }
  return delete cur[parts[parts.length - 1]];
}

/**
 * Glob match for subscription patterns. Supports '*' (one segment),
 * '**' (any depth), and '*' inside a segment for prefix/suffix.
 *   'voice.*'             → matches voice.foo, NOT voice.foo.bar
 *   'plugins.*.apiKey'    → matches plugins.deepgram.apiKey
 *   'plugins.**'          → matches plugins.deepgram.apiKey (any depth)
 *   '*'                   → matches any single-segment key
 *   '**'                  → matches everything
 */
function matchGlob(pattern, key) {
  if (pattern === '**' || pattern === '*' && !key.includes('.')) {
    if (pattern === '**') return true;
    return !key.includes('.');
  }
  if (pattern === key) return true;

  const pp = pattern.split('.');
  const kp = key.split('.');

  let pi = 0;
  let ki = 0;
  while (pi < pp.length && ki < kp.length) {
    const seg = pp[pi];
    if (seg === '**') {
      // Match any number of remaining segments
      if (pi === pp.length - 1) return true;
      // Try every split: greedy with backtrack
      for (let j = ki; j <= kp.length; j++) {
        if (matchGlob(pp.slice(pi + 1).join('.'), kp.slice(j).join('.'))) return true;
      }
      return false;
    }
    if (seg === '*') {
      pi++; ki++;
      continue;
    }
    // Within-segment wildcard
    if (seg.includes('*')) {
      const re = new RegExp('^' + seg.split('*').map(escapeRe).join('.*') + '$');
      if (!re.test(kp[ki])) return false;
      pi++; ki++;
      continue;
    }
    if (seg !== kp[ki]) return false;
    pi++; ki++;
  }
  return pi === pp.length && ki === kp.length;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { splitPath, getAtPath, setAtPath, deleteAtPath, matchGlob };
