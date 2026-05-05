/**
 * Registry well-formedness suite.
 *
 * Run from repo root:
 *   node --test tests/settings/registry.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../../src/settings/registry');
require('../../src/settings/defs.core');

test('all defs have unique keys', () => {
  const seen = new Set();
  for (const d of registry.all()) {
    assert.ok(!seen.has(d.key), `duplicate key: ${d.key}`);
    seen.add(d.key);
  }
});

test('all envVars are unique', () => {
  const seen = new Map();
  for (const d of registry.all()) {
    if (!d.envVar) continue;
    const prev = seen.get(d.envVar);
    assert.ok(!prev, `envVar ${d.envVar} claimed by both ${prev} and ${d.key}`);
    seen.set(d.envVar, d.key);
  }
});

test('enum defaults are members of their enum', () => {
  for (const d of registry.all()) {
    if (d.type !== 'enum' || d.default == null) continue;
    assert.ok(d.enum.includes(d.default),
      `enum default ${JSON.stringify(d.default)} not in enum for ${d.key}`);
  }
});

test('fallbackChain references resolve to registered keys', () => {
  for (const d of registry.all()) {
    if (!d.fallbackChain) continue;
    for (const f of d.fallbackChain) {
      assert.ok(registry.has(f), `${d.key}.fallbackChain references unknown key ${f}`);
    }
  }
});

test('all defs declare a non-empty scope', () => {
  for (const d of registry.all()) {
    assert.ok(Array.isArray(d.scope) && d.scope.length, `${d.key} has empty scope`);
  }
});

test('secret defs have type === "secret" or secret flag', () => {
  for (const d of registry.all()) {
    if (!d.secret) continue;
    assert.ok(d.type === 'secret' || d.structuredSecret, `${d.key} is marked secret but type is ${d.type}`);
  }
});
