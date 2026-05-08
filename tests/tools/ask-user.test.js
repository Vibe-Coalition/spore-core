const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolSystem } = require('../../src/tools');
const { WebGateway } = require('../../src/gateways/web');
const { SessionManager } = require('../../src/agent/sessions');

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-ask-user-'));
  return {
    dataDir: dir,
    workspacePath: dir,
    sharedSkillsDir: path.join(dir, 'skills'),
    sessionDbPath: path.join(dir, 'sessions.db'),
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
  assert.deepEqual(await pending, { type: 'single', answer: 'LAN: 192.168.1.10' });
  assert.deepEqual(tools.listPendingQuestions('channel:cli:abc'), []);
});

test('ask_user supports multi-select answers', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const payloads = [];
  tools._wsBroadcast = (sessionKey, payload) => {
    payloads.push({ sessionKey, payload });
    return 1;
  };

  const pending = tools.executeTool('ask_user', {
    question: 'Which features?',
    type: 'multi',
    options: [{ label: 'Auth' }, { label: 'DB' }, { label: 'API' }],
  }, {
    sessionKey: 'channel:cli:abc',
    channelId: 'cli:abc',
    platform: 'cli',
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payloads[0].payload.mode, 'multi');
  assert.equal(payloads[0].payload.multi, true);
  const routed = tools.answerAskUserForSession('channel:cli:abc', '1, 3');
  assert.equal(routed.ok, true);
  assert.deepEqual(routed.answers, ['Auth', 'API']);
  assert.deepEqual(await pending, { type: 'multi', answer: 'Auth, API', answers: ['Auth', 'API'] });
});

test('ask_user supports open text answers', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const payloads = [];
  tools._wsBroadcast = (sessionKey, payload) => {
    payloads.push({ sessionKey, payload });
    return 1;
  };

  const pending = tools.executeTool('ask_user', {
    question: 'What should I repeat?',
    type: 'open',
  }, {
    sessionKey: 'channel:cli:abc',
    channelId: 'cli:abc',
    platform: 'cli',
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(payloads[0].payload.mode, 'open');
  assert.deepEqual(payloads[0].payload.options, []);
  const routed = tools.answerAskUserForSession('channel:cli:abc', 'free form text');
  assert.equal(routed.ok, true);
  assert.equal(routed.answer, 'free form text');
  assert.deepEqual(await pending, { type: 'open', answer: 'free form text' });
});

test('ask_user is only advertised for modal-capable foreground sessions', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const namesFor = opts => new Set(tools.getToolDefinitions(opts).map(t => t.name));

  assert.equal(namesFor({ platform: 'web', trigger: 'dm' }).has('ask_user'), true);
  assert.equal(namesFor({ platform: 'cli', trigger: 'dm' }).has('ask_user'), true);
  assert.equal(namesFor({ platform: 'system', trigger: 'worker' }).has('ask_user'), false);
  assert.equal(namesFor({ platform: 'cli', trigger: 'worker' }).has('ask_user'), false);
  assert.equal(namesFor({ platform: 'telegram', trigger: 'dm' }).has('ask_user'), false);
});

test('ask_user qid answers are bound to the originating session', async () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const payloads = [];
  tools._wsBroadcast = (sessionKey, payload) => {
    payloads.push({ sessionKey, payload });
    return 1;
  };

  const pending = tools.executeTool('ask_user', {
    question: 'Which route?',
    options: [{ label: 'A' }, { label: 'B' }],
  }, {
    sessionKey: 'channel:cli:abc',
    channelId: 'cli:abc',
    platform: 'cli',
  });
  await new Promise(resolve => setImmediate(resolve));

  const qid = payloads[0].payload.qid;
  assert.equal(tools.answerAskUser(qid, 'A', 'channel:cli:other'), false);
  assert.equal(tools.listPendingQuestions('channel:cli:abc').length, 1);
  assert.equal(tools.answerAskUser(qid, 'A', 'channel:cli:abc'), true);
  assert.deepEqual(await pending, { type: 'single', answer: 'A' });
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

test('WebGateway does not treat non-web shared dm/channel keys as web sessions', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const gateway = new WebGateway(tools);
  const sent = [];
  const webWs = {
    readyState: 1,
    _user: '123',
    send(data) { sent.push(JSON.parse(data)); },
  };
  const channelWs = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
  };
  gateway._wss = { clients: new Set([webWs]) };
  gateway._sessionClients.set('123', new Set([{ ws: channelWs, role: 'origin' }]));

  assert.equal(gateway._broadcastToSessionKey('shared:dm:telegram:123', { type: 'leak' }), 0);
  assert.equal(gateway._broadcastToSessionKey('shared:channel:telegram:123', { type: 'leak' }), 0);
  assert.deepEqual(sent, []);

  assert.equal(gateway._broadcastToSessionKey('shared:dm:web:123', { type: 'ok' }), 1);
  assert.deepEqual(sent, [{ type: 'ok' }]);
});

