#!/usr/bin/env node
/**
 * ssh-sidecar.js — Credential Isolation Sidecar for SSH Keys
 *
 * Runs in a separate container with no inbound ports. It must have outbound
 * network access to open SSH sessions, so use SIDECAR_ALLOWED_HOSTS and/or
 * host firewall policy to constrain egress.
 *
 * Communicates with the main Spore Core container via a Unix domain socket.
 * Holds encrypted SSH private keys and manages interactive SSH sessions. The
 * main process never receives raw decrypted key material for sidecar-backed
 * saved-host flows.
 *
 * Protocol: newline-delimited JSON over Unix socket.
 * Each message has { id, method, params } and response { id, result } or { id, error }.
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client: SSHClient } = require('ssh2');

const SOCKET_PATH = process.env.SIDECAR_SOCKET || '/run/ssh-sidecar/sidecar.sock';
const STORE_FILE = process.env.SIDECAR_STORE || '/data/ssh-hosts.json';
const AUDIT_FILE = process.env.SIDECAR_AUDIT_LOG || '/data/terminal-audit.log';
const PASSPHRASE = process.env.SIDECAR_PASSPHRASE;
const PRIMARY_SALT = process.env.SIDECAR_KEY_SALT || 'spore-ssh-keystore-v1';
const LEGACY_SALTS = ['anima-ssh-keystore-v1'];
const ALLOWED_HOSTS = (process.env.SIDECAR_ALLOWED_HOSTS || '*')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const PBKDF2_ITERATIONS = 100000;
const ALGORITHM = 'aes-256-gcm';
const TAILSCALE_SOCKET = process.env.TAILSCALE_SOCKET || '/data/tailscale/ts.sock';
const TAILSCALE_SOCKS_HOST = process.env.TAILSCALE_SOCKS_HOST || '127.0.0.1';
const TAILSCALE_SOCKS_PORT = Math.max(1, Math.min(65535, Number(process.env.TAILSCALE_SOCKS_PORT || 1055) || 1055));
const TAILSCALE_STATUS_CACHE_MS = 5000;

let tailscaleStatusCache = { loaded: false, at: 0, status: null };

if (!PASSPHRASE) {
  console.error('[sidecar] FATAL: SIDECAR_PASSPHRASE not set. Cannot start without encryption key.');
  process.exit(1);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ── Encryption ────────────────────────────────────────────────────────

const keyCache = new Map();

function encryptionKeyForSalt(salt) {
  if (!keyCache.has(salt)) {
    keyCache.set(salt, crypto.pbkdf2Sync(PASSPHRASE, salt, PBKDF2_ITERATIONS, 32, 'sha256'));
  }
  return keyCache.get(salt);
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKeyForSalt(PRIMARY_SALT), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: encrypted.toString('base64') });
}

function decrypt(stored) {
  const salts = [PRIMARY_SALT, ...LEGACY_SALTS.filter(s => s !== PRIMARY_SALT)];
  let lastError = null;
  for (const salt of salts) {
    try {
      const { iv, tag, data } = JSON.parse(stored);
      const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKeyForSalt(salt), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  console.error('[sidecar] Decryption failed:', lastError?.message || 'unknown error');
  return null;
}

function isHostAllowed(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  if (ALLOWED_HOSTS.length === 0 || ALLOWED_HOSTS.includes('*')) return true;
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.some(pattern => {
    if (pattern === h) return true;
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
    if (pattern.startsWith('.')) return h.endsWith(pattern);
    return false;
  });
}

function assertHostAllowed(hostname) {
  if (!isHostAllowed(hostname)) {
    throw new Error(`Host ${hostname} is not allowed by SIDECAR_ALLOWED_HOSTS`);
  }
}

function cleanHostName(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function tailscaleBinary() {
  const candidates = [process.env.TAILSCALE_BIN, '/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale']
    .filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  return 'tailscale';
}

function readTailscaleStatus() {
  const now = Date.now();
  if (tailscaleStatusCache.loaded && now - tailscaleStatusCache.at < TAILSCALE_STATUS_CACHE_MS) {
    return tailscaleStatusCache.status;
  }
  let status = null;
  try {
    const args = [];
    if (TAILSCALE_SOCKET && fs.existsSync(TAILSCALE_SOCKET)) args.push('--socket', TAILSCALE_SOCKET);
    args.push('status', '--json');
    const out = execFileSync(tailscaleBinary(), args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    status = JSON.parse(out);
  } catch {}
  tailscaleStatusCache = { loaded: true, at: now, status };
  return status;
}

function tailnetAliasesFor(peer) {
  const aliases = new Set();
  const hostName = cleanHostName(peer?.HostName);
  const dnsName = cleanHostName(peer?.DNSName);
  if (hostName) aliases.add(hostName);
  if (dnsName) {
    aliases.add(dnsName);
    aliases.add(dnsName.split('.')[0]);
  }
  for (const ip of Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : []) {
    aliases.add(cleanHostName(ip));
  }
  return aliases;
}

function findTailnetPeer(hostname) {
  const target = cleanHostName(hostname);
  if (!target) return null;
  const status = readTailscaleStatus();
  if (!status || status.BackendState !== 'Running') return null;
  const peers = [
    ...Object.values(status.Peer || {}),
    ...(status.Self ? [status.Self] : []),
  ];
  for (const peer of peers) {
    if (tailnetAliasesFor(peer).has(target)) return peer;
  }
  return null;
}

function preferredTailnetAddress(peer, fallback) {
  const ips = Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : [];
  return ips.find(ip => net.isIPv4(ip)) || ips[0] || cleanHostName(peer?.DNSName) || fallback;
}

function withRuntimeNetworking(host) {
  assertHostAllowed(host.hostname);
  if (host.proxy?.type === 'socks5') return host;
  const peer = findTailnetPeer(host.hostname);
  if (!peer) return host;
  const targetHost = preferredTailnetAddress(peer, host.hostname);
  if (!targetHost) return host;
  return {
    ...host,
    hostname: targetHost,
    proxy: { type: 'socks5', host: TAILSCALE_SOCKS_HOST, port: TAILSCALE_SOCKS_PORT },
    _allowedHostname: host.hostname,
    _displayHostname: host.hostname,
    _runtimeNetwork: 'tailscale',
  };
}

// ── Host Store ────────────────────────────────────────────────────────

let hosts = [];
let credentials = [];

function loadHosts() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      hosts = Array.isArray(data.hosts) ? data.hosts : [];
      credentials = Array.isArray(data.credentials) ? data.credentials : [];
      console.log(`[sidecar] Loaded ${hosts.length} host(s), ${credentials.length} credential profile(s)`);
    }
  } catch (e) {
    console.error('[sidecar] Failed to load hosts:', e.message);
    hosts = [];
    credentials = [];
  }
}

function saveHosts() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ hosts, credentials }, null, 2));
  } catch (e) {
    console.error('[sidecar] Failed to save hosts:', e.message);
  }
}

loadHosts();

// ── Audit Log ─────────────────────────────────────────────────────────

let auditStream;
try {
  auditStream = fs.createWriteStream(AUDIT_FILE, { flags: 'a' });
} catch {}

function audit(sid, event, detail) {
  if (!auditStream) return;
  auditStream.write(JSON.stringify({ t: new Date().toISOString(), sid, event, detail }) + '\n');
}

// ── SSH Sessions ──────────────────────────────────────────────────────

const sessions = new Map();

function cleanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    if (!key) continue;
    if (typeof v === 'string') out[key] = v.slice(0, 256);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') return null;
  const type = String(proxy.type || '').toLowerCase();
  if (type !== 'socks5') throw new Error(`Unsupported SSH proxy type: ${type || 'empty'}`);
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port || 0);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SOCKS5 proxy requires host and port');
  }
  return { type: 'socks5', host, port };
}

function connectViaSocks5(proxy, dstHost, dstPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`SOCKS5 proxy timed out (${proxy.host}:${proxy.port})`)), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.removeListener('close', onClose);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onClose = () => fail(new Error('SOCKS5 proxy closed before connection completed'));
    const requestFor = () => {
      const host = String(dstHost || '');
      const port = Number(dstPort || 22);
      let addr;
      if (net.isIPv4(host)) {
        addr = Buffer.from(host.split('.').map(n => Number(n)));
        return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), addr, Buffer.from([port >> 8, port & 0xff])]);
      }
      const domain = Buffer.from(host, 'utf8');
      if (domain.length > 255) throw new Error('Destination hostname too long for SOCKS5');
      return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, Buffer.from([port >> 8, port & 0xff])]);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 0x05 || buffer[1] !== 0x00) throw new Error('SOCKS5 proxy does not allow no-auth connections');
          buffer = buffer.slice(2);
          stage = 'connect';
          socket.write(requestFor());
        }
        if (stage === 'connect') {
          if (buffer.length < 5) return;
          const atyp = buffer[3];
          let addrLen = 0;
          if (atyp === 0x01) addrLen = 4;
          else if (atyp === 0x03) addrLen = buffer[4] + 1;
          else if (atyp === 0x04) addrLen = 16;
          else throw new Error(`SOCKS5 proxy returned unsupported address type ${atyp}`);
          const total = 4 + addrLen + 2;
          if (buffer.length < total) return;
          if (buffer[1] !== 0x00) throw new Error(`SOCKS5 proxy connect failed with code ${buffer[1]}`);
          finish();
        }
      } catch (e) {
        fail(e);
      }
    };

    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('close', onClose);
  });
}

function withTempKeyFile(privateKey, fn) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'spore-key-'));
  const keyPath = path.join(dir, 'key');
  try {
    fs.writeFileSync(keyPath, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    return fn(keyPath, dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function derivePublicMetadata(privateKey) {
  return withTempKeyFile(privateKey, (keyPath, dir) => {
    const publicKey = execFileSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' }).trim();
    const pubPath = path.join(dir, 'key.pub');
    fs.writeFileSync(pubPath, publicKey + '\n', { mode: 0o644 });
    const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', pubPath], { encoding: 'utf8' }).trim();
    return { publicKey, fingerprint };
  });
}

function generatePrivateKey(comment) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'spore-keygen-'));
  const keyPath = path.join(dir, 'key');
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', String(comment || 'spore-sidecar'), '-f', keyPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
    const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', `${keyPath}.pub`], { encoding: 'utf8' }).trim();
    return { privateKey, publicKey, fingerprint };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function getCredential(credentialId) {
  if (!credentialId) return null;
  return credentials.find(c => c.id === credentialId) || null;
}

function publicCredentialShape(cred) {
  return cred ? {
    id: cred.id,
    name: cred.name || cred.id,
    hasPrivate: !!cred.encryptedKey,
    publicKey: cred.publicKey || null,
    fingerprint: cred.fingerprint || null,
    createdAt: cred.createdAt || null,
    updatedAt: cred.updatedAt || null,
    metadata: cred.metadata || null,
  } : null;
}

function getAuthConfig(host) {
  assertHostAllowed(host._allowedHostname || host.hostname);
  const cfg = { host: host.hostname, port: host.port || 22, username: host.username, readyTimeout: 15000, keepaliveInterval: 10000 };
  const credential = host.credentialId ? getCredential(host.credentialId) : null;
  if (credential?.encryptedKey) {
    const k = decrypt(credential.encryptedKey);
    if (k) cfg.privateKey = k;
  } else if (host.encryptedKey) {
    const k = decrypt(host.encryptedKey);
    if (k) cfg.privateKey = k;
  }
  if (host.encryptedPassword) { const p = decrypt(host.encryptedPassword); if (p) cfg.password = p; }
  return cfg;
}

async function getConnectionAuthConfig(host, timeoutMs = 15000) {
  const runtimeHost = withRuntimeNetworking(host);
  const authConfig = getAuthConfig(runtimeHost);
  if (runtimeHost.proxy?.type === 'socks5') {
    authConfig.sock = await connectViaSocks5(runtimeHost.proxy, runtimeHost.hostname, runtimeHost.port || 22, timeoutMs);
  }
  return { runtimeHost, authConfig };
}

function getHost(hostId) {
  const host = hosts.find(h => h.id === hostId);
  if (!host) throw new Error(`Unknown host: ${hostId}`);
  assertHostAllowed(host.hostname);
  return host;
}

function connectHost(hostId, timeoutMs = 15000) {
  let host;
  try {
    host = getHost(hostId);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ conn, host });
    };
    const timer = setTimeout(() => {
      try { conn.end(); } catch {}
      finish(new Error(`Connection timed out (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    conn.on('ready', () => finish(null));
    conn.on('error', (err) => finish(err));
    (async () => {
      try {
        const prepared = await getConnectionAuthConfig(host, timeoutMs);
        host = prepared.runtimeHost;
        conn.connect(prepared.authConfig);
      } catch (e) {
        finish(e);
      }
    })();
  });
}

async function withSftp(hostId, fn) {
  const { conn } = await connectHost(hostId);
  try {
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, client) => err ? reject(err) : resolve(client));
    });
    return await fn(sftp);
  } finally {
    try { conn.end(); } catch {}
  }
}

function statShape(stats) {
  return {
    size: stats.size || 0,
    isDir: !!(stats.mode & 0o40000),
    modified: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
    mode: stats.mode,
  };
}

// ── RPC Methods ───────────────────────────────────────────────────────

const methods = {
  'sidecar.status'() {
    return {
      ok: true,
      socketPath: SOCKET_PATH,
      storeFile: STORE_FILE,
      auditFile: AUDIT_FILE,
      allowedHosts: ALLOWED_HOSTS.length ? ALLOWED_HOSTS : ['*'],
      hostCount: hosts.length,
      credentialCount: credentials.length,
      sessionCount: sessions.size,
      clientCount: clientIdCounter,
      primarySalt: PRIMARY_SALT,
      tailnetProxy: {
        socket: TAILSCALE_SOCKET,
        socksHost: TAILSCALE_SOCKS_HOST,
        socksPort: TAILSCALE_SOCKS_PORT,
        backendState: readTailscaleStatus()?.BackendState || null,
      },
    };
  },

  'hosts.list'() {
    return hosts.map(h => {
      const cred = h.credentialId ? getCredential(h.credentialId) : null;
      return {
        id: h.id,
        name: h.name,
        hostname: h.hostname,
        port: h.port,
        username: h.username,
        hasKey: !!(h.encryptedKey || cred?.encryptedKey),
        hasPassword: !!h.encryptedPassword,
        credentialId: h.credentialId || null,
        proxy: h.proxy || null,
        metadata: h.metadata || null,
      };
    });
  },

  'hosts.save'({ id, name, hostname, port, username, privateKey, password, credentialId, proxy, metadata }) {
    if (hostname) assertHostAllowed(hostname);
    const existing = hosts.find(h => h.id === id);
    const entry = existing || { id: id || `host_${Date.now()}` };
    entry.name = name || entry.name || hostname;
    entry.hostname = hostname || entry.hostname;
    assertHostAllowed(entry.hostname);
    entry.port = port || entry.port || 22;
    entry.username = username || entry.username;
    if (credentialId !== undefined) {
      if (credentialId && !getCredential(credentialId)) throw new Error(`Unknown credential profile: ${credentialId}`);
      entry.credentialId = credentialId || null;
    }
    if (proxy !== undefined) entry.proxy = normalizeProxy(proxy);
    if (metadata !== undefined) entry.metadata = cleanMetadata(metadata);
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

  'credentials.public'({ id }) {
    return publicCredentialShape(getCredential(id));
  },

  'credentials.generate'({ id, name, comment, metadata }) {
    if (!id) throw new Error('credential id is required');
    const generated = generatePrivateKey(comment || `spore-${id}`);
    const existing = getCredential(id);
    const now = new Date().toISOString();
    const entry = existing || { id, createdAt: now };
    entry.name = name || entry.name || id;
    entry.encryptedKey = encrypt(generated.privateKey);
    entry.publicKey = generated.publicKey;
    entry.fingerprint = generated.fingerprint;
    entry.updatedAt = now;
    if (metadata !== undefined) entry.metadata = cleanMetadata(metadata);
    if (!existing) credentials.push(entry);
    saveHosts();
    return publicCredentialShape(entry);
  },

  'credentials.savePrivateKey'({ id, name, privateKey, metadata }) {
    if (!id) throw new Error('credential id is required');
    const key = String(privateKey || '').trim();
    if (!key.startsWith('-----BEGIN') || !key.includes('PRIVATE KEY-----')) {
      throw new Error('input does not look like an SSH private key');
    }
    const derived = derivePublicMetadata(key);
    const existing = getCredential(id);
    const now = new Date().toISOString();
    const entry = existing || { id, createdAt: now };
    entry.name = name || entry.name || id;
    entry.encryptedKey = encrypt(key.endsWith('\n') ? key : key + '\n');
    entry.publicKey = derived.publicKey;
    entry.fingerprint = derived.fingerprint;
    entry.updatedAt = now;
    if (metadata !== undefined) entry.metadata = cleanMetadata(metadata);
    if (!existing) credentials.push(entry);
    saveHosts();
    return publicCredentialShape(entry);
  },

  'credentials.delete'({ id }) {
    const idx = credentials.findIndex(c => c.id === id);
    if (idx === -1) return false;
    credentials.splice(idx, 1);
    for (const host of hosts) {
      if (host.credentialId === id) host.credentialId = null;
    }
    saveHosts();
    return true;
  },

  'hosts.test'({ id }) {
    return new Promise((resolve) => {
      const host = hosts.find(h => h.id === id);
      if (!host) return resolve({ success: false, error: 'Unknown host' });
      try { assertHostAllowed(host.hostname); } catch (e) { return resolve({ success: false, error: e.message }); }
      const conn = new SSHClient();
      let runtimeHost = host;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { conn.end(); } catch {}
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ success: false, error: 'Timed out (15s)' }), 15000);
      conn.on('ready', () => finish({ success: true, message: `Connected to ${runtimeHost._displayHostname || runtimeHost.hostname} as ${runtimeHost.username}` }));
      conn.on('error', (err) => finish({ success: false, error: err.message }));
      (async () => {
        try {
          const prepared = await getConnectionAuthConfig(host, 15000);
          runtimeHost = prepared.runtimeHost;
          conn.connect(prepared.authConfig);
        } catch (e) {
          finish({ success: false, error: e.message });
        }
      })();
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

    (async () => {
      try {
        const prepared = await getConnectionAuthConfig(host, 15000);
        conn.connect(prepared.authConfig);
      } catch (e) {
        audit(sessionId, 'error', { host: host.hostname, error: e.message });
        sessions.delete(sessionId);
        client.send({ type: 'session.error', sessionId, error: e.message });
      }
    })();
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

  async 'exec.run'({ hostId, command, cwd, timeout = 30000 }) {
    if (!hostId || !command) throw new Error('hostId and command are required');
    const maxBuffer = 1024 * 1024;
    const timeoutMs = Math.min(Number(timeout) || 30000, 120000);
    const { conn, host } = await connectHost(hostId, Math.min(timeoutMs, 15000));
    audit('exec', 'remoteExec', { hostId, command: String(command).slice(0, 200) });
    try {
      return await new Promise((resolve, reject) => {
        let streamRef = null;
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try { streamRef?.close?.(); } catch {}
          try { streamRef?.destroy?.(); } catch {}
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const cmd = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
        conn.exec(cmd, {}, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          streamRef = stream;
          stream.on('data', (d) => {
            stdout += d.toString('utf8');
            if (stdout.length > maxBuffer) {
              clearTimeout(timer);
              stream.destroy();
              reject(new Error('stdout exceeded 1MB'));
            }
          });
          stream.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
            if (stderr.length > maxBuffer) {
              clearTimeout(timer);
              stream.destroy();
              reject(new Error('stderr exceeded 1MB'));
            }
          });
          stream.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 0, host: host.name || host.hostname });
          });
          stream.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
        });
      });
    } finally {
      try { conn.end(); } catch {}
    }
  },

  async 'sftp.listDir'({ hostId, remotePath = '/' }) {
    if (!hostId) throw new Error('hostId is required');
    audit('sftp', 'listDir', { hostId, path: remotePath });
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      sftp.readdir(remotePath || '/', (err, list) => {
        if (err) return reject(err);
        resolve((list || []).map(item => ({
          name: item.filename,
          isDir: !!(item.attrs.mode & 0o40000),
          size: item.attrs.size || 0,
          modified: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
        })));
      });
    }));
  },

  async 'sftp.stat'({ hostId, remotePath }) {
    if (!hostId || !remotePath) throw new Error('hostId and remotePath are required');
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => err ? reject(err) : resolve(statShape(stats)));
    }));
  },

  async 'sftp.readFile'({ hostId, remotePath, maxBytes = 2097152 }) {
    if (!hostId || !remotePath) throw new Error('hostId and remotePath are required');
    audit('sftp', 'readFile', { hostId, path: remotePath });
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        const shaped = statShape(stats);
        if (shaped.isDir) return reject(new Error(`${remotePath} is a directory`));
        if (shaped.size > maxBytes) return reject(new Error(`File too large: ${shaped.size} bytes (max ${maxBytes})`));
        const chunks = [];
        let bytes = 0;
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            stream.destroy();
            reject(new Error(`File exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => resolve({ dataBase64: Buffer.concat(chunks).toString('base64') }));
        stream.on('error', reject);
      });
    }));
  },

  async 'sftp.writeFile'({ hostId, remotePath, contentBase64 }) {
    if (!hostId || !remotePath || contentBase64 === undefined) throw new Error('hostId, remotePath, and contentBase64 are required');
    const buf = Buffer.from(String(contentBase64), 'base64');
    if (buf.length > 10 * 1024 * 1024) throw new Error(`Write payload too large: ${buf.length} bytes exceeds 10485760 byte limit`);
    audit('sftp', 'writeFile', { hostId, path: remotePath, size: buf.length });
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => resolve({ written: buf.length, path: remotePath }));
      stream.on('error', reject);
      stream.end(buf);
    }));
  },

  async 'sftp.mkdir'({ hostId, remotePath }) {
    if (!hostId || !remotePath) throw new Error('hostId and remotePath are required');
    audit('sftp', 'mkdir', { hostId, path: remotePath });
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => err ? reject(err) : resolve({ created: remotePath }));
    }));
  },

  async 'sftp.delete'({ hostId, remotePath }) {
    if (!hostId || !remotePath) throw new Error('hostId and remotePath are required');
    audit('sftp', 'delete', { hostId, path: remotePath });
    return withSftp(hostId, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) return reject(statErr);
        const done = (err) => err ? reject(err) : resolve({ deleted: remotePath });
        if (statShape(stats).isDir) sftp.rmdir(remotePath, done);
        else sftp.unlink(remotePath, done);
      });
    }));
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
