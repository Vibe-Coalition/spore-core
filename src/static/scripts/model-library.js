/**
 * scripts/model-library.js — frontend module for the centralized model
 * library.
 *
 * Backend: src/settings/model-library.js (CRUD, vendor refresh,
 * override tracking) + the /api/models/library/* HTTP routes.
 *
 * Two surfaces:
 *   1. Settings → Models pane: list / add / edit / refresh / delete /
 *      discover-from-provider. Cards rendered into
 *      `<div id="settings-model-library-pane">` placed above the
 *      Model Routing section in graph-viewer.html.
 *   2. Tier datalists (in Model Routing + the wizard): the existing
 *      `<input list="settings-model-<tier>-datalist">` typeahead boxes
 *      get their suggestions from the library so picking a model is
 *      a one-click action and metadata follows automatically.
 */

(function () {
  'use strict';

  // Public surface — attached to window so settings.js / onboarding.js
  // can call into it without import order surgery.
  window.ModelLibrary = window.ModelLibrary || {};
  const ML = window.ModelLibrary;

  // In-memory cache; refresh on focus + after every mutation.
  let _cache = null;
  let _loadInflight = null;

  // ── API helpers ────────────────────────────────────────────────────

  function _api() { return (typeof API !== 'undefined' && API) || ''; }
  function _headers() { return (typeof authHeaders === 'function') ? authHeaders() : {}; }

  async function load(force = false) {
    if (_cache && !force) return _cache;
    if (_loadInflight) return _loadInflight;
    _loadInflight = fetch(_api() + '/api/models/library', { headers: _headers() })
      .then(r => r.ok ? r.json() : { entries: [] })
      .then(j => {
        _cache = (j && j.entries) || [];
        // Mirror to __cache so the combobox (which reads __cache
        // directly for synchronous render) stays in sync after every
        // add / update / remove / reset.
        ML.__cache = _cache;
        return _cache;
      })
      .catch(() => { _cache = []; ML.__cache = _cache; return _cache; })
      .finally(() => { _loadInflight = null; });
    return _loadInflight;
  }

  async function add(entry, opts = {}) {
    const r = await fetch(_api() + '/api/models/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._headers() },
      body: JSON.stringify({ ...entry, upsert: !!opts.upsert }),
    });
    const j = await r.json().catch(() => ({}));
    await load(true);
    return j;
  }

  async function update(id, patch) {
    const r = await fetch(_api() + '/api/models/library/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._headers() },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    await load(true);
    return j;
  }

  function _isFavorite(entry) {
    return entry?.favorite === true || entry?.metadata?.favorite === true;
  }

  function _sortModelEntries(a, b) {
    const fav = (_isFavorite(b) ? 1 : 0) - (_isFavorite(a) ? 1 : 0);
    if (fav) return fav;
    const ctx = (b.contextWindow || 0) - (a.contextWindow || 0);
    if (ctx) return ctx;
    const prov = String(a.provider || '').localeCompare(String(b.provider || ''));
    if (prov) return prov;
    return String(a.modelId || '').localeCompare(String(b.modelId || ''));
  }

  function _refreshTierSurfaces() {
    const fields = (typeof SETTINGS_MODEL_FIELDS !== 'undefined' && Array.isArray(SETTINGS_MODEL_FIELDS))
      ? SETTINGS_MODEL_FIELDS
      : [];
    for (const [key] of fields) {
      try {
        if (typeof _settingsRefreshTierModelList === 'function') _settingsRefreshTierModelList(key);
      } catch { /* ignore */ }
      }
    document.querySelectorAll('.settings-model-row').forEach(row => row?._comboInstance?.refresh?.());
  }

  async function toggleFavorite(id) {
    const entry = (_cache || []).find(e => e.id === id);
    if (!entry) return { ok: false, error: 'model not found' };
    const metadata = { ...(entry.metadata || {}) };
    if (_isFavorite(entry)) delete metadata.favorite;
    else metadata.favorite = true;
    const out = await update(id, { metadata });
    await load(true);
    _refreshTierSurfaces();
    return out;
  }

  async function remove(id) {
    const r = await fetch(_api() + '/api/models/library/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: _headers(),
    });
    const j = await r.json().catch(() => ({}));
    await load(true);
    return j;
  }

  async function reset(id) {
    const r = await fetch(_api() + '/api/models/library/' + encodeURIComponent(id) + '/reset', {
      method: 'POST',
      headers: _headers(),
    });
    const j = await r.json().catch(() => ({}));
    await load(true);
    return j;
  }

  async function discover(provider, credentials) {
    const r = await fetch(_api() + '/api/models/library/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._headers() },
      body: JSON.stringify({ provider, credentials }),
    });
    return await r.json().catch(() => ({ ok: false, suggestions: [] }));
  }

  // ── Tier datalist population ──────────────────────────────────────
  // Tier inputs use `<input list="settings-model-<tier>-datalist">` so
  // the browser native typeahead works. Populate with library entries
  // (optionally filtered by the tier's selected provider).

  function populateTierDatalist(tier, opts = {}) {
    const dl = document.getElementById(`settings-model-${tier}-datalist`);
    if (!dl) return;
    const entries = _cache || [];
    const provFilter = (opts.provider || '').toLowerCase();
    dl.innerHTML = entries
      .filter(e => e.enabled !== false)
      .filter(e => !provFilter || e.provider === provFilter)
      .sort(_sortModelEntries)
      .map(e => {
        const ctx = e.contextWindow ? ` — ${_compactNumber(e.contextWindow)} ctx` : '';
        const caps = _capsBadge(e.capabilities);
        const fav = _isFavorite(e) ? ' — favourite' : '';
        const value = e.modelId;            // bare model id; provider field is set separately
        const label = `${e.provider}/${e.modelId}${fav}${ctx}${caps}`;
        return `<option value="${_esc(value)}" label="${_esc(label)}"></option>`;
      })
      .join('');
  }

  function _compactNumber(n) {
    if (!Number.isFinite(n)) return '';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'K';
    return String(n);
  }

  function _capsBadge(c) {
    if (!c || typeof c !== 'object') return '';
    const flags = [];
    if (c.tools) flags.push('tools');
    if (c.vision) flags.push('vision');
    if (c.audio) flags.push('audio');
    if (c.video) flags.push('video');
    return flags.length ? ` [${flags.join(', ')}]` : '';
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Library pane (Settings → Models) ──────────────────────────────

  function renderLibraryPane(containerId = 'settings-model-library-pane') {
    const root = document.getElementById(containerId);
    if (!root) return;

    load(false).then(() => _renderInto(root));
  }

  function _renderInto(root) {
    const entries = _cache || [];
    const byProvider = {};
    for (const e of entries) {
      (byProvider[e.provider] = byProvider[e.provider] || []).push(e);
    }
    const providers = Object.keys(byProvider).sort();

    // Configured providers (from the registered-provider list in
    // /api/settings) — used to render a "Discover from <provider>"
    // button per provider, even if the library has no entries yet.
    const configuredProviders = (window._settingsProvidersRegistered || []).filter(p => p.configured);

    // Pane-level summary: how many providers configured, how many
    // models in the library. Quick at-a-glance state.
    const favCount = entries.filter(_isFavorite).length;
    const summary = `${configuredProviders.length} provider${configuredProviders.length === 1 ? '' : 's'} configured · ${entries.length} model${entries.length === 1 ? '' : 's'} in library${favCount ? ` · ${favCount} favourite${favCount === 1 ? '' : 's'}` : ''}`;

    let html = `
      <div class="ml-pane">
        <div class="ml-pane-summary">${_esc(summary)}</div>

        <div class="ml-discover-row">
          ${configuredProviders.length === 0
            ? '<span class="ml-pane-empty-inline">Configure a provider in the Providers tab to discover its model catalog.</span>'
            : `<span class="ml-discover-label">Click to import models from a configured provider:</span>` +
              configuredProviders.map(p =>
                `<button type="button" class="ml-btn ml-btn-primary" data-ml-discover="${_esc(p.name)}">
                   <span class="ml-btn-icon" aria-hidden="true">+</span>
                   <span>Discover from ${_esc(p.label || p.name)}</span>
                 </button>`
              ).join('')}
        </div>

        ${entries.length === 0 ? `
          <div class="ml-pane-empty">No models in the library yet. Click a Discover button above once you've configured a provider.</div>
        ` : providers.map(prov => {
            const list = byProvider[prov].slice().sort(_sortModelEntries);
            const enabled = list.filter(e => e.enabled !== false).length;
            const summary = `${list.length} model${list.length === 1 ? '' : 's'}${enabled !== list.length ? ` · ${enabled} enabled` : ''}`;
            return `
              <details class="ml-provider-group">
                <summary class="ml-provider-header">
                  <span class="ml-provider-name">${_esc(prov)}</span>
                  <span class="ml-provider-count">${_esc(summary)}</span>
                  <span class="ml-provider-caret" aria-hidden="true">▾</span>
                </summary>
                <div class="ml-cards">
                  ${list.map(e => _cardHtml(e)).join('')}
                </div>
              </details>
            `;
          }).join('')}
      </div>
    `;
    root.innerHTML = html;

    // Wire actions
    root.querySelectorAll('[data-ml-discover]').forEach(btn => {
      btn.addEventListener('click', () => _openDiscoverModal(btn.dataset.mlDiscover));
    });
    root.querySelectorAll('[data-ml-edit]').forEach(btn => {
      btn.addEventListener('click', () => _openEditModal(btn.dataset.mlEdit));
    });
    root.querySelectorAll('[data-ml-favorite]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await toggleFavorite(btn.dataset.mlFavorite);
        if (!r?.updated) {
          btn.disabled = false;
          alert('Favourite failed: ' + (r?.error || 'not updated'));
          return;
        }
        renderLibraryPane();
      });
    });
    root.querySelectorAll('[data-ml-reset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Reset metadata for ${btn.dataset.mlReset} from vendor?`)) return;
        btn.disabled = true;
        const r = await reset(btn.dataset.mlReset);
        if (!r?.ok) alert('Reset failed: ' + (r?.error || 'unknown'));
        renderLibraryPane();
      });
    });
    root.querySelectorAll('[data-ml-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Remove ${btn.dataset.mlDelete} from the library?`)) return;
        await remove(btn.dataset.mlDelete);
        renderLibraryPane();
      });
    });
  }

  function _cardHtml(e) {
    const fav = _isFavorite(e);
    const ctx = e.contextWindow ? `${_compactNumber(e.contextWindow)} ctx` : 'no ctx';
    const max = e.maxOutput ? `${_compactNumber(e.maxOutput)} out` : '';
    const eff = e.reasoningEffortDefault ? `effort: ${_esc(e.reasoningEffortDefault)}` : '';
    const caps = _capsBadge(e.capabilities).replace(/^\s\[|\]$/g, '');
    const tags = [ctx, max, eff, caps].filter(Boolean);
    const sourceTag = e.source === 'migration'
      ? '<span class="ml-tag ml-tag-warn" title="Migrated from legacy config — review">legacy</span>'
      : e.source === 'auto'
        ? '<span class="ml-tag" title="Discovered from vendor /models">auto</span>'
        : '';
    const overrideTag = (e.userOverrides || []).length
      ? `<span class="ml-tag ml-tag-info" title="Overridden: ${_esc(e.userOverrides.join(', '))}">overridden</span>`
      : '';
    const favoriteTag = fav ? '<span class="ml-tag ml-tag-fav">favourite</span>' : '';
    return `
      <div class="ml-card${fav ? ' ml-card-favorite' : ''}" data-ml-id="${_esc(e.id)}">
        <div class="ml-card-head">
          <div class="ml-card-title">${_esc(e.modelId)}</div>
          <div class="ml-card-tags">${favoriteTag}${sourceTag}${overrideTag}</div>
        </div>
        <div class="ml-card-meta">${tags.map(t => `<span>${_esc(t)}</span>`).join(' · ')}</div>
        <div class="ml-card-actions">
          <button type="button" class="ml-btn ml-btn-tiny ml-btn-fav${fav ? ' active' : ''}" data-ml-favorite="${_esc(e.id)}" aria-pressed="${fav ? 'true' : 'false'}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}">${fav ? 'favourited' : 'favourite'}</button>
          <button type="button" class="ml-btn ml-btn-tiny" data-ml-edit="${_esc(e.id)}">edit</button>
          <button type="button" class="ml-btn ml-btn-tiny" data-ml-reset="${_esc(e.id)}">refresh</button>
          <button type="button" class="ml-btn ml-btn-tiny ml-btn-danger" data-ml-delete="${_esc(e.id)}">remove</button>
        </div>
      </div>
    `;
  }

  // ── Edit modal ────────────────────────────────────────────────────

  function _openEditModal(id) {
    const existing = id ? (_cache || []).find(e => e.id === id) : null;
    const overlay = document.createElement('div');
    overlay.className = 'ml-modal-overlay';
    overlay.innerHTML = `
      <div class="ml-modal" role="dialog" aria-label="Edit model">
        <div class="ml-modal-head">
          <h4>${existing ? 'Edit ' + _esc(existing.modelId) : 'Add model'}</h4>
          <button type="button" class="ml-modal-close" aria-label="Close">×</button>
        </div>
        <div class="ml-modal-body">
          <label>Provider <input id="ml-edit-provider" type="text" ${existing ? 'readonly' : ''} value="${_esc(existing?.provider || '')}" placeholder="anthropic, openai, …"></label>
          <label>Model id <input id="ml-edit-modelid" type="text" ${existing ? 'readonly' : ''} value="${_esc(existing?.modelId || '')}" placeholder="claude-opus-4-7"></label>
          <label>Label <input id="ml-edit-label" type="text" value="${_esc(existing?.label || '')}" placeholder="optional display name"></label>
          <div class="ml-edit-row2">
            <label>Context window <input id="ml-edit-ctx" type="number" min="1" value="${existing?.contextWindow ?? ''}" placeholder="e.g. 200000"></label>
            <label>Max output <input id="ml-edit-max" type="number" min="1" value="${existing?.maxOutput ?? ''}" placeholder="e.g. 16384"></label>
            <label>Compact at <input id="ml-edit-compact" type="number" min="1" value="${existing?.compactAt ?? ''}" placeholder="optional"></label>
          </div>
          <label>Default reasoning effort
            <select id="ml-edit-effort">
              <option value="">(none)</option>
              ${['off','minimal','low','medium','high','max'].map(v => `<option value="${v}" ${existing?.reasoningEffortDefault === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <fieldset class="ml-edit-caps">
            <legend>Capabilities</legend>
            ${['tools','vision','audio','video'].map(c =>
              `<label><input type="checkbox" data-ml-cap="${c}" ${existing?.capabilities?.[c] ? 'checked' : ''}> ${c}</label>`
            ).join('')}
          </fieldset>
        </div>
        <div class="ml-modal-foot">
          <button type="button" class="ml-btn ml-btn-soft ml-modal-close">Cancel</button>
          <button type="button" class="ml-btn" id="ml-edit-save">${existing ? 'Save' : 'Add'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll('.ml-modal-close').forEach(b => b.addEventListener('click', close));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#ml-edit-save').addEventListener('click', async () => {
      const provider = (overlay.querySelector('#ml-edit-provider').value || '').trim().toLowerCase();
      const modelId = (overlay.querySelector('#ml-edit-modelid').value || '').trim();
      if (!modelId) { alert('Model id required'); return; }
      const label = (overlay.querySelector('#ml-edit-label').value || '').trim() || null;
      const ctx = parseInt(overlay.querySelector('#ml-edit-ctx').value, 10);
      const max = parseInt(overlay.querySelector('#ml-edit-max').value, 10);
      const cmp = parseInt(overlay.querySelector('#ml-edit-compact').value, 10);
      const effort = overlay.querySelector('#ml-edit-effort').value || null;
      const capabilities = {};
      overlay.querySelectorAll('[data-ml-cap]').forEach(cb => {
        if (cb.checked) capabilities[cb.dataset.mlCap] = true;
      });
      const payload = {
        provider, modelId, label,
        contextWindow: Number.isFinite(ctx) ? ctx : null,
        maxOutput: Number.isFinite(max) ? max : null,
        compactAt: Number.isFinite(cmp) ? cmp : null,
        reasoningEffortDefault: effort,
        capabilities,
      };
      if (existing) {
        await update(existing.id, payload);
      } else {
        await add(payload);
      }
      close();
      renderLibraryPane();
    });
  }

  // ── Discover modal ────────────────────────────────────────────────

  async function _openDiscoverModal(provider) {
    const overlay = document.createElement('div');
    overlay.className = 'ml-modal-overlay';
    overlay.innerHTML = `
      <div class="ml-modal" role="dialog" aria-label="Discover models from ${_esc(provider)}">
        <div class="ml-modal-head">
          <h4>Discover models · ${_esc(provider)}</h4>
          <button type="button" class="ml-modal-close" aria-label="Close">×</button>
        </div>
        <div class="ml-modal-body" id="ml-discover-body">
          <div class="ml-discover-status">Probing ${_esc(provider)}…</div>
        </div>
        <div class="ml-modal-foot">
          <button type="button" class="ml-btn ml-btn-soft ml-modal-close">Cancel</button>
          <button type="button" class="ml-btn" id="ml-discover-add" disabled>Add selected</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll('.ml-modal-close').forEach(b => b.addEventListener('click', close));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const result = await discover(provider);
    const body = overlay.querySelector('#ml-discover-body');
    const addBtn = overlay.querySelector('#ml-discover-add');
    if (!result?.ok) {
      body.innerHTML = `<div class="ml-discover-error">Discovery failed: ${_esc(result?.error || 'unknown')}</div>`;
      return;
    }
    const suggestions = result.suggestions || [];
    if (suggestions.length === 0) {
      body.innerHTML = `<div class="ml-discover-empty">${_esc(provider)} returned no models.</div>`;
      return;
    }
    body.innerHTML = `
      <div class="ml-discover-help">${suggestions.length} model(s) discovered. Pick the ones you want in your library.</div>
      <div class="ml-discover-list">
        ${suggestions.map((s, i) => `
          <label class="ml-discover-item ${s.alreadyInLibrary ? 'ml-discover-existing' : ''}">
            <input type="checkbox" data-ml-i="${i}" ${s.alreadyInLibrary ? 'disabled' : ''}>
            <div class="ml-discover-meta">
              <div class="ml-discover-name">${_esc(s.modelId)}${s.alreadyInLibrary ? ' <span class="ml-tag">already in library</span>' : ''}</div>
              <div class="ml-discover-sub">${s.contextWindow ? _compactNumber(s.contextWindow) + ' ctx' : 'ctx unknown'}${_capsBadge(s.capabilities)}</div>
            </div>
          </label>
        `).join('')}
      </div>
    `;
    const updateAddBtn = () => {
      const any = !!body.querySelector('input[data-ml-i]:checked');
      addBtn.disabled = !any;
    };
    body.querySelectorAll('input[data-ml-i]').forEach(cb => cb.addEventListener('change', updateAddBtn));
    addBtn.addEventListener('click', async () => {
      const picked = [...body.querySelectorAll('input[data-ml-i]:checked')]
        .map(cb => suggestions[Number(cb.dataset.mlI)]);
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      for (const s of picked) {
        await add({ ...s, source: 'auto' });
      }
      close();
      renderLibraryPane();
    });
  }

  // ── Tier combobox ──────────────────────────────────────────────────
  // Drop-in replacement for the legacy provider <select> + model
  // <input list> pair on each tier row. One field, typeahead search
  // across the library, suggestions grouped by provider with
  // capability badges + ctx, plus a "use custom" escape hatch for
  // models the operator hasn't added to the library yet.
  //
  //   const combo = ModelLibrary.attachTierCombobox(rootEl, {
  //     value:    { provider: 'anthropic', modelId: 'claude-opus-4-7' },
  //     onChange: ({ provider, modelId, libraryEntry }) => { ... },
  //   });
  //
  // The component reads from the cached library; the caller is
  // responsible for calling ModelLibrary.load() before mounting.

  function attachTierCombobox(root, opts = {}) {
    if (!root) return null;
    const state = {
      open: false,
      activeIndex: -1,
      filter: '',
      value: opts.value || null,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
      placeholder: opts.placeholder || 'Search or pick a model…',
      allowCustom: opts.allowCustom !== false,
      // Custom data source: () => [{ provider, modelId, contextWindow,
      // capabilities, enabled }]. Defaults to the persistent library
      // cache; the wizard passes its own in-memory model list.
      getEntries: typeof opts.getEntries === 'function' ? opts.getEntries : null,
    };

    root.classList.add('ml-combobox');
    root.innerHTML = `
      <button type="button" class="ml-combobox-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="ml-combobox-value"></span>
        <span class="ml-combobox-caret" aria-hidden="true">▾</span>
      </button>
      <div class="ml-combobox-dropdown" role="listbox" hidden>
        <div class="ml-combobox-search">
          <input type="text" class="ml-combobox-search-input" placeholder="Type to filter…" aria-label="Filter models">
        </div>
        <div class="ml-combobox-list"></div>
      </div>
    `;
    const trigger = root.querySelector('.ml-combobox-trigger');
    const valueEl = root.querySelector('.ml-combobox-value');
    const dropdown = root.querySelector('.ml-combobox-dropdown');
    const filterInput = root.querySelector('.ml-combobox-search-input');
    const list = root.querySelector('.ml-combobox-list');

    function _renderValueDisplay() {
      if (!state.value || !state.value.modelId) {
        valueEl.innerHTML = `<span class="ml-combobox-empty">${_esc(state.placeholder)}</span>`;
        return;
      }
      const { provider, modelId } = state.value;
      const source = typeof state.getEntries === 'function'
        ? (state.getEntries() || [])
        : (window.ModelLibrary?.__cache || []);
      const id = source.find(x => x.provider === provider && x.modelId === modelId);
      const label = id ? id.modelId : modelId;
      const sub = id?.contextWindow ? ` <span class="ml-combobox-meta">${_compactNumber(id.contextWindow)} ctx</span>` : '';
      const fav = id && _isFavorite(id) ? ` <span class="ml-combobox-favtag">fav</span>` : '';
      const provTag = `<span class="ml-combobox-provtag">${_esc(provider)}</span>`;
      valueEl.innerHTML = `${provTag} <span class="ml-combobox-label">${_esc(label)}</span>${sub}${fav}`;
    }

    function _suggestions() {
      const f = state.filter.trim().toLowerCase();
      const source = typeof state.getEntries === 'function'
        ? (state.getEntries() || [])
        : (window.ModelLibrary?.__cache || []);
      const lib = source.filter(e => e && e.enabled !== false);
      const filtered = lib.filter(e => {
        if (!f) return true;
        return (e.modelId || '').toLowerCase().includes(f)
            || (e.label || '').toLowerCase().includes(f)
            || (e.provider || '').toLowerCase().includes(f);
      });
      // If the operator has favourites, surface them first across
      // providers. The same entries are removed from their provider
      // groups to avoid duplicate rows in the dropdown.
      const hasFavorites = filtered.some(_isFavorite);
      const favoriteItems = hasFavorites ? filtered.filter(_isFavorite).sort(_sortModelEntries) : [];
      const groupedSource = hasFavorites ? filtered.filter(e => !_isFavorite(e)) : filtered;

      // Group remaining entries by provider.
      const byProv = {};
      for (const e of groupedSource) {
        (byProv[e.provider] = byProv[e.provider] || []).push(e);
      }
      const groups = [];
      if (favoriteItems.length) {
        groups.push({ provider: 'Favourites', kind: 'favorites', items: favoriteItems });
      }
      groups.push(...Object.keys(byProv).sort().map(prov => ({
        provider: prov,
        kind: 'provider',
        items: byProv[prov].sort(_sortModelEntries),
      })));
      return { groups, total: filtered.length };
    }

    function _renderList() {
      const { groups, total } = _suggestions();
      const flat = [];
      let html = '';
      if (total === 0) {
        html += `<div class="ml-combobox-empty-list">No matches in your library.</div>`;
      } else {
        for (const g of groups) {
          html += `<div class="ml-combobox-group-head">${_esc(g.provider)}</div>`;
          for (const e of g.items) {
            const caps = _capsBadges(e.capabilities);
            const ctx = e.contextWindow ? `<span class="ml-combobox-meta">${_compactNumber(e.contextWindow)} ctx</span>` : '';
            const fav = _isFavorite(e) ? `<span class="ml-combobox-favtag">fav</span>` : '';
            const prov = g.kind === 'favorites' ? `<span class="ml-combobox-provtag">${_esc(e.provider)}</span>` : '';
            const idx = flat.length;
            flat.push({ kind: 'lib', entry: e });
            const sel = (state.value?.provider === e.provider && state.value?.modelId === e.modelId) ? ' aria-selected="true"' : '';
            html += `
              <div class="ml-combobox-item${_isFavorite(e) ? ' ml-combobox-favorite' : ''}" role="option" data-i="${idx}"${sel}>
                ${prov}
                <span class="ml-combobox-label">${_esc(e.modelId)}</span>
                ${ctx}
                ${fav}
                ${caps}
              </div>`;
          }
        }
      }
      // Custom escape hatch — always available when allowCustom + filter is non-empty
      if (state.allowCustom && state.filter.trim()) {
        const idx = flat.length;
        const slash = state.filter.indexOf('/');
        const provider = slash > 0 ? state.filter.slice(0, slash) : 'anthropic';
        const modelId = slash > 0 ? state.filter.slice(slash + 1).trim() : state.filter.trim();
        flat.push({ kind: 'custom', provider, modelId });
        html += `
          <div class="ml-combobox-item ml-combobox-custom" role="option" data-i="${idx}">
            <span class="ml-combobox-label">Use custom: <code>${_esc(state.filter.trim())}</code></span>
            <span class="ml-combobox-meta">not in library</span>
          </div>`;
      }
      list.innerHTML = html;
      list._flat = flat;
      // Bind clicks
      list.querySelectorAll('[data-i]').forEach(el => {
        el.addEventListener('mousedown', evt => {
          evt.preventDefault();
          _pick(Number(el.dataset.i));
        });
        el.addEventListener('mouseenter', () => {
          state.activeIndex = Number(el.dataset.i);
          _highlight();
        });
      });
      _highlight();
    }

    function _highlight() {
      list.querySelectorAll('.ml-combobox-item').forEach(el => {
        el.classList.toggle('ml-combobox-active', Number(el.dataset.i) === state.activeIndex);
      });
      const active = list.querySelector('.ml-combobox-active');
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }

    function _pick(i) {
      const item = list._flat?.[i];
      if (!item) return;
      const value = item.kind === 'lib'
        ? { provider: item.entry.provider, modelId: item.entry.modelId, libraryEntry: item.entry }
        : { provider: item.provider, modelId: item.modelId, libraryEntry: null };
      state.value = { provider: value.provider, modelId: value.modelId };
      _close();
      _renderValueDisplay();
      if (state.onChange) state.onChange(value);
    }

    function _open() {
      state.open = true;
      state.filter = '';
      state.activeIndex = 0;
      filterInput.value = '';
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      _renderList();
      // Position: most callers stack the row vertically; default
      // dropdown sits below the trigger via CSS. flip to top if there
      // isn't enough space below the viewport.
      requestAnimationFrame(() => {
        const rect = dropdown.getBoundingClientRect();
        const overflow = rect.bottom - (window.innerHeight - 8);
        dropdown.classList.toggle('ml-combobox-flip', overflow > 0 && rect.top - rect.height > 8);
        filterInput.focus();
      });
    }

    function _close() {
      state.open = false;
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', () => {
      if (state.open) _close();
      else _open();
    });
    trigger.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' || evt.key === ' ' || evt.key === 'ArrowDown') {
        evt.preventDefault();
        _open();
      }
    });
    filterInput.addEventListener('input', () => {
      state.filter = filterInput.value;
      state.activeIndex = 0;
      _renderList();
    });
    filterInput.addEventListener('keydown', evt => {
      if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        const max = (list._flat?.length || 0) - 1;
        state.activeIndex = Math.min(max, state.activeIndex + 1);
        _highlight();
      } else if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        state.activeIndex = Math.max(0, state.activeIndex - 1);
        _highlight();
      } else if (evt.key === 'Enter') {
        evt.preventDefault();
        if (state.activeIndex >= 0) _pick(state.activeIndex);
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        _close();
        trigger.focus();
      }
    });
    document.addEventListener('mousedown', evt => {
      if (!state.open) return;
      if (root.contains(evt.target)) return;
      _close();
    });

    _renderValueDisplay();

    return {
      setValue(v) { state.value = v; _renderValueDisplay(); },
      getValue() { return state.value; },
      refresh() { _renderValueDisplay(); if (state.open) _renderList(); },
    };
  }

  function _capsBadges(c) {
    if (!c || typeof c !== 'object') return '';
    const flags = [];
    if (c.tools) flags.push('tools');
    if (c.vision) flags.push('vision');
    if (c.audio) flags.push('audio');
    if (c.video) flags.push('video');
    return flags.map(f => `<span class="ml-combobox-cap ml-combobox-cap-${f}">${f}</span>`).join('');
  }

  // ── Public surface ─────────────────────────────────────────────────
  ML.load = load;
  ML.add = add;
  ML.update = update;
  ML.toggleFavorite = toggleFavorite;
  ML.remove = remove;
  ML.reset = reset;
  ML.discover = discover;
  ML.populateTierDatalist = populateTierDatalist;
  ML.renderLibraryPane = renderLibraryPane;
  ML.openEditModal = _openEditModal;
  ML.openDiscoverModal = _openDiscoverModal;
  ML.attachTierCombobox = attachTierCombobox;
})();
