// settings.js — Plugins manager tab + general Settings tabs (modal UI).
// Extracted from src/static/scripts/app.js (was lines 757-1881 of the post-Phase-2 monolith).

// ── Plugins tab ─────────────────────────────────────────────────────
// Renders the installed-plugins manager card + schema-driven plugin
// settings panes inside the settings modal. Backed by:
//   • GET  /api/settings → plugins block
//   • POST /api/plugins/install
//   • POST /api/plugins/uninstall/<id>
//   • PUT  /api/settings → body.plugins.<id> = { ...partial }
function _populatePluginsTab(plugins) {
  const stateEl = document.getElementById('settings-plugins-state');
  const dirsEl  = document.getElementById('settings-plugins-dirs');
  const mgrEl   = document.getElementById('settings-plugins-manager');
  const panesEl = document.getElementById('settings-plugins-panes');
  const cloneRow = document.getElementById('settings-plugins-clone-row');
  if (!mgrEl || !panesEl) return;

  const enabled = !!plugins.enabled;
  const hot = !!plugins.hotReload;
  if (stateEl) {
    if (!enabled) {
      stateEl.textContent = 'Plugin system is disabled. Set SPORE_PLUGINS_ENABLED=true to enable. Plugins run unsandboxed with full process privileges.';
    } else if (!hot) {
      stateEl.textContent = 'Plugin system enabled (read-only). Set SPORE_PLUGINS_HOT_RELOAD=true to allow runtime install/uninstall and git clone.';
    } else {
      stateEl.textContent = 'Plugin system enabled with hot reload. Install/uninstall takes effect without restart; updating an existing plugin still needs a restart.';
    }
  }
  if (dirsEl) {
    const bundled = plugins.dirs?.bundled || '(unset)';
    const user = plugins.dirs?.user || '(unset — set SPORE_PLUGINS_USER_DIR to enable git clone)';
    dirsEl.innerHTML = `Discovery dirs: <code>${_escapeHtml(bundled)}</code> (bundled) · <code>${_escapeHtml(user)}</code> (user)`;
  }
  if (cloneRow) cloneRow.style.display = (enabled && hot && plugins.dirs?.user) ? 'block' : 'none';

  // Unified list: everything on disk, with install/uninstall toggle per row.
  const available = Array.isArray(plugins.available) ? plugins.available : [];
  if (available.length === 0) {
    mgrEl.innerHTML = '<div class="settings-note" style="opacity:.6">No plugins found in either discovery dir.</div>';
  } else {
    mgrEl.innerHTML = available.map(_renderPluginRow.bind(null, hot)).join('');
  }

  // Schema-driven panes — for now, only render panes that target the 'plugins' tab.
  // (Cross-tab placement — pane.tab === 'agent' filing under the Agent tab — will
  //  follow in a later pass; the API supports it but the host needs more wiring.)
  const panes = Array.isArray(plugins.panes) ? plugins.panes.filter(p => !p.tab || p.tab === 'plugins') : [];
  if (panes.length === 0) {
    panesEl.innerHTML = '<div class="settings-note" style="opacity:.6">No plugin settings to configure.</div>';
  } else {
    panesEl.innerHTML = panes.map(_renderPluginPane).join('');
  }
  // Notify plugin frontend-assets that their panes are now in the
  // DOM so they can wire up handlers, populate dynamic content, etc.
  // Each plugin asset listens via document.addEventListener; the
  // detail.panes array carries the rendered pane metadata.
  try {
    document.dispatchEvent(new CustomEvent('spore-plugin-panes-rendered', { detail: { panes } }));
  } catch {}
}

