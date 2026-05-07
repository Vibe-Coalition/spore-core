// chat.js — REST helpers, WebSocket connection, ask_user picker, plan-mode UI,
// subagent activity, browser live preview, notification toasts, canvas tab system.
// Extracted from src/static/scripts/app.js (was lines 3870-5914 of the post-Phase-2 monolith).

// ── REST API helpers ──
function graphApiUrl(path) {
  const slug = typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug ? String(_viewedGraphSlug) : '';
  const meta = typeof _viewedGraphMeta !== 'undefined' ? _viewedGraphMeta : null;
  if (meta?.active === true) return API + path;
  if (!slug) return API + path;
  const sep = path.includes('?') ? '&' : '?';
  return API + path + sep + 'scopeGraph=' + encodeURIComponent(slug);
}

async function fetchGraph(opts = {}) {
  const explicitSlug = opts?.slug ? String(opts.slug) : null;
  const preserveViewed = opts?.preserveViewed !== false;
  const viewedSlug = preserveViewed && typeof _viewedGraphSlug !== 'undefined' ? _viewedGraphSlug : null;
  const slug = explicitSlug || viewedSlug;
  const state = window._graphViewState || {};
  const mode = opts.mode || state.mode || 'auto';
  const params = new URLSearchParams();
  params.set('mode', mode);
  const root = opts.root || state.root || '';
  if (mode === 'slice' && root) params.set('root', root);
  if (opts.nodeLimit) params.set('nodeLimit', String(opts.nodeLimit));
  if (opts.edgeLimit) params.set('edgeLimit', String(opts.edgeLimit));
  if (opts.details) params.set('details', String(opts.details));
  const path = '/api/graph?' + params.toString();
  const url = explicitSlug
    ? `/api/graphs/${encodeURIComponent(explicitSlug)}/data?${params.toString()}`
    : (slug ? graphApiUrl(path) : API + path);
  const res = await fetch(explicitSlug ? API + url : url);
  const data = await res.json();
  if (data?.graph && typeof _setViewedGraph === 'function') {
    _setViewedGraph(data, slug);
  }
  return data;
}

