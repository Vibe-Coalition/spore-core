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
    <div class="settings-note" style="margin-top:4px">Mesh-VPN access via tailscaled. Log in once via SSO; state persists at <code>/data/tailscale</code> across container restarts.</div>
    <div id="ts-status" style="margin-top:8px;padding:8px 10px;background:var(--bg-2,var(--surface));border:1px solid var(--border);border-radius:4px;font-size:.72rem;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span id="ts-line">loading…</span>
      <span style="display:flex;gap:4px">
        <button class="settings-btn-secondary" id="ts-login"  type="button" style="font-size:.66rem;padding:3px 8px">Log in to Tailscale</button>
        <button class="settings-btn-secondary" id="ts-logout" type="button" style="font-size:.66rem;padding:3px 8px;display:none">Logout</button>
      </span>
    </div>
    <div id="ts-authurl" style="display:none;margin-top:8px;padding:10px;background:var(--bg-2,var(--surface));border:1px dashed var(--accent2,var(--accent));border-radius:4px;font-size:.7rem">
      <div style="margin-bottom:6px;font-weight:600;color:var(--accent2,var(--accent))">Open this URL in your browser and complete SSO:</div>
      <a id="ts-authurl-link" href="#" target="_blank" rel="noopener noreferrer" style="word-break:break-all;color:var(--accent);text-decoration:underline"></a>
      <div style="margin-top:6px;color:var(--text-dim)">Polling status until connected…</div>
    </div>
    <label style="display:block;font-size:.7rem;margin-top:14px">Hostname for this container on the tailnet
      <input id="ts-hostname" type="text" autocomplete="off" placeholder="spore-<agent>" style="display:block;margin-top:3px;width:100%;max-width:520px;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);padding:4px 6px;font-size:.72rem;border-radius:4px">
      <div class="settings-note" style="margin-top:3px">Sent as <code>tailscale up --hostname &lt;value&gt;</code>. Defaults to <code>spore-&lt;agentId&gt;</code>. Saved separately from the central Save button — use <button class="settings-btn-secondary" type="button" id="ts-hostname-save" style="font-size:.62rem;padding:1px 6px">save</button> to apply.</div>
    </label>
  `;

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
        line.textContent = `connected · ${ip} · ${online}/${total} peers online`;
        line.style.color = 'var(--text)';
        loginBtn.style.display = 'none';
        logoutBtn.style.display = '';
        urlBox.style.display = 'none';
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      } else if (state === 'NeedsLogin' || state === 'Starting') {
        line.textContent = state === 'Starting' ? 'daemon starting…' : 'not logged in';
        line.style.color = 'var(--text-dim)';
        loginBtn.style.display = '';
        logoutBtn.style.display = 'none';
        if (d.authUrl) {
          urlBox.style.display = '';
          urlLink.href = d.authUrl;
          urlLink.textContent = d.authUrl;
        } else {
          urlBox.style.display = 'none';
        }
      } else {
        line.textContent = d.error ? `tailscaled not running · ${String(d.error).slice(0, 80)}` : `state: ${state}`;
        line.style.color = 'var(--danger)';
        loginBtn.style.display = '';
        logoutBtn.style.display = 'none';
        urlBox.style.display = 'none';
      }
    } catch (e) {
      line.textContent = 'status unavailable: ' + e.message;
      line.style.color = 'var(--danger)';
    }
  }

  async function triggerLogin() {
    const btn = _mountEl?.querySelector('#ts-login');
    const urlBox = _mountEl?.querySelector('#ts-authurl');
    const urlLink = _mountEl?.querySelector('#ts-authurl-link');
    const line = _mountEl?.querySelector('#ts-line');
    if (btn) btn.disabled = true;
    if (line) { line.textContent = 'requesting login URL…'; line.style.color = 'var(--accent2,var(--accent))'; }
    try {
      const r = await fetch(apiBase() + '/api/tailscale/login', { method: 'POST', headers: authHeaders(), credentials: 'include' });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(txt); if (j.error) msg = j.error; } catch {}
        if (line) { line.textContent = 'login failed: ' + msg; line.style.color = 'var(--danger)'; }
        alert('Tailscale login failed: ' + msg);
        return;
      }
      const d = await r.json();
      if (d.status === 'already-connected') { refreshStatus(); return; }
      if (d.authUrl && urlBox && urlLink) {
        urlBox.style.display = '';
        urlLink.href = d.authUrl;
        urlLink.textContent = d.authUrl;
        if (line) { line.textContent = 'open the link above to complete SSO'; line.style.color = 'var(--accent2,var(--accent))'; }
      }
      // Poll status until Running.
      if (_pollTimer) clearInterval(_pollTimer);
      _pollTimer = setInterval(refreshStatus, 4000);
    } catch (e) {
      if (line) { line.textContent = 'login error: ' + e.message; line.style.color = 'var(--danger)'; }
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
      setTimeout(() => { if (btn) btn.textContent = 'save'; }, 1500);
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
