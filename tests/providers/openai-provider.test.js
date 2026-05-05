'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const openaiProvider = require('../../plugins/openai-provider');

const {
  isOpenAIChatModel,
  isOpenAIReasoningModel,
  withOpenAIModelMetadata,
  normalizeOpenAIModelFamily,
  parseOpenAIContextLimitFromError,
  isOpenAIChatUnsupportedError,
  isOpenAIResponsesUnsupportedError,
  selectOpenAIContextProbeTargets,
  applyOpenAIContextProbeResults,
  toOpenAIResponsesRequest,
  fromOpenAIResponsesPayload,
  OpenAIResponsesClient,
} = openaiProvider._test;

test('openai model metadata ignores bogus tiny discovered context windows', () => {
  const model = withOpenAIModelMetadata({}, {
    id: 'gpt-4.1-mini-2025-04-14',
    contextLength: 128,
    maxOutput: 128,
  });

  assert.equal(model.contextLength, null);
  assert.equal(model.maxOutput, undefined);
  assert.equal(model.family, 'gpt');
  assert.equal(model.capabilities.tools, true);
});

test('openai model metadata keeps larger discovered context when present', () => {
  const model = withOpenAIModelMetadata({}, {
    id: 'gpt-4o-2026-01-01',
    contextLength: 256000,
    maxOutput: 32000,
  });

  assert.equal(model.contextLength, 256000);
  assert.equal(model.maxOutput, 32000);
});

test('openai model metadata drops non-chat assets and suspicious unknown limits', () => {
  assert.equal(isOpenAIChatModel('text-embedding-3-large'), false);
  assert.equal(isOpenAIChatModel('gpt-4o-realtime-preview'), false);
  assert.equal(isOpenAIChatModel('gpt-5.2-codex'), false);
  assert.equal(withOpenAIModelMetadata({}, { id: 'text-embedding-3-large', contextLength: 8192 }), null);

  const unknown = withOpenAIModelMetadata({}, { id: 'gpt-future-chat', contextLength: 128 });
  assert.equal(unknown.contextLength, null);
});

test('openai context limit parser accepts current and legacy overflow errors', () => {
  assert.equal(
    parseOpenAIContextLimitFromError('Input tokens exceed the configured limit of 922000 tokens. Your messages resulted in 1200007 tokens.'),
    922000,
  );
  assert.equal(
    parseOpenAIContextLimitFromError("This model's maximum context length is 128,000 tokens. However, your messages resulted in 129000 tokens."),
    128000,
  );
  assert.equal(parseOpenAIContextLimitFromError('Please reduce the length of the messages.'), null);
  assert.equal(
    isOpenAIChatUnsupportedError('This is not a chat model and thus not supported in the v1/chat/completions endpoint.'),
    true,
  );
  assert.equal(
    isOpenAIChatUnsupportedError('This model is only supported in v1/responses and not in v1/chat/completions.'),
    true,
  );
  assert.equal(
    isOpenAIResponsesUnsupportedError('This model is not supported in the v1/responses endpoint.'),
    true,
  );
  assert.equal(isOpenAIChatUnsupportedError('Input tokens exceed the configured limit of 922000 tokens.'), false);
});

test('openai reasoning effort only applies to native reasoning model families', () => {
  assert.equal(isOpenAIReasoningModel('openai/gpt-5.5'), true);
  assert.equal(isOpenAIReasoningModel('gpt-5.4-mini'), true);
  assert.equal(isOpenAIReasoningModel('openai/o4-mini'), true);
  assert.equal(isOpenAIReasoningModel('openai/gpt-4o'), false);
});

test('openai context probe targets cover missing native families without probing every snapshot', () => {
  assert.equal(normalizeOpenAIModelFamily('gpt-5.5-2026-05-01'), 'gpt-5.5');
  assert.equal(normalizeOpenAIModelFamily('gpt-5.4-pro'), 'gpt-5.4-pro');
  assert.equal(normalizeOpenAIModelFamily('gpt-3.5-turbo-0125'), 'gpt-3.5-turbo');

  const targets = selectOpenAIContextProbeTargets([
    { id: 'gpt-5.5-2026-05-01', contextLength: null },
    { id: 'gpt-5.5', contextLength: null },
    { id: 'gpt-5.4-pro-2026-04-20', contextLength: null },
    { id: 'gpt-5.4-pro', contextLength: null },
    { id: 'gpt-4.1', contextLength: null },
    { id: 'gpt-4o-2024-08-06', contextLength: null },
    { id: 'gpt-4o', contextLength: null },
    { id: 'gpt-5.4-mini', contextLength: 512000 },
  ]);

  assert.deepEqual(targets, [
    { family: 'gpt-4.1', modelId: 'gpt-4.1' },
    { family: 'gpt-4o', modelId: 'gpt-4o' },
    { family: 'gpt-5.4-pro', modelId: 'gpt-5.4-pro' },
    { family: 'gpt-5.5', modelId: 'gpt-5.5' },
  ]);
});