async function saveNode(data) {
  const res = await fetch(graphApiUrl('/api/graph/node'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteNode(id) {
  const res = await fetch(graphApiUrl('/api/graph/node/' + encodeURIComponent(id)), { method: 'DELETE' });
  return res.json();
}

async function saveAspect(data) {
  const res = await fetch(graphApiUrl('/api/graph/aspect'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteAspect(id) {
  const res = await fetch(graphApiUrl('/api/graph/aspect/' + id), { method: 'DELETE' });
  return res.json();
}

async function updateAttribute(id, data) {
  const res = await fetch(graphApiUrl('/api/graph/attribute/' + id), { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteAttribute(id) {
  const res = await fetch(graphApiUrl('/api/graph/attribute/' + id), { method: 'DELETE' });
  return res.json();
}

async function saveEdge(data) {
  const res = await fetch(graphApiUrl('/api/graph/edge'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteEdge(data) {
  const res = await fetch(graphApiUrl('/api/graph/edge'), { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

// ── WebSocket Connection ──
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
const WS_RECONNECT_MIN = 1000;
const WS_RECONNECT_MAX = 30000;
let chatBusy = false;
let _chatStopped = false;
let streamingMsgEl = null;
let streamChunks = [];
let _streamDelta = '';
let _thinkingDelta = '';

function setChatBusy(busy) {
  chatBusy = busy;
  if (busy) _chatStopped = false;
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');
  sendBtn.textContent = 'send';
  sendBtn.style.display = '';
  stopBtn.style.display = busy ? '' : 'none';
  if (busy) _sporeActivityStart('chat');
  else {
    _sporeActivityEnd('chat');
    _chatLastDoneAt = Date.now();   // mid-flight straggler guard for the heuristic
  }
}
let _userWasAtBottom = true;

async function getWsUrl() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${loc.host}${API}`;
  // Always refresh from /api/ws-token so we use the CURRENT cookie session,
  // not a stale cached token from a previous user on this tab.
  try {
    const res = await fetch(API + '/api/ws-token', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        window._wsAuth = data.token;
        return `${base}/ws?token=${encodeURIComponent(data.token)}`;
      }
    }
  } catch {}
  // No valid session-cookie → drop any cached token and connect anonymously.
  // The chat handler will refuse anonymous messages and reload to login.
  window._wsAuth = null;
  return `${base}/ws`;
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const jitter = Math.random() * wsReconnectDelay * 0.3;
  const delay = Math.min(wsReconnectDelay + jitter, WS_RECONNECT_MAX);
  wsReconnectTimer = setTimeout(connectWs, delay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
}

async function connectWs() {
  wsReconnectTimer = null;
  if (ws && ws.readyState <= 1) return;
  const statusEl = document.getElementById('ws-status');
  statusEl.className = 'connecting'; statusEl.title = 'Connecting…';

  try {
    const url = await getWsUrl();
    ws = new WebSocket(url);
    window._ws = ws;
  } catch (e) {
    statusEl.className = 'disconnected'; statusEl.title = 'Connection error';
    scheduleReconnect();
    return;
  }

  let _wsPingTimer = null;
  let _wsLastPong = Date.now();

  ws.onopen = () => {
    statusEl.className = 'connected'; statusEl.title = 'Connected';
    document.getElementById('chat-send').disabled = false;
    wsReconnectDelay = WS_RECONNECT_MIN;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (!agentNames.length) loadAgentIdentity();
    _wsLastPong = Date.now();
    if (_wsPingTimer) clearInterval(_wsPingTimer);
    _wsPingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - _wsLastPong > 45000) {
        console.warn('[ws] No pong in 45s — forcing reconnect');
        try { ws.close(); } catch {}
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }, 15000);
    try { ws.send(JSON.stringify({ type: 'terminal:hosts:list' })); } catch {}
    if (window._reconnectTerminals) window._reconnectTerminals();
  };

  ws.onclose = () => {
    statusEl.className = 'disconnected'; statusEl.title = 'Disconnected';
    document.getElementById('chat-send').disabled = true;
    if (_wsPingTimer) { clearInterval(_wsPingTimer); _wsPingTimer = null; }
    scheduleReconnect();
  };

  ws.onerror = () => {
    statusEl.className = 'disconnected'; statusEl.title = 'Connection error';
  };

  ws.binaryType = 'arraybuffer';
  ws.onmessage = (evt) => {
    _wsLastPong = Date.now();
    if (evt.data instanceof ArrayBuffer) {
      handleBrowserFrame(evt.data);
      return;
    }
    if (evt.data instanceof Blob) {
      evt.data.arrayBuffer().then(buf => handleBrowserFrame(buf)).catch(() => {});
      return;
    }
    let msg;
    try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data)); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'browser:open' || msg.type === 'browser:closed') {
      handleBrowserControl(msg);
      return;
    }
    if (msg.type && msg.type.startsWith('code:')) {
      try {
        handleCodeEvent(msg);
      } catch (e) {
        console.warn('[code-viewer] event failed', e);
      }
      return;
    }
    if (msg.type === 'notification') {
      showNotification(msg);
      return;
    }
    handleWsMessage(msg);
  };
}

let _chatToolCount = 0;
let _chatToolGroupEl = null;
let _chatToolGroupBody = null;
let _chatToolEvents = [];
let _chatToolActiveEvent = null;

function setActivity(text) {
  const bar = document.getElementById('agent-activity');
  const label = document.getElementById('activity-text');
  if (typeof window.setEventLogStatus === 'function') {
    window.setEventLogStatus(text ? { op: 'chat', detail: text, source: 'agent' } : null);
  }
  // Legacy DOM node kept for older markup/mobile shell code, but the live
  // activity now belongs in the dock event log so it never steals vertical
  // space from the latest chat text/tool output.
  if (!bar) return;
  if (label) label.textContent = text || '';
  bar.title = text || '';
  bar.classList.remove('active');
  bar.setAttribute('aria-hidden', 'true');
}

function chatShouldAutoScroll() {
  const c = document.getElementById('chat-messages');
  if (!c) return true;
  return (c.scrollHeight - c.scrollTop - c.clientHeight) < 80;
}

function chatScrollToBottom() {
  const c = document.getElementById('chat-messages');
  if (c) c.scrollTop = c.scrollHeight;
}

function finalizeStreamingMsg() {
  if (!streamingMsgEl) return;
  streamingMsgEl.classList.remove('streaming');
  if (!_streamDelta) {
    _removeChatBubble(streamingMsgEl);
  } else {
    _syncAssistantRowVisibility(streamingMsgEl);
  }
  streamingMsgEl = null;
}

function _removeChatBubble(el) {
  if (!el) return;
  const row = el.closest?.('.chat-row');
  (row || el).remove();
}

function _chatBubbleHasVisibleContent(el) {
  if (!el) return false;
  if ((el.textContent || '').trim()) return true;
  return !!el.querySelector?.('img,video,audio,canvas,iframe,svg,table,pre,ul,ol,blockquote,.media-grid,.tool-tag,.usage-tag');
}

function _syncAssistantRowVisibility(el) {
  if (!el?.classList?.contains('assistant')) return true;
  const row = el.closest?.('.chat-row');
  const hasContent = _chatBubbleHasVisibleContent(el);
  if (row) row.hidden = !hasContent;
  return hasContent;
}

function _pruneEmptyAssistantRows() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.querySelectorAll('.chat-msg.assistant').forEach(el => {
    if (el === streamingMsgEl || el.classList.contains('streaming')) {
      _syncAssistantRowVisibility(el);
      return;
    }
    if (!_chatBubbleHasVisibleContent(el)) _removeChatBubble(el);
    else _syncAssistantRowVisibility(el);
  });
}

// Lazy-create the streaming assistant bubble. Lets us avoid blank
// bubbles between tool calls — only materializes the bubble when
// there's actual content (thinking / delta / chunk) to put in it.
function _ensureStreamingBubble() {
  if (streamingMsgEl) return streamingMsgEl;
  streamingMsgEl = addChatMessage('assistant', '');
  streamingMsgEl.classList.add('streaming');
  return streamingMsgEl;
}

function _resetToolRunGroup() {
  _chatToolGroupEl = null;
  _chatToolGroupBody = null;
  _chatToolEvents = [];
  _chatToolActiveEvent = null;
}

function _summarizeToolInput(toolInput) {
  let summary = '';
  let raw = '';
  const pick = (value) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed ? trimmed : '';
  };
  if (toolInput && typeof toolInput === 'object') {
    const candidates = ['query', 'q', 'url', 'path', 'command', 'cmd', 'message', 'description', 'task', 'text', 'name'];
    for (const k of candidates) {
      summary = pick(toolInput[k]);
      if (summary) break;
    }
    try { raw = JSON.stringify(toolInput, null, 2); } catch {}
    if (!summary) summary = raw;
  } else if (typeof toolInput === 'string') {
    summary = toolInput.trim();
    raw = summary;
  }
  if (summary.length > 180) summary = summary.slice(0, 177) + '…';
  return { summary, raw };
}

function _toolRunLabel() {
  const counts = new Map();
  for (const ev of _chatToolEvents) {
    const name = ev.name && ev.name !== 'tool' ? ev.name : 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const parts = [...counts.entries()].slice(0, 4).map(([name, count]) => `${name}${count > 1 ? ' ×' + count : ''}`);
  const extra = counts.size > 4 ? ` +${counts.size - 4}` : '';
  return parts.join(' · ') + extra;
}

function _ensureToolRunGroup() {
  const container = document.getElementById('chat-messages');
  if (!container) return null;
  if (_chatToolGroupEl && _chatToolGroupEl.isConnected) return _chatToolGroupEl;

  const details = document.createElement('details');
  details.className = 'chat-tool-run';
  // New assistant runs should expose tool activity by default, but once
  // the user collapses this <details>, later tool events in the same run
  // must not force it open again.
  details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'chat-tool-run-summary';
  summary.innerHTML = `
    <span class="tool-run-kicker">tools</span>
    <span class="tool-run-count">0 calls</span>
    <span class="tool-run-names"></span>
    <span class="tool-run-hint">details</span>
  `;
  const body = document.createElement('div');
  body.className = 'chat-tool-run-body';
  details.appendChild(summary);
  details.appendChild(body);
  container.appendChild(details);
  _chatToolGroupEl = details;
  _chatToolGroupBody = body;
  return details;
}

function _updateToolRunSummary() {
  if (!_chatToolGroupEl) return;
  const total = _chatToolEvents.length;
  const count = _chatToolGroupEl.querySelector('.tool-run-count');
  const names = _chatToolGroupEl.querySelector('.tool-run-names');
  if (count) count.textContent = `${total} call${total === 1 ? '' : 's'}`;
  if (names) names.textContent = _toolRunLabel();
}

function _formatToolStatus(state, meta = {}) {
  if (state === 'running') return 'running';
  if (state === 'done') {
    const ms = Number(meta.durationMs);
    if (Number.isFinite(ms) && ms >= 0) return ms >= 1000 ? `done ${(ms / 1000).toFixed(1)}s` : `done ${ms}ms`;
    return 'done';
  }
  if (state === 'progress') {
    const bytes = Number(meta.bytes) || 0;
    return bytes >= 1024 ? `writing ${Math.round(bytes / 1024)}KB` : `writing ${bytes}B`;
  }
  return 'calling';
}

function _findPendingToolEvent(toolName) {
  const wanted = (toolName || '').trim();
  for (let i = _chatToolEvents.length - 1; i >= 0; i--) {
    const ev = _chatToolEvents[i];
    if (ev.done) continue;
    if (!wanted || !ev.name || ev.name === 'tool' || ev.name === wanted) return ev;
  }
  return null;
}

function _renderToolEvent(ev) {
  if (!ev?.row) return;
  const displayName = ev.name || 'tool';
  const displaySummary = ev.summary || 'preparing arguments...';
  ev.row.classList.toggle('pending', !ev.summary && !ev.done);
  ev.row.classList.toggle('running', ev.state === 'running' || ev.state === 'progress');
  ev.row.classList.toggle('done', !!ev.done);
  if (ev.nameEl) ev.nameEl.textContent = displayName;
  if (ev.inputEl) ev.inputEl.textContent = displaySummary;
  if (ev.statusEl) ev.statusEl.textContent = _formatToolStatus(ev.state, ev);
  if (ev.rawEl) {
    if (ev.raw && ev.raw !== ev.summary && ev.raw.length < 4000) {
      ev.rawEl.textContent = ev.raw;
      ev.rawEl.style.display = '';
    } else {
      ev.rawEl.textContent = '';
      ev.rawEl.style.display = 'none';
    }
  }
}

// Condensed tool run: one collapsible event per assistant run instead of
// one speech-bubble-like card per tool call.
function _recordToolEvent(toolName, toolInput, opts = {}) {
  const container = document.getElementById('chat-messages');
  const group = _ensureToolRunGroup();
  if (!group || !_chatToolGroupBody) return null;

  const state = opts.state || 'calling';
  const name = (toolName || '').trim() || 'tool';
  const { summary, raw } = _summarizeToolInput(toolInput);
  const shouldUpdate = opts.updateLast !== false;
  let ev = shouldUpdate ? _findPendingToolEvent(name) : null;
  if (ev) {
    if (name && name !== 'tool') ev.name = name;
    if (summary) ev.summary = summary;
    if (raw) ev.raw = raw;
    ev.state = state;
    ev.bytes = opts.bytes;
    ev.durationMs = opts.durationMs;
    ev.done = state === 'done';
    _renderToolEvent(ev);
    _chatToolActiveEvent = ev.done ? null : ev;
    _updateToolRunSummary();
    if (chatShouldAutoScroll()) container.scrollTop = container.scrollHeight;
    return group;
  }

  const row = document.createElement('div');
  row.className = 'chat-tool-event';
  const title = document.createElement('div');
  title.className = 'chat-tool-event-title';
  const index = document.createElement('span');
  index.className = 'chat-tool-event-index';
  index.textContent = String(_chatToolEvents.length + 1).padStart(2, '0');
  const nameEl = document.createElement('span');
  nameEl.className = 'chat-tool-event-name';
  nameEl.textContent = name;
  const statusEl = document.createElement('span');
  statusEl.className = 'chat-tool-event-status';
  title.appendChild(index);
  title.appendChild(nameEl);
  title.appendChild(statusEl);
  row.appendChild(title);

  const input = document.createElement('div');
  input.className = 'chat-tool-event-input';
  row.appendChild(input);

  const pre = document.createElement('pre');
  pre.className = 'chat-tool-event-raw';
  row.appendChild(pre);

  ev = {
    name,
    summary,
    raw,
    state,
    bytes: opts.bytes,
    durationMs: opts.durationMs,
    done: state === 'done',
    row,
    nameEl,
    statusEl,
    inputEl: input,
    rawEl: pre,
  };
  _chatToolEvents.push(ev);
  _chatToolActiveEvent = ev.done ? null : ev;
  _renderToolEvent(ev);

  _chatToolGroupBody.appendChild(row);
  _updateToolRunSummary();
  if (chatShouldAutoScroll()) container.scrollTop = container.scrollHeight;
  return group;
}

function _updateCurrentToolEvent(toolName, opts = {}) {
  const name = (toolName || '').trim();
  const target = _findPendingToolEvent(name) || _chatToolActiveEvent;
  if (!target) {
    return _recordToolEvent(name || 'tool', opts.input || opts.detail || '', opts);
  }
  if (name && name !== 'tool') target.name = name;
  if (opts.input !== undefined) {
    const { summary, raw } = _summarizeToolInput(opts.input);
    if (summary) target.summary = summary;
    if (raw) target.raw = raw;
  } else if (opts.detail) {
    target.summary = String(opts.detail);
  }
  target.state = opts.state || target.state || 'calling';
  target.bytes = opts.bytes;
  target.durationMs = opts.durationMs;
  target.done = target.state === 'done';
  _renderToolEvent(target);
  _chatToolActiveEvent = target.done ? null : target;
  _updateToolRunSummary();
  const container = document.getElementById('chat-messages');
  if (container && chatShouldAutoScroll()) container.scrollTop = container.scrollHeight;
  return target.row;
}

function handleWsMessage(msg) {
  if (window._onWsMessage && window._onWsMessage(msg)) return;
  // After user clicks stop, suppress stale server messages until the run finishes
  if (_chatStopped) {
    if (msg.type === 'chat:done') { _chatStopped = false; setChatBusy(false); return; }
    if (msg.type === 'chat:delta' || msg.type === 'chat:thinking' || msg.type === 'chat:tool'
        || msg.type === 'chat:status' || msg.type === 'chat:chunk') return;
  }
  // On page refresh during an in-flight turn we may join after chat:start has
  // already shipped. Any subsequent in-flight event (delta/thinking/tool/etc.)
  // implies a chat is running — flip busy ON so the activity tracker (and the
  // self-node animation) catches up. Cheaper than a server snapshot and self-
  // contained.
  //
  // BUT: only fire if we're not in a "just finished" window. Servers (and our
  // own pipeline) sometimes emit a tail chat:status/chat:chunk shortly after
  // chat:done — without this guard the heuristic re-arms busy without any
  // future chat:done coming, leaving 'chat' in _sporeActiveSources until the
  // 90s watchdog evicts it. The 1500ms grace is well past anything legitimate.
  if (!chatBusy && (msg.type === 'chat:delta' || msg.type === 'chat:thinking'
      || msg.type === 'chat:tool' || msg.type === 'chat:status'
      || msg.type === 'chat:chunk')) {
    if (Date.now() - _chatLastDoneAt > 1500) {
      setChatBusy(true);
      setActivity('thinking...');
    }
  }
  // Same idea for subagents — receiving an iter/heartbeat without a prior
  // start means we joined mid-flight; mark the activity source so the
  // self-node pulses for the rest of the run.
  if (msg.type && msg.taskId && msg.type.startsWith('subagent:')
      && msg.type !== 'subagent:start' && msg.type !== 'subagent:done'
      && msg.type !== 'subagent:error' && msg.type !== 'subagent:result') {
    if (!_sporeActiveSources.has('subagent:' + msg.taskId)) {
      _sporeActivityStart('subagent:' + msg.taskId);
    }
  }
  if (msg.type === 'chat:busy') {
    setChatBusy(true);
    setActivity('thinking...');
    streamChunks = [];
    _streamDelta = '';
    _resetToolRunGroup();
    finalizeStreamingMsg();
    streamingMsgEl = null;
  } else if (msg.type === 'chat:start') {
    setChatBusy(true);
    _chatToolCount = 0;
    _resetToolRunGroup();
    streamChunks = [];
    _streamDelta = '';
    _userWasAtBottom = chatShouldAutoScroll();
    finalizeStreamingMsg();
    // Don't pre-create an empty assistant bubble. Let the first
    // chat:thinking / chat:delta / chat:chunk lazily create it via
    // _ensureStreamingBubble \u2014 keeps blank bubbles from flashing
    // between tool calls when the model goes straight from one tool
    // call to the next.
    streamingMsgEl = null;
    setActivity('thinking...');
    _thinkingDelta = '';
  } else if (msg.type === 'chat:thinking') {
    _thinkingDelta += msg.text;
    if (!_streamDelta && msg.text) setActivity('thinking...');
  } else if (msg.type === 'chat:delta') {
    if (_thinkingDelta && !_streamDelta) {
      if (streamingMsgEl) streamingMsgEl.classList.remove('thinking-stream');
    }
    _streamDelta += msg.text;
    setActivity('responding...');
    _ensureStreamingBubble();
    streamingMsgEl.textContent = _streamDelta;
    _syncAssistantRowVisibility(streamingMsgEl);
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:tool') {
    _chatToolCount++;
    if (streamingMsgEl && _streamDelta.trim()) {
      streamingMsgEl.classList.remove('streaming');
      streamingMsgEl.innerHTML = rewriteMediaUrlsInHtml(renderMarkdown(_streamDelta));
      streamingMsgEl = null;
    } else {
      finalizeStreamingMsg();
    }
    _recordToolEvent(msg.tool, msg.input, { state: msg.input ? 'running' : 'calling', updateLast: false });
    setActivity('using ' + (msg.tool || 'tool') + (_chatToolCount > 1 ? '  (' + _chatToolCount + ' tools)' : ''));
    _streamDelta = '';
    // Don't immediately create a new empty bubble for the next iteration.
    // The next chat:thinking/delta/chunk will create one if needed.
    streamingMsgEl = null;
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:status') {
    const s = msg.status;
    if (s === 'thinking_start') {
      setActivity('thinking deeply...');
    } else if (s === 'thinking') {
      const snippet = msg.snippet ? ' \u2014 ' + msg.snippet.substring(0, 140) : '';
      setActivity('thinking (' + (msg.tokens || 0) + ' tokens)' + snippet);
    } else if (s === 'thinking_done') {
      setActivity('composing response...');
    } else if (s === 'tool_progress') {
      const kb = Math.round((msg.bytes || 0) / 1024);
      const label = kb > 0 ? kb + 'KB' : (msg.bytes || 0) + 'B';
      _updateCurrentToolEvent(msg.tool, { state: 'progress', bytes: msg.bytes });
      setActivity('writing ' + (msg.tool || '') + ' ' + label + '...');
    } else if (s === 'tool_exec_start') {
      const d = msg.detail ? ': ' + msg.detail.substring(0, 60) : '';
      _updateCurrentToolEvent(msg.tool, { state: 'running', detail: msg.detail, input: msg.input });
      setActivity('running ' + msg.tool + d + '...');
    } else if (s === 'tool_exec_done') {
      const sec = msg.durationMs >= 1000 ? (msg.durationMs / 1000).toFixed(1) + 's' : msg.durationMs + 'ms';
      const d = msg.detail ? ' — ' + msg.detail.substring(0, 40) : '';
      _updateCurrentToolEvent(msg.tool, { state: 'done', detail: msg.detail, durationMs: msg.durationMs });
      setActivity(msg.tool + ' done (' + sec + ')' + d);
    } else if (s === 'truncated') {
      setActivity('output truncated — retrying with smaller output...');
      addChatMessage('system', '\u26a0 Output truncated at token limit — retrying');
    } else if (s === 'parallel_exec') {
      setActivity('running ' + msg.count + ' tools in parallel...');
    } else if (s === 'heartbeat') {
      const label = msg.phase === 'thinking' ? 'thinking deeply' : msg.phase === 'generating' ? 'responding' : msg.phase === 'tool_call' ? (msg.toolName ? 'using ' + msg.toolName : 'calling tool') : msg.phase;
      setActivity(label + '... (' + msg.elapsed + 's)');
    } else if (s === 'interjected') {
      // Gateway acknowledging we queued the user's follow-up into an in-flight run.
      setActivity('interjection queued — the agent will address it next iteration');
      addChatMessage('system', '\u21bb Follow-up queued — the agent is still working, will fold this into its reply.');
    } else if (s === 'interjection') {
      // Loop picked up the interjection at the next iteration boundary.
      const n = msg.count || 1;
      setActivity(`interjecting${n > 1 ? ` (${n} message${n === 1 ? '' : 's'})` : ''}... the agent is reading the follow-up now`);
      addChatMessage('system', `\u27f3 Agent is now folding your follow-up${n > 1 ? `s (${n})` : ''} into its response.`);
    }
  } else if (msg.type === 'chat:chunk') {
    streamChunks.push(msg.text);
    _ensureStreamingBubble();
    streamingMsgEl.textContent = msg.text;
    _streamDelta = msg.text;
    _syncAssistantRowVisibility(streamingMsgEl);
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:done') {
    setActivity(null);
    if (_chatToolGroupEl) _chatToolGroupEl.classList.add('complete');
    if (streamingMsgEl) {
      streamingMsgEl.classList.remove('streaming', 'thinking-stream');
      const content = _streamDelta || '';
      if (content.trim()) {
        streamingMsgEl.innerHTML = formatAssistantMsg(content, msg);
        _syncAssistantRowVisibility(streamingMsgEl);
      } else {
        _removeChatBubble(streamingMsgEl);
        // Append tool tags and usage to the last assistant bubble
        if (msg.toolUsage || msg.usage) {
          const allAssistant = document.getElementById('chat-messages').querySelectorAll('.chat-msg.assistant');
          const lastBubble = allAssistant.length ? allAssistant[allAssistant.length - 1] : null;
          if (lastBubble) {
            let extra = '';
            if (msg.toolUsage && typeof msg.toolUsage === 'object') {
              const entries = Object.entries(msg.toolUsage);
              if (entries.length) {
                extra += '<div style="margin-top:8px">';
                for (const [tool, count] of entries) extra += `<span class="tool-tag">${esc(tool)}${count > 1 ? ' \u00d7' + count : ''}</span>`;
                extra += '</div>';
              }
            }
            if (msg.usage) extra += _formatUsageTag(msg.usage, msg.iterations);
            if (extra) lastBubble.insertAdjacentHTML('beforeend', extra);
          }
        }
      }
    }
    streamingMsgEl = null;
    _pruneEmptyAssistantRows();
    setChatBusy(false);
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:error') {
    setActivity(null);
    finalizeStreamingMsg();
    addChatMessage('system', 'Error: ' + msg.error);
    setChatBusy(false);
    // Session expired — reload to surface the login screen so the user can re-auth.
    if (msg.code === 'auth-required' && !window._wsAuthRedirected) {
      window._wsAuthRedirected = true;
      setTimeout(() => { try { window.location.reload(); } catch {} }, 1500);
    }
  } else if (msg.type === 'chat:history') {
    const container = document.getElementById('chat-messages');
    const welcome = document.getElementById('chat-welcome');
    // Clear existing messages on reconnect to avoid duplicates
    const welcomeRef = welcome ? welcome.cloneNode(true) : null;
    container.innerHTML = '';
    if (welcomeRef) container.appendChild(welcomeRef);
    if (msg.messages?.length) {
      if (welcomeRef) welcomeRef.style.display = 'none';
      for (const m of msg.messages) {
        if (m.role === 'notification') {
          addChatMessage('system', '\ud83d\udcec ' + m.text);
          continue;
        }
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        if (role === 'assistant' && !(m.text || '').trim()) continue;
        const el = document.createElement('div');
        el.className = 'chat-msg ' + role;
        if (role === 'assistant') {
          let html = rewriteMediaUrlsInHtml(renderMarkdown(m.text));
          const media = detectMediaInText(m.text);
          if (media.length) html += '<div class="media-grid">' + renderMediaHtml(media) + '</div>';
          el.innerHTML = html;
        } else {
          el.textContent = m.text;
        }
        container.appendChild(_wrapChatBubble(el, role));
        _syncAssistantRowVisibility(el);
      }
      _pruneEmptyAssistantRows();
      container.scrollTop = container.scrollHeight;
    }
  } else if (msg.type === 'chat:cleared') {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const welcome = document.getElementById('chat-welcome');
    if (welcome) { welcome.style.display = ''; container.appendChild(welcome); }
  } else if (msg.type === 'graph:event') {
    handleGraphEvent(msg);
  } else if (msg.type && msg.type.startsWith('voice:')) {
    handleVoiceMessage(msg);
  } else if (msg.type && msg.type.startsWith('subagent:')) {
    handleSubagentMessage(msg);
  } else if (msg.type && msg.type.startsWith('benchmark:')) {
    handleBenchmarkWs(msg);
  } else if (msg.type === 'ask_user') {
    renderAskUserCard(msg);
  } else if (msg.type === 'ask_user_answer_ack') {
    // ack landed — picker already disabled; nothing to do
  } else if (msg.type === 'ask_user_cancelled') {
    markAskUserCancelled(msg);
  } else if (msg.type === 'plan_proposal' || msg.type === 'plan_applied'
             || msg.type === 'plan_rejected' || msg.type === 'plan_mode') {
    handlePlanModeMessage(msg);
  }
}

// ── ask_user picker card ──
function renderAskUserCard(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'chat-msg agent chat-ask-user';
  card.dataset.qid = msg.qid;
  const opts = (msg.options || []).map((o, i) =>
    `<label class="au-option"><input type="radio" name="au-${msg.qid}" value="${(o.label || '').replace(/"/g, '&quot;')}" ${i === 0 ? 'checked' : ''}> <strong>${escapeHtml(o.label || '')}</strong>${o.description ? `<div class="au-desc">${escapeHtml(o.description)}</div>` : ''}</label>`
  ).join('');
  card.innerHTML = `
    <div class="au-question">${escapeHtml(msg.question || '')}</div>
    <div class="au-options">${opts}</div>
    <button class="au-submit">Submit</button>
    <div class="au-status"></div>
  `;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  const submitBtn = card.querySelector('.au-submit');
  submitBtn.addEventListener('click', () => {
    const picked = card.querySelector(`input[name="au-${msg.qid}"]:checked`);
    if (!picked) { card.querySelector('.au-status').textContent = 'Pick one first.'; return; }
    submitBtn.disabled = true;
    card.querySelectorAll('input').forEach(i => i.disabled = true);
    try {
      ws.send(JSON.stringify({ type: 'ask_user_answer', qid: msg.qid, answer: picked.value }));
      card.querySelector('.au-status').textContent = `Sent: ${picked.value}`;
    } catch (e) {
      submitBtn.disabled = false;
      card.querySelectorAll('input').forEach(i => i.disabled = false);
      card.querySelector('.au-status').textContent = 'Failed to send — reconnect?';
    }
  });
}

function markAskUserCancelled(msg) {
  const qid = String(msg.qid || '');
  const card = [...document.querySelectorAll('.chat-ask-user')].find(el => el.dataset.qid === qid);
  if (!card) return;
  card.classList.add('is-cancelled');
  card.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
  const status = card.querySelector('.au-status');
  if (status) status.textContent = 'Cancelled';
}

// Tiny HTML escaper for the picker (the chat otherwise renders markdown).
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Plan-mode UI ──
let _planModeEnabled = false;
function handlePlanModeMessage(msg) {
  const card = document.getElementById('plan-proposals-card');
  if (msg.type === 'plan_mode') {
    _planModeEnabled = !!msg.enabled;
    _refreshPlanModeBadge();
    return;
  }
  if (msg.type === 'plan_proposal') {
    _refreshPlanProposals();
    return;
  }
  if (msg.type === 'plan_applied') {
    const container = document.getElementById('chat-messages');
    if (container) {
      const el = document.createElement('div');
      el.className = 'chat-msg system';
      const lines = (msg.results || []).map(r => `${r.ok ? '✓' : '✗'} ${r.tool} — ${r.summary || ''}${r.error ? ' · ' + r.error : ''}`);
      el.textContent = `[plan] Applied ${msg.results?.filter(r => r.ok).length}/${msg.results?.length}\n${lines.join('\n')}`;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }
    _refreshPlanProposals();
    return;
  }
  if (msg.type === 'plan_rejected') {
    _refreshPlanProposals();
    return;
  }
}

async function _refreshPlanProposals() {
  const sessionKey = _currentSessionKeyForPlan();
  if (!sessionKey) return;
  try {
    const r = await fetch(API + '/api/plan/pending?sessionKey=' + encodeURIComponent(sessionKey), { headers: authHeaders() });
    const d = await r.json();
    _renderPlanCard(d.proposals || [], sessionKey);
  } catch {}
}

function _currentSessionKeyForPlan() {
  // Same keying as the server: `dm:<username>` for normal sessions.
  if (_userRole === 'creator' || _userRole === 'admin' || _userRole === 'webapp') {
    return 'dm:' + (_currentUserName || 'operator');
  }
  return null;
}

function _renderPlanCard(proposals, sessionKey) {
  let card = document.getElementById('plan-proposals-card');
  if (!proposals.length) {
    if (card) card.remove();
    return;
  }
  if (!card) {
    card = document.createElement('div');
    card.id = 'plan-proposals-card';
    card.className = 'plan-card';
    const container = document.getElementById('chat-messages');
    if (container) container.appendChild(card);
  }
  const rows = proposals.map(p => `<div class="plan-row"><span class="plan-seq">${p.sequence}.</span> <span class="plan-tool">${escapeHtml(p.tool)}</span> <span class="plan-summary">${escapeHtml(p.summary || '')}</span></div>`).join('');
  card.innerHTML = `
    <div class="plan-header">Pending plan (${proposals.length} step${proposals.length !== 1 ? 's' : ''})</div>
    <div class="plan-rows">${rows}</div>
    <div class="plan-buttons">
      <button class="plan-approve">Approve</button>
      <button class="plan-reject">Reject</button>
    </div>
  `;
  card.querySelector('.plan-approve').addEventListener('click', () => _approvePlan(sessionKey));
  card.querySelector('.plan-reject').addEventListener('click', () => _rejectPlan(sessionKey));
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

async function _approvePlan(sessionKey) {
  const card = document.getElementById('plan-proposals-card');
  if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + '/api/plan/approve', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey }) });
    const d = await r.json();
    if (!d.ok) toast('Approve failed: ' + (d.error || 'unknown'), true);
  } catch (e) { toast('Approve error: ' + e.message, true); }
  _refreshPlanProposals();
}

async function _rejectPlan(sessionKey) {
  const card = document.getElementById('plan-proposals-card');
  if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + '/api/plan/reject', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey }) });
    await r.json();
  } catch {}
  _refreshPlanProposals();
}

function _togglePlanMode() {
  const sessionKey = _currentSessionKeyForPlan();
  if (!sessionKey) return;
  const next = !_planModeEnabled;
  fetch(API + '/api/plan/mode', { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey, enabled: next }) })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        _planModeEnabled = d.planMode;
        _refreshPlanModeBadge();
        toast(_planModeEnabled ? 'Plan mode ON — mutating tools will queue for approval' : 'Plan mode OFF');
      }
    })
    .catch(e => toast('Plan mode toggle failed: ' + e.message, true));
}

