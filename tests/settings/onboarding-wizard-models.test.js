/**
 * Onboarding wizard model aggregation.
 *
 * Run: node --test tests/settings/onboarding-wizard-models.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWizardHarness() {
  const file = path.join(__dirname, '../../src/static/scripts/onboarding.js');
  const code = fs.readFileSync(file, 'utf8') + `
    globalThis.__obTest = {
      setState({ providers = [], entries = [], known = {}, tierValues = {} } = {}) {
        OB_PROVIDERS = providers;
        _obProviderEntries.length = 0;
        _obProviderEntries.push(...entries);
        for (const key of Object.keys(_obKnownModelLimits)) delete _obKnownModelLimits[key];
        Object.assign(_obKnownModelLimits, known);
        for (const key of Object.keys(_obTierValues)) delete _obTierValues[key];
        Object.assign(_obTierValues, tierValues);
      },
      allConfiguredModels: () => JSON.parse(JSON.stringify(_obAllConfiguredModels())),
      wizardEntries: () => JSON.parse(JSON.stringify(_obWizardEntries())),
      autoFillEmptyTiers: (tier) => _obAutoFillEmptyTiers(tier),
      tierValues: () => JSON.parse(JSON.stringify(_obTierValues)),
      renderChannelCard: (plugin) => _obRenderChannelCard(plugin),
      setChannels({ plugins = [], saved = {}, checked = {} } = {}) {
        _obPluginsCache = plugins;
        _obData.plugins = JSON.parse(JSON.stringify(saved));
        document.getElementById = (id) => {
          const prefix = 'ob-channel-on-';
          if (!String(id || '').startsWith(prefix)) return null;
          return { checked: !!checked[String(id).slice(prefix.length)] };
        };
      },
      snapshotChannels() {
        _obSnapshotChannelsStep();
        return JSON.parse(JSON.stringify(_obData.plugins || {}));
      },
    };
  `;
  const ctx = {
    console,
    API: '',
    THEMES: {},
    applyGraphTheme() {},
    authHeaders() { return {}; },
    showApp() {},
    _settingsEscapeHtml(value) { return String(value ?? ''); },
    localStorage: { getItem() {}, setItem() {}, removeItem() {} },
    sessionStorage: { setItem() {} },
    window: { location: { reload() {} }, matchMedia: () => ({ matches: false }) },
    document: { querySelectorAll: () => [], getElementById: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: file });
  return ctx.__obTest;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('wizard routing model list aggregates every configured provider entry', () => {
  const h = loadWizardHarness();
  h.setState({
    // Deliberately incomplete provider registry: _obProviderEntries is
    // the wizard source of truth after the provider-picker step.
    providers: [{ id: 'openai', fields: [{ key: 'apiKey' }] }],
    entries: [
      { kind: 'builtin', id: 'openai', apiKey: 'sk-openai', models: 'gpt-5, gpt-4o' },
      { kind: 'builtin', id: 'gemini', apiKey: 'gemini-key', models: 'gemini-2.5-pro' },
      { kind: 'builtin', id: 'anthropic', apiKey: 'anthropic-key', models: 'claude-opus-4-7' },
      { kind: 'custom', name: 'llama', url: 'http://llama.local/v1', apiKey: '', models: 'llama-3.3' },
    ],
  });

  assert.deepEqual(plain(h.allConfiguredModels()), {
    openai: ['gpt-5', 'gpt-4o'],
    gemini: ['gemini-2.5-pro'],
    anthropic: ['claude-opus-4-7'],
    llama: ['llama-3.3'],
  });

  const refs = plain(h.wizardEntries()).map(e => `${e.provider}/${e.modelId}`);
  assert.deepEqual(refs, [
    'openai/gpt-5',
    'openai/gpt-4o',
    'gemini/gemini-2.5-pro',
    'anthropic/claude-opus-4-7',
    'llama/llama-3.3',
  ]);
});

test('wizard routing model list merges probed metadata with pasted models without dropping providers', () => {
  const h = loadWizardHarness();
  h.setState({
    providers: [
      { id: 'openai', fields: [{ key: 'apiKey' }] },
      { id: 'gemini', fields: [{ key: 'apiKey' }] },
    ],
    entries: [
      { kind: 'builtin', id: 'openai', apiKey: 'sk-openai', models: 'gpt-5, gpt-4o' },
      { kind: 'builtin', id: 'gemini', apiKey: 'gemini-key', models: 'gemini-2.5-pro, gemini-2.5-flash' },
    ],
    known: {
      'openai/gpt-5': { contextLength: 400000, capabilities: { tools: true } },
      'gemini/gemini-2.5-pro': { contextLength: 1000000, capabilities: { vision: true } },
      'zai/glm-4.6': { contextLength: 128000 },
    },
  });

  const entries = plain(h.wizardEntries());
  assert.deepEqual(entries.map(e => `${e.provider}/${e.modelId}`), [
    'openai/gpt-5',
    'gemini/gemini-2.5-pro',
    'openai/gpt-4o',
    'gemini/gemini-2.5-flash',
  ]);
  assert.equal(entries.find(e => e.provider === 'openai' && e.modelId === 'gpt-5').contextWindow, 400000);
  assert.equal(entries.find(e => e.provider === 'gemini' && e.modelId === 'gemini-2.5-pro').contextWindow, 1000000);
});

test('wizard only auto-fills empty tiers when exactly one model is configured', () => {
  const h = loadWizardHarness();
  h.setState({
    entries: [
      { kind: 'builtin', id: 'openai', apiKey: 'sk-openai', models: 'gpt-5' },
      { kind: 'builtin', id: 'gemini', apiKey: 'gemini-key', models: 'gemini-2.5-pro' },
    ],
    tierValues: { planner: { provider: 'openai', modelId: 'gpt-5' } },
  });
  h.autoFillEmptyTiers('planner');
  assert.equal(h.tierValues().normal, undefined);

  h.setState({
    entries: [
      { kind: 'builtin', id: 'openai', apiKey: 'sk-openai', models: 'gpt-5' },
    ],
    tierValues: { planner: { provider: 'openai', modelId: 'gpt-5' } },
  });
  h.autoFillEmptyTiers('planner');
  assert.deepEqual(plain(h.tierValues().normal), { provider: 'openai', modelId: 'gpt-5' });
});

test('wizard channels step only records install toggles, not channel settings', () => {
  const h = loadWizardHarness();
  const slack = {
    id: 'slack',
    name: 'Slack',
    channel: true,
    pane: {
      description: 'Connect Slack through Socket Mode.',
      schema: [
        { key: 'enabled', label: 'Enable Slack channel', type: 'toggle', default: false },
        { key: 'botToken', label: 'Bot token', type: 'password', secret: true },
        { key: 'sessionMode', label: 'Session mode', type: 'select', default: 'thread', options: ['channel', 'thread'] },
      ],
      values: { botToken: 'xoxb-secret', sessionMode: 'thread' },
    },
  };

  const html = h.renderChannelCard(slack);
  assert.match(html, /ob-channel-on-slack/);
  assert.match(html, /Settings -&gt; Channels/);
  assert.doesNotMatch(html, /data-channel-key/);
  assert.doesNotMatch(html, /Bot token|Session mode|xoxb-secret/);

  h.setChannels({
    plugins: [slack, { id: 'telegram', name: 'Telegram', channel: true }],
    checked: { slack: true, telegram: false },
  });

  assert.deepEqual(plain(h.snapshotChannels()), {
    slack: { enabled: true, config: {} },
    telegram: { enabled: false, config: {} },
  });
});
