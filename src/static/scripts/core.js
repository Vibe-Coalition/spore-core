// core.js — foundation for every other module. Loaded right after bootstrap.js.
//
// Holds: brand IIFE + API constant, theme definitions (THEMES, applyGraphTheme,
// normalizeThemeName), settings populator helpers (populateSettingsPanel and
// the _settings* family), and the graph type system (TYPE_COLORS, FAM,
// TYPE_FAMILY, getFamily/getFamilyKey, TYPE_VISUALS, graphData, simulation).
//
// Originated as the catch-all 13,470-line app.js Phase-2 extraction; carved
// down to ~850 lines through Phase 5 + Phase 6.

const VB = window.BRAND || {};
(function initViewerBrand() {
  const s = (id, t) => { const e = document.getElementById(id); if (e) e.innerHTML = t; };
  s('chat-logo', VB.chatLogo || '');
  s('chat-header-text', VB.chatHeaderText || 'GRAPH VIEWER');
  s('chat-welcome', `Send a message to speak with this ${VB.agent || 'agent'}. Graph updates appear in real time.`);
})();
const API = window.location.pathname.replace(/\/graph\/?$/, '');

// ── Theme Definitions ──
//
// Two themes: `dark` (default — the zinc baseline already lives in :root, so
// applying `dark` just clears any light-theme overrides) and `light` (a warm
// stone-based palette designed as a coherent companion). The 16 categorical
// graph node colors get their own per-theme palette: dark uses the existing
// vivid jewel tones from :root, light uses saturated mid-tones tuned for
// legibility on a near-white background.
//
// Picker UX: a single sun/moon toggle button in the header. No dropdown.
//
// Migration: legacy theme names (midnight, terminal, ember, arctic, neon,
// forest, paper) are normalized in normalizeThemeName() — `paper` → `light`,
// everything else → `dark`. Applied silently on first load and rewritten to
// localStorage + /api/preferences so old names never leak again.
const THEMES = {
  dark: {
    label: 'Dark',
    icon: '🌙',
    swatch: '#16140f',
    // Empty vars — :root carries the dark palette as the baseline. Applying
    // this theme just removes any light overrides so :root values take effect.
    vars: {},
    nodeVars: {},
  },
  light: {
    label: 'Light',
    icon: '☀',
    swatch: '#ece7dc',
    vars: {
      // Tier 1 — semantic foundation. The prototype's literal `paper #f7f2e6`
      // and `panel #fbf7ec` read as warm in its sparse layout (atmospheric
      // gradients tint most surfaces, lots of bg breathing room). In our
      // full-bleed UI the same hex values render closer to bright cream.
      // Compensate by deepening surface/panel ~4% and pulling the warmth
      // up — keeps the prototype's intent (warm paper) while reading as
      // such across the dense chrome we have.
      '--bg': '#ece7dc',
      '--surface': '#f3eddc',
      '--panel': '#f7f1e0',
      '--element': '#f7f1e0',
      '--border': 'rgba(29,33,27,0.12)',
      '--border-active': 'rgba(29,33,27,0.32)',
      '--border-subtle': 'rgba(29,33,27,0.08)',
      '--graph-hair': 'rgba(29,33,27,0.12)',
      '--graph-bg': '#f7f1e0',
      '--graph-cream': '#f7f1e0',
      // Atmospheric glows on the graph canvas, light-mode hues. Lower
      // alpha than dark so they don't overpower the paper surface.
      '--graph-glow-1': 'rgba(184, 84, 42, 0.10)',
      '--graph-glow-2': 'rgba(90, 122, 74, 0.12)',
      '--graph-glow-3': 'rgba(58, 106, 163, 0.08)',
      '--hl-rgb': '29, 33, 27',  // ink, polarity-flipped from dark mode
      '--text': '#4a4e46',
      '--text-bright': '#1d211b',
      '--text-dim': '#8a8c82',
      '--text-muted': '#b1aa9c',
      // Accent is leaf green per the Petri prototype (PETRI_THEMES.light.accent).
      // Warm/coral lives on accent3, mirroring the dark palette's structure.
      '--accent': '#5a7a4a',
      '--accent2': '#3e6b47',
      '--accent3': '#b8542a',
      '--danger': '#b8341c',
      '--warn': '#b8542a',
      '--success': '#5a7a4a',
      '--info': '#3a6aa3',
      // Tier 2 — markdown
      '--md-heading': '#1d211b',
      '--md-heading-marker': '#5a7a4a',
      '--md-link': '#3a6aa3',
      '--md-link-text': '#b8542a',
      '--md-code': '#5a7a4a',
      '--md-code-bg': 'rgba(90,122,74,.08)',
      '--md-code-block-bg': 'rgba(29,33,27,.04)',
      '--md-code-block-border': 'rgba(29,33,27,0.12)',
      '--md-blockquote': '#6b6760',
      '--md-blockquote-border': '#5a7a4a',
      '--md-emph': '#b8542a',
      '--md-strong': '#8a3a1f',
      '--md-list-marker': '#5a7a4a',
      '--md-hr': 'rgba(29,33,27,0.12)',
      '--md-table-header-bg': 'rgba(90,122,74,.06)',
      '--md-table-border': 'rgba(29,33,27,0.12)',
      // Tier 3 — diffs
      '--diff-added': '#5a7a4a',
      '--diff-added-bg': 'rgba(90,122,74,.10)',
      '--diff-removed': '#8a3a1f',
      '--diff-removed-bg': 'rgba(184,52,28,.08)',
      '--diff-context': '#6b6760',
      '--diff-hunk': '#b8542a',
      '--diff-line-num': '#b8b3a8',
    },
    // Tier 4 — Petri TYPE_COLORS (light), exact values from dir-petri.jsx.
    // 8 hue families: coral, slate, plum, leaf, ochre, rose, teal, clay.
    // Extended types beyond the prototype's 8 reuse the closest family.
    nodeVars: {
      '--node-self': '#b8542a',
      '--node-person': '#3a6aa3',
      '--node-channel': '#c08a2e',
      '--node-concept': '#8a4a9c',
      '--node-rule': '#2f6a6a',
      '--node-project': '#b07030',
      '--node-tool': '#c08a2e',
      '--node-memory': '#8a4a9c',
      '--node-skill': '#5a7a4a',
      '--node-capability': '#2f6a6a',
      '--node-event': '#b8542a',
      '--node-preference': '#9c4a4a',
      '--node-organization': '#b07030',
      '--node-topic': '#8a8c82',
      '--node-location': '#2f6a6a',
      '--node-default': '#8a8c82',
    },
  },
};

