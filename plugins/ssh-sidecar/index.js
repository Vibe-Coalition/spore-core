// ssh-sidecar plugin — owns the optional SSH credential-isolation runtime.
//
// Core's SSHManager remains the RPC client and local fallback. This plugin
// decides whether the sidecar path is active for this boot, exposes operator
// status in Settings, and installs agent-facing reference docs.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTERNAL_SOCKET_PATH = process.env.SIDECAR_SOCKET || '/run/ssh-sidecar/sidecar.sock';
const MANAGED_DIR = '/data/ssh-sidecar';
const MANAGED_SOCKET_PATH = path.join(MANAGED_DIR, 'sidecar.sock');
const MANAGED_STORE = path.join(MANAGED_DIR, 'ssh-hosts.json');
const MANAGED_AUDIT = path.join(MANAGED_DIR, 'terminal-audit.log');
const MANAGED_SECRET = path.join(MANAGED_DIR, 'passphrase');
const MANAGED_LOG = path.join(MANAGED_DIR, 'sidecar.log');
let _managedProc = null;
let _ensurePromise = null;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function socketState(socketPath = EXTERNAL_SOCKET_PATH) {
  try {
    const st = fs.statSync(socketPath);
    return { present: true, isSocket: typeof st.isSocket === 'function' ? st.isSocket() : false };
  } catch {
    return { present: false, isSocket: false };
  }
}

function sidecarRpc(method, params = {}, timeoutMs = 2500, socketPath = EXTERNAL_SOCKET_PATH) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(error ? { ok: false, error } : { ok: true, result });
    };
    const timer = setTimeout(() => finish(null, 'sidecar status RPC timed out'), timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 1, method, params }) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) finish(msg.result || null, msg.error || null);
        } catch (e) {
          finish(null, 'invalid sidecar response: ' + e.message);
        }
      }
    });
    socket.on('error', (e) => finish(null, e.message));
    socket.on('close', () => {
      if (!settled) finish(null, 'sidecar closed before responding');
    });
  });
}

async function readJson(req, limit = 256 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  if (!body) return {};
  return JSON.parse(body);
}

function ensureManagedSecret() {
  fs.mkdirSync(MANAGED_DIR, { recursive: true });
  try {
    if (fs.existsSync(MANAGED_SECRET)) {
      const existing = fs.readFileSync(MANAGED_SECRET, 'utf8').trim();
      if (existing) return existing;
    }
  } catch {}
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(MANAGED_SECRET, generated + '\n', { mode: 0o600 });
  return generated;
}

async function socketResponds(socketPath) {
  const st = socketState(socketPath);
  if (!st.present || !st.isSocket) return false;
  const rpc = await sidecarRpc('sidecar.status', {}, 1200, socketPath);
  return !!rpc.ok;
}

