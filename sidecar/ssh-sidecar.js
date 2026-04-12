#!/usr/bin/env node
/**
 * ssh-sidecar.js — Credential Isolation Sidecar for SSH Keys
 *
 * Runs in a separate container with NO network access.
 * Communicates with the main Anima container via a Unix domain socket.
 * Holds encrypted SSH private keys and manages SSH sessions.
 * The main process never sees decrypted key material.
 *
 * Protocol: newline-delimited JSON over Unix socket.
 * Each message has { id, method, params } and response { id, result } or { id, error }.
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client: SSHClient } = require('ssh2');

const SOCKET_PATH = process.env.SIDECAR_SOCKET || '/run/ssh-sidecar/sidecar.sock';
const STORE_FILE = process.env.SIDECAR_STORE || '/data/ssh-hosts.json';
const PASSPHRASE = process.env.SIDECAR_PASSPHRASE;
const PBKDF2_ITERATIONS = 100000;
const ALGORITHM = 'aes-256-gcm';

if (!PASSPHRASE) {
  console.error('[sidecar] FATAL: SIDECAR_PASSPHRASE not set. Cannot start without encryption key.');
  process.exit(1);
}

// ── Encryption ────────────────────────────────────────────────────────

const encryptionKey = crypto.pbkdf2Sync(PASSPHRASE, 'anima-ssh-keystore-v1', PBKDF2_ITERATIONS, 32, 'sha256');

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: encrypted.toString('base64') });
}

function decrypt(stored) {
  try {
    const { iv, tag, data } = JSON.parse(stored);
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[sidecar] Decryption failed:', e.message);
    return null;
  }
}

// ── Host Store ────────────────────────────────────────────────────────

let hosts = [];

function loadHosts() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      hosts = Array.isArray(data.hosts) ? data.hosts : [];
      console.log(`[sidecar] Loaded ${hosts.length} host(s)`);
    }
  } catch (e) {
    console.error('[sidecar] Failed to load hosts:', e.message);
    hosts = [];
  }
}

function saveHosts() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ hosts }, null, 2));
  } catch (e) {
    console.error('[sidecar] Failed to save hosts:', e.message);
  }
}

loadHosts();

// ── Audit Log ─────────────────────────────────────────────────────────

let auditStream;
try {
  auditStream = fs.createWriteStream('/data/terminal-audit.log', { flags: 'a' });
} catch {}

function audit(sid, event, detail) {
  if (!auditStream) return;
  auditStream.write(JSON.stringify({ t: new Date().toISOString(), sid, event, detail }) + '\n');
}

// ── SSH Sessions ──────────────────────────────────────────────────────

const sessions = new Map();

function getAuthConfig(host) {
  const cfg = { host: host.hostname, port: host.port || 22, username: host.username, readyTimeout: 15000, keepaliveInterval: 10000 };
  if (host.encryptedKey) { const k = decrypt(host.encryptedKey); if (k) cfg.privateKey = k; }
  if (host.encryptedPassword) { const p = decrypt(host.encryptedPassword); if (p) cfg.password = p; }
  return cfg;
}

// ── RPC Methods ───────────────────────────────────────────────────────

const methods = {
  'hosts.list'() {
    return hosts.map(h => ({ id: h.id, name: h.name, hostname: h.hostname, port: h.port, username: h.username, hasKey: !!h.encryptedKey, hasPassword: !!h.encryptedPassword }));
  },

  'hosts.save'({ id, name, hostname, port, username, privateKey, password }) {
    const existing = hosts.find(h => h.id === id);
    const entry = existing || { id: id || `host_${Date.now()}` };
    entry.name = name || entry.name || hostname;
    entry.hostname = hostname || entry.hostname;
    entry.port = port || entry.port || 22;
    entry.username = username || entry.username;
    if (privateKey) entry.encryptedKey = encrypt(privateKey);
    if (password) entry.encryptedPassword = encrypt(password);
    if (!existing) hosts.push(entry);
    saveHosts();
    return { id: entry.id, name: entry.name };
  },

  'hosts.delete'({ id }) {
    const idx = hosts.findIndex(h => h.id === id);
    if (idx === -1) return false;
    hosts.splice(idx, 1);
    saveHosts();
    return true;
  },

  'hosts.test'({ id }) {
    return new Promise((resolve) => {
      const host = hosts.find(h => h.id === id);
      if (!host) return resolve({ success: false, error: 'Unknown host' });
      const conn = new SSHClient();
      const timeout = setTimeout(() => { conn.end(); resolve({ success: false, error: 'Timed out (15s)' }); }, 15000);
      conn.on('ready', () => { clearTimeout(timeout); conn.end(); resolve({ success: true, message: `Connected to ${host.hostname} as ${host.username}` }); });
      conn.on('error', (err) => { clearTimeout(timeout); resolve({ success: false, error: err.message }); });
      conn.connect(getAuthConfig(host));
    });
  },

  'session.open'({ hostId, cols, rows }, client) {
    const host = hosts.find(h => h.id === hostId);
    if (!host) return { error: `Unknown host: ${hostId}` };

    const sessionId = `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const conn = new SSHClient();

    conn.on('ready', () => {
      audit(sessionId, 'connected', { host: host.hostname, user: host.username });
      conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) {
          client.send({ type: 'session.error', sessionId, error: err.message });
          conn.end();
          return;
        }
        sessions.set(sessionId, { conn, stream, host: host.name, clientId: client.id });
        stream.on('data', (data) => client.send({ type: 'session.data', sessionId, data: data.toString('utf8') }));
        stream.stderr?.on('data', (data) => client.send({ type: 'session.data', sessionId, data: data.toString('utf8') }));
        stream.on('close', () => {
          audit(sessionId, 'disconnected', { host: host.hostname });
          sessions.delete(sessionId);
          client.send({ type: 'session.closed', sessionId });
          conn.end();
        });
        client.send({ type: 'session.opened', sessionId, hostId });
      });
    });

    conn.on('error', (err) => {
      audit(sessionId, 'error', { host: host.hostname, error: err.message });
      sessions.delete(sessionId);
      client.send({ type: 'session.error', sessionId, error: err.message });
    });

    conn.connect(getAuthConfig(host));
    return { sessionId };
  },

  'session.write'({ sessionId, data }) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    s.stream.write(data);
    return true;
  },

  'session.resize'({ sessionId, cols, rows }) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    s.stream.setWindow(rows || 24, cols || 80, 0, 0);
    return true;
  },

  'session.close'({ sessionId }) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    audit(sessionId, 'closed_by_user', { host: s.host });
    s.stream.end();
    s.conn.end();
    sessions.delete(sessionId);
    return true;
  },
};

// ── Unix Socket Server ────────────────────────────────────────────────

let clientIdCounter = 0;

function cleanSocket() {
  try { if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH); } catch {}
  const dir = path.dirname(SOCKET_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

cleanSocket();

const server = net.createServer((socket) => {
  const clientId = ++clientIdCounter;
  let buffer = '';

  const client = {
    id: clientId,
    send(obj) {
      try { socket.write(JSON.stringify(obj) + '\n'); } catch {}
    },
  };

  console.log(`[sidecar] Client ${clientId} connected`);

  socket.on('data', async (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      const { id, method, params } = msg;
      const fn = methods[method];
      if (!fn) {
        client.send({ id, error: `Unknown method: ${method}` });
        continue;
      }

      try {
        const result = await fn(params || {}, client);
        client.send({ id, result });
      } catch (e) {
        client.send({ id, error: e.message });
      }
    }
  });

  socket.on('close', () => {
    console.log(`[sidecar] Client ${clientId} disconnected`);
    for (const [sid, s] of sessions) {
      if (s.clientId === clientId) {
        try { s.stream.end(); s.conn.end(); } catch {}
        sessions.delete(sid);
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o660);
  console.log(`[sidecar] Listening on ${SOCKET_PATH}`);
});

process.on('SIGTERM', () => {
  console.log('[sidecar] Shutting down...');
  for (const [, s] of sessions) { try { s.stream.end(); s.conn.end(); } catch {} }
  sessions.clear();
  server.close();
  if (auditStream) auditStream.end();
  cleanSocket();
  process.exit(0);
});

process.on('SIGINT', () => process.emit('SIGTERM'));
