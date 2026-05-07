// SSH sidecar settings UI - loaded only when the ssh-sidecar plugin is installed.

(function () {
  'use strict';
  if (window.__SporeSshSidecarSettings) return;
  window.__SporeSshSidecarSettings = true;

  const PLUGIN_ID = 'ssh-sidecar';
  const apiBase = () => (window.location.pathname.replace(/\/graph\/?$/, '') || '');
  const authHeaders = () => (typeof window.authHeaders === 'function' ? window.authHeaders() : {});
  const jsonHeaders = () => ({ ...authHeaders(), 'Content-Type': 'application/json' });

  let _mountEl = null;
  let _status = null;
  let _hosts = [];
  let _editingHost = null;
  let _notice = null;

  function statusText(d) {
    if (d?.autoStartError) return { kind: 'err', text: `sidecar auto-start failed: ${d.autoStartError}` };
    if (!d?.socketPresent) return { kind: 'err', text: 'sidecar service not running; local encrypted fallback is active' };
    if (!d.socketIsSocket) return { kind: 'err', text: 'socket path exists but is not a Unix socket' };
    if (d.sidecar?.ok === false) return { kind: 'err', text: `socket found; status RPC failed: ${d.sidecar.error || 'unknown error'}` };
    return { kind: 'ok', text: d.mode === 'managed-process'
      ? 'connected; managed sidecar process active'
      : 'connected; SSH keys stay outside the main app process' };
  }

  function hostAuth(h) {
    if (h.credentialId) return `profile:${h.credentialId}`;
    if (h.hasKey && h.hasPassword) return 'key + password';
    if (h.hasKey) return 'key';
    if (h.hasPassword) return 'password';
    return 'no auth';
  }

  function hostRows() {
    if (!_hosts.length) {
      return '<div class="settings-scroll-empty">No SSH hosts saved yet.</div>';
    }
    return _hosts.map(h => {
      const selected = _editingHost?.id === h.id ? ' is-active' : '';
      const source = h.metadata?.source ? ` / ${h.metadata.source}` : '';
      return `
        <div class="ssh-sidecar-host-row${selected}" data-host-id="${escapeAttr(h.id)}">
          <div class="ssh-sidecar-host-main">
            <div class="ssh-sidecar-host-name">${escapeHtml(h.name || h.id)}</div>
            <div class="ssh-sidecar-host-meta">${escapeHtml(h.username || '')}@${escapeHtml(h.hostname || '')}:${escapeHtml(h.port || 22)}${escapeHtml(source)}</div>
            <div class="ssh-sidecar-host-auth">${escapeHtml(hostAuth(h))}</div>
          </div>
          <div class="ssh-sidecar-host-actions">
            <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-edit="${escapeAttr(h.id)}">Edit</button>
            <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-test="${escapeAttr(h.id)}">Test</button>
            <button class="settings-btn-secondary settings-compact-btn settings-danger-title" type="button" data-ssh-delete="${escapeAttr(h.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function render(el, error = null) {
    if (!_mountEl) _mountEl = el;
    if (error) {
      el.innerHTML = `<div class="settings-status-muted" data-kind="err">status unavailable: ${escapeHtml(error)}</div>`;
      return;
    }

    const data = _status || {};
    const status = statusText(data);
    const manager = data.manager || {};
    const runtimeMode = manager.localMode
      ? 'local fallback'
      : (manager.sidecarReady ? 'sidecar RPC' : 'not initialized yet');
    const serviceMode = data.mode === 'managed-process'
      ? 'managed process'
      : (data.mode === 'external-socket' ? 'external service' : 'unknown');
    const hostCount = data.sidecar?.hostCount ?? manager.hostCount ?? _hosts.length;
    const credentialCount = data.sidecar?.credentialCount ?? 'unknown';
    const sessionCount = data.sidecar?.sessionCount ?? manager.activeSessionCount ?? 0;
    const allowlist = Array.isArray(data.sidecar?.allowedHosts) ? data.sidecar.allowedHosts.join(', ') : '*';
    const h = _editingHost || {};
    const formTitle = _editingHost ? 'Edit saved host' : 'Add saved host';
    const keyHint = _editingHost
      ? 'Leave private key and password blank to keep the stored credential unchanged.'
      : 'Paste a private key here to encrypt it inside the sidecar immediately on save.';

    el.innerHTML = `
      <div class="settings-plugin-card">
        <div class="settings-plugin-card-row">
          <span class="settings-status-muted" data-kind="${status.kind}">${escapeHtml(status.text)}</span>
          <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-sidecar-refresh>Refresh</button>
        </div>
        <div class="settings-note settings-muted-soft">Core uses this plugin as the sidecar boundary for saved-host CRUD, interactive SSH, remote exec, and SFTP. Private keys entered below are sent once to the server and encrypted by the sidecar; they are never shown back in this UI.</div>
      </div>

      <div class="settings-plugin-card">
        <div class="settings-plugin-accent-title">Saved SSH hosts</div>
        <div class="ssh-sidecar-host-list">${hostRows()}</div>
      </div>

      <div class="settings-plugin-card">
        <div class="settings-plugin-accent-title">${escapeHtml(formTitle)}</div>
        <div class="settings-field-grid">
          <label>Name
            <input id="ssh-sidecar-name" type="text" autocomplete="off" value="${escapeAttr(h.name || '')}" placeholder="Workstation">
          </label>
          <label>Hostname
            <input id="ssh-sidecar-hostname" type="text" autocomplete="off" value="${escapeAttr(h.hostname || '')}" placeholder="host.tailnet.ts.net">
          </label>
          <label>Port
            <input id="ssh-sidecar-port" type="number" min="1" max="65535" value="${escapeAttr(h.port || 22)}">
          </label>
          <label>Username
            <input id="ssh-sidecar-username" type="text" autocomplete="off" value="${escapeAttr(h.username || '')}" placeholder="ssh-user">
          </label>
          <label class="settings-field-wide">Private key
            <textarea id="ssh-sidecar-private-key" class="settings-code-textarea" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
            <div class="settings-note settings-muted-soft">${escapeHtml(keyHint)}</div>
          </label>
          <label class="settings-field-wide">Password or key passphrase (optional)
            <input id="ssh-sidecar-password" type="password" autocomplete="new-password" value="">
          </label>
        </div>
        <div class="settings-plugin-actions">
          <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-save-host>Save host</button>
          <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-test-current${_editingHost ? '' : ' disabled'}>Test saved host</button>
          <button class="settings-btn-secondary settings-compact-btn" type="button" data-ssh-clear-form>Clear</button>
        </div>
        <div class="settings-status-muted ssh-sidecar-form-status" data-kind="${escapeAttr(_notice?.kind || '')}">${escapeHtml(_notice?.text || '')}</div>
      </div>

      <div class="settings-plugin-card">
        <div class="settings-plugin-accent-title">Runtime</div>
        <div class="settings-note">Mode: <code>${escapeHtml(runtimeMode)}</code></div>
        <div class="settings-note">Service: <code>${escapeHtml(serviceMode)}</code></div>
        <div class="settings-note">Socket: <code>${escapeHtml(data.socketPath || '')}</code></div>
        <div class="settings-note">Stored hosts: <code>${escapeHtml(String(hostCount))}</code> · credential profiles: <code>${escapeHtml(String(credentialCount))}</code> · active sessions: <code>${escapeHtml(String(sessionCount))}</code></div>
        <div class="settings-note">Allowed SSH hosts: <code>${escapeHtml(allowlist)}</code></div>
      </div>

      <div class="settings-plugin-card">
        <div class="settings-plugin-accent-title">Deployment</div>
        <div class="settings-note settings-muted-soft">The plugin auto-starts a managed sidecar process when no external sidecar socket is present. For stronger container-level isolation, build the plugin-owned image and start the compose profile; the compose template shares the app network namespace so Tailscale's local userspace proxy remains available to sidecar SSH sessions.</div>
        <pre class="settings-plugin-code">docker build -t spore-ssh-sidecar:latest plugins/ssh-sidecar/sidecar
SPORE_SSH_SIDECAR_PASSPHRASE='use-a-long-random-secret' docker compose --profile ssh-sidecar up -d ssh-sidecar</pre>
      </div>
    `;
    bind(el);
  }

  function bind(el) {
    el.querySelector('[data-ssh-sidecar-refresh]')?.addEventListener('click', () => load(el));
    el.querySelector('[data-ssh-save-host]')?.addEventListener('click', saveHost);
    el.querySelector('[data-ssh-clear-form]')?.addEventListener('click', () => {
      _editingHost = null;
      _notice = null;
      render(el);
    });
    el.querySelector('[data-ssh-test-current]')?.addEventListener('click', () => {
      if (_editingHost?.id) testHost(_editingHost.id);
    });
    el.querySelectorAll('[data-ssh-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        _editingHost = _hosts.find(h => h.id === btn.dataset.sshEdit) || null;
        _notice = null;
        render(el);
      });
    });
    el.querySelectorAll('[data-ssh-test]').forEach(btn => {
      btn.addEventListener('click', () => testHost(btn.dataset.sshTest));
    });
    el.querySelectorAll('[data-ssh-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteHost(btn.dataset.sshDelete));
    });
  }

  function formStatus(text, kind = '') {
    _notice = { text, kind };
    const el = _mountEl?.querySelector('.ssh-sidecar-form-status');
    if (el) {
      el.textContent = text || '';
      el.dataset.kind = kind;
    }
  }

  function collectForm() {
    const hostname = _mountEl?.querySelector('#ssh-sidecar-hostname')?.value.trim() || '';
    const username = _mountEl?.querySelector('#ssh-sidecar-username')?.value.trim() || '';
    const name = _mountEl?.querySelector('#ssh-sidecar-name')?.value.trim() || hostname;
    const port = Number(_mountEl?.querySelector('#ssh-sidecar-port')?.value || 22) || 22;
    const privateKey = _mountEl?.querySelector('#ssh-sidecar-private-key')?.value.trim() || '';
    const password = _mountEl?.querySelector('#ssh-sidecar-password')?.value || '';
    return {
      id: _editingHost?.id || undefined,
      name,
      hostname,
      port,
      username,
      privateKey: privateKey || undefined,
      password: password || undefined,
    };
  }

  async function load(el) {
    _mountEl = el;
    el.innerHTML = '<div class="settings-status-muted">loading sidecar status...</div>';
    try {
      const [statusRes, hostsRes] = await Promise.all([
        fetch(apiBase() + '/api/plugins/ssh-sidecar/status', { headers: authHeaders(), credentials: 'include' }),
        fetch(apiBase() + '/api/plugins/ssh-sidecar/hosts', { headers: authHeaders(), credentials: 'include' }),
      ]);
      if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`);
      _status = await statusRes.json();
      if (hostsRes.ok) {
        const hostData = await hostsRes.json();
        _hosts = Array.isArray(hostData.hosts) ? hostData.hosts : [];
      } else {
        _hosts = [];
        _notice = { kind: 'err', text: `Unable to load hosts: HTTP ${hostsRes.status}` };
      }
      if (_editingHost) _editingHost = _hosts.find(h => h.id === _editingHost.id) || null;
      render(el);
    } catch (e) {
      render(el, e.message);
    }
  }

  async function saveHost() {
    const payload = collectForm();
    if (!payload.hostname || !payload.username) {
      formStatus('Hostname and username are required.', 'err');
      return;
    }
    formStatus('Saving and encrypting credential...', 'accent');
    try {
      const r = await fetch(apiBase() + '/api/plugins/ssh-sidecar/hosts', {
        method: 'POST',
        headers: jsonHeaders(),
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      formStatus(`Saved ${d.name || payload.name}.`, 'ok');
      _editingHost = { id: d.id, name: d.name || payload.name };
      await load(_mountEl);
      formStatus(`Saved ${d.name || payload.name}.`, 'ok');
    } catch (e) {
      formStatus(`Save failed: ${e.message}`, 'err');
    }
  }

  async function testHost(id) {
    if (!id) return;
    formStatus('Testing SSH connection...', 'accent');
    try {
      const r = await fetch(apiBase() + '/api/plugins/ssh-sidecar/hosts/test', {
        method: 'POST',
        headers: jsonHeaders(),
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false || d.success === false) throw new Error(d.error || `HTTP ${r.status}`);
      formStatus(d.message || 'Connection successful.', 'ok');
    } catch (e) {
      formStatus(`Test failed: ${e.message}`, 'err');
    }
  }

  async function deleteHost(id) {
    const host = _hosts.find(h => h.id === id);
    const label = host?.name || id;
    if (!confirm(`Delete SSH host "${label}"?`)) return;
    formStatus('Deleting host...', 'accent');
    try {
      const r = await fetch(apiBase() + '/api/plugins/ssh-sidecar/hosts/delete', {
        method: 'POST',
        headers: jsonHeaders(),
        credentials: 'include',
        body: JSON.stringify({ id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      if (_editingHost?.id === id) _editingHost = null;
      await load(_mountEl);
      formStatus(`Deleted ${label}.`, 'ok');
    } catch (e) {
      formStatus(`Delete failed: ${e.message}`, 'err');
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  document.addEventListener('spore-plugin-panes-rendered', () => {
    const el = document.querySelector(`[data-plugin-pane="${PLUGIN_ID}"] [data-plugin-mount="${PLUGIN_ID}"]`);
    if (el) load(el);
  });
})();
