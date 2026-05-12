'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

const { SlackGateway } = require('../../plugins/slack/lib/gateway');
const { DiscordGateway } = require('../../plugins/discord/lib/gateway');
const { TelegramGateway } = require('../../plugins/telegram/lib/gateway');
const sporeCode = require('../../plugins/spore-code');
const { AgentLoop } = require('../../src/agent/loop');

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FakeSessions {
  constructor() {
    this.messages = [];
    this.cleared = [];
  }

  static buildKey(channelIdOrOpts, isDm = false, userId = null) {
    if (channelIdOrOpts && typeof channelIdOrOpts === 'object') {
      const {
        platform = 'web',
        channelId = null,
        isDm: objectIsDm = false,
        userId: objectUserId = null,
        private: isPrivate = false,
      } = channelIdOrOpts;
      const scope = isPrivate ? 'private' : 'shared';
      if (objectIsDm && objectUserId) return `${scope}:dm:${platform}:${objectUserId}`;
      return `${scope}:channel:${platform}:${channelId}`;
    }
    if (isDm && userId) return `dm:${userId}`;
    return `channel:${channelIdOrOpts}`;
  }

  addMessage(sessionKey, role, content) {
    this.messages.push({ sessionKey, role, content });
  }

  clearSession(sessionKey) {
    this.cleared.push(sessionKey);
  }
}

function makeChannelAgent(responseText) {
  const turns = [];
  const sessions = new FakeSessions();
  return {
    turns,
    agent: {
      sessions,
      _jobQueue: {
        async submitAgentTurn(opts, meta) {
          turns.push({ opts, meta });
          return {
            text: responseText,
            usage: { input_tokens: 10, output_tokens: 3 },
            iterations: 1,
          };
        },
      },
      async processMessage() {
        throw new Error('expected channel smoke to use runtime queue submitAgentTurn');
      },
    },
  };
}

function tempConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-smoke-'));
  return {
    dataDir,
    maxQueuePerChannel: 8,
    messageDebounceMs: 60_000,
    intermediateTextThrottleSeconds: 1,
    maxMessageLength: 2000,
    typingInterval: 60_000,
    channels: {
      slack: { sessionMode: 'thread' },
      discord: { sessionMode: 'user' },
      telegram: { enabled: true, dmPolicy: 'open', groupPolicy: 'open', requireMention: false, textChunkLimit: 4000 },
    },
    ...overrides,
  };
}

function cleanupConfig(config) {
  if (config?.dataDir) fs.rmSync(config.dataDir, { recursive: true, force: true });
}

async function drainGatewayQueue(gateway, channelId) {
  const ch = gateway._getChannel(channelId);
  if (ch.debounceTimer) {
    clearTimeout(ch.debounceTimer);
    ch.debounceTimer = null;
  }
  await gateway._processQueue(channelId);
}

test('simulated Slack DM roundtrip reaches the agent and replies in the same route', async () => {
  const config = tempConfig();
  const { agent, turns } = makeChannelAgent('slack response');
  const gateway = new SlackGateway(config, log, agent);
  const posted = [];
  const client = {
    users: { info: async () => ({ user: { profile: { display_name: 'Alice' }, name: 'alice' } }) },
    conversations: { info: async () => ({ channel: { name: 'dm:Alice' } }) },
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: `sent-${posted.length}` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
  };

  try {
    await gateway._onMessage({
      client_msg_id: 'slack-smoke-1',
      channel: 'D123',
      channel_type: 'im',
      user: 'U123',
      text: 'hello from slack',
      ts: '171.0001',
    }, async text => posted.push({ say: text }), client);
    await drainGatewayQueue(gateway, 'D123');

    assert.equal(turns.length, 1);
    assert.equal(turns[0].opts.platform, 'slack');
    assert.equal(turns[0].opts.sessionKey, 'shared:dm:slack:U123');
    assert.equal(turns[0].opts.suppressLearning, false);
    assert.equal(turns[0].meta.lane, 'channel');
    assert.equal(turns[0].meta.route, 'slack.message');
    assert.equal(posted.at(-1).channel, 'D123');
    assert.equal(posted.at(-1).text, 'slack response');
  } finally {
    cleanupConfig(config);
  }
});

