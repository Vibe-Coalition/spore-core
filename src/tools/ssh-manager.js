/**
 * ssh-manager.js — SSH Manager (Sidecar Client + Local Fallback)
 *
 * When the ssh-sidecar plugin is installed and a sidecar socket is available
 * at /run/ssh-sidecar/sidecar.sock, saved-host operations and interactive SSH
 * sessions are delegated to the isolated sidecar process. Decrypted keys for
 * those flows never enter this process.
 *
 * When no sidecar is detected, falls back to in-process mode with
 * AES-256-GCM encrypted key storage (Phase 1 behavior).
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SIDECAR_SOCKET = '/run/ssh-sidecar/sidecar.sock';
const PBKDF2_ITERATIONS = 100000;
const ALGORITHM = 'aes-256-gcm';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class SSHManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this._auditStream = null;
    this._rpcId = 0;
    this._pending = new Map();
    this._sidecarConn = null;
    this._sidecarReady = false;
    this._sidecarSocket = config.sshSidecarSocket || process.env.SIDECAR_SOCKET || DEFAULT_SIDECAR_SOCKET;
    this._eventHandlers = new Map();
    this._buffer = '';
    this._closing = false;

    // Paths derived from config
    this._storeFile = path.join(config.dataDir, 'ssh-hosts.json');
    this._auditLogPath = path.join(config.dataDir, 'terminal-audit.log');

    // Local fallback state
    this._localMode = false;
    this._encryptionKey = null;
    this.hosts = [];
    this._sidecarHostRefreshInFlight = null;
    this._activeSessions = new Map();

    this._initAuditLog();
    this._connectSidecar();
  }

  // ── Sidecar Connection ──────────────────────────────────────────────

  _connectSidecar() {
    if (this.config.sshSidecarEnabled !== true) {
      this.log.info('[ssh] SSH sidecar plugin inactive — running in local (in-process) mode');
      this._initLocal();
      return;
    }

    if (!fs.existsSync(this._sidecarSocket)) {
      this.log.info('[ssh] SSH sidecar plugin active, but no socket found — running in local (in-process) mode');
      this._initLocal();
      return;
    }

    this._sidecarConn = net.createConnection(this._sidecarSocket);

    this._sidecarConn.on('connect', () => {
      this._sidecarReady = true;
      this._localMode = false;
      this.log.info('[ssh] Connected to credential isolation sidecar');
      this._refreshSidecarHosts().catch(e => {
        this.log.warn('[ssh] Failed to refresh sidecar host cache: ' + e.message);
      });
    });

    this._sidecarConn.on('data', (chunk) => {
      this._buffer += chunk.toString();
      let nl;
      while ((nl = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, nl).trim();
        this._buffer = this._buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this._pending.has(msg.id)) {
            const { resolve } = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            resolve(msg.error ? { _error: msg.error } : msg.result);
          } else if (msg.type) {
            const handlers = this._eventHandlers.get(msg.sessionId);
            if (handlers) {
              if (msg.type === 'session.data') handlers.onData?.(msg.data);
              else if (msg.type === 'session.opened') handlers.onReady?.(msg.sessionId);
              else if (msg.type === 'session.closed') handlers.onClose?.();
              else if (msg.type === 'session.error') handlers.onError?.(msg.error);
            }
          }
        } catch (e) { this.log.warn('[ssh-manager] JSON.parse failed: ' + e.message); }
      }
    });

    this._sidecarConn.on('error', (e) => {
      this.log.warn(`[ssh] Sidecar connection error: ${e.message} — falling back to local mode`);
      this._sidecarReady = false;
      this._initLocal();
    });

    this._sidecarConn.on('close', () => {
      this._sidecarReady = false;
      if (!this._closing) {
        this.log.warn('[ssh] Sidecar disconnected — falling back to local mode');
        if (!this._localMode) this._initLocal();
      }
    });
  }

  _rpc(method, params = {}) {
    if (!this._sidecarReady) return Promise.resolve({ _error: 'Sidecar not connected' });
    return new Promise((resolve) => {
      const id = ++this._rpcId;
      const timer = setTimeout(() => { this._pending.delete(id); resolve({ _error: 'Timeout' }); }, 30000);
      this._pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, timer });
      try { this._sidecarConn.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); resolve({ _error: e.message }); }
    });
  }

  async _sidecarRpcOrThrow(method, params = {}) {
    const r = await this._rpc(method, params);
    if (r?._error) throw new Error(r._error);
    return r;
  }

  async _refreshSidecarHosts() {
    if (this._localMode || !this._sidecarReady) return this.hosts;
    if (this._sidecarHostRefreshInFlight) return this._sidecarHostRefreshInFlight;
    this._sidecarHostRefreshInFlight = (async () => {
      const r = await this._rpc('hosts.list');
      if (r?._error) throw new Error(r._error);
      this.hosts = Array.isArray(r) ? r : [];
      return this.hosts;
    })().finally(() => {
      this._sidecarHostRefreshInFlight = null;
    });
    return this._sidecarHostRefreshInFlight;
  }

  getKnownHosts() {
    return Array.isArray(this.hosts) ? this.hosts : [];
  }

  _normalizeHostRef(value) {
    if (value == null) return '';
    let ref = String(value).trim();
    if (!ref) return '';
    ref = ref.replace(/^ssh:\/\//i, '');
    ref = ref.replace(/\/.*$/, '');
    return ref.toLowerCase();
  }

  _hostAliases(host = {}) {
    const aliases = new Set();
    const add = (value) => {
      const normalized = this._normalizeHostRef(value);
      if (normalized) aliases.add(normalized);
    };
    add(host.id);
    add(host.name);
    add(host.hostname);
    const hostname = String(host.hostname || '').trim();
    const shortHost = hostname.includes('.') ? hostname.split('.')[0] : hostname;
    add(shortHost);
    if (host.username && hostname) {
      add(`${host.username}@${hostname}`);
      add(`${host.username}@${shortHost}`);
      if (host.port) add(`${host.username}@${hostname}:${host.port}`);
    }
    if (hostname && host.port) add(`${hostname}:${host.port}`);
    return [...aliases];
  }

  _knownHostHint() {
    const hosts = this.getKnownHosts();
    if (!hosts.length) {
      return 'No SSH hosts are configured. Add a host in the SSH Sidecar plugin settings first.';
    }
    const items = hosts.map(h => {
      const aliases = this._hostAliases(h)
        .filter(a => a !== this._normalizeHostRef(h.id))
        .slice(0, 5);
      return aliases.length ? `${h.id} (aliases: ${aliases.join(', ')})` : String(h.id);
    });
    return `Available SSH host IDs/aliases: ${items.join('; ')}`;
  }

  _unknownHostMessage(hostRef) {
    return `Unknown host: ${hostRef}. ${this._knownHostHint()}. Use a saved host ID or alias from the remote tool catalog; do not shell out to ssh or tailscale ssh for configured hosts.`;
  }

  _resolveHostRefSync(hostRef) {
    const target = this._normalizeHostRef(hostRef);
    if (!target) return null;
    for (const host of this.getKnownHosts()) {
      if (this._hostAliases(host).includes(target)) return host.id;
    }
    return null;
  }

  async _resolveHostRef(hostRef) {
    if (!this._localMode) {
      try { await this._refreshSidecarHosts(); }
      catch (e) { this.log.warn('[ssh] Failed to refresh sidecar hosts before host resolution: ' + e.message); }
    }
    const resolved = this._resolveHostRefSync(hostRef);
    if (!resolved) throw new Error(this._unknownHostMessage(hostRef));
    return resolved;
  }

  supportsTunnels() {
    return this._localMode;
  }

  isSidecarReady() {
    return this.config.sshSidecarEnabled === true && this._sidecarReady && !this._localMode;
  }

  async waitForSidecarReady(timeoutMs = 1000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      if (this.isSidecarReady()) return true;
      if (this.config.sshSidecarEnabled !== true || !fs.existsSync(this._sidecarSocket)) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    return this.isSidecarReady();
  }

  getStatus() {
    return {
      sidecarEnabled: this.config.sshSidecarEnabled === true,
      sidecarReady: this._sidecarReady,
      localMode: this._localMode,
      socketPath: this._sidecarSocket,
      socketPresent: fs.existsSync(this._sidecarSocket),
      keystoreUnlocked: this.keystoreUnlocked,
      keystoreSource: this.keystoreSource || null,
      hostCount: this.hosts.length,
      activeSessionCount: this._activeSessions.size,
      tunnelCount: this._tunnels ? this._tunnels.size : 0,
    };
  }

  reconnectSidecar(socketPath = null) {
    if (socketPath) this._sidecarSocket = socketPath;
    this._closing = true;
    if (this._sidecarConn) {
      try { this._sidecarConn.end(); } catch {}
      try { this._sidecarConn.destroy(); } catch {}
    }
    this._sidecarConn = null;
    this._sidecarReady = false;
    this._localMode = false;
    this._closing = false;
    this._connectSidecar();
    return this.getStatus();
  }

  // ── Local Fallback ──────────────────────────────────────────────────

  _initLocal() {
    this._localMode = true;
    this._deriveKey();
    this._loadHosts();
  }

  _deriveKey() {
    const passphrase = this.config.webAuthPass;
    if (passphrase) {
      this._encryptionKey = crypto.pbkdf2Sync(passphrase, 'spore-ssh-keystore-v1', PBKDF2_ITERATIONS, 32, 'sha256');
      this._keystoreSource = 'webAuthPass';
      this.log.info('[ssh] Keystore encryption derived from webAuthPass');
    } else {
      this._encryptionKey = null;
      this._keystoreSource = null;
      this.log.info('[ssh] No webAuthPass — keystore locked until unlocked via UI passphrase');
    }
  }

  unlockKeystore(passphrase) {
    if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
      throw new Error('Keystore passphrase must be at least 8 characters');
    }
    this._encryptionKey = crypto.pbkdf2Sync(passphrase, 'spore-ssh-keystore-v1', PBKDF2_ITERATIONS, 32, 'sha256');
    this._keystoreSource = 'ui-passphrase';
    this.log.info('[ssh] Keystore unlocked via UI passphrase (held in memory only)');
  }

  lockKeystore() {
    if (this._keystoreSource === 'ui-passphrase') {
      this._encryptionKey = null;
      this._keystoreSource = null;
      this.log.info('[ssh] Keystore locked — passphrase cleared from memory');
    }
  }

  get keystoreUnlocked() {
    return this._encryptionKey !== null;
  }

  get keystoreSource() {
    return this._keystoreSource;
  }

  _encrypt(plaintext) {
    if (!this._encryptionKey) throw new Error('SSH keystore is locked. Unlock it with a passphrase in the terminal tab before adding hosts.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this._encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  }

  _decrypt(stored) {
    if (!this._encryptionKey) {
      throw new Error('SSH keystore is locked. Unlock it with your passphrase in the terminal tab.');
    }
    try {
      const { iv, tag, data } = JSON.parse(stored);
      const d = crypto.createDecipheriv(ALGORITHM, this._encryptionKey, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    } catch (e) { this.log.warn(`[ssh] Decryption failed: ${e.message}`); return null; }
  }

  _loadHosts() {
    try {
      if (fs.existsSync(this._storeFile)) {
        this.hosts = JSON.parse(fs.readFileSync(this._storeFile, 'utf8')).hosts || [];
        this.log.info(`[ssh] Loaded ${this.hosts.length} host(s) (local mode)`);
      }
    } catch (e) { this.hosts = []; }
  }

  _saveHosts() {
    try {
      const dir = path.dirname(this._storeFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._storeFile, JSON.stringify({ hosts: this.hosts }, null, 2));
    } catch (e) { this.log.warn('[ssh-manager] path.dirname failed: ' + e.message); }
  }

  // ── Audit ───────────────────────────────────────────────────────────

  _initAuditLog() {
    try {
      const dir = path.dirname(this._auditLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._auditStream = fs.createWriteStream(this._auditLogPath, { flags: 'a' });
    } catch (e) { this.log.warn('[ssh-manager] path.dirname failed: ' + e.message); }
  }

  audit(sessionId, event, detail) {
    if (!this._auditStream) return;
    this._auditStream.write(JSON.stringify({ t: new Date().toISOString(), sid: sessionId, event, detail: typeof detail === 'string' ? detail.substring(0, 500) : detail }) + '\n');
  }

  // ── Public API (routes to sidecar or local) ─────────────────────────

  async listHosts() {
    if (!this._localMode) {
      try { return await this._refreshSidecarHosts(); }
      catch { return []; }
    }
    return this.hosts.map(h => ({
      id: h.id,
      name: h.name,
      hostname: h.hostname,
      port: h.port,
      username: h.username,
      hasKey: !!h.encryptedKey,
      hasPassword: !!h.encryptedPassword,
      credentialId: h.credentialId || null,
      proxy: h.proxy || null,
      metadata: h.metadata || null,
    }));
  }

  async saveHost(opts) {
    if (!this._localMode) {
      const r = await this._rpc('hosts.save', opts);
      if (!r._error) {
        try { await this._refreshSidecarHosts(); } catch (e) { this.log.warn('[ssh] Failed to refresh sidecar hosts after save: ' + e.message); }
      }
      return r._error ? { error: r._error } : r;
    }
    const { id, name, hostname, port, username, privateKey, password } = opts;
    const existing = this.hosts.find(h => h.id === id);
    const entry = existing || { id: id || `host_${Date.now()}` };
    entry.name = name || entry.name || hostname;
    entry.hostname = hostname || entry.hostname;
    entry.port = port || entry.port || 22;
    entry.username = username || entry.username;
    if (opts.credentialId !== undefined) entry.credentialId = opts.credentialId || null;
    if (opts.proxy !== undefined) entry.proxy = opts.proxy || null;
    if (opts.metadata !== undefined) entry.metadata = opts.metadata || null;
    if (privateKey) entry.encryptedKey = this._encrypt(privateKey);
    if (password) entry.encryptedPassword = this._encrypt(password);
    if (!existing) this.hosts.push(entry);
    this._saveHosts();
    return { id: entry.id, name: entry.name };
  }

  async deleteHost(id) {
    if (!this._localMode) {
      const r = await this._rpc('hosts.delete', { id });
      if (!r._error) this.hosts = this.hosts.filter(h => h.id !== id);
      return !r._error && r !== false;
    }
    const idx = this.hosts.findIndex(h => h.id === id);
    if (idx === -1) return false;
    this.hosts.splice(idx, 1);
    this._saveHosts();
    return true;
  }

  async getCredentialPublic(id) {
    if (!this.isSidecarReady()) {
      return { id, hasPrivate: false, publicKey: null, fingerprint: null, error: 'SSH sidecar is not connected' };
    }
    const r = await this._rpc('credentials.public', { id });
    if (r?._error) return { id, hasPrivate: false, publicKey: null, fingerprint: null, error: r._error };
    return r || { id, hasPrivate: false, publicKey: null, fingerprint: null };
  }

  async generateCredential({ id, name, comment, metadata } = {}) {
    if (!this.isSidecarReady()) {
      throw new Error('SSH sidecar is required for automatic credential generation. Start the ssh-sidecar service and retry.');
    }
    return this._sidecarRpcOrThrow('credentials.generate', { id, name, comment, metadata });
  }

  async saveCredentialPrivateKey({ id, name, privateKey, metadata } = {}) {
    if (!this.isSidecarReady()) {
      throw new Error('SSH sidecar is required for cluster credential storage. Start the ssh-sidecar service and retry.');
    }
    return this._sidecarRpcOrThrow('credentials.savePrivateKey', { id, name, privateKey, metadata });
  }

  async deleteCredential(id) {
    if (!this.isSidecarReady()) {
      throw new Error('SSH sidecar is required for cluster credential management. Start the ssh-sidecar service and retry.');
    }
    return this._sidecarRpcOrThrow('credentials.delete', { id });
  }

  async testConnection(hostId) {
    let resolvedHostId;
    try { resolvedHostId = await this._resolveHostRef(hostId); }
    catch (e) { return { success: false, error: e.message }; }
    if (!this._localMode) {
      const r = await this._rpc('hosts.test', { id: resolvedHostId });
      return r._error ? { success: false, error: r._error } : r;
    }
    return this._localTestConnection(resolvedHostId);
  }

  connect(hostId, callbacks) {
    const resolvedHostId = this._resolveHostRefSync(hostId);
    if (!resolvedHostId) {
      const error = this._unknownHostMessage(hostId);
      callbacks?.onError?.(error);
      return { error };
    }
    if (!this._localMode) {
      const sessionId = `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this._eventHandlers.set(sessionId, callbacks);
      this._rpc('session.open', { hostId: resolvedHostId, cols: 80, rows: 24 }).then(r => {
        if (r._error) { callbacks.onError?.(r._error); this._eventHandlers.delete(sessionId); }
        else if (r.error) { callbacks.onError?.(r.error); this._eventHandlers.delete(sessionId); }
        else if (r.sessionId) {
          this._eventHandlers.delete(sessionId);
          this._eventHandlers.set(r.sessionId, callbacks);
        }
      });
      return { sessionId };
    }
    return this._localConnect(resolvedHostId, callbacks);
  }

  write(sessionId, data) {
    if (!this._localMode) { this._rpc('session.write', { sessionId, data }); return true; }
    const s = this._activeSessions.get(sessionId);
    if (!s) return false;
    s.stream.write(data);
    return true;
  }

  resize(sessionId, cols, rows) {
    if (!this._localMode) { this._rpc('session.resize', { sessionId, cols, rows }); return true; }
    const s = this._activeSessions.get(sessionId);
    if (!s) return false;
    s.stream.setWindow(rows, cols, 0, 0);
    return true;
  }

  close(sessionId) {
    if (!this._localMode) { this._rpc('session.close', { sessionId }); this._eventHandlers.delete(sessionId); return true; }
    const s = this._activeSessions.get(sessionId);
    if (!s) return false;
    this.audit(sessionId, 'closed_by_user', { host: s.host });
    s.stream.end();
    s.conn.end();
    this._activeSessions.delete(sessionId);
    return true;
  }

  // ── Local-mode SSH (fallback, same as Phase 1) ──────────────────────

  _localConnect(hostId, callbacks) {
    const { Client: SSHClient } = require('ssh2');
    const host = this.hosts.find(h => h.id === hostId);
    if (!host) return { error: `Unknown host: ${hostId}` };

    const sessionId = `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const conn = new SSHClient();
    const authConfig = { host: host.hostname, port: host.port || 22, username: host.username, readyTimeout: 15000, keepaliveInterval: 10000 };
    if (host.encryptedKey) { const k = this._decrypt(host.encryptedKey); if (k) authConfig.privateKey = k; }
    if (host.encryptedPassword) { const p = this._decrypt(host.encryptedPassword); if (p) authConfig.password = p; }

    conn.on('ready', () => {
      this.audit(sessionId, 'connected', { host: host.hostname, user: host.username });
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) { callbacks.onError?.(err.message); conn.end(); return; }
        this._activeSessions.set(sessionId, { conn, stream, host: host.name });
        stream.on('data', (d) => callbacks.onData?.(d.toString('utf8')));
        stream.stderr?.on('data', (d) => callbacks.onData?.(d.toString('utf8')));
        stream.on('close', () => { this.audit(sessionId, 'disconnected', { host: host.hostname }); this._activeSessions.delete(sessionId); callbacks.onClose?.(); conn.end(); });
        callbacks.onReady?.(sessionId);
      });
    });
    conn.on('error', (err) => { this.audit(sessionId, 'error', { host: host.hostname, error: err.message }); callbacks.onError?.(err.message); this._activeSessions.delete(sessionId); });
    conn.on('end', () => this._activeSessions.delete(sessionId));
    conn.connect(authConfig);
    return { sessionId };
  }

  _localTestConnection(hostId) {
    const { Client: SSHClient } = require('ssh2');
    return new Promise((resolve) => {
      const host = this.hosts.find(h => h.id === hostId);
      if (!host) return resolve({ success: false, error: 'Unknown host' });
      const conn = new SSHClient();
      const timeout = setTimeout(() => { conn.end(); resolve({ success: false, error: 'Timed out (15s)' }); }, 15000);
      const authConfig = { host: host.hostname, port: host.port || 22, username: host.username, readyTimeout: 15000 };
      if (host.encryptedKey) { const k = this._decrypt(host.encryptedKey); if (k) authConfig.privateKey = k; }
      if (host.encryptedPassword) { const p = this._decrypt(host.encryptedPassword); if (p) authConfig.password = p; }
      conn.on('ready', () => { clearTimeout(timeout); conn.end(); resolve({ success: true, message: `Connected to ${host.hostname} as ${host.username}` }); });
      conn.on('error', (err) => { clearTimeout(timeout); resolve({ success: false, error: err.message }); });
      conn.connect(authConfig);
    });
  }

  // ── Connection Pool (for SFTP / exec reuse) ─────────────────────────

  _getPooledConnection(hostId) {
    if (!this._localMode) {
      return Promise.reject(new Error('Connection pooling is not available for sidecar-backed SSH hosts'));
    }
    const resolvedHostId = this._resolveHostRefSync(hostId);
    if (!resolvedHostId) return Promise.reject(new Error(this._unknownHostMessage(hostId)));
    if (!this._connPool) this._connPool = new Map();
    const existing = this._connPool.get(resolvedHostId);
    if (existing?.conn?._sock?.writable) {
      existing.lastUsed = Date.now();
      return Promise.resolve(existing);
    }
    if (existing) {
      try { existing.conn.end(); } catch (e) { this.log.warn('[ssh-manager] existing.conn.end failed: ' + e.message); }
      this._connPool.delete(resolvedHostId);
    }

    const { Client: SSHClient } = require('ssh2');
    const host = this.hosts.find(h => h.id === resolvedHostId);
    if (!host) return Promise.reject(new Error(this._unknownHostMessage(hostId)));

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const authConfig = {
        host: host.hostname, port: host.port || 22, username: host.username,
        readyTimeout: 15000, keepaliveInterval: 10000,
      };
      if (host.encryptedKey) { const k = this._decrypt(host.encryptedKey); if (k) authConfig.privateKey = k; }
      if (host.encryptedPassword) { const p = this._decrypt(host.encryptedPassword); if (p) authConfig.password = p; }

      const timeout = setTimeout(() => { conn.end(); reject(new Error('Connection timed out (15s)')); }, 15000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        const entry = { conn, sftp: null, lastUsed: Date.now(), hostName: host.name };
        this._connPool.set(resolvedHostId, entry);
        conn.on('end', () => this._connPool.delete(resolvedHostId));
        conn.on('error', () => this._connPool.delete(resolvedHostId));
        this.log.info(`[ssh] Pool: connected to ${host.hostname} (${resolvedHostId})`);
        resolve(entry);
      });
      conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
      conn.connect(authConfig);
    });
  }

  async _getSftp(hostId) {
    const entry = await this._getPooledConnection(hostId);
    if (entry.sftp) return entry.sftp;
    return new Promise((resolve, reject) => {
      entry.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        entry.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  _startPoolCleanup() {
    if (this._poolTimer) return;
    const IDLE_MS = 5 * 60 * 1000;
    this._poolTimer = setInterval(() => {
      if (!this._connPool) return;
      const now = Date.now();
      for (const [id, entry] of this._connPool) {
        if (now - entry.lastUsed > IDLE_MS) {
          this.log.info(`[ssh] Pool: closing idle connection ${id}`);
          try { entry.conn.end(); } catch (e) { this.log.warn('[ssh-manager] entry.conn.end failed: ' + e.message); }
          this._connPool.delete(id);
        }
      }
    }, 60000);
    if (this._poolTimer.unref) this._poolTimer.unref();
  }

  // ── SFTP Operations ─────────────────────────────────────────────────

  async sftpListDir(hostId, remotePath) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('sftp.listDir', { hostId: resolvedHostId, remotePath });
    }
    this._startPoolCleanup();
    const sftp = await this._getSftp(resolvedHostId);
    this.audit('sftp', 'listDir', { hostId: resolvedHostId, path: remotePath });
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath || '/', (err, list) => {
        if (err) return reject(err);
        const entries = (list || []).map(item => ({
          name: item.filename,
          isDir: !!(item.attrs.mode & 0o40000),
          size: item.attrs.size || 0,
          modified: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
        }));
        resolve(entries);
      });
    });
  }

  async sftpStat(hostId, remotePath) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('sftp.stat', { hostId: resolvedHostId, remotePath });
    }
    this._startPoolCleanup();
    const sftp = await this._getSftp(resolvedHostId);
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size || 0,
          isDir: !!(stats.mode & 0o40000),
          modified: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
          mode: stats.mode,
        });
      });
    });
  }

  async sftpReadFile(hostId, remotePath, opts = {}) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    this._startPoolCleanup();
    const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
    if (!this._localMode) {
      const r = await this._sidecarRpcOrThrow('sftp.readFile', { hostId: resolvedHostId, remotePath, maxBytes });
      return Buffer.from(r.dataBase64 || '', 'base64');
    }
    const sftp = await this._getSftp(resolvedHostId);
    this.audit('sftp', 'readFile', { hostId: resolvedHostId, path: remotePath });

    const stat = await this.sftpStat(resolvedHostId, remotePath);
    if (stat.isDir) throw new Error(`${remotePath} is a directory`);
    if (stat.size > maxBytes) throw new Error(`File too large: ${stat.size} bytes (max ${maxBytes})`);

    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(remotePath);
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { stream.destroy(); reject(new Error(`File exceeds ${maxBytes} bytes`)); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async sftpWriteFile(hostId, remotePath, content) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    const MAX_WRITE_BYTES = 10 * 1024 * 1024;
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (buf.length > MAX_WRITE_BYTES) {
      throw new Error(`Write payload too large: ${buf.length} bytes exceeds ${MAX_WRITE_BYTES} byte limit`);
    }
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('sftp.writeFile', { hostId: resolvedHostId, remotePath, contentBase64: buf.toString('base64') });
    }
    this._startPoolCleanup();
    const sftp = await this._getSftp(resolvedHostId);
    this.audit('sftp', 'writeFile', { hostId: resolvedHostId, path: remotePath, size: buf.length });
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => resolve({ written: buf.length, path: remotePath }));
      stream.on('error', reject);
      stream.end(buf);
    });
  }

  async sftpMkdir(hostId, remotePath) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('sftp.mkdir', { hostId: resolvedHostId, remotePath });
    }
    this._startPoolCleanup();
    const sftp = await this._getSftp(resolvedHostId);
    this.audit('sftp', 'mkdir', { hostId: resolvedHostId, path: remotePath });
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) return reject(err);
        resolve({ created: remotePath });
      });
    });
  }

  async sftpDelete(hostId, remotePath) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('sftp.delete', { hostId: resolvedHostId, remotePath });
    }
    this._startPoolCleanup();
    const sftp = await this._getSftp(resolvedHostId);
    this.audit('sftp', 'delete', { hostId: resolvedHostId, path: remotePath });

    const stat = await this.sftpStat(resolvedHostId, remotePath);
    return new Promise((resolve, reject) => {
      if (stat.isDir) {
        sftp.rmdir(remotePath, (err) => err ? reject(err) : resolve({ deleted: remotePath }));
      } else {
        sftp.unlink(remotePath, (err) => err ? reject(err) : resolve({ deleted: remotePath }));
      }
    });
  }

  // ── Remote Exec (single command, not shell) ─────────────────────────

  async remoteExec(hostId, command, opts = {}) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    const timeout = Math.min(opts.timeout || 30000, 120000);
    if (!this._localMode) {
      return this._sidecarRpcOrThrow('exec.run', { hostId: resolvedHostId, command, cwd: opts.cwd || null, timeout });
    }
    this._startPoolCleanup();
    const maxBuffer = 1024 * 1024;
    const entry = await this._getPooledConnection(resolvedHostId);
    this.audit('exec', 'remoteExec', { hostId: resolvedHostId, command: command.substring(0, 200) });

    return new Promise((resolve, reject) => {
      let _stream = null;
      const timer = setTimeout(() => {
        if (_stream) { try { _stream.close(); } catch { /* silent: best-effort close */ } try { _stream.destroy(); } catch (e) { this.log.warn('[ssh-manager] _stream.destroy failed: ' + e.message); } }
        reject(new Error(`Command timed out after ${timeout}ms (remote process killed)`));
      }, timeout);

      const execOpts = {};
      if (opts.cwd) execOpts.env = { ...execOpts.env, PWD: opts.cwd };

      const cmd = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
      entry.conn.exec(cmd, execOpts, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        _stream = stream;
        let stdout = '', stderr = '';
        stream.on('data', (d) => {
          stdout += d.toString('utf8');
          if (stdout.length > maxBuffer) { stream.destroy(); clearTimeout(timer); reject(new Error('stdout exceeded 1MB')); }
        });
        stream.stderr.on('data', (d) => {
          stderr += d.toString('utf8');
          if (stderr.length > maxBuffer) { stream.destroy(); clearTimeout(timer); reject(new Error('stderr exceeded 1MB')); }
        });
        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
        stream.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
    });
  }

  // ── SSH Tunnels (local port forwarding) ─────────────────────────────

  async createTunnel(hostId, { remoteHost = 'localhost', remotePort, localPort } = {}) {
    const resolvedHostId = await this._resolveHostRef(hostId);
    if (!this._localMode) {
      throw new Error('SSH tunnels are not supported for sidecar-backed hosts yet because the forwarded local port must live in the main container. Use local fallback for tunnels.');
    }
    if (!this._tunnels) this._tunnels = new Map();
    const MAX_TUNNELS = 5;
    const PORT_MIN = 19000, PORT_MAX = 19999;
    const ALLOWED_REMOTE_HOSTS = ['localhost', '127.0.0.1', '::1'];

    if (this._tunnels.size >= MAX_TUNNELS) {
      throw new Error(`Max ${MAX_TUNNELS} tunnels reached. Close one first.`);
    }
    if (!remotePort || remotePort < 1 || remotePort > 65535) {
      throw new Error('remotePort is required (1-65535)');
    }
    if (!ALLOWED_REMOTE_HOSTS.includes(remoteHost)) {
      throw new Error(`remoteHost must be one of: ${ALLOWED_REMOTE_HOSTS.join(', ')} (got: ${remoteHost}). Only localhost forwarding is allowed for security.`);
    }

    if (localPort) {
      if (localPort < PORT_MIN || localPort > PORT_MAX) {
        throw new Error(`localPort must be ${PORT_MIN}-${PORT_MAX}`);
      }
      if (this._tunnels.has(localPort)) {
        throw new Error(`Local port ${localPort} already in use by a tunnel`);
      }
    } else {
      localPort = PORT_MIN;
      while (this._tunnels.has(localPort) && localPort <= PORT_MAX) localPort++;
      if (localPort > PORT_MAX) throw new Error('No available ports in tunnel range');
    }

    this._startPoolCleanup();
    const entry = await this._getPooledConnection(resolvedHostId);
    const host = this.hosts.find(h => h.id === resolvedHostId);

    const server = net.createServer((sock) => {
      entry.conn.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, stream) => {
        if (err) { sock.end(); return; }
        stream.pipe(sock).pipe(stream);
        stream.on('error', () => sock.destroy());
        sock.on('error', () => stream.destroy());
      });
    });

    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(localPort, '127.0.0.1', () => resolve());
    });

    const tunnelInfo = {
      localPort, remoteHost, remotePort,
      hostId: resolvedHostId, hostName: host?.name || resolvedHostId,
      server, createdAt: Date.now(),
    };
    this._tunnels.set(localPort, tunnelInfo);

    const onConnClose = () => this._closeTunnelByPort(localPort);
    entry.conn.once('end', onConnClose);
    entry.conn.once('error', onConnClose);
    tunnelInfo._onConnClose = onConnClose;
    tunnelInfo._conn = entry.conn;

    this.log.info(`[ssh] Tunnel: localhost:${localPort} -> ${remoteHost}:${remotePort} via ${resolvedHostId}`);
    this.audit('tunnel', 'createTunnel', { hostId: resolvedHostId, localPort, remoteHost, remotePort });

    return { localPort, remoteHost, remotePort, hostId: resolvedHostId };
  }

  _closeTunnelByPort(localPort) {
    if (!this._tunnels) return false;
    const t = this._tunnels.get(localPort);
    if (!t) return false;
    try { t.server.close(); } catch { /* silent: best-effort close */ }
    if (t._conn && t._onConnClose) {
      t._conn.removeListener('end', t._onConnClose);
      t._conn.removeListener('error', t._onConnClose);
    }
    this._tunnels.delete(localPort);
    this.log.info(`[ssh] Tunnel closed: localhost:${localPort}`);
    return true;
  }

  closeTunnel(localPort) {
    return this._closeTunnelByPort(localPort);
  }

  listTunnels() {
    if (!this._tunnels) return [];
    return [...this._tunnels.values()].map(t => ({
      localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort,
      hostId: t.hostId, hostName: t.hostName,
      uptime: Math.round((Date.now() - t.createdAt) / 1000),
    }));
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  closeAll() {
    this._closing = true;
    if (this._tunnels) {
      for (const [port] of this._tunnels) this._closeTunnelByPort(port);
    }
    for (const [, s] of this._activeSessions) { try { s.stream.end(); s.conn.end(); } catch (e) { this.log.warn('[ssh-manager] s.stream.end failed: ' + e.message); } }
    this._activeSessions.clear();
    if (this._connPool) {
      for (const [, entry] of this._connPool) { try { entry.conn.end(); } catch (e) { this.log.warn('[ssh-manager] entry.conn.end failed: ' + e.message); } }
      this._connPool.clear();
    }
    if (this._poolTimer) { clearInterval(this._poolTimer); this._poolTimer = null; }
    if (this._sidecarConn) try { this._sidecarConn.end(); } catch (e) { this.log.warn('[ssh-manager] _sidecarConn.end failed: ' + e.message); }
    if (this._auditStream) this._auditStream.end();
  }
}

module.exports = { SSHManager };