function _renderPluginRow(hotReload, p) {
  const sourceTag = `<span class="settings-note" style="opacity:.55">${_escapeHtml(p.source || 'unknown')}</span>`;
  const stateTag = p.isInstalled
    ? '<span class="settings-note" style="color:var(--accent);opacity:.85">installed</span>'
    : (p.isDisabled
      ? '<span class="settings-note" style="color:#c66;opacity:.85">uninstalled</span>'
      : '<span class="settings-note" style="opacity:.55">available</span>');

  const bits = [];
  if (p.hasReferenceNodes) bits.push('<span class="settings-note" style="opacity:.7">ref nodes</span>');
  if (p.toolCount) bits.push(`<span class="settings-note" style="opacity:.7">${p.toolCount} tool${p.toolCount > 1 ? 's' : ''}</span>`);
  if (p.gatewayCount) bits.push(`<span class="settings-note" style="opacity:.7">${p.gatewayCount} gateway${p.gatewayCount > 1 ? 's' : ''}</span>`);
  if ((p.depends || []).length) bits.push(`<span class="settings-note" style="opacity:.55">depends: ${p.depends.map(_escapeHtml).join(', ')}</span>`);

  let actionBtn = '';
  if (hotReload) {
    actionBtn = p.isInstalled
      ? `<button type="button" class="settings-btn-secondary" data-plugin-uninstall="${_escapeAttr(p.id)}">Uninstall</button>`
      : `<button type="button" class="settings-btn-secondary" data-plugin-install="${_escapeAttr(p.id)}">Install</button>`;
  }

  return `<div class="settings-plugin-row" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border)">
    <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
        <strong>${_escapeHtml(p.name || p.id)}</strong>
        <span class="settings-note" style="opacity:.5">${_escapeHtml(p.id)}@${_escapeHtml(p.version || '0.0.0')}</span>
        <span class="settings-note" style="opacity:.7">${_escapeHtml(p.kind)}</span>
        ${sourceTag}
        ${stateTag}
      </div>
      ${bits.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap">${bits.join('')}</div>` : ''}
    </div>
    ${actionBtn}
  </div>`;
}

function _renderPluginPane(pane) {
  const fields = (pane.schema || []).map(field => _renderPluginField(pane.pluginId, field, pane.values?.[field.key], pane.meta?.[field.key])).join('');
  const desc = pane.description ? `<div class="settings-note" style="margin-bottom:8px">${_escapeHtml(pane.description)}</div>` : '';
  const customHtml = pane.html ? `<div data-plugin-custom="${pane.pluginId}">${pane.html}</div>` : '';
  return `<div class="settings-plugin-pane" data-plugin-pane="${pane.pluginId}" style="margin-bottom:18px;padding:10px 0;border-top:1px solid var(--border)">
    <h5 style="margin:0 0 6px 0">${_escapeHtml(pane.title)}</h5>
    ${desc}
    ${fields}
    ${customHtml}
  </div>`;
}

function _renderPluginField(pluginId, field, value, meta) {
  const id = `settings-plugin-${pluginId}-${field.key}`;
  const labelEl = `<label for="${id}" style="display:block;font-size:.78rem;margin-bottom:2px">${_escapeHtml(field.label || field.key)}</label>`;
  const help = field.help ? `<div class="settings-note" style="opacity:.6;margin-top:2px">${_escapeHtml(field.help)}</div>` : '';
  // Compute the rendered value (saved slot value > schema default > '').
  // Stash it on the wrapper as `data-plugin-original` so the collector
  // can diff against it on save and only emit fields the operator
  // actually modified — without this, an unmodified Save sends every
  // schema default and clobbers env mirrors with values like
  // authHeader:'bearer' when the wizard had already persisted x-key.
  const v = (value === undefined || value === null) ? (field.default !== undefined ? field.default : '') : value;
  const originalAttr = `data-plugin-original="${_escapeAttr(String(v))}"`;
  const wrap = (inner) => `<div style="margin-bottom:10px" data-plugin-field="${pluginId}.${field.key}" data-plugin-secret="${field.secret ? '1' : '0'}" ${originalAttr}>${labelEl}${inner}${help}</div>`;
  switch (field.type) {
    case 'toggle': {
      const checked = !!v ? 'checked' : '';
      return wrap(`<input type="checkbox" id="${id}" ${checked} />`);
    }
    case 'number':
      return wrap(`<input type="number" id="${id}" value="${_escapeAttr(String(v))}" style="width:120px" />`);
    case 'select': {
      const opts = (field.options || []).map(o => `<option value="${_escapeAttr(o.value)}"${o.value === v ? ' selected' : ''}>${_escapeHtml(o.label || o.value)}</option>`).join('');
      return wrap(`<select id="${id}">${opts}</select>`);
    }
    case 'textarea':
      return wrap(`<textarea id="${id}" rows="3" style="width:100%;font-family:var(--font-body)">${_escapeHtml(String(v))}</textarea>`);
    case 'password': {
      const placeholder = meta?.isSet ? '••• stored — leave blank to keep' : '';
      return wrap(`<input type="password" id="${id}" placeholder="${placeholder}" style="width:100%;font-family:var(--font-body)" />`);
    }
    default:
      return wrap(`<input type="text" id="${id}" value="${_escapeAttr(String(v))}" style="width:100%;font-family:var(--font-body)" />`);
  }
}

function _escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

function _collectPluginSettingsPayload() {
  const out = {};
  document.querySelectorAll('#settings-plugins-panes [data-plugin-field]').forEach(wrap => {
    const [pluginId, key] = wrap.getAttribute('data-plugin-field').split('.');
    const isSecret = wrap.getAttribute('data-plugin-secret') === '1';
    const original = wrap.getAttribute('data-plugin-original');
    const input = wrap.querySelector('input, select, textarea');
    if (!input || !key) return;
    let v;
    if (input.type === 'checkbox') v = input.checked;
    else if (input.type === 'number') v = input.value === '' ? null : Number(input.value);
    else v = input.value;
    // Skip empty password fields — empty means "keep stored value"
    if (isSecret && (v === '' || v === null || v === undefined)) return;
    // Skip fields that match the rendered original (saved slot value or
    // schema default). This is the load-bearing guard: without it, every
    // Save sends every form field — including unedited schema defaults —
    // and overwrites the wizard's saved values via the plugin's
    // onConfigChange env mirror (the famous "wizard saved x-key,
    // settings save sent bearer back" regression).
    if (original !== null && String(v) === String(original)) return;
    if (!out[pluginId]) out[pluginId] = {};
    out[pluginId][key] = v;
  });
  return out;
}

async function _refreshSettingsFromServer() {
  try {
    const r = await fetch(API + '/api/settings', { headers: { ...authHeaders() } });
    if (r.ok) populateSettingsPanel(await r.json());
  } catch { /* silent: best-effort refresh */ }
  // Plugin install/uninstall flips section visibility — invalidate cache
  // and re-run the gate so newly-installed plugins' UI cards appear.
  _pluginInstalledIdsCache = null;
  if (typeof _hidePluginUiIfMissing === 'function') _hidePluginUiIfMissing();
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;

  // Per-row Uninstall
  const uninstallId = t.getAttribute?.('data-plugin-uninstall');
  if (uninstallId) {
    if (!confirm(`Uninstall plugin "${uninstallId}"? Its tools will disappear, its reference content will be removed from the graph, and its gateways will shut down.`)) return;
    setSettingsBusy(true, 'Uninstalling…');
    try {
      const r = await fetch(API + '/api/plugins/uninstall/' + encodeURIComponent(uninstallId), {
        method: 'POST', headers: { ...authHeaders() },
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || 'Uninstall failed');
      toast(`Uninstalled ${uninstallId}`);
      await _refreshSettingsFromServer();
    } catch (err) {
      toast(err?.message || 'Uninstall failed', true);
    } finally {
      setSettingsBusy(false);
    }
    return;
  }

  // Per-row Install (resolves id against discovery dirs)
  const installId = t.getAttribute?.('data-plugin-install');
  if (installId) {
    setSettingsBusy(true, 'Installing…');
    try {
      const r = await fetch(API + '/api/plugins/install', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: installId }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || 'Install failed');
      toast(`Installed ${data.manifest?.id || installId}`);
      await _refreshSettingsFromServer();
    } catch (err) {
      toast(err?.message || 'Install failed', true);
    } finally {
      setSettingsBusy(false);
    }
    return;
  }

  // Clone from git
  if (t.id === 'settings-plugins-clone-btn') {
    const repoInput = document.getElementById('settings-plugins-clone-repo');
    const nameInput = document.getElementById('settings-plugins-clone-name');
    const repo = repoInput?.value?.trim();
    if (!repo) { toast('Enter a git repository URL', true); return; }
    setSettingsBusy(true, 'Cloning…');
    try {
      const r = await fetch(API + '/api/plugins/clone', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, name: nameInput?.value?.trim() || undefined }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || 'Clone failed');
      toast(`Cloned ${data.manifest?.id || 'plugin'} — click Install to load it`);
      if (repoInput) repoInput.value = '';
      if (nameInput) nameInput.value = '';
      await _refreshSettingsFromServer();
    } catch (err) {
      toast(err?.message || 'Clone failed', true);
    } finally {
      setSettingsBusy(false);
    }
    return;
  }
});

async function _populateUsersSection() {
  const section = document.getElementById('settings-users-section');
  if (!section) return;
  if (!_isCreatorRole()) { section.style.display = 'none'; return; }
  section.style.display = '';
  const list = document.getElementById('settings-users-list');
  list.innerHTML = '<div class="settings-note" style="opacity:.6">Loading…</div>';
  try {
    const r = await fetch(API + '/api/webapp/users', { headers: authHeaders() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    const users = (d.users || []).slice().sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    if (!users.length) { list.innerHTML = '<div class="settings-note" style="opacity:.6">No users yet.</div>'; return; }
    const me = _currentUserName;
    list.innerHTML = users.map(u => {
      const isSelf = u.username === me;
      const tag = u.selfRegistered ? '<span class="su-tag">self-registered</span>' : '';
      const roleSel = isSelf
        ? `<span style="color:var(--text-dim);font-size:.74rem">${u.role}</span>`
        : `<select data-user-role="${u.username}">
             <option value="webapp"${u.role === 'webapp' ? ' selected' : ''}>webapp</option>
             <option value="creator"${u.role === 'creator' ? ' selected' : ''}>creator</option>
           </select>`;
      const blockBtn = isSelf
        ? '<span></span>'
        : `<button type="button" class="block-btn" data-user-block="${u.username}" data-blocked="${u.blocked}">${u.blocked ? 'unblock' : 'block'}</button>`;
      const delBtn = isSelf
        ? '<span></span>'
        : `<button type="button" class="danger" data-user-delete="${u.username}" title="Delete user">×</button>`;
      return `<div class="settings-user-row${u.blocked ? ' is-blocked' : ''}${isSelf ? ' is-self' : ''}" data-user="${u.username}">
        <div class="su-name">${u.username}${tag}</div>
        ${roleSel}
        ${blockBtn}
        ${delBtn}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-user-role]').forEach(sel => {
      sel.addEventListener('change', () => _settingsPatchUser(sel.dataset.userRole, { role: sel.value }));
    });
    list.querySelectorAll('[data-user-block]').forEach(btn => {
      btn.addEventListener('click', () => {
        const blocked = btn.dataset.blocked === 'true';
        _settingsPatchUser(btn.dataset.userBlock, { blocked: !blocked });
      });
    });
    list.querySelectorAll('[data-user-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const u = btn.dataset.userDelete;
        if (!confirm(`Delete user "${u}"? Their session is dropped immediately.`)) return;
        await _settingsDeleteUser(u);
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="settings-note" style="color:var(--danger)">${esc(e.message || e)}</div>`;
  }
}
async function _settingsPatchUser(username, patch) {
  const status = document.getElementById('settings-users-status');
  status.textContent = 'Saving…';
  try {
    const r = await fetch(API + '/api/webapp/users/' + encodeURIComponent(username), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(patch),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    status.textContent = '';
    await _populateUsersSection();
  } catch (e) {
    status.textContent = String(e.message || e);
    await _populateUsersSection();
  }
}
async function _settingsDeleteUser(username) {
  const status = document.getElementById('settings-users-status');
  status.textContent = 'Deleting…';
  try {
    const r = await fetch(API + '/api/webapp/users/' + encodeURIComponent(username), {
      method: 'DELETE', headers: authHeaders(),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    status.textContent = '';
    await _populateUsersSection();
  } catch (e) {
    status.textContent = String(e.message || e);
  }
}

function _isCreatorRole() {
  return _userRole === 'creator' || _userRole === 'admin';
}

function _applyRoleGatingToSettings() {
  // Webapp users get a slim settings pane: only Appearance (theme) + their
  // own Profile (display name + change password). All other sections are
  // hidden entirely.
  const personalH4 = new Set(['Appearance', 'Your Profile']);
  const isCreator = _isCreatorRole();
  document.querySelectorAll('#settings-pane .settings-section').forEach(sec => {
    const h4 = sec.querySelector('h4')?.textContent?.trim() || '';
    const isPersonal = personalH4.has(h4) || sec.id === 'settings-profile-section';
    // Always restore visibility + remove any old banner so toggling roles works.
    sec.style.display = '';
    sec.querySelector('.settings-readonly-banner')?.remove();
    sec.classList.remove('is-readonly');
    if (isCreator || isPersonal) return;
    sec.style.display = 'none';
  });
  // Also hide the top-level Knowledge Graph buttons + maintenance trigger when
  // we're a webapp user (they live outside .settings-section).
  for (const id of ['settings-maintainer-run', 'settings-graphs-list', 'settings-new-graph']) {
    const el = document.getElementById(id);
    if (el) el.closest('.settings-section') ? null : (el.style.display = isCreator ? '' : 'none');
  }
}

async function _populateProfileSection() {
  const section = document.getElementById('settings-profile-section');
  if (!section) return;
  // Show Your Profile (display name + change password) for every authenticated
  // user, creator included — creators signed up with a password too and should
  // be able to rotate it without editing webapp-users.json by hand.
  section.style.display = '';
  try {
    const r = await fetch(API + '/api/preferences', { headers: authHeaders() });
    const d = await r.json();
    const dn = document.getElementById('settings-profile-displayname');
    if (dn) dn.value = d.displayName || '';
    const note = document.getElementById('settings-profile-username-note');
    if (note) note.textContent = `Logged in as ${d.username || _currentUserName || 'unknown'}.`;
  } catch {}
  if (!section.dataset.bound) {
    section.dataset.bound = '1';
    document.getElementById('settings-profile-pw-save')?.addEventListener('click', _settingsChangePassword);
    document.getElementById('settings-profile-logout')?.addEventListener('click', _settingsLogout);
  }
}

async function _settingsLogout() {
  const out = document.getElementById('settings-profile-logout-result');
  if (out) { out.className = 'settings-test-result'; out.textContent = '…'; }
  // Try both logout endpoints — whichever cookie you had will be cleared.
  // Order doesn't matter; the other just no-ops if you don't have that cookie.
  try {
    await fetch(API + '/api/webapp/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
    await fetch(API + '/api/auth/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
    // Best-effort: clear any client-side auth hints before redirecting.
    try { localStorage.removeItem('spore-session'); } catch {}
    try { sessionStorage.clear(); } catch {}
    if (out) { out.className = 'settings-test-result ok'; out.textContent = 'signed out ✓'; }
    // Send the user back to the main app. '/' redirects to '/graph' which
    // serves the SPA; its login overlay takes over since we no longer have a
    // session cookie. (Don't land on '/login' — that's now a 302 alias.)
    const base = (window.location.pathname || '/').replace(/\/(graph|index\.html|login)?\/?$/, '');
    setTimeout(() => { window.location.href = (base || '') + '/'; }, 250);
  } catch (e) {
    if (out) { out.className = 'settings-test-result err'; out.textContent = String(e.message || e).slice(0, 100); }
  }
}

async function _settingsChangePassword() {
  const cur = document.getElementById('settings-profile-pw-current').value;
  const nw = document.getElementById('settings-profile-pw-new').value;
  const out = document.getElementById('settings-profile-pw-result');
  out.className = 'settings-test-result';
  if (nw.length < 8) { out.className = 'settings-test-result err'; out.textContent = 'min 8 chars'; return; }
  out.textContent = '…';
  try {
    const r = await fetch(API + '/api/webapp/users/me/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    out.className = 'settings-test-result ok'; out.textContent = 'changed ✓';
    document.getElementById('settings-profile-pw-current').value = '';
    document.getElementById('settings-profile-pw-new').value = '';
  } catch (e) {
    out.className = 'settings-test-result err'; out.textContent = String(e.message || e).slice(0, 100);
  }
}

async function _copyToClipboard(text) {
  // Modern API — only works on https / localhost
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  // Fallback for http contexts: temporary textarea + execCommand('copy')
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// Cache of known model context limits (auto-detected from /models endpoints
// of configured providers). Populated on settings open; consulted by the
// model-row placeholder logic so the operator sees the real number even when
// no override is saved.
const _settingsKnownLimits = {};

function _settingsRefreshTierPlaceholders(key) {
  const ctxInput = document.getElementById(`settings-model-${key}-ctx`);
  const compactInput = document.getElementById(`settings-model-${key}-compact`);
  if (!ctxInput) return;
  const limKey = ctxInput.dataset.limKey || '';
  const overrideCtx = Number(ctxInput.value);
  const detectedCtx = _settingsKnownLimits[limKey]?.contextLength;
  let effectiveCtx, ctxLabel;
  if (overrideCtx > 0) { effectiveCtx = overrideCtx; ctxLabel = ''; }
  else if (detectedCtx > 0) { effectiveCtx = detectedCtx; ctxLabel = ' (auto-detected)'; }
  else { effectiveCtx = 200000; ctxLabel = ' (default)'; }
  ctxInput.placeholder = `${effectiveCtx.toLocaleString()}${ctxLabel}`;
  if (compactInput) {
    const overrideCmp = Number(compactInput.value);
    const baseCtx = effectiveCtx;
    if (overrideCmp > 0) compactInput.placeholder = `${overrideCmp.toLocaleString()}`;
    else compactInput.placeholder = `${Math.floor(baseCtx * 0.85).toLocaleString()} (85%)`;
  }
}

// Rebuild the <datalist> of model suggestions for a tier row based on which
// provider is currently selected for that tier. Called on provider-change and
// whenever _settingsKnownLimits is updated by a "test connection" probe.
function _settingsRefreshTierModelList(key) {
  const dl = document.getElementById(`settings-model-${key}-datalist`);
  if (!dl) return;
  const provider = document.getElementById(`settings-model-${key}-provider`)?.value || '';
  // For built-in providers (anthropic/openai/openrouter/gemini), ids in
  // _settingsKnownLimits look like `openai/gpt-5.4`. For custom providers
  // like "glm", they look like `glm/<model-id>`. Bare model ids (no slash)
  // are treated as belonging to 'anthropic' by convention.
  const entries = [];
  for (const k of Object.keys(_settingsKnownLimits)) {
    const slash = k.indexOf('/');
    const pref = slash >= 0 ? k.slice(0, slash) : 'anthropic';
    const id = slash >= 0 ? k.slice(slash + 1) : k;
    if (pref !== provider) continue;
    const ctx = _settingsKnownLimits[k]?.contextLength;
    entries.push({ id, ctx: ctx || 0 });
  }
  entries.sort((a, b) => (b.ctx - a.ctx) || a.id.localeCompare(b.id));
  dl.innerHTML = entries.map(e =>
    `<option value="${_settingsEscapeHtml(e.id)}"${e.ctx ? ` label="${e.ctx.toLocaleString()} ctx"` : ''}></option>`
  ).join('');
}

// When the model input matches a known model id, auto-populate the ctx field
// (only if it's currently empty — we never overwrite an operator override).
function _settingsOnTierModelChange(key) {
  const providerSel = document.getElementById(`settings-model-${key}-provider`);
  const nameInp = document.getElementById(`settings-model-${key}-name`);
  const ctxInp = document.getElementById(`settings-model-${key}-ctx`);
  if (!providerSel || !nameInp || !ctxInp) return;
  const provider = providerSel.value;
  const model = (nameInp.value || '').trim();
  if (!model) return;
  const limKey = (provider && provider !== 'anthropic') ? `${provider}/${model}` : model;
  ctxInp.dataset.limKey = limKey;
  const known = _settingsKnownLimits[limKey]?.contextLength;
  if (known && !ctxInp.value) {
    // Leave value empty so "auto-detected" still shows as placeholder — but
    // refresh the placeholder so the operator sees the detected number.
  }
  _settingsRefreshTierPlaceholders(key);
}

async function _settingsAutoDetectModelLimits(data) {
  // For every configured custom provider, fetch its /models and cache ctx.
  const tasks = [];
  for (const p of (data.providers?.custom || [])) {
    if (!p?.url || !p?.name) continue;
    tasks.push(fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ kind: 'custom', baseUrl: p.url, apiKey: p.key, authHeader: p.authHeader }),
    }).then(r => r.json()).then(d => {
      if (!d?.ok) return;
      for (const m of (d.models || [])) {
        if (!m?.id) continue;
        const ref = `${p.name}/${m.id}`;
        const prev = _settingsKnownLimits[ref];
        _settingsKnownLimits[ref] = { contextLength: m.contextLength || prev?.contextLength || 0 };
      }
    }).catch(() => {}));
  }
  // Plugin-registered providers — read from data.providers.registered
  // (populated by web.js _getSettingsState from the plugin manager).
  // Each entry's per-provider config block is at data.providers[name],
  // so we don't need a separate hardcoded list.
  const registered = Array.isArray(data.providers?.registered) ? data.providers.registered : [];
  const builtins = registered
    .map(p => [p.name, data.providers?.[p.name]])
    .filter(([, cfg]) => cfg && typeof cfg === 'object');
  for (const [kind, cfg] of builtins) {
    if (!cfg?.apiKeySet && !cfg?.apiKey) continue;
    tasks.push(fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ kind, apiKey: cfg.apiKey || '', baseUrl: cfg.baseUrl || '' }),
    }).then(r => r.json()).then(d => {
      if (!d?.ok) return;
      for (const m of (d.models || [])) {
        if (!m?.id) continue;
        const ref = (kind === 'anthropic') ? m.id : `${kind}/${m.id}`;
        const prev = _settingsKnownLimits[ref];
        _settingsKnownLimits[ref] = { contextLength: m.contextLength || prev?.contextLength || 0 };
      }
    }).catch(() => {}));
  }
  await Promise.allSettled(tasks);
  // After all probes, refresh placeholders + datalists for every tier row.
  for (const [key] of (typeof SETTINGS_MODEL_FIELDS !== 'undefined' ? SETTINGS_MODEL_FIELDS : [])) {
    _settingsRefreshTierModelList(key);
    _settingsRefreshTierPlaceholders(key);
  }
}

// Live model-list refresh — lets the operator paste an API key into a
// provider input and watch the per-tier datalists populate without
// having to hit Save first. Triggered on debounced 'input' for each
// built-in provider's apiKey field. Uses the form's CURRENT values
// (not the persisted snapshot) so unsaved keys still drive the probe.
//
// Built-in providers list mirrors _settingsAutoDetectModelLimits; when
// you add a new built-in provider, also add its input ids here.
const _SETTINGS_PROVIDER_LIVE_PROBE = [
  // [kind, apiKeyInputId, baseUrlInputId|null]
  ['anthropic',  'settings-provider-anthropic-key',  null],
  ['openai',     'settings-provider-openai-key',     'settings-provider-openai-base-url'],
  ['openrouter', 'settings-provider-openrouter-key', 'settings-provider-openrouter-base-url'],
  ['zai',        'settings-provider-zai-key',        'settings-provider-zai-base-url'],
];

let _settingsLiveProbeTimer = null;
function _settingsLiveProbeOneProvider(kind, apiKey, baseUrl) {
  return fetch(API + '/api/providers/list-models', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind, apiKey: apiKey || '', baseUrl: baseUrl || '' }),
  }).then(r => r.json()).then(d => {
    if (!d?.ok) return;
    for (const m of (d.models || [])) {
      if (!m?.id) continue;
      const ref = (kind === 'anthropic') ? m.id : `${kind}/${m.id}`;
      const prev = _settingsKnownLimits[ref];
      _settingsKnownLimits[ref] = { contextLength: m.contextLength || prev?.contextLength || 0 };
    }
    // Repaint the tier rows so the just-fetched models appear in
    // datalists + the contextLength placeholders update.
    for (const [key] of (typeof SETTINGS_MODEL_FIELDS !== 'undefined' ? SETTINGS_MODEL_FIELDS : [])) {
      _settingsRefreshTierModelList(key);
      _settingsRefreshTierPlaceholders(key);
    }
  }).catch(() => {});
}

function _bindSettingsProviderLiveProbe() {
  for (const [kind, keyId, baseId] of _SETTINGS_PROVIDER_LIVE_PROBE) {
    const keyInp = document.getElementById(keyId);
    if (!keyInp || keyInp.dataset.liveProbeBound === '1') continue;
    keyInp.dataset.liveProbeBound = '1';
    const fire = () => {
      const apiKey = (keyInp.value || '').trim();
      if (!apiKey || apiKey === '***hidden***') return;
      const baseUrl = baseId ? (document.getElementById(baseId)?.value.trim() || '') : '';
      clearTimeout(_settingsLiveProbeTimer);
      _settingsLiveProbeTimer = setTimeout(
        () => _settingsLiveProbeOneProvider(kind, apiKey, baseUrl),
        // 1.2s debounce — long enough to stop firing mid-paste, short
        // enough to feel responsive after the operator stops typing.
        1200
      );
    };
    keyInp.addEventListener('input', fire);
    if (baseId) {
      const baseInp = document.getElementById(baseId);
      if (baseInp && baseInp.dataset.liveProbeBound !== '1') {
        baseInp.dataset.liveProbeBound = '1';
        baseInp.addEventListener('input', fire);
      }
    }
  }
}

// Hide settings sections whose owning plugin isn't installed. Sections
// declare ownership via `data-plugin-required="<plugin-id>"`. Cached for
// the lifetime of the panel; "everything optional" — when the plugin is
// uninstalled the card disappears, when reinstalled it reappears.
let _pluginInstalledIdsCache = null;
async function _ensurePluginInstalledIds() {
  if (_pluginInstalledIdsCache) return _pluginInstalledIdsCache;
  try {
    const r = await fetch(API + '/api/plugins/list', { headers: authHeaders() });
    if (!r.ok) { _pluginInstalledIdsCache = new Set(); return _pluginInstalledIdsCache; }
    const data = await r.json();
    _pluginInstalledIdsCache = new Set((data?.installed || []).map(p => p.id));
  } catch { _pluginInstalledIdsCache = new Set(); }
  return _pluginInstalledIdsCache;
}
async function _hidePluginUiIfMissing() {
  const ids = await _ensurePluginInstalledIds();
  document.querySelectorAll('[data-plugin-required]').forEach(el => {
    const required = el.getAttribute('data-plugin-required');
    el.style.display = required && ids.has(required) ? '' : 'none';
  });
}


// ── Settings tabs ────────────────────────────────────────────────────
// Each settings-section carries data-target-tab="<id>". On panel open we
// reparent sections into the right tab pane, render a role-filtered tab
// bar, and activate either the last-active tab or the first allowed one.
// Lazy refresh hooks run on tab switch so live state (backup list,
// janitor bin, tailscale status, etc.) stays fresh without blocking open.
const SETTINGS_TABS = [
  { id: 'profile',      label: 'Profile',       forAll: true  },
  { id: 'providers',    label: 'Providers',     forAll: false },
  { id: 'agent',        label: 'Agent',         forAll: false },
  { id: 'graph-memory', label: 'Graph & Memory', forAll: false },
  { id: 'backups',      label: 'Backups',       forAll: false },
  { id: 'tools',        label: 'Tools',         forAll: false },
  { id: 'plugins',      label: 'Plugins',       forAll: false },
  { id: 'users',        label: 'Users',         forAll: false },
  { id: 'advanced',     label: 'Advanced',      forAll: false },
];
const _SETTINGS_TAB_REFRESHERS = {
  'graph-memory': () => {
    try { if (typeof _maintRefreshStatus === 'function') _maintRefreshStatus(); } catch {}
    try { if (typeof _janRefreshStatus === 'function') _janRefreshStatus(); } catch {}
    try { if (typeof _janLoadBin === 'function') _janLoadBin(); } catch {}
  },
  'backups': () => {
    try { if (typeof _bkLoadStatus === 'function') _bkLoadStatus(); } catch {}
    try { if (typeof _bkLoadList === 'function') _bkLoadList(); } catch {}
  },
  // Tailscale + compute-cluster live in their plugins now (Plugins
  // tab). No 'cluster' refresher needed.
};

function _reparentSettingsSections() {
  // Move every [data-target-tab] section into its matching pane. Idempotent.
  const sections = document.querySelectorAll('#settings-pane [data-target-tab]');
  sections.forEach(sec => {
    const tab = sec.getAttribute('data-target-tab');
    const pane = document.querySelector(`#settings-panes [data-tab="${tab}"]`);
    if (pane && sec.parentElement !== pane) pane.appendChild(sec);
  });
}

