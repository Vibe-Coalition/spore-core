/**
 * Transport tri-state semantics — the core regression suite for the
 * "empty wipes value" bug class.
 *
 * Run from repo root:
 *   node --test tests/settings/transport.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSettings() {
  // Drop module cache so each test gets a clean store + DB.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/settings/') || k.includes('/src/config')) delete require.cache[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-set-test-'));
  process.env.SPORE_DATA_DIR = tmp;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SPORE_PLANNER_MODEL;
  delete process.env.SPORE_PROACTIVE_ENABLED;
  delete process.env.SPORE_LEARNER_ACTIVATION_MODE;
  delete process.env.SPORE_LEARNER_ENABLED_PLATFORMS;
  const settings = require('../../src/settings');
  settings.boot({ skipLegacy: true });
  return { settings, tmp };
}

test('SET applies typed value', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'voice.silenceThresholdMs': 600 });
  assert.equal(settings.get('voice.silenceThresholdMs'), 600);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('null clears row and falls back to default', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'voice.silenceThresholdMs': 600 });
  assert.equal(settings.get('voice.silenceThresholdMs'), 600);
  settings.applyPatch({ 'voice.silenceThresholdMs': null });
  assert.equal(settings.get('voice.silenceThresholdMs'), 400);  // registry default
  assert.equal(settings.provenance('voice.silenceThresholdMs'), 'default');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('missing key in patch leaves value untouched (regression: wizard wiped baseUrl)', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'providers.openai.apiKey': 'sk-real', 'providers.openai.baseUrl': 'https://example.com' });
  // Now save a patch that ONLY mentions apiKey — baseUrl must survive
  settings.applyPatch({ 'providers.openai.apiKey': 'sk-newer' });
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-newer');
  assert.equal(settings.get('providers.openai.baseUrl'), 'https://example.com');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('empty string for secret = no-change (preserves masked-password UX)', () => {
  const { settings, tmp } = freshSettings();
  settings.applyPatch({ 'providers.openai.apiKey': 'sk-secret' });
  settings.applyPatch({ 'providers.openai.apiKey': '' });
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-secret');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('invalid type throws PatchError with offending key', () => {
  const { settings, tmp } = freshSettings();
  assert.throws(
    () => settings.applyPatch({ 'voice.silenceThresholdMs': 'not-an-int' }),
    err => err.errors.some(e => e.key === 'voice.silenceThresholdMs')
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unknown key throws PatchError', () => {
  const { settings, tmp } = freshSettings();
  assert.throws(
    () => settings.applyPatch({ 'voice.unknownKey': 1 }),
    err => err.errors[0].key === 'voice.unknownKey' && err.errors[0].error === 'unknown setting'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('out-of-range integer rejected via per-def validate', () => {
  const { settings, tmp } = freshSettings();
  assert.throws(
    () => settings.applyPatch({ 'voice.silenceThresholdMs': 50 }),  // min is 100
    err => err.errors[0].key === 'voice.silenceThresholdMs'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('learner activation settings are typed and proactive defaults off', () => {
  const { settings, tmp } = freshSettings();
  assert.equal(settings.get('proactive.enabled'), false);
  assert.equal(settings.get('learningMode'), 'always');
  assert.equal(settings.get('learnerActivationMode'), 'every_turn');
  assert.deepEqual(settings.get('learnerEnabledPlatforms'), ['web', 'cli', 'telegram', 'slack', 'discord', 'chatroom', 'api', 'unknown']);

  settings.applyPatch({
    learnerActivationMode: 'idle_batch',
    learnerIdleDelaySeconds: 30,
    learnerBatchMinTurns: 2,
    learnerBatchMaxTurns: 5,
    learnerMinExchangeChars: 64,
    learnerEnabledPlatforms: ['web', 'cli'],
  });

  assert.equal(settings.get('learnerActivationMode'), 'idle_batch');
  assert.equal(settings.get('learnerIdleDelaySeconds'), 30);
  assert.equal(settings.get('learnerBatchMinTurns'), 2);
  assert.equal(settings.get('learnerBatchMaxTurns'), 5);
  assert.equal(settings.get('learnerMinExchangeChars'), 64);
  assert.deepEqual(settings.get('learnerEnabledPlatforms'), ['web', 'cli']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('invalid learner platform list is rejected atomically', () => {
  const { settings, tmp } = freshSettings();
  assert.throws(
    () => settings.applyPatch({ learnerActivationMode: 'idle_batch', learnerEnabledPlatforms: ['web', 'fax'] }),
    err => err.errors.some(e => e.key === 'learnerEnabledPlatforms')
  );
  assert.equal(settings.get('learnerActivationMode'), 'every_turn');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('one bad key rejects entire patch (atomic)', () => {
  const { settings, tmp } = freshSettings();
  const before = settings.get('voice.silenceThresholdMs');
  assert.throws(() => settings.applyPatch({
    'voice.silenceThresholdMs': 600,            // valid
    'voice.maxUtteranceSecs': 'nope',           // invalid
  }));
  // Both rejected — first key did NOT land
  assert.equal(settings.get('voice.silenceThresholdMs'), before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('legacy nested settings payload maps advanced fields into canonical patch', () => {
  const { settings, tmp } = freshSettings();
  const patch = settings.flattenWizardPayload({
    publicUrl: 'https://spore.example',
    inviteKey: 'invite-secret',
    embedder: 'gemma-300m',
    providers: {
      custom: [{ name: 'groq', url: 'https://api.groq.com/openai/v1', key: 'sk-groq', authHeader: 'bearer' }],
    },
    agent: {
      effort: 'deep',
      budgets: {
        casualMessageBudget: null,
        complexMessageBudget: 90000,
        compactTokenThreshold: 120000,
        maxToolResultChars: 24000,
      },
    },
    budgets: {
      sections: { runtime: 2500 },
      total: null,
    },
  });

  assert.equal(patch.publicUrl, 'https://spore.example');
  assert.equal(patch.inviteKey, 'invite-secret');
  assert.equal(patch.embedder, 'gemma-300m');
  assert.deepEqual(patch['providers.custom'], [{ name: 'groq', url: 'https://api.groq.com/openai/v1', key: 'sk-groq', authHeader: 'bearer' }]);
  assert.equal(patch.agentEffort, 'deep');
  assert.equal(patch.casualMessageBudget, null);
  assert.equal(patch.complexMessageBudget, 90000);
  assert.equal(patch.compactTokenThreshold, 120000);
  assert.equal(patch.maxToolResultChars, 24000);
  assert.deepEqual(patch.sectionBudgets, { runtime: 2500 });
  assert.equal(patch.totalPromptBudget, null);

  fs.rmSync(tmp, { recursive: true, force: true });
});
