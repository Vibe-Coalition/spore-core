/**
 * Model library — CRUD, override tracking, vendor refresh, migration.
 *
 * Run: node --test tests/settings/model-library.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshLib() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPORE_') || k === 'GRAPH_DB_PATH') delete process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-lib-test-'));
  process.env.SPORE_DATA_DIR = tmp;
  const settings = require('../../src/settings');
  settings.boot({ skipLegacy: true });
  const lib = require('../../src/settings/model-library');
  return { lib, settings, tmp };
}

test('add creates a row, returns created=true; duplicate add returns created=false', () => {
  const { lib, tmp } = freshLib();
  const r1 = lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7', source: 'manual' });
  assert.equal(r1.id, 'claude-opus-4-7');
  assert.equal(r1.created, true);
  const r2 = lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7' });
  assert.equal(r2.created, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('composeId follows the implicit-anthropic convention', () => {
  const { lib, tmp } = freshLib();
  assert.equal(lib.composeId('anthropic', 'claude-opus-4-7'), 'claude-opus-4-7');
  assert.equal(lib.composeId('openai', 'gpt-4o'), 'openai/gpt-4o');
  assert.equal(lib.composeId('OpenAI', 'gpt-4o'), 'openai/gpt-4o');
  assert.deepEqual(lib.parseId('openai/gpt-4o'), { provider: 'openai', modelId: 'gpt-4o' });
  assert.deepEqual(lib.parseId('claude-haiku-4-5'), { provider: 'anthropic', modelId: 'claude-haiku-4-5' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('update tracks user overrides', () => {
  const { lib, tmp } = freshLib();
  lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7', contextWindow: 200000 });
  lib.update('claude-opus-4-7', { contextWindow: 250000, reasoningEffortDefault: 'high' });
  const e = lib.get('claude-opus-4-7');
  assert.equal(e.contextWindow, 250000);
  assert.equal(e.reasoningEffortDefault, 'high');
  assert.deepEqual(new Set(e.userOverrides), new Set(['contextWindow', 'reasoningEffortDefault']));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyVendorRefresh updates non-overridden fields, preserves user-pinned values', () => {
  const { lib, tmp } = freshLib();
  lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7', contextWindow: 200000 });
  // User pins context window to 250000
  lib.update('claude-opus-4-7', { contextWindow: 250000 });
  // Vendor refresh tries to set contextWindow back to 200000 and adds family
  const r = lib.applyVendorRefresh('claude-opus-4-7', { contextWindow: 200000, family: 'claude-4', maxOutput: 16384 });
  assert.equal(r.updated, true);
  const e = lib.get('claude-opus-4-7');
  assert.equal(e.contextWindow, 250000, 'user override must survive vendor refresh');
  assert.equal(e.family, 'claude-4');
  assert.equal(e.maxOutput, 16384);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('resetMetadata clears overrides and applies vendor fields', () => {
  const { lib, tmp } = freshLib();
  lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7' });
  lib.update('claude-opus-4-7', { contextWindow: 999999 });
  let e = lib.get('claude-opus-4-7');
  assert.equal(e.userOverrides.length, 1);
  lib.resetMetadata('claude-opus-4-7', { contextWindow: 200000, family: 'claude' });
  e = lib.get('claude-opus-4-7');
  assert.equal(e.contextWindow, 200000);
  assert.deepEqual(e.userOverrides, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('list filters by provider and enabledOnly', () => {
  const { lib, tmp } = freshLib();
  lib.add({ provider: 'anthropic', modelId: 'claude-opus-4-7' });
  lib.add({ provider: 'openai', modelId: 'gpt-4o' });
  lib.add({ provider: 'openai', modelId: 'gpt-4o-mini', enabled: false });
  assert.equal(lib.list({ provider: 'openai' }).length, 2);
  assert.equal(lib.list({ provider: 'openai', enabledOnly: true }).length, 1);
  assert.equal(lib.list().length, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureFromSettingsSnapshot seeds routed models with modelLimits metadata', () => {
  const { lib, tmp } = freshLib();
  const out = lib.ensureFromSettingsSnapshot({
    models: {
      planner: 'local//blob/raw/checkpoints/Qwen3.6-27B',
      normal: 'local//blob/raw/checkpoints/Qwen3.6-27B',
    },
    modelLimits: {
      'local//blob/raw/checkpoints/Qwen3.6-27B': { contextWindow: 262144, maxOutput: 8192 },
    },
  });
  assert.deepEqual(out.added, ['local//blob/raw/checkpoints/Qwen3.6-27B']);
  const row = lib.get('local//blob/raw/checkpoints/Qwen3.6-27B');
  assert.equal(row.provider, 'local');
  assert.equal(row.modelId, '/blob/raw/checkpoints/Qwen3.6-27B');
  assert.equal(row.contextWindow, 262144);
  assert.equal(row.maxOutput, 8192);
  assert.equal(row.source, 'auto');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('legacy modelLimits + tier strings migrate into the library on first boot', () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPORE_') || k === 'GRAPH_DB_PATH') delete process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-lib-mig-'));
  process.env.SPORE_DATA_DIR = tmp;
  // Seed a spore.json that the migrator will pick up
  fs.writeFileSync(path.join(tmp, 'spore.json'), JSON.stringify({
    casualModel: 'claude-haiku-4-5',
    plannerModel: 'claude-opus-4-7',
    recallModel: 'gpt-4o-mini',
    modelLimits: {
      'claude-opus-4-7': { contextWindow: 200000, compactAt: 170000 },
      'openai/gpt-4o-mini': { contextWindow: 128000 },
    },
  }, null, 2));
  const settings = require('../../src/settings');
  settings.boot();
  const lib = require('../../src/settings/model-library');
  const ids = new Set(lib.list().map(e => e.id));
  assert.ok(ids.has('claude-haiku-4-5'));
  assert.ok(ids.has('claude-opus-4-7'));
  assert.ok(ids.has('openai/gpt-4o-mini'));
  // contextWindow + compactAt got merged from modelLimits
  const opus = lib.get('claude-opus-4-7');
  assert.equal(opus.contextWindow, 200000);
  assert.equal(opus.compactAt, 170000);
  // recallModel correctly inferred to be openai (gpt-* prefix)
  const recall = lib.get('openai/gpt-4o-mini');
  assert.equal(recall.provider, 'openai');
  assert.equal(recall.contextWindow, 128000);
  // Migrated rows are flagged
  for (const e of lib.list()) {
    assert.equal(e.source, 'migration');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('migration is idempotent (second boot is a no-op)', () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-lib-idem-'));
  process.env.SPORE_DATA_DIR = tmp;
  fs.writeFileSync(path.join(tmp, 'spore.json'), JSON.stringify({
    plannerModel: 'claude-opus-4-7',
  }, null, 2));
  let settings = require('../../src/settings');
  settings.boot();
  let lib = require('../../src/settings/model-library');
  assert.equal(lib.count(), 1);
  // Reboot
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  settings = require('../../src/settings');
  settings.boot();
  lib = require('../../src/settings/model-library');
  assert.equal(lib.count(), 1, 'migration must not double-seed');
  fs.rmSync(tmp, { recursive: true, force: true });
});
