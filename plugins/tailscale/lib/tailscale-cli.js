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

const { spawn } = require('child_process');

const TS_SOCKET = '/data/tailscale/ts.sock';

/** Spawn `sudo -n tailscale --socket <ts.sock> <args>` and capture
 *  stdout / stderr / exit code. Times out after `timeoutMs`.
 */
function tsRun(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proc = spawn('sudo', ['-n', 'tailscale', '--socket', TS_SOCKET, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
  });
}

module.exports = { tsRun, TS_SOCKET };