function _renderSettingsTabs() {
  const tabBar = document.getElementById('settings-tabs');
  if (!tabBar) return;
  const isCreator = (typeof _isCreatorRole === 'function') ? _isCreatorRole() : (_userRole === 'creator' || _userRole === 'admin');
  // Empty tabs get auto-hidden (e.g. Users tab when no user mgmt is configured)
  const nonEmpty = new Set(
    Array.from(document.querySelectorAll('#settings-panes .settings-tab-pane'))
      .filter(p => p.children.length > 0)
      .map(p => p.getAttribute('data-tab'))
  );
  const allowed = SETTINGS_TABS.filter(t => (isCreator || t.forAll) && nonEmpty.has(t.id));
  tabBar.innerHTML = allowed.map(t =>
    `<button class="settings-tab" type="button" data-tab="${t.id}">${t.label}</button>`
  ).join('');
}

function _settingsSwitchTab(tabId) {
  const panes = document.querySelectorAll('#settings-panes .settings-tab-pane');
  const buttons = document.querySelectorAll('#settings-tabs .settings-tab');
  let resolved = tabId;
  // Fall back to first visible tab if requested isn't available to this user
  const visibleTabIds = Array.from(buttons).map(b => b.getAttribute('data-tab'));
  if (!visibleTabIds.includes(resolved)) resolved = visibleTabIds[0] || 'profile';
  panes.forEach(p => p.classList.toggle('active', p.getAttribute('data-tab') === resolved));
  buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === resolved));
  try { localStorage.setItem('spore-settings-tab', resolved); } catch {}
  const refresh = _SETTINGS_TAB_REFRESHERS[resolved];
  if (refresh) refresh();
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.classList?.contains('settings-tab') && t.hasAttribute('data-tab')) {
    _settingsSwitchTab(t.getAttribute('data-tab'));
  }
});

