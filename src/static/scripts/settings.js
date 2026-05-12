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
      stateEl.textContent = 'Plugin system enabled (read-only). Remove SPORE_PLUGINS_HOT_RELOAD=false or set it to true to allow runtime install/uninstall and git clone.';
    } else {
      stateEl.textContent = 'Plugin system enabled with hot reload. Install/uninstall takes effect without restart; updating an existing plugin still needs a restart.';
    }
  }
  if (dirsEl) {
    const bundled = plugins.dirs?.bundled || '(unset)';
    const user = plugins.dirs?.user || '(unset — set SPORE_PLUGINS_USER_DIR to enable git clone)';
    dirsEl.innerHTML = `Discovery dirs: <code>${_escapeHtml(bundled)}</code> (bundled) · <code>${_escapeHtml(user)}</code> (user)`;
  }
  if (cloneRow) cloneRow.hidden = !(enabled && hot && plugins.dirs?.user);

  // Unified list: everything on disk, with install/uninstall toggle per row.
  const availableAll = Array.isArray(plugins.available) ? plugins.available : [];
  const available = availableAll.filter(p => !_isChannelPlugin(p));
  if (available.length === 0) {
    mgrEl.innerHTML = '<div class="settings-note settings-muted-soft">No plugins found in either discovery dir.</div>';
  } else {
    mgrEl.innerHTML = available.map(_renderPluginRow.bind(null, hot)).join('');
  }

  // Schema-driven panes — for now, only render panes that target the 'plugins' tab.
  // (Cross-tab placement — pane.tab === 'agent' filing under the Agent tab — will
  //  follow in a later pass; the API supports it but the host needs more wiring.)
  const panes = Array.isArray(plugins.panes) ? plugins.panes.filter(p => (!p.tab || p.tab === 'plugins') && !_isChannelPane(p, availableAll)) : [];
  if (panes.length === 0) {
    panesEl.innerHTML = '<div class="settings-note settings-muted-soft">No plugin settings to configure.</div>';
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
  const sourceTag = `<span class="settings-note settings-muted-soft">${_escapeHtml(p.source || 'unknown')}</span>`;
  const description = (p.description || '').trim() || 'No description provided by this plugin.';
  const stateTag = p.isInstalled
    ? '<span class="settings-note settings-status-ok">installed</span>'
    : (p.isDisabled
      ? '<span class="settings-note settings-status-danger">uninstalled</span>'
      : '<span class="settings-note settings-muted-soft">available</span>');

  const bits = [];
  if (p.hasReferenceNodes) bits.push('<span class="settings-note settings-muted">ref nodes</span>');
  if (p.toolCount) bits.push(`<span class="settings-note settings-muted">${p.toolCount} tool${p.toolCount > 1 ? 's' : ''}</span>`);
  if (p.gatewayCount) bits.push(`<span class="settings-note settings-muted">${p.gatewayCount} gateway${p.gatewayCount > 1 ? 's' : ''}</span>`);
  if ((p.depends || []).length) bits.push(`<span class="settings-note settings-muted-soft">depends: ${p.depends.map(_escapeHtml).join(', ')}</span>`);

  let actionBtn = '';
  if (hotReload) {
    actionBtn = p.isInstalled
      ? `<button type="button" class="settings-btn-secondary" data-plugin-uninstall="${_escapeAttr(p.id)}">Uninstall</button>`
      : `<button type="button" class="settings-btn-secondary" data-plugin-install="${_escapeAttr(p.id)}">Install</button>`;
  }

  return `<div class="settings-plugin-row">
    <div class="settings-plugin-row-main">
      <div class="settings-plugin-row-head">
        <strong>${_escapeHtml(p.name || p.id)}</strong>
        <span class="settings-note settings-muted-soft">${_escapeHtml(p.id)}@${_escapeHtml(p.version || '0.0.0')}</span>
        <span class="settings-note settings-muted">${_escapeHtml(p.kind)}</span>
        ${sourceTag}
        ${stateTag}
      </div>
      <div class="settings-plugin-description">${_escapeHtml(description)}</div>
      ${bits.length ? `<div class="settings-plugin-row-tags">${bits.join('')}</div>` : ''}
    </div>
    ${actionBtn}
  </div>`;
}

function _renderPluginPane(pane) {
  const fields = (pane.schema || []).map(field => _renderPluginField(pane.pluginId, field, pane.values?.[field.key], pane.meta?.[field.key])).join('');
  const desc = pane.description ? `<div class="settings-note">${_escapeHtml(pane.description)}</div>` : '';
  const customHtml = pane.html ? `<div data-plugin-custom="${pane.pluginId}">${pane.html}</div>` : '';
  const channelHtml = pane.pluginId === 'telegram' ? _renderTelegramPairingPanel() : '';
  return `<div class="settings-plugin-pane" data-plugin-pane="${pane.pluginId}">
    <h5>${_escapeHtml(pane.title)}</h5>
    ${desc}
    ${fields}
    ${customHtml}
    ${channelHtml}
  </div>`;
}

function _renderTelegramPairingPanel() {
  return `<div class="settings-channel-pairing" data-telegram-pairing>
    <div class="settings-channel-pairing-head">
      <div>
        <h6>Telegram pairing</h6>
        <div class="settings-note">Pending requests can be approved here.</div>
      </div>
      <button type="button" class="settings-btn-secondary" data-telegram-pair-refresh>Refresh</button>
    </div>
    <div class="settings-channel-pairing-status" data-telegram-pairing-status></div>
    <div class="settings-channel-pairing-group">
      <div class="settings-channel-pairing-label">Pending requests</div>
      <div class="settings-channel-pairing-list" data-telegram-pairing-pending>
        <div class="settings-note settings-muted-soft">Loading...</div>
      </div>
    </div>
    <div class="settings-channel-pairing-group">
      <div class="settings-channel-pairing-label">Approved users</div>
      <div class="settings-channel-pairing-list" data-telegram-pairing-approved>
        <div class="settings-note settings-muted-soft">Loading...</div>
      </div>
    </div>
  </div>`;
}

function _renderPluginField(pluginId, field, value, meta) {
  const W = window.SettingsWidgets;
  const id = `settings-plugin-${pluginId}-${field.key}`;
  // Compute the rendered value (saved slot value > schema default > '').
  // Stash it on the wrapper as `data-plugin-original` so the collector
  // can diff against it on save and only emit fields the operator
  // actually modified — without this, an unmodified Save sends every
  // schema default and clobbers env mirrors with values like
  // authHeader:'bearer' when the wizard had already persisted x-key.
  const v = (value === undefined || value === null) ? (field.default !== undefined ? field.default : '') : value;
  const fieldAttrs = {
    'data-plugin-field': `${pluginId}.${field.key}`,
    'data-plugin-secret': field.secret ? '1' : '0',
    'data-plugin-original': String(v),
  };
  const wrap = (inner, extraClass = '') => {
    if (W?.field) {
      return W.field({
        id,
        label: field.label || field.key,
        help: field.help,
        control: inner,
        className: `settings-plugin-field${extraClass ? ` ${extraClass}` : ''}`,
        attrs: fieldAttrs,
      });
    }
    const labelEl = `<label for="${id}">${_escapeHtml(field.label || field.key)}</label>`;
    const help = field.help ? `<div class="settings-note settings-muted-soft">${_escapeHtml(field.help)}</div>` : '';
    const originalAttr = `data-plugin-original="${_escapeAttr(String(v))}"`;
    return `<div class="settings-plugin-field${extraClass ? ` ${extraClass}` : ''}" data-plugin-field="${_escapeAttr(pluginId)}.${_escapeAttr(field.key)}" data-plugin-secret="${field.secret ? '1' : '0'}" ${originalAttr}>${labelEl}${inner}${help}</div>`;
  };
  switch (field.type) {
    case 'toggle': {
      return wrap(W?.input ? W.input({ id, type: 'checkbox', checked: !!v }) : `<input type="checkbox" id="${id}" ${!!v ? 'checked' : ''} />`);
    }
    case 'number':
      return wrap(W?.input ? W.input({ id, type: 'number', value: String(v) }) : `<input type="number" id="${id}" value="${_escapeAttr(String(v))}" />`, 'compact');
    case 'select': {
      if (W?.select) return wrap(W.select({ id, value: v, options: field.options || [] }));
      const opts = (field.options || []).map(o => `<option value="${_escapeAttr(o.value)}"${o.value === v ? ' selected' : ''}>${_escapeHtml(o.label || o.value)}</option>`).join('');
      return wrap(`<select id="${id}">${opts}</select>`);
    }
    case 'segmented': {
      if (W?.segmented) return wrap(W.segmented({ id, value: v, options: field.options || [], className: 'settings-plugin-segmented' }));
      const selected = String(v);
      const buttons = (field.options || []).map(o => {
        const optionValue = String(o.value);
        const active = optionValue === selected ? ' active' : '';
        const pressed = optionValue === selected ? 'true' : 'false';
        const title = o.description || o.help || o.label || o.value;
        return `<button class="settings-segmented-btn${active}" type="button" data-settings-segment-value="${_escapeAttr(optionValue)}" aria-pressed="${pressed}" title="${_escapeAttr(title)}">${_escapeHtml(o.label || optionValue)}</button>`;
      }).join('');
      return wrap(`<input type="hidden" id="${id}" value="${_escapeAttr(selected)}" /><div class="settings-widget-segmented settings-plugin-segmented" data-settings-segmented-for="${id}">${buttons}</div>`);
    }
    case 'textarea':
      return wrap(W?.textarea ? W.textarea({ id, rows: 3, value: String(v) }) : `<textarea id="${id}" rows="3">${_escapeHtml(String(v))}</textarea>`);
    case 'password': {
      const placeholder = meta?.isSet ? '••• stored — leave blank to keep' : '';
      return wrap(W?.input ? W.input({ id, type: 'password', placeholder }) : `<input type="password" id="${id}" placeholder="${placeholder}" />`);
    }
    default:
      return wrap(W?.input ? W.input({ id, type: 'text', value: String(v) }) : `<input type="text" id="${id}" value="${_escapeAttr(String(v))}" />`);
  }
}

function _isChannelPlugin(p) {
  if (!p) return false;
  return !!p.channel || p.category === 'channels' || ['discord', 'telegram', 'slack'].includes(p.id);
}

function _isChannelPane(pane, plugins) {
  if (!pane) return false;
  if (pane.tab === 'channels') return true;
  const meta = (plugins || []).find(p => p.id === pane.pluginId);
  return _isChannelPlugin(meta);
}