test('simulated Discord DM roundtrip reaches the agent and replies in the same route', async () => {
  const config = tempConfig();
  const { agent, turns } = makeChannelAgent('discord response');
  const gateway = new DiscordGateway(config, log, agent);
  gateway.client = { user: { id: 'BOT', username: 'sporebot' } };
  gateway.minMessageInterval = 0;
  const replies = [];
  const channel = {
    id: 'D456',
    name: 'dm',
    isThread: () => false,
    sendTyping: async () => {},
    send: async (text) => {
      replies.push({ method: 'send', text });
      return { id: `sent-${replies.length}` };
    },
  };
  const message = {
    id: 'discord-smoke-1',
    content: 'hello from discord',
    attachments: new Map(),
    channelId: 'D456',
    channel,
    guild: null,
    author: { id: 'U456', bot: false, username: 'alice', displayName: 'Alice' },
    member: null,
    mentions: { has: () => false },
    reply: async (text) => {
      replies.push({ method: 'reply', text });
      return { id: `reply-${replies.length}` };
    },
    react: async () => {},
    reactions: { cache: new Map() },
  };

  try {
    await gateway._onMessage(message);
    await drainGatewayQueue(gateway, 'D456');

    assert.equal(turns.length, 1);
    assert.equal(turns[0].opts.platform, 'discord');
    assert.equal(turns[0].opts.sessionKey, 'shared:dm:discord:U456');
    assert.equal(turns[0].opts.suppressLearning, false);
    assert.equal(turns[0].meta.lane, 'channel');
    assert.equal(turns[0].meta.route, 'discord.message');
    assert.deepEqual(replies.at(-1), { method: 'reply', text: 'discord response' });
  } finally {
    cleanupConfig(config);
  }
});

test('simulated Telegram DM roundtrip reaches the agent and replies to the originating chat', async () => {
  const config = tempConfig();
  const { agent, turns } = makeChannelAgent('telegram response');
  const gateway = new TelegramGateway(config, log, agent);
  const sent = [];
  gateway._api = async () => ({ ok: true });
  gateway.sendMessage = async (target, content, filePath, opts) => {
    sent.push({ target, content, filePath, opts });
    return { sent: 1 };
  };

  try {
    await gateway._handleMessage({
      message_id: 7,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 789, type: 'private' },
      from: { id: 789, first_name: 'Tara', username: 'tara' },
      text: 'hello from telegram',
    });

    assert.equal(turns.length, 1);
    assert.equal(turns[0].opts.platform, 'telegram');
    assert.equal(turns[0].opts.sessionKey, 'shared:dm:telegram:789');
    assert.equal(turns[0].opts.suppressLearning, false);
    assert.equal(turns[0].meta.lane, 'channel');
    assert.equal(turns[0].meta.route, 'telegram.message');
    assert.equal(sent.at(-1).target, '789');
    assert.equal(sent.at(-1).content, 'telegram response');
    assert.equal(sent.at(-1).opts.replyToMessageId, 7);
  } finally {
    cleanupConfig(config);
  }
});

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function writeUser(dataDir, username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'webapp-users.json'), JSON.stringify([{
    username,
    salt,
    hash: hashPassword(password, salt),
    role: 'webapp',
    created: Date.now(),
  }]));
}

function makeReq(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body || {})]);
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk);
    },
  };
}

function makeSporeCodeApi(dataDir) {
  const webSessions = new Map();
  return {
    webSessions,
    api: {
      _appContext: {
        config: { dataDir },
        tools: { gateway: { _webSessions: webSessions } },
      },
      getHostConfig: () => ({ dataDir, inviteKey: '' }),
      getConfig: () => ({}),
      getLogger: () => log,
    },
  };
}

test('simulated Spore Code device session authenticates as CLI and schedules CLI learner work', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-smoke-'));
  try {
    writeUser(dataDir, 'cli-user', 'secret-password');
    const { api, webSessions } = makeSporeCodeApi(dataDir);
    const authRes = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      authMethod: 'password',
      password: 'secret-password',
      issueDevice: true,
    }), authRes);

    assert.equal(authRes.statusCode, 200);
    const authPayload = JSON.parse(authRes.body);
    assert.match(authPayload.deviceToken, /^spc_/);

    const sessionRes = makeRes();
    await sporeCode._test.handleDeviceSession(api, makeReq({}, {
      authorization: `Bearer ${authPayload.deviceToken}`,
    }), sessionRes);

    assert.equal(sessionRes.statusCode, 200);
    const sessionPayload = JSON.parse(sessionRes.body);
    const wsSession = webSessions.get(sessionPayload.token);
    assert.equal(wsSession.type, 'cli');
    assert.equal(wsSession.user, 'cli-user');
    assert.equal(wsSession.deviceId, authPayload.deviceId);

    const jobs = [];
    const loop = Object.create(AgentLoop.prototype);
    loop.config = {
      learningMode: 'always',
      learnerActivationMode: 'every_turn',
      learnerMinExchangeChars: 1,
      learnerEnabledPlatforms: ['cli'],
    };
    loop.log = log;
    loop.learner = { extractAndLearn: async () => ({ ok: true }) };
    loop.tools = {
      _jobQueue: {
        submitWorkerJob(kind, payload, meta) {
          jobs.push({ kind, payload, meta });
        },
      },
    };

    loop._kickOffLearnerExtraction({
      content: 'cli user asked for project work',
      platform: 'cli',
      sessionKey: 'channel:cli:cli-user@repo',
      channelId: 'cli:cli-user@repo',
      userId: 'cli-user',
      userName: 'cli-user',
      projectContext: { cwd: '/tmp/repo', project: 'repo' },
      memoryEnvelope: { primarySlug: 'project-repo' },
    }, 'cli agent completed useful project work', []);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.opts.platform, 'cli');
    assert.equal(jobs[0].payload.opts.sessionId, 'cli:cli-user@repo');
    assert.equal(jobs[0].meta.sessionKey, 'channel:cli:cli-user@repo');
    assert.equal(jobs[0].meta.graph, 'project-repo');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