// Normalize legacy theme names to one of the two surviving themes. Used both
// on the client (loadGraphThemePreference) and mirrored on the server in
// gateways/web.js so user preferences from before the redesign don't leak
// stale names anywhere.
function normalizeThemeName(name) {
  if (name === 'light' || name === 'paper' || name === 'arctic') return 'light';
  // dark, midnight, terminal, ember, neon, forest, undefined, anything else
  // → dark (the new baseline).
  return 'dark';
}

let _currentTheme = 'dark';

function applyGraphTheme(name) {
  const normalized = normalizeThemeName(name);
  const theme = THEMES[normalized] || THEMES.dark;
  _currentTheme = normalized;
  const root = document.documentElement.style;
  // Clear every var that ANY theme defines so applying a theme that omits a
  // var (e.g. dark with empty vars) reverts that var to the :root baseline
  // instead of leaving the prior theme's value sticking around.
  const allVars = new Set();
  Object.values(THEMES).forEach(t => {
    Object.keys(t.vars).forEach(k => allVars.add(k));
    Object.keys(t.nodeVars || {}).forEach(k => allVars.add(k));
  });
  allVars.forEach(k => root.removeProperty(k));
  Object.entries(theme.vars).forEach(([k, v]) => root.setProperty(k, v));
  Object.entries(theme.nodeVars || {}).forEach(([k, v]) => root.setProperty(k, v));
  // Set data-theme on <html> so any future CSS using
  // [data-theme="light"]{...} selectors works without JS coordination, and
  // for color-scheme-aware native widgets (scrollbars, form controls).
  document.documentElement.setAttribute('data-theme', normalized);
  document.documentElement.style.colorScheme = normalized === 'light' ? 'light' : 'dark';
  localStorage.setItem('spore-theme', normalized);
  // Sync the toggle button's icon
  const toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.textContent = THEMES[normalized === 'light' ? 'dark' : 'light'].icon;
  // Rebuild the family palette and retint existing graph nodes. Touch only
  // fill/stroke on the existing visual elements — don't go through
  // _upsertNodeVisuals (which also updates geometry, labels, halos, etc.)
  // because that races with the live d3 simulation tick and can blank
  // nodes if the data binding is mid-update. Self-node geometry rebuilds
  // every frame via _selfAnim regardless.
  try {
    FAM = _buildFAM();
    if (typeof gNodes !== 'undefined' && gNodes) {
      gNodes.selectAll('.glow-ring')
        .attr('fill', d => d ? getColor(d.type) : null);
      gNodes.selectAll('.node-circle')
        .attr('fill', d => d ? getFillColor(d.type) : null)
        .attr('stroke', d => d ? getColor(d.type) : null);
      gNodes.selectAll('.node-glyph')
        .attr('fill', d => d ? getColor(d.type) : null);
      gNodes.selectAll('.node-focus-halo')
        .attr('stroke', d => d ? getColor(d.type) : null);
    }
  } catch (e) { console.warn('theme retint failed', e); }
}

