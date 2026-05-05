/**
 * Reactivity — verifies subscribers fire correctly and patch coalescing
 * works (one event per pattern, even when multiple matching keys
 * change in the same patch).
 *
 * Run: node --test tests/settings/reactivity.test.js
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
  const settings = require('../../src/settings');
  settings.boot({ skipLegacy: true });
  return { settings, tmp };
}

test('subscriber receives change set on patch', () => {
  const { settings, tmp } = freshSettings();
  let received = null;
  settings.subscribe('voice.silenceThresholdMs', changes => { received = changes; });
  settings.applyPatch({ 'voice.silenceThresholdMs': 600 });
  assert.ok(received);
  assert.equal(received.length, 1);
  assert.equal(received[0].key, 'voice.silenceThresholdMs');
  assert.equal(received[0].newValue, 600);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('glob subscriber fires once when multiple matching keys change in one patch', () => {
  const { settings, tmp } = freshSettings();
  let calls = 0;
  let sawKeys = [];
  settings.subscribe('voice.*', changes => {
    calls++;
    sawKeys = changes.map(c => c.key);
  });
  settings.applyPatch({
    'voice.enabled': true,
    'voice.silenceThresholdMs': 600,
    'voice.maxUtteranceSecs': 45,
  });
  assert.equal(calls, 1, 'glob fired more than once for a single patch');
  assert.equal(sawKeys.length, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('subscribers for unrelated keys are not invoked', () => {
  const { settings, tmp } = freshSettings();
  let voiceCalls = 0;
  let modelCalls = 0;
  settings.subscribe('voice.*', () => voiceCalls++);
  settings.subscribe('models.*', () => modelCalls++);
  settings.applyPatch({ 'voice.silenceThresholdMs': 500 });
  assert.equal(voiceCalls, 1);
  assert.equal(modelCalls, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('subscriber unsubscribes cleanly', () => {
  const { settings, tmp } = freshSettings();
  let calls = 0;
  const unsub = settings.subscribe('voice.*', () => calls++);
  settings.applyPatch({ 'voice.silenceThresholdMs': 500 });
  unsub();
  settings.applyPatch({ 'voice.silenceThresholdMs': 600 });
  assert.equal(calls, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('subscriber that throws does not break the patch', () => {
  const { settings, tmp } = freshSettings();
  let goodCalls = 0;
  settings.subscribe('voice.*', () => { throw new Error('subscriber boom'); });
  settings.subscribe('voice.*', () => goodCalls++);
  // Must not throw
  settings.applyPatch({ 'voice.silenceThresholdMs': 600 });
  assert.equal(goodCalls, 1);
  assert.equal(settings.get('voice.silenceThresholdMs'), 600);
  fs.rmSync(tmp, { recursive: true, force: true });
});
