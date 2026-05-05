'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OAICompatClient,
  toOAIRequest,
  fromOAIResponse,
  _toOAIToolChoice,
  _isForcedOAIToolChoice,
} = require('../../plugins/local-oai-provider/lib/oai-compat-client');

const browserTool = {
  name: 'browser',
  description: 'Control a browser',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      url: { type: 'string' },
    },
    required: ['action'],
  },
};

test('oai compat uses auto tool choice by default when tools are present', () => {
  const body = toOAIRequest({
    model: 'openai/gpt-5.5',
    system: 'You are an agent.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [browserTool],
  }, { useMaxCompletionTokens: true });

  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'browser');
});

test('oai compat converts generic forced tool choice to OpenAI function shape', () => {
  assert.deepEqual(
    _toOAIToolChoice({ type: 'tool', name: 'browser' }),
    { type: 'function', function: { name: 'browser' } },
  );
  assert.equal(_isForcedOAIToolChoice({ type: 'function', function: { name: 'browser' } }), true);
  assert.equal(_isForcedOAIToolChoice('auto'), false);

  const body = toOAIRequest({
    model: 'openai/gpt-5.5',
    system: 'You are an agent.',
    messages: [{ role: 'user', content: 'browse ynet.co.il' }],
    tools: [browserTool],
    tool_choice: { type: 'tool', name: 'browser' },
  }, { useMaxCompletionTokens: true });

  assert.deepEqual(body.tool_choice, {
    type: 'function',
    function: { name: 'browser' },
  });
});

test('oai compat forced tool-choice stream uses provider-owned non-stream request', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'browser',
                  arguments: '{"action":"navigate","url":"https://www.reddit.com"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    };
  };

  try {
    const client = new OAICompatClient({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      useMaxCompletionTokens: true,
    });
    const stream = client.messages.stream({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'browse reddit.com' }],
      tools: [browserTool],
      tool_choice: { type: 'tool', name: 'browser' },
      max_tokens: 256,
    });
    const final = await stream.finalMessage();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, undefined);
    assert.deepEqual(calls[0].tool_choice, { type: 'function', function: { name: 'browser' } });
    assert.equal(final.stop_reason, 'tool_use');
    assert.equal(final.content.find(b => b.type === 'tool_use')?.name, 'browser');
  } finally {
    global.fetch = oldFetch;
  }
});

test('oai compat recovers tool calls serialized as named XML text', () => {
  const result = fromOAIResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: 'Trying.\n<tool_call name="browser">\n{"action":"navigate","url":"https://www.reddit.com"}\n</tool_call>',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 10 },
  });

  assert.equal(result.stop_reason, 'tool_use');
  const tool = result.content.find(b => b.type === 'tool_use');
  assert.equal(tool.name, 'browser');
  assert.deepEqual(tool.input, { action: 'navigate', url: 'https://www.reddit.com' });
});

test('oai compat recovers self-closing tool calls with arguments attribute', () => {
  const result = fromOAIResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call name="browser" arguments=\'{"action":"navigate","url":"https://www.ynet.co.il"}\' />',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 10 },
  });

  assert.equal(result.stop_reason, 'tool_use');
  const tool = result.content.find(b => b.type === 'tool_use');
  assert.equal(tool.name, 'browser');
  assert.deepEqual(tool.input, { action: 'navigate', url: 'https://www.ynet.co.il' });
});

test('oai compat recovers XML tool call accidentally placed in function arguments', () => {
  const result = fromOAIResponse({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'browser',
            arguments: '<tool_call name="browser" arguments=\'{"action":"navigate","url":"https://www.reddit.com"}\' />',
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 10 },
  });

  assert.equal(result.stop_reason, 'tool_use');
  const tool = result.content.find(b => b.type === 'tool_use');
  assert.equal(tool.name, 'browser');
  assert.deepEqual(tool.input, { action: 'navigate', url: 'https://www.reddit.com' });
});