async function openSettingsPanel() {
  const { overlay } = getSettingsEls();
  if (!overlay) {
    toast('Settings panel failed to initialize', true);
    return;
  }
  if (typeof toolsMenu !== 'undefined' && toolsMenu) toolsMenu.style.display = 'none';
  _toolsMenuOpen = false;
  closeToolsSubmenus();
  setSettingsBusy(true, 'Loading settings...');

  overlay.classList.add('settings-pane-open');
  _initSettingsFloatingPane();
  _bindResetGraphButton();
  _bindInviteKeyButtons();
  _hidePluginUiIfMissing();
  if (typeof _focusFloatingWindow === 'function') _focusFloatingWindow('settings-pane');
  if (typeof _syncUtilBar === 'function') _syncUtilBar();

  try {
    const r = await fetch(API + '/api/settings', { headers: authHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Failed to load settings');
    populateSettingsPanel(data);
    renderSettingsGraphsList();
    // Re-parent settings-sections into their tab panes, render the tab bar,
    // and activate either the remembered tab or the first available one.
    _reparentSettingsSections();
    _renderSettingsTabs();
    let lastTab = 'profile';
    try { lastTab = localStorage.getItem('spore-settings-tab') || 'profile'; } catch {}
    _settingsSwitchTab(lastTab);
    setSettingsBusy(false, '');
    _settingsAutoDetectModelLimits(data);
    _bindSettingsProviderLiveProbe();
  } catch (e) {
    setSettingsBusy(false, e?.message || 'Failed to load settings');
  }
}

let _settingsPaneInited = false;
function _initSettingsFloatingPane() {
  if (_settingsPaneInited) return;
  const pane = document.getElementById('settings-pane');
  // Drop any prior saved rect that would snap the pane to a tiny default
  try {
    const raw = localStorage.getItem('_floatingWindow:settings-pane');
    if (raw) {
      const r = JSON.parse(raw);
      if (!r || r.width < 560 || r.height < 400) localStorage.removeItem('_floatingWindow:settings-pane');
    }
  } catch {}
  // Set generous initial rect BEFORE init so the helper doesn't snap to 360x320
  if (pane) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(920, Math.max(640, vw * 0.7));
    const h = Math.min(720, Math.max(480, vh * 0.78));
    pane.style.width = w + 'px';
    pane.style.height = h + 'px';
    pane.style.left = Math.max(24, Math.round((vw - w) / 2)) + 'px';
    pane.style.top = Math.max(48, Math.round((vh - h) / 2)) + 'px';
  }
  if (typeof _initFloatingWindow === 'function') {
    _initFloatingWindow('settings-pane', '.floating-pane-head');
  }
  // If helper snapped too small, force our dimensions back
  if (pane) {
    const r = pane.getBoundingClientRect();
    if (r.width < 560 || r.height < 400) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(920, Math.max(640, vw * 0.7));
      const h = Math.min(720, Math.max(480, vh * 0.78));
      pane.style.width = w + 'px';
      pane.style.height = h + 'px';
      pane.style.left = Math.max(24, Math.round((vw - w) / 2)) + 'px';
      pane.style.top = Math.max(48, Math.round((vh - h) / 2)) + 'px';
    }
  }
  // Hook the close button — can't use data-window-action="close" because
  // _initFloatingWindow routes it through closeRightPanel(), which doesn't
  // know about settings-pane. Same pattern as tm-window.
  const closeBtn = document.getElementById('settings-pane-close-btn');
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSettingsPanel(); });
  }
  _settingsPaneInited = true;
}