async function toggleTheme() {
  const next = _currentTheme === 'light' ? 'dark' : 'light';
  applyGraphTheme(next);
  try {
    await fetch(API + '/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch {}
}

async function loadGraphThemePreference() {
  // Apply localStorage first for instant render — no waiting on the server
  // round-trip. Server preference (if it disagrees) overrides afterward.
  const cached = localStorage.getItem('spore-theme');
  if (cached) {
    const normalizedCached = normalizeThemeName(cached);
    applyGraphTheme(normalizedCached);
    // Rewrite stale legacy names so the next load doesn't have to migrate.
    if (normalizedCached !== cached) localStorage.setItem('spore-theme', normalizedCached);
  }
  try {
    const r = await fetch(API + '/api/preferences');
    const data = await r.json();
    if (data?.theme) {
      const normalized = normalizeThemeName(data.theme);
      applyGraphTheme(normalized);
      // If the server stored a legacy name, write the normalized one back so
      // it's clean next time.
      if (normalized !== data.theme) {
        try {
          await fetch(API + '/api/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: normalized }),
          });
        } catch {}
      }
    }
  } catch {}
}

function getSettingsEls() {
  return {
    overlay: document.getElementById('settings-pane'),
    statusEl: document.getElementById('settings-status'),
    saveBtn: document.getElementById('settings-save-btn'),
  };
}

function _settingsList(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function _settingsValue(value, fallback = 'unset') {
  const text = value === null || value === undefined || value === '' ? fallback : String(value);
  return text;
}

const SETTINGS_MODEL_FIELDS = [
  ['casual', 'Casual'],
  ['normal', 'Normal'],
  ['planner', 'Planner'],
  ['subagent', 'Subagent'],
  ['learner', 'Learner'],
  ['imageVlm', 'Image VLM'],
  ['videoVlm', 'Video VLM'],
  ['audioVlm', 'Audio VLM'],
];

const SETTINGS_PROVIDER_LABELS = {
  anthropic: 'anthropic / claude',
  openai: 'openai',
  openrouter: 'openrouter',
  local: 'local / oai-compat',
  gemini: 'gemini',
};

function _settingsEscapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _settingsProviderLabel(name) {
  const key = String(name || '').trim().toLowerCase();
  return SETTINGS_PROVIDER_LABELS[key] || key;
}

function _settingsProviderChoices() {
  const customNames = [...document.querySelectorAll('.settings-custom-provider [data-custom-provider-name]')]
    .map(input => String(input.value || '').trim().toLowerCase())
    .filter(Boolean)
    .filter((name, index, arr) => arr.indexOf(name) === index);
  const builtins = ['anthropic', 'openai', 'openrouter', 'local', 'gemini'];
  return builtins.concat(customNames.filter(name => !builtins.includes(name)).sort());
}

// Known OpenAI-compatible providers — pick one and URL + auth header fill in.
const PROVIDER_PRESETS = [
  { id: '',          label: 'Pick a preset to auto-fill…', baseUrl: '', authHeader: '',       keyHint: '' },
  { id: 'groq',      label: 'Groq',            baseUrl: 'https://api.groq.com/openai/v1',         authHeader: 'bearer', keyHint: 'console.groq.com/keys' },
  { id: 'together',  label: 'Together AI',     baseUrl: 'https://api.together.xyz/v1',            authHeader: 'bearer', keyHint: 'api.together.ai (Settings → API Keys)' },
  { id: 'fireworks', label: 'Fireworks',       baseUrl: 'https://api.fireworks.ai/inference/v1',  authHeader: 'bearer', keyHint: 'fireworks.ai/account/api-keys' },
  { id: 'cerebras',  label: 'Cerebras',        baseUrl: 'https://api.cerebras.ai/v1',             authHeader: 'bearer', keyHint: 'cloud.cerebras.ai (API Keys)' },
  { id: 'perplexity',label: 'Perplexity',      baseUrl: 'https://api.perplexity.ai',              authHeader: 'bearer', keyHint: 'perplexity.ai/settings/api' },
  { id: 'deepinfra', label: 'DeepInfra',       baseUrl: 'https://api.deepinfra.com/v1/openai',    authHeader: 'bearer', keyHint: 'deepinfra.com/dash/api_keys' },
  { id: 'mistral',   label: 'Mistral',         baseUrl: 'https://api.mistral.ai/v1',              authHeader: 'bearer', keyHint: 'console.mistral.ai' },
  { id: 'ollama',    label: 'Ollama (local)',  baseUrl: 'http://localhost:11434/v1',              authHeader: 'bearer', keyHint: '(no key needed — any value)' },
  { id: 'custom',    label: 'Other — fill in manually',    baseUrl: '', authHeader: 'bearer', keyHint: '' },
];

function _settingsOnAuthSelectChange(selectEl) {
  const row = selectEl.closest('.settings-custom-provider');
  if (!row) return;
  const customInp = row.querySelector('[data-custom-provider-auth-custom]');
  const hidden = row.querySelector('[data-custom-provider-auth]');
  if (selectEl.value === '__custom') {
    if (customInp) { customInp.style.display = 'block'; setTimeout(() => customInp.focus(), 30); }
    if (hidden) hidden.value = customInp?.value || '';
  } else {
    if (customInp) { customInp.style.display = 'none'; }
    if (hidden) hidden.value = selectEl.value;
  }
}

function _settingsOnAuthCustomInput(inputEl) {
  const row = inputEl.closest('.settings-custom-provider');
  if (!row) return;
  const hidden = row.querySelector('[data-custom-provider-auth]');
  if (hidden) hidden.value = inputEl.value.trim() || 'bearer';
}

function _settingsApplyPreset(selectEl) {
  const row = selectEl.closest('.settings-custom-provider');
  if (!row) return;
  const presetId = selectEl.value;
  const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
  if (!preset || !preset.id) return;
  const nameI = row.querySelector('[data-custom-provider-name]');
  const urlI = row.querySelector('[data-custom-provider-url]');
  const keyI = row.querySelector('[data-custom-provider-key]');
  const authSelect = row.querySelector('[data-custom-provider-auth-select]');
  const authHidden = row.querySelector('[data-custom-provider-auth]');
  const authCustom = row.querySelector('[data-custom-provider-auth-custom]');
  const hintEl = row.querySelector('[data-custom-provider-hint]');
  if (nameI && !nameI.value) { nameI.value = preset.id === 'custom' ? '' : preset.id; nameI.dispatchEvent(new Event('input', { bubbles: true })); }
  if (urlI && preset.baseUrl) urlI.value = preset.baseUrl;
  if (preset.authHeader) {
    const known = ['bearer', 'x-api-key', 'x-key'];
    if (authSelect) authSelect.value = known.includes(preset.authHeader) ? preset.authHeader : '__custom';
    if (authHidden) authHidden.value = preset.authHeader;
    if (authCustom) {
      if (known.includes(preset.authHeader)) {
        authCustom.style.display = 'none'; authCustom.value = '';
      } else {
        authCustom.style.display = 'block'; authCustom.value = preset.authHeader;
      }
    }
  }
  if (keyI && preset.keyHint) keyI.placeholder = 'API key — get one from ' + preset.keyHint;
  if (hintEl) hintEl.textContent = preset.keyHint ? 'Get a key: ' + preset.keyHint : '';
  if (keyI && !keyI.value) setTimeout(() => keyI.focus(), 30);
}

function _settingsCustomProviderRow(provider = {}) {
  const name = _settingsEscapeHtml(provider.name || '');
  const url = _settingsEscapeHtml(provider.url || '');
  const key = _settingsEscapeHtml(provider.key || '');
  const authHeader = _settingsEscapeHtml(provider.authHeader || 'bearer');
  const presetOptions = PROVIDER_PRESETS.map(p =>
    `<option value="${_settingsEscapeHtml(p.id)}">${_settingsEscapeHtml(p.label)}</option>`
  ).join('');
  return `
    <div class="settings-custom-provider">
      <div class="settings-custom-provider-head">
        <strong>${name ? _settingsEscapeHtml(name) : 'Custom Provider'}</strong>
        <button type="button" class="settings-danger-btn" onclick="removeSettingsCustomProvider(this)">Remove</button>
      </div>
      <label>Preset (optional)</label>
      <select data-custom-provider-preset onchange="_settingsApplyPreset(this)">${presetOptions}</select>
      <div class="settings-inline" style="margin-top:8px">
        <div>
          <label>Prefix</label>
          <input data-custom-provider-name type="text" value="${name}" placeholder="e.g. groq, together" oninput="onSettingsCustomProviderNameChange(this)">
        </div>
        <div>
          <label>Auth Header</label>
          ${(() => {
            const known = ['bearer', 'x-api-key', 'x-key'];
            const isCustom = authHeader && !known.includes(authHeader);
            return `
              <select data-custom-provider-auth-select onchange="_settingsOnAuthSelectChange(this)">
                <option value="bearer"${authHeader === 'bearer' || !authHeader ? ' selected' : ''}>Bearer (most providers)</option>
                <option value="x-api-key"${authHeader === 'x-api-key' ? ' selected' : ''}>x-api-key (Anthropic-style)</option>
                <option value="x-key"${authHeader === 'x-key' ? ' selected' : ''}>x-key</option>
                <option value="__custom"${isCustom ? ' selected' : ''}>Custom header…</option>
              </select>
              <input data-custom-provider-auth-custom type="text" value="${isCustom ? authHeader : ''}" placeholder="header-name" oninput="_settingsOnAuthCustomInput(this)" style="display:${isCustom ? 'block' : 'none'};margin-top:6px">
              <input data-custom-provider-auth type="hidden" value="${authHeader || 'bearer'}">
            `;
          })()}
        </div>
      </div>
      <label>Base URL</label>
      <input data-custom-provider-url type="text" value="${url}" placeholder="https://api.example.com/v1">
      <label>API Key</label>
      <input data-custom-provider-key type="password" value="${key}" placeholder="paste API key here">
      <div class="settings-hint" data-custom-provider-hint></div>
      <div class="settings-test-row">
        <button type="button" class="settings-test-btn" onclick="populateSettingsCustomProvider(this)">test connection &amp; load models</button>
        <span class="settings-test-result" data-custom-provider-populate-result></span>
      </div>
    </div>
  `;
}

async function populateSettingsCustomProvider(btn) {
  const row = btn.closest('.settings-custom-provider');
  const out = row.querySelector('[data-custom-provider-populate-result]');
  const v = _settingsReadCustomRow(row);
  if (!v.url) { out.className = 'settings-test-result err'; out.textContent = 'base URL required'; return; }
  if (!v.name) { out.className = 'settings-test-result err'; out.textContent = 'prefix required (e.g. "groq" — the first part of model IDs like groq/llama-3.3-70b)'; return; }
  btn.disabled = true; out.className = 'settings-test-result'; out.textContent = 'testing…';
  try {
    const r = await fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ kind: 'custom', baseUrl: v.url, apiKey: v.key, authHeader: v.authHeader }),
    });
    const d = await r.json();
    if (!d.ok) {
      // Friendlier error surfacing
      const raw = String(d.error || ('HTTP ' + r.status));
      let msg = raw;
      if (/401|unauthori[sz]ed|invalid[_ ]api/i.test(raw)) {
        msg = 'API key rejected — double-check you copied the full key and the auth header matches the provider';
      } else if (/404|not found/i.test(raw)) {
        msg = "Couldn't find /models at this URL. Did you paste an Anthropic-shaped or non-OpenAI-compat URL?";
      } else if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(raw)) {
        msg = "Couldn't reach the host. If it's a tailnet-only URL, make sure Tailscale is connected.";
      } else if (/getaddrinfo|ENOTFOUND|could not resolve/i.test(raw)) {
        msg = "Host not resolvable. If it's a tailnet hostname, Tailscale needs to be connected first.";
      }
      throw new Error(msg);
    }
    let withCtx = 0;
    for (const m of (d.models || [])) {
      if (!m?.id) continue;
      const ref = v.name ? `${v.name}/${m.id}` : m.id;
      // Always store the id (empty ctx is fine — powers the datalist even when
      // the provider doesn't advertise context windows)
      const prev = _settingsKnownLimits[ref];
      _settingsKnownLimits[ref] = { contextLength: m.contextLength || prev?.contextLength || 0 };
      if (m.contextLength) withCtx++;
    }
    out.className = 'settings-test-result ok';
    const n = (d.models || []).length;
    if (n === 0) {
      out.textContent = 'auth OK, but provider listed 0 models — you can still enter model IDs manually in the Routing rows';
    } else {
      out.textContent = `✓ ${n} models${withCtx ? ` · ${withCtx} with ctx` : ''}`;
    }
    if (typeof SETTINGS_MODEL_FIELDS !== 'undefined') {
      for (const [key] of SETTINGS_MODEL_FIELDS) {
        _settingsRefreshTierModelList(key);
        _settingsRefreshTierPlaceholders(key);
      }
    }
  } catch (e) {
    out.className = 'settings-test-result err';
    out.textContent = String(e.message || e).slice(0, 180);
  } finally { btn.disabled = false; }
}