test('WebGateway scopes binary browser frames to web users and registered session clients', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const gateway = new WebGateway(tools);
  const sent = [];
  const webWs = {
    readyState: 1,
    _user: 'test-user',
    send(data) { sent.push(data); },
  };
  const otherWs = {
    readyState: 1,
    _user: 'other',
    send(data) { sent.push(data); },
  };
  const cliWs = {
    readyState: 1,
    _role: 'cli',
    _user: 'test-user',
    send(data) { sent.push(data); },
  };
  const frame = Buffer.from('browser-frame');
  gateway._wss = { clients: new Set([webWs, otherWs, cliWs]) };

  assert.equal(gateway._broadcastBinaryToSessionKey('shared:dm:telegram:test-user', frame), 0);
  assert.equal(gateway._broadcastBinaryToSessionKey('shared:dm:web:test-user', frame), 1);
  assert.deepEqual(sent, [frame]);

  const cliSent = [];
  const originWs = { readyState: 1, send(data) { cliSent.push(data); } };
  gateway._sessionClients.set('cli:project-a', new Set([{ ws: originWs, role: 'origin' }]));
  assert.equal(gateway._broadcastBinaryToSessionKey('channel:cli:project-a', frame), 1);
  assert.deepEqual(cliSent, [frame]);
});

test('WebGateway matches CLI graph events only to their registered session', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const gateway = new WebGateway(tools);
  const cliWs = { readyState: 1, _role: 'cli', _user: 'test-user', send() {} };
  gateway._sessionClients.set('cli:test-user@project-a', new Set([{ ws: cliWs, role: 'origin' }]));

  assert.equal(gateway._sessionKeyClientMatches(cliWs, 'channel:cli:test-user@project-a'), true);
  assert.equal(gateway._sessionKeyClientMatches(cliWs, null, 'cli:test-user@project-a'), true);
  assert.equal(gateway._sessionKeyClientMatches(cliWs, 'channel:cli:test-user@project-b'), false);
  assert.equal(gateway._sessionKeyClientMatches(cliWs, 'dm:test-user'), false);
  assert.equal(gateway._sessionKeyClientMatches(cliWs, null, null), false);
});

test('WebGateway only accepts ask_user qid answers from the owning session client', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const gateway = new WebGateway(tools);
  const cliA = { readyState: 1, _role: 'cli', _user: 'test-user', send() {} };
  const cliB = { readyState: 1, _role: 'cli', _user: 'test-user', send() {} };
  gateway._sessionClients.set('cli:project-a', new Set([{ ws: cliA, role: 'origin' }]));
  gateway._sessionClients.set('cli:project-b', new Set([{ ws: cliB, role: 'origin' }]));

  const pending = {
    qid: 'q1',
    sessionKey: 'channel:cli:project-a',
    channelId: 'cli:project-a',
  };

  assert.equal(gateway._askUserAnswerMatchesClient(cliA, { sessionId: 'cli:project-a' }, pending), true);
  assert.equal(gateway._askUserAnswerMatchesClient(cliB, { sessionId: 'cli:project-b' }, pending), false);
  assert.equal(gateway._askUserAnswerMatchesClient(cliB, { sessionKey: 'channel:cli:project-b' }, pending), false);
});

