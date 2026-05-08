'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatFlowHarness,
  requestText,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');

test('cli plan research turns repair markerless stale greetings after tool work', async () => {
  const harness = createChatFlowHarness({
    prompt: [
      'You are a Spore Code agent.',
      '## Plan Mode',
      'Research turns must end with RESEARCH_DONE.',
      'QUESTIONS:',
      'PLAN_READY',
    ].join('\n'),
    tools: ['read_file'],
    toolResults: {
      read_file: { content: 'export function debounce() {}', path: 'src/utils.ts' },
    },
    script: [
      toolResponse('read_file', { path: 'src/utils.ts' }, {
        id: 'toolu_read_1',
        text: 'reading the relevant source',
      }),
      textResponse("hey test-user. what's up?"),
      textResponse('RESEARCH_DONE:\nsummary: inspected source and found the improvement targets.'),
    ],
  });

  const turn = await harness.send('[RESEARCH] Interview answers - proceed to research+code phase.', {
    sessionKey: 'channel:cli:test-user@test-project',
    channelId: 'cli:test-user@test-project',
    platform: 'cli',
    trigger: 'mention',
    isDm: false,
    projectContext: {
      cwd: '/work/test-project',
      project: 'test-project',
      mode: 'plan',
      source: 'spore-code',
      tools: ['read_file'],
      localTools: ['read_file'],
    },
  });

  assert.match(turn.text, /^RESEARCH_DONE:/);
  assert.equal(harness.model.requests.length, 3);
  assert.match(requestText(harness.model.requests[1]), /PLAN MODE CONTINUATION ANCHOR/);
  assert.match(requestText(harness.model.requests[1]), /Do not answer an earlier greeting/);
  assert.match(requestText(harness.model.requests[2]), /Plan Mode output repair/);
  assert.match(requestText(harness.model.requests[2]), /This is the RESEARCH turn/);
  assert.deepEqual(turn.toolCalls.map(c => c.name), ['read_file']);
  const persistedAssistantText = turn.history
    .filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.doesNotMatch(persistedAssistantText, /hey test-user/i);
  assert.match(persistedAssistantText, /RESEARCH_DONE:/);
});