function _populateChannelsTab(plugins) {
  const listEl = document.getElementById('settings-channels-list');
  const panesEl = document.getElementById('settings-channels-panes');
  if (!listEl || !panesEl) return;
  const hot = !!plugins.hotReload;
  const available = (Array.isArray(plugins.available) ? plugins.available : []).filter(_isChannelPlugin);
  const gatewayRows = Array.isArray(plugins.gateways)
    ? plugins.gateways
    : Object.entries(plugins.gateways || {}).map(([platform, status]) => ({ platform, status }));
  const statuses = new Map(gatewayRows.map(g => [g.platform || g.name, g]));

  const builtins = [
    {
      id: 'web',
      name: 'Web',
      description: 'Always-on browser chat and graph UI. This stays in core because it hosts Settings, onboarding, auth, files, and the app shell.',
      isInstalled: true,
      fixed: true,
      status: 'connected',
    },
    {
      id: 'cli',
      name: 'CLI / Spore Code',
      description: 'Enabled by the Spore Code plugin and invite key. CLI sessions are kept as a first-class local channel rather than a public chat integration.',
      isInstalled: true,
      fixed: true,
      status: 'available',
    },
  ];
  const channelRows = available.map(p => ({
    ...p,
    status: statuses.get(p.id)?.status || (p.isInstalled ? 'registered' : 'available'),
  }));
  listEl.innerHTML = builtins.concat(channelRows).map(p => _renderChannelRow(hot, p)).join('');

  const panes = Array.isArray(plugins.panes)
    ? plugins.panes.filter(p => _isChannelPane(p, available))
    : [];
  panesEl.innerHTML = panes.length
    ? panes.map(_renderPluginPane).join('')
    : '<div class="settings-note settings-muted-soft">No channel plugin settings available.</div>';
  try {
    document.dispatchEvent(new CustomEvent('spore-channel-panes-rendered', { detail: { panes } }));
  } catch {}
  try { _settingsRefreshTelegramPairing(); } catch {}
}

function _renderChannelRow(hotReload, p) {
  const status = p.status || (p.isInstalled ? 'installed' : 'available');
  const statusClass = status === 'connected' ? 'ok' : (status === 'disabled' || status === 'available' ? '' : 'warn');
  const action = p.fixed ? ''
    : (hotReload
      ? (p.isInstalled
        ? `<button type="button" class="settings-btn-secondary" data-plugin-uninstall="${_escapeAttr(p.id)}">Uninstall</button>`
        : `<button type="button" class="settings-btn-secondary" data-plugin-install="${_escapeAttr(p.id)}">Install</button>`)
      : '');
  const deps = (p.depends || []).length
    ? `<span class="settings-note settings-muted-soft">depends: ${p.depends.map(_escapeHtml).join(', ')}</span>`
    : '';
  return `<div class="settings-channel-row">
    <div class="settings-channel-main">
      <div class="settings-channel-title">
        <strong>${_escapeHtml(p.name || p.id)}</strong>
        <span class="settings-channel-id">${_escapeHtml(p.id)}</span>
        <span class="settings-channel-status ${statusClass}">${_escapeHtml(status)}</span>
      </div>
      <div class="settings-note settings-muted">${_escapeHtml(p.description || 'Channel integration plugin.')}</div>
      ${deps}
    </div>
    ${action}
  </div>`;
}

function _escapeHtml(s) {
  if (window.SettingsWidgets?.escapeHtml) return window.SettingsWidgets.escapeHtml(s);
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _escapeAttr(s) {
  if (window.SettingsWidgets?.escapeAttr) return window.SettingsWidgets.escapeAttr(s);
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function _settingsTelegramPairingStatus(message, kind = '') {
  const el = document.querySelector('[data-telegram-pairing-status]');
  if (!el) return;
  el.textContent = message || '';
  el.setAttribute('data-kind', kind || '');
}

function _settingsPairingName(req) {
  const meta = req?.meta || {};
  const username = meta.username ? `@${meta.username}` : '';
  const name = [meta.name, username].filter(Boolean).join(' ');
  return name || `Telegram user ${req?.id || 'unknown'}`;
}

function _settingsPairingTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toLocaleString(); } catch { return ''; }
}

function _settingsRenderTelegramPending(reqs) {
  if (!reqs.length) return '<div class="settings-note settings-muted-soft">No pending Telegram pairing requests.</div>';
  return reqs.map(req => {
    const lastSeen = _settingsPairingTime(req.lastSeenAt || req.createdAt);
    const details = [
      req.id ? `ID ${_escapeHtml(req.id)}` : '',
      lastSeen ? `last seen ${_escapeHtml(lastSeen)}` : '',
    ].filter(Boolean).join(' - ');
    return `<div class="settings-channel-pairing-row">
      <div class="settings-channel-pairing-main">
        <div class="settings-channel-pairing-title">${_escapeHtml(_settingsPairingName(req))}</div>
        <div class="settings-channel-pairing-code">${_escapeHtml(req.code || '')}</div>
        ${details ? `<div class="settings-note">${details}</div>` : ''}
      </div>
      <button type="button" class="settings-btn-secondary" data-telegram-pair-approve="${_escapeAttr(req.code || '')}">Approve</button>
    </div>`;
  }).join('');
}

function _settingsRenderTelegramApproved(ids) {
  if (!ids.length) return '<div class="settings-note settings-muted-soft">No approved Telegram users.</div>';
  return ids.map(id => `<div class="settings-channel-pairing-row">
    <div class="settings-channel-pairing-main">
      <div class="settings-channel-pairing-title">Telegram user</div>
      <div class="settings-channel-pairing-code">${_escapeHtml(id)}</div>
    </div>
    <button type="button" class="settings-btn-secondary" data-telegram-pair-revoke="${_escapeAttr(id)}">Revoke</button>
  </div>`).join('');
}

