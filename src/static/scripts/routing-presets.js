/**
 * routing-presets.js — Frontend for named model-routing presets.
 *
 * Provides a preset bar (dropdown + Save / Delete) above the
 * Model Routing grid in the Settings panel.  Saves and restores
 * the full routing configuration (tier assignments + model limits).
 *
 * Follows the same API-call patterns as model-library.js.
 */

/* global SETTINGS_MODEL_FIELDS, saveAllSettings, toast, setSettingsBusy */

// ── API helpers ──────────────────────────────────────────

const _api = () => (window._settingsApiRoot || '') + '/api/models/routing-presets';
const _headers = () => ({
  ...(window._authHeaders?.() || {}),
  'Content-Type': 'application/json',
});

async function _fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ..._headers(), ...(opts.headers || {}) } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(t || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Data helpers ─────────────────────────────────────────

function _collectCurrentConfig() {
  // Collect the 9 tier assignments from the UI inputs
  const models = {};
  const fields = typeof SETTINGS_MODEL_FIELDS !== 'undefined' ? SETTINGS_MODEL_FIELDS : [];
  for (const [key] of fields) {
    const provEl = document.getElementById(`settings-model-${key}-provider`);
    const modelEl = document.getElementById(`settings-model-${key}-name`);
    const ctxEl = document.getElementById(`settings-model-${key}-ctx`);
    const compactEl = document.getElementById(`settings-model-${key}-compact`);
    const maxoutEl = document.getElementById(`settings-model-${key}-maxout`);
    const effortEl = document.getElementById(`settings-model-${key}-effort`);

    const provider = provEl?.value || '';
    const model = modelEl?.value || '';
    models[key] = { provider, model };
    if (ctxEl?.value) models[key].ctx = ctxEl.value;
    if (compactEl?.value) models[key].compact = compactEl.value;
    if (maxoutEl?.value) models[key].maxOutput = maxoutEl.value;
    if (effortEl?.value && effortEl.value !== 'auto') models[key].effort = effortEl.value;
  }

  // Collect model limits from the model-library rows (if visible)
  // We read the limits directly from the hidden settings patch fields
  const modelLimits = {};
  const limitRows = document.querySelectorAll('.ml-card');
  for (const card of limitRows) {
    const id = card.dataset?.id;
    if (!id) continue;
    const ctxEl = card.querySelector('[data-ctx]');
    const maxoutEl = card.querySelector('[data-maxout]');
    const effortEl = card.querySelector('[data-effort]');
    if (ctxEl?.value || maxoutEl?.value || effortEl?.value) {
      modelLimits[id] = {};
      if (ctxEl?.value) modelLimits[id].contextWindow = ctxEl.value;
      if (maxoutEl?.value) modelLimits[id].maxOutput = maxoutEl.value;
      if (effortEl?.value && effortEl.value !== 'auto') modelLimits[id].reasoningEffort = effortEl.value;
    }
  }

  return { models, modelLimits };
}

function _applyConfigToUI(config) {
  if (!config?.models) return;
  const fields = typeof SETTINGS_MODEL_FIELDS !== 'undefined' ? SETTINGS_MODEL_FIELDS : [];
  for (const [key] of fields) {
    const tier = config.models[key];
    if (!tier) continue;

    const provEl = document.getElementById(`settings-model-${key}-provider`);
    const modelEl = document.getElementById(`settings-model-${key}-name`);
    const ctxEl = document.getElementById(`settings-model-${key}-ctx`);
    const compactEl = document.getElementById(`settings-model-${key}-compact`);
    const maxoutEl = document.getElementById(`settings-model-${key}-maxout`);
    const effortEl = document.getElementById(`settings-model-${key}-effort`);

    if (provEl && tier.provider) {
      provEl.value = tier.provider;
      provEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (modelEl && tier.model) modelEl.value = tier.model;
    if (ctxEl && tier.ctx) ctxEl.value = tier.ctx;
    if (compactEl && tier.compact) compactEl.value = tier.compact;
    if (maxoutEl && tier.maxOutput) maxoutEl.value = tier.maxOutput;
    if (effortEl && tier.effort) effortEl.value = tier.effort;
  }
}

// ── DOM helpers ──────────────────────────────────────────

function _getSelect() { return document.getElementById('routing-preset-select'); }
function _selectedName() { return _getSelect()?.value || ''; }

function _populateDropdown(presets) {
  const sel = _getSelect();
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select preset —</option>';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  // Restore selection if it still exists
  if (presets.some(p => p.name === current)) sel.value = current;
}

// ── Public API ───────────────────────────────────────────

async function loadPresets() {
  try {
    const data = await _fetchJson(_api());
    return data.presets || [];
  } catch (e) {
    console.warn('routing-presets: load failed', e);
    return [];
  }
}

async function savePreset() {
  const name = prompt('Preset name:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  try {
    setSettingsBusy?.(true, 'Saving preset…');
    const config = _collectCurrentConfig();
    await _fetchJson(`${_api()}/${encodeURIComponent(trimmed)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
    toast?.(`Preset "${trimmed}" saved`);
    const presets = await loadPresets();
    _populateDropdown(presets);
    _getSelect().value = trimmed;
  } catch (e) {
    toast?.(e?.message || 'Failed to save preset', true);
  } finally {
    setSettingsBusy?.(false);
  }
}

async function deletePreset() {
  const name = _selectedName();
  if (!name) { toast?.('Select a preset first', true); return; }
  if (!confirm(`Delete preset "${name}"?`)) return;
  try {
    setSettingsBusy?.(true, 'Deleting preset…');
    await _fetchJson(`${_api()}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast?.(`Preset "${name}" deleted`);
    const presets = await loadPresets();
    _populateDropdown(presets);
  } catch (e) {
    toast?.(e?.message || 'Failed to delete preset', true);
  } finally {
    setSettingsBusy?.(false);
  }
}

async function applyPreset() {
  const name = _selectedName();
  if (!name) return;
  try {
    setSettingsBusy?.(true, 'Applying preset…');
    const apiRoot = window._settingsApiRoot || '';
    await _fetchJson(`${_api()}/${encodeURIComponent(name)}/apply`, {
      method: 'POST',
    });

    toast?.(`Preset "${name}" applied`);

    // Re-populate the panel with fresh server data so UI shows the applied values
    const fresh = await _fetchJson(apiRoot + '/api/settings');
    if (typeof populateSettingsPanel === 'function') {
      populateSettingsPanel(fresh);
    }
  } catch (e) {
    toast?.(e?.message || 'Failed to apply preset', true);
  } finally {
    setSettingsBusy?.(false);
  }
}

function initPresetBar() {
  const sel = _getSelect();
  const saveBtn = document.getElementById('routing-preset-save');
  const deleteBtn = document.getElementById('routing-preset-delete');
  if (!sel) return;

  // Wire buttons (idempotent — remove old listeners by cloning)
  if (saveBtn) {
    const clone = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(clone, saveBtn);
    clone.addEventListener('click', () => savePreset());
  }
  if (deleteBtn) {
    const clone = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(clone, deleteBtn);
    clone.addEventListener('click', () => deletePreset());
  }
  const selClone = sel.cloneNode(true);
  sel.parentNode.replaceChild(selClone, sel);
  selClone.addEventListener('change', () => {
    if (selClone.value) applyPreset();
  });

  // Populate dropdown
  loadPresets().then(presets => _populateDropdown(presets));
}

window.RoutingPresets = { initPresetBar, loadPresets, savePreset, deletePreset, applyPreset };