function _refreshPlanModeBadge() {
  const btn = document.getElementById('plan-mode-toggle');
  if (!btn) return;
  btn.classList.toggle('on', !!_planModeEnabled);
  btn.textContent = _planModeEnabled ? 'Plan: ON' : 'Plan: off';
}

// ── Subagent Activity (multi-agent) ──
const _saAgents = new Map();

function _saGetOrCreate(taskId) {
  if (_saAgents.has(taskId)) return _saAgents.get(taskId);
  const container = document.getElementById('subagent-container');
  if (!container) return null;

  const panel = document.createElement('div');
  panel.className = 'sa-panel';
  panel.id = 'sa-panel-' + taskId;

  const shortId = taskId.split('_').pop();
  panel.innerHTML = `<div class="sa-panel-header" onclick="this.nextElementSibling.classList.toggle('collapsed')"><span class="sa-panel-title">SUB ${esc(shortId)}</span><span class="sa-panel-status"></span></div><div class="sa-panel-body"></div>`;
  container.prepend(panel);
  container.classList.add('active');

  const state = { taskId, panel, lines: [], body: panel.querySelector('.sa-panel-body'), status: panel.querySelector('.sa-panel-status'), title: panel.querySelector('.sa-panel-title') };
  _saAgents.set(taskId, state);
  return state;
}

