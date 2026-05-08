'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PluginManager } = require('../../src/plugins/manager');

function managerWithTool(tool) {
  const mgr = new PluginManager({ log: { debug() {}, info() {}, warn() {}, error() {} } });
  mgr.plugins.set('fake', {
    instance: {
      getRegisteredTools() {
        return tool ? [tool] : [];
      },
    },
  });
  return mgr;
}

test('missing plugin tools return null', async () => {
  const mgr = managerWithTool(null);
  assert.equal(await mgr.executePluginTool('missing', {}, { platform: 'cli' }), null);
});

test('unavailable plugin tools return stable context error', async () => {
  const mgr = managerWithTool({
    name: 'web_only',
    definition: { platforms: ['web'], execute: async () => ({ ok: true }) },
  });
  const result = await mgr.executePluginTool('web_only', {}, { platform: 'cli' });
  assert.deepEqual(result, { error: 'Tool web_only is not available in this cli context.' });
});

test('available plugin tools receive input and ctx', async () => {
  const seen = {};
  const mgr = managerWithTool({
    name: 'do_it',
    definition: {
      execute: async (input, ctx) => {
        seen.input = input;
        seen.ctx = ctx;
        return { ok: true };
      },
    },
  });
  const ctx = { platform: 'cli', sessionId: 's1' };
  assert.deepEqual(await mgr.executePluginTool('do_it', { value: 1 }, ctx), { ok: true });
  assert.deepEqual(seen, { input: { value: 1 }, ctx });
});

test('plugin tool thrown errors normalize predictably', async () => {
  const mgr = managerWithTool({
    name: 'boom',
    definition: { execute: async () => { throw new Error('bad plugin'); } },
  });
  const result = await mgr.executePluginTool('boom', {}, { platform: 'cli' });
  assert.deepEqual(result, { error: 'Plugin tool boom failed: bad plugin' });
});
