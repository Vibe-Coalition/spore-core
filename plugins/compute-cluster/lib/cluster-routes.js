// HTTP route handlers for the compute-cluster plugin.
// Extracted verbatim from src/gateways/web.js — same endpoint
// behavior, same response shapes, same /data/.ssh/id_cluster path.
// Operates on host config (clusterUsername / clusterLoginHost /
// clusterTmuxPrefix / clusterHosts / tailscaleHostname) so existing
// .env / spore.json contents keep working out of the box.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SSH_DIR = '/data/.ssh';
const KEY_PATH = path.join(SSH_DIR, 'id_cluster');
const PUB_PATH = KEY_PATH + '.pub';

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 64) throw new Error('body too large');
  }
  if (!body) return {};
  return JSON.parse(body);
}

function getSettings(api, req, res) {
  const cfg = api._appContext?.config || {};
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    clusterUsername:   cfg.clusterUsername || '',
    clusterLoginHost:  cfg.clusterLoginHost || '',
    clusterTmuxPrefix: cfg.clusterTmuxPrefix || 'spore',
    clusterHosts: Array.isArray(cfg.clusterHosts) ? cfg.clusterHosts : [],
  }));
}

async function postSettings(api, req, res) {
  try {
    const body = await readJson(req);
    const clean = (v) => (typeof v === 'string' ? v.trim() : '');
    const cfg = api._appContext?.config || {};
    const envUpd = {};
    const updates = {};
    if ('clusterUsername'  in body) { updates.clusterUsername  = clean(body.clusterUsername)  || null; envUpd.SPORE_CLUSTER_USERNAME    = clean(body.clusterUsername); }
    if ('clusterLoginHost' in body) { updates.clusterLoginHost = clean(body.clusterLoginHost) || null; envUpd.SPORE_CLUSTER_LOGIN_HOST  = clean(body.clusterLoginHost); }
    if ('clusterTmuxPrefix' in body) {
      const p = clean(body.clusterTmuxPrefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'spore';
      updates.clusterTmuxPrefix = p;
      envUpd.SPORE_CLUSTER_TMUX_PREFIX = p;
    }
    // tailscaleHostname now owned by the tailscale plugin (POST
    // /api/tailscale/settings). Cleanly separated.
    Object.assign(cfg, updates);
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function' && Object.keys(envUpd).length) {
        gw._applyEnvUpdates(envUpd);
      }
    } catch (e) { api.getLogger().warn('cluster-settings persist failed: ' + e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saved: updates }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function postHosts(api, req, res) {
  try {
    const body = await readJson(req);
    const hosts = Array.isArray(body.hosts) ? body.hosts : [];
    const cfg = api._appContext?.config || {};
    const cleanList = [];
    for (const h of hosts) {
      if (!h || typeof h !== 'object') continue;
      const entry = {
        name:     String(h.name || '').trim().slice(0, 64),
        host:     String(h.host || '').trim().slice(0, 128),
        username: String(h.username || '').trim().slice(0, 64),
      };
      if (!entry.host && !entry.name) continue;
      if (!entry.name) entry.name = entry.host;
      cleanList.push(entry);
    }
    cfg.clusterHosts = cleanList;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') {
        gw._applyEnvUpdates({ SPORE_CLUSTER_HOSTS: JSON.stringify(cleanList) });
      }
    } catch (e) { api.getLogger().warn('cluster-hosts persist failed: ' + e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hosts: cleanList }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function postTestSsh(api, req, res) {
  try {
    const body = await readJson(req).catch(() => ({}));
    const cfg = api._appContext?.config || {};
    const user = String(body.user || cfg.clusterUsername || '').trim();
    const host = String(body.host || cfg.clusterLoginHost || '').trim();
    if (!user || !host) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'username and host required (set Cluster settings first)' }));
      return;
    }
    const hasKey = fs.existsSync(KEY_PATH);
    // Route through tailscale's local SOCKS5 proxy so MagicDNS names
    // resolve against the tailnet and the outbound connection rides
    // the userspace-networking tailscale stack.
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=12',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=/data/.ssh/known_hosts',
      '-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:1055 %h %p',
    ];
    if (hasKey) sshArgs.push('-i', KEY_PATH, '-o', 'IdentitiesOnly=yes');
    sshArgs.push(`${user}@${host}`, 'hostname; which sbatch || echo no-slurm; sinfo --version 2>/dev/null || echo no-sinfo');
    const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 20000);
    const code = await new Promise((r) => { proc.on('close', (c) => { clearTimeout(timer); r(c); }); });
    const output = (out || '').trim();
    const stderr = (err || '').trim();
    let hint = null;
    if (code !== 0) {
      if (/could not resolve hostname|getaddrinfo/i.test(stderr)) {
        hint = 'Hostname did not resolve via MagicDNS. Verify the tailscale plugin is installed + connected (Settings → Tailscale).';
      } else if (/Permission denied|publickey/i.test(stderr)) {
        hint = hasKey
          ? 'SSH auth rejected. Make sure the public key (settings → Copy SSH public key) is in ~/.ssh/authorized_keys on the cluster login node.'
          : 'No SSH key installed. Click "Generate SSH key" below, copy the public key, and install it on the cluster (~/.ssh/authorized_keys).';
      } else {
        hint = 'SSH failed. If the hostname is unreachable, verify tailscale is connected. Otherwise check the cluster username and that your public key is authorised.';
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: code === 0,
      code,
      output: output.slice(0, 800),
      stderr: stderr.slice(0, 800),
      usedKey: hasKey ? KEY_PATH : null,
      hint,
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function getSshKey(api, req, res) {
  try {
    const hasPrivate = fs.existsSync(KEY_PATH);
    let publicKey = null, fingerprint = null;
    if (fs.existsSync(PUB_PATH)) {
      try { publicKey = fs.readFileSync(PUB_PATH, 'utf8').trim(); } catch {}
    }
    if (hasPrivate) {
      try { fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim(); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasPrivate, publicKey, fingerprint }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function postSshKeyGenerate(api, req, res) {
  try {
    const cfg = api._appContext?.config || {};
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(SSH_DIR, 0o700); } catch {}
    try { fs.unlinkSync(KEY_PATH); } catch {}
    try { fs.unlinkSync(PUB_PATH); } catch {}
    const comment = `spore-cluster-${cfg.agentId || 'agent'}`;
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', KEY_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
    try { fs.chmodSync(KEY_PATH, 0o600); } catch {}
    try { fs.chmodSync(PUB_PATH, 0o644); } catch {}
    const publicKey = fs.readFileSync(PUB_PATH, 'utf8').trim();
    const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, publicKey, fingerprint }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function postSshKey(api, req, res) {
  try {
    const body = await readJson(req);
    const privateKey = String(body.privateKey || '').trim();
    if (!privateKey.startsWith('-----BEGIN') || !privateKey.includes('PRIVATE KEY-----')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'input does not look like an SSH private key (expected PEM with BEGIN/END PRIVATE KEY markers)' }));
      return;
    }
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(SSH_DIR, 0o700); } catch {}
    fs.writeFileSync(KEY_PATH, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
    try { fs.chmodSync(KEY_PATH, 0o600); } catch {}
    let publicKey = null, fingerprint = null;
    try {
      publicKey = execFileSync('ssh-keygen', ['-y', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
      fs.writeFileSync(PUB_PATH, publicKey + '\n', { mode: 0o644 });
      fingerprint = execFileSync('ssh-keygen', ['-l', '-f', KEY_PATH], { encoding: 'utf8' }).trim();
    } catch (e) {
      try { fs.unlinkSync(KEY_PATH); } catch {}
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not derive public key — is this an encrypted / passphrase-protected key? Decrypt it first (`ssh-keygen -p -f key`) or paste an unencrypted version.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, publicKey, fingerprint }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function deleteSshKey(api, req, res) {
  try {
    try { fs.unlinkSync(KEY_PATH); } catch {}
    try { fs.unlinkSync(PUB_PATH); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

module.exports = {
  getSettings, postSettings, postHosts, postTestSsh,
  getSshKey, postSshKeyGenerate, postSshKey, deleteSshKey,
};