test('WebGateway does not label unscoped tool activity as the active graph', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  tools._graphRegistry = {
    getActiveSlug: () => 'default',
    get: slug => ({ slug, name: slug === 'default' ? 'Default' : slug }),
  };
  const gateway = new WebGateway(tools);

  const toolEvent = gateway._decorateGraphEventForClient({ op: 'tool:call', tool: 'exec', source: 'agent' });
  assert.equal(toolEvent.graph, undefined);
  assert.equal(toolEvent.graphName, undefined);

  const nodeEvent = gateway._decorateGraphEventForClient({ op: 'node:update', nodeId: 'n1', source: 'editor' });
  assert.equal(nodeEvent.graph, 'default');
  assert.equal(nodeEvent.graphName, 'Default');
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
    return sessionKey === 'channel:cli:test-user@project' ? 1 : 0;
  };
  tools.broadcast = () => { globalBroadcasts++; };

  const delivered = tools._broadcastTaskEvent({
    taskId: 'task_test',
    sessionKey: 'channel:cli:test-user@project',
    channelId: 'cli:test-user@project',
    platform: 'cli',
    userId: 'test-user',
  }, { type: 'subagent:start', taskId: 'task_test' });

  assert.equal(delivered, 1);
  assert.equal(globalBroadcasts, 0);
  assert.deepEqual(calls[0], {
    sessionKey: 'channel:cli:test-user@project',
    payload: { type: 'subagent:start', taskId: 'task_test', sessionId: 'cli:test-user@project' },
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
    sessionKey: 'channel:cli:test-user@project',
    channelId: 'cli:test-user@project',
    platform: 'cli',
    userId: 'test-user',
  }, { type: 'subagent:done', taskId: 'task_test' });

  assert.equal(delivered, 0);
  assert.equal(globalBroadcasts, 0);
  assert.equal(calls.includes('dm:test-user'), false);
  assert.equal(calls.includes('shared:dm:cli:test-user'), false);
});

test('subagent events for channel routes do not fall back to web dm or global broadcast', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const calls = [];
  let globalBroadcasts = 0;
  tools._wsBroadcast = (sessionKey) => {
    calls.push(sessionKey);
    return 0;
  };
  tools.broadcast = () => { globalBroadcasts++; };

  const delivered = tools._broadcastTaskEvent({
    taskId: 'task_telegram',
    sessionKey: 'shared:dm:telegram:123',
    channelId: 'telegram:123',
    platform: 'telegram',
    userId: '123',
  }, { type: 'subagent:done', taskId: 'task_telegram' });

  assert.equal(delivered, 0);
  assert.equal(globalBroadcasts, 0);
  assert.equal(calls.includes('dm:123'), false);
  assert.equal(calls.includes('shared:dm:web:123'), false);
});

test('subagent delivery for cli preserves project session key', () => {
  const tools = new ToolSystem(tmpConfig(), logger(), null, null, null);
  const taskEntry = {
    sessionKey: 'channel:cli:test-user@project',
    channelId: 'cli:test-user@project',
    platform: 'cli',
  };

  assert.equal(tools._deliverySessionKey(taskEntry, true, 'test-user'), 'channel:cli:test-user@project');
});

test('task list events for cli route only to originating session', async () => {
  const config = tmpConfig();
  const sessions = new SessionManager(config, logger(), null);
  assert.equal(sessions.init(), true);
  const tools = new ToolSystem(config, logger(), null, null, null);
  tools._sessions = sessions;
  const calls = [];
  let globalBroadcasts = 0;
  tools._wsBroadcast = (sessionKey, payload) => {
    calls.push({ sessionKey, payload });
    return sessionKey === 'channel:cli:test-user@project' ? 1 : 0;
  };
  tools.broadcast = () => { globalBroadcasts++; };

  try {
    const ctx = {
      sessionKey: 'channel:cli:test-user@project',
      channelId: 'cli:test-user@project',
      platform: 'cli',
      userId: 'test-user',
    };
    const created = await tools.executeTool('task_create', {
      id: 'route-test',
      subject: 'Route test task',
    }, ctx);
    const progressed = await tools.executeTool('task_progress', {
      id: 'route-test',
      status: 'done',
    }, ctx);

    assert.deepEqual(created, { ok: true, id: 'route-test' });
    assert.deepEqual(progressed, { ok: true });
    assert.equal(globalBroadcasts, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sessionKey, 'channel:cli:test-user@project');
    assert.equal(calls[0].payload.type, 'task:create');
    assert.equal(calls[1].sessionKey, 'channel:cli:test-user@project');
    assert.equal(calls[1].payload.type, 'task:update');
  } finally {
    try { sessions.db.close(); } catch {}
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  }
});
