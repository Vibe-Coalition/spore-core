'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SlackGateway } = require('../../plugins/slack/lib/gateway');
const { DiscordGateway } = require('../../plugins/discord/lib/gateway');
const { TelegramGateway } = require('../../plugins/telegram/lib/gateway');
const { WebGateway } = require('../../src/gateways/web');

class FakeSessions {
  static buildKey(channelIdOrOpts, isDm = false, userId = null) {
    if (channelIdOrOpts && typeof channelIdOrOpts === 'object') {
      const {
        platform = 'discord',
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

  addMessage() {}
  clearSession() {}
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function fakeAgent() {
  return {
    sessions: new FakeSessions(),
    processMessage: async () => ({ text: 'ok' }),
  };
}

test('Web proactive prompt suppresses learner writes', async () => {
  let observedOpts = null;
  const gateway = new WebGateway({
    config: { dataDir: process.cwd(), workspacePath: process.cwd() },
    log: logger(),
    graph: null,
    skills: null,
    _agent: {},
    _jobQueue: {
      submitAgentTurn: async (opts) => {
        observedOpts = opts;
        return { text: 'NO_REPLY' };
      },
    },
  });
  gateway._wss = {
    clients: new Set([{ readyState: 1, _role: 'creator', _user: 'yam' }]),
  };
  gateway.hasOperatorConnected = () => true;
  gateway._getActiveWebUser = () => 'yam';
  gateway._sendToSession = () => {};

  gateway.injectProactivePrompt('web:control-panel', 'check in', 'topic');
  await gateway._proactiveQueue;

  assert.equal(observedOpts.trigger, 'proactive');
  assert.equal(observedOpts.platform, 'web');
  assert.equal(observedOpts.suppressLearning, true);
});

test('Slack task completion preserves original session and thread route', () => {
  const gateway = new SlackGateway({
    channels: { slack: { sessionMode: 'thread' } },
  }, logger(), fakeAgent());
  gateway._processQueue = () => {};
  gateway.app = { client: { chat: { postMessage: async () => ({}) } } };

  gateway.injectTaskComplete('C123', 'task-1', {
    status: 'done',
    startedAt: 1000,
    completedAt: 2000,
    result: { result: 'done' },
    sessionKey: 'shared:channel:slack:C123:thread:171.123',
    userId: 'U123',
    isDm: false,
    platformMeta: { threadTs: '171.123' },
  });

  const item = gateway._getChannel('C123').queue[0];
  assert.equal(item.sessionKey, 'shared:channel:slack:C123:thread:171.123');
  assert.equal(item.threadTs, '171.123');
  assert.equal(item.userId, 'U123');
});

test('Slack proactive prompt preserves active DM route', () => {
  const gateway = new SlackGateway({
    channels: { slack: { sessionMode: 'thread' } },
  }, logger(), fakeAgent());
  gateway._processQueue = () => {};
  gateway.app = { client: { chat: { postMessage: async () => ({}) } } };

  const ch = gateway._getChannel('D123');
  ch.name = 'dm:yam';
  ch.isDm = true;
  ch.userId = 'U123';

  gateway.injectProactivePrompt('D123', 'check in', 'topic');

  const item = ch.queue[0];
  assert.equal(item.sessionKey, 'shared:dm:slack:U123');
  assert.equal(item.isDm, true);
  assert.equal(item.userId, 'U123');
});

test('Discord task completion preserves original scoped session', () => {
  const gateway = new DiscordGateway({
    channels: { discord: { sessionMode: 'user' } },
  }, logger(), fakeAgent());
  gateway._processQueue = () => {};
  gateway.client = { channels: { fetch: async () => ({ send: async () => null, sendTyping: async () => null }) } };

  gateway.injectTaskComplete('C123', 'task-1', {
    status: 'done',
    startedAt: 1000,
    completedAt: 2000,
    result: { result: 'done' },
    sessionKey: 'shared:channel:discord:C123:user:U123',
    userId: 'U123',
    isDm: false,
    platformMeta: { isThread: true, parentChannelName: 'parent' },
  });

  const item = gateway._getChannel('C123').queue[0];
  assert.equal(item.sessionKey, 'shared:channel:discord:C123:user:U123');
  assert.equal(item.isThread, true);
  assert.equal(item.parentChannelName, 'parent');
});

test('Discord proactive prompt preserves active DM route', () => {
  const gateway = new DiscordGateway({
    channels: { discord: { sessionMode: 'channel' } },
  }, logger(), fakeAgent());
  gateway._processQueue = () => {};
  gateway.client = { channels: { fetch: async () => ({ send: async () => null, sendTyping: async () => null }) } };

  const ch = gateway._getChannel('D123');
  ch.name = 'dm';
  ch.isDm = true;
  ch.userId = 'U123';

  gateway.injectProactivePrompt('D123', 'check in', 'topic');

  const item = ch.queue[0];
  assert.equal(item.sessionKey, 'shared:dm:discord:U123');
  assert.equal(item.isDm, true);
  assert.equal(item.userId, 'U123');
});

test('Telegram session keys match text, voice, proactive, and topic policy', () => {
  const agent = fakeAgent();
  const byTopic = new TelegramGateway({
    channels: { telegram: { sessionMode: 'topic' } },
  }, logger(), agent);

  assert.equal(
    byTopic._sessionKey('-100', false, 'U123', '42', null),
    'shared:channel:telegram:-100:topic:42',
  );
  assert.equal(
    byTopic._sessionKey('123', true, '123', null, null),
    'shared:dm:telegram:123',
  );

  const byChat = new TelegramGateway({
    channels: { telegram: { sessionMode: 'chat' } },
  }, logger(), agent);

  assert.equal(
    byChat._sessionKey('-100', false, 'U123', '42', { private: true }),
    'private:channel:telegram:-100',
  );
});