function saAddLine(state, cls, text) {
  if (!state?.body) return;
  const el = document.createElement('div');
  el.className = 'sa-line ' + cls;
  el.textContent = text;
  state.body.appendChild(el);
  state.lines.push(el);
  if (state.lines.length > 60) { state.lines.shift()?.remove(); }
  state.body.scrollTop = state.body.scrollHeight;
}

function handleSubagentMessage(msg) {
  const container = document.getElementById('subagent-container');
  if (!container) return;

  const tid = msg.taskId;
  if (!tid) return;

  if (msg.type === 'subagent:start') {
    _sporeActivityStart('subagent:' + tid);
    const s = _saGetOrCreate(tid);
    if (!s) return;
    s.body.innerHTML = '';
    s.body.classList.remove('collapsed');
    s.lines = [];
    s.status.textContent = 'starting...';
    s.status.className = 'sa-panel-status sa-pulse';
    saAddLine(s, '', '\u25b6 ' + (msg.model || '') + ' — ' + (msg.task || ''));
    s._startTime = Date.now();
    _saResetStaleTimer(tid);
    if (s._timer) clearInterval(s._timer);
    s._timer = setInterval(() => {
      const el = Math.round((Date.now() - s._startTime) / 1000);
      if (!s.status.textContent.startsWith('done') && !s.status.textContent.startsWith('error')) {
        const label = s.status.textContent.replace(/\s*\(\d+s\)$/, '');
        s.status.textContent = (label || 'working') + ' (' + el + 's)';
      }
    }, 1000);
    return;
  }

  const s = _saAgents.get(tid);
  if (!s) return;
  _saResetStaleTimer(tid);

  if (msg.type === 'subagent:iter') {
    s.status.textContent = 'thinking (' + msg.iteration + '/' + msg.maxIter + ')';
  } else if (msg.type === 'subagent:iter_done') {
    const line = '\u2502 iter ' + msg.iteration + ': ' + msg.durationMs + 'ms, ' + msg.toolCount + ' tools, ' + msg.textChars + ' chars, stop=' + (msg.stopReason || '?');
    saAddLine(s, msg.toolCount === 0 && msg.textChars > 500 ? 'warn' : 'text', line);
  } else if (msg.type === 'subagent:thinking_start') {
    saAddLine(s, 'thinking sa-pulse', '\u25c6 thinking...');
  } else if (msg.type === 'subagent:thinking') {
    const last = s.lines[s.lines.length - 1];
    if (last && last.classList.contains('thinking')) {
      const snippet = msg.snippet ? ' \u2014 ' + msg.snippet : '';
      last.textContent = '\u25c6 ' + msg.tokens + ' tokens' + snippet;
      last.title = msg.snippet || '';
    }
    s.status.textContent = 'thinking (' + msg.tokens + ' tokens)';
  } else if (msg.type === 'subagent:text') {
    const last = s.lines[s.lines.length - 1];
    if (last && last.classList.contains('thinking')) last.classList.remove('sa-pulse');
    if (last && last.classList.contains('streaming-text')) {
      const cur = last.textContent;
      if (cur.length < 200) last.textContent = cur + msg.text;
    } else {
      const el = document.createElement('div');
      el.className = 'sa-line text streaming-text';
      el.textContent = msg.text;
      s.body.appendChild(el);
      s.lines.push(el);
    }
  } else if (msg.type === 'subagent:heartbeat') {
    if (msg.toolBytes > 0) {
      s.status.textContent = 'writing ' + (msg.toolName || '') + ' ' + Math.round(msg.toolBytes / 1024) + 'KB';
    } else if (msg.tools > 0) {
      s.status.textContent = 'executing tools';
    } else if (msg.thinking > 0) {
      s.status.textContent = 'thinking (' + msg.thinking + ' tokens)';
    } else {
      s.status.textContent = 'thinking';
    }
    s.status.className = 'sa-panel-status sa-pulse';
  } else if (msg.type === 'subagent:tool_progress') {
    const last = s.lines[s.lines.length - 1];
    const kb = Math.round((msg.bytes || 0) / 1024);
    if (last && last.classList.contains('tool')) {
      last.textContent = '\u2699 ' + (msg.tool || '') + ' \u2014 writing ' + kb + 'KB...';
    }
    s.status.textContent = 'writing ' + (msg.tool || '') + ' ' + kb + 'KB';
    s.status.className = 'sa-panel-status sa-pulse';
  } else if (msg.type === 'subagent:tool_start' || msg.type === 'subagent:tool_call') {
    const tool = msg.tool || '';
    let input = msg.input ? ' ' + msg.input.substring(0, 120) : '';
    input = input
      .replace(/(?:KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIALS)[=:]\\{0,2}["']?\s*([A-Za-z0-9_\-.]{8,})/gi,
        (m, val) => m.replace(val, val.slice(0, 4) + '***'))
      .replace(/(?:sk-|pk-|key-|tok-|Bearer\s+)([A-Za-z0-9_\-.]{8,})/g,
        (m, val) => m.replace(val, val.slice(0, 4) + '***'));
    saAddLine(s, 'tool', '\u2699 ' + tool + input);
  } else if (msg.type === 'subagent:warn') {
    saAddLine(s, 'warn', '\u26a0 ' + (msg.message || ''));
    s.status.className = 'sa-panel-status warn';
  } else if (msg.type === 'subagent:finishing') {
    s.status.textContent = 'finishing up...';
    s.status.className = 'sa-panel-status';
    saAddLine(s, 'done', '\u2713 task complete \u2014 generating summary');
    if (s._staleTimer) clearTimeout(s._staleTimer);
    s._staleTimer = setTimeout(() => { _saCleanup(tid); }, 30000);
  } else if (msg.type === 'subagent:done') {
    _sporeActivityEnd('subagent:' + tid);
    if (s._timer) { clearInterval(s._timer); s._timer = null; }
    _saCleanup(tid);
  } else if (msg.type === 'subagent:error') {
    _sporeActivityEnd('subagent:' + tid);
    s.status.textContent = 'error';
    s.status.className = 'sa-panel-status';
    if (s._timer) { clearInterval(s._timer); s._timer = null; }
    saAddLine(s, 'error', '\u2717 ' + (msg.error || 'unknown error'));
    setTimeout(() => { _saCleanup(tid); }, 10000);
  } else if (msg.type === 'subagent:result') {
    _sporeActivityEnd('subagent:' + tid);
    _saCleanup(tid);
    if (msg.status === 'completed') {
      setActivity('processing result...');
    }
  }
}

function _saCleanup(taskId) {
  const s = _saAgents.get(taskId);
  if (!s) return;
  if (s._timer) { clearInterval(s._timer); s._timer = null; }
  if (s._staleTimer) { clearTimeout(s._staleTimer); s._staleTimer = null; }
  s.panel.remove();
  _saAgents.delete(taskId);
  const container = document.getElementById('subagent-container');
  if (container && _saAgents.size === 0) container.classList.remove('active');
}
function _saResetStaleTimer(taskId) {
  const s = _saAgents.get(taskId);
  if (!s) return;
  if (s._staleTimer) clearTimeout(s._staleTimer);
  const elapsed = s._startTime ? (Date.now() - s._startTime) / 1000 : 0;
  const timeout = elapsed > 120 ? 300000 : 120000;
  s._staleTimer = setTimeout(() => { _saCleanup(taskId); }, timeout);
}

// ── Browser Live Preview ──
let _browserFrameUrl = null;
let _browserFrameCount = 0;
// User-dismissed flag: when the operator clicks ✕ on the preview
// panel we hide it AND set this. Incoming `browser:frame` packets
// then update img silently without re-popping the panel. Cleared on
// the next `browser:open` (= next browser tool launch).
let _browserPanelDismissed = false;
let _browserLastFrameTime = 0;

function _clampBrowserPanel(panel) {
  requestAnimationFrame(() => {
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = r.width || 420, ph = r.height || 320;
    let x = r.left, y = r.top;
    // If panel ended up at 0,0 or completely off-screen, reset to top-right
    if ((x === 0 && y === 0) || x + pw < 20 || y + ph < 20 || x > vw - 20 || y > vh - 20) {
      x = Math.max(10, vw - pw - 20);
      y = 10;
      localStorage.removeItem('_browserPreviewPos');
    }
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
}

function handleBrowserFrame(arrayBuf) {
  const view = new DataView(arrayBuf);
  if (arrayBuf.byteLength < 4) return;
  const headerLen = view.getUint32(0, false);
  if (arrayBuf.byteLength < 4 + headerLen) return;

  const headerBytes = new Uint8Array(arrayBuf, 4, headerLen);
  let header;
  try { header = JSON.parse(new TextDecoder().decode(headerBytes)); } catch { return; }

  const jpegBytes = new Uint8Array(arrayBuf, 4 + headerLen);
  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);

  const panel = document.getElementById('browser-preview');
  const img = document.getElementById('browser-preview-img');
  const status = document.getElementById('browser-preview-status');

  if (_browserFrameUrl) URL.revokeObjectURL(_browserFrameUrl);
  _browserFrameUrl = url;
  img.src = url;

  if (!panel.classList.contains('active') && !_browserPanelDismissed) {
    panel.classList.add('active');
    _clampBrowserPanel(panel);
  }
  _browserFrameCount++;
  _browserLastFrameTime = Date.now();
  if (_browserFrameCount % 10 === 0) {
    status.textContent = _browserFrameCount + ' frames | ' + (header.w || '?') + 'x' + (header.h || '?');
  }
}

// ── Notification Toasts ──────────────────────────────────────────────
function showNotification(msg) {
  let container = document.querySelector('.spore-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'spore-toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'spore-toast' + (msg.urgent ? ' urgent' : '');

  const source = msg.source || msg.from || 'Notification';
  toast.innerHTML = `
    <div class="spore-toast-source">${source}</div>
    <div class="spore-toast-body"></div>
    <button class="spore-toast-close">&times;</button>
  `;
  toast.querySelector('.spore-toast-body').textContent = msg.message || '';
  toast.querySelector('.spore-toast-close').onclick = () => dismissToast(toast);
  container.appendChild(toast);

  // Also add to chat so it persists
  addChatMessage('system', `📬 **${source}**: ${msg.message || ''}`);

  // Auto-dismiss after 15s (30s if urgent)
  const ttl = msg.urgent ? 30000 : 15000;
  setTimeout(() => dismissToast(toast), ttl);
}

function dismissToast(el) {
  if (!el || el._dismissed) return;
  el._dismissed = true;
  el.style.animation = 'toast-fade-out .3s ease forwards';
  setTimeout(() => el.remove(), 300);
}

function handleBrowserControl(msg) {
  const panel = document.getElementById('browser-preview');
  if (msg.type === 'browser:open') {
    // New browser session — clear any prior user-dismissed state so
    // the panel actually shows. Without this, an operator who closed
    // the panel during a previous session would never see the new one.
    _browserPanelDismissed = false;
    panel.classList.add('active');
    _clampBrowserPanel(panel);
    _browserFrameCount = 0;
    document.getElementById('browser-preview-status').textContent = 'connected — waiting for frames...';
  } else if (msg.type === 'browser:closed') {
    panel.classList.remove('active');
    _browserFrameCount = 0;
  }
}

function _initBrowserPreview() {
  const panel = document.getElementById('browser-preview');
  const header = document.getElementById('browser-preview-header');
  const closeBtn = document.getElementById('browser-preview-close');
  const resizeHandle = document.getElementById('browser-preview-resize');
  if (!panel || !header || !closeBtn) return;

  // Restore saved position/size — default to top-right
  try {
    const saved = JSON.parse(localStorage.getItem('_browserPreviewPos') || '{}');
    if (saved.x !== undefined && saved.y !== undefined) {
      panel.style.left = saved.x + 'px'; panel.style.top = saved.y + 'px';
    } else {
      panel.style.left = Math.max(10, window.innerWidth - 440) + 'px'; panel.style.top = '10px';
    }
    if (saved.w) panel.style.width = saved.w + 'px';
    if (saved.h) panel.style.height = saved.h + 'px';
  } catch { panel.style.left = Math.max(10, window.innerWidth - 440) + 'px'; panel.style.top = '10px'; }

  function savePos() {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem('_browserPreviewPos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    } catch {}
  }

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('active');
    // Mark the panel as user-dismissed so subsequent frame packets
    // don't silently re-open it. Cleared on the next browser:open
    // (= next time the agent calls browser({action:"launch"})).
    _browserPanelDismissed = true;
  });

  // Drag from header
  let mode = null, startX, startY, startLeft, startTop, startW, startH;

  header.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    e.preventDefault();
    mode = 'drag';
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  // Resize from corner handle
  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      mode = 'resize';
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!mode) return;
    if (mode === 'drag') {
      const pw = panel.offsetWidth || 420;
      const x = Math.max(-pw + 60, Math.min(startLeft + e.clientX - startX, window.innerWidth - 60));
      const y = Math.max(-20, Math.min(startTop + e.clientY - startY, window.innerHeight - 30));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    } else if (mode === 'resize') {
      const w = Math.max(200, startW + e.clientX - startX);
      const h = Math.max(150, startH + e.clientY - startY);
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (mode) { savePos(); mode = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initBrowserPreview);
} else {
  _initBrowserPreview();
}

// ═══════════════════════════════════════════════════════════════════════
// Code Viewer (docked in canvas tab or floating)
// ═══════════════════════════════════════════════════════════════════════
const _cvTabs = [];        // { id, path, mode, content, language, badge }
let _cvActiveTabId = null;
let _cvAutoHideTimer = null;
const CV_MAX_TABS = 8;
const CV_AUTO_HIDE_MS = 120000;
const _cvSavedMode = localStorage.getItem('cv-mode');
let _cvMode = _cvSavedMode === 'off' ? 'off' : 'on-request';
if (_cvSavedMode === 'auto') localStorage.setItem('cv-mode', 'on-request');
let _cvPendingCount = 0;
let _cvDocked = localStorage.getItem('cv-docked') !== 'false'; // default docked

// ── Canvas Tab System ──
function _ctSetActiveTab(tabName) {
  const canvas = document.getElementById('canvas');
  const tabBar = document.getElementById('canvas-tabs');
  if (tabBar) {
    tabBar.classList.remove('active');
    tabBar.querySelectorAll('.canvas-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.ct === tabName);
    });
  }
  if (!canvas) return;
  if (tabName === 'code') {
    canvas.classList.add('cv-tab-active');
    const cv = document.getElementById('code-viewer');
    if (cv && cv.classList.contains('cv-docked')) {
      cv.classList.remove('cv-entering');
      void cv.offsetWidth;
      cv.classList.add('cv-entering');
      cv.addEventListener('animationend', () => cv.classList.remove('cv-entering'), { once: true });
    }
    if (_cvAceEditor) setTimeout(() => _cvAceEditor.resize(), 50);
  } else {
    canvas.classList.remove('cv-tab-active');
  }
}

function _ctShowTabBar() {
  const tabBar = document.getElementById('canvas-tabs');
  if (tabBar) tabBar.classList.remove('active');
}

function _ctHideTabBar() {
  const tabBar = document.getElementById('canvas-tabs');
  const canvas = document.getElementById('canvas');
  if (tabBar) tabBar.classList.remove('active');
  if (canvas) canvas.classList.remove('cv-tab-active');
}

function _ctUpdateCodeBadge() {
  const codeTab = document.querySelector('.canvas-tab[data-ct="code"]');
  if (!codeTab) return;
  const existing = codeTab.querySelector('.ct-badge');
  if (_cvTabs.length > 0 && _cvPendingCount > 0) {
    if (existing) { existing.textContent = _cvPendingCount; }
    else {
      const b = document.createElement('span');
      b.className = 'ct-badge';
      b.textContent = _cvPendingCount;
      codeTab.insertBefore(b, codeTab.querySelector('.canvas-tab-close'));
    }
  } else if (existing) {
    existing.remove();
  }
}

function _cvSetDocked(docked) {
  _cvDocked = docked;
  localStorage.setItem('cv-docked', docked ? 'true' : 'false');
  const panel = document.getElementById('code-viewer');
  if (!panel) return;

  if (docked) {
    panel.classList.add('cv-docked');
    panel.style.left = ''; panel.style.top = '';
    panel.style.width = ''; panel.style.height = '';
    if (_cvTabs.length > 0 && panel.classList.contains('active')) {
      _ctSetActiveTab('code');
    }
  } else {
    panel.classList.remove('cv-docked');
    // Restore floating position
    try {
      const saved = JSON.parse(localStorage.getItem('_codeViewerPos') || '{}');
      if (saved.x != null) panel.style.left = saved.x + 'px';
      if (saved.y != null) panel.style.top = saved.y + 'px';
      if (saved.w) panel.style.width = saved.w + 'px';
      if (saved.h) panel.style.height = saved.h + 'px';
    } catch {}
    _ctSetActiveTab('graph');
    if (_cvTabs.length === 0) _ctHideTabBar();
  }
  if (_cvAceEditor) setTimeout(() => _cvAceEditor.resize(), 50);
}

function _initCanvasTabs() {
  const tabBar = document.getElementById('canvas-tabs');
  if (!tabBar) return;

  tabBar.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-ct-close]');
    if (closeEl) {
      // Close the code tab — hide the code viewer
      const panel = document.getElementById('code-viewer');
      if (_cvEditing) _cvExitEditMode(false);
      if (panel) panel.classList.remove('active');
      _ctSetActiveTab('graph');
      if (_cvTabs.length === 0) _ctHideTabBar();
      return;
    }
    const tab = e.target.closest('[data-ct]');
    if (!tab) return;
    const name = tab.dataset.ct;
    _ctSetActiveTab(name);
  });

  // Double-click code tab to pop out to floating
  tabBar.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('[data-ct="code"]');
    if (tab && _cvDocked) {
      _cvSetDocked(false);
    }
  });
}

