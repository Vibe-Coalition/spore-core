'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop } = require('../../src/agent/loop');

function makeAgent(toolNames) {
  return new AgentLoop(
    {},
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    {
      getToolDefinitions() {
        return toolNames.map(name => ({ name }));
      },
    },
    null,
  );
}

function makeFilteringAgent() {
  return new AgentLoop(
    {},
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    {
      getToolDefinitions(opts = {}) {
        const names = opts.projectContext?.mode === 'plan'
          ? ['read_file', 'glob']
          : ['read_file', 'glob', 'exec', 'write_file', 'edit_file'];
        return names.map(name => ({ name }));
      },
    },
    null,
  );
}

test('explicit browse intent forces the browser tool when available', () => {
  const agent = makeAgent(['browser', 'graph_query', 'web_search']);

  assert.equal(
    agent._detectForcedToolNameForIntent('can you browse ynet.co.il', { platform: 'web' }),
    'browser',
  );
  assert.equal(
    agent._detectForcedToolNameForIntent('open https://example.com', { platform: 'web' }),
    'browser',
  );
});

test('explicit graph/node intent forces graph_query when available', () => {
  const agent = makeAgent(['browser', 'graph_query', 'graph_update']);

  assert.equal(
    agent._detectForcedToolNameForIntent('check out the nodes', { platform: 'web' }),
    'graph_query',
  );
  assert.equal(
    agent._detectForcedToolNameForIntent('did you check your graph', { platform: 'web' }),
    'graph_query',
  );
  assert.equal(
    agent._detectForcedToolNameForIntent('can you use graph_query', { platform: 'web' }),
    'graph_query',
  );
  assert.equal(
    agent._detectForcedToolNameForIntent('make a node for sushi', { platform: 'web' }),
    'graph_update',
  );
});

test('tool intent detector does not force a tool for generic chat', () => {
  const agent = makeAgent(['browser', 'graph_query']);

  assert.equal(agent._detectForcedToolNameForIntent('hello there', { platform: 'web' }), null);
});

test('tool intent detector ignores background worker prompts', () => {
  const agent = makeAgent(['ask_user', 'graph_query']);

  assert.equal(
    agent._detectForcedToolNameForIntent('Research ask_user Tool and record findings with graph_query.', {
      platform: 'system',
      trigger: 'worker',
    }),
    null,
  );
});

test('retry intent inherits the previous explicit tool request', () => {
  const agent = makeAgent(['browser', 'graph_query']);

  assert.equal(
    agent._detectForcedToolNameForIntent('again', {
      platform: 'web',
      messages: [
        { role: 'user', content: 'can you browse to reddit.com' },
        { role: 'assistant', content: 'I emitted <tool_call name="browser">{"action":"navigate","url":"https://www.reddit.com"}</tool_call> as text.' },
        { role: 'user', content: 'again' },
      ],
    }),
    'browser',
  );
});

test('forced tool-choice transport remains provider-owned', () => {
  const agent = makeAgent(['browser']);

  assert.equal(
    agent._shouldUseNonStreamToolTurn({
      tools: [{ name: 'browser' }],
      tool_choice: { type: 'tool', name: 'browser' },
    }),
    false,
  );
  assert.equal(agent._shouldUseNonStreamToolTurn({ tools: [{ name: 'browser' }] }), false);
});

test('end-turn handler does not replay stale intermediate text as final answer', () => {
  const agent = makeAgent(['read_file']);
  const stored = [];
  agent.sessions = {
    addMessage(sessionKey, role, content) {
      stored.push({ sessionKey, role, content });
    },
  };

  const result = agent._handleEndTurn({
    response: { content: [] },
    responseText: '',
    finalText: 'stale intermediate text',
    lastSentIntermediate: 'different streamed text',
    sessionKey: 'session-1',
    opts: {},
    messages: [],
  });

  assert.equal(result.action, 'break');
  assert.equal(result.finalText, '');
  assert.deepEqual(stored, []);
});

