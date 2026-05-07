// Compute-cluster plugin settings UI — loaded by graph-viewer.html
// when the plugin is installed. Populates the plugin's settings pane
// in the Plugins tab with cluster username/host/tmux fields, the
// Test SSH button, the additional clusters list, and the sidecar-backed
// SSH credential block.
//
// All endpoints are under /api/cluster/* (path alias to
// /api/plugins/compute-cluster/*).

(function () {
  'use strict';
  if (window.__ComputeClusterSettings) return;
  window.__ComputeClusterSettings = true;

  const PLUGIN_ID = 'compute-cluster';
  const apiBase = () => (window.location.pathname.replace(/\/graph\/?$/, '') || '');
  const authHeaders = () => (typeof window.authHeaders === 'function' ? window.authHeaders() : {});

  let _mountEl = null;

  const HTML = `
    <div class="settings-note settings-muted">SLURM cluster access over Tailscale. SSH credentials are stored by the SSH Sidecar, so there is no manual keystore unlock and private keys are not readable back through the app.</div>
    <div class="settings-field-grid compact settings-subsection">
      <label>Cluster SSH username
        <input id="cl-username" type="text" autocomplete="off">
      </label>
      <label>Login host (MagicDNS)
        <input id="cl-loginhost" type="text" autocomplete="off" placeholder="login.tailnet.ts.net">
      </label>
      <label class="settings-field-wide">tmux session prefix
        <input id="cl-tmux" type="text" autocomplete="off" placeholder="spore">
      </label>
    </div>
    <div class="settings-plugin-actions">
      <button class="settings-btn-secondary settings-compact-btn" id="cl-save" type="button">Save settings</button>
      <button class="settings-btn-secondary settings-compact-btn" id="cl-test" type="button">Test SSH</button>
    </div>
    <div id="cl-test-result" class="settings-status-muted settings-status-prewrap"></div>

    <div class="settings-subsection">
      <div class="settings-row spaced">
        <div class="settings-subtitle">Additional clusters</div>
        <button class="settings-btn-secondary settings-compact-btn" id="cl-hosts-add" type="button">+ Add cluster</button>
      </div>
      <div class="settings-note settings-muted-soft">Extra SLURM clusters reachable over the same tailnet. Username falls back to the primary cluster's if left blank.</div>
      <div id="cl-hosts-list" class="settings-stack-tight settings-plugin-list"></div>
      <div class="settings-plugin-actions"><button class="settings-btn-secondary settings-compact-btn" id="cl-hosts-save" type="button">Save additional clusters</button></div>
      <div id="cl-hosts-status" class="settings-status-muted"></div>
    </div>

    <div class="settings-subsection">
      <div class="settings-subtitle">Cluster SSH credential</div>
      <div class="settings-note settings-muted-soft">Stored as sidecar credential profile <code>cluster-default</code>. Generated keys are created inside the sidecar; the app only receives public key + fingerprint.</div>
      <div id="cl-key-status" class="settings-status-muted">loading…</div>
      <div id="cl-pubkey-wrap" class="settings-subsection" hidden>
        <div class="settings-note settings-muted">Public key (install on the cluster: <code>~/.ssh/authorized_keys</code>):</div>
        <textarea id="cl-pubkey" class="settings-code-textarea" readonly rows="2"></textarea>
        <button class="settings-btn-secondary settings-compact-btn" id="cl-copypub" type="button">Copy public key</button>
      </div>
      <div class="settings-plugin-actions">
        <button class="settings-btn-secondary settings-compact-btn" id="cl-gen-key" type="button">Generate sidecar key</button>
        <button class="settings-btn-secondary settings-compact-btn" id="cl-paste-key" type="button">Import private key…</button>
        <button class="settings-btn-secondary settings-compact-btn settings-danger-title" id="cl-del-key" type="button" hidden>Remove credential</button>
      </div>
    </div>
  `;

  function setStatus(el, text, kind = '') {
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }

  // ── Settings load/save ───────────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch(apiBase() + '/api/cluster/settings', { headers: authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      _mountEl.querySelector('#cl-username').value  = d.clusterUsername  || '';
      _mountEl.querySelector('#cl-loginhost').value = d.clusterLoginHost || '';
      _mountEl.querySelector('#cl-tmux').value      = d.clusterTmuxPrefix || 'spore';
      renderHosts(d.clusterHosts || []);
    } catch {}
  }
  async function saveSettings() {
    const btn = _mountEl.querySelector('#cl-save');
    btn.disabled = true;
    try {
      const body = {
        clusterUsername:   _mountEl.querySelector('#cl-username').value || '',
        clusterLoginHost:  _mountEl.querySelector('#cl-loginhost').value || '',
        clusterTmuxPrefix: _mountEl.querySelector('#cl-tmux').value || '',
      };
      const r = await fetch(apiBase() + '/api/cluster/settings', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) { alert('Save failed: ' + (d.error || 'unknown')); return; }
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save settings'; }, 1500);
    } catch (e) { alert('Save error: ' + e.message); }
    finally { btn.disabled = false; }
  }

  // ── Test SSH ─────────────────────────────────────────────────────
  async function testSsh() {
    const out = _mountEl.querySelector('#cl-test-result');
    setStatus(out, 'testing…');
    try {
      const r = await fetch(apiBase() + '/api/cluster/test-ssh', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (d.ok) {
        setStatus(out, '✓ ' + (d.output || 'connected'), 'ok');
      } else {
        setStatus(out, '✗ ' + (d.hint || d.stderr || d.error || 'failed'), 'err');
      }
    } catch (e) { setStatus(out, 'error: ' + e.message, 'err'); }
  }

  // ── Additional clusters list ─────────────────────────────────────
  let _hosts = [];
  function renderHosts(hosts) {
    _hosts = Array.isArray(hosts) ? hosts.map(h => ({ ...h })) : [];
    const list = _mountEl.querySelector('#cl-hosts-list');
    if (!_hosts.length) { list.innerHTML = '<div class="settings-note settings-muted-soft">none added yet</div>'; return; }
    list.innerHTML = _hosts.map((h, i) => `
      <div class="settings-plugin-host-row">
        <input data-idx="${i}" data-field="name" value="${(h.name||'').replace(/"/g,'&quot;')}" placeholder="name">
        <input data-idx="${i}" data-field="host" value="${(h.host||'').replace(/"/g,'&quot;')}" placeholder="host">
        <input data-idx="${i}" data-field="username" value="${(h.username||'').replace(/"/g,'&quot;')}" placeholder="username">
        <button class="settings-btn-secondary settings-compact-btn settings-danger-title" data-remove="${i}" type="button">×</button>
      </div>
    `).join('');
    list.querySelectorAll('input').forEach(el => el.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      const f = e.target.dataset.field;
      if (_hosts[i]) _hosts[i][f] = e.target.value;
    }));
    list.querySelectorAll('button[data-remove]').forEach(b => b.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.remove, 10);
      _hosts.splice(i, 1);
      renderHosts(_hosts);
    }));
  }
  async function saveHosts() {
    const status = _mountEl.querySelector('#cl-hosts-status');
    setStatus(status, 'saving…');
    try {
      const r = await fetch(apiBase() + '/api/cluster/hosts', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ hosts: _hosts }) });
      const d = await r.json();
      if (!d.ok) { setStatus(status, 'save failed: ' + (d.error || ''), 'err'); return; }
      setStatus(status, 'saved');
      renderHosts(d.hosts || []);
    } catch (e) { setStatus(status, 'error: ' + e.message, 'err'); }
  }

  // ── SSH key block ────────────────────────────────────────────────
  async function loadKey() {
    const status = _mountEl.querySelector('#cl-key-status');
    const pubWrap = _mountEl.querySelector('#cl-pubkey-wrap');
    const pub = _mountEl.querySelector('#cl-pubkey');
    const delBtn = _mountEl.querySelector('#cl-del-key');
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key', { headers: authHeaders() });
      const d = await r.json();
      if (d.error && !d.sidecarReady) {
        setStatus(status, d.error, 'err');
        pubWrap.hidden = true;
        delBtn.hidden = true;
      } else if (d.hasPrivate && d.publicKey) {
        setStatus(status, 'key installed · ' + (d.fingerprint || ''), 'ok');
        pubWrap.hidden = false;
        pub.value = d.publicKey;
        delBtn.hidden = false;
      } else {
        setStatus(status, 'no key installed');
        pubWrap.hidden = true;
        delBtn.hidden = true;
      }
    } catch {}
  }
  async function generateKey() {
    if (!confirm('Generate a fresh ed25519 cluster key inside the SSH sidecar? This replaces the existing cluster credential profile.')) return;
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key/generate', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!d.ok) { alert('Generate failed: ' + (d.error || '')); return; }
      loadKey();
    } catch (e) { alert('Generate error: ' + e.message); }
  }
  async function pasteKey() {
    const k = prompt('Paste private key to import into the SSH sidecar (BEGIN/END markers required). Generated keys are safer because the private key never enters the app process.');
    if (!k) return;
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ privateKey: k }) });
      const d = await r.json();
      if (!d.ok) { alert('Paste failed: ' + (d.error || '')); return; }
      loadKey();
    } catch (e) { alert('Paste error: ' + e.message); }
  }
  async function deleteKey() {
    if (!confirm('Remove the cluster SSH credential from the sidecar?')) return;
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key', { method: 'DELETE', headers: authHeaders() });
      const d = await r.json();
      if (!d.ok) { alert('Delete failed: ' + (d.error || '')); return; }
      loadKey();
    } catch (e) { alert('Delete error: ' + e.message); }
  }
  async function copyPub() {
    const t = _mountEl.querySelector('#cl-pubkey').value;
    try { await navigator.clipboard.writeText(t); } catch {}
    const b = _mountEl.querySelector('#cl-copypub');
    if (b) { b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy public key'; }, 1200); }
  }

  function mount(paneEl) {
    _mountEl = paneEl;
    paneEl.innerHTML = HTML;
    paneEl.querySelector('#cl-save')?.addEventListener('click', saveSettings);
    paneEl.querySelector('#cl-test')?.addEventListener('click', testSsh);
    paneEl.querySelector('#cl-hosts-add')?.addEventListener('click', () => { _hosts.push({ name: '', host: '', username: '' }); renderHosts(_hosts); });
    paneEl.querySelector('#cl-hosts-save')?.addEventListener('click', saveHosts);
    paneEl.querySelector('#cl-gen-key')?.addEventListener('click', generateKey);
    paneEl.querySelector('#cl-paste-key')?.addEventListener('click', pasteKey);
    paneEl.querySelector('#cl-del-key')?.addEventListener('click', deleteKey);
    paneEl.querySelector('#cl-copypub')?.addEventListener('click', copyPub);
    loadSettings();
    loadKey();
  }

  document.addEventListener('spore-plugin-panes-rendered', () => {
    const el = document.querySelector(`[data-plugin-pane="${PLUGIN_ID}"] [data-plugin-mount="${PLUGIN_ID}"]`);
    if (el) mount(el);
  });
})();