function _settingsReadCustomRow(row) {
  return {
    name: (row.querySelector('[data-custom-provider-name]')?.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    url: (row.querySelector('[data-custom-provider-url]')?.value || '').trim(),
    key: (row.querySelector('[data-custom-provider-key]')?.value || '').trim(),
    authHeader: row.querySelector('[data-custom-provider-auth]')?.value || 'bearer',
  };
}

function renderSettingsModelProviderOptions() {
  const choices = _settingsProviderChoices();
  for (const [key] of SETTINGS_MODEL_FIELDS) {
    const select = document.getElementById(`settings-model-${key}-provider`);
    if (!select) continue;
    const current = select.value || select.dataset.currentValue || 'anthropic';
    select.innerHTML = choices
      .map(name => `<option value="${name}">${_settingsEscapeHtml(_settingsProviderLabel(name))}</option>`)
      .join('');
    select.value = choices.includes(current) ? current : 'anthropic';
    select.dataset.currentValue = select.value;
  }
}

function renderSettingsCustomProviders(providers = []) {
  const container = document.getElementById('settings-custom-providers');
  if (!container) return;
  const list = Array.isArray(providers) ? providers : [];
  container.innerHTML = list.length
    ? list.map(provider => _settingsCustomProviderRow(provider)).join('')
    : '<div class="settings-note" id="settings-custom-providers-empty">No custom OAI-compatible providers configured.</div>';
  renderSettingsModelProviderOptions();
}

function addSettingsCustomProvider() {
  const container = document.getElementById('settings-custom-providers');
  if (!container) return;
  const empty = document.getElementById('settings-custom-providers-empty');
  if (empty) empty.remove();
  container.insertAdjacentHTML('beforeend', _settingsCustomProviderRow({ authHeader: 'bearer' }));
  renderSettingsModelProviderOptions();
}

function removeSettingsCustomProvider(button) {
  const row = button?.closest('.settings-custom-provider');
  if (row) row.remove();
  const container = document.getElementById('settings-custom-providers');
  if (container && !container.querySelector('.settings-custom-provider')) {
    container.innerHTML = '<div class="settings-note" id="settings-custom-providers-empty">No custom OAI-compatible providers configured.</div>';
  }
  renderSettingsModelProviderOptions();
}

function onSettingsCustomProviderNameChange(input) {
  if (!input) return;
  const cleaned = String(input.value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned !== input.value) input.value = cleaned;
  renderSettingsModelProviderOptions();
}

function collectSettingsCustomProviders() {
  return [...document.querySelectorAll('.settings-custom-provider')].map((row) => ({
    name: row.querySelector('[data-custom-provider-name]')?.value.trim().toLowerCase() || '',
    url: row.querySelector('[data-custom-provider-url]')?.value.trim() || '',
    key: row.querySelector('[data-custom-provider-key]')?.value.trim() || '',
    authHeader: row.querySelector('[data-custom-provider-auth]')?.value.trim() || 'bearer',
  })).filter(provider => provider.name);
}

function setSettingsBusy(busy, message = '') {
  const { saveBtn, statusEl } = getSettingsEls();
  if (saveBtn) saveBtn.disabled = !!busy;
  if (statusEl) statusEl.textContent = message || '';
}

function populateSettingsPanel(data) {
  if (!data) return;
  document.getElementById('settings-display-name').value = data.identity?.displayName || '';
  document.getElementById('settings-nicknames').value = _settingsList(data.identity?.nicknames || []);
  document.getElementById('settings-enhanced-recall').checked = !!data.memory?.enhancedRecall;
  document.getElementById('settings-proactive-enabled').checked = !!data.proactive?.enabled;
  document.getElementById('settings-proactive-cooldown').value = data.proactive?.cooldownMinutes ?? 60;
  document.getElementById('settings-proactive-max-day').value = data.proactive?.maxPerDay ?? 5;
  document.getElementById('settings-proactive-channels').value = _settingsList(data.proactive?.channels || []);
  document.getElementById('settings-voice-enabled').checked = !!data.voice?.enabled;
  // STT provider dropdown — options come from data.voice.providers
  // (server walks plugin registrations + legacy env fallback).
  // Empty list = no STT installed; render a single disabled placeholder.
  const sttSelect = document.getElementById('settings-stt-provider');
  if (sttSelect) {
    const providers = Array.isArray(data.voice?.providers) ? data.voice.providers : [];
    sttSelect.innerHTML = '';
    if (!providers.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No STT providers installed';
      opt.disabled = true;
      sttSelect.appendChild(opt);
      sttSelect.disabled = true;
    } else {
      sttSelect.disabled = false;
      for (const p of providers) {
        const opt = document.createElement('option');
        opt.value = p.name;
        const label = p.name === 'deepgram' ? 'Deepgram'
                    : p.name === 'openai'   ? 'OpenAI Whisper'
                    : p.name;
        opt.textContent = p.configured ? label : `${label} (no key)`;
        sttSelect.appendChild(opt);
      }
      sttSelect.value = data.voice?.sttProvider || providers.find(p => p.configured)?.name || providers[0].name;
    }
  }
  document.getElementById('settings-tts-provider').value = data.voice?.ttsProvider || '';
  document.getElementById('settings-tts-voice').value = data.voice?.ttsVoice || '';
  document.getElementById('settings-edge-voice').value = data.voice?.edgeVoice || 'en-US-AriaNeural';
  document.getElementById('settings-tts-model').value = data.voice?.ttsModel || '';

  renderSettingsCustomProviders(data.providers?.custom || []);
  renderSettingsModelProviderOptions();
  for (const [key] of SETTINGS_MODEL_FIELDS) {
    const modelData = data.models?.[key] || {};
    const providerSelect = document.getElementById(`settings-model-${key}-provider`);
    const modelInput = document.getElementById(`settings-model-${key}-name`);
    if (providerSelect) {
      const providerValue = modelData.provider || 'anthropic';
      providerSelect.dataset.currentValue = providerValue;
      providerSelect.value = providerValue;
    }
    if (modelInput) modelInput.value = modelData.model || '';
    // Attach a <datalist> of known model ids to the model input — populated
    // from _settingsKnownLimits (filled by provider-populate + auto-detect).
    if (modelInput && providerSelect) {
      const listId = `settings-model-${key}-datalist`;
      if (!document.getElementById(listId)) {
        const dl = document.createElement('datalist');
        dl.id = listId;
        modelInput.parentElement?.appendChild(dl);
      }
      modelInput.setAttribute('list', listId);
      if (!modelInput.dataset.tierBound) {
        modelInput.dataset.tierBound = '1';
        modelInput.addEventListener('input', () => _settingsOnTierModelChange(key));
      }
      if (!providerSelect.dataset.tierBound) {
        providerSelect.dataset.tierBound = '1';
        providerSelect.addEventListener('change', () => {
          // Clear the old model + ctx override when switching provider —
          // otherwise a leftover value blocks the datalist typeahead and the
          // stale ctx doesn't belong to the new provider's models anyway.
          const mInp = document.getElementById(`settings-model-${key}-name`);
          const cInp = document.getElementById(`settings-model-${key}-ctx`);
          const cmpInp = document.getElementById(`settings-model-${key}-compact`);
          const moInp = document.getElementById(`settings-model-${key}-maxout`);
          const efInp = document.getElementById(`settings-model-${key}-effort`);
          if (mInp) mInp.value = '';
          if (cInp) cInp.value = '';
          if (cmpInp) cmpInp.value = '';
          if (moInp) moInp.value = '';
          if (efInp) efInp.value = 'auto';
          _settingsRefreshTierModelList(key);
          _settingsOnTierModelChange(key);
          mInp?.focus();
        });
      }
      _settingsRefreshTierModelList(key);
    }

    // Inject Max ctx + Compact-at inputs once per row, then populate from
    // data.modelLimits keyed by full model ref (provider/model).
    const row = providerSelect?.closest('.settings-model-row');
    if (row && !row.querySelector(`[data-settings-tier-ctx="${key}"]`)) {
      const testCell = row.querySelector('.settings-model-test');
      const ctxCell = document.createElement('div');
      ctxCell.className = 'settings-model-ctx';
      ctxCell.innerHTML = `<label for="settings-model-${key}-ctx">Max ctx</label><input id="settings-model-${key}-ctx" data-settings-tier-ctx="${key}" type="number" placeholder="auto" min="1" step="1024">`;
      const compactCell = document.createElement('div');
      compactCell.className = 'settings-model-compact';
      compactCell.innerHTML = `<label for="settings-model-${key}-compact">Compact at</label><input id="settings-model-${key}-compact" data-settings-tier-compact="${key}" type="number" placeholder="auto" min="1" step="1024">`;
      const maxOutCell = document.createElement('div');
      maxOutCell.className = 'settings-model-maxout';
      maxOutCell.innerHTML = `<label for="settings-model-${key}-maxout">Max out</label><input id="settings-model-${key}-maxout" data-settings-tier-maxout="${key}" type="number" placeholder="auto" min="1" step="256">`;
      const effortCell = document.createElement('div');
      effortCell.className = 'settings-model-effort';
      effortCell.innerHTML = `<label for="settings-model-${key}-effort">Thinking</label><select id="settings-model-${key}-effort" data-settings-tier-effort="${key}"><option value="auto">auto</option><option value="off">off</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select>`;
      row.insertBefore(ctxCell, testCell);
      row.insertBefore(compactCell, testCell);
      row.insertBefore(maxOutCell, testCell);
      row.insertBefore(effortCell, testCell);
    }
    const limKey = (modelData.provider && modelData.provider !== 'anthropic')
      ? `${modelData.provider}/${modelData.model || ''}`
      : (modelData.model || '');
    const lim = (data.modelLimits && limKey) ? data.modelLimits[limKey] : null;
    const detectedCtx = _settingsKnownLimits[limKey]?.contextLength;
    const ctxInput = document.getElementById(`settings-model-${key}-ctx`);
    const compactInput = document.getElementById(`settings-model-${key}-compact`);
    const maxOutInput = document.getElementById(`settings-model-${key}-maxout`);
    if (ctxInput) {
      ctxInput.value = lim?.contextWindow || '';
      ctxInput.dataset.limKey = limKey;
      _settingsRefreshTierPlaceholders(key);
      if (!ctxInput.dataset.bound) {
        ctxInput.dataset.bound = '1';
        ctxInput.addEventListener('input', () => _settingsRefreshTierPlaceholders(key));
      }
    }
    if (maxOutInput) {
      maxOutInput.value = lim?.maxTokens || '';
      maxOutInput.dataset.limKey = limKey;
    }
    const effortInput = document.getElementById(`settings-model-${key}-effort`);
    if (effortInput) {
      effortInput.value = lim?.reasoningEffort || 'auto';
      effortInput.dataset.limKey = limKey;
    }
    if (compactInput) {
      compactInput.value = lim?.compactAt || '';
      compactInput.dataset.limKey = limKey;
      _settingsRefreshTierPlaceholders(key);
    }
  }

  document.getElementById('settings-provider-anthropic-key').value = data.providers?.anthropic?.apiKey || '';
  document.getElementById('settings-provider-openai-base-url').value = data.providers?.openai?.baseUrl || '';
  document.getElementById('settings-provider-openai-key').value = data.providers?.openai?.apiKey || '';
  document.getElementById('settings-provider-openrouter-base-url').value = data.providers?.openrouter?.baseUrl || '';
  document.getElementById('settings-provider-openrouter-key').value = data.providers?.openrouter?.apiKey || '';
  document.getElementById('settings-provider-openrouter-referer').value = data.providers?.openrouter?.referer || '';
  document.getElementById('settings-provider-local-base-url').value = data.providers?.local?.baseUrl || '';
  document.getElementById('settings-provider-local-key').value = data.providers?.local?.apiKey || '';

  document.getElementById('settings-browser-backend').value = data.browser?.backend || 'zendriver';

  const inviteInput = document.getElementById('settings-invite-key');
  if (inviteInput) {
    inviteInput.value = data.inviteKey || '';
    inviteInput.type = 'password';
    const showBtn = document.getElementById('settings-invite-key-show');
    if (showBtn) showBtn.textContent = 'show';
    const inviteNote = document.getElementById('settings-invite-key-note');
    if (inviteNote) inviteNote.textContent = data.inviteKeySet
      ? 'Self-registration + acorn-cli auth are enabled.'
      : 'No invite key set — self-registration + acorn-cli auth are disabled.';
  }

  document.getElementById('settings-websearch-searxng-url').value = data.webSearch?.searxngUrl || '';
  document.getElementById('settings-websearch-searxng-key').value = data.webSearch?.searxngApiKey || '';
  document.getElementById('settings-websearch-brave-key').value = data.webSearch?.braveApiKey || '';

  document.getElementById('settings-identity-note').textContent =
    `Display name source: ${data.sources?.displayName || 'derived'} · Nicknames source: ${data.sources?.nicknames || 'derived'}`;
  document.getElementById('settings-proactive-note').textContent =
    `Persistence source: ${data.sources?.proactive || 'default'}`;
  document.getElementById('settings-voice-note').textContent =
    `${data.voice?.note || ''} Source: ${data.sources?.voice || 'default'}.`;
  document.getElementById('settings-provider-note').textContent =
    `Provider URLs, keys, and model routing persist to the instance .env and apply to future requests. Source: ${data.sources?.providers || 'env'}.`;
  document.getElementById('settings-routing-note').textContent =
    `Choose a provider prefix and model ID for each tier. Anthropic/Claude uses the raw model name without a prefix. Source: ${data.sources?.models || 'env'}.`;
  document.getElementById('settings-browser-note').textContent =
    `Default browser backend for future browser launches: ${data.browser?.backend || 'zendriver'}.`;

  document.getElementById('settings-runtime-agent-id').textContent = _settingsValue(data.identity?.agentId);
  const pubUrlInput = document.getElementById('settings-runtime-public-url-input');
  if (pubUrlInput) pubUrlInput.value = data.runtime?.publicUrl || '';
  document.getElementById('settings-runtime-web-port').textContent = _settingsValue(data.runtime?.webPort);
  document.getElementById('settings-runtime-workspace').textContent = _settingsValue(data.runtime?.workspacePath);
  document.getElementById('settings-runtime-data-dir').textContent = _settingsValue(data.runtime?.dataDir);

  // System-prompt budgets — headline knobs (runtime + total) plus the
  // collapsed all-sections grid. Inputs left blank when the current
  // value matches the default; defaults shown next to the label so
  // the user can see what they'd be overriding.
  _populateBudgetInputs(data.budgets);
  // Agent context budgets — 4 absolute knobs in the Agent tab (casual /
  // complex soft budgets, per-insert compaction trigger, tool-result
  // truncation cap). Empty = use auto-scaled default.
  _populateAgentBudgetsInputs(data.agent);

  updateErBadge(!!data.memory?.enhancedRecall);
  _applyRoleGatingToSettings();
  _populateProfileSection();
  _populateUsersSection();
  _populatePluginsTab(data.plugins || { enabled: false, hotReload: false, panes: [], dockItems: [], installed: [] });
}

const TYPE_COLORS = {
  self: '#7aa583', person: '#b48dc4', channel: '#c4a574',
  concept: '#e08a4e', rule: '#7aa3c4', project: '#9ec49e',
  tool: '#c4a574', memory: '#b48dc4', skill: '#9ec49e',
  capability: '#7aa3c4', event: '#e08a4e', preference: '#b48dc4',
  organization: '#c4a574', topic: '#8a8676', location: '#9ec49e',
  group: '#c4a574', interest: '#b48dc4', emotion: '#e08a4e',
  belief: '#b48dc4', relationship: '#9ec49e',
};
const DEFAULT_COLOR = '#8a8676';

// Family palette from the design handoff (design_handoff_node_graph),
// retuned for the Petri direction. Six families: stroke + soft fill +
// glyph color (glyph always equals stroke so labels stay legible against
// the fill). Self-node sits outside this system — it keeps its dedicated
// F01 amber/ink palette.
//
// Theme-aware: rebuilt by _buildFAM() on theme change so node colours
// stay legible in both light and dark. Light uses saturated mid-tones
// over warm paper; dark uses lighter Petri tones with soft alpha fills.
function _buildFAM() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    return {
      meta:   { name: 'Meta',   stroke: '#4a4e46', fill: 'rgba(74,78,70,0.10)',   glyph: '#4a4e46' },
      people: { name: 'People', stroke: '#3a6aa3', fill: 'rgba(58,106,163,0.10)', glyph: '#3a6aa3' },
      mind:   { name: 'Mind',   stroke: '#8a4a9c', fill: 'rgba(138,74,156,0.10)', glyph: '#8a4a9c' },
      event:  { name: 'Events', stroke: '#b8542a', fill: 'rgba(184,84,42,0.10)',  glyph: '#b8542a' },
      thing:  { name: 'Things', stroke: '#c08a2e', fill: 'rgba(192,138,46,0.10)', glyph: '#c08a2e' },
      affect: { name: 'Affect', stroke: '#9c4a4a', fill: 'rgba(156,74,74,0.10)',  glyph: '#9c4a4a' },
    };
  }
  return {
    meta:   { name: 'Meta',   stroke: '#b5b0a0', fill: 'rgba(181,176,160,0.14)', glyph: '#b5b0a0' },
    people: { name: 'People', stroke: '#7aa7d6', fill: 'rgba(122,167,214,0.14)', glyph: '#7aa7d6' },
    mind:   { name: 'Mind',   stroke: '#c29ad0', fill: 'rgba(194,154,208,0.14)', glyph: '#c29ad0' },
    event:  { name: 'Events', stroke: '#e38b5f', fill: 'rgba(227,139,95,0.14)',  glyph: '#e38b5f' },
    thing:  { name: 'Things', stroke: '#e3b567', fill: 'rgba(227,181,103,0.14)', glyph: '#e3b567' },
    affect: { name: 'Affect', stroke: '#d67a7a', fill: 'rgba(214,122,122,0.14)', glyph: '#d67a7a' },
  };
}
let FAM = _buildFAM();
// Map every node type SPORE knows to one of the six design families.
const TYPE_FAMILY = {
  self:         'meta',  // overridden visually by F01 mark anyway
  rule:         'meta',
  project:      'meta',
  organization: 'meta',
  person:       'people',
  group:        'people',
  channel:      'thing',
  tool:         'thing',
  capability:   'thing',
  skill:        'thing',
  interest:     'thing',
  concept:      'mind',
  topic:        'mind',
  belief:       'mind',
  event:        'event',
  location:     'event',
  reference:    'event',
  memory:       'affect',
  preference:   'affect',
  emotion:      'affect',
  relationship: 'affect',
};
function getFamily(type) { return FAM[TYPE_FAMILY[type] || 'meta']; }
function getFamilyKey(type) { return TYPE_FAMILY[type] || 'meta'; }

