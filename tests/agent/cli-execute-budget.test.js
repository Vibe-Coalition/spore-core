'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatFlowHarness,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');

function budgetTestConfig() {
  return {
    dmMaxIterations: 2,
    loopDetection: { ceiling: 6, warn: 5, critical: 10, pingPong: 8, budgetPressure: 4 },
  };
}

test('cli execute turns are not stopped by the direct-message iteration cap', async () => {
  const harness = createChatFlowHarness({
    config: budgetTestConfig(),
    tools: ['read_file'],
    toolResults: {
      read_file: input => ({ content: `content for ${input.path}` }),
    },
    script: [
      toolResponse('read_file', { path: 'protocol.ts' }, { id: 'toolu_read_1' }),
      toolResponse('read_file', { path: 'auth.ts' }, { id: 'toolu_read_2' }),
      toolResponse('read_file', { path: 'types.ts' }, { id: 'toolu_read_3' }),
      textResponse('done after the third focused read'),
    ],
  });

  const turn = await harness.send('implement the protocol/auth changes', {
    sessionKey: 'channel:cli:test-user@repo',
    channelId: 'cli:test-user@repo',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/repo',
      project: 'repo',
      mode: 'execute',
      source: 'spore-code',
      tools: ['read_file'],
      localTools: ['read_file'],
    },
  });

  assert.equal(turn.text, 'done after the third focused read');
  assert.equal(harness.model.requests.length, 4);
  assert.deepEqual(turn.toolCalls.map(c => c.input.path), ['protocol.ts', 'auth.ts', 'types.ts']);
  assert.equal(harness.logger.entries.some(e => /Chat hit max iterations/.test(e.text)), false);
});

test('ordinary direct chat still respects dmMaxIterations', async () => {
  const harness = createChatFlowHarness({
    config: budgetTestConfig(),
    tools: ['read_file'],
    toolResults: {
      read_file: input => ({ content: `content for ${input.path}` }),
    },
    script: [
      toolResponse('read_file', { path: 'one.txt' }, { id: 'toolu_read_1' }),
      toolResponse('read_file', { path: 'two.txt' }, { id: 'toolu_read_2' }),
      toolResponse('read_file', { path: 'three.txt' }, { id: 'toolu_read_3' }),
      textResponse('should not reach this response'),
    ],
  });

  const turn = await harness.send('read several files', {
    sessionKey: 'channel:web:user',
    channelId: 'web:user',
    platform: 'web',
    trigger: 'dm',
    isDm: true,
  });

  assert.equal(harness.model.requests.length, 2);
  assert.deepEqual(turn.toolCalls.map(c => c.input.path), ['one.txt', 'two.txt']);
  assert.equal(harness.logger.entries.some(e => /Chat hit max iterations \(2\)/.test(e.text)), true);
});
