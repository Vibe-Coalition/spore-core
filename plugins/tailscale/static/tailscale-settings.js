// Tailscale plugin settings UI — loaded by graph-viewer.html when the
// plugin is installed (via api.registerFrontendAsset). Populates the
// plugin's settings pane in the Plugins tab with:
//   - Live status line (polls /api/tailscale/status)
//   - Log in / Logout buttons + auth-URL reveal
//   - Hostname input (saves via /api/tailscale/settings)
//
// Listens for the 'spore-plugin-panes-rendered' event the host
// dispatches after rendering plugin panes so we can wire handlers
// without depending on graph-viewer.html knowing about us.

(function () {
  'use strict';
  if (window.__TailscaleSettings) return; // singleton guard
  window.__TailscaleSettings = true;

  const PLUGIN_ID = 'tailscale';

  const apiBase = () => (window.location.pathname.replace(/\/graph\/?$/, '') || '');
  const authHeaders = () => (typeof window.authHeaders === 'function' ? window.authHeaders() : {});

  let _pollTimer = null;
  let _mountEl = null;

  const HTML = `
    <div class="settings-note settings-muted">Mesh-VPN access via tailscaled. Log in once via SSO; state persists at <code>/data/tailscale</code> across container restarts.</div>
    <div id="ts-status" class="settings-plugin-card settings-plugin-card-row">
      <span id="ts-line" class="settings-status-muted">loading…</span>
      <span class="settings-plugin-actions tight">
        <button class="settings-btn-secondary settings-compact-btn" id="ts-login" type="button">Log in to Tailscale</button>
        <button class="settings-btn-secondary settings-compact-btn" id="ts-logout" type="button" hidden>Logout</button>
      </span>
    </div>
    <div id="ts-authurl" class="settings-plugin-auth-box" hidden>
      <div class="settings-plugin-accent-title">Open this URL in your browser and complete SSO:</div>
      <a id="ts-authurl-link" href="#" target="_blank" rel="noopener noreferrer" class="settings-plugin-link"></a>
      <div class="settings-note settings-muted">Polling status until connected…</div>
    </div>
    <label class="settings-subsection">Hostname for this container on the tailnet
      <input id="ts-hostname" type="text" autocomplete="off" placeholder="spore-<agent>">
      <div class="settings-note settings-muted-soft">Sent as <code>tailscale up --hostname &lt;value&gt;</code>. Defaults to <code>spore-&lt;agentId&gt;</code>. Saved separately from the central Save button.</div>
    </label>
    <div class="settings-row wrap">
      <button class="settings-btn-secondary settings-compact-btn" type="button" id="ts-hostname-save">Save hostname</button>
    </div>
  `;

  function setLine(line, text, kind = '') {
    if (!line) return;
    line.textContent = text;
    line.dataset.kind = kind;
  }

  async function refreshStatus() {
    if (!_mountEl) return;
    const line = _mountEl.querySelector('#ts-line');
    const loginBtn = _mountEl.querySelector('#ts-login');
    const logoutBtn = _mountEl.querySelector('#ts-logout');
    const urlBox = _mountEl.querySelector('#ts-authurl');
    const urlLink = _mountEl.querySelector('#ts-authurl-link');
    if (!line) return;
    try {
      const r = await fetch(apiBase() + '/api/tailscale/status', { headers: authHeaders() });
      const d = await r.json();
      const state = d.backend || 'Stopped';
      if (state === 'Running') {
        const ip = d.tailnetIp || '?';
        const online = d.onlineCount != null ? d.onlineCount : 0;
        const total = d.peerCount != null ? d.peerCount : 0;
        setLine(line, `connected · ${ip} · ${online}/${total} peers online`, 'ok');
        loginBtn.hidden = true;
        logoutBtn.hidden = false;
        urlBox.hidden = true;
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      } else if (state === 'NeedsLogin' || state === 'Starting') {
        setLine(line, state === 'Starting' ? 'daemon starting…' : 'not logged in');
        loginBtn.hidden = false;
        logoutBtn.hidden = true;
        if (d.authUrl) {
          urlBox.hidden = false;
          urlLink.href = d.authUrl;
          urlLink.textContent = d.authUrl;
        } else {
          urlBox.hidden = true;
        }
      } else {
        setLine(line, d.error ? `tailscaled not running · ${String(d.error).slice(0, 80)}` : `state: ${state}`, 'err');
        loginBtn.hidden = false;
        logoutBtn.hidden = true;
        urlBox.hidden = true;
      }
    } catch (e) {
      setLine(line, 'status unavailable: ' + e.message, 'err');
    }
  }

  async function triggerLogin() {
    const btn = _mountEl?.querySelector('#ts-login');
    const urlBox = _mountEl?.querySelector('#ts-authurl');
    const urlLink = _mountEl?.querySelector('#ts-authurl-link');
    const line = _mountEl?.querySelector('#ts-line');
    if (btn) btn.disabled = true;
    setLine(line, 'requesting login URL…', 'accent');
    try {
      const r = await fetch(apiBase() + '/api/tailscale/login', { method: 'POST', headers: authHeaders(), credentials: 'include' });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(txt); if (j.error) msg = j.error; } catch {}
        setLine(line, 'login failed: ' + msg, 'err');
        alert('Tailscale login failed: ' + msg);
        return;
      }
      const d = await r.json();
      if (d.status === 'already-connected') { refreshStatus(); return; }
      if (d.authUrl && urlBox && urlLink) {
        urlBox.hidden = false;
        urlLink.href = d.authUrl;
        urlLink.textContent = d.authUrl;
        setLine(line, 'open the link above to complete SSO', 'accent');
      }
      // Poll status until Running.
      if (_pollTimer) clearInterval(_pollTimer);
      _pollTimer = setInterval(refreshStatus, 4000);
    } catch (e) {
      setLine(line, 'login error: ' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function triggerLogout() {
    if (!confirm('Disconnect this container from the tailnet?')) return;
    try {
      const r = await fetch(apiBase() + '/api/tailscale/logout', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!d.ok) alert('Logout failed: ' + (d.stderr || ''));
      refreshStatus();
    } catch (e) { alert('Logout error: ' + e.message); }
  }

  async function loadHostname() {
    const input = _mountEl?.querySelector('#ts-hostname');
    if (!input) return;
    try {
      const r = await fetch(apiBase() + '/api/tailscale/settings', { headers: authHeaders() });
      if (r.ok) {
        const d = await r.json();
        input.value = d.hostname || '';
      }
    } catch {}
  }

  async function saveHostname() {
    const input = _mountEl?.querySelector('#ts-hostname');
    const btn = _mountEl?.querySelector('#ts-hostname-save');
    if (!input) return;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(apiBase() + '/api/tailscale/settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: input.value || '' }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        alert('Save failed: ' + txt);
        return;
      }
      if (btn) btn.textContent = 'saved ✓';
      setTimeout(() => { if (btn) btn.textContent = 'Save hostname'; }, 1500);
    } catch (e) {
      alert('Save error: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function mount(paneEl) {
    _mountEl = paneEl;
    paneEl.innerHTML = HTML;
    paneEl.querySelector('#ts-login')?.addEventListener('click', triggerLogin);
    paneEl.querySelector('#ts-logout')?.addEventListener('click', triggerLogout);
    paneEl.querySelector('#ts-hostname-save')?.addEventListener('click', saveHostname);
    refreshStatus();
    loadHostname();
  }

  document.addEventListener('spore-plugin-panes-rendered', () => {
    const el = document.querySelector(`[data-plugin-pane="${PLUGIN_ID}"] [data-plugin-mount="${PLUGIN_ID}"]`);
    if (el) mount(el);
  });

  // Cleanup the poll timer on settings panel close — best-effort,
  // catches the common case via overlay class change.
  const overlay = document.querySelector('.settings-pane-open, [data-settings-pane]');
  if (overlay) {
    new MutationObserver(() => {
      if (!document.querySelector('.settings-pane-open')) {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      }
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
})();
