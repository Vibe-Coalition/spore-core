// Tailscale CLI helpers — extracted verbatim from src/gateways/web.js.
//
// The Node process runs as unprivileged `spore`. Tailscale's `up` /
// `logout` / `set` need root (or an already-persisted operator
// setting, which itself can only be set by root). Sudoers grants
// passwordless `/usr/bin/tailscale` to spore — we use it
// unconditionally so we don't depend on the operator-persist side
// channel.
//
// The container must have tailscaled running for any of this to work.
// That setup lives in entrypoint.sh + Dockerfile, gated by
// SPORE_TAILSCALE_ENABLED=true.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TS_DIR = '/data/tailscale';
const TS_SOCKET = '/data/tailscale/ts.sock';
const TS_LOG = '/data/tailscale/tailscaled.log';
let _tailscaledProc = null;
let _ensurePromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _isSocket(file) {
  try { return fs.statSync(file).isSocket(); } catch { return false; }
}

function _rawRun(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
  });
}

async function _socketResponds() {
  if (!_isSocket(TS_SOCKET)) return false;
  const r = await _rawRun('/usr/bin/tailscale', ['--socket', TS_SOCKET, 'status', '--json'], 3000);
  const out = String(r.stdout || '').trim();
  if (out.startsWith('{') && out.endsWith('}')) return true;
  const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
  return !/failed to connect|connect: no such file|connection refused/i.test(combined);
}

async function _setOperator() {
  await _rawRun('sudo', ['-n', 'tailscale', '--socket', TS_SOCKET, 'set', '--operator=spore'], 5000);
}

async function ensureTailscaled() {
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    if (await _socketResponds()) return { ok: true, started: false, socket: TS_SOCKET };

    fs.mkdirSync(TS_DIR, { recursive: true });
    let logFd = null;
    try { logFd = fs.openSync(TS_LOG, 'a'); } catch {}
    const stdio = ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'];
    _tailscaledProc = spawn('/usr/sbin/tailscaled', [
      '--tun=userspace-networking',
      `--state=${path.join(TS_DIR, 'state')}`,
      `--socket=${TS_SOCKET}`,
      '--socks5-server=localhost:1055',
      '--outbound-http-proxy-listen=localhost:1055',
    ], {
      detached: true,
      stdio,
    });
    _tailscaledProc.on('error', () => {});
    _tailscaledProc.unref();
    if (logFd !== null) {
      _tailscaledProc.on('close', () => { try { fs.closeSync(logFd); } catch {} });
    }

    for (let i = 0; i < 20; i++) {
      if (await _socketResponds()) {
        await _setOperator();
        return { ok: true, started: true, socket: TS_SOCKET };
      }
      await sleep(250);
    }
    return { ok: false, started: true, socket: TS_SOCKET, error: 'tailscaled socket did not become ready' };
  })().finally(() => { _ensurePromise = null; });
  return _ensurePromise;
}

/** Spawn `sudo -n tailscale --socket <ts.sock> <args>` and capture
 *  stdout / stderr / exit code. Times out after `timeoutMs`.
 */
async function tsRun(args, timeoutMs = 10000) {
  await ensureTailscaled();
  return _rawRun('sudo', ['-n', 'tailscale', '--socket', TS_SOCKET, ...args], timeoutMs);
}

module.exports = { ensureTailscaled, tsRun, TS_DIR, TS_SOCKET };
