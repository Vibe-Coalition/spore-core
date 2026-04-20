/**
 * chatroom.js — Shared Chat Room Gateway
 *
 * WebSocket client that connects to the manager's chatroom hub.
 * Implements Discord-style lull system for multi-agent/user chat:
 *   - Direct triggers (@mention) → immediate agent invocation
 *   - Passive messages → lull timer, then decide whether to respond
 *   - Anti-pile-on jitter → stagger responses from multiple animas
 *   - NO_REPLY gating → agent can opt out silently
 */

const WebSocket = require('ws');

const LULL_DELAY_MS = 15_000;
const DIRECT_DEBOUNCE_MS = 1200;
const BASE_JITTER_MS = 2000;
const MAX_JITTER_MS = 8000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_QUEUE_SIZE = 10;

class ChatroomGateway {
  constructor(agent, config, log, managerUrl, serviceKey) {
    this.agent = agent;
    this.config = config;
    this.log = log;
    this.managerUrl = managerUrl.replace(/\/$/, '');
    this.serviceKey = serviceKey || '';
    this.agentId = config.agentId;
    this.displayName = config.displayName || config.agentId;

    this._ws = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._closed = false;

    this._queue = [];
    this._processing = false;
    this._lullTimer = null;
    this._directDebounceTimer = null;
    this._recentAnimaResponses = 0;
    this._recentAnimaResponseTimer = null;
    this._participants = new Map();
  }

  connect() {
    if (this._closed) return;
    const wsUrl = this.managerUrl.replace(/^http/, 'ws') + '/ws/chatroom';

    try {
      this._ws = new WebSocket(wsUrl, {
        headers: {
          'x-service-key': this.serviceKey,
          'x-agent-id': this.agentId,
          'x-agent-name': this.displayName,
        },
      });
    } catch (e) {
      this.log.warn(`[chatroom] Failed to create WebSocket: ${e.message}`);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._reconnectAttempts = 0;
      this.log.info(`[chatroom] Connected to manager chatroom hub`);
      this._startHeartbeat();
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._onMessage(msg);
      } catch (e) {
        this.log.warn(`[chatroom] Bad message: ${e.message}`);
      }
    });

    this._ws.on('close', (code) => {
      this.log.info(`[chatroom] Disconnected (code ${code})`);
      this._stopHeartbeat();
      if (!this._closed) this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this.log.warn(`[chatroom] WebSocket error: ${err.message}`);
    });
  }

  disconnect() {
    this._closed = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._lullTimer) clearTimeout(this._lullTimer);
    if (this._directDebounceTimer) clearTimeout(this._directDebounceTimer);
    if (this._ws) {
      try { this._ws.close(1000); } catch {}
      this._ws = null;
    }
  }

  _scheduleReconnect() {
    if (this._closed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(1.5, this._reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this._reconnectAttempts++;
    this.log.info(`[chatroom] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Message handling ────────────────────────────────────────────────

  _onMessage(msg) {
    if (msg.type === 'history') {
      return;
    }

    if (msg.type === 'presence') {
      this._participants.set(msg.id, { name: msg.name, type: msg.authorType });
      return;
    }

    if (msg.type === 'leave') {
      this._participants.delete(msg.id);
      return;
    }

    if (msg.type !== 'chat') return;

    if (msg.authorId === this.agentId) return;

    const nicknames = this.config.nicknames || [this.agentId];
    const allNames = [this.displayName.toLowerCase(), ...nicknames.map(n => n.toLowerCase())];
    const contentLower = (msg.content || '').toLowerCase();
    const isDirect = allNames.some(n => contentLower.includes(`@${n}`)) ||
                     contentLower.includes(`@${this.agentId}`);

    const item = {
      content: msg.content || '',
      authorId: msg.authorId,
      authorName: msg.authorName,
      authorType: msg.authorType,
      messageId: msg.id,
      isDirect,
      trigger: isDirect ? 'mention' : 'passive',
      ts: Date.now(),
    };

    if (this._queue.length >= MAX_QUEUE_SIZE) {
      this._queue.shift();
    }
    this._queue.push(item);

    if (isDirect) {
      if (this._lullTimer) { clearTimeout(this._lullTimer); this._lullTimer = null; }
      if (this._directDebounceTimer) clearTimeout(this._directDebounceTimer);
      this._directDebounceTimer = setTimeout(() => this._processQueue(), DIRECT_DEBOUNCE_MS);
    } else {
      if (this._lullTimer) clearTimeout(this._lullTimer);
      this._lullTimer = setTimeout(() => this._processQueue(), LULL_DELAY_MS);
    }
  }

  async _processQueue() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;

    try {
      const items = this._queue.splice(0);
      const hasDirect = items.some(i => i.isDirect);
      const trigger = hasDirect ? 'mention' : 'lull';

      const jitterMs = this._calculateJitter(hasDirect);
      if (jitterMs > 0) {
        await new Promise(r => setTimeout(r, jitterMs));
      }

      const merged = items.map(i => {
        const prefix = i.authorType === 'spore' ? `[${i.authorName}]` : `[${i.authorName}]`;
        return `${prefix} ${i.content}`;
      }).join('\n');

      const lastItem = items[items.length - 1];

      this._sendTyping();
      this._sendStatus('thinking');
      const typingHeartbeat = setInterval(() => this._sendTyping(), 3000);

      const sessionKey = `chatroom:shared`;
      let result;
      try {
        result = await this.agent.processMessage({
          content: merged,
          channelId: sessionKey,
          channelName: 'chatroom',
          userId: lastItem.authorId,
          userName: lastItem.authorName,
          trigger,
          platform: 'chatroom',
          isDm: false,
          suppressLearning: trigger === 'lull',
          onTextDelta: null,
          onError: (err) => {
            this.log.error(`[chatroom] Agent error: ${err.message}`);
          },
        });
      } finally {
        clearInterval(typingHeartbeat);
        this._sendStatus(null);
      }

      if (result?.text && result.text.trim() && result.text.trim() !== 'NO_REPLY') {
        this._sendChat(result.text);
        this._trackAnimaResponse();
      } else {
        this.log.debug(`[chatroom] ${trigger}: no visible response`);
      }
    } catch (e) {
      this.log.error(`[chatroom] Process error: ${e.message}`);
    } finally {
      this._processing = false;
      if (this._queue.length > 0) {
        const nextDelay = this._queue.some(i => i.isDirect) ? DIRECT_DEBOUNCE_MS : 2000;
        setTimeout(() => this._processQueue(), nextDelay);
      }
    }
  }

  _calculateJitter(isDirect) {
    if (isDirect) return Math.random() * 1000;
    const base = BASE_JITTER_MS + (this._recentAnimaResponses * 2000);
    return Math.min(base + Math.random() * 3000, MAX_JITTER_MS);
  }

  _trackAnimaResponse() {
    this._recentAnimaResponses++;
    if (this._recentAnimaResponseTimer) clearTimeout(this._recentAnimaResponseTimer);
    this._recentAnimaResponseTimer = setTimeout(() => {
      this._recentAnimaResponses = 0;
    }, 30_000);
  }

  _sendChat(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      type: 'chat',
      content: text,
    }));
  }

  _sendTyping() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'typing' }));
  }

  _sendStatus(status) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'status', status }));
  }
}

module.exports = { ChatroomGateway };