test('openai context probe results fill every model in the same family', () => {
  const models = applyOpenAIContextProbeResults([
    { id: 'gpt-5.5', contextLength: null },
    { id: 'gpt-5.5-2026-05-01', contextLength: null },
    { id: 'gpt-5.5-pro', contextLength: null },
    { id: 'gpt-5.4-mini', contextLength: 512000 },
    { id: 'gpt-4.1', contextLength: null },
  ], new Map([
    ['gpt-5.5', { contextLength: 922000, chatSupported: true }],
    ['gpt-5.5-pro', { contextLength: null, chatSupported: false }],
    ['gpt-5.4-mini', 900000],
    ['gpt-4.1', { contextLength: 1000000, responsesSupported: true }],
  ]));

  assert.equal(models[0].contextLength, 922000);
  assert.equal(models[0].contextSource, 'openai-overflow-probe');
  assert.equal(models[1].contextLength, 922000);
  assert.equal(models.some(m => m.id === 'gpt-5.5-pro'), false);
  assert.equal(models[2].contextLength, 512000);
  assert.equal(models[2].contextSource, undefined);
  assert.equal(models[3].contextLength, 1000000);
  assert.equal(models[3].contextSource, 'openai-overflow-probe');
});

test('openai native responses request converts tools and forced tool choice', () => {
  const req = toOpenAIResponsesRequest({
    model: 'openai/gpt-5.5',
    system: [{ type: 'text', text: 'You are concise.' }],
    max_tokens: 1234,
    reasoning: { effort: 'low' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Open Reddit.' }] }],
    tools: [{
      name: 'browser',
      description: 'Use the browser',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          url: { type: 'string' },
          loose_list: { type: 'array', description: 'A plugin-provided array schema without items.' },
          nested: {
            type: 'object',
            properties: {
              values: { type: 'array' },
            },
          },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'browser' },
  }, { stream: true });

  assert.equal(req.model, 'gpt-5.5');
  assert.equal(req.instructions, 'You are concise.');
  assert.equal(req.max_output_tokens, 1234);
  assert.equal(req.stream, true);
  assert.deepEqual(req.reasoning, { effort: 'low' });
  assert.deepEqual(req.tool_choice, { type: 'function', name: 'browser' });
  assert.equal(req.tools[0].type, 'function');
  assert.equal(req.tools[0].name, 'browser');
  assert.deepEqual(req.tools[0].parameters.properties.loose_list.items, {});
  assert.deepEqual(req.tools[0].parameters.properties.nested.properties.values.items, {});
  assert.equal(req.messages, undefined);
  assert.equal(req.input[0].type, 'message');
  assert.equal(req.input[0].content[0].type, 'input_text');
});

test('openai native responses payload maps function calls to tool_use blocks', () => {
  const result = fromOpenAIResponsesPayload({
    status: 'completed',
    output: [{
      type: 'function_call',
      call_id: 'call_123',
      name: 'browser',
      arguments: '{"action":"navigate","url":"https://reddit.com"}',
    }],
    usage: { input_tokens: 10, output_tokens: 2 },
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'call_123',
    name: 'browser',
    input: { action: 'navigate', url: 'https://reddit.com' },
  }]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
});

test('openai native responses stream maps function-call SSE to tool_use', async () => {
  const oldFetch = global.fetch;
  const events = [];
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'browser' });

    const encoder = new TextEncoder();
    const event = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
    const chunks = [
      event({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'browser', arguments: '' },
      }),
      event({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"action":',
      }),
      event({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '"navigate"}',
      }),
      event({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        name: 'browser',
        arguments: '{"action":"navigate"}',
      }),
      event({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'browser',
          arguments: '{"action":"navigate"}',
        },
      }),
      event({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 1 } },
      }),
    ];
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    };
  };

  try {
    const client = new OpenAIResponsesClient({ apiKey: 'sk-test' });
    const stream = client.messages.stream({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'browse' }],
      tools: [{ name: 'browser', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'browser' },
    });
    stream.on('event', event => events.push(event));
    const result = await stream.finalMessage();

    assert.equal(result.stop_reason, 'tool_use');
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 1 });
    assert.deepEqual(result.content, [{
      type: 'tool_use',
      id: 'call_1',
      name: 'browser',
      input: { action: 'navigate' },
    }]);
    assert.equal(events.some(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'), true);
    assert.equal(events.some(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta'), true);
  } finally {
    global.fetch = oldFetch;
  }
});
