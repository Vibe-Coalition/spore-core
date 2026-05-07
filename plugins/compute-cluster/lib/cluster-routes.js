// HTTP route handlers for the compute-cluster plugin.
//
// Cluster credentials are owned by SSHManager/ssh-sidecar, not by this
// plugin. Generated keys are created inside the sidecar; the app process
// receives only public key metadata. Pasted keys transit this route once
// so the operator can import an existing key, but no route can read a
// private key back out.

const fs = require('fs');

const CLUSTER_CREDENTIAL_ID = 'cluster-default';
const PRIMARY_CLUSTER_HOST_ID = 'cluster-login';
const LEGACY_KEY_PATH = '/data/.ssh/id_cluster';
const LEGACY_PUB_PATH = `${LEGACY_KEY_PATH}.pub`;

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 64) throw new Error('body too large');
  }
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getSshManager(api) {
  const tools = api._appContext?.tools || null;
  if (tools?._ensureSSHManager) return tools._ensureSSHManager();
  if (tools?._sshManager) return tools._sshManager;
  const gateway = tools?.gateway || api._appContext?.gateways?.getGateway?.('web') || null;
  if (gateway?._ensureSSHManager) return gateway._ensureSSHManager();
  return gateway?._sshManager || null;
}

function managerSidecarReady(mgr) {
  if (!mgr) return false;
  if (typeof mgr.isSidecarReady === 'function') return mgr.isSidecarReady();
  const status = mgr.getStatus?.();
  return !!(status?.sidecarReady && !status?.localMode);
}

async function ensureSidecarReady(mgr) {
  if (!mgr) return false;
  if (managerSidecarReady(mgr)) return true;
  if (typeof mgr.waitForSidecarReady === 'function') return await mgr.waitForSidecarReady(1200);
  return managerSidecarReady(mgr);
}

function sidecarRequiredMessage() {
  return 'Compute Cluster SSH keys now require the SSH Sidecar service. Install/enable ssh-sidecar and start the sidecar service; no manual keystore unlock is needed.';
}