test('empty direct coding replies are repaired only after tool use', () => {
  const agent = makeAgent(['read_file']);
  const base = {
    opts: { trigger: 'mention', projectContext: { mode: 'execute', cwd: '/repo' } },
    toolLog: [{ tool: 'read_file' }],
  };

  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: '', isDirect: true }), true);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: 'NO_REPLY', isDirect: true }), true);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: 'done', isDirect: true }), false);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: '', isDirect: false }), false);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: '', isDirect: true, wasUserAbort: true }), false);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: '', isDirect: true, toolLog: [] }), false);
  assert.equal(agent._shouldRepairEmptyDirectToolReply({ ...base, finalText: '', isDirect: true, opts: { trigger: 'mention' } }), false);
});

test('empty direct coding reply repair uses a no-tool status turn and reports metadata', async () => {
  const agent = makeAgent(['read_file', 'exec']);
  const statuses = [];
  const messages = [
    { role: 'user', content: 'fix the tests' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'exec', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] },
  ];
  let request;
  agent._callLLM = async (systemPrompt, repairMessages, opts) => {
    request = { systemPrompt, repairMessages, opts };
    return {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
      content: [{ type: 'text', text: 'I made the change and the focused npm test command passed.' }],
    };
  };
  const totalUsage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  const repair = await agent._repairEmptyDirectToolReply({
    systemPrompt: 'sys',
    staticPrompt: 'static',
    dynamicContext: 'dynamic',
    messages,
    opts: {
      platform: 'cli',
      trigger: 'mention',
      projectContext: { mode: 'execute', cwd: '/repo' },
      onStatus(status) { statuses.push(status); },
    },
    sessionKey: 'session-1',
    totalUsage,
    toolLog: [{
      tool: 'exec',
      input: '{"command":"npm test -- --grep request-id"}',
      resultPreview: '{"ok":true,"stdout":"15 passing"}',
      succeeded: true,
      exitCode: 0,
    }],
  });

  assert.equal(repair.repaired, true);
  assert.match(repair.text, /focused npm test/);
  assert.deepEqual(request.opts.tools, []);
  assert.equal(request.opts.route, 'response-repair');
  assert.equal(request.opts.projectContext.cwd, '/repo');
  assert.match(request.repairMessages.at(-1).content, /Do not call tools/);
  assert.match(request.repairMessages.at(-1).content, /Latest tool evidence/);
  assert.match(request.repairMessages.at(-1).content, /npm test -- --grep request-id/);
  assert.notEqual(request.repairMessages, messages);
  assert.deepEqual(statuses, [{ type: 'response_repair', reason: 'empty_tool_reply' }]);
  assert.deepEqual(totalUsage, {
    input_tokens: 11,
    output_tokens: 6,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
  });
});