async function _settingsFetchPairingJson(path, options = {}) {
  const r = await fetch(API + path, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

async function _settingsRefreshTelegramPairing() {
  const panel = document.querySelector('[data-telegram-pairing]');
  if (!panel) return;
  const pendingEl = panel.querySelector('[data-telegram-pairing-pending]');
  const approvedEl = panel.querySelector('[data-telegram-pairing-approved]');
  if (!pendingEl || !approvedEl) return;
  pendingEl.innerHTML = '<div class="settings-note settings-muted-soft">Loading...</div>';
  approvedEl.innerHTML = '<div class="settings-note settings-muted-soft">Loading...</div>';
  _settingsTelegramPairingStatus('', '');
  try {
    const [pendingData, approvedData] = await Promise.all([
      _settingsFetchPairingJson('/api/pairing/pending'),
      _settingsFetchPairingJson('/api/pairing/approved'),
    ]);
    const pending = Array.isArray(pendingData?.telegram) ? pendingData.telegram : [];
    const approved = Array.isArray(approvedData?.telegram) ? approvedData.telegram : [];
    pendingEl.innerHTML = _settingsRenderTelegramPending(pending);
    approvedEl.innerHTML = _settingsRenderTelegramApproved(approved);
  } catch (err) {
    pendingEl.innerHTML = '<div class="settings-note settings-muted-soft">Unable to load pairing requests.</div>';
    approvedEl.innerHTML = '<div class="settings-note settings-muted-soft">Unable to load approved users.</div>';
    _settingsTelegramPairingStatus(err?.message || 'Pairing API unavailable', 'err');
  }
}

function _collectPluginSettingsPayload() {
  const out = {};
  document.querySelectorAll('#settings-plugins-panes [data-plugin-field], #settings-channels-panes [data-plugin-field]').forEach(wrap => {
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

  const pluginSegment = t.closest?.('[data-plugin-segment-value]');
  if (pluginSegment) {
    const group = pluginSegment.closest('[data-plugin-segmented-for]');
    const inputId = group?.getAttribute('data-plugin-segmented-for');
    const input = inputId ? document.getElementById(inputId) : null;
    if (input) input.value = pluginSegment.getAttribute('data-plugin-segment-value') || '';
    group?.querySelectorAll('[data-plugin-segment-value]').forEach(btn => {
      const active = btn === pluginSegment;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return;
  }

  const pairRefresh = t.closest?.('[data-telegram-pair-refresh]');
  if (pairRefresh) {
    await _settingsRefreshTelegramPairing();
    return;
  }

  const pairApprove = t.closest?.('[data-telegram-pair-approve]');
  if (pairApprove) {
    const code = pairApprove.getAttribute('data-telegram-pair-approve') || '';
    if (!code) return;
    pairApprove.disabled = true;
    _settingsTelegramPairingStatus('Approving...', '');
    try {
      const data = await _settingsFetchPairingJson('/api/pairing/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'telegram', code }),
      });
      toast(`Approved Telegram user ${data.id || ''}`.trim());
      await _settingsRefreshTelegramPairing();
      _settingsTelegramPairingStatus('Approved.', 'ok');
    } catch (err) {
      const msg = err?.message || 'Approval failed';
      _settingsTelegramPairingStatus(msg, 'err');
      toast(msg, true);
    } finally {
      pairApprove.disabled = false;
    }
    return;
  }

  const pairRevoke = t.closest?.('[data-telegram-pair-revoke]');
  if (pairRevoke) {
    const id = pairRevoke.getAttribute('data-telegram-pair-revoke') || '';
    if (!id) return;
    if (!confirm(`Revoke Telegram user "${id}"?`)) return;
    pairRevoke.disabled = true;
    _settingsTelegramPairingStatus('Revoking...', '');
    try {
      const data = await _settingsFetchPairingJson('/api/pairing/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'telegram', id }),
      });
      if (!data.ok) throw new Error('Revoke failed');
      toast(`Revoked Telegram user ${id}`);
      await _settingsRefreshTelegramPairing();
      _settingsTelegramPairingStatus('Revoked.', 'ok');
    } catch (err) {
      const msg = err?.message || 'Revoke failed';
      _settingsTelegramPairingStatus(msg, 'err');
      toast(msg, true);
    } finally {
      pairRevoke.disabled = false;
    }
    return;
  }

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
  list.innerHTML = '<div class="settings-note settings-muted-soft">Loading…</div>';
  try {
    const r = await fetch(API + '/api/webapp/users', { headers: authHeaders() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    const users = (d.users || []).slice().sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    if (!users.length) { list.innerHTML = '<div class="settings-note settings-muted-soft">No users yet.</div>'; return; }
    const me = _currentUserName;
    list.innerHTML = users.map(u => {
      const isSelf = u.username === me;
      const tag = u.selfRegistered ? '<span class="su-tag">self-registered</span>' : '';
      const roleSel = isSelf
        ? `<span class="su-role">${u.role}</span>`
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
    list.innerHTML = `<div class="settings-note settings-status-danger">${esc(e.message || e)}</div>`;
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

  // Source #1: the model library (curated, vendor-augmented).
  // Source #2: _settingsKnownLimits — populated by the "Populate
  //   models" probe; legacy fallback for models the operator hasn't
  //   added to their library yet.
  const seen = new Set();
  const entries = [];
  const lib = (window.ModelLibrary && window.ModelLibrary.load && window.ModelLibrary._cache) || null;
  // Pull from cache only — the library module owns its own load
  // lifecycle. populateSettingsPanel ensures the cache is warm before
  // tier rows render.
  const libCache = (window.ModelLibrary && typeof window.ModelLibrary.populateTierDatalist === 'function')
    ? (window.ModelLibrary.__cache || []) : (lib || []);
  // Prefer the public accessor if it's wired (set below by populateSettingsPanel).
  const libEntries = window.ModelLibrary?.__cache || [];
  for (const e of libEntries) {
    if (e?.enabled === false) continue;
    if (provider && e.provider !== provider) continue;
    if (seen.has(e.modelId)) continue;
    seen.add(e.modelId);
    entries.push({ id: e.modelId, ctx: e.contextWindow || 0, fromLibrary: true });
  }
  for (const k of Object.keys(_settingsKnownLimits)) {
    const slash = k.indexOf('/');
    const pref = slash >= 0 ? k.slice(0, slash) : 'anthropic';
    const id = slash >= 0 ? k.slice(slash + 1) : k;
    if (pref !== provider) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const ctx = _settingsKnownLimits[k]?.contextLength;
    entries.push({ id, ctx: ctx || 0, fromLibrary: false });
  }
  // Library entries first (curated > probed), then by ctx desc.
  entries.sort((a, b) => {
    if (a.fromLibrary !== b.fromLibrary) return a.fromLibrary ? -1 : 1;
    return (b.ctx - a.ctx) || a.id.localeCompare(b.id);
  });
  dl.innerHTML = entries.map(e =>
    `<option value="${_settingsEscapeHtml(e.id)}" label="${e.ctx ? e.ctx.toLocaleString() + ' ctx' : ''}${e.fromLibrary ? ' · library' : ''}"></option>`
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
      body: JSON.stringify({ kind: 'custom', name: p.name, baseUrl: p.url, apiKey: p.key, authHeader: p.authHeader }),
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

// Walk every dynamically-rendered provider card and collect its typed
// values. Returns a body.providers payload of shape:
//   { custom: [...], <name>: { <fieldKey>: <value>, ... }, ... }
// AND stashes per-plugin slot payloads on the function so
// _mergeProviderPluginPayload can fold them into body.plugins below.
//
// Empty secret fields are skipped (their stored value is preserved).
// Empty non-secret fields are also skipped — the server's
// assignProviderField treats blank as a no-op to prevent stale form
// values from clobbering persisted ones (see web.js:1132 for the
// historical regression that produced this behavior).
let _settingsLastProviderPluginExtras = {};
function _collectProvidersPayload() {
  const providers = { custom: collectSettingsCustomProviders() };
  const pluginExtras = {};
  document.querySelectorAll('[data-provider-form]').forEach(wrap => {
    const name = wrap.getAttribute('data-provider-form');
    const pluginId = wrap.getAttribute('data-provider-plugin-id') || '';
    if (!name) return;
    // 'custom' is reserved for the user-defined custom providers array
    // (collectSettingsCustomProviders → providers.custom = [...]). If
    // a plugin happens to register a provider named 'custom' (the
    // local-oai-provider does, conditionally), don't overwrite the
    // array shape — its config is collected the legacy way via the
    // custom-providers UI grid.
    if (name === 'custom') return;
    const values = {};
    let any = false;
    wrap.querySelectorAll('[data-provider-field]').forEach(input => {
      const key = input.getAttribute('data-provider-field');
      if (!key) return;
      const isSecret = input.getAttribute('data-provider-secret') === '1';
      const v = (input.value || '').trim();
      if (v === '') return;
      // Skip stored-secret placeholder if any plugin/UI ever sets it
      if (isSecret && v === '••• stored — leave blank to keep') return;
      values[key] = v;
      any = true;
    });
    if (any) {
      providers[name] = values;
      if (pluginId) pluginExtras[pluginId] = { ...(pluginExtras[pluginId] || {}), ...values };
    }
  });
  _settingsLastProviderPluginExtras = pluginExtras;
  return providers;
}
function _mergeProviderPluginPayload(pluginPayload) {
  const out = { ...(pluginPayload || {}) };
  for (const [pluginId, values] of Object.entries(_settingsLastProviderPluginExtras || {})) {
    out[pluginId] = { ...(out[pluginId] || {}), ...values };
  }
  // Reset for next save so a stale call doesn't double-fold.
  _settingsLastProviderPluginExtras = {};
  return out;
}

const SETTINGS_HOST_PROVIDER_FIELDS = {
  anthropic: new Set(['apiKey']),
  openai: new Set(['apiKey', 'baseUrl']),
  openrouter: new Set(['apiKey', 'baseUrl', 'referer']),
  local: new Set(['apiKey', 'baseUrl', 'authHeader']),
  gemini: new Set(['apiKey']),
};

function _settingsInputValue(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function _settingsPositiveIntOrNull(id) {
  const raw = _settingsInputValue(id);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SETTINGS_RUNTIME_QUEUE_LANES = ['interactive', 'channel', 'deferred', 'learner', 'maintenance', 'background'];
const SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES = {
  interactive: 2,
  channel: 1,
  deferred: 1,
  learner: 1,
  maintenance: 1,
  background: 1,
};
const SETTINGS_RUNTIME_QUEUE_LANE_HELP = {
  interactive: 'Live web and CLI agent turns. Keep this high enough that direct user sessions do not feel blocked.',
  channel: 'Inbound chat gateways and voice turns, including Telegram, Slack, Discord, and STT-driven messages.',
  deferred: 'Scheduled or resumable user work such as wakeups, delayed tasks, and channel follow-up sends.',
  learner: 'After-turn learning jobs that distill sessions into memory and update graph summaries.',
  maintenance: 'Operational upkeep: graph maintenance, janitor runs, backups, and manual maintenance actions.',
  background: 'Low-priority enrichment jobs such as General KB research, channel distillation, and graph side work.',
};
const SETTINGS_LEARNER_PLATFORMS = ['web', 'cli', 'telegram', 'slack', 'discord', 'chatroom', 'api', 'unknown'];
const SETTINGS_LEARNER_PLATFORM_LABELS = {
  web: 'Web',
  cli: 'Spore Code',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  chatroom: 'Chatroom',
  api: 'API',
  unknown: 'Unknown',
};

function _settingsCheckboxIfPresent(id) {
  const el = document.getElementById(id);
  return el ? !!el.checked : undefined;
}

function _settingsPositiveNumberIfPresent(id, fallback, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  const raw = (el.value || '').trim();
  const parsed = raw ? Number(raw) : Number(fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return opts.integer ? Math.floor(parsed) : parsed;
}

function _settingsPatchIfPresent(patch, key, value) {
  if (value !== undefined) patch[key] = value;
}

function _settingsRuntimeLaneLimitsPayload() {
  if (!document.getElementById('settings-runtime-lane-interactive')) return undefined;
  const out = {};
  for (const lane of SETTINGS_RUNTIME_QUEUE_LANES) {
    out[lane] = _settingsPositiveNumberIfPresent(`settings-runtime-lane-${lane}`, SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES[lane] || 1, { integer: true }) || SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES[lane] || 1;
  }
  return out;
}

function _settingsLearnerModeValue(data) {
  const learningMode = _settingsCanonicalValue(data, 'learningMode', 'always');
  if (learningMode === 'disabled' || learningMode === 'flush_only') return learningMode;
  const activation = _settingsCanonicalValue(data, 'learnerActivationMode', 'every_turn');
  return activation === 'idle_batch' ? 'idle_batch' : 'every_turn';
}

function _settingsApplyLearnerModeAvailability() {
  const mode = document.getElementById('settings-learner-activation-mode')?.value || 'every_turn';
  const disabled = mode === 'disabled' || mode === 'flush_only';
  const idle = mode === 'idle_batch';
  for (const id of [
    'settings-learner-idle-delay',
    'settings-learner-batch-min',
    'settings-learner-batch-max',
  ]) {
    const el = document.getElementById(id);
    if (el) el.disabled = !idle;
  }
  const minChars = document.getElementById('settings-learner-min-chars');
  if (minChars) minChars.disabled = disabled;
  for (const platform of SETTINGS_LEARNER_PLATFORMS) {
    const el = document.getElementById(`settings-learner-platform-${platform}`);
    if (el) el.disabled = disabled;
  }
}

function _settingsLearnerPlatformsPayload() {
  if (!document.getElementById('settings-learner-platform-web')) return undefined;
  return SETTINGS_LEARNER_PLATFORMS.filter(platform =>
    !!document.getElementById(`settings-learner-platform-${platform}`)?.checked
  );
}

function _settingsLearnerModePatch(patch) {
  const select = document.getElementById('settings-learner-activation-mode');
  if (!select) return;
  const mode = select.value || 'every_turn';
  if (mode === 'disabled') {
    patch.learningMode = 'disabled';
    patch.learnerActivationMode = 'every_turn';
  } else if (mode === 'flush_only') {
    patch.learningMode = 'flush_only';
    patch.learnerActivationMode = 'every_turn';
  } else if (mode === 'idle_batch') {
    patch.learningMode = 'always';
    patch.learnerActivationMode = 'idle_batch';
  } else {
    patch.learningMode = 'always';
    patch.learnerActivationMode = 'every_turn';
  }
}

function _settingsEnsureGraphRuntimeStyles() {
  // Runtime settings styles live in settings.css; kept as a compatibility
  // shim for older call sites that still ensure before mounting controls.
}

function _settingsEnsureGraphRuntimeControls() {
  if (document.getElementById('settings-graph-runtime-controls')) return;
  const section = document.getElementById('settings-maintainer-run')?.closest('.settings-section');
  if (!section) return;
  _settingsEnsureGraphRuntimeStyles();
  const wrap = document.createElement('div');
  wrap.id = 'settings-graph-runtime-controls';
  wrap.innerHTML = `
    <div class="settings-runtime-card">
      <div class="settings-runtime-card-head">
        <div class="settings-runtime-card-title">Graph maintenance</div>
        <label class="settings-check" for="settings-graph-maintenance-enabled">
          <input id="settings-graph-maintenance-enabled" type="checkbox">
          <span>enabled</span>
        </label>
      </div>
      <div class="settings-runtime-grid">
        <div>
          <label for="settings-graph-maintenance-interval">Interval minutes</label>
          <input id="settings-graph-maintenance-interval" type="number" min="1" step="1" placeholder="120">
        </div>
        <div>
          <label for="settings-graph-maintenance-batch">Batch size</label>
          <input id="settings-graph-maintenance-batch" type="number" min="1" step="1" placeholder="4">
        </div>
      </div>
      <div class="settings-runtime-note">Runs per-graph upkeep through the central queue: gap filling, sparse-node connection, dedup, reasoning, clustering, and embeddings.</div>
    </div>
    <div class="settings-runtime-card">
      <div class="settings-runtime-card-head">
        <div class="settings-runtime-card-title">General KB research</div>
        <label class="settings-check" for="settings-general-kb-research-enabled">
          <input id="settings-general-kb-research-enabled" type="checkbox">
          <span>scheduled</span>
        </label>
      </div>
      <div class="settings-runtime-grid">
        <div>
          <label for="settings-general-kb-research-interval">Interval hours</label>
          <input id="settings-general-kb-research-interval" type="number" min="0.25" step="0.25" placeholder="24">
        </div>
        <div>
          <label for="settings-general-kb-research-batch">Nodes per run</label>
          <input id="settings-general-kb-research-batch" type="number" min="1" step="1" placeholder="1">
        </div>
      </div>
      <div class="settings-runtime-note">Scheduled runs are independent from graph maintenance and only target the General Knowledge Base graph. Use the General Knowledge Base row's research action for an immediate manual run.</div>
    </div>
  `;
  const janitorRow = document.getElementById('settings-janitor-run')?.closest('div');
  if (janitorRow && janitorRow.parentElement === section) section.insertBefore(wrap, janitorRow);
  else section.appendChild(wrap);
}

function _settingsEnsureLearnerActivationControls() {
  if (document.getElementById('settings-learner-activation-controls')) return;
  const anchor = document.getElementById('settings-enhanced-recall')?.closest('.settings-section');
  if (!anchor) return;
  _settingsEnsureGraphRuntimeStyles();
  const section = document.createElement('div');
  section.className = 'settings-section wide';
  section.id = 'settings-learner-activation-section';
  section.setAttribute('data-target-tab', 'graph-memory');
  section.innerHTML = `
    <h4>Learner activation</h4>
    <div class="settings-note">Controls when conversation turns become learner jobs. Compaction and manual session distill can still run when after-turn learning is paused.</div>
    <div id="settings-learner-activation-controls">
      <div class="settings-runtime-card">
        <div class="settings-runtime-card-head">
          <div>
            <div class="settings-runtime-card-title">After-turn learner</div>
            <span class="settings-runtime-status">Applies to web, Spore Code, channels, and API sessions.</span>
          </div>
          <select id="settings-learner-activation-mode" aria-label="Learner activation mode">
            <option value="every_turn">Every turn</option>
            <option value="idle_batch">Idle/batched</option>
            <option value="flush_only">Compaction/manual only</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <div class="settings-runtime-grid">
          <div>
            <label for="settings-learner-idle-delay">Idle delay seconds</label>
            <input id="settings-learner-idle-delay" type="number" min="1" step="1" placeholder="45">
          </div>
          <div>
            <label for="settings-learner-batch-min">Minimum turns</label>
            <input id="settings-learner-batch-min" type="number" min="1" step="1" placeholder="1">
          </div>
          <div>
            <label for="settings-learner-batch-max">Maximum turns</label>
            <input id="settings-learner-batch-max" type="number" min="1" step="1" placeholder="6">
          </div>
          <div>
            <label for="settings-learner-min-chars">Minimum exchange chars</label>
            <input id="settings-learner-min-chars" type="number" min="1" step="1" placeholder="20">
          </div>
        </div>
        <div class="settings-learner-platforms">
          ${SETTINGS_LEARNER_PLATFORMS.map(platform => `
            <label class="settings-check" for="settings-learner-platform-${platform}">
              <input id="settings-learner-platform-${platform}" type="checkbox">
              <span>${SETTINGS_LEARNER_PLATFORM_LABELS[platform] || platform}</span>
            </label>
          `).join('')}
        </div>
        <div class="settings-runtime-note">Idle batches are isolated by graph, platform, and session so one user's channel context cannot merge into another user's CLI or web graph.</div>
      </div>
    </div>
  `;
  anchor.insertAdjacentElement('afterend', section);
  const select = section.querySelector('#settings-learner-activation-mode');
  select?.addEventListener('change', _settingsApplyLearnerModeAvailability);
}

function _settingsEnsureCoreRuntimeControls() {
  _settingsEnsureGraphRuntimeStyles();
  let wrap = document.getElementById('settings-core-runtime-controls');
  if (!wrap) {
    const runtimeSection = document.getElementById('settings-runtime-public-url-input')?.closest('.settings-section');
    if (!runtimeSection) return;
    const section = document.createElement('div');
    section.className = 'settings-section wide';
    section.id = 'settings-runtime-queue-section';
    section.setAttribute('data-target-tab', 'advanced');
    section.innerHTML = `
      <h4>Runtime job queue</h4>
      <div class="settings-note">Central scheduler for web, CLI, channels, learner, wakeups, backups, and maintenance work. Lane limits and enable/disable changes apply after server restart.</div>
      <div id="settings-core-runtime-controls"></div>
    `;
    runtimeSection.insertAdjacentElement('afterend', section);
    wrap = section.querySelector('#settings-core-runtime-controls');
  }
  if (!wrap || wrap.dataset.mounted === '1') return;
  wrap.dataset.mounted = '1';
  wrap.innerHTML = `
    <div class="settings-runtime-card">
      <div class="settings-runtime-card-head">
        <div>
          <div class="settings-runtime-card-title">Lane limits</div>
          <span id="settings-runtime-queue-status" class="settings-runtime-status">status not loaded</span>
        </div>
        <label class="settings-check" for="settings-runtime-queue-enabled">
          <input id="settings-runtime-queue-enabled" type="checkbox">
          <span>enabled</span>
        </label>
      </div>
      <div class="settings-runtime-grid">
        ${SETTINGS_RUNTIME_QUEUE_LANES.map(lane => `
          <div class="settings-runtime-lane-control">
            <label for="settings-runtime-lane-${lane}">${lane}</label>
            <input id="settings-runtime-lane-${lane}" type="number" min="1" step="1" placeholder="${SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES[lane] || 1}">
            <div class="settings-runtime-lane-hint">${SETTINGS_RUNTIME_QUEUE_LANE_HELP[lane] || ''}</div>
          </div>
        `).join('')}
      </div>
      <div class="settings-runtime-note">Coordinates web, CLI, channel, learner, wakeup, and maintenance work. Enable/disable, lane limits, and timer cadence apply after server restart.</div>
    </div>
  `;
}

function _settingsCanonicalValue(data, key, fallback) {
  if (data?.values && Object.prototype.hasOwnProperty.call(data.values, key)) return data.values[key];
  return fallback;
}

function _settingsNumberValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _settingsJsonObjectValue(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return fallback;
}

function _settingsSetRuntimeInput(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function _settingsSetRuntimeChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
}

function _populateGraphRuntimeSettings(data) {
  _settingsEnsureGraphRuntimeControls();
  _settingsEnsureLearnerActivationControls();
  _settingsEnsureCoreRuntimeControls();
  _settingsSetRuntimeChecked('settings-graph-maintenance-enabled',
    _settingsCanonicalValue(data, 'graphMaintenanceEnabled', true));
  _settingsSetRuntimeInput('settings-graph-maintenance-interval',
    _settingsNumberValue(_settingsCanonicalValue(data, 'graphMaintenanceIntervalMinutes', 120), 120));
  _settingsSetRuntimeInput('settings-graph-maintenance-batch',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'graphMaintenanceBatchSize', 4), 4)));

  _settingsSetRuntimeChecked('settings-general-kb-research-enabled',
    _settingsCanonicalValue(data, 'generalKbResearchEnabled', true));
  _settingsSetRuntimeInput('settings-general-kb-research-interval',
    _settingsNumberValue(_settingsCanonicalValue(data, 'generalKbResearchIntervalHours', 24), 24));
  _settingsSetRuntimeInput('settings-general-kb-research-batch',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'generalKbResearchBatchSize', 1), 1)));

  _settingsSetRuntimeChecked('settings-runtime-queue-enabled',
    _settingsCanonicalValue(data, 'runtimeQueueEnabled', true));
  const lanes = {
    ...SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES,
    ..._settingsJsonObjectValue(_settingsCanonicalValue(data, 'runtimeQueueLaneLimits', SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES), {}),
  };
  for (const lane of SETTINGS_RUNTIME_QUEUE_LANES) {
    _settingsSetRuntimeInput(`settings-runtime-lane-${lane}`, Math.floor(_settingsNumberValue(lanes[lane], SETTINGS_RUNTIME_QUEUE_DEFAULT_LANES[lane] || 1)));
  }
  const learnerMode = document.getElementById('settings-learner-activation-mode');
  if (learnerMode) learnerMode.value = _settingsLearnerModeValue(data);
  _settingsSetRuntimeInput('settings-learner-idle-delay',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'learnerIdleDelaySeconds', 45), 45)));
  _settingsSetRuntimeInput('settings-learner-batch-min',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'learnerBatchMinTurns', 1), 1)));
  _settingsSetRuntimeInput('settings-learner-batch-max',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'learnerBatchMaxTurns', 6), 6)));
  _settingsSetRuntimeInput('settings-learner-min-chars',
    Math.floor(_settingsNumberValue(_settingsCanonicalValue(data, 'learnerMinExchangeChars', 20), 20)));
  const enabledPlatforms = new Set((_settingsCanonicalValue(data, 'learnerEnabledPlatforms', SETTINGS_LEARNER_PLATFORMS) || SETTINGS_LEARNER_PLATFORMS)
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean));
  for (const platform of SETTINGS_LEARNER_PLATFORMS) {
    _settingsSetRuntimeChecked(`settings-learner-platform-${platform}`, enabledPlatforms.has(platform));
  }
  _settingsApplyLearnerModeAvailability();
  _runtimeQueueRefreshStatus();
}