function closeSettingsPanel() {
  const { overlay } = getSettingsEls();
  overlay?.classList.remove('settings-pane-open', 'window-maximized');
  setSettingsBusy(false, '');
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}

async function renderSettingsGraphsList() {
  const container = document.getElementById('settings-graphs-list');
  if (!container) return;
  container.innerHTML = '<div style="opacity:.5;font-size:.66rem;padding:6px">loading…</div>';
  try {
    const res = await fetch(API + '/api/graphs');
    const data = await res.json();
    const graphs = data.graphs || [];
    if (!graphs.length) {
      container.innerHTML = '<div style="opacity:.5;font-size:.66rem;padding:6px">No graphs yet</div>';
      return;
    }
    container.innerHTML = graphs.map(g => {
      const nodes = g.nodeCount != null ? g.nodeCount : '?';
      return `<div class="settings-graph-row${g.active ? ' active' : ''}" data-slug="${esc(g.slug)}" title="${esc(g.description || g.name)}">
        <span class="sg-name">${esc(g.name)}</span>
        <span class="sg-count">${nodes}n</span>
        ${g.active ? '<span class="sg-badge">active</span>' : ''}
      </div>`;
    }).join('');
    container.querySelectorAll('.settings-graph-row').forEach(el => {
      el.addEventListener('click', () => {
        const slug = el.dataset.slug;
        const g = graphs.find(x => x.slug === slug);
        if (g && !g.active && typeof switchToGraph === 'function') switchToGraph(slug);
      });
    });
  } catch (e) {
    container.innerHTML = `<div style="opacity:.5;font-size:.66rem;padding:6px;color:var(--danger)">Failed: ${esc(e.message)}</div>`;
  }
}

