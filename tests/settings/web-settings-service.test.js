'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshEnv() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPORE_') || k === 'OPENAI_API_KEY' || k === 'GRAPH_DB_PATH') {
      delete process.env[k];
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-web-settings-'));
  process.env.SPORE_DATA_DIR = tmp;
  return tmp;
}

function makeWeb(opts = {}) {
  const settings = require('../../src/settings');
  if (opts.beforeBoot) opts.beforeBoot(settings);
  settings.boot();
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const toolSystem = {
    config: require('../../src/config').loadConfig(),
    log,
    graph: null,
    skills: null,
    _pluginManager: opts.pluginManager || { getSTTProviders: () => [], getProviders: () => [], getSettingsPanes: () => [] },
    _agent: null,
    llmClient: { clearCache: () => {} },
  };
  const { WebGateway } = require('../../src/gateways/web');
  return { settings, web: new WebGateway(toolSystem) };
}

test('canonical settings state exposes values, meta, and schema', () => {
  const tmp = freshEnv();
  const { web } = makeWeb();
  const state = web._settingsService.getCanonicalSettingsState();

  assert.ok(state.values);
  assert.ok(state.meta);
  assert.ok(Array.isArray(state.schema));
  assert.ok(state.schema.some(d => d.key === 'models.planner'));
  assert.equal(state.meta['models.planner'].type, 'string');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('canonical plugin patch mirrors config and dispatches plugin changes', () => {
  const tmp = freshEnv();
  const changes = [];
  const pluginManager = {
    getSTTProviders: () => [],
    getProviders: () => [],
    getSettingsPanes: () => [],
    dispatchConfigChange: (pluginId, before, after) => {
      changes.push({ pluginId, before, after });
      return Promise.resolve();
    },
  };
  const { settings, web } = makeWeb({
    pluginManager,
    beforeBoot: s => {
      s._registry.register({
        key: 'plugins.demo.enabled',
        type: 'boolean',
        default: false,
        pluginId: 'demo',
        scope: ['settings'],
        group: 'plugins',
      });
    },
  });

  web.config.plugins = { demo: { enabled: false } };
  const { result } = web._settingsService.applyCanonicalPatch({ 'plugins.demo.enabled': true });

  assert.deepEqual(result.errors, []);
  assert.ok(result.changed.includes('plugins.demo.enabled'));
  assert.equal(settings.get('plugins.demo.enabled'), true);
  assert.equal(web.config.plugins.demo.enabled, true);
  assert.deepEqual(changes, [{
    pluginId: 'demo',
    before: { enabled: false },
    after: { enabled: true },
  }]);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('canonical patch applies typed values and masks secrets', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  const { result, settings: state } = web._settingsService.applyCanonicalPatch({
    'providers.openai.apiKey': 'sk-test',
    'voice.enabled': true,
  });

  assert.deepEqual(result.errors, []);
  assert.ok(result.changed.includes('providers.openai.apiKey'));
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-test');
  assert.equal(settings.get('voice.enabled'), true);
  assert.equal(web.config.openaiApiKey, 'sk-test');
  assert.equal(state.values['providers.openai.apiKey'], '__set__');
  assert.equal(state.values['voice.enabled'], true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('settings response redacts creator secrets and strips server config for webapp users', () => {
  const tmp = freshEnv();
  const { web } = makeWeb();
  web.config.openaiApiKey = 'sk-openai';
  web.config.anthropicApiKey = 'sk-anthropic';
  web.config.inviteKey = 'invite-secret';
  web.config.customProviders = {
    groq: { url: 'https://api.groq.com/openai/v1', key: 'sk-groq', authHeader: 'bearer' },
  };

  const creatorState = web._settingsService.getSettingsResponse({ role: 'creator' });
  assert.equal(creatorState.providers.openai.apiKey, '');
  assert.equal(creatorState.providers.openai.apiKeySet, true);
  assert.equal(creatorState.providers.anthropic.apiKey, '');
  assert.equal(creatorState.inviteKey, '');
  assert.equal(creatorState.inviteKeySet, true);
  assert.equal(creatorState.providers.custom[0].key, '');
  assert.equal(creatorState.providers.custom[0].keySet, true);

  const webappState = web._settingsService.getSettingsResponse({ role: 'webapp' });
  assert.equal(webappState.readonly, true);
  assert.equal(webappState.personalOnly, true);
  assert.deepEqual(webappState.values, {});
  assert.equal(webappState.providers, undefined);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('invite key regenerate action stores secret but only returns it once', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  const { result, settings: state, generatedSecrets } = web._settingsService.applyCanonicalPatch({}, {
    actor: 'web',
    actions: { regenerateInviteKey: true },
  });

  assert.ok(result.changed.includes('inviteKey'));
  assert.match(generatedSecrets.inviteKey, /^[0-9a-f-]{32,36}$/i);
  assert.equal(settings.get('inviteKey'), generatedSecrets.inviteKey);
  assert.equal(web.config.inviteKey, generatedSecrets.inviteKey);
  assert.equal(state.inviteKey, '');
  assert.equal(state.inviteKeySet, true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wizard ensureInviteKey mints invite key only when missing', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  const created = web._settingsService.persistSettingsPatch(
    { ensureInviteKey: true },
    { returnGeneratedSecrets: true },
  );
  assert.match(created.generatedSecrets.inviteKey, /^[0-9a-f-]{32,36}$/i);
  assert.equal(settings.get('inviteKey'), created.generatedSecrets.inviteKey);
  assert.equal(web.config.inviteKey, created.generatedSecrets.inviteKey);
  assert.equal(created.settings.inviteKey, '');
  assert.equal(created.settings.inviteKeySet, true);

  const kept = web._settingsService.persistSettingsPatch(
    { ensureInviteKey: true },
    { returnGeneratedSecrets: true },
  );
  assert.deepEqual(kept.generatedSecrets, {});
  assert.equal(settings.get('inviteKey'), created.generatedSecrets.inviteKey);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('custom provider keep sentinel preserves existing key and mirrors config', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();
  web.config.customProviders = {
    groq: { url: 'https://old.example/v1', key: 'sk-existing', authHeader: 'bearer' },
  };

  const { result, settings: state } = web._settingsService.applyCanonicalPatch({
    'providers.custom': [
      { name: 'groq', url: 'https://new.example/v1', key: '__KEEP__', authHeader: 'x-key' },
    ],
  });

  assert.ok(result.changed.includes('providers.custom'));
  assert.deepEqual(settings.get('providers.custom'), [
    { name: 'groq', url: 'https://new.example/v1', key: 'sk-existing', authHeader: 'x-key' },
  ]);
  assert.deepEqual(web.config.customProviders.groq, {
    url: 'https://new.example/v1',
    key: 'sk-existing',
    authHeader: 'x-key',
  });
  assert.equal(state.providers.custom[0].key, '');
  assert.equal(state.providers.custom[0].keySet, true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('legacy local OAI settings surface as a custom endpoint and preserve key on save', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();
  web.config.localModelBaseUrl = 'http://localhost:11434/v1';
  web.config.localModelApiKey = 'local-secret';
  web.config.localModelAuthHeader = 'x-key';

  const state = web._settingsService.getSettingsResponse({ role: 'creator' });
  const local = state.providers.custom.find(p => p.name === 'local');
  assert.ok(local, 'legacy LOCAL_MODEL_* should render as custom endpoint "local"');
  assert.equal(local.url, 'http://localhost:11434/v1');
  assert.equal(local.key, '');
  assert.equal(local.keySet, true);
  assert.equal(local.authHeader, 'x-key');

  web._settingsService.applyCanonicalPatch({
    'providers.custom': [
      { name: 'local', url: 'http://new-local.example/v1', key: '__KEEP__', authHeader: 'bearer' },
    ],
  });

  assert.deepEqual(settings.get('providers.custom'), [
    { name: 'local', url: 'http://new-local.example/v1', key: 'local-secret', authHeader: 'bearer' },
  ]);
  assert.deepEqual(web.config.customProviders.local, {
    url: 'http://new-local.example/v1',
    key: 'local-secret',
    authHeader: 'bearer',
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