async function _runtimeQueueRefreshStatus() {
  const el = document.getElementById('settings-runtime-queue-status');
  if (!el) return;
  el.textContent = 'loading status...';
  try {
    const r = await fetch(API + '/api/queue/status', { headers: authHeaders() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    const persistent = data.persistent || {};
    const queued = Number(data.memoryPending || 0) + Number(persistent.queued || 0);
    const running = Number(data.running || 0);
    const failed = Number(persistent.failed || 0);
    const stopped = data.stopped ? 'stopped' : 'active';
    const lanes = Object.entries(data.lanes || {})
      .map(([name, info]) => `${name} ${info.running || 0}/${info.limit || 0}`)
      .join(' · ');
    el.textContent = `${stopped} · ${running} running · ${queued} queued${failed ? ` · ${failed} failed` : ''}${lanes ? ` · ${lanes}` : ''}`;
  } catch (e) {
    el.textContent = `status unavailable: ${e?.message || e}`;
  }
}

function _settingsBlankToNull(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : null;
}

function _settingsComposeModelRef(provider, model) {
  const p = String(provider || 'anthropic').trim().toLowerCase() || 'anthropic';
  const m = String(model || '').trim();
  if (!m) return null;
  return p === 'anthropic' ? m : `${p}/${m}`;
}

function _addPluginPatchEntries(patch, pluginPayload) {
  for (const [pluginId, values] of Object.entries(pluginPayload || {})) {
    if (!values || typeof values !== 'object') continue;
    for (const [field, value] of Object.entries(values)) {
      patch[`plugins.${pluginId}.${field}`] = value;
    }
  }
}

function _buildSettingsPatchPayload(modelLimits, models) {
  const patch = {
    displayName: _settingsInputValue('settings-display-name'),
    nicknames: _settingsInputValue('settings-nicknames').split(',').map(s => s.trim()).filter(Boolean),
    enhancedRecall: !!document.getElementById('settings-enhanced-recall')?.checked,
    modelLimits,
    browserBackend: document.getElementById('settings-browser-backend')?.value || 'zendriver',
    publicUrl: _settingsBlankToNull(_settingsInputValue('settings-runtime-public-url-input')),
    'providers.custom': typeof collectSettingsCustomProviders === 'function'
      ? collectSettingsCustomProviders({ preserveStoredKey: true })
      : [],
    'webSearch.searxngUrl': _settingsBlankToNull(_settingsInputValue('settings-websearch-searxng-url')),
  };

  _settingsPatchIfPresent(patch, 'graphMaintenanceEnabled',
    _settingsCheckboxIfPresent('settings-graph-maintenance-enabled'));
  _settingsPatchIfPresent(patch, 'graphMaintenanceIntervalMinutes',
    _settingsPositiveNumberIfPresent('settings-graph-maintenance-interval', 120, { integer: true }));
  _settingsPatchIfPresent(patch, 'graphMaintenanceBatchSize',
    _settingsPositiveNumberIfPresent('settings-graph-maintenance-batch', 4, { integer: true }));
  _settingsPatchIfPresent(patch, 'generalKbResearchEnabled',
    _settingsCheckboxIfPresent('settings-general-kb-research-enabled'));
  _settingsPatchIfPresent(patch, 'generalKbResearchIntervalHours',
    _settingsPositiveNumberIfPresent('settings-general-kb-research-interval', 24));
  _settingsPatchIfPresent(patch, 'generalKbResearchBatchSize',
    _settingsPositiveNumberIfPresent('settings-general-kb-research-batch', 1, { integer: true }));
  _settingsPatchIfPresent(patch, 'runtimeQueueEnabled',
    _settingsCheckboxIfPresent('settings-runtime-queue-enabled'));
  _settingsPatchIfPresent(patch, 'runtimeQueueLaneLimits',
    _settingsRuntimeLaneLimitsPayload());
  _settingsPatchIfPresent(patch, 'nodePerformanceMetricViz',
    _settingsCheckboxIfPresent('settings-node-performance-metric-viz'));
  _settingsLearnerModePatch(patch);
  _settingsPatchIfPresent(patch, 'learnerIdleDelaySeconds',
    _settingsPositiveNumberIfPresent('settings-learner-idle-delay', 45, { integer: true }));
  _settingsPatchIfPresent(patch, 'learnerBatchMinTurns',
    _settingsPositiveNumberIfPresent('settings-learner-batch-min', 1, { integer: true }));
  _settingsPatchIfPresent(patch, 'learnerBatchMaxTurns',
    _settingsPositiveNumberIfPresent('settings-learner-batch-max', 6, { integer: true }));
  _settingsPatchIfPresent(patch, 'learnerMinExchangeChars',
    _settingsPositiveNumberIfPresent('settings-learner-min-chars', 20, { integer: true }));
  _settingsPatchIfPresent(patch, 'learnerEnabledPlatforms',
    _settingsLearnerPlatformsPayload());

  for (const [tier, value] of Object.entries(models || {})) {
    patch[`models.${tier}`] = _settingsComposeModelRef(value.provider, value.model);
  }

  const proactiveChannels = _settingsInputValue('settings-proactive-channels').split(',').map(s => s.trim()).filter(Boolean);
  patch['proactive.enabled'] = !!document.getElementById('settings-proactive-enabled')?.checked;
  patch['proactive.cooldownMinutes'] = parseInt(_settingsInputValue('settings-proactive-cooldown'), 10) || 60;
  patch['proactive.maxPerDay'] = parseInt(_settingsInputValue('settings-proactive-max-day'), 10) || 5;
  patch['proactive.channels'] = proactiveChannels;

  patch['voice.enabled'] = !!document.getElementById('settings-voice-enabled')?.checked;
  patch['voice.sttProvider'] = _settingsBlankToNull(_settingsInputValue('settings-stt-provider'));
  patch['voice.ttsProvider'] = _settingsBlankToNull(_settingsInputValue('settings-tts-provider'));
  patch['voice.ttsVoice'] = _settingsBlankToNull(_settingsInputValue('settings-tts-voice'));
  patch['voice.edgeVoice'] = _settingsBlankToNull(_settingsInputValue('settings-edge-voice'));
  patch['voice.ttsModel'] = _settingsBlankToNull(_settingsInputValue('settings-tts-model'));

  const pluginPayload = _collectPluginSettingsPayload();
  document.querySelectorAll('[data-provider-form]').forEach(wrap => {
    const name = wrap.getAttribute('data-provider-form');
    const pluginId = wrap.getAttribute('data-provider-plugin-id') || '';
    if (!name || name === 'custom') return;
    const hostFields = SETTINGS_HOST_PROVIDER_FIELDS[name] || new Set();
    wrap.querySelectorAll('[data-provider-field]').forEach(input => {
      const field = input.getAttribute('data-provider-field');
      if (!field) return;
      const isSecret = input.getAttribute('data-provider-secret') === '1';
      const raw = (input.value || '').trim();
      if (isSecret && !raw) return;
      const value = raw ? raw : null;
      if (hostFields.has(field)) patch[`providers.${name}.${field}`] = value;
      if (pluginId) {
        if (!pluginPayload[pluginId]) pluginPayload[pluginId] = {};
        pluginPayload[pluginId][field] = value;
      }
    });
  });
  _addPluginPatchEntries(patch, pluginPayload);

  const sectionBudgets = {};
  document.querySelectorAll('#settings-budget-sections-grid input[data-budget-section]').forEach(el => {
    const key = el.getAttribute('data-budget-section');
    const raw = (el.value || '').trim();
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) sectionBudgets[key] = n;
  });
  const runtimeBudget = _settingsPositiveIntOrNull('settings-budget-runtime');
  if (runtimeBudget) sectionBudgets.runtime = runtimeBudget;
  patch.sectionBudgets = sectionBudgets;
  patch.totalPromptBudget = _settingsPositiveIntOrNull('settings-budget-total');

  patch.agentEffort = _collectAgentEffortPayload();
  const agentBudgets = _collectAgentBudgetsPayload();
  for (const [key, value] of Object.entries(agentBudgets)) patch[key] = value;

  const searxngKey = _settingsInputValue('settings-websearch-searxng-key');
  const braveKey = _settingsInputValue('settings-websearch-brave-key');
  if (searxngKey) patch['webSearch.searxngApiKey'] = searxngKey;
  if (braveKey) patch['webSearch.braveApiKey'] = braveKey;

  const actions = {};
  const inviteValue = _settingsInputValue('settings-invite-key');
  if (_pendingInviteRegenerate) actions.regenerateInviteKey = true;
  else if (_pendingInviteClear) patch.inviteKey = null;
  else if (inviteValue) patch.inviteKey = inviteValue;

  return { patch, actions };
}

// Live model-list refresh — lets the operator paste an API key into a
// provider input and watch the per-tier datalists populate without
// having to hit Save first. Walks every dynamically-rendered provider
// card (data-provider-form) and binds a debounced 'input' handler to
// each apiKey + baseUrl field. Generic — adding a new provider plugin
// gets the live probe automatically with no UI patching here.
const _settingsProviderProbeTimers = new WeakMap();
function _settingsProviderFormValues(wrap) {
  const values = {};
  wrap.querySelectorAll('[data-provider-field]').forEach(input => {
    const key = input.getAttribute('data-provider-field');
    if (!key) return;
    values[key] = (input.value || '').trim();
  });
  return values;
}
function _settingsProviderProbeHash(kind, values) {
  return [kind, values.apiKey || '', values.baseUrl || '', values.authHeader || '', values.referer || ''].join('|');
}
function _settingsProviderReadyForProbe(wrap, values) {
  if (wrap.getAttribute('data-provider-configured') === '1') return true;
  const hasSecret = !!wrap.querySelector('[data-provider-secret="1"]');
  if (hasSecret && !Object.values(values).some(v => String(v || '').trim())) return false;
  if (values.apiKey) return true;
  return Object.entries(values)
    .some(([key, value]) => !['authHeader', 'referer'].includes(key) && !!String(value || '').trim());
}
function _settingsLiveProbeOneProvider(kind, values = {}, resultEl = null, opts = {}) {
  const body = (values && typeof values === 'object')
    ? { kind, ...values }
    : { kind, apiKey: values || '', baseUrl: arguments[2] || '' };
  return fetch(API + '/api/providers/list-models', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(r => r.json()).then(d => {
    if (!d?.ok) {
      if (resultEl) {
        resultEl.className = 'settings-test-result err';
        resultEl.textContent = String(d?.error || 'probe failed').slice(0, 120);
      }
      return false;
    }
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
    if (resultEl) {
      const n = (d.models || []).length;
      resultEl.className = 'settings-test-result ok';
      resultEl.textContent = `${opts.auto ? 'auto ' : ''}✓ ${n} model${n === 1 ? '' : 's'} loaded`;
    }
    return true;
  }).catch(e => {
    if (resultEl) {
      resultEl.className = 'settings-test-result err';
      resultEl.textContent = String(e?.message || e).slice(0, 120);
    }
    return false;
  });
}

function _bindSettingsProviderLiveProbe() {
  document.querySelectorAll('[data-provider-form]').forEach(wrap => {
    const kind = wrap.getAttribute('data-provider-form');
    if (!kind) return;
    if (wrap.dataset.liveProbeBound === '1') return;
    wrap.dataset.liveProbeBound = '1';
    const resultEl = document.querySelector(`[data-provider-result="${kind}"]`);
    const fire = (delay = 900) => {
      const values = _settingsProviderFormValues(wrap);
      if (!_settingsProviderReadyForProbe(wrap, values)) return;
      const hash = _settingsProviderProbeHash(kind, values);
      if (wrap.dataset.liveProbeHash === hash) return;
      const existing = _settingsProviderProbeTimers.get(wrap);
      if (existing) clearTimeout(existing);
      if (resultEl) { resultEl.className = 'settings-test-result'; resultEl.textContent = 'auto-probing…'; }
      const timer = setTimeout(async () => {
        const latest = _settingsProviderFormValues(wrap);
        if (_settingsProviderProbeHash(kind, latest) !== hash) return;
        const ok = await _settingsLiveProbeOneProvider(kind, latest, resultEl, { auto: true });
        if (ok) wrap.dataset.liveProbeHash = hash;
      }, delay);
      _settingsProviderProbeTimers.set(wrap, timer);
    };
    wrap.querySelectorAll('[data-provider-field]').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, () => fire());
    });
    fire(1200);
  });
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
  { id: 'providers',    label: 'Models',        forAll: false },
  { id: 'agent',        label: 'Agent',         forAll: false },
  { id: 'graph-memory', label: 'Graph & Memory', forAll: false },
  { id: 'backups',      label: 'Backups & Portability', forAll: false },
  { id: 'tools',        label: 'Tools & Search', forAll: false },
  { id: 'channels',     label: 'Channels',      forAll: false },
  { id: 'plugins',      label: 'Plugins',       forAll: false },
  { id: 'users',        label: 'Users',         forAll: false },
  // Keep the stable tab id for saved preferences, but show the product-facing
  // name now that this pane owns host/runtime controls.
  { id: 'advanced',     label: 'Spore Core',    forAll: false },
];
const _SETTINGS_TAB_REFRESHERS = {
  'graph-memory': () => {
    try { if (typeof _maintRefreshStatus === 'function') _maintRefreshStatus(); } catch {}
    try { if (typeof _janRefreshStatus === 'function') _janRefreshStatus(); } catch {}
    try { if (typeof _janLoadBin === 'function') _janLoadBin(); } catch {}
  },
  'advanced': () => {
    try { if (typeof _runtimeQueueRefreshStatus === 'function') _runtimeQueueRefreshStatus(); } catch {}
  },
  'backups': () => {
    try { if (typeof _bkLoadStatus === 'function') _bkLoadStatus(); } catch {}
    try { if (typeof _bkLoadList === 'function') _bkLoadList(); } catch {}
  },
  'channels': () => {
    try { _settingsRefreshTelegramPairing(); } catch {}
  },
  // Tailscale + compute-cluster live in their plugins now (Plugins
  // tab). No 'cluster' refresher needed.
};