function _cvLangAlias(lang) {
  const map = { javascript: 'js', typescript: 'ts', python: 'py', markdown: 'md', bash: 'sh', yaml: 'yml' };
  return map[lang] || lang || 'text';
}

function _cvFileName(p) {
  if (!p) return 'untitled';
  return p.split('/').pop();
}

function _cvShortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : p;
}

function _cvPrismLang(language) {
  if (typeof Prism === 'undefined') return null;
  const aliases = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', yml: 'yaml', md: 'markdown', text: null };
  const lang = aliases[language] || language;
  return Prism.languages[lang] || null;
}

function _cvHighlight(code, language) {
  const grammar = _cvPrismLang(language);
  if (grammar) {
    try { return Prism.highlight(code, grammar, language); } catch { }
  }
  const el = document.createElement('span');
  el.textContent = code;
  return el.innerHTML;
}

function _cvComputeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const hunks = [];
  let oi = 0, ni = 0;
  // Simple line-by-line LCS-style diff
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      hunks.push({ type: 'ctx', text: oldLines[oi] });
      oi++; ni++;
    } else {
      // Find next common line within a lookahead window
      let foundOld = -1, foundNew = -1;
      const window = 20;
      outer:
      for (let d = 1; d < window; d++) {
        for (let s = 0; s <= d; s++) {
          if (oi + s < oldLines.length && ni + d < newLines.length && oldLines[oi + s] === newLines[ni + d]) {
            foundOld = s; foundNew = d; break outer;
          }
          if (ni + s < newLines.length && oi + d < oldLines.length && oldLines[oi + d] === newLines[ni + s]) {
            foundOld = d; foundNew = s; break outer;
          }
        }
      }
      if (foundOld === -1) {
        // No convergence in window — emit remaining as del/add
        while (oi < oldLines.length) { hunks.push({ type: 'del', text: oldLines[oi++] }); }
        while (ni < newLines.length) { hunks.push({ type: 'add', text: newLines[ni++] }); }
      } else {
        for (let i = 0; i < foundOld; i++) { hunks.push({ type: 'del', text: oldLines[oi++] }); }
        for (let i = 0; i < foundNew; i++) { hunks.push({ type: 'add', text: newLines[ni++] }); }
      }
    }
  }
  return hunks;
}

