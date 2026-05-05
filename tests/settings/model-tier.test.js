/**
 * Model-tier fallback — replaces the duplicated `||` ladders at
 * agent/loop.js:524-527, agent/loop.js:1452-1458, plugins/longmemeval/
 * lib/runner.js:76-77, agent/effort.js.
 *
 * Run: node --test tests/settings/model-tier.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSettings() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/settings/') || k.includes('/src/config')) delete require.cache[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-set-test-'));
  process.env.SPORE_DATA_DIR = tmp;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPORE_') && k.includes('MODEL')) delete process.env[k];
  }
  const settings = require('../../src/settings');
  settings.boot({ skipLegacy: true });
  return { settings, tmp };
}

test('only planner set: every tier resolves to planner via fallback', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'models.planner': 'claude-opus-4-7' });
  assert.equal(settings.modelForTier('planner'), 'claude-opus-4-7');
  assert.equal(settings.modelForTier('normal'), 'claude-opus-4-7');
  assert.equal(settings.modelForTier('casual'), 'claude-opus-4-7');
  assert.equal(settings.modelForTier('subagent'), 'claude-opus-4-7');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('casual + planner set: normal falls back to planner first', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'models.casual': 'haiku', 'models.planner': 'opus' });
  // models.normal fallbackChain: ['models.planner', 'models.casual']
  assert.equal(settings.modelForTier('normal'), 'opus');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('strict mode returns null instead of falling back', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'models.planner': 'opus' });
  assert.equal(settings.modelForTier('subagent'), 'opus');           // fallback OK
  assert.equal(settings.modelForTier('subagent', { strict: true }), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('learner tier prefers casual over normal (per fallback chain)', () => {
  const { settings, tmp } = freshSettings();
  // models.learner fallbackChain: ['models.casual', 'models.normal']
  settings.applyPatch({ 'models.casual': 'haiku', 'models.normal': 'sonnet' });
  assert.equal(settings.modelForTier('learner'), 'haiku');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unknown tier returns null', () => {
  const { settings, tmp } = freshSettings();
  assert.equal(settings.modelForTier('nonsense'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});
