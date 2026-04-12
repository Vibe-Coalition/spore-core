/**
 * gateways/pairing.js — Pairing Store
 *
 * Handles the pairing flow for Telegram and future channels:
 *   1. Stranger DMs the bot → gets a code (e.g. "HARRY-A3K7")
 *   2. Owner approves via HTTP API or Discord command
 *   3. Approved ID is stored and bot responds to them going forward
 *
 * Persisted to /data/pairing.json (inside the agent's data volume).
 *
 * Approval methods:
 *   POST /api/pairing/approve  { channel, code }
 *   GET  /api/pairing/pending
 *   POST /api/pairing/revoke   { channel, id }
 *   Or: tell the agent "approve telegram XXXX-XXXX"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_PER_CHANNEL = 10;

class PairingStore {
  constructor(dataDir, logger) {
    this.dataDir = dataDir;
    this.log = logger;
    this.filePath = path.join(dataDir, 'pairing.json');
    this._store = null;
    this._dirty = false;
    this._saveTimer = null;
  }

  // ── Init ────────────────────────────────────────────────────────

  init() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this._store = JSON.parse(raw);
        this._migrate();
      } else {
        this._store = this._empty();
      }
      this._pruneExpired();
      this._save();
      this.log.info(`[pairing] Store loaded (${this._totalPending()} pending, ${this._totalApproved()} approved)`);
      return true;
    } catch (e) {
      this.log.error('[pairing] Failed to initialize pairing store:', e.message);
      this._store = this._empty();
      return false;
    }
  }

  _empty() {
    return { version: 1, pending: {}, approved: {} };
  }

  _migrate() {
    if (!this._store.version) this._store.version = 1;
    if (!this._store.pending) this._store.pending = {};
    if (!this._store.approved) this._store.approved = {};
  }

  // ── Queries ─────────────────────────────────────────────────────

  isApproved(channel, id) {
    const list = this._store.approved[channel] || [];
    return list.includes(String(id));
  }

  listPending(channel) {
    if (channel) {
      this._pruneExpiredForChannel(channel);
      return (this._store.pending[channel] || []).slice();
    }
    this._pruneExpired();
    const out = {};
    for (const [ch, reqs] of Object.entries(this._store.pending)) {
      if (reqs.length) out[ch] = reqs.slice();
    }
    return out;
  }

  listApproved(channel) {
    if (channel) return (this._store.approved[channel] || []).slice();
    return JSON.parse(JSON.stringify(this._store.approved));
  }

  // ── Mutations ────────────────────────────────────────────────────

  /**
   * Called when a DM arrives from an unpaired user.
   * Creates a new pending request if one doesn't exist, or bumps lastSeenAt.
   * Returns { code, created, alreadyPending }.
   */
  upsertRequest(channel, senderId, meta = {}) {
    const ch = String(channel);
    const id = String(senderId);
    if (!this._store.pending[ch]) this._store.pending[ch] = [];

    this._pruneExpiredForChannel(ch);

    const existing = this._store.pending[ch].find(r => r.id === id);
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      if (meta.name && !existing.meta?.name) {
        existing.meta = { ...(existing.meta || {}), ...meta };
      }
      this._scheduleSave();
      return { code: existing.code, created: false, alreadyPending: true };
    }

    // Cap pending requests per channel
    if (this._store.pending[ch].length >= MAX_PENDING_PER_CHANNEL) {
      // Remove oldest
      this._store.pending[ch].sort((a, b) => (a.lastSeenAt || a.createdAt).localeCompare(b.lastSeenAt || b.createdAt));
      this._store.pending[ch].shift();
    }

    const code = this._generateCode(ch);
    const now = new Date().toISOString();
    this._store.pending[ch].push({ id, code, createdAt: now, lastSeenAt: now, meta });
    this._scheduleSave();
    return { code, created: true, alreadyPending: false };
  }

  /**
   * Owner approves a code. Returns { id, channel, meta } or null if not found/expired.
   */
  approveCode(code) {
    const normalized = String(code).toUpperCase().replace(/[-\s]/g, '');
    for (const [ch, reqs] of Object.entries(this._store.pending)) {
      const idx = reqs.findIndex(r => r.code.replace(/[-\s]/g, '') === normalized);
      if (idx < 0) continue;
      const req = reqs[idx];
      if (this._isExpired(req)) {
        reqs.splice(idx, 1);
        this._scheduleSave();
        return null;
      }
      reqs.splice(idx, 1);
      if (!this._store.approved[ch]) this._store.approved[ch] = [];
      if (!this._store.approved[ch].includes(req.id)) {
        this._store.approved[ch].push(req.id);
      }
      this._scheduleSave();
      this.log.info(`[pairing] Approved ${req.id} on ${ch} (was: ${req.meta?.name || 'unknown'})`);
      return { id: req.id, channel: ch, meta: req.meta || {} };
    }
    return null;
  }

  /**
   * Approve by channel + code (for HTTP API that specifies channel).
   */
  approveCodeForChannel(channel, code) {
    const ch = String(channel);
    const normalized = String(code).toUpperCase().replace(/[-\s]/g, '');
    const reqs = this._store.pending[ch] || [];
    const idx = reqs.findIndex(r => r.code.replace(/[-\s]/g, '') === normalized);
    if (idx < 0) return null;
    const req = reqs[idx];
    if (this._isExpired(req)) {
      reqs.splice(idx, 1);
      this._scheduleSave();
      return null;
    }
    reqs.splice(idx, 1);
    if (!this._store.approved[ch]) this._store.approved[ch] = [];
    if (!this._store.approved[ch].includes(req.id)) {
      this._store.approved[ch].push(req.id);
    }
    this._scheduleSave();
    this.log.info(`[pairing] Approved ${req.id} on ${ch}`);
    return { id: req.id, channel: ch, meta: req.meta || {} };
  }

  /**
   * Revoke an approved ID. Returns true if it was found.
   */
  revokeApproved(channel, id) {
    const ch = String(channel);
    const normalized = String(id);
    const list = this._store.approved[ch] || [];
    const idx = list.indexOf(normalized);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this._scheduleSave();
    this.log.info(`[pairing] Revoked ${normalized} on ${ch}`);
    return true;
  }

  /**
   * Deny / remove a pending request without approving.
   */
  denyPending(channel, id) {
    const ch = String(channel);
    const reqs = this._store.pending[ch] || [];
    const idx = reqs.findIndex(r => r.id === String(id));
    if (idx < 0) return false;
    reqs.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  // ── Internal ─────────────────────────────────────────────────────

  _generateCode(channel) {
    const existing = new Set((this._store.pending[channel] || []).map(r => r.code));
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
      }
      // Format as XXXX-XXXX for readability
      const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
      if (!existing.has(formatted)) return formatted;
    }
    throw new Error('[pairing] Failed to generate unique code');
  }

  _isExpired(req) {
    const created = Date.parse(req.createdAt);
    return isNaN(created) || Date.now() - created > CODE_TTL_MS;
  }

  _pruneExpiredForChannel(channel) {
    const reqs = this._store.pending[channel];
    if (!reqs) return;
    const before = reqs.length;
    this._store.pending[channel] = reqs.filter(r => !this._isExpired(r));
    if (this._store.pending[channel].length !== before) this._dirty = true;
  }

  _pruneExpired() {
    for (const ch of Object.keys(this._store.pending)) {
      this._pruneExpiredForChannel(ch);
    }
  }

  _totalPending() {
    return Object.values(this._store.pending).reduce((n, arr) => n + arr.length, 0);
  }

  _totalApproved() {
    return Object.values(this._store.approved).reduce((n, arr) => n + arr.length, 0);
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 200);
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._store, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
    } catch (e) {
      this.log.error('[pairing] Failed to save pairing store:', e.message);
    }
  }

  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this._save();
  }

  // ── HTTP handlers ─────────────────────────────────────────────────

  handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const authToken = process.env.MANAGER_SERVICE_KEY;
    if (authToken) {
      const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!provided || provided.length !== authToken.length ||
          !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(authToken))) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return true;
      }
    }

    if (url.pathname === '/api/pairing/pending' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.listPending(), null, 2));
      return true;
    }

    if (url.pathname === '/api/pairing/approved' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.listApproved(), null, 2));
      return true;
    }

    if (url.pathname === '/api/pairing/approve' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { channel, code } = JSON.parse(body || '{}');
          const result = channel
            ? this.approveCodeForChannel(channel, code)
            : this.approveCode(code);
          if (!result) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Code not found or expired' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    if (url.pathname === '/api/pairing/revoke' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { channel, id } = JSON.parse(body || '{}');
          const ok = this.revokeApproved(channel, id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return true;
    }

    return false;
  }
}

module.exports = { PairingStore };