const TYPE_VISUALS = {
  // Petri direction shape mapping: self=rosette flower, person=circle,
  // concept=diamond, system-like=hexagon, tool-like=rounded square,
  // reference/temporal=triangle, rule=shield, project=pentagon. Glyphs are
  // mono-friendly single characters that render inside the shape at small
  // sizes.
  self:         { shape: 'rosette',        glyph: '@' },
  person:       { shape: 'circle',         glyph: 'P' },
  channel:      { shape: 'hexagon',        glyph: '#' },
  concept:      { shape: 'diamond',        glyph: 'C' },
  rule:         { shape: 'shield',         glyph: '!' },
  project:      { shape: 'pentagon',       glyph: 'P' },
  tool:         { shape: 'rounded-square', glyph: 'T' },
  memory:       { shape: 'pill',           glyph: 'M' },
  skill:        { shape: 'hexagon',        glyph: 'S' },
  capability:   { shape: 'rounded-square', glyph: 'C' },
  event:        { shape: 'triangle',       glyph: 'E' },
  preference:   { shape: 'pill',           glyph: '*' },
  organization: { shape: 'pentagon',       glyph: 'O' },
  topic:        { shape: 'diamond',        glyph: 'T' },
  location:     { shape: 'triangle',       glyph: 'L' },
  group:        { shape: 'circle',         glyph: 'G' },
  interest:     { shape: 'hexagon',        glyph: 'I' },
  emotion:      { shape: 'pill',           glyph: 'E' },
  belief:       { shape: 'triangle',       glyph: 'B' },
  relationship: { shape: 'octagon',        glyph: 'R' },
};

let graphData = { nodes: [], edges: [] };
let simulation, svg, gLinks, gNodes, zoom;

