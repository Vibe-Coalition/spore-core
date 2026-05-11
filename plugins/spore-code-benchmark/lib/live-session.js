'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function truncate(value, max = 2000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value || {});
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

function toWsUrl(baseUrl, token) {
  const u = new URL(baseUrl || 'http://127.0.0.1:18803');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = `?token=${encodeURIComponent(token)}`;
  return u.toString();
}

function loadWebSocket() {
  try {
    return require('ws');
  } catch (e) {
    throw new Error('The ws package is required to run live Spore Code benchmarks');
  }
}

class LiveSporeCodeSession {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.sessionId = opts.sessionId || `scb:${crypto.randomBytes(8).toString('hex')}`;
    this.cwd = opts.cwd;
    this.userName = opts.userName || 'benchmark';
    this.projectContext = opts.projectContext || {};
    this.localTools = opts.localTools || [];
    this.toolExecutor = opts.toolExecutor;
    this.askUserResponder = opts.askUserResponder || null;
    this.log = opts.log || null;
    this.turnTimeoutMs = Math.max(5000, Number(opts.turnTimeoutMs) || 20 * 60 * 1000);
    this.ws = null;
    this.transcript = [];
    this.events = [];
    this.toolCalls = [];
    this.workflowEvents = [];
    this.latestWorkflow = null;
    this._answeredAskUser = new Set();
    this._pendingTurn = null;
    this._closed = false;
  }

  record(type, data = {}) {
    const evt = { ts: nowIso(), type, ...data };
    this.events.push(evt);
    if (['user', 'assistant', 'thinking', 'status', 'tool', 'error'].includes(type)) {
      const last = this.transcript[this.transcript.length - 1];
      const canCoalesce =
        last
        && last.type === type
        && typeof last.text === 'string'
        && typeof evt.text === 'string'
        && (
          type === 'thinking'
          || (type === 'assistant' && last.delta && evt.delta)
        );
      if (canCoalesce) {
        last.text += evt.text;
        last.ts = evt.ts;
        return evt;
      }
      this.transcript.push(evt);
    }
    return evt;
  }

  async connect() {
    if (!this.token) throw new Error('LiveSporeCodeSession requires a websocket token');
    const WebSocket = loadWebSocket();
    const url = toWsUrl(this.baseUrl, this.token);
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 15000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        this.ws.on('message', raw => this._handleMessage(raw));
        this.ws.on('close', () => this._handleClose());
        this.ws.on('error', e => this.record('error', { message: e.message }));
        resolve();
      });
      this.ws.once('error', e => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this.record('status', { status: 'connected', sessionId: this.sessionId });
  }

  startSession() {
    this.send({
      type: 'session:start',
      sessionId: this.sessionId,
      cwd: this.cwd,
      userName: this.userName,
      startedAt: Date.now(),
      clientVersion: 'spore-code-benchmark/1.0.0',
      localTools: this.localTools,
      projectContext: {
        ...this.projectContext,
        cwd: this.cwd,
        localTools: this.localTools,
      },
    });
    this.record('status', { status: 'session:start', sessionId: this.sessionId });
  }

  async sendChat(content, opts = {}) {
    if (this._pendingTurn) throw new Error('A chat turn is already pending for this session');
    const text = String(content || '');
    this.record('user', { text });
    this.send({
      type: 'chat',
      sessionId: this.sessionId,
      content: text,
      displayText: opts.displayText || text,
      userName: this.userName,
      cwd: this.cwd,
      projectContext: {
        ...this.projectContext,
        mode: opts.mode || this.projectContext.mode || 'execute',
        cwd: this.cwd,
        localTools: this.localTools,
      },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingTurn = null;
        reject(new Error(`chat turn timed out after ${this.turnTimeoutMs}ms`));
      }, this.turnTimeoutMs);
      this._pendingTurn = { resolve, reject, timer };
    });
  }

  async close(graceful = true) {
    this._closed = true;
    if (!this.ws) return;
    try {
      if (graceful && this.ws.readyState === 1) {
        this.send({ type: 'session:end', sessionId: this.sessionId, endedAt: Date.now() });
      }
    } catch {}
    try { this.ws.close(); } catch {}
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('websocket is not open');
    this.ws.send(JSON.stringify(payload));
  }

  _finishTurn(result, isError = false) {
    const pending = this._pendingTurn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingTurn = null;
    if (isError) pending.reject(result instanceof Error ? result : new Error(String(result?.error || result || 'chat error')));
    else pending.resolve(result);
  }

  _handleClose() {
    this.record('status', { status: 'closed' });
    if (!this._closed && this._pendingTurn) {
      this._finishTurn(new Error('websocket closed during chat turn'), true);
    }
  }

  async _handleToolRequest(msg) {
    const tool = {
      id: msg.id,
      name: msg.name,
      input: msg.input || {},
      inputText: truncate(msg.input || {}, 4000),
      startedAt: nowIso(),
    };
    this.toolCalls.push(tool);
    this.record('tool', { name: msg.name, id: msg.id, input: tool.inputText });
    try { this.send({ type: 'tool:ack', id: msg.id }); } catch {}
    let result;
    try {
      if (!this.toolExecutor) throw new Error('No benchmark local tool executor is configured');
      result = await this.toolExecutor.execute(msg.name, msg.input || {});
    } catch (e) {
      result = { error: e.message };
    }
    tool.finishedAt = nowIso();
    tool.resultSummary = truncate(result, 3000);
    try {
      this.send({ type: 'tool:result', id: msg.id, result });
    } catch (e) {
      this.record('error', { message: `failed to send tool result: ${e.message}` });
    }
  }

  _maybeAnswerAskUser(msg) {
    const qid = msg.qid;
    if (!qid || this._answeredAskUser.has(qid)) return;
    this._answeredAskUser.add(qid);
    const options = Array.isArray(msg.options) ? msg.options.map(o => String(o?.label || '').trim()).filter(Boolean) : [];
    const mode = String(msg.mode || (options.length ? (msg.multi ? 'multi' : 'single') : 'open')).toLowerCase();
    const fallback = mode === 'open'
      ? 'Make the most conservative reasonable assumption and continue.'
      : (mode === 'multi' ? options.slice(0, 2).join(', ') : options[0]) || 'Make the most conservative reasonable assumption and continue.';
    Promise.resolve()
      .then(() => this.askUserResponder ? this.askUserResponder(msg) : fallback)
      .then(answer => {
        const text = String(answer || fallback).trim() || fallback;
        try {
          this.send({ type: 'ask_user_answer', qid, answer: text });
          this.record('status', { status: 'ask_user:auto_answered', qid, text });
        } catch (e) {
          this.record('error', { message: `failed to answer ask_user prompt: ${e.message}` });
        }
      })
      .catch(e => {
        try {
          this.send({ type: 'ask_user_answer', qid, answer: fallback });
          this.record('status', { status: 'ask_user:auto_answered', qid, text: fallback, error: e.message });
        } catch (sendErr) {
          this.record('error', { message: `failed to answer ask_user prompt: ${sendErr.message}` });
        }
      });
  }

  _recordWorkflow(msg = {}) {
    const workflow = msg.workflow || null;
    if (!workflow) return;
    this.latestWorkflow = workflow;
    this.workflowEvents.push({ ts: nowIso(), workflow });
    this.record('status', {
      status: 'workflow:update',
      text: truncate({
        phase: workflow.phase,
        status: workflow.status,
        tasks: workflow.tasks,
        evidenceCount: workflow.evidenceCount,
      }, 1000),
    });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    this.events.push({ ts: nowIso(), rawType: msg.type, message: truncate(msg, 2000) });
    switch (msg.type) {
      case 'capabilities':
        this.record('status', { status: 'capabilities', text: truncate(msg, 600) });
        break;
      case 'chat:start':
        this.record('status', { status: 'chat:start' });
        break;
      case 'chat:delta':
        if (msg.text) this.record('assistant', { delta: true, text: msg.text });
        break;
      case 'chat:thinking':
        if (msg.text) this.record('thinking', { delta: true, text: msg.text });
        break;
      case 'chat:tool':
        this.record('status', { status: 'chat:tool', tool: msg.tool });
        break;
      case 'chat:status':
        this.record('status', { status: msg.status || 'chat:status', text: truncate(msg, 1000) });
        if (msg.status === 'workflow:update') this._recordWorkflow(msg);
        if (msg.status === 'ask_user_waiting') this._maybeAnswerAskUser(msg);
        break;
      case 'workflow:update':
        this._recordWorkflow(msg);
        break;
      case 'ask_user':
        this.record('status', { status: 'ask_user:prompt', qid: msg.qid, text: truncate(msg, 1000) });
        this._maybeAnswerAskUser(msg);
        break;
      case 'tool:pending':
        this.record('status', { status: 'tool:pending', tool: msg.name, text: msg.summary || '' });
        break;
      case 'tool:resolved':
        this.record('status', { status: 'tool:resolved', toolId: msg.id, denied: !!msg.denied });
        break;
      case 'tool:request':
        this._handleToolRequest(msg);
        break;
      case 'chat:done':
        this.record('assistant', { final: true, text: msg.text || '' });
	        this._finishTurn({
	          text: msg.text || '',
	          usage: msg.usage || null,
	          iterations: msg.iterations || 0,
	          toolUsage: msg.toolUsage || {},
	          responseRepair: msg.responseRepair || null,
	          workflow: this.latestWorkflow,
	        });
        break;
      case 'chat:error':
        this.record('error', { message: msg.error || 'chat error' });
        this._finishTurn(new Error(msg.error || 'chat error'), true);
        break;
      case 'auth:error':
        this.record('error', { message: msg.error || 'auth error', code: msg.code });
        this._finishTurn(new Error(msg.error || 'auth error'), true);
        break;
      default:
        break;
    }
  }
}

module.exports = {
  LiveSporeCodeSession,
  _test: {
    toWsUrl,
    truncate,
  },
};
