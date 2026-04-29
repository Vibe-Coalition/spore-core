// Compute-cluster plugin settings UI — loaded by graph-viewer.html
// when the plugin is installed. Populates the plugin's settings pane
// in the Plugins tab with cluster username/host/tmux fields, the
// Test SSH button, the additional clusters list, and the SSH key
// management block.
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
    <div class="settings-note" style="margin-top:4px">SLURM cluster access over SSH (typically over a tailnet). Reachability further depends on the Tailscale plugin being installed and connected.</div>
    <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:520px">
      <label style="font-size:.7rem">Cluster SSH username
        <input id="cl-username" type="text" autocomplete="off" style="display:block;margin-top:3px;width:100%;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);padding:4px 6px;font-size:.72rem;border-radius:4px">
      </label>
      <label style="font-size:.7rem">Login host (MagicDNS)
        <input id="cl-loginhost" type="text" autocomplete="off" placeholder="login.tailnet.ts.net" style="display:block;margin-top:3px;width:100%;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);padding:4px 6px;font-size:.72rem;border-radius:4px">
      </label>
      <label style="font-size:.7rem;grid-column:1/-1">tmux session prefix
        <input id="cl-tmux" type="text" autocomplete="off" placeholder="spore" style="display:block;margin-top:3px;width:100%;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);padding:4px 6px;font-size:.72rem;border-radius:4px">
      </label>
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="settings-btn-secondary" id="cl-save"  type="button" style="font-size:.66rem;padding:3px 8px">Save settings</button>
      <button class="settings-btn-secondary" id="cl-test"  type="button" style="font-size:.68rem;padding:3px 8px">Test SSH</button>
    </div>
    <div id="cl-test-result" style="margin-top:6px;font-family:var(--font-body);font-size:.64rem;color:var(--text-dim);white-space:pre-wrap"></div>

    <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border)">
      <div style="font-size:.72rem;font-weight:600;display:flex;justify-content:space-between;align-items:center">
        <span>Additional clusters</span>
        <button class="settings-btn-secondary" id="cl-hosts-add" type="button" style="font-size:.62rem;padding:2px 6px">+ Add cluster</button>
      </div>
      <div class="settings-note" style="margin-top:2px">Extra SLURM clusters reachable over the same tailnet. Username falls back to the primary cluster's if left blank.</div>
      <div id="cl-hosts-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px"></div>
      <div style="margin-top:6px;display:flex;gap:6px"><button class="settings-btn-secondary" id="cl-hosts-save" type="button" style="font-size:.62rem;padding:2px 6px">Save additional clusters</button></div>
      <div id="cl-hosts-status" style="margin-top:4px;font-family:var(--font-body);font-size:.62rem;color:var(--text-dim)"></div>
    </div>

    <div style="margin-top:16px;padding-top:10px;border-top:1px dashed var(--border)">
      <div style="font-size:.72rem;font-weight:600">Cluster SSH key</div>
      <div class="settings-note" style="margin-top:2px">Stored at <code>/data/.ssh/id_cluster</code> (0600, owned by spore). Used by Test SSH and by the agent's cluster tools.</div>
      <div id="cl-key-status" style="margin-top:6px;font-family:var(--font-body);font-size:.64rem;color:var(--text-dim)">loading…</div>
      <div id="cl-pubkey-wrap" style="display:none;margin-top:6px">
        <div style="font-size:.66rem;color:var(--text-dim)">Public key (install on the cluster: <code>~/.ssh/authorized_keys</code>):</div>
        <textarea id="cl-pubkey" readonly rows="2" style="display:block;width:100%;margin-top:3px;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);padding:4px 6px;font-family:var(--font-mono,monospace);font-size:.62rem;border-radius:4px;resize:vertical;word-break:break-all"></textarea>
        <button class="settings-btn-secondary" id="cl-copypub" type="button" style="margin-top:4px;font-size:.62rem;padding:2px 6px">Copy public key</button>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="settings-btn-secondary" id="cl-gen-key"    type="button" style="font-size:.66rem;padding:3px 8px">Generate new ed25519 key</button>
        <button class="settings-btn-secondary" id="cl-paste-key"  type="button" style="font-size:.66rem;padding:3px 8px">Paste private key…</button>
        <button class="settings-btn-secondary" id="cl-del-key"    type="button" style="font-size:.66rem;padding:3px 8px;color:var(--danger);display:none">Remove key</button>
      </div>
    </div>
  `;

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
    out.textContent = 'testing…';
    out.style.color = 'var(--text-dim)';
    try {
      const r = await fetch(apiBase() + '/api/cluster/test-ssh', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (d.ok) {
        out.textContent = '✓ ' + (d.output || 'connected');
        out.style.color = 'var(--text)';
      } else {
        out.textContent = '✗ ' + (d.hint || d.stderr || d.error || 'failed');
        out.style.color = 'var(--danger)';
      }
    } catch (e) { out.textContent = 'error: ' + e.message; out.style.color = 'var(--danger)'; }
  }

  // ── Additional clusters list ─────────────────────────────────────
  let _hosts = [];
  function renderHosts(hosts) {
    _hosts = Array.isArray(hosts) ? hosts.map(h => ({ ...h })) : [];
    const list = _mountEl.querySelector('#cl-hosts-list');
    if (!_hosts.length) { list.innerHTML = '<div class="settings-note" style="opacity:.6;font-size:.66rem">none added yet</div>'; return; }
    list.innerHTML = _hosts.map((h, i) => `
      <div style="display:grid;grid-template-columns:1fr 1.5fr 1fr auto;gap:6px;align-items:center">
        <input data-idx="${i}" data-field="name"     value="${(h.name||'').replace(/"/g,'&quot;')}"     placeholder="name"     style="font-size:.66rem;padding:3px 6px;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);border-radius:4px">
        <input data-idx="${i}" data-field="host"     value="${(h.host||'').replace(/"/g,'&quot;')}"     placeholder="host"     style="font-size:.66rem;padding:3px 6px;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);border-radius:4px">
        <input data-idx="${i}" data-field="username" value="${(h.username||'').replace(/"/g,'&quot;')}" placeholder="username" style="font-size:.66rem;padding:3px 6px;background:var(--bg-2,var(--surface));border:1px solid var(--border);color:var(--text);border-radius:4px">
        <button class="settings-btn-secondary" data-remove="${i}" type="button" style="font-size:.6rem;padding:2px 6px;color:var(--danger)">×</button>
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
    status.textContent = 'saving…';
    try {
      const r = await fetch(apiBase() + '/api/cluster/hosts', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ hosts: _hosts }) });
      const d = await r.json();
      if (!d.ok) { status.textContent = 'save failed: ' + (d.error || ''); status.style.color = 'var(--danger)'; return; }
      status.textContent = 'saved'; status.style.color = 'var(--text-dim)';
      renderHosts(d.hosts || []);
    } catch (e) { status.textContent = 'error: ' + e.message; status.style.color = 'var(--danger)'; }
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
      if (d.hasPrivate && d.publicKey) {
        status.textContent = 'key installed · ' + (d.fingerprint || '');
        pubWrap.style.display = '';
        pub.value = d.publicKey;
        delBtn.style.display = '';
      } else {
        status.textContent = 'no key installed';
        pubWrap.style.display = 'none';
        delBtn.style.display = 'none';
      }
    } catch {}
  }
  async function generateKey() {
    if (!confirm('Generate a fresh ed25519 key? This overwrites any existing key at /data/.ssh/id_cluster.')) return;
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key/generate', { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      if (!d.ok) { alert('Generate failed: ' + (d.error || '')); return; }
      loadKey();
    } catch (e) { alert('Generate error: ' + e.message); }
  }
  async function pasteKey() {
    const k = prompt('Paste private key (BEGIN/END markers required):');
    if (!k) return;
    try {
      const r = await fetch(apiBase() + '/api/cluster/ssh-key', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ privateKey: k }) });
      const d = await r.json();
      if (!d.ok) { alert('Paste failed: ' + (d.error || '')); return; }
      loadKey();
    } catch (e) { alert('Paste error: ' + e.message); }
  }
  async function deleteKey() {
    if (!confirm('Remove the cluster SSH key?')) return;
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