// Reset Graph button — gates on the user typing the literal RESET into
// the confirm input, then POSTs /api/admin/reset-graph. On success
// shows the before/after counts + backup path inline. The endpoint
// itself also requires {confirm: "RESET"} as a second guard. Idempotent
// rebind — refreshes button state if the settings pane is opened/closed
// multiple times in one session.
// Invite-key card buttons — show/hide toggle, copy-to-clipboard, regen.
// Regen sets a `_pendingInviteRegenerate` flag so the next saveSettingsPanel
// call posts `inviteKeyRegenerate: true` instead of the typed value.
let _inviteKeyBound = false;
let _pendingInviteRegenerate = false;
function _bindInviteKeyButtons() {
  if (_inviteKeyBound) return;
  _inviteKeyBound = true;
  const input = document.getElementById('settings-invite-key');
  document.getElementById('settings-invite-key-show')?.addEventListener('click', () => {
    if (!input) return;
    if (input.type === 'password') { input.type = 'text'; document.getElementById('settings-invite-key-show').textContent = 'hide'; }
    else { input.type = 'password'; document.getElementById('settings-invite-key-show').textContent = 'show'; }
  });
  document.getElementById('settings-invite-key-copy')?.addEventListener('click', async () => {
    if (!input?.value) return;
    const ok = await _copyToClipboard(input.value);
    toast(ok ? 'Invite key copied' : 'Copy failed — select manually', !ok);
  });
  document.getElementById('settings-invite-key-regen')?.addEventListener('click', async () => {
    if (!confirm('Regenerate the SPORE invite key? Existing webapp guests + acorn-cli users will lose access until they get the new key.')) return;
    _pendingInviteRegenerate = true;
    if (input) input.value = '';
    const note = document.getElementById('settings-invite-key-note');
    if (note) note.textContent = 'Will mint a fresh UUID on Save.';
    toast('Click Save to mint the new key');
  });
}

let _resetGraphBound = false;
function _bindResetGraphButton() {
  if (_resetGraphBound) return;
  const input = document.getElementById('settings-reset-confirm');
  const btn = document.getElementById('settings-reset-btn');
  const result = document.getElementById('settings-reset-result');
  if (!input || !btn) return;
  _resetGraphBound = true;

  const updateBtn = () => {
    const ok = input.value === 'RESET';
    btn.disabled = !ok;
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
    btn.style.opacity = ok ? '1' : '0.5';
  };
  input.addEventListener('input', updateBtn);

  btn.addEventListener('click', async () => {
    if (input.value !== 'RESET') return;
    btn.disabled = true;
    btn.textContent = 'Resetting…';
    if (result) {
      result.style.display = 'block';
      result.textContent = 'Wiping graph + reseeding refs…';
    }
    try {
      const r = await fetch(API + '/api/admin/reset-graph', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || 'reset failed');
      const b = data.before || {};
      const a = data.after || {};
      const summary = `Graph reset OK. before: nodes=${b.nodes} aspects=${b.aspects} attrs=${b.attrs} edges=${b.edges} episodes=${b.episodes}. after: nodes=${a.nodes} aspects=${a.aspects} attrs=${a.attrs} edges=${a.edges} episodes=${a.episodes}. backup at ${data.backup}.`;
      if (result) result.textContent = summary;
      if (typeof toast === 'function') toast('Graph reset to seeds');
    } catch (e) {
      if (result) result.textContent = 'Failed: ' + (e?.message || e);
      if (typeof toast === 'function') toast('Reset failed: ' + (e?.message || e), true);
    } finally {
      input.value = '';
      updateBtn();
      btn.textContent = 'Reset graph';
    }
  });
  updateBtn();
}

