'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