function _cvRenderDiff(hunks, language) {
  // Trim leading/trailing context to keep it tight, show up to 3 ctx lines around changes
  const condensed = [];
  let lastChangeIdx = -999;
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'ctx') { lastChangeIdx = i; }
  }
  let prevChangeIdx = -999;
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'ctx') {
      prevChangeIdx = i;
      condensed.push(hunks[i]);
    } else {
      // Next change index
      let nextChange = hunks.length;
      for (let j = i + 1; j < hunks.length; j++) {
        if (hunks[j].type !== 'ctx') { nextChange = j; break; }
      }
      const distBefore = i - prevChangeIdx;
      const distAfter = nextChange - i;
      if (distBefore <= 3 || distAfter <= 3) {
        condensed.push(hunks[i]);
      } else if (distBefore === 4 || distAfter === 4) {
        // Show the separator line
        condensed.push(hunks[i]);
      } else if (condensed.length > 0 && condensed[condensed.length - 1].type !== 'sep') {
        condensed.push({ type: 'sep' });
      }
    }
  }

  let html = '';
  for (const h of condensed) {
    if (h.type === 'sep') {
      html += '<span class="cv-diff-line cv-diff-hunk">───</span>';
      continue;
    }
    const prefix = h.type === 'add' ? '+' : h.type === 'del' ? '-' : ' ';
    const cls = h.type === 'add' ? 'cv-diff-add' : h.type === 'del' ? 'cv-diff-del' : 'cv-diff-ctx';
    const highlighted = _cvHighlight(h.text, language);
    html += `<span class="cv-diff-line ${cls}"><span class="cv-diff-prefix">${prefix}</span>${highlighted}</span>`;
  }
  return html;
}

function _cvRenderLineNumbers(lineCount) {
  const el = document.querySelector('#code-viewer .cv-line-numbers');
  if (!el) return;
  if (lineCount > 2000) { el.innerHTML = ''; return; }
  let html = '';
  for (let i = 1; i <= lineCount; i++) html += `<span>${i}</span>`;
  el.innerHTML = html;
}

function _cvClearLineNumbers() {
  const el = document.querySelector('#code-viewer .cv-line-numbers');
  if (el) el.innerHTML = '';
}

function _cvOpenPanel(panel = document.getElementById('code-viewer')) {
  if (!panel) return;
  panel.classList.add('active');
  _cvPendingCount = 0;
  _cvUpdatePendingBadge();
  _ctUpdateCodeBadge();
  if (_cvDocked) _ctSetActiveTab('code');
  if (_cvAceEditor) setTimeout(() => _cvAceEditor.resize(), 50);
}

function _cvClosePanel(panel = document.getElementById('code-viewer')) {
  if (!panel) return;
  if (_cvEditing) _cvExitEditMode(false);
  panel.classList.remove('active');
  panel.classList.remove('editing');
  _ctSetActiveTab('graph');
  _ctHideTabBar();
  _cvUpdatePendingBadge();
}

function _cvRenderTab(tab) {
  const panel = document.getElementById('code-viewer');
  const pathEl = document.getElementById('code-viewer-path');
  const badgeEl = document.getElementById('code-viewer-badge');
  const codeEl = document.getElementById('code-viewer-code');
  const langEl = document.getElementById('code-viewer-lang');
  const infoEl = document.getElementById('code-viewer-info');
  const contentEl = document.getElementById('code-viewer-content');
  const toolbar = document.getElementById('code-viewer-toolbar');
  const editBtn = document.getElementById('code-viewer-edit-btn');
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const discardBtn = document.getElementById('code-viewer-discard-btn');
  const saveStatus = document.getElementById('code-viewer-save-status');

  if (!panel || !pathEl || !badgeEl || !codeEl || !langEl || !infoEl || !contentEl) return;

  pathEl.textContent = _cvShortPath(tab.path);
  pathEl.title = tab.path;

  if (tab.badge === 'new') {
    badgeEl.textContent = 'new'; badgeEl.className = 'cv-badge cv-badge-new';
  } else if (tab.badge === 'edit') {
    badgeEl.textContent = 'edit'; badgeEl.className = 'cv-badge cv-badge-edit';
  } else {
    badgeEl.textContent = 'read'; badgeEl.className = 'cv-badge cv-badge-read';
  }

  // Media branch: if the tab's path has a known media extension, render an
  // <img>/<video>/<audio> instead of the code+line-numbers view. No edit UI.
  const mediaExtMatch = (tab.path || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const mediaExt = mediaExtMatch ? mediaExtMatch[1] : null;
  let mediaType = null;
  if (mediaExt) {
    if (MEDIA_EXTS.image.includes(mediaExt)) mediaType = 'image';
    else if (MEDIA_EXTS.video.includes(mediaExt)) mediaType = 'video';
    else if (MEDIA_EXTS.audio.includes(mediaExt)) mediaType = 'audio';
  }
  if (mediaType && tab.mode !== 'diff') {
    contentEl.classList.remove('has-lines');
    _cvClearLineNumbers();
    const workspacePath = tab.path.startsWith('/workspace/') ? tab.path : `/workspace/${tab.path.replace(/^\/+/, '')}`;
    const mediaUrl = resolveAnimaMediaUrl(workspacePath);
    const escUrl = esc(mediaUrl);
    if (mediaType === 'image') {
      codeEl.innerHTML = `<div class="cv-media"><img src="${escUrl}" alt="${esc(tab.path)}" loading="lazy" onclick="window.open(this.src,'_blank')"></div>`;
    } else if (mediaType === 'video') {
      codeEl.innerHTML = `<div class="cv-media"><video src="${escUrl}" controls preload="metadata"></video></div>`;
    } else {
      codeEl.innerHTML = `<div class="cv-media"><audio src="${escUrl}" controls preload="metadata"></audio></div>`;
    }
    langEl.textContent = mediaType;
    infoEl.textContent = mediaExt.toUpperCase();
    if (toolbar) toolbar.classList.remove('active');
    panel.classList.remove('editing');
    contentEl.scrollTop = 0;
    _cvRenderTabBar();
    if (panel.classList.contains('active')) {
      _cvOpenPanel(panel);
    } else if (_cvMode !== 'off') {
      _cvPendingCount++;
      _cvUpdatePendingBadge();
      _ctUpdateCodeBadge();
    }
    return;
  }

  if (tab.mode === 'diff') {
    contentEl.classList.remove('has-lines');
    _cvClearLineNumbers();
    codeEl.innerHTML = tab.content;
    langEl.textContent = _cvLangAlias(tab.language);
    infoEl.textContent = 'diff';
    if (toolbar) toolbar.classList.remove('active');
  } else {
    contentEl.classList.add('has-lines');
    codeEl.innerHTML = _cvHighlight(tab.content, tab.language);
    const lineCount = tab.content.split('\n').length;
    _cvRenderLineNumbers(lineCount);
    langEl.textContent = _cvLangAlias(tab.language);
    infoEl.textContent = `${lineCount} lines`;
    // Show toolbar with Edit button for viewable files
    if (toolbar) toolbar.classList.add('active');
    if (editBtn) editBtn.style.display = '';
    if (saveBtn) saveBtn.style.display = 'none';
    if (discardBtn) discardBtn.style.display = 'none';
    if (saveStatus) saveStatus.textContent = '';
  }

  panel.classList.remove('editing');

  // Scroll to top
  contentEl.scrollTop = 0;

  // Update tab bar
  _cvRenderTabBar();

  if (panel.classList.contains('active')) {
    _cvOpenPanel(panel);
  } else if (_cvMode !== 'off') {
    _cvPendingCount++;
    _cvUpdatePendingBadge();
    _ctUpdateCodeBadge();
  }
  _cvResetAutoHide();
}

function _cvRenderTabBar() {
  const bar = document.getElementById('code-viewer-tabs');
  if (!bar) return;
  if (_cvTabs.length <= 1) { bar.innerHTML = ''; return; }
  bar.innerHTML = _cvTabs.map(t => {
    const active = t.id === _cvActiveTabId ? ' active' : '';
    const name = _cvFileName(t.path);
    const icon = t.badge === 'edit' ? '~' : t.badge === 'new' ? '+' : '';
    return `<span class="cv-tab${active}" data-cv-tab="${t.id}">${icon ? `<span style="color:var(--accent2)">${icon}</span> ` : ''}${name}<span class="cv-tab-close" data-cv-close="${t.id}">&times;</span></span>`;
  }).join('');
}

function _cvAddTab(path, mode, content, language, badge) {
  // Reuse existing tab for same path, or create new
  let tab = _cvTabs.find(t => t.path === path);
  if (tab) {
    tab.mode = mode;
    tab.content = content;
    tab.language = language;
    tab.badge = badge;
  } else {
    if (_cvTabs.length >= CV_MAX_TABS) _cvTabs.shift();
    tab = { id: 'cv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), path, mode, content, language, badge };
    _cvTabs.push(tab);
  }
  _cvActiveTabId = tab.id;
  _cvRenderTab(tab);
}

function _cvSwitchTab(tabId) {
  const tab = _cvTabs.find(t => t.id === tabId);
  if (!tab) return;
  _cvActiveTabId = tabId;
  _cvRenderTab(tab);
}

function _cvCloseTab(tabId) {
  const idx = _cvTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  _cvTabs.splice(idx, 1);
  if (_cvTabs.length === 0) {
    const panel = document.getElementById('code-viewer');
    if (panel) panel.classList.remove('active');
    _cvPendingCount = 0;
    _cvUpdatePendingBadge();
    if (_cvDocked) { _ctSetActiveTab('graph'); _ctHideTabBar(); }
    return;
  }
  if (_cvActiveTabId === tabId) {
    _cvActiveTabId = _cvTabs[Math.min(idx, _cvTabs.length - 1)].id;
    _cvRenderTab(_cvTabs.find(t => t.id === _cvActiveTabId));
  } else {
    _cvRenderTabBar();
  }
  _cvUpdatePendingBadge();
}

function _cvResetAutoHide() {
  if (_cvAutoHideTimer) clearTimeout(_cvAutoHideTimer);
  _cvAutoHideTimer = setTimeout(() => {
    // Don't auto-hide, just dim the border
  }, CV_AUTO_HIDE_MS);
}

function _cvUpdatePendingBadge() {
  const badge = document.getElementById('cv-pending-badge');
  if (!badge) return;
  const panel = document.getElementById('code-viewer');
  const isActive = !!panel?.classList.contains('active');
  const shouldShow = _cvMode !== 'off' && _cvTabs.length > 0;
  const label = _cvPendingCount > 0
    ? `code ${_cvPendingCount}`
    : 'code';
  badge.textContent = label;
  badge.classList.toggle('cv-ready', shouldShow);
  badge.classList.toggle('cv-attention', shouldShow && _cvPendingCount > 0 && !isActive);
  badge.classList.toggle('cv-open', shouldShow && isActive);
  badge.hidden = !shouldShow;
  badge.title = isActive
    ? 'Code viewer is open'
    : _cvPendingCount > 0
    ? `Open ${_cvPendingCount} pending code ${_cvPendingCount === 1 ? 'view' : 'views'}`
    : 'Open code viewer';
  if (typeof window._updateViewModePill === 'function') {
    requestAnimationFrame(window._updateViewModePill);
  }
}

function _cvShowFromBadge() {
  _cvPendingCount = 0;
  _cvUpdatePendingBadge();
  _ctUpdateCodeBadge();
  const panel = document.getElementById('code-viewer');
  if (!panel) return;
  if (_cvTabs.length > 0) {
    const tab = _cvTabs.find(t => t.id === _cvActiveTabId) || _cvTabs[_cvTabs.length - 1];
    panel.classList.add('active');
    if (tab) _cvRenderTab(tab);
    _cvOpenPanel(panel);
  }
}

let _cvEditing = false;
let _cvOriginalContent = '';
let _cvAceEditor = null;

const _cvAceModeMap = {
  javascript: 'javascript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  python: 'python', py: 'python', ruby: 'ruby', rb: 'ruby',
  go: 'golang', rust: 'rust', rs: 'rust', java: 'java',
  c: 'c_cpp', cpp: 'c_cpp', h: 'c_cpp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  markdown: 'markdown', md: 'markdown',
  sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
  xml: 'xml', svg: 'xml', php: 'php', swift: 'swift',
  kotlin: 'kotlin', kt: 'kotlin', lua: 'lua', perl: 'perl',
  dockerfile: 'dockerfile', makefile: 'makefile',
  text: 'text',
};

function _cvGetAceMode(language) {
  return _cvAceModeMap[language] || _cvAceModeMap[language?.toLowerCase()] || 'text';
}

function _cvEnsureAce() {
  if (_cvAceEditor) return _cvAceEditor;
  if (typeof ace === 'undefined') return null;

  _cvAceEditor = ace.edit('code-viewer-ace', {
    theme: 'ace/theme/one_dark',
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', 'Consolas', monospace",
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false,
    enableBasicAutocompletion: false,
    highlightActiveLine: true,
    showGutter: true,
    animatedScroll: false,
  });

  // Load the one_dark theme — fall back to monokai if unavailable
  try {
    ace.config.set('basePath', 'https://cdn.jsdelivr.net/npm/ace-builds@1.36.5/src-min-noconflict');
    _cvAceEditor.setTheme('ace/theme/one_dark');
  } catch {
    try { _cvAceEditor.setTheme('ace/theme/monokai'); } catch { }
  }

  // Ctrl+S / Cmd+S to save
  _cvAceEditor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: _cvSave,
  });

  return _cvAceEditor;
}