let _settingsSearchBound = false;
let _settingsSearchObserver = null;
let _settingsSearchRaf = null;

function _settingsSearchNormalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function _settingsSearchExpandText(value) {
  const raw = String(value || '');
  const camelSplit = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const dePunctuated = raw.replace(/[^a-zA-Z0-9]+/g, ' ');
  return _settingsSearchNormalize(`${raw} ${camelSplit} ${dePunctuated}`);
}

function _settingsSearchCompact(value) {
  return _settingsSearchNormalize(value).replace(/[^a-z0-9]+/g, '');
}

function _settingsSearchTokenMatches(text, token) {
  if (!token) return true;
  if (text.includes(token)) return true;
  const compactToken = _settingsSearchCompact(token);
  if (!compactToken) return true;
  const compactText = _settingsSearchCompact(text);
  if (compactText.includes(compactToken)) return true;
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => word.startsWith(compactToken) || word.includes(compactToken))) return true;
  return false;
}

function _settingsSearchTabLabel(tabId) {
  return SETTINGS_TABS.find(t => t.id === tabId)?.label || tabId || '';
}

function _settingsSearchSectionText(section) {
  const pane = section.closest('.settings-tab-pane');
  const tabId = pane?.getAttribute('data-tab') || section.getAttribute('data-target-tab') || '';
  const pieces = [
    _settingsSearchTabLabel(tabId),
    section.id,
    section.getAttribute('data-target-tab'),
    section.getAttribute('data-search-terms'),
    section.textContent,
  ];
  section.querySelectorAll('label, input, select, textarea, button, [title], [aria-label], [placeholder]').forEach(el => {
    pieces.push(
      el.id,
      el.name,
      el.getAttribute('for'),
      el.getAttribute('title'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder')
    );
    if (el.tagName === 'SELECT') {
      Array.from(el.options || []).forEach(opt => pieces.push(opt.textContent, opt.value));
    }
  });
  return _settingsSearchExpandText(pieces.filter(Boolean).join(' '));
}

function _settingsSearchBaseHidden(section, allowedTabs) {
  const pane = section.closest('.settings-tab-pane');
  const tabId = pane?.getAttribute('data-tab') || section.getAttribute('data-target-tab') || '';
  if (!allowedTabs.has(tabId)) return true;
  if (section.hidden) return true;
  if (section.style.display === 'none' && !section.classList.contains('settings-search-hidden')) return true;
  let el = section.parentElement;
  while (el && el.id !== 'settings-panes') {
    if (el.hidden || el.style.display === 'none') return true;
    el = el.parentElement;
  }
  return false;
}

function _settingsSearchEmptyEl() {
  const panes = document.getElementById('settings-panes');
  if (!panes) return null;
  let el = document.getElementById('settings-search-empty');
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-search-empty';
    el.className = 'settings-search-empty';
    el.textContent = 'No settings match that search.';
    panes.appendChild(el);
  }
  return el;
}

