/**
 * Phase 2 end-to-end — exercises the full boot + persist + reactivity
 * cycle using the real WebGateway code path.
 *
 *   - Fresh dataDir → new settings.db
 *   - Wizard payload through _persistSettingsPatch → DB rows + this.config mirror
 *   - Tri-state PATCH (clear secret) → DB row deleted, env fallback applies
 *   - Voice subscriber fires on voice.* changes
 *   - Reactive subscribers fire on models.*, providers.* changes
 *
 * Run: node --test tests/settings/phase2-e2e.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function freshEnv() {
  // Drop module cache to get a clean settings store + config + web
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPORE_') || k === 'OPENAI_API_KEY' || k === 'ANTHROPIC_API_KEY' ||
        k === 'GRAPH_DB_PATH' || k === 'TELEGRAM_BOT_TOKEN' || k === 'DISCORD_TOKEN') {
      delete process.env[k];
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-phase2-'));
  process.env.SPORE_DATA_DIR = tmp;
  return tmp;
}

function makeWeb() {
  const settings = require('../../src/settings');
  settings.boot();
  // Build a minimal toolSystem stub mirroring what app.js wires up
  const log = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  };
  const toolSystem = {
    config: require('../../src/config').loadConfig(),
    log,
    graph: null,
    skills: null,
    _pluginManager: { getSTTProviders: () => [], getProviders: () => [], getSettingsPanes: () => [] },
    _agent: null,
    llmClient: { clearCache: () => {} },
  };
  const { WebGateway } = require('../../src/gateways/web');
  return { settings, web: new WebGateway(toolSystem), toolSystem };
}

test('fresh boot creates settings.db and seeds zero rows from no-spore.json', () => {
  const tmp = freshEnv();
  const { settings } = makeWeb();
  const dbPath = path.join(tmp, 'settings.db');
  assert.ok(fs.existsSync(dbPath), 'settings.db not created');
  const db = new DatabaseSync(dbPath);
  const count = db.prepare('SELECT COUNT(*) as c FROM settings').get().c;
  assert.equal(count, 0, 'fresh data dirs must not import bundled src/spore.json defaults');
  const libCount = db.prepare('SELECT COUNT(*) as c FROM model_library').get().c;
  assert.equal(libCount, 0, 'fresh data dirs must not seed default Anthropic models');
  const meta = db.prepare('SELECT v FROM settings_meta WHERE k=?').get('spore_json_migrated_at');
  assert.ok(meta, 'spore_json_migrated_at flag must be set after first boot');
  assert.equal(settings.get('pluginsHotReload'), true, 'plugin hot reload should default on');
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wizard payload via _persistSettingsPatch lands in DB and config mirror', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  const payload = {
    displayName: 'Phase 2 Bot',
    nicknames: ['p2', 'bot'],
    enhancedRecall: true,
    providers: {
      openai: { apiKey: 'sk-oai-real', baseUrl: 'https://api.openai.com/v1' },
      anthropic: { apiKey: 'sk-ant-real' },
    },
    models: {
      planner: { provider: 'anthropic', model: 'claude-opus-4-7' },
      casual: 'claude-haiku-4-5',
    },
    voice: { enabled: true, silenceThresholdMs: 600 },
  };
  const result = web._persistSettingsPatch(payload);
  assert.ok(result, 'should return settings state');

  // Settings store has the new values
  assert.equal(settings.get('displayName'), 'Phase 2 Bot');
  assert.deepEqual(settings.get('nicknames'), ['p2', 'bot']);
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-oai-real');
  assert.equal(settings.get('providers.openai.baseUrl'), 'https://api.openai.com/v1');
  assert.equal(settings.get('models.planner'), 'claude-opus-4-7');
  assert.equal(settings.get('models.casual'), 'claude-haiku-4-5');
  assert.equal(settings.get('voice.enabled'), true);
  assert.equal(settings.get('voice.silenceThresholdMs'), 600);

  // this.config legacy mirror updated
  assert.equal(web.config.displayName, 'Phase 2 Bot');
  assert.deepEqual(web.config.nicknames, ['p2', 'bot']);
  assert.equal(web.config.openaiApiKey, 'sk-oai-real');
  assert.equal(web.config.openaiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(web.config.plannerModel, 'claude-opus-4-7');
  assert.equal(web.config.voice.enabled, true);
  assert.equal(web.config.voice.silenceThresholdMs, 600);

  // settings.db actually has rows
  const db = new DatabaseSync(path.join(tmp, 'settings.db'));
  const apiKeyRow = db.prepare('SELECT value, type, updated_by FROM settings WHERE key=?').get('providers.openai.apiKey');
  assert.equal(apiKeyRow.value, 'sk-oai-real');
  assert.equal(apiKeyRow.type, 'secret');
  assert.equal(apiKeyRow.updated_by, 'web');
  const libIds = new Set(db.prepare('SELECT id FROM model_library').all().map(r => r.id));
  assert.ok(libIds.has('claude-opus-4-7'), 'saved model route should seed model_library');
  assert.ok(libIds.has('claude-haiku-4-5'), 'saved model route should seed model_library');
  db.close();

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('partial save does NOT wipe untouched fields (regression for the "wizard wiped baseUrl" bug)', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  // Initial save: both apiKey and baseUrl set
  web._persistSettingsPatch({
    providers: { openai: { apiKey: 'sk-1', baseUrl: 'https://example.com/v1' } },
  });
  // Now save again, ONLY apiKey present in body — baseUrl must survive
  web._persistSettingsPatch({
    providers: { openai: { apiKey: 'sk-2' } },
  });
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-2');
  assert.equal(settings.get('providers.openai.baseUrl'), 'https://example.com/v1', 'baseUrl was wiped — regression!');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('model library UI entries hide unconfigured or uninstalled providers', () => {
  const tmp = freshEnv();
  const { web } = makeWeb();
  web.config.customProviders = {
    local: { url: 'http://local.example/v1', key: '', authHeader: 'bearer' },
  };
  web.tools._pluginManager = {
    getProviders: () => [{
      name: 'custom',
      pluginId: 'local-oai-provider',
      prefixes: ['custom', 'local'],
      configured: true,
    }],
  };
  const visible = web._visibleModelLibraryEntries([
    { id: 'claude-opus-4-6', provider: 'anthropic', modelId: 'claude-opus-4-6' },
    { id: 'local/qwen', provider: 'local', modelId: 'qwen' },
  ]);
  assert.deepEqual(visible.map(e => e.id), ['local/qwen']);
  assert.equal(visible[0].providerStatus.available, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('VoicePipeline rebuilds when voice.* changes (no manual cache-bust)', () => {
  const tmp = freshEnv();
  const { settings } = makeWeb();
  // Don't load real VoicePipeline (would require STT plugins) — just
  // verify the subscribe wiring fires.
  let voiceFired = 0;
  let modelsFired = 0;
  settings.subscribe('voice.*', () => voiceFired++);
  settings.subscribe('models.*', () => modelsFired++);
  settings.applyPatch({ 'voice.enabled': true, 'voice.silenceThresholdMs': 500 });
  assert.equal(voiceFired, 1, 'voice.* subscriber must fire exactly once for a multi-key patch');
  assert.equal(modelsFired, 0);
  settings.applyPatch({ 'models.planner': 'opus' });
  assert.equal(voiceFired, 1);
  assert.equal(modelsFired, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('null in patch clears the DB row and value falls back to default', () => {
  const tmp = freshEnv();
  const { settings, web } = makeWeb();

  web._persistSettingsPatch({ voice: { silenceThresholdMs: 600 } });
  assert.equal(settings.get('voice.silenceThresholdMs'), 600);

  // Tri-state: explicit null clears
  settings.applyPatch({ 'voice.silenceThresholdMs': null });
  assert.equal(settings.get('voice.silenceThresholdMs'), 400, 'should fall back to default');
  assert.equal(settings.provenance('voice.silenceThresholdMs'), 'default');

  // Verify DB row really deleted
  const db = new DatabaseSync(path.join(tmp, 'settings.db'));
  const row = db.prepare('SELECT * FROM settings WHERE key=?').get('voice.silenceThresholdMs');
  assert.ok(!row, 'DB row should be DELETEd, not just nulled');
  db.close();

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('env-only override survives clear (operator can rotate via env without breaking UI)', () => {
  const tmp = freshEnv();
  process.env.OPENAI_API_KEY = 'sk-from-env';
  const { settings, web } = makeWeb();

  // The first boot's env-seed migration writes env value to DB. Clear
  // the row and confirm the runtime store falls back to env.
  settings.applyPatch({ 'providers.openai.apiKey': null });
  assert.equal(settings.get('providers.openai.apiKey'), 'sk-from-env');
  assert.equal(settings.provenance('providers.openai.apiKey'), 'env');
  assert.ok(settings.isEnvLocked('providers.openai.apiKey'));

  delete process.env.OPENAI_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('multi-key patch fires each glob subscriber exactly once', () => {
  const tmp = freshEnv();
  const { settings } = makeWeb();
  let voiceCalls = 0;
  let providerCalls = 0;
  settings.subscribe('voice.*', () => voiceCalls++);
  settings.subscribe('providers.**', () => providerCalls++);
  settings.applyPatch({
    'voice.enabled': true,
    'voice.silenceThresholdMs': 600,
    'voice.maxUtteranceSecs': 45,
    'providers.openai.apiKey': 'sk-a',
    'providers.openai.baseUrl': 'https://api.openai.com/v1',
  });
  assert.equal(voiceCalls, 1);
  assert.equal(providerCalls, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('second boot is a no-op (idempotent migrators)', () => {
  const tmp = freshEnv();
  const { settings: s1 } = makeWeb();
  const meta1 = s1._registry; void meta1;
  // Reboot in same dataDir — clear caches, settings should rehydrate from DB
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  const settings2 = require('../../src/settings');
  settings2.boot();
  // Migrations should not double-process: spore_json_migrated_at flag persists
  const db = new DatabaseSync(path.join(tmp, 'settings.db'));
  const ts = db.prepare('SELECT v FROM settings_meta WHERE k=?').get('spore_json_migrated_at');
  assert.ok(ts);
  // No spore.json file should be created on second boot
  assert.equal(fs.existsSync(path.join(tmp, 'spore.json')), false);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
