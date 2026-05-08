'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerBrowserCore = require('../../plugins/browser-core');
const BrowserTool = require('../../plugins/browser-core/lib/tool');

function makeTool() {
  const calls = [];
  const backend = {
    running: false,
    isRunning() { return this.running; },
    async execute(input) {
      calls.push(input);
      if (input.action === 'launch') {
        this.running = true;
        return { status: 'launched' };
      }
      if (input.action === 'navigate') return { status: 'navigated', url: input.url };
      return { status: input.action };
    },
  };
  const tool = new BrowserTool({
    log: { info() {}, warn() {}, error() {}, debug() {} },
    broadcast() {},
    config: { browserBackend: 'zendriver' },
    pluginManager: {
      getBrowserBackends() {
        return [{
          name: 'zendriver',
          aliases: ['zd'],
          available: true,
          factory: () => backend,
        }];
      },
    },
  });
  return { tool, calls };
}

test('browser tool auto-launches before first navigation', async () => {
  const { tool, calls } = makeTool();

  const result = await tool.execute({ action: 'navigate', url: 'https://www.ynet.co.il' });

  assert.deepEqual(calls.map(c => c.action), ['launch', 'navigate']);
  assert.equal(result.backend, 'zendriver');
  assert.equal(result.status, 'navigated');
});

test('browser tool normalizes open action to navigate', async () => {
  const { tool, calls } = makeTool();

  const result = await tool.execute({ action: 'open', url: 'https://www.ynet.co.il' });

  assert.deepEqual(calls.map(c => c.action), ['launch', 'navigate']);
  assert.equal(result.status, 'navigated');
});

function registerCoreForTest() {
  const scopedEvents = [];
  const scopedBinaries = [];
  const globalEvents = [];
  let factoryCalls = 0;
  let registered = null;
  let shutdown = null;
  const tools = {
    _broadcastSessionEvent(route, payload, opts) {
      scopedEvents.push({ route, payload, opts });
      return 1;
    },
    _broadcastSessionBinary(route, buffer, opts) {
      scopedBinaries.push({ route, buffer, opts });
      return 1;
    },
    broadcast(data) {
      globalEvents.push({ data, binary: false });
    },
    broadcastBinary(data) {
      globalEvents.push({ data, binary: true });
    },
    _pluginManager: {
      getBrowserBackends() {
        return [{
          name: 'zendriver',
          aliases: [],
          available: true,
          factory: ({ broadcast }) => {
            factoryCalls += 1;
            return {
              running: false,
              isRunning() { return this.running; },
              async execute(input) {
                if (input.action === 'launch') {
                  this.running = true;
                  broadcast({ type: 'browser:open' }, false);
                  broadcast(Buffer.from('frame'), true);
                  return { status: 'launched' };
                }
                return { status: input.action };
              },
              async destroy() {},
            };
          },
        }];
      },
    },
  };
  registerBrowserCore({
    _appContext: { config: { browserBackend: 'zendriver' }, tools },
    getLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    registerReferenceNodes() {},
    registerTool(name, definition) {
      registered = { name, definition };
    },
    onShutdown(fn) {
      shutdown = fn;
    },
  });
  return {
    registered,
    shutdown,
    scopedEvents,
    scopedBinaries,
    globalEvents,
    factoryCalls: () => factoryCalls,
  };
}

test('browser-core hides the browser tool from CLI contexts', () => {
  const { registered } = registerCoreForTest();

  assert.equal(registered.name, 'browser');
  assert.equal(registered.definition.available({ platform: 'cli' }), false);
  assert.equal(registered.definition.available({ platform: 'web' }), true);
  assert.equal(registered.definition.available({ platform: 'telegram' }), true);
});

test('browser-core routes preview events to the invoking session scope only', async () => {
  const { registered, scopedEvents, scopedBinaries, globalEvents } = registerCoreForTest();
  const toolCtx = {
    platform: 'web',
    sessionKey: 'dm:test-user',
    channelId: 'web:control-panel',
    userId: 'test-user',
  };

  const result = await registered.definition.execute({ action: 'launch' }, toolCtx);

  assert.equal(result.status, 'launched');
  assert.equal(globalEvents.length, 0);
  assert.equal(scopedEvents.length, 1);
  assert.equal(scopedEvents[0].payload.type, 'browser:open');
  assert.equal(scopedEvents[0].payload.sessionKey, 'dm:test-user');
  assert.equal(scopedEvents[0].payload.channelId, 'web:control-panel');
  assert.equal(scopedEvents[0].route.userId, 'test-user');
  assert.equal(scopedEvents[0].opts.fallbackGlobal, false);
  assert.equal(scopedBinaries.length, 1);
  assert.deepEqual(scopedBinaries[0].buffer, Buffer.from('frame'));
  assert.equal(scopedBinaries[0].route.sessionKey, 'dm:test-user');
  assert.equal(scopedBinaries[0].opts.fallbackGlobal, false);
});

test('browser-core keeps browser backend instances separate per user and channel scope', async () => {
  const { registered, factoryCalls } = registerCoreForTest();

  await registered.definition.execute({ action: 'launch' }, {
    platform: 'web',
    sessionKey: 'dm:test-user',
    channelId: 'web:control-panel',
    userId: 'test-user',
  });
  await registered.definition.execute({ action: 'status' }, {
    platform: 'web',
    sessionKey: 'dm:test-user',
    channelId: 'web:control-panel',
    userId: 'test-user',
  });
  await registered.definition.execute({ action: 'launch' }, {
    platform: 'telegram',
    sessionKey: 'shared:channel:telegram:room-1',
    channelId: 'room-1',
    userId: 'pirateking',
  });

  assert.equal(factoryCalls(), 2);
});