function _settingsApplySearchFilter() {
  const input = document.getElementById('settings-search');
  const clearBtn = document.getElementById('settings-search-clear');
  const countEl = document.getElementById('settings-search-count');
  const panesWrap = document.getElementById('settings-panes');
  if (!input || !panesWrap) return;

  const tokens = _settingsSearchNormalize(input.value).split(' ').filter(Boolean);
  const active = tokens.length > 0;
  const emptyEl = _settingsSearchEmptyEl();
  const panes = Array.from(panesWrap.querySelectorAll('.settings-tab-pane'));
  const sections = Array.from(panesWrap.querySelectorAll('.settings-section'));
  const allowedTabs = new Set(Array.from(document.querySelectorAll('#settings-tabs .settings-tab'))
    .map(btn => btn.getAttribute('data-tab'))
    .filter(Boolean));

  panesWrap.classList.toggle('settings-search-active', active);
  if (clearBtn) clearBtn.hidden = !active;

  if (!active) {
    panes.forEach(pane => pane.removeAttribute('data-search-visible'));
    sections.forEach(section => section.classList.remove('settings-search-hidden', 'settings-search-match'));
    if (emptyEl) emptyEl.removeAttribute('data-visible');
    if (countEl) countEl.textContent = '';
    return;
  }

  let matches = 0;
  const visiblePanes = new Set();
  for (const section of sections) {
    const pane = section.closest('.settings-tab-pane');
    const tabId = pane?.getAttribute('data-tab') || section.getAttribute('data-target-tab') || '';
    const hidden = _settingsSearchBaseHidden(section, allowedTabs);
    const text = hidden ? '' : _settingsSearchSectionText(section);
    const matched = !hidden && tokens.every(token => _settingsSearchTokenMatches(text, token));
    section.classList.toggle('settings-search-hidden', !matched);
    section.classList.toggle('settings-search-match', matched);
    if (matched) {
      matches++;
      if (tabId) visiblePanes.add(tabId);
    }
  }

  panes.forEach(pane => {
    const tabId = pane.getAttribute('data-tab');
    if (visiblePanes.has(tabId)) pane.setAttribute('data-search-visible', 'true');
    else pane.removeAttribute('data-search-visible');
  });
  if (emptyEl) {
    if (matches) emptyEl.removeAttribute('data-visible');
    else emptyEl.setAttribute('data-visible', 'true');
  }
  if (countEl) countEl.textContent = matches ? `${matches} match${matches === 1 ? '' : 'es'}` : 'No matches';
}

function _settingsClearSearch(opts = {}) {
  const input = document.getElementById('settings-search');
  if (!input) return;
  input.value = '';
  _settingsApplySearchFilter();
  if (opts.focus) input.focus();
}

function _bindSettingsSearch() {
  if (_settingsSearchBound) return;
  _settingsSearchBound = true;
  const input = document.getElementById('settings-search');
  const clearBtn = document.getElementById('settings-search-clear');
  const panes = document.getElementById('settings-panes');
  if (!input || !panes) return;

  input.addEventListener('input', _settingsApplySearchFilter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      _settingsClearSearch({ focus: true });
    }
  });
  clearBtn?.addEventListener('click', () => _settingsClearSearch({ focus: true }));
  if (typeof MutationObserver === 'function' && !_settingsSearchObserver) {
    _settingsSearchObserver = new MutationObserver(() => {
      if (!input.value.trim()) return;
      if (_settingsSearchRaf) cancelAnimationFrame(_settingsSearchRaf);
      _settingsSearchRaf = requestAnimationFrame(() => {
        _settingsSearchRaf = null;
        _settingsApplySearchFilter();
      });
    });
    _settingsSearchObserver.observe(panes, { childList: true, subtree: true, characterData: true });
  }
}

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
  _bindSettingsSearch();
  _settingsApplySearchFilter();
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
    if (document.getElementById('settings-search')?.value) _settingsClearSearch();
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
  _bindSettingsSearch();
  _hidePluginUiIfMissing();
  if (typeof _focusFloatingWindow === 'function') _focusFloatingWindow('settings-pane');
  if (typeof _syncUtilBar === 'function') _syncUtilBar();

  if (!_isCreatorRole()) {
    _reparentSettingsSections();
    _applyRoleGatingToSettings();
    _renderSettingsTabs();
    await _populateProfileSection();
    _settingsSwitchTab('profile');
    setSettingsBusy(false, '');
    return;
  }

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
  _settingsClearSearch();
  overlay?.classList.remove('settings-pane-open', 'window-maximized');
  setSettingsBusy(false, '');
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}

const SETTINGS_GRAPH_GROUPS_KEY = 'spore.settings.graphGroups.v1';

function _settingsReadGraphGroupState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_GRAPH_GROUPS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function _settingsWriteGraphGroupState(key, open) {
  if (!key) return;
  const state = _settingsReadGraphGroupState();
  state[key] = !!open;
  try { localStorage.setItem(SETTINGS_GRAPH_GROUPS_KEY, JSON.stringify(state)); } catch {}
}

function _settingsGraphRole(graph) {
  return String(graph?.role || '').toLowerCase();
}

function _settingsGraphIsViewed(graph) {
  return typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug === graph?.slug && !graph?.active;
}

function _settingsGraphIsManagedMemoryRole(role) {
  return role === 'project' || role === 'user' || role === 'channel' || role === 'general_kb';
}

function _settingsGraphBadgeLabel(graph, inspectOnly) {
  if (!inspectOnly) return '';
  const role = _settingsGraphRole(graph);
  if (role === 'project' || role === 'user' || role === 'channel') return role;
  return 'system';
}