function slug(value, fallback = 'cluster') {
  const s = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function clusterProxy() {
  if (String(process.env.SPORE_CLUSTER_SSH_PROXY || '').toLowerCase() === 'none') return null;
  const host = process.env.SPORE_CLUSTER_SOCKS_HOST || '127.0.0.1';
  const port = Number(process.env.SPORE_CLUSTER_SOCKS_PORT || 1055);
  return { type: 'socks5', host, port };
}

function computeHostEntries(cfg, credentialReady) {
  if (!credentialReady) return [];
  const proxy = clusterProxy();
  const entries = [];
  const username = String(cfg.clusterUsername || '').trim();
  const loginHost = String(cfg.clusterLoginHost || '').trim();
  if (username && loginHost) {
    entries.push({
      id: PRIMARY_CLUSTER_HOST_ID,
      name: 'Cluster login',
      hostname: loginHost,
      port: 22,
      username,
      credentialId: CLUSTER_CREDENTIAL_ID,
      proxy,
      metadata: { source: 'compute-cluster', role: 'primary' },
    });
  }

  const extra = Array.isArray(cfg.clusterHosts) ? cfg.clusterHosts : [];
  extra.forEach((h, idx) => {
    if (!h || typeof h !== 'object') return;
    const hostname = String(h.host || '').trim();
    if (!hostname) return;
    const name = String(h.name || hostname).trim();
    entries.push({
      id: `cluster-${slug(name || hostname || idx, `host-${idx + 1}`)}`,
      name,
      hostname,
      port: 22,
      username: String(h.username || username || '').trim(),
      credentialId: CLUSTER_CREDENTIAL_ID,
      proxy,
      metadata: { source: 'compute-cluster', role: 'additional' },
    });
  });

  return entries.filter(h => h.username && h.hostname);
}

async function getClusterCredential(mgr) {
  if (!mgr?.getCredentialPublic || !(await ensureSidecarReady(mgr))) {
    return { id: CLUSTER_CREDENTIAL_ID, hasPrivate: false, publicKey: null, fingerprint: null, error: sidecarRequiredMessage() };
  }
  return await mgr.getCredentialPublic(CLUSTER_CREDENTIAL_ID);
}

async function migrateLegacyCredential(api, mgr, credential) {
  if (!(await ensureSidecarReady(mgr)) || credential?.hasPrivate || !fs.existsSync(LEGACY_KEY_PATH)) return { credential, migrated: false };
  try {
    const privateKey = fs.readFileSync(LEGACY_KEY_PATH, 'utf8');
    const imported = await mgr.saveCredentialPrivateKey({
      id: CLUSTER_CREDENTIAL_ID,
      name: 'Compute Cluster',
      privateKey,
      metadata: { source: 'compute-cluster', migratedFrom: LEGACY_KEY_PATH },
    });
    try { fs.unlinkSync(LEGACY_KEY_PATH); } catch {}
    try { fs.unlinkSync(LEGACY_PUB_PATH); } catch {}
    api.getLogger().info('Migrated legacy cluster SSH key into ssh-sidecar credential profile and removed /data/.ssh/id_cluster');
    return { credential: imported, migrated: true };
  } catch (e) {
    api.getLogger().warn(`Legacy cluster key migration failed: ${e.message}`);
    return { credential: { ...credential, error: e.message }, migrated: false };
  }
}

async function syncClusterHosts(api, opts = {}) {
  const cfg = api._appContext?.config || {};
  const mgr = getSshManager(api);
  if (!mgr) throw new Error('SSH manager not available');
  if (opts.requireSidecar && !(await ensureSidecarReady(mgr))) throw new Error(sidecarRequiredMessage());

  let credential = await getClusterCredential(mgr);
  const migration = await migrateLegacyCredential(api, mgr, credential);
  credential = migration.credential;

  const desired = computeHostEntries(cfg, !!credential?.hasPrivate);
  const desiredIds = new Set(desired.map(h => h.id));
  for (const host of desired) {
    await mgr.saveHost(host);
  }

  try {
    const existing = await mgr.listHosts();
    for (const host of existing || []) {
      if (host?.metadata?.source !== 'compute-cluster') continue;
      if (!desiredIds.has(host.id)) await mgr.deleteHost(host.id);
    }
  } catch (e) {
    api.getLogger().warn(`cluster host cleanup failed: ${e.message}`);
  }

  return { mgr, credential, hosts: desired, migrated: migration.migrated };
}

function getSettings(api, req, res) {
  const cfg = api._appContext?.config || {};
  sendJson(res, 200, {
    clusterUsername: cfg.clusterUsername || '',
    clusterLoginHost: cfg.clusterLoginHost || '',
    clusterTmuxPrefix: cfg.clusterTmuxPrefix || 'spore',
    clusterHosts: Array.isArray(cfg.clusterHosts) ? cfg.clusterHosts : [],
  });
}

async function postSettings(api, req, res) {
  try {
    const body = await readJson(req);
    const clean = (v) => (typeof v === 'string' ? v.trim() : '');
    const cfg = api._appContext?.config || {};
    const envUpd = {};
    const updates = {};
    if ('clusterUsername' in body) { updates.clusterUsername = clean(body.clusterUsername) || null; envUpd.SPORE_CLUSTER_USERNAME = clean(body.clusterUsername); }
    if ('clusterLoginHost' in body) { updates.clusterLoginHost = clean(body.clusterLoginHost) || null; envUpd.SPORE_CLUSTER_LOGIN_HOST = clean(body.clusterLoginHost); }
    if ('clusterTmuxPrefix' in body) {
      const p = clean(body.clusterTmuxPrefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'spore';
      updates.clusterTmuxPrefix = p;
      envUpd.SPORE_CLUSTER_TMUX_PREFIX = p;
    }
    Object.assign(cfg, updates);
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function' && Object.keys(envUpd).length) {
        gw._applyEnvUpdates(envUpd);
      }
    } catch (e) { api.getLogger().warn('cluster-settings persist failed: ' + e.message); }

    let ssh = null;
    try {
      const synced = await syncClusterHosts(api);
      ssh = { credentialReady: !!synced.credential?.hasPrivate, hosts: synced.hosts.map(h => h.id), migrated: synced.migrated };
    } catch (e) {
      ssh = { error: e.message };
    }

    sendJson(res, 200, { ok: true, saved: updates, ssh });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
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
        name: String(h.name || '').trim().slice(0, 64),
        host: String(h.host || '').trim().slice(0, 128),
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

    let ssh = null;
    try {
      const synced = await syncClusterHosts(api);
      ssh = { credentialReady: !!synced.credential?.hasPrivate, hosts: synced.hosts.map(h => h.id), migrated: synced.migrated };
    } catch (e) {
      ssh = { error: e.message };
    }

    sendJson(res, 200, { ok: true, hosts: cleanList, ssh });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function postTestSsh(api, req, res) {
  try {
    const body = await readJson(req).catch(() => ({}));
    const cfg = api._appContext?.config || {};
    if (body.user) cfg.clusterUsername = String(body.user || '').trim();
    if (body.host) cfg.clusterLoginHost = String(body.host || '').trim();

    if (!cfg.clusterUsername || !cfg.clusterLoginHost) {
      sendJson(res, 400, { ok: false, error: 'username and host required (set Cluster settings first)' });
      return;
    }

    const synced = await syncClusterHosts(api, { requireSidecar: true });
    if (!synced.credential?.hasPrivate) {
      sendJson(res, 400, {
        ok: false,
        error: 'No cluster SSH credential installed',
        hint: 'Generate a key, copy the public key to ~/.ssh/authorized_keys on the cluster login node, then test again.',
      });
      return;
    }

    const hostId = body.hostId || PRIMARY_CLUSTER_HOST_ID;
    const result = await synced.mgr.remoteExec(hostId, 'hostname; which sbatch || echo no-slurm; sinfo --version 2>/dev/null || echo no-sinfo', { timeout: 20000 });
    const output = [result.stdout, result.stderr ? `--- stderr ---\n${result.stderr}` : ''].filter(Boolean).join('\n').trim();
    sendJson(res, 200, {
      ok: (result.exitCode ?? 0) === 0,
      code: result.exitCode ?? 0,
      output: output.slice(0, 800),
      stderr: String(result.stderr || '').trim().slice(0, 800),
      usedKey: CLUSTER_CREDENTIAL_ID,
      hostId,
      migrated: synced.migrated,
    });
  } catch (e) {
    const msg = e.message || String(e);
    let hint = 'SSH failed. Verify Tailscale is connected, the cluster username/login host are correct, and the public key is authorized on the login node.';
    if (/sidecar/i.test(msg)) hint = sidecarRequiredMessage();
    else if (/could not resolve|getaddrinfo|ENOTFOUND/i.test(msg)) hint = 'Hostname did not resolve. Verify the Tailscale plugin is installed, connected, and MagicDNS is enabled.';
    else if (/Permission denied|publickey|All configured authentication methods failed/i.test(msg)) hint = 'SSH auth rejected. Copy the public key from settings into ~/.ssh/authorized_keys on the cluster login node.';
    sendJson(res, 200, { ok: false, code: 1, stderr: msg.slice(0, 800), hint, usedKey: CLUSTER_CREDENTIAL_ID });
  }
}

async function getSshKey(api, req, res) {
  try {
    const mgr = getSshManager(api);
    if (!mgr) {
      sendJson(res, 200, { hasPrivate: false, publicKey: null, fingerprint: null, credentialId: CLUSTER_CREDENTIAL_ID, sidecarReady: false, error: 'SSH manager not available' });
      return;
    }
    let credential = await getClusterCredential(mgr);
    const migration = await migrateLegacyCredential(api, mgr, credential);
    credential = migration.credential;
    if (migration.migrated) {
      try { await syncClusterHosts(api); } catch (e) { api.getLogger().warn(`cluster host sync after migration failed: ${e.message}`); }
    }
    sendJson(res, 200, {
      hasPrivate: !!credential?.hasPrivate,
      publicKey: credential?.publicKey || null,
      fingerprint: credential?.fingerprint || null,
      credentialId: CLUSTER_CREDENTIAL_ID,
      backend: 'ssh-sidecar',
      sidecarReady: await ensureSidecarReady(mgr),
      migrated: migration.migrated,
      error: credential?.error || null,
    });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function postSshKeyGenerate(api, req, res) {
  try {
    const cfg = api._appContext?.config || {};
    const mgr = getSshManager(api);
    if (!mgr || !(await ensureSidecarReady(mgr))) throw new Error(sidecarRequiredMessage());
    const credential = await mgr.generateCredential({
      id: CLUSTER_CREDENTIAL_ID,
      name: 'Compute Cluster',
      comment: `spore-cluster-${cfg.agentId || 'agent'}`,
      metadata: { source: 'compute-cluster' },
    });
    const synced = await syncClusterHosts(api, { requireSidecar: true });
    sendJson(res, 200, { ok: true, publicKey: credential.publicKey, fingerprint: credential.fingerprint, hosts: synced.hosts.map(h => h.id) });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function postSshKey(api, req, res) {
  try {
    const body = await readJson(req);
    const privateKey = String(body.privateKey || '').trim();
    const mgr = getSshManager(api);
    if (!mgr || !(await ensureSidecarReady(mgr))) throw new Error(sidecarRequiredMessage());
    const credential = await mgr.saveCredentialPrivateKey({
      id: CLUSTER_CREDENTIAL_ID,
      name: 'Compute Cluster',
      privateKey,
      metadata: { source: 'compute-cluster', imported: true },
    });
    const synced = await syncClusterHosts(api, { requireSidecar: true });
    sendJson(res, 200, { ok: true, publicKey: credential.publicKey, fingerprint: credential.fingerprint, hosts: synced.hosts.map(h => h.id) });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function deleteSshKey(api, req, res) {
  try {
    const mgr = getSshManager(api);
    if (!mgr || !(await ensureSidecarReady(mgr))) throw new Error(sidecarRequiredMessage());
    await mgr.deleteCredential(CLUSTER_CREDENTIAL_ID);
    await syncClusterHosts(api, { requireSidecar: true });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

module.exports = {
  getSettings, postSettings, postHosts, postTestSsh,
  getSshKey, postSshKeyGenerate, postSshKey, deleteSshKey,
};