function _cvEnterEditMode() {
  const panel = document.getElementById('code-viewer');
  const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
  if (!panel || !tab || tab.mode === 'diff') return;

  const editor = _cvEnsureAce();
  if (!editor) return;

  _cvEditing = true;
  _cvOriginalContent = tab.content;
  panel.classList.add('editing');

  const aceMode = _cvGetAceMode(tab.language);
  editor.session.setMode('ace/mode/' + aceMode);
  editor.setValue(tab.content, -1);
  editor.clearSelection();
  editor.focus();
  editor.gotoLine(1, 0, false);

  // Resize ace to fit the container
  setTimeout(() => editor.resize(), 50);

  const toolbar = document.getElementById('code-viewer-toolbar');
  const editBtn = document.getElementById('code-viewer-edit-btn');
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const discardBtn = document.getElementById('code-viewer-discard-btn');
  const saveStatus = document.getElementById('code-viewer-save-status');
  if (toolbar) toolbar.classList.add('active');
  if (editBtn) editBtn.style.display = 'none';
  if (saveBtn) saveBtn.style.display = '';
  if (discardBtn) discardBtn.style.display = '';
  if (saveStatus) saveStatus.textContent = '';

  const infoEl = document.getElementById('code-viewer-info');
  if (infoEl) infoEl.textContent = 'editing';
}

function _cvExitEditMode(keepChanges) {
  const panel = document.getElementById('code-viewer');
  if (!panel) return;

  if (keepChanges && _cvAceEditor) {
    const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
    if (tab) {
      tab.content = _cvAceEditor.getValue();
      _cvRenderTab(tab);
    }
  }

  _cvEditing = false;
  panel.classList.remove('editing');
  const editBtn = document.getElementById('code-viewer-edit-btn');
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const discardBtn = document.getElementById('code-viewer-discard-btn');
  if (editBtn) editBtn.style.display = '';
  if (saveBtn) saveBtn.style.display = 'none';
  if (discardBtn) discardBtn.style.display = 'none';
}

function _cvSave() {
  const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
  if (!tab || !_cvAceEditor) return;

  const newContent = _cvAceEditor.getValue();
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const statusEl = document.getElementById('code-viewer-save-status');
  if (!saveBtn || !statusEl) return;

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';

  if (window._ws && window._ws.readyState === 1) {
    window._ws.send(JSON.stringify({
      type: 'code:save',
      path: tab.path,
      content: newContent,
    }));
  } else {
    statusEl.textContent = 'Error: no connection';
    saveBtn.disabled = false;
  }
}

function handleCodeEvent(msg) {
  if (_cvMode === 'off' && msg.type !== 'code:saved') return;
  const panel = document.getElementById('code-viewer');
  if (!panel) return;

  if (msg.type === 'code:view') {
    if (_cvEditing) _cvExitEditMode(false);
    const badge = msg.isNew ? 'new' : 'read';
    _cvAddTab(msg.path, 'view', msg.content, msg.language, badge);
  } else if (msg.type === 'code:diff') {
    if (_cvEditing) _cvExitEditMode(false);
    const hunks = _cvComputeDiff(msg.oldText, msg.newText);
    const diffHtml = _cvRenderDiff(hunks, msg.language);
    _cvAddTab(msg.path, 'diff', diffHtml, msg.language, 'edit');
  } else if (msg.type === 'code:close') {
    if (_cvEditing) _cvExitEditMode(false);
    _cvClosePanel(panel);
  } else if (msg.type === 'code:saved') {
    const statusEl = document.getElementById('code-viewer-save-status');
    const saveBtn = document.getElementById('code-viewer-save-btn');
    if (!statusEl || !saveBtn) return;
    if (msg.error) {
      statusEl.textContent = 'Error: ' + msg.error;
      saveBtn.disabled = false;
    } else {
      statusEl.textContent = 'Saved ✓';
      saveBtn.disabled = false;
      const tab = _cvTabs.find(t => t.path === msg.path);
      if (tab && _cvAceEditor) {
        tab.content = _cvAceEditor.getValue();
      }
      setTimeout(() => {
        _cvExitEditMode(true);
        statusEl.textContent = '';
      }, 800);
    }
  }
}

function _initCodeViewer() {
  const panel = document.getElementById('code-viewer');
  const header = document.getElementById('code-viewer-header');
  const closeBtn = document.getElementById('code-viewer-close');
  const resizeHandle = document.getElementById('code-viewer-resize');
  const tabBar = document.getElementById('code-viewer-tabs');
  const editBtn = document.getElementById('code-viewer-edit-btn');
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const discardBtn = document.getElementById('code-viewer-discard-btn');
  const dockBtn = document.getElementById('cv-dock-btn');
  if (!panel || !header) return;

  // Apply initial docked state
  if (_cvDocked) {
    panel.classList.add('cv-docked');
  } else {
    panel.classList.remove('cv-docked');
  }

  // Mode selector
  const modeSelect = document.getElementById('code-viewer-mode');
  if (modeSelect) {
    modeSelect.value = _cvMode;
    modeSelect.addEventListener('change', () => {
      _cvMode = modeSelect.value;
      localStorage.setItem('cv-mode', _cvMode);
      if (_cvMode === 'off') {
        _cvClosePanel(panel);
        _cvPendingCount = 0;
        _cvUpdatePendingBadge();
      } else {
        _cvUpdatePendingBadge();
      }
    });
    modeSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Restore floating position/size (only applied when floating)
  if (!_cvDocked) {
    try {
      const saved = JSON.parse(localStorage.getItem('_codeViewerPos') || '{}');
      if (saved.x != null && saved.y != null) {
        panel.style.left = saved.x + 'px'; panel.style.top = saved.y + 'px';
      }
      if (saved.w) panel.style.width = saved.w + 'px';
      if (saved.h) panel.style.height = saved.h + 'px';
    } catch { }
  }

  function savePos() {
    if (_cvDocked) return;
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem('_codeViewerPos', JSON.stringify({
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      }));
    } catch { }
  }

  // Dragging (only when floating)
  let dragX, dragY, startX, startY;
  header.addEventListener('mousedown', (e) => {
    if (_cvDocked) return;
    if (e.target.closest('button') || e.target.closest('select')) return;
    e.preventDefault();
    dragX = e.clientX; dragY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startX = rect.left; startY = rect.top;
    const onMove = (ev) => {
      panel.style.left = (startX + ev.clientX - dragX) + 'px';
      panel.style.top = (startY + ev.clientY - dragY) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); savePos(); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click header to toggle docked/floating
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('select')) return;
    _cvSetDocked(!_cvDocked);
  });

  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e) => {
      if (_cvDocked) return;
      e.preventDefault(); e.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const onMove = (ev) => {
        const w = Math.max(400, ev.clientX - rect.left);
        const h = Math.max(250, ev.clientY - rect.top);
        panel.style.width = w + 'px'; panel.style.height = h + 'px';
        if (_cvAceEditor) _cvAceEditor.resize();
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); savePos(); if (_cvAceEditor) _cvAceEditor.resize(); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', () => _cvClosePanel(panel));

  // Dock button (only visible when floating)
  if (dockBtn) {
    dockBtn.addEventListener('click', () => _cvSetDocked(true));
  }

  // Edit / Save / Discard buttons
  if (editBtn) editBtn.addEventListener('click', _cvEnterEditMode);
  if (saveBtn) saveBtn.addEventListener('click', _cvSave);
  if (discardBtn) discardBtn.addEventListener('click', () => _cvExitEditMode(false));

  // Tab clicks
  if (tabBar) tabBar.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-cv-close]');
    if (closeEl) {
      if (_cvEditing) _cvExitEditMode(false);
      _cvCloseTab(closeEl.dataset.cvClose);
      return;
    }
    const tabEl = e.target.closest('[data-cv-tab]');
    if (tabEl) {
      if (_cvEditing) _cvExitEditMode(false);
      _cvSwitchTab(tabEl.dataset.cvTab);
    }
  });

  const pendingBtn = document.getElementById('cv-pending-badge');
  if (pendingBtn) {
    pendingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      _cvShowFromBadge();
    });
  }

  _initCanvasTabs();
  _cvUpdatePendingBadge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initCodeViewer);
} else {
  _initCodeViewer();
}