async function renderSettingsGraphsList() {
  const container = document.getElementById('settings-graphs-list');
  if (!container) return;
  container.innerHTML = '<div class="settings-scroll-empty">loading…</div>';
  try {
    const res = await fetch(API + '/api/graphs');
    const data = await res.json();
    const graphs = data.graphs || [];
    if (!graphs.length) {
      container.innerHTML = '<div class="settings-scroll-empty">No graphs yet</div>';
      return;
    }
    const renderGraphRow = (g) => {
      const role = _settingsGraphRole(g);
      const nodes = g.nodeCount != null ? g.nodeCount : '?';
      const backlog = Number(g.embeddingBacklog || 0);
      const maintenanceLabel = g.maintenanceStatus === 'running'
        ? 'maintaining'
        : (g.communityState === 'unclustered'
          ? 'needs clustering'
          : (backlog > 0
            ? `${backlog} embeddings queued`
            : (g.lastMaintainedAt ? `maintained ${new Date(g.lastMaintainedAt).toLocaleDateString()}` : 'not maintained')));
      const maintenanceTone = g.maintenanceStatus === 'error'
        ? 'error'
        : (g.maintenanceStatus === 'running'
          ? 'running'
          : ((g.communityState === 'unclustered' || backlog > 0 || !g.lastMaintainedAt) ? 'stale' : 'ok'));
      const inspectOnly = typeof _isInspectOnlyGraph === 'function'
        ? _isInspectOnlyGraph(g)
        : !!(g.inspectOnly || g.activationLocked || g.managed || g.protected || _settingsGraphIsManagedMemoryRole(role));
      const canManage = g?.canManage !== false && !g?.readOnly && (typeof _isCreatorRole !== 'function' || _isCreatorRole());
      const viewing = _settingsGraphIsViewed(g);
      const canDelete = canManage && !g.active && !g.protected && role !== 'main' && role !== 'general_kb';
      const canReset = canManage && role === 'general_kb';
      const canResearchGeneralKb = canManage && (role === 'general_kb' || g.slug === 'spore-knowledge-base');
      const badgeLabel = _settingsGraphBadgeLabel(g, inspectOnly);
      return `<div class="settings-graph-row${g.active ? ' active' : ''}${viewing ? ' viewing' : ''}${inspectOnly ? ' protected' : ''}" data-slug="${esc(g.slug)}" title="${esc(g.description || g.name)}">
        <div class="sg-main">
          <span class="sg-name">${esc(g.name)}</span>
          <span class="sg-count">${nodes}n${role ? ` · ${esc(role)}` : ''}</span>
          ${g.active ? '<span class="sg-badge">active</span>' : ''}
          ${viewing ? '<span class="sg-badge">viewing</span>' : ''}
          ${badgeLabel ? `<span class="sg-badge">${esc(badgeLabel)}</span>` : ''}
          <span class="sg-maintenance ${maintenanceTone}" title="${esc(g.maintenanceError || maintenanceLabel)}">${esc(maintenanceLabel)}</span>
        </div>
        <div class="sg-actions">
          ${canManage ? `<button type="button" class="sg-action" data-graph-maintain="${esc(g.slug)}">maintain</button>` : ''}
          ${canResearchGeneralKb ? `<button type="button" class="sg-action" data-graph-research-general-kb="${esc(g.slug)}">research</button>` : ''}
          ${canReset ? `<button type="button" class="sg-action" data-graph-reset="${esc(g.slug)}">reset</button>` : ''}
          ${canDelete ? `<button type="button" class="sg-action danger" data-graph-delete="${esc(g.slug)}">delete</button>` : ''}
        </div>
      </div>`;
    };
    const grouped = new Set();
    const groupState = _settingsReadGraphGroupState();
    const groupDefs = [
      { key: 'project', title: 'Project graphs' },
      { key: 'user', title: 'User graphs' },
      { key: 'channel', title: 'Channel graphs' },
    ];
    const renderGroup = (def) => {
      const items = graphs.filter(g => _settingsGraphRole(g) === def.key);
      if (!items.length) return '';
      for (const graph of items) grouped.add(graph.slug);
      const nodeTotal = items.reduce((sum, graph) => sum + Number(graph.nodeCount || 0), 0);
      const hasSelectedGraph = items.some(g => g.active || _settingsGraphIsViewed(g));
      const savedOpen = groupState[def.key];
      const open = hasSelectedGraph || (typeof savedOpen === 'boolean' ? savedOpen : false);
      const graphLabel = items.length === 1 ? 'graph' : 'graphs';
      return `<details class="settings-graph-group" data-graph-group="${esc(def.key)}"${open ? ' open' : ''}>
        <summary class="settings-graph-group-summary">
          <span class="sgg-title">${esc(def.title)}</span>
          <span class="sgg-count">${items.length} ${graphLabel} · ${nodeTotal}n</span>
        </summary>
        <div class="settings-graph-group-rows">${items.map(renderGraphRow).join('')}</div>
      </details>`;
    };
    const groupedRows = groupDefs.map(renderGroup).join('');
    const coreRows = graphs.filter(g => !grouped.has(g.slug)).map(renderGraphRow).join('');
    container.innerHTML = [coreRows, groupedRows].filter(Boolean).join('');
    container.querySelectorAll('.settings-graph-row').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const slug = el.dataset.slug;
        const g = graphs.find(x => x.slug === slug);
        const role = _settingsGraphRole(g);
        const inspectOnly = typeof _isInspectOnlyGraph === 'function'
          ? _isInspectOnlyGraph(g)
          : !!(g?.inspectOnly || g?.activationLocked || g?.managed || g?.protected || _settingsGraphIsManagedMemoryRole(role));
        if (inspectOnly && typeof inspectGraph === 'function') inspectGraph(slug);
        else if (g?.active && typeof viewActiveGraph === 'function') viewActiveGraph(slug);
        else if (g && !g.active && typeof switchToGraph === 'function') switchToGraph(slug);
      });
    });
    container.querySelectorAll('.settings-graph-group').forEach(el => {
      el.addEventListener('toggle', () => _settingsWriteGraphGroupState(el.dataset.graphGroup, el.open));
    });
    container.querySelectorAll('[data-graph-delete]').forEach(btn => {
      btn.addEventListener('click', () => _deleteSettingsGraph(btn.dataset.graphDelete, graphs.find(g => g.slug === btn.dataset.graphDelete)));
    });
    container.querySelectorAll('[data-graph-reset]').forEach(btn => {
      btn.addEventListener('click', () => _resetSettingsGraph(btn.dataset.graphReset, graphs.find(g => g.slug === btn.dataset.graphReset)));
    });
    container.querySelectorAll('[data-graph-maintain]').forEach(btn => {
      btn.addEventListener('click', () => _maintainSettingsGraph(btn.dataset.graphMaintain, graphs.find(g => g.slug === btn.dataset.graphMaintain)));
    });
    container.querySelectorAll('[data-graph-research-general-kb]').forEach(btn => {
      btn.addEventListener('click', () => _researchSettingsGeneralKb(btn.dataset.graphResearchGeneralKb, graphs.find(g => g.slug === btn.dataset.graphResearchGeneralKb), btn));
    });
  } catch (e) {
    container.innerHTML = `<div class="settings-scroll-empty settings-status-danger">Failed: ${esc(e.message)}</div>`;
  }
}

async function _maintainSettingsGraph(slug, graph) {
  if (!slug) return;
  const name = graph?.name || slug;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/maintenance/run`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true, reason: 'settings' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'maintenance failed');
    toast(`Maintained ${name}`);
    if (typeof loadGraphsList === 'function') loadGraphsList();
    await renderSettingsGraphsList();
    if (typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug === slug && typeof inspectGraph === 'function') inspectGraph(slug);
  } catch (e) {
    toast(`Maintenance failed: ${e.message || e}`, true);
    await renderSettingsGraphsList();
  }
}

async function _researchSettingsGeneralKb(slug, graph, button) {
  if (!slug) return;
  const name = graph?.name || slug;
  const batchInput = document.getElementById('settings-general-kb-research-batch');
  const batchSize = Math.max(1, parseInt((batchInput?.value || '1').trim(), 10) || 1);
  const originalText = button?.textContent || 'research';
  if (button) {
    button.disabled = true;
    button.textContent = 'queueing';
  }
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/research/run`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true, reason: 'manual', batchSize }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    if (data.ok) {
      toast(`Queued ${data.queued || 0} ${name} research node${data.queued === 1 ? '' : 's'}`);
    } else if (data.skipped) {
      toast(`Research skipped: ${data.skipped}`);
    } else {
      toast('No research work queued');
    }
    await renderSettingsGraphsList();
  } catch (e) {
    toast(`Research failed: ${e.message || e}`, true);
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function _deleteSettingsGraph(slug, graph) {
  if (!slug) return;
  const name = graph?.name || slug;
  if (!confirm(`Delete graph "${name}"? This removes its database file. This cannot be undone from the UI.`)) return;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'delete failed');
    toast(`Deleted graph ${name}`);
    if (typeof loadGraphsList === 'function') loadGraphsList();
    await renderSettingsGraphsList();
    if (typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug === slug && typeof viewActiveGraph === 'function') {
      const active = (typeof _graphsList !== 'undefined' ? _graphsList : []).find(g => g.active);
      if (active) viewActiveGraph(active.slug);
    }
  } catch (e) {
    toast(`Delete failed: ${e.message || e}`, true);
  }
}