class FakeElement {
  constructor(doc, tagName = 'div') {
    this.doc = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.hidden = false;
  }

  set id(value) {
    this._id = value;
    if (value) this.doc._byId.set(value, this);
  }

  get id() {
    return this._id || '';
  }

  set value(value) {
    this._value = value == null ? '' : String(value);
  }

  get value() {
    return this._value || '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  set innerHTML(html) {
    this._innerHTML = String(html || '');
    const tagIdRe = /<([a-zA-Z0-9-]+)([^>]*)\sid="([^"]+)"([^>]*)>/g;
    let match;
    while ((match = tagIdRe.exec(this._innerHTML))) {
      const [, tag, before, id, after] = match;
      const attrs = `${before} ${after}`;
      const el = new FakeElement(this.doc, tag);
      el.parentElement = this;
      el.id = id;
      const typeMatch = attrs.match(/\stype="([^"]+)"/);
      if (typeMatch) el.type = typeMatch[1];
      if (el.type === 'checkbox') el.checked = false;
      this.children.push(el);
    }
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  insertAdjacentElement(position, el) {
    el.parentElement = this.parentElement || this;
    this.children.push(el);
  }

  closest(selector) {
    if (selector === '.settings-section') {
      let cur = this;
      while (cur) {
        if (String(cur.className || '').split(/\s+/).includes('settings-section')) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  querySelector(selector) {
    if (selector.startsWith('#')) return this.doc.getElementById(selector.slice(1));
    return null;
  }

  querySelectorAll() {
    return [];
  }

  addEventListener() {}
}

class FakeDocument {
  constructor() {
    this._byId = new Map();
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  getElementById(id) {
    return this._byId.get(id) || null;
  }

  querySelectorAll() {
    return [];
  }

  addEventListener() {}
}

test('simulated settings UI toggles learner controls and builds the expected patch', () => {
  const doc = new FakeDocument();
  const memorySection = doc.createElement('div');
  memorySection.className = 'settings-section';
  const enhancedRecall = doc.createElement('input');
  enhancedRecall.id = 'settings-enhanced-recall';
  enhancedRecall.type = 'checkbox';
  enhancedRecall.parentElement = memorySection;
  memorySection.children.push(enhancedRecall);

  const context = {
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/static/scripts/settings.js'), 'utf8'), context);

  context._populateGraphRuntimeSettings({
    values: {
      learningMode: 'always',
      learnerActivationMode: 'idle_batch',
      learnerIdleDelaySeconds: 12,
      learnerBatchMinTurns: 2,
      learnerBatchMaxTurns: 4,
      learnerMinExchangeChars: 33,
      learnerEnabledPlatforms: ['web', 'cli', 'telegram'],
    },
  });

  assert.ok(doc.getElementById('settings-learner-activation-controls'));
  assert.equal(doc.getElementById('settings-learner-activation-mode').value, 'idle_batch');
  assert.equal(doc.getElementById('settings-learner-idle-delay').value, '12');
  assert.equal(doc.getElementById('settings-learner-platform-web').checked, true);
  assert.equal(doc.getElementById('settings-learner-platform-slack').checked, false);
  assert.equal(doc.getElementById('settings-learner-idle-delay').disabled, false);

  doc.getElementById('settings-learner-activation-mode').value = 'flush_only';
  context._settingsApplyLearnerModeAvailability();
  assert.equal(doc.getElementById('settings-learner-idle-delay').disabled, true);
  assert.equal(doc.getElementById('settings-learner-platform-web').disabled, true);

  const { patch } = context._buildSettingsPatchPayload({}, {});
  assert.equal(patch.learningMode, 'flush_only');
  assert.equal(patch.learnerActivationMode, 'every_turn');
  assert.equal(patch.learnerIdleDelaySeconds, 12);
  assert.equal(patch.learnerBatchMinTurns, 2);
  assert.equal(patch.learnerBatchMaxTurns, 4);
  assert.equal(patch.learnerMinExchangeChars, 33);
  assert.deepEqual(Array.from(patch.learnerEnabledPlatforms), ['web', 'cli', 'telegram']);
});