async function ensureSidecar(api) {
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    const cfg = api._appContext?.config || {};
    if (await socketResponds(EXTERNAL_SOCKET_PATH)) {
      cfg.sshSidecarSocket = EXTERNAL_SOCKET_PATH;
      return { ok: true, mode: 'external-socket', socketPath: EXTERNAL_SOCKET_PATH };
    }
    if (await socketResponds(MANAGED_SOCKET_PATH)) {
      cfg.sshSidecarSocket = MANAGED_SOCKET_PATH;
      return { ok: true, mode: 'managed-process', socketPath: MANAGED_SOCKET_PATH };
    }

    fs.mkdirSync(MANAGED_DIR, { recursive: true });
    try { fs.unlinkSync(MANAGED_SOCKET_PATH); } catch {}
    const passphrase = process.env.SIDECAR_PASSPHRASE
      || process.env.SPORE_SSH_SIDECAR_PASSPHRASE
      || ensureManagedSecret();
    const sidecarScript = path.join(__dirname, 'sidecar', 'ssh-sidecar.js');
    let logFd = null;
    try { logFd = fs.openSync(MANAGED_LOG, 'a'); } catch {}
    _managedProc = spawn(process.execPath, [sidecarScript], {
      cwd: path.dirname(sidecarScript),
      detached: true,
      env: {
        ...process.env,
        NODE_PATH: process.env.NODE_PATH || '/app/node_modules',
        SIDECAR_PASSPHRASE: passphrase,
        SIDECAR_SOCKET: MANAGED_SOCKET_PATH,
        SIDECAR_STORE: process.env.SIDECAR_STORE || MANAGED_STORE,
        SIDECAR_AUDIT_LOG: process.env.SIDECAR_AUDIT_LOG || MANAGED_AUDIT,
        SIDECAR_ALLOWED_HOSTS: process.env.SIDECAR_ALLOWED_HOSTS || process.env.SPORE_SSH_SIDECAR_ALLOWED_HOSTS || '*',
        TAILSCALE_SOCKET: process.env.TAILSCALE_SOCKET || '/data/tailscale/ts.sock',
        TAILSCALE_SOCKS_HOST: process.env.TAILSCALE_SOCKS_HOST || '127.0.0.1',
        TAILSCALE_SOCKS_PORT: process.env.TAILSCALE_SOCKS_PORT || '1055',
      },
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    _managedProc.on('error', e => api.getLogger().warn('managed sidecar spawn failed: ' + e.message));
    _managedProc.unref();
    if (logFd !== null) {
      _managedProc.on('close', () => { try { fs.closeSync(logFd); } catch {} });
    }

    for (let i = 0; i < 30; i++) {
      if (await socketResponds(MANAGED_SOCKET_PATH)) {
        cfg.sshSidecarSocket = MANAGED_SOCKET_PATH;
        return { ok: true, mode: 'managed-process', socketPath: MANAGED_SOCKET_PATH };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, mode: 'managed-process', socketPath: MANAGED_SOCKET_PATH, error: 'managed sidecar did not become ready' };
  })().finally(() => { _ensurePromise = null; });
  return _ensurePromise;
}

async function sidecarJson(api, res, method, params = {}, timeoutMs = 5000) {
  const ensured = await ensureSidecar(api);
  const socketPath = ensured.socketPath || api._appContext?.config?.sshSidecarSocket || EXTERNAL_SOCKET_PATH;
  if (!ensured.ok) {
    sendJson(res, 503, { ok: false, error: ensured.error || 'SSH sidecar is not ready' });
    return null;
  }
  const rpc = await sidecarRpc(method, params, timeoutMs, socketPath);
  if (!rpc.ok) {
    sendJson(res, 500, { ok: false, error: rpc.error || 'sidecar RPC failed' });
    return null;
  }
  return rpc.result;
}

module.exports = function register(api) {
  const cfg = api._appContext?.config;
  if (cfg) {
    cfg.sshSidecarEnabled = true;
    cfg.sshSidecarSocket = socketState(EXTERNAL_SOCKET_PATH).isSocket ? EXTERNAL_SOCKET_PATH : MANAGED_SOCKET_PATH;
  }

  api.registerReferenceNodes({
    install: './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 3,
  });

  api.registerSettingsPane({
    title: 'SSH Sidecar',
    description: 'Optional process isolation for SSH keys and remote terminal sessions.',
    html: '<div data-plugin-mount="ssh-sidecar">Loading...</div>',
  });
  api.registerFrontendAsset('ssh-sidecar-settings.js');

  api.registerWebRoute('GET', '/status', async (_req, res) => {
    const ensured = await ensureSidecar(api);
    const socketPath = ensured.socketPath || cfg?.sshSidecarSocket || EXTERNAL_SOCKET_PATH;
    const state = socketState(socketPath);
    const manager = api._appContext?.tools?._sshManager
      || api._appContext?.tools?.gateway?._sshManager
      || null;
    if (manager && !manager.isSidecarReady?.() && state.present && state.isSocket && manager.reconnectSidecar) {
      try { manager.reconnectSidecar(socketPath); } catch {}
    }
    const managerStatus = manager?.getStatus ? manager.getStatus() : null;

    const out = {
      enabled: true,
      mode: ensured.mode || 'external-socket',
      socketPath,
      socketPresent: state.present,
      socketIsSocket: state.isSocket,
      autoStartError: ensured.ok === false ? ensured.error || 'auto-start failed' : null,
      manager: managerStatus,
      sidecar: null,
    };

    if (state.present && state.isSocket) {
      const rpc = await sidecarRpc('sidecar.status', {}, 2500, socketPath);
      if (rpc.ok) out.sidecar = rpc.result;
      else out.sidecar = { ok: false, error: rpc.error };
    }

    sendJson(res, 200, out);
  });

  api.registerWebRoute('GET', '/hosts', async (_req, res) => {
    try {
      const hosts = await sidecarJson(api, res, 'hosts.list', {}, 5000);
      if (!hosts) return;
      sendJson(res, 200, { ok: true, hosts: Array.isArray(hosts) ? hosts : [] });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  api.registerWebRoute('POST', '/hosts', async (req, res) => {
    try {
      const body = await readJson(req);
      const hostname = String(body.hostname || '').trim();
      const username = String(body.username || '').trim();
      if (!hostname || !username) {
        sendJson(res, 400, { ok: false, error: 'hostname and username are required' });
        return;
      }
      const payload = {
        id: body.id ? String(body.id) : undefined,
        name: String(body.name || hostname).trim(),
        hostname,
        port: Math.max(1, Math.min(65535, Number(body.port || 22) || 22)),
        username,
      };
      const privateKey = String(body.privateKey || '').trim();
      const password = body.password == null ? '' : String(body.password);
      if (privateKey) payload.privateKey = privateKey.endsWith('\n') ? privateKey : privateKey + '\n';
      if (password) payload.password = password;
      if (body.proxy !== undefined) payload.proxy = body.proxy || null;
      if (body.metadata !== undefined) payload.metadata = body.metadata || null;

      const saved = await sidecarJson(api, res, 'hosts.save', payload, 8000);
      if (!saved) return;
      sendJson(res, 200, { ok: true, ...saved });
    } catch (e) {
      const code = /body too large/.test(e.message) ? 413 : 400;
      sendJson(res, code, { ok: false, error: e.message });
    }
  });

  api.registerWebRoute('POST', '/hosts/test', async (req, res) => {
    try {
      const body = await readJson(req, 4096);
      const id = String(body.id || '').trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'host id is required' });
        return;
      }
      const result = await sidecarJson(api, res, 'hosts.test', { id }, 20000);
      if (!result) return;
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
  });

  api.registerWebRoute('POST', '/hosts/delete', async (req, res) => {
    try {
      const body = await readJson(req, 4096);
      const id = String(body.id || '').trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'host id is required' });
        return;
      }
      const deleted = await sidecarJson(api, res, 'hosts.delete', { id }, 5000);
      if (deleted === null) return;
      sendJson(res, 200, { ok: deleted !== false, deleted: deleted !== false });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
  });

  api.onShutdown(() => {
    if (cfg) cfg.sshSidecarEnabled = false;
    const tools = api._appContext?.tools;
    const mgr = tools?._sshManager || tools?.gateway?._sshManager || null;
    if (mgr?.closeAll) {
      try { mgr.closeAll(); } catch {}
    }
    if (tools) tools._sshManager = null;
    if (tools?.gateway) tools.gateway._sshManager = null;
    if (_managedProc && !_managedProc.killed) {
      try { _managedProc.kill('SIGTERM'); } catch {}
    }
    _managedProc = null;
  });

  ensureSidecar(api).then(result => {
    if (result?.ok) api.getLogger().info(`SSH sidecar ready (${result.mode}) at ${result.socketPath}`);
    else api.getLogger().warn(`SSH sidecar auto-start failed: ${result?.error || 'unknown error'}`);
  }).catch(e => api.getLogger().warn('SSH sidecar auto-start failed: ' + (e?.message || e)));

  api.getLogger().info(`Plugin ready — SSHManager may use ${cfg?.sshSidecarSocket || EXTERNAL_SOCKET_PATH} when the sidecar service is running.`);
};