test('runtime contract adds a non-droppable cli plan-mode guard', () => {
  const agent = makeAgent(['read_file', 'glob', 'graph_query']);
  const contract = agent._buildRuntimeToolContract({
    platform: 'cli',
    projectContext: { mode: 'plan' },
  });

  assert.match(contract, /## Plan Mode Guard/);
  assert.match(contract, /RULES \(HARD\):/);
  assert.match(contract, /QUESTIONS:/);
  assert.match(contract, /PLAN_READY/);
  assert.match(contract, /Do NOT call `exec`/);
  assert.match(contract, /Evidence discipline/);
  assert.match(contract, /stale context/);
  assert.match(contract, /Ask the user when uncertainty is about intent/);
  assert.match(contract, /final verification claims must be command-derived/);
  assert.match(contract, /focused tests/);
});

test('runtime contract explains graph discovery and General Knowledge Base access', () => {
  const agent = makeAgent(['graph_query']);
  const contract = agent._buildRuntimeToolContract({ platform: 'web' });

  assert.match(contract, /graph_query\(\{ mode: "graphs" \}\)/);
  assert.match(contract, /graph: "spore-knowledge-base"/);
  assert.match(contract, /type: "skill"/);
  assert.match(contract, /shared\/stored graph knowledge/);
  assert.match(contract, /Do not call it empty or "fresh"/);
  assert.match(contract, /do not inspect `\/data\/graphs`/i);
});

test('cli plan marker text does not force hidden execution tools', () => {
  const agent = makeFilteringAgent();
  const content = '[PLAN MODE — read your ## Plan Mode system prompt section. Do NOT call write_file/edit_file/exec. Follow the phase instructions there.]\n\nok thanks it works';

  assert.equal(
    agent._detectForcedToolNameForIntent(content, {
      platform: 'cli',
      projectContext: { mode: 'plan' },
    }),
    null,
  );
});

test('graph discovery loop guard catches varied no-progress graph probes', () => {
  const agent = makeAgent(['graph_query']);
  const tracker = {};
  const result = JSON.stringify({ mode: 'overview', nodes: [], total: 0, done: true });
  const calls = [
    { query: 'shared graph' },
    { query: 'shared graph knowledge skills' },
    { query: 'stored skills' },
    { query: 'distilled skills' },
    { query: '*' },
    { mode: 'overview' },
    { graph: 'spore-knowledge-base', type: 'concept' },
    { project: 'spore-knowledge-base', type: 'technology' },
    { graph: 'spore-knowledge-base', query: 'general knowledge' },
    { query: 'current graph' },
    { mode: 'graphs' },
  ];

  const checks = calls.map(input => agent._recordGraphDiscoveryProgress(
    tracker,
    'graph_query',
    input,
    result,
  ));

  assert.equal(checks.some(c => c.warning), true);
  assert.equal(checks.at(-1).blocked, true);
  assert.match(checks.at(-1).message, /Repeated graph-discovery queries/);
});

test('aborted tool batches keep tool_use/tool_result pairing intact', async () => {
  const agent = makeAgent(['exec', 'write_file']);
  const ac = new AbortController();
  ac.abort();

  const result = await agent._executeToolBatch([
    { id: 'toolu_1', name: 'exec', input: { command: 'sleep 10' } },
    { id: 'toolu_2', name: 'write_file', input: { path: 'x', content: 'y' } },
  ], {
    abortSignal: ac.signal,
    sessionKey: 'session-1',
    loopTracker: new Map(),
    toolLog: [],
    opts: {},
  });

  assert.equal(result.toolResults.length, 2);
  assert.deepEqual(result.toolResults.map(r => r.tool_use_id), ['toolu_1', 'toolu_2']);
  for (const tr of result.toolResults) {
    const parsed = JSON.parse(tr.content);
    assert.equal(parsed.interrupted, true);
    assert.match(parsed.note, /context/);
  }
});

test('duplicate tool batches execute one identical call and preserve pairing', async () => {
  const agent = makeAgent(['read_file']);
  const executed = [];
  const statuses = [];

  const result = await agent._executeToolBatch([
    { id: 'toolu_1', name: 'read_file', input: { path: 'tests/test_options.py' } },
    { id: 'toolu_2', name: 'read_file', input: { path: 'tests/test_options.py' } },
    { id: 'toolu_3', name: 'read_file', input: { path: 'tests/test_options.py', offset: 10, limit: 5 } },
  ], {
    abortSignal: null,
    sessionKey: 'session-1',
    loopTracker: { history: [], maxHistory: 20 },
    toolLog: [],
    opts: {
      onStatus(status) { statuses.push(status); },
      async onToolExecute(name, input, id) {
        executed.push({ name, input, id });
        return { ok: true, id, input };
      },
    },
  });

  assert.deepEqual(executed.map(e => e.id), ['toolu_1', 'toolu_3']);
  assert.equal(result.criticalBlock, false);
  assert.deepEqual(result.toolResults.map(r => r.tool_use_id), ['toolu_1', 'toolu_2', 'toolu_3']);
  assert.match(JSON.parse(result.toolResults[1].content).error, /Duplicate read_file call skipped/);
  assert.equal(JSON.parse(result.toolResults[1].content).duplicateOf, 'toolu_1');
  assert.equal(statuses.some(s => s.type === 'duplicate_tool_batch' && s.skipped === 1), true);
});

test('large duplicate tool batches trip the loop breaker before context bloat', async () => {
  const agent = makeAgent(['read_file']);
  let executed = 0;
  const blocks = Array.from({ length: 12 }, (_, i) => ({
    id: `toolu_${i}`,
    name: 'read_file',
    input: { path: 'tests/test_options.py' },
  }));

  const result = await agent._executeToolBatch(blocks, {
    abortSignal: null,
    sessionKey: 'session-1',
    loopTracker: { history: [], maxHistory: 20 },
    toolLog: [],
    opts: {
      async onToolExecute() {
        executed += 1;
        return { ok: true, content: 'file contents' };
      },
    },
  });

  assert.equal(executed, 1);
  assert.equal(result.criticalBlock, true);
  assert.equal(result.toolResults.length, 12);
  assert.equal(result.toolResults.filter(r => /Duplicate read_file call skipped/.test(r.content)).length, 11);
});

test('context overflow errors compact once and retry', async () => {
  const agent = makeAgent(['read_file']);
  const statuses = [];
  let compactArgs = null;
  agent._compactHistory = async (sessionKey, messages, targetTokens, onStatus) => {
    compactArgs = { sessionKey, messages, targetTokens, onStatus };
    return [
      messages[0],
      { role: 'user', content: '[compacted test history]' },
    ];
  };

  const err = new Error('OAI provider HTTP 400: {"error":{"message":"This model maximum context length is 262144 tokens. However, you requested 8192 output tokens and your prompt contains at least 253953 input tokens"}}');
  err.status = 400;
  const state = {
    sessionRecoveredThisCall: false,
    contextOverflowRecoveredThisCall: false,
    apiRetries: 0,
  };

  const first = await agent._handleIterationError(err, {
    abortSignal: null,
    sessionKey: 'session-1',
    iterations: 3,
    opts: { onStatus(status) { statuses.push(status); } },
    messages: [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'x'.repeat(10000) },
    ],
    state,
    systemPrompt: 'system',
    hardCeiling: 12000,
  });

  assert.equal(first.action, 'continue');
  assert.equal(state.contextOverflowRecoveredThisCall, true);
  assert.equal(compactArgs.sessionKey, 'session-1');
  assert.ok(compactArgs.targetTokens < 12000);
  assert.deepEqual(first.messages, [
    { role: 'user', content: 'fix it\n[compacted test history]' },
  ]);
  assert.equal(statuses.some(s => s.type === 'context_overflow_recover'), true);
  assert.equal(statuses.some(s => s.type === 'context_overflow_retry'), true);

  const second = await agent._handleIterationError(err, {
    abortSignal: null,
    sessionKey: 'session-1',
    iterations: 4,
    opts: {},
    messages: first.messages,
    state,
    systemPrompt: 'system',
    hardCeiling: 12000,
  });
  assert.equal(second.action, 'rethrow');
});

test('abort preserves queued interjections instead of discarding user text', () => {
  const agent = makeAgent(['read_file']);
  const saved = [];
  agent.sessions = {
    addMessage(sessionKey, role, content) {
      saved.push({ sessionKey, role, content });
    },
  };
  agent._pendingInterjections = new Map([
    ['session-1', [
      { content: 'yes use the LAN IP', opts: null },
      'also print the QR here',
    ]],
  ]);

  const count = agent._preservePendingInterjectionsOnAbort('session-1');

  assert.equal(count, 2);
  assert.deepEqual(saved, [
    { sessionKey: 'session-1', role: 'user', content: 'yes use the LAN IP' },
    { sessionKey: 'session-1', role: 'user', content: 'also print the QR here' },
  ]);
});