// Agent Effort — 3-button picker (quick / balanced / deep). The selected
// tier is stored in a data attribute on the buttons container so save can
// read it; clicking a button updates the active class + redraws the
// budget input placeholders to reflect that tier's defaults.
let _settingsEffortPresets = null;
function _populateAgentEffortButtons(effort) {
  const wrap = document.getElementById('settings-effort-buttons');
  if (!wrap) return;
  const value = (effort && effort.value) || 'balanced';
  wrap.dataset.value = value;
  _settingsEffortPresets = effort?.presets || null;
  wrap.querySelectorAll('.settings-effort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.effort === value);
  });
  if (!wrap.dataset.bound) {
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-effort-btn');
      if (!btn) return;
      const tier = btn.dataset.effort;
      if (!tier) return;
      wrap.dataset.value = tier;
      wrap.querySelectorAll('.settings-effort-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      _refreshAgentEffortSummary();
      _refreshAgentBudgetPlaceholders();
    });
  }
  _refreshAgentEffortSummary();
}
function _refreshAgentEffortSummary() {
  const wrap = document.getElementById('settings-effort-buttons');
  const note = document.getElementById('settings-effort-summary');
  if (!wrap || !note || !_settingsEffortPresets) return;
  const tier = wrap.dataset.value || 'balanced';
  const p = _settingsEffortPresets[tier];
  if (!p) { note.textContent = ''; return; }
  note.textContent =
    `Casual ${p.casualMessageBudget.toLocaleString()} / Complex ${p.complexMessageBudget.toLocaleString()} tokens · ` +
    `${p.dmMaxIterations} chat iters · ${p.maxSubagentChildren} concurrent sub-agents (${p.subagentMaxIter} iters / ${Math.round(p.subagentTimeoutSeconds/60)}m each, ${p.subagentMaxTokens.toLocaleString()} max-tokens)`;
}
// Re-render budget input placeholders when the effort tier changes so the
// "auto (X)" text reflects the newly-selected tier's defaults instead of
// the server's snapshot. Pinned values (the input's actual value) stay.
function _refreshAgentBudgetPlaceholders() {
  const wrap = document.getElementById('settings-effort-buttons');
  if (!wrap || !_settingsEffortPresets) return;
  const tier = wrap.dataset.value || 'balanced';
  const p = _settingsEffortPresets[tier];
  if (!p) return;
  const map = [
    ['settings-budget-casual',           p.casualMessageBudget],
    ['settings-budget-complex',          p.complexMessageBudget],
    ['settings-budget-tool-result-cap',  p.maxToolResultChars],
  ];
  for (const [id, val] of map) {
    const input = document.getElementById(id);
    const note = document.getElementById(`${id}-default`);
    if (input) input.placeholder = `auto (${val.toLocaleString()})`;
    if (note) note.textContent = `Default: ${val.toLocaleString()}. Leave blank to use the auto-scaled value.`;
  }
}
function _collectAgentEffortPayload() {
  const wrap = document.getElementById('settings-effort-buttons');
  if (!wrap) return null;
  return wrap.dataset.value || 'balanced';
}

// Agent context budgets — 4 absolute knobs in the Agent tab. Server
// returns `data.agent.budgets = { casualMessageBudget, complexMessageBudget,
// compactTokenThreshold, maxToolResultChars, defaults: {...} }`. A null
// field means "no override saved" and the input renders empty with the
// default shown as placeholder + a sub-label.
function _populateAgentBudgetsInputs(agent) {
  const budgets = agent?.budgets;
  if (!budgets) return;
  const defaults = budgets.defaults || {};
  const fields = [
    ['casualMessageBudget',   'settings-budget-casual'],
    ['complexMessageBudget',  'settings-budget-complex'],
    ['compactTokenThreshold', 'settings-budget-compact-threshold'],
    ['maxToolResultChars',    'settings-budget-tool-result-cap'],
  ];
  for (const [key, inputId] of fields) {
    const input = document.getElementById(inputId);
    const noteEl = document.getElementById(`${inputId}-default`);
    if (!input) continue;
    const cur = budgets[key];
    const def = defaults[key];
    input.value = (cur != null && cur !== def) ? String(cur) : '';
    if (def != null) {
      input.placeholder = `auto (${def.toLocaleString()})`;
      if (noteEl) noteEl.textContent = `Default: ${def.toLocaleString()}. Leave blank to use the auto-scaled value.`;
    }
  }
}

// Inverse of _populateAgentBudgetsInputs. Empty input = "no override"
// (omitted from payload entirely so the server's clear path runs and
// the auto-scaled default kicks back in). Non-empty = positive integer
// override sent to the server, which validates + persists it.
function _collectAgentBudgetsPayload() {
  const fields = [
    ['casualMessageBudget',   'settings-budget-casual'],
    ['complexMessageBudget',  'settings-budget-complex'],
    ['compactTokenThreshold', 'settings-budget-compact-threshold'],
    ['maxToolResultChars',    'settings-budget-tool-result-cap'],
  ];
  const out = {};
  for (const [key, inputId] of fields) {
    const input = document.getElementById(inputId);
    if (!input) continue;
    const raw = (input.value || '').trim();
    if (!raw) {
      // Send explicit null so the server clears the override; the loop
      // falls back to its auto-scaled floor on the very next turn.
      out[key] = null;
      continue;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      out[key] = null;
      continue;
    }
    out[key] = n;
  }
  return out;
}

function _populateBudgetInputs(budgets) {
  if (!budgets) return;
  const sectionDefaults = budgets.sectionDefaults || {};
  const sections = budgets.sections || {};

  // Headline runtime + total knobs
  const runtimeInput = document.getElementById('settings-budget-runtime');
  const runtimeDef = document.getElementById('settings-budget-runtime-default');
  if (runtimeInput) {
    const defVal = sectionDefaults.runtime;
    const curVal = sections.runtime;
    runtimeInput.value = (curVal != null && curVal !== defVal) ? curVal : '';
    runtimeInput.placeholder = `default: ${defVal ?? '?'}`;
  }
  if (runtimeDef && sectionDefaults.runtime != null) {
    runtimeDef.textContent = `(default ${sectionDefaults.runtime})`;
  }

  const totalInput = document.getElementById('settings-budget-total');
  const totalDef = document.getElementById('settings-budget-total-default');
  if (totalInput) {
    const defVal = budgets.totalDefault;
    const curVal = budgets.total;
    totalInput.value = (curVal != null && curVal !== defVal) ? curVal : '';
    totalInput.placeholder = `default: ${defVal ?? '?'}`;
  }
  if (totalDef && budgets.totalDefault != null) {
    totalDef.textContent = `(default ${budgets.totalDefault})`;
  }

  // Per-section grid — render lazily so the DOM only carries 18 inputs
  // when the user opens the <details>. Keep input ids predictable so
  // saveSettingsPanel can read them by key.
  const grid = document.getElementById('settings-budget-sections-grid');
  if (!grid) return;
  if (grid.dataset.rendered === '1') return;
  const orderedKeys = Object.keys(sectionDefaults).sort();
  grid.innerHTML = orderedKeys.map(k => {
    const defVal = sectionDefaults[k];
    const curVal = sections[k];
    const overridden = (curVal != null && curVal !== defVal);
    return `
      <div class="settings-budget-row" style="display:flex;flex-direction:column;gap:2px">
        <label for="settings-budget-section-${k}" style="font-size:0.85em">${k} <span style="opacity:0.55;font-weight:normal">(default ${defVal})</span></label>
        <input id="settings-budget-section-${k}" data-budget-section="${k}" type="number" min="100" step="100" placeholder="${defVal}" value="${overridden ? curVal : ''}">
      </div>
    `;
  }).join('');
  grid.dataset.rendered = '1';
}

// Collect non-empty per-section overrides + headline runtime + total
// into the budgets payload sent to /api/settings. Inputs left blank
// fall back to the in-source default (no override sent for that key).
function _collectBudgetsPayload() {
  const sections = {};
  document.querySelectorAll('#settings-budget-sections-grid input[data-budget-section]').forEach(el => {
    const key = el.getAttribute('data-budget-section');
    const raw = (el.value || '').trim();
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    sections[key] = n;
  });
  const runtimeRaw = (document.getElementById('settings-budget-runtime')?.value || '').trim();
  const runtime = runtimeRaw ? parseInt(runtimeRaw, 10) : null;
  if (Number.isFinite(runtime) && runtime > 0) sections.runtime = runtime;
  const totalRaw = (document.getElementById('settings-budget-total')?.value || '').trim();
  const total = totalRaw ? parseInt(totalRaw, 10) : null;
  const out = { sections };
  if (Number.isFinite(total) && total > 0) out.total = total;
  return out;
}

