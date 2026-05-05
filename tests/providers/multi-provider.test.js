'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MultiProvider,
  _hasForcedToolChoice,
} = require('../../src/providers');

const browserTool = {
  name: 'browser',
  description: 'Control a browser',
  input_schema: {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
  },
};

test('provider adapter keeps tools for explicit forced tool choice despite stale tools=false cache', () => {
  const client = new MultiProvider({});
  client._capabilities.set('openai/gpt-5.5', {
    tools: false,
    vision: true,
    audio: false,
    video: false,
  });

  const adapted = client.resolveRequest({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'use browser to see ynet.co.il' }],
    tools: [browserTool],
    tool_choice: { type: 'tool', name: 'browser' },
  });

  assert.equal(adapted.tools.length, 1);
  assert.deepEqual(adapted.tool_choice, { type: 'tool', name: 'browser' });
});

test('provider adapter still strips auto tools when stale tools=false cache is present', () => {
  const client = new MultiProvider({});
  client._capabilities.set('openai/gpt-5.5', {
    tools: false,
    vision: true,
    audio: false,
    video: false,
  });

  const adapted = client.resolveRequest({
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [browserTool],
    tool_choice: 'auto',
  });

  assert.equal(adapted.tools, undefined);
  assert.equal(adapted.tool_choice, undefined);
});

test('forced tool-choice helper recognizes generic and OpenAI shapes', () => {
  assert.equal(_hasForcedToolChoice({ tool_choice: { type: 'tool', name: 'browser' } }), true);
  assert.equal(_hasForcedToolChoice({ tool_choice: { type: 'function', function: { name: 'browser' } } }), true);
  assert.equal(_hasForcedToolChoice({ tool_choice: 'auto' }), false);
  assert.equal(_hasForcedToolChoice({ tool_choice: 'none' }), false);
});
