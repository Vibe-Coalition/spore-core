'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBuiltinToolHandlers } = require('../../src/tools/builtin-registry');

function makeToolsHarness() {
  const calls = [];
  const tools = {};

  const methodNames = [
    '_execTool',
    '_messageSendTool',
    '_messageReactTool',
    '_messageEditTool',
    '_messageReadTool',
    '_graphQueryTool',
    '_queryAboutTool',
    '_graphUpdateTool',
    '_graphDiffTool',
    '_graphDeleteTool',
    '_delegateTask',
    '_taskStatusTool',
    '_taskCancelTool',
    '_taskUpdateTool',
    '_webSearchTool',
    '_webFetchTool',
    '_readFileTool',
    '_writeFileTool',
    '_editFileTool',
    '_grepTool',
    '_globTool',
    '_sessionStatusTool',
    '_sessionsListTool',
    '_envManageTool',
    '_webServeTool',
    '_analyzeTool',
    '_analyzeMediaTool',
    '_saveToolTool',
    '_listCustomTools',
    '_notifyUserTool',
    '_scheduleWakeupTool',
    '_listWakeupsTool',
    '_cancelWakeupTool',
    '_tasklistCreateTool',
    '_tasklistProgressTool',
    '_tasklistListTool',
    '_tasklistGetTool',
    '_logWatchTool',
    '_logWatchListTool',
    '_logWatchStopTool',
    '_askUserTool',
    '_animaListTool',
    '_animaMessageTool',
    '_animaGraphTool',
    '_animaManageTool',
    '_remoteExecTool',
    '_remoteTailTool',
    '_remoteTmuxKillTool',
    '_remoteReadFileTool',
    '_remoteWriteFileTool',
    '_sshTunnelTool',
    '_startupTasksTool',
    '_dataPollerTool',
    '_webappRequestTool',
    '_skillLookupTool',
    '_skillUpdateTool',
  ];

  for (const name of methodNames) {
    tools[name] = (...args) => {
      calls.push({ name, args });
      return { name, args };
    };
  }

  return { calls, tools };
}

test('built-in registry dispatches named tools to ToolSystem methods', async () => {
  const { calls, tools } = makeToolsHarness();
  const handlers = buildBuiltinToolHandlers(tools);

  assert.equal(typeof handlers.exec, 'function');
  assert.equal(typeof handlers.graph_query, 'function');
  assert.equal(typeof handlers.skill_update, 'function');

  const execResult = await handlers.exec({ command: 'true' });
  const sessionResult = await handlers.session_status({ ignored: true });
  const imageResult = await handlers.analyze_image({ url: 'file.png' });

  assert.deepEqual(execResult, { name: '_execTool', args: [{ command: 'true' }] });
  assert.deepEqual(sessionResult, { name: '_sessionStatusTool', args: [] });
  assert.deepEqual(imageResult, { name: '_analyzeMediaTool', args: ['image', { url: 'file.png' }] });
  assert.deepEqual(calls.map(call => call.name), ['_execTool', '_sessionStatusTool', '_analyzeMediaTool']);
});

test('built-in sleep handler clamps duration and returns reason', async () => {
  const { tools } = makeToolsHarness();
  const handlers = buildBuiltinToolHandlers(tools);
  const started = Date.now();

  const result = await handlers.sleep({ seconds: -1, reason: 'unit test' });

  assert.equal(result.slept, 1);
  assert.equal(result.reason, 'unit test');
  assert.ok(Date.now() - started >= 900);
});