async function _resetSettingsGraph(slug, graph) {
  if (!slug) return;
  const name = graph?.name || slug;
  if (!confirm(`Reset "${name}" to its seed nodes? This wipes distilled reusable memory but keeps the graph itself.`)) return;
  const typed = prompt(`Type RESET to reset "${name}"`);
  if (typed !== 'RESET') return;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/reset`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'reset failed');
    const a = data.after || {};
    toast(`Reset ${name}: ${a.nodes ?? '?'} nodes`);
    if (typeof loadGraphsList === 'function') loadGraphsList();
    await renderSettingsGraphsList();
    if (typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug === slug && typeof inspectGraph === 'function') inspectGraph(slug);
  } catch (e) {
    toast(`Reset failed: ${e.message || e}`, true);
  }
}

// Reset Graph button — gates on the user typing the literal RESET into
// the confirm input, then POSTs /api/admin/reset-graph. In multi-graph
// mode this resets default + General Knowledge and prunes every other
// graph. The endpoint itself also requires {confirm: "RESET"} as a
// second guard. Idempotent rebind — refreshes button state if the
// settings pane is opened/closed multiple times in one session.
// Invite-key card buttons — show/hide toggle, copy-to-clipboard, regen.
// Regen sets a `_pendingInviteRegenerate` flag so the next saveSettingsPanel
// call posts `inviteKeyRegenerate: true` instead of the typed value.
let _inviteKeyBound = false;
let _pendingInviteRegenerate = false;
let _pendingInviteClear = false;
async function _revealInviteKey(input) {
  const r = await fetch(API + '/api/settings/invite-key/reveal', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) throw new Error(data?.error || 'Invite key reveal failed');
  if (!data.inviteKey) throw new Error('No invite key is set');
  if (input) {
    input.value = data.inviteKey;
    input.type = 'text';
    input.dataset.secretSet = '1';
    input.dataset.revealed = '1';
  }
  const note = document.getElementById('settings-invite-key-note');
  if (note) note.textContent = 'Current invite key revealed. Copy it now or hide it again.';
  const showBtn = document.getElementById('settings-invite-key-show');
  if (showBtn) showBtn.textContent = 'hide';
  return data.inviteKey;
}
function _bindInviteKeyButtons() {
  if (_inviteKeyBound) return;
  _inviteKeyBound = true;
  const input = document.getElementById('settings-invite-key');
  document.getElementById('settings-invite-key-show')?.addEventListener('click', async () => {
    if (!input) return;
    const showBtn = document.getElementById('settings-invite-key-show');
    if (input.type === 'password') {
      try {
        if (!input.value && input.dataset.secretSet === '1') await _revealInviteKey(input);
        else input.type = 'text';
        if (showBtn) showBtn.textContent = 'hide';
      } catch (e) {
        toast(e?.message || 'Invite key reveal failed', true);
      }
    } else {
      input.type = 'password';
      if (showBtn) showBtn.textContent = 'show';
    }
  });
  document.getElementById('settings-invite-key-copy')?.addEventListener('click', async () => {
    try {
      const value = input?.value || (input?.dataset.secretSet === '1' ? await _revealInviteKey(input) : '');
      if (!value) throw new Error('No invite key is set');
      const ok = await _copyToClipboard(value);
      toast(ok ? 'Invite key copied' : 'Copy failed — select manually', !ok);
    } catch (e) {
      toast(e?.message || 'Invite key copy failed', true);
    }
  });
  document.getElementById('settings-invite-key-regen')?.addEventListener('click', async () => {
    if (!confirm('Regenerate the Spore Core invite key? Existing webapp guests + Spore Code users will lose access until they get the new key.')) return;
    _pendingInviteRegenerate = true;
    _pendingInviteClear = false;
    if (input) { input.value = ''; input.dataset.revealed = '0'; }
    const note = document.getElementById('settings-invite-key-note');
    if (note) note.textContent = 'Will mint a fresh UUID on Save.';
    toast('Click Save to mint the new key');
  });
  document.getElementById('settings-invite-key-clear')?.addEventListener('click', async () => {
    if (!confirm('Disable the invite key? Self-registration and Spore Code invite auth will stop working until a new key is set.')) return;
    _pendingInviteClear = true;
    _pendingInviteRegenerate = false;
    if (input) { input.value = ''; input.dataset.secretSet = '0'; input.dataset.revealed = '0'; }
    const note = document.getElementById('settings-invite-key-note');
    if (note) note.textContent = 'Will disable invite auth on Save.';
    toast('Click Save to disable the invite key');
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
	  };
  input.addEventListener('input', updateBtn);

  btn.addEventListener('click', async () => {
    if (input.value !== 'RESET') return;
    btn.disabled = true;
    btn.textContent = 'Resetting…';
	    if (result) {
	      result.hidden = false;
	      result.textContent = 'Resetting default + General Knowledge and pruning extra graphs…';
	    }
    try {
      const r = await fetch(API + '/api/admin/reset-graph', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || 'reset failed');
      const d = data.defaultGraph || {};
      const g = data.generalGraph || {};
      const db = d.before || {};
      const da = d.after || {};
      const gb = g.before || {};
      const ga = g.after || {};
      const pruned = Array.isArray(data.prunedGraphs) ? data.prunedGraphs : [];
      const graphSummary = data.mode === 'legacy'
        ? `Graph reset OK. before: nodes=${db.nodes} aspects=${db.aspects} attrs=${db.attrs} edges=${db.edges} episodes=${db.episodes}. after: nodes=${da.nodes} aspects=${da.aspects} attrs=${da.attrs} edges=${da.edges} episodes=${da.episodes}. backup at ${d.backup || data.backup}.`
        : `Core graph reset OK. default: ${db.nodes ?? '?'} → ${da.nodes ?? '?'} nodes. General Knowledge: ${gb.nodes ?? '?'} → ${ga.nodes ?? '?'} nodes. Pruned ${pruned.length} extra graph${pruned.length === 1 ? '' : 's'}. Backups: ${[d.backup, g.backup].filter(Boolean).join(' · ') || 'created'}.`;
      const summary = graphSummary;
      if (result) result.textContent = summary;
      if (typeof toast === 'function') toast(data.mode === 'legacy' ? 'Graph reset to seeds' : `Reset core graphs; pruned ${pruned.length}`);
      if (typeof loadGraphsList === 'function') loadGraphsList();
      if (typeof renderSettingsGraphsList === 'function') renderSettingsGraphsList();
      if (typeof viewActiveGraph === 'function') {
        const active = (typeof _graphsList !== 'undefined' ? _graphsList : []).find(g => g.active);
        if (active) viewActiveGraph(active.slug);
      }
    } catch (e) {
      if (result) result.textContent = 'Failed: ' + (e?.message || e);
      if (typeof toast === 'function') toast('Reset failed: ' + (e?.message || e), true);
    } finally {
      input.value = '';
      updateBtn();
      btn.textContent = 'Reset core graphs';
    }
  });
  updateBtn();
}

// Agent Effort — 3-button picker (quick / balanced / deep). The selected
// tier is stored in a hidden widget input and mirrored to the container
// dataset for older save/summary code.
let _settingsEffortPresets = null;
function _populateAgentEffortButtons(effort) {
  const wrap = document.getElementById('settings-effort-buttons');
  if (!wrap) return;
  const value = (effort && effort.value) || 'balanced';
  wrap.dataset.value = value;
  _settingsEffortPresets = effort?.presets || null;
  const W = window.SettingsWidgets;
  if (W?.segmented && wrap.dataset.widgetMounted !== '1') {
    wrap.dataset.widgetMounted = '1';
    wrap.innerHTML = W.segmented({
      id: 'settings-effort-value',
      value,
      className: 'settings-agent-effort-segmented',
      options: [
        { value: 'quick', label: 'Quick', description: 'Lower cost and shorter turns.' },
        { value: 'balanced', label: 'Balanced', description: 'Default budgets and iteration limits.' },
        { value: 'deep', label: 'Deep', description: 'Higher budgets for long research and coding work.' },
      ],
    });
  } else if (!W?.segmented && !wrap.querySelector('.settings-effort-btn')) {
    wrap.classList.add('settings-row');
    wrap.innerHTML = `
      <button class="settings-effort-btn" type="button" data-effort="quick">Quick</button>
      <button class="settings-effort-btn" type="button" data-effort="balanced">Balanced</button>
      <button class="settings-effort-btn" type="button" data-effort="deep">Deep</button>
    `;
  }
  if (W?.setSegmentedValue) {
    W.setSegmentedValue('settings-effort-value', value);
  } else {
    wrap.querySelectorAll('.settings-effort-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.effort === value);
    });
  }
  if (!wrap.dataset.bound) {
    wrap.dataset.bound = '1';
    wrap.addEventListener('settings-segmented-change', (e) => {
      if (e.detail?.id !== 'settings-effort-value') return;
      const tier = e.detail.value;
      if (!tier) return;
      wrap.dataset.value = tier;
      _refreshAgentEffortSummary();
      _refreshAgentBudgetPlaceholders();
    });
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-effort-btn');
      if (!btn) return;
      const tier = btn.dataset.effort;
      if (!tier) return;
      wrap.dataset.value = tier;
      wrap.querySelectorAll('.settings-effort-btn').forEach(b => b.classList.toggle('active', b === btn));
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
  const widgetValue = document.getElementById('settings-effort-value')?.value;
  if (widgetValue) return widgetValue;
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
      <div class="settings-budget-row">
        <label for="settings-budget-section-${k}">${k} <span class="settings-budget-default">(default ${defVal})</span></label>
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
  // modelLimits is keyed by model, not tier. When multiple tiers route to
  // the same model (e.g. all nine pointed at one local Qwen) every tier
  // would otherwise fight over the same entry and an `auto` row would
  // wipe a non-default set by a sibling. Merge-only: first non-default
  // wins, default never deletes. Numerics fold via Math.max so two tiers
  // with different values converge on the larger one instead of
  // silently shrinking. Server-side replace of SPORE_MODEL_LIMITS still
  // clears stale entries when no tier sets a field.
  for (const [key] of SETTINGS_MODEL_FIELDS) {
    const provider = document.getElementById(`settings-model-${key}-provider`)?.value || 'anthropic';
    const model = document.getElementById(`settings-model-${key}-name`)?.value.trim() || '';
    models[key] = { provider, model };
    if (!model) continue;
    const ctx = parseInt(document.getElementById(`settings-model-${key}-ctx`)?.value, 10);
    const cmp = parseInt(document.getElementById(`settings-model-${key}-compact`)?.value, 10);
    const mxo = parseInt(document.getElementById(`settings-model-${key}-maxout`)?.value, 10);
    const eff = document.getElementById(`settings-model-${key}-effort`)?.value || 'auto';
    const limKey = (provider && provider !== 'anthropic') ? `${provider}/${model}` : model;
    const entry = modelLimits[limKey] || {};
    if (ctx > 0) entry.contextWindow = Math.max(entry.contextWindow || 0, ctx);
    if (cmp > 0) entry.compactAt    = Math.max(entry.compactAt    || 0, cmp);
    if (mxo > 0) entry.maxTokens    = Math.max(entry.maxTokens    || 0, mxo);
    if (eff && eff !== 'auto' && !entry.reasoningEffort) entry.reasoningEffort = eff;
    if (Object.keys(entry).length) modelLimits[limKey] = entry;
  }
  const { patch, actions } = _buildSettingsPatchPayload(modelLimits, models);

  setSettingsBusy(true, 'Saving settings...');
  try {
    const r = await fetch(API + '/api/settings', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, actions }),
    });
    const data = await r.json();
    if (!r.ok || !data?.ok) throw new Error(data?.error || 'Failed to save settings');
    _pendingInviteRegenerate = false;
    _pendingInviteClear = false;
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
    if (data.secrets?.inviteKey) {
      const input = document.getElementById('settings-invite-key');
      if (input) { input.value = data.secrets.inviteKey; input.type = 'text'; }
      const note = document.getElementById('settings-invite-key-note');
      if (note) note.textContent = 'New invite key generated. Copy it now; it will be hidden after reload.';
      const showBtn = document.getElementById('settings-invite-key-show');
      if (showBtn) showBtn.textContent = 'hide';
    }
    if (theme && theme !== _currentTheme) applyGraphTheme(theme);
    updateErBadge(!!data.settings?.memory?.enhancedRecall);
    setSettingsBusy(false, 'Saved');
    toast('Settings saved');
    // Stay open — the panel re-populates from the server's response
    // above, so the operator sees the just-saved values reflected
    // immediately. Closing on save (the previous behaviour) forced a
    // re-open cycle every time a value depended on a previous save
    // landing first. The panel still has a manual close button.
  } catch (e) {
    setSettingsBusy(false, e?.message || 'Failed to save settings');
    toast(e?.message || 'Failed to save settings', true);
  }
}
