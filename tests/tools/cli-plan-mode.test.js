'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ToolSystem } = require('../../src/tools/tools');

function makeTools() {
  return new ToolSystem(
    { workspacePath: process.cwd() },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
}

test('cli plan mode hides local execution and write tools from the catalog', () => {
  const tools = makeTools();
  const names = tools.getToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'plan' },
  }).map(t => t.name);

  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('glob'));
  assert.ok(!names.includes('exec'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('web_serve'));
  assert.ok(!names.includes('env_manage'));
});

test('cli plan mode blocks execution/write tools before dispatch', () => {
  const tools = makeTools();
  const ctx = { platform: 'cli', projectContext: { mode: 'plan' } };

  assert.equal(tools.planModeBlockForTool('read_file', { path: 'package.json' }, ctx), null);

  const execBlock = tools.planModeBlockForTool('exec', { command: 'npm start' }, ctx);
  assert.equal(execBlock.blocked, true);
  assert.equal(execBlock.planMode, true);
  assert.match(execBlock.error, /read-only/);

  const writeBlock = tools.planModeBlockForTool('write_file', { path: 'x', content: 'y' }, ctx);
  assert.equal(writeBlock.blocked, true);
});

test('cli execute mode does not block execution tools', () => {
  const tools = makeTools();
  const ctx = { platform: 'cli', projectContext: { mode: 'execute' } };

  assert.equal(tools.planModeBlockForTool('exec', { command: 'npm start' }, ctx), null);
  assert.equal(tools.planModeBlockForTool('write_file', { path: 'x', content: 'y' }, ctx), null);
});
