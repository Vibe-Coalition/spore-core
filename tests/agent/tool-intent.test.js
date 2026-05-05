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
