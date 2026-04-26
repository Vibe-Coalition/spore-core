// tailscale plugin — exposes /api/tailscale/{status,login,logout}
// + ref-tailscale reference node.
//
// Auth: all three routes require creator authentication. The
// ws-aware path-alias plumbing in core preserves /api/tailscale/* by
// rewriting to /api/plugins/tailscale/*.
//
// State (this._tsAuthUrl, this._tsLoginProc) lives on the closure of
// the plugin's register function — survives across requests within
// one plugin lifetime. Cleared on uninstall via shutdown handler.

const { spawn } = require('child_process');
const { tsRun, TS_SOCKET } = require('./lib/tailscale-cli');

module.exports = function register(api) {
  // In-memory state — closure over the plugin's lifetime.
  let _tsAuthUrl = null;
  let _tsAuthUrlExpiresAt = 0;
  let _tsLoginProc = null;

  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  // Path alias so existing UI + scripts that hit /api/tailscale/* keep
  // working. Core's resolvePathAlias rewrites to /api/plugins/tailscale/*
  // and dispatches into the registerWebRoute handlers below.
  api.registerPathAlias('tailscale', { notFoundCode: 'TAILSCALE_ROUTE_NOT_FOUND' });

  async function statusHandler(req, res) {
    try {
      const r = await tsRun(['status', '--json'], 8000);
      if (r.code !== 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backend: 'Stopped', error: (r.stderr || '').trim().slice(0, 300), authUrl: _tsAuthUrl || null }));
        return;
      }
      let j;
      try { j = JSON.parse(r.stdout); } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'tailscale status parse: ' + e.message })); return;
      }
      const peers = [];
      for (const key of Object.keys(j.Peer || {})) {
        const p = j.Peer[key];
        peers.push({ hostName: p.HostName, dnsName: p.DNSName, addrs: p.TailscaleIPs || [], online: !!p.Online, os: p.OS, tags: p.Tags || [] });
      }
      peers.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        backend: j.BackendState || 'Unknown',
        tailnetIp: (j.Self?.TailscaleIPs || [])[0] || null,
        hostname: j.Self?.HostName || null,
        dnsName: j.Self?.DNSName || null,
        peers,
        peerCount: peers.length,
        onlineCount: peers.filter(p => p.online).length,
        authUrl: (j.BackendState === 'NeedsLogin' ? (_tsAuthUrl || null) : null),
      }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function loginHandler(req, res) {
    api.getLogger().info('login endpoint hit — initiating `tailscale up`');
    try {
      // If already connected, short-circuit.
      const status = await tsRun(['status', '--json'], 5000);
      if (status.code === 0) {
        try {
          const j = JSON.parse(status.stdout);
          if (j.BackendState === 'Running') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'already-connected', tailnetIp: (j.Self?.TailscaleIPs || [])[0] || null }));
            return;
          }
        } catch {}
      }

      // Resolve hostname from host config (legacy SPORE_TAILSCALE_HOSTNAME
      // env var) or default to spore-<agentId>.
      const cfg = api._appContext?.config || {};
      const hostname = cfg.tailscaleHostname || `spore-${cfg.agentId || 'agent'}`;

      // `--reset` clears any half-persisted flag state from a previous
      // partial login attempt, so our flag set becomes canonical.
      // `up` needs root → sudo -n tailscale.
      const args = [
        '-n', 'tailscale',
        '--socket', TS_SOCKET, 'up',
        '--reset',
        '--hostname', hostname,
        '--operator', 'spore',
        '--accept-routes',
        '--ssh',
        '--timeout=0',
      ];

      // Kill any stale previous login attempt.
      if (_tsLoginProc && !_tsLoginProc.killed) {
        try { _tsLoginProc.kill('SIGTERM'); } catch {}
      }
      _tsAuthUrl = null;
      const proc = spawn('sudo', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      _tsLoginProc = proc;
      _tsAuthUrlExpiresAt = Date.now() + 10 * 60_000;

      const urlRegex = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/;
      const capture = (chunk) => {
        const m = chunk.toString().match(urlRegex);
        if (m && !_tsAuthUrl) {
          _tsAuthUrl = m[0];
          api.getLogger().info('login URL captured');
        }
      };
      proc.stdout.on('data', capture);
      proc.stderr.on('data', capture);
      proc.on('close', (code) => {
        api.getLogger().info(`up process exited ${code}`);
        _tsLoginProc = null;
        if (code === 0) _tsAuthUrl = null;
      });

      // Poll for URL up to 6s.
      let waited = 0;
      while (!_tsAuthUrl && waited < 6000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }

      if (!_tsAuthUrl) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'no-url-yet', message: 'tailscale up running; poll /api/tailscale/status' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'pending-auth', authUrl: _tsAuthUrl, expiresAt: _tsAuthUrlExpiresAt }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function logoutHandler(req, res) {
    try {
      const r = await tsRun(['logout'], 15000);
      _tsAuthUrl = null;
      if (_tsLoginProc && !_tsLoginProc.killed) {
        try { _tsLoginProc.kill('SIGTERM'); } catch {}
      }
      res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.code === 0, stderr: (r.stderr || '').trim().slice(0, 300) }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  }

  // /status is creator-gated by core's default plugin-route auth (no
  // `public:true` flag); same for login/logout.
  api.registerWebRoute('GET',  '/status', statusHandler);
  api.registerWebRoute('POST', '/login',  loginHandler);
  api.registerWebRoute('POST', '/logout', logoutHandler);

  // Hostname settings — read/write the tailnet hostname used by
  // `tailscale up --hostname <value>`. Persists to env so the host's
  // config.tailscaleHostname survives restarts; loginHandler reads
  // the same value via api.getHostConfig().
  api.registerWebRoute('GET', '/settings', (req, res) => {
    const cfg = api._appContext?.config || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hostname: cfg.tailscaleHostname || `spore-${cfg.agentId || 'agent'}`,
    }));
  });
  api.registerWebRoute('POST', '/settings', async (req, res) => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return; } }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'bad body' })); return; }
    const cfg = api._appContext?.config || {};
    const clean = String(parsed.hostname || '').trim().replace(/[^a-zA-Z0-9.-]/g, '') || `spore-${cfg.agentId || 'agent'}`;
    cfg.tailscaleHostname = clean;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') {
        gw._applyEnvUpdates({ SPORE_TAILSCALE_HOSTNAME: clean });
      }
    } catch (e) { api.getLogger().warn('hostname persist failed: ' + e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hostname: clean }));
  });

  // Settings pane — appears in the Plugins tab. Markup is a thin
  // mount-point; the frontend asset (loaded by graph-viewer.html via
  // registerFrontendAsset) populates it on the spore-plugin-panes-
  // rendered event and wires up the live handlers.
  api.registerSettingsPane({
    title: 'Tailscale',
    description: 'Mesh-VPN access. Log in via SSO; state persists at /data/tailscale across container restarts.',
    html: '<div data-plugin-mount="tailscale">Loading…</div>',
  });
  api.registerFrontendAsset('tailscale-settings.js');

  // Shutdown: kill any active login process so plugin uninstall doesn't
  // leave a child SUDO process running in the container.
  api.onShutdown(() => {
    if (_tsLoginProc && !_tsLoginProc.killed) {
      try { _tsLoginProc.kill('SIGTERM'); } catch {}
    }
    _tsLoginProc = null;
    _tsAuthUrl = null;
  });

  api.getLogger().info('Plugin ready — /api/tailscale/{status,login,logout,settings} + ref-tailscale node + settings pane + frontend asset registered.');
};