async function saveSettingsPanel() {
  // Theme is owned by the header sun/moon toggle and lives on the
  // browser-global _currentTheme — Settings just persists whatever's
  // active so the operator's choice survives reload.
  const theme = _currentTheme;
  // Webapp users save only personal preferences (theme + displayName) via
  // /api/preferences. They never touch /api/settings, so they can't change
  // server-side state even if they hit Save.
  if (!_isCreatorRole()) {
    setSettingsBusy(true, 'Saving…');
    try {
      const dn = document.getElementById('settings-profile-displayname')?.value.trim() || '';
      const r = await fetch(API + '/api/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ theme, displayName: dn }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Failed to save');
      if (theme && theme !== _currentTheme) applyGraphTheme(theme);
      setSettingsBusy(false, 'Saved');
      toast('Preferences saved');
      closeSettingsPanel();
    } catch (e) {
      setSettingsBusy(false, e?.message || 'Failed to save');
      toast(e?.message || 'Failed to save', true);
    }
    return;
  }
  const models = {};
  const modelLimits = {};
  for (const [key] of SETTINGS_MODEL_FIELDS) {
    const provider = document.getElementById(`settings-model-${key}-provider`)?.value || 'anthropic';
    const model = document.getElementById(`settings-model-${key}-name`)?.value.trim() || '';
    models[key] = { provider, model };
    const ctx = parseInt(document.getElementById(`settings-model-${key}-ctx`)?.value, 10);
    const cmp = parseInt(document.getElementById(`settings-model-${key}-compact`)?.value, 10);
    const mxo = parseInt(document.getElementById(`settings-model-${key}-maxout`)?.value, 10);
    const eff = document.getElementById(`settings-model-${key}-effort`)?.value || 'auto';
    if ((ctx > 0 || cmp > 0 || mxo > 0 || (eff && eff !== 'auto')) && model) {
      const limKey = (provider && provider !== 'anthropic') ? `${provider}/${model}` : model;
      const entry = modelLimits[limKey] || {};
      if (ctx > 0) entry.contextWindow = ctx;
      if (cmp > 0) entry.compactAt = cmp;
      if (mxo > 0) entry.maxTokens = mxo;
      if (eff && eff !== 'auto') entry.reasoningEffort = eff;
      modelLimits[limKey] = entry;
    }
  }
  const payload = {
    displayName: document.getElementById('settings-display-name').value.trim(),
    nicknames: document.getElementById('settings-nicknames').value.split(',').map(s => s.trim()).filter(Boolean),
    enhancedRecall: document.getElementById('settings-enhanced-recall').checked,
    proactive: {
      enabled: document.getElementById('settings-proactive-enabled').checked,
      cooldownMinutes: parseInt(document.getElementById('settings-proactive-cooldown').value, 10) || 60,
      maxPerDay: parseInt(document.getElementById('settings-proactive-max-day').value, 10) || 5,
      channels: document.getElementById('settings-proactive-channels').value.split(',').map(s => s.trim()).filter(Boolean),
    },
    voice: {
      enabled: document.getElementById('settings-voice-enabled').checked,
      sttProvider: document.getElementById('settings-stt-provider').value,
      ttsProvider: document.getElementById('settings-tts-provider').value,
      ttsVoice: document.getElementById('settings-tts-voice').value.trim(),
      edgeVoice: document.getElementById('settings-edge-voice').value.trim(),
      ttsModel: document.getElementById('settings-tts-model').value.trim(),
    },
    models,
    modelLimits,
    providers: {
      anthropic: {
        apiKey: document.getElementById('settings-provider-anthropic-key').value.trim(),
      },
      openai: {
        baseUrl: document.getElementById('settings-provider-openai-base-url').value.trim(),
        apiKey: document.getElementById('settings-provider-openai-key').value.trim(),
      },
      openrouter: {
        baseUrl: document.getElementById('settings-provider-openrouter-base-url').value.trim(),
        apiKey: document.getElementById('settings-provider-openrouter-key').value.trim(),
        referer: document.getElementById('settings-provider-openrouter-referer').value.trim(),
      },
      local: {
        baseUrl: document.getElementById('settings-provider-local-base-url').value.trim(),
        apiKey: document.getElementById('settings-provider-local-key').value.trim(),
      },
      zai: {
        baseUrl: document.getElementById('settings-provider-zai-base-url')?.value.trim() || '',
        apiKey:  document.getElementById('settings-provider-zai-key')?.value.trim() || '',
      },
      custom: collectSettingsCustomProviders(),
    },
    browser: {
      backend: document.getElementById('settings-browser-backend').value,
    },
    publicUrl: document.getElementById('settings-runtime-public-url-input')?.value.trim() || '',
    budgets: _collectBudgetsPayload(),
    agent: { effort: _collectAgentEffortPayload(), budgets: _collectAgentBudgetsPayload() },
    webSearch: {
      searxngUrl: document.getElementById('settings-websearch-searxng-url').value.trim(),
      searxngApiKey: document.getElementById('settings-websearch-searxng-key').value.trim(),
      braveApiKey: document.getElementById('settings-websearch-brave-key').value.trim(),
    },
    plugins: _collectPluginSettingsPayload(),
    // Invite key: regen flag wins (mint fresh UUID server-side).
    // Otherwise send the typed value (empty string = disable).
    ...(_pendingInviteRegenerate
      ? { inviteKeyRegenerate: true }
      : { inviteKey: document.getElementById('settings-invite-key')?.value.trim() ?? '' }),
  };
  // Reset the regen latch after the body is built; the next save would
  // be a normal value-update unless the operator clicks regen again.
  _pendingInviteRegenerate = false;

  setSettingsBusy(true, 'Saving settings...');
  try {
    const r = await fetch(API + '/api/settings', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data?.ok) throw new Error(data?.error || 'Failed to save settings');
    // Profile tab's "What should the agent call you?" lives in per-user prefs,
    // not /api/settings (which is global agent config). Save it separately so
    // the Profile tab's value persists across reopens for creators too.
    const profileDn = document.getElementById('settings-profile-displayname')?.value.trim() || '';
    try {
      await fetch(API + '/api/preferences', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, displayName: profileDn }),
      });
    } catch {}
    // Fan out to each subsection's dedicated save endpoint. These sections
    // have their own Save buttons in the UI, but the big Save button should
    // also capture any edits the user made there. Values were populated on
    // panel open, so re-saving unchanged fields is idempotent.
    const sectionSaves = [
      ['Backups', typeof _bkSaveSettings === 'function' ? _bkSaveSettings : null],
      // Tailscale + cluster save flows live in the plugin settings
      // panes (Plugins tab) — they have their own per-pane Save
      // buttons, no central-Save propagation.
    ].filter(([, fn]) => fn);
    const sectionFailures = [];
    for (const [name, fn] of sectionSaves) {
      try { await fn(); } catch (e) { sectionFailures.push(`${name}: ${e.message || e}`); }
    }
    if (sectionFailures.length) toast('Some subsections failed: ' + sectionFailures.join('; '), true);
    populateSettingsPanel(data.settings);
    if (theme && theme !== _currentTheme) applyGraphTheme(theme);
    updateErBadge(!!data.settings?.memory?.enhancedRecall);
    setSettingsBusy(false, 'Saved');
    toast('Settings saved');
    closeSettingsPanel();
  } catch (e) {
    setSettingsBusy(false, e?.message || 'Failed to save settings');
    toast(e?.message || 'Failed to save settings', true);
  }
}