const MEDIA_EXTS = {
  image: ['png','jpg','jpeg','gif','webp','svg','avif','bmp'],
  video: ['mp4','webm','mov','avi','mkv'],
  audio: ['mp3','wav','ogg','flac','m4a','aac'],
};

// Normalize any media URL string to a same-origin URL the current UI can load.
// This makes media rendering robust across topologies (localhost, reverse proxy,
// tunnels, subpath mounts): the agent can emit absolute or relative URLs and the
// UI rewrites them to resolve against whichever origin served the chat.
function resolveAnimaMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return url;

  let parsed;
  try { parsed = new URL(url, window.location.href); } catch { return url; }

  // 1. Any /workspace/<rest> path (regardless of origin) → same-origin /files/<rest>
  const wsIdx = parsed.pathname.indexOf('/workspace/');
  if (wsIdx !== -1) {
    const rel = parsed.pathname.slice(wsIdx + '/workspace/'.length);
    return `${API}/files/${rel}${parsed.search}`;
  }

  // 2. Already same-origin → trust it
  if (parsed.origin === window.location.origin) return url;

  // 3. Cross-origin but points at a "local" hostname → rewrite to same-origin /files/.
  // Any path served from a localhost origin is treated as a workspace file: either
  // after an explicit /files/ segment, or (when the agent served it via its own port
  // with no prefix) the full pathname as the file key.
  const host = parsed.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocalHost) {
    const filesIdx = parsed.pathname.lastIndexOf('/files/');
    if (filesIdx !== -1) {
      const rel = parsed.pathname.slice(filesIdx + '/files/'.length);
      return `${API}/files/${rel}${parsed.search}`;
    }
    // Bare http://localhost:PORT/foo.png → web_serve static root (/workspace/web/)
    const rel = parsed.pathname.replace(/^\/+/, '');
    if (rel) return `${API}/files/web/${rel}${parsed.search}`;
  }

  // 4. External URL (CDN, YouTube, etc.) — leave alone
  return url;
}

function detectMediaInText(text) {
  // Match /workspace/... paths (internal) and absolute URLs ending in a known media ext.
  const patterns = [
    /[`'("<]?(\/workspace\/[^\s"'<>`)]+\.(\w+))[`'")>]?/gi,
    /[`'("<]?(https?:\/\/[^\s"'<>`)]+\.(\w+))[`'")>]?/gi,
  ];
  const found = [];
  const seen = new Set();
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[1];
      const ext = m[2].toLowerCase();
      if (seen.has(raw)) continue;
      let type = null;
      if (MEDIA_EXTS.image.includes(ext)) type = 'image';
      else if (MEDIA_EXTS.video.includes(ext)) type = 'video';
      else if (MEDIA_EXTS.audio.includes(ext)) type = 'audio';
      if (!type) continue;
      const resolved = resolveAnimaMediaUrl(raw);
      seen.add(raw);
      found.push({ url: resolved, type, raw });
    }
  }
  return found;
}

// Walk an HTML string and rewrite media src attributes through resolveAnimaMediaUrl.
// Heals markdown-rendered <img>/<video>/<audio> that contain baked-in absolute URLs.
function rewriteMediaUrlsInHtml(html) {
  if (!html || typeof html !== 'string') return html;
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  tmpl.content.querySelectorAll('img, video, audio, source').forEach(el => {
    const src = el.getAttribute('src');
    if (src) {
      const fixed = resolveAnimaMediaUrl(src);
      if (fixed !== src) el.setAttribute('src', fixed);
    }
    const poster = el.getAttribute('poster');
    if (poster) {
      const fixed = resolveAnimaMediaUrl(poster);
      if (fixed !== poster) el.setAttribute('poster', fixed);
    }
  });
  return tmpl.innerHTML;
}

function renderMediaHtml(media) {
  return media.map(m => {
    if (m.type === 'image') return `<img src="${esc(m.url)}" alt="image" loading="lazy" onclick="window.open(this.src,'_blank')">`;
    if (m.type === 'video') return `<video src="${esc(m.url)}" controls preload="metadata"></video>`;
    if (m.type === 'audio') return `<audio src="${esc(m.url)}" controls preload="metadata"></audio>`;
    return '';
  }).join('');
}

const _markedRenderer = (() => {
  if (typeof marked === 'undefined') return null;
  const renderer = new marked.Renderer();
  renderer.link = function({ href, title, text }) {
    const t = title ? ` title="${esc(title)}"` : '';
    return `<a href="${esc(href)}"${t} target="_blank" rel="noopener">${text}</a>`;
  };
  renderer.code = function({ text, lang }) {
    if (lang === 'diff' || (!lang && text.match(/^[+-@]/m) && text.includes('@@'))) {
      const lines = text.split('\n').map(line => {
        const cls = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : 'context';
        return `<div class="diff-line ${cls}">${esc(line)}</div>`;
      }).join('');
      return `<div class="diff-block">${lines}</div>`;
    }
    const language = lang && Prism.languages[lang] ? lang : '';
    const label = lang ? `<div style="display:flex;justify-content:flex-end;padding:4px 10px 0;font-family:var(--font-mono);font-size:.58rem;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;user-select:none">${esc(lang)}</div>` : '';
    if (language) {
      const highlighted = Prism.highlight(text, Prism.languages[language], language);
      return `<pre class="language-${language}">${label}<code class="language-${language}">${highlighted}</code></pre>`;
    }
    return `<pre>${label}<code>${esc(text)}</code></pre>`;
  };
  marked.setOptions({
    renderer,
    gfm: true,
    breaks: true,
  });
  return renderer;
})();

function renderMarkdown(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    let raw = marked.parse(text);
    raw = raw.replace(/(^|[^"'>])(https?:\/\/[^\s<"']+)/g, (m, pre, url) => {
      if (pre.endsWith('href="') || pre.endsWith("href='") || pre.endsWith('src="')) return m;
      return `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
    });
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
      ALLOWED_TAGS: ['p','br','strong','em','a','code','pre','h1','h2','h3','h4','h5','h6',
        'ul','ol','li','blockquote','table','thead','tbody','tr','th','td','hr','del','span','div','img','video','audio'],
    });
  }
  let s = esc(text);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function _formatUsageTag(usage, iterations) {
  const inTok = (usage.input_tokens||0).toLocaleString();
  const outTok = (usage.output_tokens||0).toLocaleString();
  const iters = iterations || 1;
  const cached = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  let cacheHint = '';
  if (cached > 0 || cacheWrite > 0) {
    const total = (usage.input_tokens||0);
    const pct = total > 0 ? Math.round(cached / total * 100) : 0;
    cacheHint = ` · ${pct}% cached`;
  }
  return `<span class="usage-tag">${inTok} in / ${outTok} out · ${iters} iteration${iters>1?'s':''}${cacheHint}</span>`;
}

function formatAssistantMsg(text, meta) {
  let html = rewriteMediaUrlsInHtml(renderMarkdown(text));
  const media = detectMediaInText(text);
  if (media.length) {
    html += '<div class="media-grid">' + renderMediaHtml(media) + '</div>';
  }
  if (meta?.toolUsage && typeof meta.toolUsage === 'object') {
    const entries = Object.entries(meta.toolUsage);
    if (entries.length) {
      html += '<div style="margin-top:8px">';
      for (const [tool, count] of entries) {
        html += `<span class="tool-tag">${esc(tool)}${count > 1 ? ' ×' + count : ''}</span>`;
      }
      html += '</div>';
    }
  }
  if (meta?.usage) {
    html += _formatUsageTag(meta.usage, meta.iterations);
  }
  return html;
}

// Avatars for the chat row. Assistant uses the F01 spore mark (inherits
// brand.chatLogo if present, falls back to an inline SVG). User gets a
// generic person silhouette.
const _USER_AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';
function _assistantAvatarHtml() {
  if (window.BRAND && window.BRAND.chatLogo) return window.BRAND.chatLogo;
  // Fallback F01 mark (small).
  return '<svg viewBox="-1 -1 2 2" aria-hidden="true"><g stroke="currentColor" stroke-width="0.06" stroke-linecap="round"><line x1="0" y1="0" x2="0" y2="-0.62"/><line x1="0" y1="0" x2="0.5369" y2="-0.31"/><line x1="0" y1="0" x2="0.5369" y2="0.31"/><line x1="0" y1="0" x2="0" y2="0.62"/><line x1="0" y1="0" x2="-0.5369" y2="0.31"/><line x1="0" y1="0" x2="-0.5369" y2="-0.31"/></g><g fill="#c8762c"><circle cx="0" cy="-0.62" r="0.18"/><circle cx="0.5369" cy="-0.31" r="0.18"/><circle cx="0.5369" cy="0.31" r="0.18"/><circle cx="0" cy="0.62" r="0.18"/><circle cx="-0.5369" cy="0.31" r="0.18"/><circle cx="-0.5369" cy="-0.31" r="0.18"/></g><circle cx="0" cy="0" r="0.2" fill="currentColor"/></svg>';
}
// Wrap a user/assistant bubble in a row with an avatar. Returns the row.
// Pass-through for system/agent/etc. roles — they don't get avatars.
function _wrapChatBubble(bubbleEl, role) {
  if (role !== 'user' && role !== 'assistant') return bubbleEl;
  const row = document.createElement('div');
  row.className = 'chat-row ' + role;
  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar ' + role;
  avatar.innerHTML = role === 'assistant' ? _assistantAvatarHtml() : _USER_AVATAR_SVG;
  // row-reverse on .user already places the avatar on the right; we just
  // append in the same order both ways.
  row.appendChild(avatar);
  row.appendChild(bubbleEl);
  return row;
}

function addChatMessage(role, text, attachments) {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  el.textContent = text;
  if (attachments?.length && role === 'user') {
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const a of attachments) {
      if (a.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        img.alt = a.name;
        grid.appendChild(img);
      } else if (a.type.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = a.dataUrl; vid.controls = true; vid.preload = 'metadata';
        grid.appendChild(vid);
      } else if (a.type.startsWith('audio/')) {
        const aud = document.createElement('audio');
        aud.src = a.dataUrl; aud.controls = true; aud.preload = 'metadata';
        grid.appendChild(aud);
      }
    }
    el.appendChild(grid);
  }
  const wasAtBottom = chatShouldAutoScroll();
  container.appendChild(_wrapChatBubble(el, role));
  _syncAssistantRowVisibility(el);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  return el;
}

function showTyping(show) {
  let el = document.querySelector('.chat-typing');
  if (show && !el) {
    el = document.createElement('div');
    el.className = 'chat-typing';
    el.innerHTML = 'thinking<span class="dots"></span>';
    document.getElementById('chat-messages').appendChild(el);
  } else if (!show && el) {
    el.remove();
  }
}
