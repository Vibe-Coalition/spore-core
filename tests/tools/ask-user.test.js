const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolSystem } = require('../../src/tools');
const { WebGateway } = require('../../src/gateways/web');

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-ask-user-'));
  return {
    dataDir: dir,
    workspacePath: dir,
    sharedSkillsDir: path.join(dir, 'skills'),
  };
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test('ask_user fails fast when no session broadcaster exists', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);

  const result = await tools.executeTool('ask_user', {
    question: 'Pick one?',
    options: [{ label: 'A' }, { label: 'B' }],
  }, {
    sessionKey: 'channel:test',
    channelId: 'test',
    platform: 'web',
  });

  assert.match(result.error, /could not be delivered/);
  assert.deepEqual(tools.listPendingQuestions('channel:test'), []);
});

test('ask_user clears pending state when broadcast reaches no clients', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  tools._wsBroadcast = () => 0;

  const result = await tools.executeTool('ask_user', {
    question: 'Pick one?',
    options: [{ label: 'A' }, { label: 'B' }],
  }, {
    sessionKey: 'channel:test',
    channelId: 'test',
    platform: 'web',
  });

  assert.match(result.error, /no connected/);
  assert.deepEqual(tools.listPendingQuestions('channel:test'), []);
});

test('ask_user can be answered by option number for a pending session', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const payloads = [];
  tools._wsBroadcast = (sessionKey, payload) => {
    payloads.push({ sessionKey, payload });
    return 1;
  };

  const pending = tools.executeTool('ask_user', {
    question: 'Which route?',
    options: [{ label: 'LAN: 192.168.1.10' }, { label: 'Tunnel' }],
  }, {
    sessionKey: 'channel:cli:abc',
    channelId: 'cli:abc',
    platform: 'cli',
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payloads.length, 1);
  assert.equal(tools.listPendingQuestions('channel:cli:abc').length, 1);

  const routed = tools.answerAskUserForSession('channel:cli:abc', '1');
  assert.equal(routed.ok, true);
  assert.equal(routed.answer, 'LAN: 192.168.1.10');
  assert.deepEqual(await pending, { answer: 'LAN: 192.168.1.10' });
  assert.deepEqual(tools.listPendingQuestions('channel:cli:abc'), []);
});

test('WebGateway broadcasts channel:cli session keys to cli-prefixed session clients', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const gateway = new WebGateway(tools);
  const sent = [];
  const ws = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
  };
  gateway._sessionClients.set('cli:abc', new Set([{ ws, role: 'origin' }]));

  const count = gateway._broadcastToSessionKey('channel:cli:abc', { type: 'ask_user', qid: 'q1' });

  assert.equal(count, 1);
  assert.deepEqual(sent, [{ type: 'ask_user', qid: 'q1' }]);
});

test('web_serve gateway creation wires ask_user broadcaster', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const result = tools._webServeTool({ action: 'status' });

  assert.equal(result.running, false);
  assert.equal(typeof tools._wsBroadcast, 'function');
});

test('subagent events for cli route only to originating session', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const calls = [];
  let globalBroadcasts = 0;
  tools._wsBroadcast = (sessionKey, payload) => {
    calls.push({ sessionKey, payload });
    return sessionKey === 'channel:cli:yam@project' ? 1 : 0;
  };
  tools.broadcast = () => { globalBroadcasts++; };

  const delivered = tools._broadcastTaskEvent({
    taskId: 'task_test',
    sessionKey: 'channel:cli:yam@project',
    channelId: 'cli:yam@project',
    platform: 'cli',
    userId: 'yam',
  }, { type: 'subagent:start', taskId: 'task_test' });

  assert.equal(delivered, 1);
  assert.equal(globalBroadcasts, 0);
  assert.deepEqual(calls[0], {
    sessionKey: 'channel:cli:yam@project',
    payload: { type: 'subagent:start', taskId: 'task_test', sessionId: 'cli:yam@project' },
  });
});

test('subagent events for cli do not fall back to web dm routes', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const calls = [];
  let globalBroadcasts = 0;
  tools._wsBroadcast = (sessionKey) => {
    calls.push(sessionKey);
    return 0;
  };
  tools.broadcast = () => { globalBroadcasts++; };

  const delivered = tools._broadcastTaskEvent({
    taskId: 'task_test',
    sessionKey: 'channel:cli:yam@project',
    channelId: 'cli:yam@project',
    platform: 'cli',
    userId: 'yam',
  }, { type: 'subagent:done', taskId: 'task_test' });

  assert.equal(delivered, 0);
  assert.equal(globalBroadcasts, 0);
  assert.equal(calls.includes('dm:yam'), false);
  assert.equal(calls.includes('shared:dm:cli:yam'), false);
});

test('subagent delivery for cli preserves project session key', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const taskEntry = {
    sessionKey: 'channel:cli:yam@project',
    channelId: 'cli:yam@project',
    platform: 'cli',
  };

  assert.equal(tools._deliverySessionKey(taskEntry, true, 'yam'), 'channel:cli:yam@project');
});
