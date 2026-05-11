'use strict';

const { EventEmitter } = require('node:events');

const { AgentLoop } = require('../../src/agent/loop');
const { SessionManager } = require('../../src/agent/sessions');

function makeLogger() {
  const entries = [];
  const push = (level, args) => {
    entries.push({
      level,
      text: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
      args,
    });
  };
  return {
    entries,
    debug(...args) { push('debug', args); },
    info(...args) { push('info', args); },
    warn(...args) { push('warn', args); },
    error(...args) { push('error', args); },
  };
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function textResponse(text, patch = {}) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...patch,
  };
}

function toolResponse(name, input = {}, opts = {}) {
  const content = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  content.push({
    type: 'tool_use',
    id: opts.id || `toolu_${name}_1`,
    name,
    input,
  });
  return {
    content,
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...opts.patch,
  };
}

function normalizeResponse(response) {
  if (typeof response === 'string') return textResponse(response);
  if (Array.isArray(response)) {
    return { content: response, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  }
  if (response && typeof response === 'object') {
    return {
      stop_reason: response.stop_reason || 'end_turn',
      usage: response.usage || { input_tokens: 1, output_tokens: 1 },
      content: Array.isArray(response.content) ? response.content : [{ type: 'text', text: String(response.text || '') }],
      ...response,
    };
  }
  return textResponse('');
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map(block => {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_use') return `[tool_use ${block.name || ''} ${JSON.stringify(block.input || {})}]`;
    if (block.type === 'tool_result') return `[tool_result ${block.tool_use_id || ''} ${block.content || ''}]`;
    return block.text || block.content || JSON.stringify(block);
  }).filter(Boolean).join('\n');
}

function systemText(request) {
  const sys = request?.system;
  if (Array.isArray(sys)) return sys.map(block => block?.text || '').join('\n');
  return typeof sys === 'string' ? sys : '';
}

function messagesText(request) {
  return (request?.messages || [])
    .map(msg => `${msg.role}: ${contentToText(msg.content)}`)
    .join('\n');
}

function requestText(request) {
  return [systemText(request), messagesText(request)].filter(Boolean).join('\n\n');
}

class ScriptedStream extends EventEmitter {
  constructor(resolveResponse) {
    super();
    this._resolveResponse = resolveResponse;
    this._aborted = false;
  }

  abort() {
    this._aborted = true;
    this.emit('end');
  }

  async finalMessage() {
    if (this._aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const response = await this._resolveResponse();
    for (const block of response.content || []) {
      if (this._aborted) break;
      if (block.type === 'text') {
        this.emit('event', { type: 'content_block_start', content_block: { type: 'text' } });
        this.emit('text', block.text || '');
        this.emit('event', { type: 'content_block_stop' });
      } else if (block.type === 'tool_use') {
        this.emit('event', { type: 'content_block_start', content_block: block });
        this.emit('event', { type: 'content_block_stop' });
      }
    }
    this.emit('end');
    return response;
  }
}

class ScriptedModelClient {
  constructor(script = []) {
    this.script = Array.isArray(script) ? [...script] : [script];
    this.requests = [];
    this.calls = [];
    this.messages = {
      create: this.create.bind(this),
      stream: this.stream.bind(this),
    };
  }

  resolveModel(req = {}) {
    return req.model;
  }

  resolveRequest(req = {}) {
    return req;
  }

  async _next(request) {
    const index = this.calls.length;
    const entry = this.script.length > index
      ? this.script[index]
      : this.script[this.script.length - 1];
    this.calls.push({ index, request });
    if (typeof entry === 'function') {
      return normalizeResponse(await entry(request, { model: this, index }));
    }
    return normalizeResponse(entry);
  }

  async create(request) {
    const snapshot = cloneJson(request);
    this.requests.push(snapshot);
    return this._next(snapshot);
  }

  stream(request) {
    const snapshot = cloneJson(request);
    this.requests.push(snapshot);
    return new ScriptedStream(() => this._next(snapshot));
  }
}

class MemorySessionStore {
  constructor(config = {}) {
    this.config = { maxSessionMessages: 200, ...config };
    this.messages = new Map();
    this.metadata = new Map();
  }

  static buildKey(...args) {
    return SessionManager.buildKey(...args);
  }

  ensureSession(key) {
    if (!this.messages.has(key)) this.messages.set(key, []);
    if (!this.metadata.has(key)) this.metadata.set(key, {});
  }

  addMessage(key, role, content) {
    this.ensureSession(key);
    const rows = this.messages.get(key);
    rows.push({ role, content: cloneJson(content) ?? content });
    const excess = rows.length - (this.config.maxSessionMessages || 200);
    if (excess > 0) rows.splice(0, excess);
  }

  getHistory(key, limit = null) {
    const rows = this.messages.get(key) || [];
    const slice = limit ? rows.slice(-limit) : rows;
    return cloneJson(slice);
  }

  clearSession(key) {
    this.messages.set(key, []);
  }

  setMessages(key, messages) {
    this.messages.set(key, cloneJson(messages || []));
  }

  truncateConsumedToolResults() {
    return 0;
  }

  getMessageCount(key) {
    return (this.messages.get(key) || []).length;
  }

  getSessionMeta(key) {
    return { key, metadata: this.metadata.get(key) || {}, messageCount: this.getMessageCount(key) };
  }

  setSessionMeta(key, metadata) {
    this.metadata.set(key, cloneJson(metadata || {}));
  }
}

class StaticGraph {
  constructor(prompt = 'You are a test agent.') {
    this.prompt = prompt;
    this.promptCalls = [];
  }

  async buildSystemPromptAsync(opts = {}) {
    this.promptCalls.push(cloneJson(opts));
    return typeof this.prompt === 'function' ? this.prompt(opts) : this.prompt;
  }

  buildSystemPrompt(opts = {}) {
    this.promptCalls.push(cloneJson(opts));
    return typeof this.prompt === 'function' ? this.prompt(opts) : this.prompt;
  }

  buildStaticPrompt() {
    return '';
  }
}

class HarnessTools {
  constructor(opts = {}) {
    this.toolDefs = opts.toolDefs || opts.tools || ['graph_query'];
    this.toolResults = opts.toolResults || {};
    this.calls = [];
    this._sessionContexts = new Map();
    this._pluginManager = opts.pluginManager || null;
    this._graphRegistry = opts.graphRegistry || null;
    this.gateway = opts.gateway || { getWebappStatus: () => null };
  }

  getToolDefinitions(opts = {}) {
    const defs = typeof this.toolDefs === 'function' ? this.toolDefs(opts) : this.toolDefs;
    return (defs || []).map(def => {
      if (typeof def === 'string') return { name: def, description: `${def} test tool`, input_schema: { type: 'object', properties: {} } };
      return { input_schema: { type: 'object', properties: {} }, ...def };
    });
  }

  async executeTool(name, input, ctx = {}) {
    this.calls.push({ name, input: cloneJson(input), ctx: cloneJson(ctx) });
    const handler = this.toolResults[name];
    if (typeof handler === 'function') return handler(input, ctx, this.calls);
    if (handler !== undefined) return cloneJson(handler);
    return { ok: true, tool: name, input };
  }

  planModeBlockForTool() {
    return null;
  }

  workflowBlockForTool(name, input, ctx = {}) {
    const sessionKey = ctx?.sessionKey || null;
    if (!sessionKey || !this._workflow?.toolBlockForTool) return null;
    return this._workflow.toolBlockForTool(sessionKey, name, input);
  }

  killSessionLogWatches() {}
  cancelSessionAskUser() {}
  listPendingQuestions() { return []; }
}

function createChatFlowHarness(opts = {}) {
  const logger = opts.logger || makeLogger();
  const graph = opts.graph || new StaticGraph(opts.prompt);
  const sessions = opts.sessions || new MemorySessionStore(opts.sessionConfig);
  const model = opts.model || new ScriptedModelClient(opts.script || [textResponse('ok')]);
  const tools = opts.toolsHost || new HarnessTools({
    tools: opts.tools,
    toolDefs: opts.toolDefs,
    toolResults: opts.toolResults,
    pluginManager: opts.pluginManager,
    graphRegistry: opts.graphRegistry,
    gateway: opts.gateway,
  });
  const config = {
    model: 'test-model',
    plannerModel: 'test-model',
    maxTokens: 1024,
    maxSessionMessages: 200,
    nonStreamToolTurns: true,
    learningMode: 'disabled',
    loopDetection: { ceiling: 12, warn: 5, critical: 10, budgetPressure: 8 },
    ...opts.config,
  };
  const agent = new AgentLoop(config, logger, graph, sessions, tools, opts.learner || null);
  agent.client = model;
  if (opts.pluginManager) {
    agent._pluginManager = opts.pluginManager;
    graph._pluginManager = opts.pluginManager;
  }

  async function send(content, turnOpts = {}) {
    const events = {
      textDeltas: [],
      intermediateTexts: [],
      status: [],
      toolUses: [],
      completions: [],
      errors: [],
    };
    const baseOpts = {
      content,
      channelId: 'test-channel',
      channelName: 'test',
      userId: 'test-user',
      userName: 'Test User',
      userRole: 'webapp',
      platform: 'web',
      trigger: 'mention',
      isDm: true,
      suppressLearning: true,
      ...turnOpts,
    };
    const result = await agent.processMessage({
      ...baseOpts,
      onTextDelta(text) { events.textDeltas.push(text); turnOpts.onTextDelta?.(text); },
      onIntermediateText(text) { events.intermediateTexts.push(text); turnOpts.onIntermediateText?.(text); },
      onStatus(status) { events.status.push(status); turnOpts.onStatus?.(status); },
      onToolUse(name, input) { events.toolUses.push({ name, input }); turnOpts.onToolUse?.(name, input); },
      onComplete(text, usage, meta) { events.completions.push({ text, usage, meta }); turnOpts.onComplete?.(text, usage, meta); },
      onError(error) { events.errors.push(error); turnOpts.onError?.(error); },
    });
    return {
      result,
      events,
      text: result?.text,
      sessionKey: result?.sessionKey || baseOpts.sessionKey,
      modelRequests: model.requests,
      toolCalls: tools.calls,
      history: sessions.getHistory(result?.sessionKey || baseOpts.sessionKey, 500),
    };
  }

  async function runFlow(steps = []) {
    const turns = [];
    for (const step of steps) {
      const turn = await send(step.user ?? step.content ?? '', step.opts || {});
      turns.push(turn);
      if (step.assert) await step.assert(turn, api);
    }
    return turns;
  }

  const api = {
    agent,
    graph,
    sessions,
    tools,
    model,
    logger,
    send,
    runFlow,
    requestText,
    systemText,
    messagesText,
    contentToText,
    textResponse,
    toolResponse,
  };
  return api;
}

module.exports = {
  createChatFlowHarness,
  HarnessTools,
  MemorySessionStore,
  ScriptedModelClient,
  StaticGraph,
  contentToText,
  makeLogger,
  messagesText,
  requestText,
  systemText,
  textResponse,
  toolResponse,
};
