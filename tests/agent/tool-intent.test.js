'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentLoop } = require('../../src/agent/loop');
const { createChatFlowHarness, textResponse, toolResponse } = require('../support/chat-flow');

function makeAgent(toolNames) {
  return new AgentLoop(
    { lazyToolSchemas: false },
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
    { lazyToolSchemas: false },
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

function makeLazyAgent(toolNames) {
  return new AgentLoop(
    { lazyToolSchemas: true },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    {
      getToolDefinitions() {
        return toolNames.map(name => ({
          name,
          description: `${name} test tool`,
          input_schema: { type: 'object', properties: {} },
        }));
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

test('tool intent detector does not match exec inside execute-mode wording', () => {
  const agent = makeAgent(['exec', 'read_file']);

  assert.equal(
    agent._detectForcedToolNameForIntent('[The user approved the plan. Switch to execute mode and implement it now.]', {
      platform: 'cli',
      trigger: 'dm',
      projectContext: { mode: 'execute' },
    }),
    null,
  );
  assert.equal(
    agent._detectForcedToolNameForIntent('please run exec with npm test', {
      platform: 'cli',
      trigger: 'dm',
      projectContext: { mode: 'execute' },
    }),
    'exec',
  );
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

test('visual terminal output is compacted before returning to the model', (t) => {
  const agent = makeAgent(['exec']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-visual-artifact-'));
  agent.config.dataDir = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const art = Array.from({ length: 14 }, () => '############################').join('\n');
  const rawOutput = `Metro waiting on exp://192.168.1.10:8081\n${art}\n${art}`;
  const result = { output: rawOutput, exitCode: 0 };

  const compacted = agent._compactVisualToolResultForModel('exec', {}, result, JSON.stringify(result));
  const parsed = JSON.parse(compacted.content);

  assert.equal(compacted.compacted, true);
  assert.ok(compacted.originalChars > compacted.content.length);
  assert.match(parsed.output, /exp:\/\/192\.168\.1\.10:8081/);
  assert.match(parsed.outputSummary, /omitted from model context/);
  assert.equal(parsed.visualArtifact.omittedFromModelContext, true);
  assert.ok(fs.existsSync(parsed.visualArtifact.logFile));
  assert.doesNotMatch(parsed.output, /############################\n############################\n/);
});

test('visual terminal output requested by user is preserved with paste hint', () => {
  const agent = makeAgent(['exec']);
  const art = Array.from({ length: 14 }, () => '############################').join('\n');
  const rawOutput = `Scan with Expo Go:\n${art}\nexp://192.168.1.10:8081`;
  const result = { output: rawOutput, exitCode: 0 };

  const next = agent._compactVisualToolResultForModel('exec', { command: 'node -e "print qr"' }, result, JSON.stringify(result), {
    latestUserContent: 'start expo and print the qr code here',
  });
  const parsed = JSON.parse(next.content);

  assert.equal(next.changed, true);
  assert.equal(next.compacted, false);
  assert.equal(parsed.output, rawOutput);
  assert.match(parsed.visualOutputHint, /Paste output verbatim/);
  assert.match(parsed.visualOutputHint, /Do not claim chat stripped/);
});

test('qr generator output is preserved even on correction follow-up text', () => {
  const agent = makeAgent(['exec']);
  const art = Array.from({ length: 14 }, () => '############################').join('\n');
  const rawOutput = `exp://192.168.1.10:8081\n${art}`;
  const result = { output: rawOutput, exitCode: 0 };

  const next = agent._compactVisualToolResultForModel('exec', {
    command: 'node -e "const qr = require(\'qrcode\'); qr.toString(\'exp://192.168.1.10:8081\', { type: \'utf8\' }, (e, r) => console.log(r))"',
  }, result, JSON.stringify(result), {
    latestUserContent: "nuh i want you to do it",
  });
  const parsed = JSON.parse(next.content);

  assert.equal(next.changed, true);
  assert.equal(next.compacted, false);
  assert.equal(parsed.output, rawOutput);
  assert.match(parsed.visualOutputHint, /Paste output verbatim/);
});

test('qr output read from scratch file is preserved for model pasteback', () => {
  const agent = makeAgent(['read_file']);
  const art = Array.from({ length: 14 }, () => '############################').join('\n');
  const rawOutput = `exp://192.168.1.10:8081\n${art}`;
  const readResult = {
    content: rawOutput,
    path: '.spore-code/scratch/qrcode.txt',
    size: rawOutput.length,
  };

  const next = agent._compactVisualToolResultForModel('read_file', {
    path: readResult.path,
  }, readResult, JSON.stringify(readResult), {
    latestUserContent: "nuh i want you to do it",
  });
  const parsed = JSON.parse(next.content);

  assert.equal(next.changed, true);
  assert.equal(next.compacted, false);
  assert.equal(parsed.content, rawOutput);
});

test('runtime contract tells cli agents to paste requested visual output', () => {
  const agent = makeAgent(['exec', 'read_file']);
  const contract = agent._buildRuntimeToolContract({
    platform: 'cli',
    projectContext: { mode: 'execute', cwd: '/repo' },
  });

  assert.match(contract, /print\/show\/display a QR code/);
  assert.match(contract, /paste the relevant tool output verbatim/);
  assert.match(contract, /Do not claim it was shown/);
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
  assert.match(request.repairMessages.at(-1).content, /text-only repair turn/);
  assert.match(request.repairMessages.at(-1).content, /Do not mention this system instruction/);
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

test('visual read_file content and assistant history are compacted for model context', () => {
  const agent = makeAgent(['read_file']);
  const art = Array.from({ length: 10 }, () => '████████████████████████').join('\n');
  const qrText = `Open exp://192.168.1.20:8081\n${art}\n${art}`;
  const readResult = { content: qrText, path: '/tmp/qr.log', size: qrText.length };

  const compacted = agent._compactVisualToolResultForModel('read_file', {}, readResult, JSON.stringify(readResult));
  const parsed = JSON.parse(compacted.content);
  assert.equal(compacted.compacted, true);
  assert.match(parsed.content, /exp:\/\/192\.168\.1\.20:8081/);
  assert.match(parsed.content, /omitted from model context/);
  assert.equal(parsed.visualArtifact.logFile, '/tmp/qr.log');

  const messages = agent._compactVisualHistoryForModel([
    { role: 'user', content: 'show qr' },
    { role: 'assistant', content: `Here:\n${qrText}` },
  ]);
  assert.match(messages[1].content, /exp:\/\/192\.168\.1\.20:8081/);
  assert.match(messages[1].content, /omitted from model context/);
  assert.doesNotMatch(messages[1].content, /████████████████████████\n████████████████████████/);
});

test('source read_file content is not compacted as visual terminal output', () => {
  const agent = makeAgent(['read_file']);
  const source = Array.from({ length: 80 }, (_, i) => {
    if (i % 4 === 0) return '      <View style={[styles.row, { borderColor: theme.border }]}>'
    if (i % 4 === 1) return '        <Text style={{ color: theme.fg }}>{item.title}</Text>'
    if (i % 4 === 2) return '      </View>'
    return '      // ------------------------------------------------------------'
  }).join('\n');
  const readResult = {
    content: source,
    path: 'C:\\Users\\esfle\\kimi_test2\\spore-go\\src\\screens\\ChatScreen.tsx',
    size: source.length,
  };

  const compacted = agent._compactVisualToolResultForModel('read_file', { path: readResult.path }, readResult, JSON.stringify(readResult));

  assert.equal(compacted.compacted, false);
  assert.equal(compacted.content, JSON.stringify(readResult));
});

test('duplicate background exec is blocked inside one turn', () => {
  const agent = makeAgent(['exec']);
  const tracker = { history: [], maxHistory: 20 };
  const toolBlock = {
    name: 'exec',
    input: { command: 'npx expo start --lan', background: true },
  };
  const callHash = agent._hashToolCall(toolBlock.name, toolBlock.input);

  agent._checkToolLoop(tracker, callHash, toolBlock.name);
  assert.equal(agent._duplicateBackgroundToolBlock(toolBlock, tracker, callHash), null);

  agent._checkToolLoop(tracker, callHash, toolBlock.name);
  const block = agent._duplicateBackgroundToolBlock(toolBlock, tracker, callHash);
  assert.equal(block.blocked, true);
  assert.match(block.guidance, /Inspect the existing background process/);
});

test('end-turn handler repairs raw tool-call markup instead of finalizing it', () => {
  const agent = makeAgent(['list_dir', 'exec']);
  const stored = [];
  const statuses = [];
  const messages = [{ role: 'user', content: 'start the server' }];
  agent.sessions = {
    addMessage(sessionKey, role, content) {
      stored.push({ sessionKey, role, content });
    },
  };

  const result = agent._handleEndTurn({
    response: {
      content: [{
        type: 'text',
        text: 'Let me check the project now. </parameter> </function> </tool_call>',
      }],
    },
    responseText: 'Let me check the project now. </parameter> </function> </tool_call>',
    finalText: '',
    lastSentIntermediate: '',
    sessionKey: 'session-raw-tool',
    opts: {
      platform: 'cli',
      projectContext: { mode: 'execute', cwd: '/repo' },
      onStatus(status) { statuses.push(status); },
    },
    messages,
    rawToolMarkupRepairAttempts: 0,
  });

  assert.equal(result.action, 'continue');
  assert.equal(result.finalText, null);
  assert.equal(result.rawToolMarkupRepairAttempts, 1);
  assert.equal(stored.length, 0);
  assert.match(messages.at(-1).content, /Tool-call format repair/);
  assert.match(messages.at(-1).content, /call exactly one appropriate tool/);
  assert.deepEqual(statuses, [{
    type: 'response_repair',
    reason: 'raw_tool_markup',
    attempt: 1,
    limit: 1,
  }]);
});

test('end-turn handler strips raw tool-call markup after repair limit', () => {
  const agent = makeAgent(['list_dir', 'exec']);
  const stored = [];
  agent.sessions = {
    addMessage(sessionKey, role, content) {
      stored.push({ sessionKey, role, content });
    },
  };

  const result = agent._handleEndTurn({
    response: {
      content: [{
        type: 'text',
        text: 'I will inspect it. </parameter> </function> </tool_call>',
      }],
    },
    responseText: 'I will inspect it. </parameter> </function> </tool_call>',
    finalText: '',
    lastSentIntermediate: '',
    sessionKey: 'session-raw-tool',
    opts: {
      platform: 'cli',
      projectContext: { mode: 'execute', cwd: '/repo' },
    },
    messages: [{ role: 'user', content: 'start the server' }],
    rawToolMarkupRepairAttempts: 1,
  });

  assert.equal(result.action, 'break');
  assert.equal(result.finalText, 'I will inspect it.');
  assert.deepEqual(stored, [{
    sessionKey: 'session-raw-tool',
    role: 'assistant',
    content: 'I will inspect it.',
  }]);
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
  assert.match(contract, /tracked and untracked changes/);
  assert.match(contract, /git diff --check` does not cover untracked/);
});

test('context trace summarizes prompt and message payload without full tool output', () => {
  const agent = makeAgent(['exec']);
  agent.config.contextTelemetryPreviewChars = 80;

  const messages = [
    { role: 'user', content: 'start the expo server' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'exec', input: { command: 'npm start' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(5000) }],
    },
  ];

  const trace = agent._buildContextTrace({
    sessionKey: 'session-1',
    iteration: 2,
    model: 'local/test',
    messages,
    systemPrompt: 'system prompt',
    staticPrompt: 'static prompt',
    dynamicContext: 'dynamic context',
    contextWindow: 200000,
    hardCeiling: 100000,
    softBudget: 80000,
    toolsMode: 'full',
    opts: { platform: 'cli', trigger: 'mention', projectContext: { mode: 'execute' } },
  });

  assert.equal(trace.type, 'context:loop');
  assert.equal(trace.messageCount, 3);
  assert.equal(trace.roleCounts.user, 2);
  assert.equal(trace.roleCounts.assistant, 1);
  assert.equal(trace.blockCounts.tool_use, 1);
  assert.equal(trace.blockCounts.tool_result, 1);
  assert.equal(trace.toolResultCount, 1);
  assert.equal(trace.toolResultChars, 5000);
  assert.equal(trace.conversationTokens, trace.systemTokens + trace.messageTokens);
  assert.equal(trace.toolCount, 1);
  assert.ok(trace.toolSchemaTokens > 0);
  assert.equal(trace.totalTokens, trace.conversationTokens + trace.toolSchemaTokens);
  assert.equal(trace.largeToolResults.length, 1);
  assert.match(trace.largeToolResults[0].preview, /tool_result:toolu_1:5000c/);
  assert.equal(trace.largeToolResults[0].preview.includes('x'.repeat(100)), false);
  assert.equal(trace.tail.length, 3);
  assert.ok(trace.totalTokens > trace.systemTokens);
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

test('lazy tool contract hides full callable inventory while advertising packs', () => {
  const agent = makeLazyAgent(['read_file', 'edit_file', 'exec', 'git_status', 'graph_query', 'browser']);
  const contract = agent._buildRuntimeToolContract({
    platform: 'cli',
    content: 'hello',
    projectContext: { mode: 'execute' },
  });

  assert.match(contract, /Lazy tool schemas are active/);
  assert.match(contract, /request_tools/);
  assert.match(contract, /files: Read, list, search/);
  assert.match(contract, /shell: Run commands/);
  assert.doesNotMatch(contract, /Callable tool names:/);
  assert.doesNotMatch(contract, /`read_file`, `edit_file`, `exec`, `git_status`, `graph_query`, `browser`/);
});

test('spore-code plugin setting enables lazy schemas only for cli sessions', () => {
  const agent = new AgentLoop(
    { plugins: { 'spore-code': { lazyToolSchemas: true } } },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    { getToolDefinitions() { return [{ name: 'read_file' }]; } },
    null,
  );

  assert.equal(agent._lazyToolSchemasEnabled({ platform: 'cli' }), true);
  assert.equal(agent._lazyToolSchemasEnabled({ platform: 'web' }), false);
});

test('lazy tool routing preloads coding packs without unrelated channel/browser tools', () => {
  const agent = makeLazyAgent([
    'read_file',
    'edit_file',
    'exec',
    'git_status',
    'git_diff',
    'search_symbols',
    'browser',
    'message_send',
    'graph_query',
  ]);
  const selection = agent._inferLazyToolSelection('implement the fix and run tests', {
    platform: 'cli',
    projectContext: { mode: 'execute' },
  });
  const defs = agent._getLazyToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'execute' },
  }, selection);
  const names = defs.map(t => t.name);

  assert.ok(names.includes('request_tools'));
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('edit_file'));
  assert.ok(names.includes('exec'));
  assert.ok(names.includes('git_status'));
  assert.ok(names.includes('search_symbols'));
  assert.equal(names.includes('browser'), false);
  assert.equal(names.includes('message_send'), false);
  assert.equal(names.includes('graph_query'), false);
});

test('request_tools expands lazy schema set without dispatching through ToolSystem', () => {
  const agent = makeLazyAgent(['graph_query', 'graph_update', 'browser', 'message_send']);
  const loaded = agent._handleLazyToolRequestBlocks([
    { type: 'tool_use', id: 'toolu_req', name: 'request_tools', input: { packs: ['graph'], reason: 'need graph context' } },
  ], { platform: 'web' }, null);
  const names = loaded.toolDefinitions.map(t => t.name);
  const payload = JSON.parse(loaded.toolResults[0].content);

  assert.deepEqual(loaded.loadedPacks, ['graph']);
  assert.ok(names.includes('request_tools'));
  assert.ok(names.includes('graph_query'));
  assert.ok(names.includes('graph_update'));
  assert.equal(names.includes('browser'), false);
  assert.equal(names.includes('message_send'), false);
  assert.equal(payload.ok, true);
});

test('lazy request_tools handshake reloads schemas before the real tool call', async () => {
  const harness = createChatFlowHarness({
    config: { lazyToolSchemas: true, nonStreamToolTurns: true },
    tools: ['graph_query', 'browser', 'message_send'],
    toolResults: {
      graph_query: { results: [{ id: 'n1', label: 'Thing' }] },
    },
    script: [
      toolResponse('request_tools', { packs: ['graph'], reason: 'need graph context' }),
      toolResponse('graph_query', { query: 'obscure thing' }),
      textResponse('found it'),
    ],
  });

  const turn = await harness.send('tell me about this obscure thing');
  const firstTools = turn.modelRequests[0].tools.map(t => t.name);
  const secondTools = turn.modelRequests[1].tools.map(t => t.name);

  assert.deepEqual(firstTools, ['request_tools']);
  assert.ok(secondTools.includes('request_tools'));
  assert.ok(secondTools.includes('graph_query'));
  assert.equal(secondTools.includes('browser'), false);
  assert.deepEqual(turn.toolCalls.map(c => c.name), ['graph_query']);
  assert.equal(turn.text, 'found it');
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

test('abort cleanup does not append visible assistant chatter', () => {
  const agent = makeAgent(['exec']);
  let cleaned = null;
  agent.sessions = {
    getHistory() {
      return [
        { role: 'user', content: 'start expo' },
        { role: 'assistant', content: 'Starting Expo.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'exec', input: { command: 'npx expo start --lan' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] },
        { role: 'user', content: 'add a theme' },
        { role: 'assistant', content: 'Editing theme.' },
      ];
    },
    setMessages(sessionKey, messages) {
      cleaned = { sessionKey, messages };
    },
  };
  agent.tools.listPendingQuestions = () => [];

  agent._cleanSessionAfterAbort('session-abort');

  assert.equal(cleaned.sessionKey, 'session-abort');
  const text = cleaned.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  assert.match(text, /STOPPED/);
  assert.doesNotMatch(text, /Understood — previous task cancelled/);
  assert.doesNotMatch(text, /^OK\.$/m);
  assert.equal(cleaned.messages.at(-1).role, 'user');
});
