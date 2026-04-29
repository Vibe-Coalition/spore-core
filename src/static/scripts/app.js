// app.js — main inline application (was lines 790-14261 of the
// pre-split graph-viewer.html monolith, ~13,470 lines).
//
// This is the catch-all extraction — preserves execution order and
// every top-level binding so existing cross-references keep working.
// Future commits split this into focused modules (chat.js, graph.js,
// onboarding.js, settings.js, etc.) — see /root/.claude/plans/.

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

  updateErBadge(!!data.memory?.enhancedRecall);
  _applyRoleGatingToSettings();
  _populateProfileSection();
  _populateUsersSection();
  _populatePluginsTab(data.plugins || { enabled: false, hotReload: false, panes: [], dockItems: [], installed: [] });
}

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
  // Built-in providers (only if they have a key set)
  const builtins = [
    ['anthropic', data.providers?.anthropic],
    ['openai', data.providers?.openai],
    ['openrouter', data.providers?.openrouter],
  ];
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
      custom: collectSettingsCustomProviders(),
    },
    browser: {
      backend: document.getElementById('settings-browser-backend').value,
    },
    publicUrl: document.getElementById('settings-runtime-public-url-input')?.value.trim() || '',
    budgets: _collectBudgetsPayload(),
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

// ── Tools menu ──
const toolsMenuBtn = document.getElementById('btn-tools-menu');
const toolsMenu = document.getElementById('tools-menu');
let _toolsMenuOpen = false;

function closeToolsSubmenus() {
  if (_graphPickerOpen) { _graphPickerOpen = false; graphPickerEl?.classList.remove('open'); }
}

toolsMenuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  _toolsMenuOpen = !_toolsMenuOpen;
  toolsMenu.style.display = _toolsMenuOpen ? 'block' : 'none';
  if (!_toolsMenuOpen) closeToolsSubmenus();
});

document.addEventListener('click', e => {
  const wrap = document.getElementById('tools-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    _toolsMenuOpen = false;
    toolsMenu.style.display = 'none';
    closeToolsSubmenus();
  }
});

document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleTheme();
});

document.getElementById('tmi-settings')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettingsPanel();
});

document.getElementById('tmi-graphs')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsMenu.style.display = 'none';
  _toolsMenuOpen = false;
  _graphPickerOpen = !_graphPickerOpen;
  if (_graphPickerOpen) { loadGraphsList(); graphPickerEl?.classList.add('open'); }
  else { graphPickerEl?.classList.remove('open'); }
});

document.getElementById('tmi-longmemeval')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsMenu.style.display = 'none';
  _toolsMenuOpen = false;
  lmeOpen();
});

// Enhanced Recall toggle
let _erEnabled = false;
const erBadge = document.getElementById('er-badge');
function updateErBadge(on) {
  _erEnabled = on;
  if (!erBadge) return;
  erBadge.textContent = on ? 'ON' : 'OFF';
  erBadge.style.background = on ? 'var(--accent2)' : 'var(--border)';
  erBadge.style.color = on ? 'var(--bg)' : 'var(--text-dim)';
}
fetch(API + '/api/enhanced-recall', { headers: authHeaders() }).then(r => r.json()).then(d => {
  updateErBadge(!!d.enhancedRecall);
}).catch(() => {});
document.getElementById('tmi-enhanced-recall')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const newState = !_erEnabled;
  updateErBadge(newState);
  fetch(API + '/api/enhanced-recall', {
    method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: newState }),
  }).then(r => r.json()).then(d => {
    toast(d.enhancedRecall ? 'Enhanced Recall ON — LLM search active' : 'Enhanced Recall OFF');
  }).catch(() => { updateErBadge(!newState); toast('Failed to update', true); });
});

// ── Auth check & login ──
let _authenticated = false;
let _userRole = null;

let _currentUserName = 'Operator';
async function checkAuthState() {
  try {
    const r = await fetch(API + '/api/auth/check');
    const data = await r.json();
    if (data.role) _userRole = data.role;
    if (data.username) _currentUserName = data.username;
    const authed = (data.authenticated && (data.role === 'admin' || data.role === 'creator' || data.role === 'webapp'))
      || (!data.needsAuth && !data.hasWebappUsers);
    if (authed && !data.role && !data.needsAuth) _userRole = 'admin';
    return { ok: authed, wizardNeeded: !!data.wizardNeeded };
  } catch {}
  return { ok: false, wizardNeeded: false };
}

function showApp() {
  _authenticated = true;
  document.getElementById('app').classList.remove('hidden');
  loadGraphThemePreference();
  if (_userRole !== 'admin') {
    document.getElementById('tmi-longmemeval')?.remove();
    document.getElementById('lme-hud')?.remove();
  }
  // Webapp users get a stripped dock — no files / logs / terminal access.
  _applyDockRoleGate();
  // Pull the user's chosen displayName so the agent can address them properly.
  _loadCurrentUserProfile();
  if (typeof initApp === 'function') initApp();
  // Mode-selector pill needs a re-measure now that the canvas is visible.
  // Use a double rAF so layout settles before measuring.
  if (typeof window._updateViewModePill === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(window._updateViewModePill));
  }
}

function _applyDockRoleGate() {
  const isCreator = _userRole === 'creator' || _userRole === 'admin';
  // Webapp users only need: chat, node (graph), settings.
  const hide = isCreator ? [] : ['dock-files', 'dock-logs', 'dock-terminal', 'rp-tab-files', 'rp-tab-logs'];
  for (const id of hide) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

let _currentUserDisplayName = '';
async function _loadCurrentUserProfile() {
  try {
    const r = await fetch(API + '/api/preferences', { headers: authHeaders() });
    const d = await r.json();
    if (d?.displayName) _currentUserDisplayName = d.displayName;
    if (d?.username && !_currentUserName) _currentUserName = d.username;
  } catch {}
}

// Login lives at /login.html — the SPA just redirects there when unauthenticated.


// Hardcoded fallback palette (Petri dark — warm earth). Used when the CSS
// `--node-*` var isn't defined for a given type, or before theme application.
// `getColor()` prefers the CSS var so theme switches retint the graph live.
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

// ── Spore activity tracker ──────────────────────────────────────────────
// Tracks whatever subsystems are currently doing work (chat, learner,
// session summarize/distill, tools…) and reflects it visually as a pulse
// on the agent's `self` node in the graph. Multiple activities can be
// active at once; the visual stays on until all have ended.
//
// Stale-source watchdog: each source carries the timestamp it was last
// touched (start OR end). Every SPORE_WATCHDOG_TICK ms we evict any
// source whose timestamp is older than SPORE_SOURCE_TTL — this recovers
// quickly when a `*:done` frame is lost (network drop, server crash,
// upstream throwing without our catch path emitting done) instead of
// waiting on the global 5-minute safety timer.
const _sporeActiveSources = new Map();          // source → lastTouchedMs
let _sporeActivitySafetyTimer = null;
let _sporeLastEventAt = 0;
let _sporeLastEventOp = '';                     // last source that fired
let _chatLastDoneAt = 0;                        // for stragglers guard
const SPORE_SOURCE_TTL = 90 * 1000;
const SPORE_WATCHDOG_TICK = 15 * 1000;

// Activity transitions are debounced: if the source set briefly empties
// (e.g. chat:done arrives just before learner:start) we don't want to
// fire idle → active back-to-back. We commit the idle state only if
// we've actually been idle for SPORE_IDLE_DEBOUNCE ms.
let _sporeActiveLast = false;
let _sporeIdleTimer = null;
const SPORE_IDLE_DEBOUNCE = 700;
function _sporeActivityCommit(active) {
  if (active === _sporeActiveLast) return;
  _sporeActiveLast = active;
  document.body.classList.toggle('spore-active', active);
  _selfAnimSetActive(active);
  // Diagnostic — surfaces whether we transitioned because of a clean
  // *:done frame, the watchdog, or the safety timer. Look in devtools
  // console after a stuck-active episode to see what cleared it.
  try {
    console.log(`[spore-activity] ${active ? 'active' : 'idle'} | last-event=${_sporeLastEventOp || '(none)'} (${_sporeLastEventAt ? Math.round((Date.now() - _sporeLastEventAt)/1000) + 's ago' : 'never'}) | sources=[${[..._sporeActiveSources.keys()].join(', ')}]`);
  } catch {}
}
function _sporeActivitySync() {
  const rawActive = _sporeActiveSources.size > 0;
  if (rawActive) {
    if (_sporeIdleTimer) { clearTimeout(_sporeIdleTimer); _sporeIdleTimer = null; }
    _sporeActivityCommit(true);
  } else if (_sporeActiveLast && !_sporeIdleTimer) {
    _sporeIdleTimer = setTimeout(() => {
      _sporeIdleTimer = null;
      if (_sporeActiveSources.size === 0) _sporeActivityCommit(false);
    }, SPORE_IDLE_DEBOUNCE);
  }
}
// Sweep stale sources. Runs once every SPORE_WATCHDOG_TICK regardless
// of activity — cheap. If anything was evicted, sync so the visual
// catches up.
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [k, ts] of _sporeActiveSources) {
    if (now - ts > SPORE_SOURCE_TTL) {
      _sporeActiveSources.delete(k);
      evicted++;
      try { console.warn(`[spore-activity] watchdog evicted ${k} (last touch ${Math.round((now - ts)/1000)}s ago)`); } catch {}
    }
  }
  if (evicted) {
    _sporeLastEventOp = 'watchdog';
    _sporeLastEventAt = now;
    _sporeActivitySync();
  }
}, SPORE_WATCHDOG_TICK);

// ── F01 Six-petal mark — animation engine ───────────────────────────
// Spec lives in /mnt/user/appdata/anima/design_stuff/spore logo and node/.
// One rAF loop drives the self-node geometry through one of 11 named
// behaviors from the design system (A01-A12 minus the one-shot Spawn).
// Each anim is a pure function of (R, t) → geometry. The engine lerps
// between the previous and current animations' geometries over a
// FLOWER_FADE_MS window so transitions ease in/out smoothly instead
// of snapping when the animation switches. Random pick on each
// idle⇄active transition (and re-roll on subsequent transitions) so
// it never feels canned.
const _SELF_ANGLES = [];
for (let i = 0; i < 6; i++) _SELF_ANGLES.push(-Math.PI / 2 + (i / 6) * Math.PI * 2);
const _easeInOut = t => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
const FLOWER_FADE_MS = 700;

function _emptyGeom() {
  const spokes = [], petals = [], halos = [];
  for (let i = 0; i < 6; i++) {
    spokes.push({ x2: 0, y2: 0, sw: 0, opacity: 0 });
    petals.push({ cx: 0, cy: 0, r: 0, opacity: 0 });
    halos.push({ cx: 0, cy: 0, r: 0, opacity: 0, mode: 'stroke', sw: 0 });
  }
  return { spokes, petals, halos, center: { r: 0, opacity: 1 } };
}

// Lerp two geom snapshots. Categorical fields (halo mode) can't blend
// linearly — fade prev's halos out by p=0.5, fade new's halos in over
// the second half so the mode swap happens while the halo is invisible.
function _lerpGeom(a, b, p) {
  const lerp = (x, y) => x + (y - x) * p;
  const out = _emptyGeom();
  for (let i = 0; i < 6; i++) {
    out.spokes[i] = {
      x2: lerp(a.spokes[i].x2, b.spokes[i].x2),
      y2: lerp(a.spokes[i].y2, b.spokes[i].y2),
      sw: lerp(a.spokes[i].sw, b.spokes[i].sw),
      opacity: lerp(a.spokes[i].opacity, b.spokes[i].opacity),
    };
    out.petals[i] = {
      cx: lerp(a.petals[i].cx, b.petals[i].cx),
      cy: lerp(a.petals[i].cy, b.petals[i].cy),
      r:  lerp(a.petals[i].r,  b.petals[i].r),
      opacity: lerp(a.petals[i].opacity, b.petals[i].opacity),
    };
    if (p < 0.5) {
      out.halos[i] = { ...a.halos[i], opacity: a.halos[i].opacity * (1 - p * 2) };
    } else {
      out.halos[i] = { ...b.halos[i], opacity: b.halos[i].opacity * (p * 2 - 1) };
    }
  }
  out.center = {
    r: lerp(a.center.r, b.center.r),
    opacity: lerp(a.center.opacity, b.center.opacity),
  };
  return out;
}

function _writeGeom(sel, g) {
  for (let i = 0; i < 6; i++) {
    const sp = g.spokes[i], pt = g.petals[i], ha = g.halos[i];
    sel.select(`.self-spoke[data-i="${i}"]`)
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', sp.x2).attr('y2', sp.y2)
      .attr('stroke-width', sp.sw)
      .attr('opacity', sp.opacity);
    sel.select(`.self-petal[data-i="${i}"]`)
      .attr('cx', pt.cx).attr('cy', pt.cy).attr('r', pt.r)
      .attr('opacity', pt.opacity);
    const halo = sel.select(`.self-halo[data-i="${i}"]`);
    if (ha.mode === 'fill') {
      halo.attr('fill', 'var(--spore-amber)').attr('stroke', 'none');
    } else {
      halo.attr('fill', 'none').attr('stroke', 'var(--spore-amber)')
          .attr('stroke-width', ha.sw);
    }
    halo.attr('cx', ha.cx).attr('cy', ha.cy).attr('r', ha.r)
        .attr('opacity', ha.opacity);
  }
  sel.select('.self-center').attr('r', g.center.r).attr('opacity', g.center.opacity);
}

const _FLOWER_ANIMS = {
  // ── Idle pool ──────────────────────────────────────────────────────
  wobble: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const off = Math.sin(t * 1.8 + i * 1.1) * 0.04 * R;
      const x = ringR * Math.cos(a) + Math.cos(a + Math.PI/2) * off;
      const y = ringR * Math.sin(a) + Math.sin(a + Math.PI/2) * off;
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  breathe: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, sw = R * 0.04;
    const cycle = 2.4;
    const p = (t % cycle) / cycle;
    const breath = 0.5 + 0.5 * Math.sin(p * Math.PI * 2);
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: R * (0.13 + breath * 0.05), opacity: 1 };
    return g;
  }},
  flicker: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      const flick = 0.55 + 0.45 * Math.sin(t * 4 + i * 13.7);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: flick };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  inhale: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    const cycle = 3.0;
    const p = (t % cycle) / cycle;
    let r;
    if (p < 0.4)      r = 0.62 - _easeInOut(p / 0.4) * 0.30;
    else if (p < 0.5) r = 0.32;
    else if (p < 0.9) r = 0.32 + _easeInOut((p - 0.5) / 0.4) * 0.30;
    else              r = 0.62;
    const ringR = R * r;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  // ── Active pool ────────────────────────────────────────────────────
  bloom: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const centerR = R * 0.18, sw = R * 0.04;
    const cycle = 4.0;
    const p = (t % cycle) / cycle;
    let amp;
    if (p < 0.4)      amp = _easeInOut(p / 0.4);
    else if (p < 0.7) amp = 1;
    else              amp = _easeInOut(1 - (p - 0.7) / 0.3);
    const ringR = R * (0.18 + amp * 0.46);
    const petalR = R * (0.06 + amp * 0.10);
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: amp };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  seqbloom: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 3.0;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const slot = i / 6;
      const local = (p - slot + 1) % 1;
      const lit = local < 0.6;
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: lit ? 1 : 0.18 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: lit ? 1 : 0.18 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  pulseOut: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 1.4;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 0.6 + p * 0.4 };
      const bulletR = R * (0.05 + (1 - p) * 0.03);
      g.halos[i] = { cx: x * p, cy: y * p, r: bulletR, opacity: 1 - p * 0.4, mode: 'fill', sw: 0 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  pulseIn: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, sw = R * 0.03;
    const cycle = 1.4;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const bulletR = R * (0.05 + p * 0.04);
      g.halos[i] = { cx: x * (1 - p), cy: y * (1 - p), r: bulletR, opacity: 1 - (1 - p) * 0.4, mode: 'fill', sw: 0 };
    }
    g.center = { r: R * (0.16 + (1 - p) * 0.04), opacity: 1 };
    return g;
  }},
  rotation: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const angOff = (t * 18 * Math.PI) / 180;  // 18°/s
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i] + angOff;
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  listen: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 2.0;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const slot = i / 6;
      const local = (p - slot + 1) % 1;
      const halo = local < 0.4 ? 1 - local / 0.4 : 0;
      const haloR = R * (0.13 + halo * 0.18);
      g.halos[i] = { cx: x, cy: y, r: haloR, opacity: halo, mode: 'stroke', sw: R * 0.025 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  rings: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 2.5;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const slot = (i % 3) / 3;
      const local = (p - slot + 1) % 1;
      const haloR = R * (0.13 + local * 0.30);
      const op = local < 0.7 ? (1 - local / 0.7) * 0.6 : 0;
      g.halos[i] = { cx: x, cy: y, r: haloR, opacity: op, mode: 'stroke', sw: R * 0.018 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
};
const _IDLE_KEYS = Object.keys(_FLOWER_ANIMS).filter(k => _FLOWER_ANIMS[k].kind === 'idle');
const _ACTIVE_KEYS = Object.keys(_FLOWER_ANIMS).filter(k => _FLOWER_ANIMS[k].kind === 'active');

const _selfAnim = {
  current: null, startMs: 0,
  prev: null, prevStartMs: 0, fadeStartMs: 0,
  raf: null,
};
function _flowerEachSelf(fn) {
  const groups = document.querySelectorAll('.graph-node[data-node-type="self"]');
  groups.forEach(g => {
    const sel = d3.select(g);
    const datum = sel.datum();
    const R = (datum && datum.radius) || 14;
    fn(sel, R);
  });
}
function _pickAnim(kind) {
  // Idle is fixed to wobble — keeps the resting state visually consistent
  // across refreshes and across the idle⇄active⇄idle cycle. Active stays
  // randomized so each work session reads as its own moment.
  if (kind === 'idle') return 'wobble';
  const pool = _ACTIVE_KEYS;
  if (!pool.length) return null;
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && pick === _selfAnim.current) {
    pick = pool[(pool.indexOf(pick) + 1) % pool.length];
  }
  return pick;
}
function _selfAnimTick(now) {
  if (!_selfAnim.startMs) _selfAnim.startMs = now;
  const t = (now - _selfAnim.startMs) / 1000;
  const def = _FLOWER_ANIMS[_selfAnim.current];
  if (def) {
    let fading = false;
    let fadeP = 0;
    if (_selfAnim.prev && _selfAnim.fadeStartMs) {
      fadeP = (now - _selfAnim.fadeStartMs) / FLOWER_FADE_MS;
      if (fadeP >= 1) {
        _selfAnim.prev = null;
        _selfAnim.prevStartMs = 0;
        _selfAnim.fadeStartMs = 0;
      } else {
        fading = true;
      }
    }
    _flowerEachSelf((sel, R) => {
      const newG = def.fn(R, t);
      let g = newG;
      if (fading) {
        const prevDef = _FLOWER_ANIMS[_selfAnim.prev];
        if (prevDef) {
          const prevT = (now - _selfAnim.prevStartMs) / 1000;
          const prevG = prevDef.fn(R, prevT);
          g = _lerpGeom(prevG, newG, _easeInOut(fadeP));
        }
      }
      _writeGeom(sel, g);
    });
  }
  _selfAnim.raf = requestAnimationFrame(_selfAnimTick);
}
function _selfAnimSetActive(active) {
  const next = _pickAnim(active ? 'active' : 'idle');
  if (!next) return;
  if (next === _selfAnim.current) return;  // no-op pick-same (shouldn't usually happen)
  // Capture the current anim as "prev" for the cross-fade.
  if (_selfAnim.current) {
    _selfAnim.prev = _selfAnim.current;
    _selfAnim.prevStartMs = _selfAnim.startMs;  // keep its time origin so it
                                                // continues evolving during fade
    _selfAnim.fadeStartMs = performance.now();
  }
  _selfAnim.current = next;
  _selfAnim.startMs = 0;
  if (!_selfAnim.raf) _selfAnim.raf = requestAnimationFrame(_selfAnimTick);
}
// Kick off the idle loop early. _flowerEachSelf is a no-op until the
// first self-node lands in the DOM, so this is safe pre-initGraph.
_selfAnimSetActive(false);
function _sporeActivityStart(source) {
  if (!source) return;
  const now = Date.now();
  _sporeActiveSources.set(source, now);
  _sporeLastEventOp = source + ':start';
  _sporeLastEventAt = now;
  _sporeActivitySync();
  if (_sporeActivitySafetyTimer) clearTimeout(_sporeActivitySafetyTimer);
  _sporeActivitySafetyTimer = setTimeout(() => {
    if (_sporeActiveSources.size > 0) {
      try { console.warn(`[spore-activity] safety timer cleared ${_sporeActiveSources.size} stuck source(s): ${[..._sporeActiveSources.keys()].join(', ')}`); } catch {}
    }
    _sporeActiveSources.clear();
    _sporeLastEventOp = 'safety-timer';
    _sporeLastEventAt = Date.now();
    _sporeActivitySync();
  }, 5 * 60 * 1000);
}
function _sporeActivityEnd(source) {
  if (!source) return;
  const had = _sporeActiveSources.delete(source);
  if (had) {
    _sporeLastEventOp = source + ':done';
    _sporeLastEventAt = Date.now();
  }
  _sporeActivitySync();
  if (_sporeActiveSources.size === 0 && _sporeActivitySafetyTimer) {
    clearTimeout(_sporeActivitySafetyTimer);
    _sporeActivitySafetyTimer = null;
  }
}
function _sporeActivityPulse(source, ms = 1200) {
  _sporeActivityStart(source);
  setTimeout(() => _sporeActivityEnd(source), ms);
}
window._sporeActivity = {
  start: _sporeActivityStart,
  end: _sporeActivityEnd,
  pulse: _sporeActivityPulse,
  sources: () => [..._sporeActiveSources.entries()],  // for live debugging
};
let selectedNode = null;
let selectedNodeIds = new Set();
let hoveredNodeId = null;
let _selectionRect = null;
let _graphMarquee = { active: false, moved: false, startX: 0, startY: 0 };
let _suppressNextGraphClick = false;
let _currentZoomScale = 1;
let _graphFocusedId = null;
let _graphPreFocusTransform = null;
let _tickScheduled = false;
let _needsTick = false;
let _labelLayoutTimer = null;

function getColor(type) {
  // Family-based palette (design_handoff_node_graph). Returns the family's
  // stroke colour — used for outlines and glyphs. Self-node still resolves
  // through the legacy CSS var path so its theme-aware override (ink in
  // light, cream in dark) keeps working.
  if (type === 'self') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--node-' + type).trim();
    return v || TYPE_COLORS[type] || DEFAULT_COLOR;
  }
  return getFamily(type).stroke;
}
// Edge weight classification (design_handoff_node_graph).
//   strong  — direct, primary edges. width 2.0, opacity 0.85, no dash.
//   normal  — ordinary edges.        width 1.4, opacity 0.6,  no dash.
//   soft    — inferred / weak.       width 1.0, opacity 0.45, dash 4 4.
// Heuristic: any edge directly connecting the self-node is "strong"; an
// edge whose source.weight (an aggregate from extraction) is >= 3 is
// "normal"; otherwise "soft". Falls back to "normal" when nothing is
// known about the edge.
function getEdgeKind(d) {
  const sId = (d?.source?.id || d?.source);
  const tId = (d?.target?.id || d?.target);
  // Touching the self-node always reads as a primary relation.
  const selfNode = (graphData?.nodes || []).find(n => n.type === 'self');
  if (selfNode && (sId === selfNode.id || tId === selfNode.id)) return 'strong';
  const w = Number(d?.weight);
  if (Number.isFinite(w)) {
    if (w >= 3) return 'normal';
    return 'soft';
  }
  return 'normal';
}
const EDGE_KIND = {
  strong: { width: 2.0, opacity: 0.55, dash: null },
  normal: { width: 1.4, opacity: 0.38, dash: null },
  soft:   { width: 1.0, opacity: 0.25, dash: '4 4' },
};
function getFillColor(type) {
  // The soft, harmonised fill paired with the family stroke. Used as the
  // node-circle fill (no fill-opacity needed — the colour is already soft).
  if (type === 'self') return 'transparent';
  return getFamily(type).fill;
}
function getNodeVisual(type) {
  return TYPE_VISUALS[type] || { shape: 'circle', glyph: String(type || '?').slice(0, 1).toUpperCase() };
}

function _polygonPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + ' Z';
}

function _circlePath(radius) {
  return `M0 ${(-radius).toFixed(2)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 1 0 ${radius.toFixed(2)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 1 0 ${(-radius).toFixed(2)} Z`;
}

function _roundedRectPath(width, height, cornerRadius) {
  const hw = width / 2;
  const hh = height / 2;
  const rr = Math.min(cornerRadius, hw, hh);
  return [
    `M${(-hw + rr).toFixed(2)} ${(-hh).toFixed(2)}`,
    `H${(hw - rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${hw.toFixed(2)} ${(-hh + rr).toFixed(2)}`,
    `V${(hh - rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(hw - rr).toFixed(2)} ${hh.toFixed(2)}`,
    `H${(-hw + rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(-hw).toFixed(2)} ${(hh - rr).toFixed(2)}`,
    `V${(-hh + rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(-hw + rr).toFixed(2)} ${(-hh).toFixed(2)}`,
    'Z',
  ].join(' ');
}

function getNodeShapePath(type, radius) {
  const { shape } = getNodeVisual(type);
  switch (shape) {
    case 'diamond':
      return _polygonPath([[0, -radius * 1.05], [radius * 0.92, 0], [0, radius * 1.05], [-radius * 0.92, 0]]);
    case 'square': {
      const side = radius * 0.88;
      return _polygonPath([[-side, -side], [side, -side], [side, side], [-side, side]]);
    }
    case 'rounded-square': {
      // Petri: tool-like nodes — rotated rounded square
      const s = radius * 1.0;
      return _roundedRectPath(s * 2, s * 2, s * 0.32);
    }
    case 'triangle':
      return _polygonPath([[0, -radius * 1.08], [radius * 0.94, radius * 0.82], [-radius * 0.94, radius * 0.82]]);
    case 'hexagon': {
      const rx = radius * 0.98;
      const ry = radius * 0.84;
      return _polygonPath([[-rx, 0], [-rx * 0.5, -ry], [rx * 0.5, -ry], [rx, 0], [rx * 0.5, ry], [-rx * 0.5, ry]]);
    }
    case 'pentagon': {
      // Petri: project nodes — five-sided, point up
      const pts = Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return [Math.cos(a) * radius * 1.10, Math.sin(a) * radius * 1.10];
      });
      return _polygonPath(pts);
    }
    case 'shield': {
      // Petri: rule nodes — pointed-bottom shield
      const w = radius * 1.05;
      const h = radius * 1.20;
      return [
        `M${(-w).toFixed(2)} ${(-h * 0.6).toFixed(2)}`,
        `L0 ${(-h).toFixed(2)}`,
        `L${w.toFixed(2)} ${(-h * 0.6).toFixed(2)}`,
        `L${(w * 0.7).toFixed(2)} ${(h * 0.8).toFixed(2)}`,
        `L0 ${h.toFixed(2)}`,
        `L${(-w * 0.7).toFixed(2)} ${(h * 0.8).toFixed(2)}`,
        'Z',
      ].join(' ');
    }
    case 'rosette': {
      // Petri's signature: six-petal flower — used for the agent's self node.
      // Returns a single composite path: six overlapping circles + a small
      // center disc punched out, all unioned via even-odd fill.
      const petalR = radius * 0.55;
      const ringR = radius * 0.70;
      const parts = Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2;
        const cx = Math.cos(a) * ringR;
        const cy = Math.sin(a) * ringR;
        return `M${cx.toFixed(2)} ${(cy - petalR).toFixed(2)} `
             + `A${petalR.toFixed(2)} ${petalR.toFixed(2)} 0 1 1 ${cx.toFixed(2)} ${(cy + petalR).toFixed(2)} `
             + `A${petalR.toFixed(2)} ${petalR.toFixed(2)} 0 1 1 ${cx.toFixed(2)} ${(cy - petalR).toFixed(2)} Z`;
      });
      const coreR = radius * 0.42;
      parts.push(
        `M0 ${(-coreR).toFixed(2)} `
        + `A${coreR.toFixed(2)} ${coreR.toFixed(2)} 0 1 0 0 ${coreR.toFixed(2)} `
        + `A${coreR.toFixed(2)} ${coreR.toFixed(2)} 0 1 0 0 ${(-coreR).toFixed(2)} Z`
      );
      return parts.join(' ');
    }
    case 'octagon': {
      const edge = radius * 0.44;
      const outer = radius * 0.96;
      return _polygonPath([[-edge, -outer], [edge, -outer], [outer, -edge], [outer, edge], [edge, outer], [-edge, outer], [-outer, edge], [-outer, -edge]]);
    }
    case 'pill':
      return _roundedRectPath(radius * 2.18, radius * 1.42, radius * 0.52);
    case 'circle':
    default:
      return _circlePath(radius);
  }
}

function getNodeGlyph(type) {
  return getNodeVisual(type).glyph;
}

function _nodeLabelText(node) {
  const label = String(node?.label || node?.id || 'untitled');
  return label.length > 20 ? label.slice(0, 18) + '…' : label;
}

function _hashStringNumber(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _phyllotaxisSeed(index, width, height) {
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const radius = 30 * Math.sqrt(index + 1);
  return {
    x: (width / 2) + (Math.cos(angle) * radius),
    y: (height / 2) + (Math.sin(angle) * radius),
  };
}

function _clampSeedToViewport(point, width, height, pad = 36) {
  return {
    x: Math.max(pad, Math.min(width - pad, point.x)),
    y: Math.max(pad, Math.min(height - pad, point.y)),
  };
}

function _stableSeedOffset(nodeId, radius = 26) {
  const hash = _hashStringNumber(nodeId);
  const angle = ((hash % 3600) / 3600) * Math.PI * 2;
  const magnitude = radius * (0.72 + (((hash >>> 11) % 1000) / 1000) * 0.55);
  return {
    x: Math.cos(angle) * magnitude,
    y: Math.sin(angle) * magnitude,
  };
}

function _graphNodeId(ref) {
  return ref?.id || ref;
}

function _hasFiniteNodePosition(node) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.y);
}

// Pre-cluster: place each unpositioned node inside its type's treemap rect
// using phyllotaxis (golden-angle spiral) sized to fit the rect. Big types get
// nodes spread across a big rect; singletons get placed dead-center in their
// tiny rect.
function _seedNodesByType(nodes, width, height) {
  if (!nodes?.length) return;
  const anchors = _typeClusterAnchors(nodes, width, height);
  if (!anchors.size) return;
  const byType = new Map();
  for (const n of nodes) {
    if (_hasFiniteNodePosition(n)) continue;
    const t = String(n?.type || 'unknown');
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(n);
  }
  for (const [t, list] of byType.entries()) {
    const anchor = anchors.get(t);
    if (!anchor) continue;
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const maxR = Math.max(8, Math.min(anchor.w, anchor.h) / 2 - 8);
    if (list.length === 1) {
      list[0].x = anchor.x;
      list[0].y = anchor.y;
      continue;
    }
    // Phyllotaxis radius scales so the outermost node lands near the edge.
    const baseR = Math.max(6, maxR / Math.sqrt(list.length));
    const step = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < list.length; i++) {
      const r = Math.min(maxR, baseR * Math.sqrt(i + 0.5));
      const angle = i * step;
      list[i].x = anchor.x + Math.cos(angle) * r;
      list[i].y = anchor.y + Math.sin(angle) * r;
    }
  }
}

function _neighborSeedPosition(nodeId, edgeData, nodeById, width, height, fallbackIndex = 0) {
  const neighbors = [];
  for (const edge of edgeData || []) {
    const sourceId = _graphNodeId(edge.source);
    const targetId = _graphNodeId(edge.target);
    let neighborId = null;
    if (sourceId === nodeId) neighborId = targetId;
    else if (targetId === nodeId) neighborId = sourceId;
    if (!neighborId) continue;
    const neighbor = nodeById[neighborId];
    if (_hasFiniteNodePosition(neighbor)) neighbors.push(neighbor);
  }

  if (!neighbors.length) {
    return _clampSeedToViewport(_phyllotaxisSeed(fallbackIndex, width, height), width, height);
  }

  const centroid = neighbors.reduce((acc, node) => {
    acc.x += node.x;
    acc.y += node.y;
    return acc;
  }, { x: 0, y: 0 });
  centroid.x /= neighbors.length;
  centroid.y /= neighbors.length;

  const offset = _stableSeedOffset(nodeId, Math.min(42, 18 + (neighbors.length * 4)));
  return _clampSeedToViewport({
    x: centroid.x + offset.x,
    y: centroid.y + offset.y,
  }, width, height);
}

function _graphForceProfile(nodeCount) {
  const isLarge = nodeCount > 150;
  const isHuge = nodeCount > 280;
  return {
    // Very gentle, very local charge. Collision handles "don't overlap";
    // charge just adds a touch of springiness within the cluster. distanceMax
    // is small enough that a node can't influence another type's region.
    chargeStrength: isHuge ? -18 : (isLarge ? -25 : -50),
    chargeTheta: isLarge ? 0.9 : 0.8,
    chargeMaxDist: isHuge ? 70 : 110,
    linkDistance: isLarge ? 60 : 80,
    linkStrength: isHuge ? 0.05 : (isLarge ? 0.08 : 0.15),
    collisionPad: isLarge ? 3 : 4,
    collisionIterations: isLarge ? 1 : 2,
    // Heavy damping kills oscillation fast.
    velocityDecay: isHuge ? 0.78 : (isLarge ? 0.7 : 0.6),
    axisStrength: 0,
    // Gentler anchor pull — collision needs room to spread nodes within
    // their treemap rect. Too-strong pull packs them on top of each other.
    clusterStrength: isHuge ? 0.18 : (isLarge ? 0.15 : 0.12),
    refreshAlpha: isLarge ? 0.02 : 0.035,
    dragAlpha: isLarge ? 0.08 : 0.12,
    restartAlpha: isLarge ? 0.05 : 0.08,
    warmTicks: nodeCount > 60 ? Math.min(120, Math.round(28 + Math.sqrt(nodeCount) * 4)) : 0,
  };
}

// Box-based collision that includes the bottom-placed label as part of the
// node's footprint. Circular collide can't separate horizontally-adjacent
// labels — only this can. Quadtree-pruned for O(n log n) per tick.
function _createLabelBoxCollide() {
  let nodes = [];
  let strength = 1.0;
  let padding = 4;
  let iterations = 2;

  function runOnce() {
    const boxes = new Array(nodes.length);
    let maxHalfW = 0, maxHalfH = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const r = n.radius || 12;
      const labelChars = Math.min((n.label || n.id || '').toString().length, 20);
      const labelW = Math.min(Math.max(labelChars * 6.9, 20), 145);
      const labelH = 16;
      const gap = 3;
      const halfW = Math.max(r, labelW / 2) + padding;
      const top = -r - padding;
      const bottom = r + gap + labelH + padding;
      const halfH = (bottom - top) / 2;
      const cyOffset = (top + bottom) / 2;
      const x = (n.x || 0) + (n.vx || 0);
      const y = (n.y || 0) + (n.vy || 0);
      const cx = x;
      const cy = y + cyOffset;
      if (halfW > maxHalfW) maxHalfW = halfW;
      if (halfH > maxHalfH) maxHalfH = halfH;
      boxes[i] = {
        node: n, idx: i, cx, cy, halfW, halfH, cyOffset,
        left: cx - halfW, right: cx + halfW,
        top: cy - halfH, bottom: cy + halfH,
      };
    }

    const tree = d3.quadtree().x(b => b.cx).y(b => b.cy).addAll(boxes);

    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      const sLeft = a.left - maxHalfW;
      const sRight = a.right + maxHalfW;
      const sTop = a.top - maxHalfH;
      const sBottom = a.bottom + maxHalfH;
      tree.visit((quad, x0, y0, x1, y1) => {
        if (x0 > sRight || x1 < sLeft || y0 > sBottom || y1 < sTop) return true;
        if (!quad.length) {
          let leaf = quad;
          do {
            const b = leaf.data;
            if (b && b.idx > a.idx) {
              const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              if (overlapX > 0) {
                const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (overlapY > 0) {
                  if (overlapX < overlapY) {
                    let dir = Math.sign(a.cx - b.cx) || 1;
                    const push = overlapX * 0.5 * strength;
                    a.node.x = (a.node.x || 0) + dir * push;
                    b.node.x = (b.node.x || 0) - dir * push;
                  } else {
                    let dir = Math.sign(a.cy - b.cy) || 1;
                    const push = overlapY * 0.5 * strength;
                    a.node.y = (a.node.y || 0) + dir * push;
                    b.node.y = (b.node.y || 0) - dir * push;
                  }
                }
              }
            }
            leaf = leaf.next;
          } while (leaf);
        }
        return false;
      });
    }
  }

  function force() {
    if (!nodes.length) return;
    for (let it = 0; it < iterations; it++) runOnce();
  }

  force.initialize = function(_nodes) { nodes = _nodes || []; };
  force.strength = function(s) { if (!arguments.length) return strength; strength = +s || 0; return force; };
  force.iterations = function(v) { if (!arguments.length) return iterations; iterations = Math.max(1, +v || 1); return force; };
  force.padding = function(p) { if (!arguments.length) return padding; padding = +p || 0; return force; };
  return force;
}

// Treemap-based type anchors: each type gets a rectangle whose AREA scales
// with node count. A type with 70 nodes gets ~70× the canvas area of a
// singleton type. Anchor = rect center; rect dimensions are exposed so the
// pre-seeder knows how much space to spread across.
function _typeClusterAnchors(nodes, width, height) {
  const counts = new Map();
  for (const node of nodes || []) {
    const type = String(node?.type || 'unknown');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const anchors = new Map();
  if (!counts.size) return anchors;

  // Strong super-linear weighting so big types get the room their nodes need
  // for label-bbox collision. n^1.4 means: singleton=1, n=10 → 25, n=70 → 410.
  // This is necessary because 70 label-aware footprints need MUCH more area
  // than 70× a single footprint due to packing inefficiency.
  const childData = [...counts.entries()].map(([type, n]) => ({
    type,
    value: Math.pow(n + 0.5, 1.4),
  }));
  const root = d3.hierarchy({ children: childData })
    .sum(d => d.value)
    .sort((a, b) => b.value - a.value);
  d3.treemap()
    .tile(d3.treemapSquarify.ratio(1.3))
    .size([width, height])
    .paddingInner(14)
    .paddingOuter(10)
    .round(true)(root);

  for (const leaf of root.leaves()) {
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    anchors.set(leaf.data.type, {
      x: (leaf.x0 + leaf.x1) / 2,
      y: (leaf.y0 + leaf.y1) / 2,
      w, h,
    });
  }
  return anchors;
}

function _createTypeClusterForce(width, height) {
  let nodes = [];
  let strength = 0.06;
  let size = { width: width || 0, height: height || 0 };
  let anchors = new Map();

  function rebuildAnchors() {
    anchors = _typeClusterAnchors(nodes, size.width || window.innerWidth, size.height || window.innerHeight);
  }

  function force(alpha) {
    if (!nodes.length) return;
    const pull = Math.max(0.25, alpha) * strength;
    for (const node of nodes) {
      const anchor = anchors.get(String(node?.type || 'unknown'));
      if (!anchor) continue;
      node.vx = (node.vx || 0) + ((anchor.x - (node.x || 0)) * pull);
      node.vy = (node.vy || 0) + ((anchor.y - (node.y || 0)) * pull);
    }
  }

  force.initialize = function(_nodes) {
    nodes = _nodes || [];
    rebuildAnchors();
  };
  force.strength = function(value) {
    if (!arguments.length) return strength;
    strength = Math.max(0, +value || 0);
    return force;
  };
  force.size = function(nextWidth, nextHeight) {
    if (!arguments.length) return { ...size };
    size = {
      width: nextWidth || size.width,
      height: nextHeight || size.height,
    };
    rebuildAnchors();
    return force;
  };

  return force;
}

function _boxesOverlap(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function _boxIntersectsCircle(box, cx, cy, r) {
  const closestX = Math.max(box.left, Math.min(cx, box.right));
  const closestY = Math.max(box.top, Math.min(cy, box.bottom));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx) + (dy * dy) <= (r * r);
}

function _estimateNodeLabelBox(node, transform) {
  const text = _nodeLabelText(node);
  const scale = transform?.k || 1;
  const width = Math.min(Math.max(text.length * 6.1, 18), 150) * scale;
  const height = 12 * scale;
  const screenX = transform.applyX(node.x || 0);
  const screenY = transform.applyY(node.y || 0);
  const screenRadius = ((node.radius || 12) + 4) * scale;
  const top = screenY + screenRadius + (6 * scale);
  return {
    left: screenX - (width / 2),
    right: screenX + (width / 2),
    top,
    bottom: top + height,
  };
}

function _labelMetrics(node, scale) {
  const localWidth = Math.min(Math.max(_nodeLabelText(node).length * 6.1, 18), 150);
  const localHeight = 12;
  return {
    localWidth,
    localHeight,
    width: localWidth * scale,
    height: localHeight * scale,
  };
}

function _labelLocalPlacementCandidates(node, centerX, centerY, metrics = _labelMetrics(node, 1)) {
  const localGap = (node.radius || 12) + 2;
  const horizontalTop = -(metrics.localHeight / 2);
  const verticalLeft = -(metrics.localWidth / 2);
  const verticalRight = metrics.localWidth / 2;
  const positions = {
    top: {
      attrs: { x: 0, y: -(localGap + (metrics.localHeight / 2)), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: -localGap - metrics.localHeight,
        bottom: -localGap,
      },
    },
    bottom: {
      attrs: { x: 0, y: localGap + (metrics.localHeight / 2), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: localGap,
        bottom: localGap + metrics.localHeight,
      },
    },
    right: {
      attrs: { x: localGap, y: 0, anchor: 'start', baseline: 'middle' },
      box: {
        left: localGap,
        right: localGap + metrics.localWidth,
        top: horizontalTop,
        bottom: horizontalTop + metrics.localHeight,
      },
    },
    left: {
      attrs: { x: -localGap, y: 0, anchor: 'end', baseline: 'middle' },
      box: {
        left: -localGap - metrics.localWidth,
        right: -localGap,
        top: horizontalTop,
        bottom: horizontalTop + metrics.localHeight,
      },
    },
  };

  return _labelCandidateOrder(node.x || 0, node.y || 0, centerX, centerY).map((name) => ({
    name,
    attrs: positions[name].attrs,
    box: positions[name].box,
  }));
}

function _preferredLabelPlacement(node, centerX, centerY, metrics = _labelMetrics(node, 1)) {
  return _labelLocalPlacementCandidates(node, centerX, centerY, metrics).find((candidate) => candidate.name === 'bottom')
    || _labelLocalPlacementCandidates(node, centerX, centerY, metrics)[0];
}

function _nodeFootprint(node, centerX, centerY) {
  const metrics = _labelMetrics(node, 1);
  const placement = _preferredLabelPlacement(node, centerX, centerY, metrics);
  const radius = (node.radius || 12) + 4;
  const pad = 3;
  return {
    metrics,
    placement,
    box: {
      left: Math.min(-radius, placement.box.left) - pad,
      right: Math.max(radius, placement.box.right) + pad,
      top: Math.min(-radius, placement.box.top) - pad,
      bottom: Math.max(radius, placement.box.bottom) + pad,
    },
  };
}

function _labelCandidateOrder(screenX, screenY, centerX, centerY) {
  const outwardHorizontal = screenX < centerX ? 'left' : 'right';
  const outwardVertical = screenY < centerY ? 'top' : 'bottom';
  return [
    outwardHorizontal,
    outwardVertical,
    outwardHorizontal === 'left' ? 'right' : 'left',
    outwardVertical === 'top' ? 'bottom' : 'top',
  ];
}

function _labelPlacementCandidates(node, transform, metrics) {
  const scale = transform?.k || 1;
  const screenX = transform.applyX(node.x || 0);
  const screenY = transform.applyY(node.y || 0);
  const centerX = (svg?.node()?.clientWidth || window.innerWidth) / 2;
  const centerY = (svg?.node()?.clientHeight || window.innerHeight) / 2;
  const localGap = (node.radius || 12) + 8;
  const horizontalTop = screenY - (metrics.height / 2);
  const verticalLeft = screenX - (metrics.width / 2);
  const verticalRight = screenX + (metrics.width / 2);
  const positions = {
    top: {
      attrs: { x: 0, y: -(localGap + (metrics.localHeight / 2)), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: screenY - (localGap * scale) - metrics.height,
        bottom: screenY - (localGap * scale),
      },
    },
    bottom: {
      attrs: { x: 0, y: localGap + (metrics.localHeight / 2), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: screenY + (localGap * scale),
        bottom: screenY + (localGap * scale) + metrics.height,
      },
    },
    right: {
      attrs: { x: localGap, y: 0, anchor: 'start', baseline: 'middle' },
      box: {
        left: screenX + (localGap * scale),
        right: screenX + (localGap * scale) + metrics.width,
        top: horizontalTop,
        bottom: horizontalTop + metrics.height,
      },
    },
    left: {
      attrs: { x: -localGap, y: 0, anchor: 'end', baseline: 'middle' },
      box: {
        left: screenX - (localGap * scale) - metrics.width,
        right: screenX - (localGap * scale),
        top: horizontalTop,
        bottom: horizontalTop + metrics.height,
      },
    },
  };

  return _labelCandidateOrder(screenX, screenY, centerX, centerY).map((name) => ({
    name,
    attrs: positions[name].attrs,
    box: positions[name].box,
  }));
}

function _overlapArea(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function _smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - (2 * t));
}

function _labelPlacementPenalty(candidate, nodeId, circles, placedBoxes) {
  let penalty = 0;
  for (const circle of circles) {
    if (circle.id === nodeId) continue;
    if (_boxIntersectsCircle(candidate.box, circle.x, circle.y, circle.r)) {
      penalty += 1000 + (circle.r * circle.r);
    }
  }
  for (const box of placedBoxes) {
    const overlap = _overlapArea(candidate.box, box);
    if (overlap > 0) penalty += 2000 + overlap;
  }
  return penalty;
}

function _boxFromCenter(cx, cy, width, height) {
  return {
    left: cx - (width / 2),
    right: cx + (width / 2),
    top: cy - (height / 2),
    bottom: cy + (height / 2),
  };
}

function _labelStateBox(state) {
  return _boxFromCenter(state.cx, state.cy, state.width, state.height);
}

function _candidateCenter(candidate) {
  return {
    x: (candidate.box.left + candidate.box.right) / 2,
    y: (candidate.box.top + candidate.box.bottom) / 2,
  };
}

function _resolveZeroVector(dx, dy, fallbackAngle = 0) {
  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) return { dx, dy };
  return { dx: Math.cos(fallbackAngle), dy: Math.sin(fallbackAngle) };
}

function _clampLabelState(state, viewport) {
  const pad = 6;
  state.cx = Math.max((state.width / 2) + pad, Math.min(viewport.width - (state.width / 2) - pad, state.cx));
  state.cy = Math.max((state.height / 2) + pad, Math.min(viewport.height - (state.height / 2) - pad, state.cy));

  let dx = state.cx - state.nodeX;
  let dy = state.cy - state.nodeY;
  ({ dx, dy } = _resolveZeroVector(dx, dy, state.preferredAngle));
  let dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
  if (dist < state.minRadius) {
    const scale = state.minRadius / dist;
    state.cx = state.nodeX + (dx * scale);
    state.cy = state.nodeY + (dy * scale);
  } else if (dist > state.maxRadius) {
    const scale = state.maxRadius / dist;
    state.cx = state.nodeX + (dx * scale);
    state.cy = state.nodeY + (dy * scale);
  }
}

function _relaxLabelStates(states, circles, viewport) {
  if (!states.length) return;
  const iterations = Math.min(12, 5 + Math.ceil(states.length / 40));
  const labelPadding = 4;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < states.length; i++) {
      const a = states[i];
      for (let j = i + 1; j < states.length; j++) {
        const b = states[j];
        const overlapX = ((a.width + b.width) / 2 + labelPadding) - Math.abs(a.cx - b.cx);
        const overlapY = ((a.height + b.height) / 2 + labelPadding) - Math.abs(a.cy - b.cy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        if (overlapX < overlapY) {
          let dx = a.cx - b.cx;
          ({ dx } = _resolveZeroVector(dx, 0, a.preferredAngle));
          const dir = Math.sign(dx) || 1;
          const shift = overlapX / 2;
          a.cx += dir * shift;
          b.cx -= dir * shift;
        } else {
          let dy = a.cy - b.cy;
          ({ dy } = _resolveZeroVector(0, dy, a.preferredAngle + (Math.PI / 2)));
          const dir = Math.sign(dy) || 1;
          const shift = overlapY / 2;
          a.cy += dir * shift;
          b.cy -= dir * shift;
        }
      }
    }

    for (const state of states) {
      for (const circle of circles) {
        const stateBox = _labelStateBox(state);
        if (!_boxIntersectsCircle(stateBox, circle.x, circle.y, circle.r + 2)) continue;
        let dx = state.cx - circle.x;
        let dy = state.cy - circle.y;
        ({ dx, dy } = _resolveZeroVector(dx, dy, state.preferredAngle));
        const dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
        const push = Math.max(2, Math.min(14, (circle.r / 5) + 2));
        state.cx += (dx / dist) * push;
        state.cy += (dy / dist) * push;
      }

      state.cx += (state.preferredX - state.cx) * 0.08;
      state.cy += (state.preferredY - state.cy) * 0.08;
      _clampLabelState(state, viewport);
    }
  }
}

function _autoLabelBudget(scale, nodeCount) {
  if (scale <= 0.18) return 0;
  // Estimate how many labels fit visibly at the current zoom. A typical label
  // bbox is ~85x18 px at scale 1.0; at scale s it's ~85s x 18s. The visible
  // area is the canvas area, which we approximate as 900x700 = 630k px² of
  // usable graph space (sidebars eat the rest). With ~50% packing efficiency
  // we can show area / (labelArea * 2) labels.
  const labelArea = 85 * 18; // logical px²
  const visibleArea = 630000 * Math.min(4, scale * scale);
  let budget = Math.floor(visibleArea / (labelArea * 4.5));
  // Hard floor so even at low zoom you see the most-important handful.
  budget = Math.max(scale > 0.28 ? 12 : 0, Math.min(nodeCount, budget));
  return budget;
}

function _autoLabelOpacity(scale) {
  return 0.35 + (_smoothstep(0.24, 1.05, scale) * 0.65);
}

function _setLabelPlacement(labelEl, placement) {
  labelEl.setAttribute('x', placement.attrs.x);
  labelEl.setAttribute('y', placement.attrs.y);
  labelEl.setAttribute('text-anchor', placement.attrs.anchor);
  labelEl.setAttribute('dominant-baseline', placement.attrs.baseline);
}

function _setLabelHidden(labelEl) {
  labelEl.style.opacity = '0';
}

function _setLabelVisible(labelEl, opacity = 1) {
  labelEl.style.opacity = String(Math.max(0, Math.min(1, opacity)));
}

function _scheduleLabelLayout(immediate = false) {
  if (!gNodes || !svg) return;
  if (immediate) {
    if (_labelLayoutTimer) {
      clearTimeout(_labelLayoutTimer);
      _labelLayoutTimer = null;
    }
    _updateNodeLabelVisibility(_currentZoomScale);
    return;
  }
  if (_labelLayoutTimer) return;
  const alpha = typeof simulation?.alpha === 'function' ? simulation.alpha() : 0;
  const delay = alpha > 0.18 ? 120 : (alpha > 0.08 ? 64 : 18);
  _labelLayoutTimer = setTimeout(() => {
    _labelLayoutTimer = null;
    _updateNodeLabelVisibility(_currentZoomScale);
  }, delay);
}

function _setHoveredNode(nodeId = null) {
  if (hoveredNodeId === nodeId) return;
  hoveredNodeId = nodeId;
  _scheduleLabelLayout(true);
}

function _upsertNodeVisuals(nodeSelection) {
  // Annotate each node group with its type so CSS selectors (e.g. the
  // self-node activity pulse) can target by attribute.
  nodeSelection.attr('data-node-type', d => d?.type || '');
  nodeSelection.each(function(d) {
    const sel = d3.select(this);
    if (sel.select('.glow-ring').empty()) sel.append('path').attr('class', 'node-shape glow-ring').attr('stroke', 'none');
    if (sel.select('.node-circle').empty()) sel.append('path').attr('class', 'node-shape node-circle');
    if (sel.select('.node-glyph').empty()) {
      sel.append('text')
        .attr('class', 'node-glyph')
        .attr('text-anchor', 'middle')
        .attr('y', 1);
    }
    if (sel.select('.node-label').empty()) {
      // Fill is set in CSS (.node-label) so labels retint on theme change.
      sel.append('text')
        .attr('class', 'node-label')
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px');
    }
    // Sub-label below the node name (mono, uppercase, family-stroke
    // color when focused else muted) — design_handoff_node_graph spec.
    if (sel.select('.node-sub-label').empty()) {
      sel.append('text')
        .attr('class', 'node-sub-label')
        .attr('text-anchor', 'middle')
        .attr('font-size', '8.5px')
        .attr('letter-spacing', '0.6');
    }
    // Selection halo — design's dashed ring that appears around the
    // focused node. Drawn first (under everything else) so it sits
    // behind the shape; opacity is toggled by _applyGraphSelectionStyles.
    if (sel.select('.node-focus-halo').empty()) {
      sel.insert('circle', ':first-child')
        .attr('class', 'node-focus-halo')
        .attr('fill', 'none')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3 4')
        .attr('opacity', 0)
        .attr('pointer-events', 'none');
    }
    // F01 mark elements for self-type nodes only (spec:
    //   /mnt/user/appdata/anima/design_stuff/spore logo and node/).
    // Stack order: spokes → halos → petals → center.
    // Halos sit between spokes and petals so listen/rings animations
    // ripple from behind each petal outward without occluding it.
    if (d?.type === 'self') {
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-spoke[data-i="${i}"]`).empty()) {
          sel.append('line').attr('class', 'self-spoke').attr('data-i', i);
        }
      }
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-halo[data-i="${i}"]`).empty()) {
          sel.append('circle').attr('class', 'self-halo').attr('data-i', i);
        }
      }
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-petal[data-i="${i}"]`).empty()) {
          sel.append('circle').attr('class', 'self-petal').attr('data-i', i);
        }
      }
      if (sel.select('.self-center').empty()) {
        sel.append('circle').attr('class', 'self-center');
      }
    }
  });

  nodeSelection.select('.glow-ring')
    .attr('d', d => getNodeShapePath(d.type, d.radius + 8))
    .attr('fill', d => getColor(d.type))
    .attr('stroke', 'none');

  nodeSelection.select('.node-circle')
    .attr('d', d => getNodeShapePath(d.type, d.radius))
    .attr('fill', d => getFillColor(d.type))
    // Solid family fill on permanent nodes; thin / hollow on temp nodes
    // so they read as transient even at a glance.
    .attr('fill-opacity', d => d.extra?.ttl === 'temp' ? 0.25 : 1)
    .attr('stroke', d => getColor(d.type))
    .attr('stroke-width', d => d.extra?.ttl === 'temp' ? 1.2 : 1.6)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round')
    .attr('stroke-dasharray', d => d.extra?.ttl === 'temp' ? '4 3' : null);

  // ── F01 mark — base geometry for self-type nodes. The animation rAF
  // loop (_selfAnim) overrides cx/cy/r every frame; this just sets sane
  // defaults in case the loop hasn't ticked yet (e.g. first paint).
  nodeSelection.filter(d => d?.type === 'self').each(function(d) {
    const sel = d3.select(this);
    const R = d.radius || 14;            // bounding half-extent in px
    const ringR = R * 0.62;              // petal ring radius (spec)
    const petalR = R * 0.16;             // each petal radius (spec)
    const centerR = R * 0.18;            // center disc radius (spec)
    const strokeW = R * 0.04;            // spoke stroke (spec)
    const ANGLES = [];
    for (let i = 0; i < 6; i++) ANGLES.push(-Math.PI / 2 + (i / 6) * Math.PI * 2);
    sel.selectAll('.self-spoke').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', ringR * Math.cos(a))
        .attr('y2', ringR * Math.sin(a))
        .attr('stroke-width', strokeW);
    });
    sel.selectAll('.self-petal').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('cx', ringR * Math.cos(a))
        .attr('cy', ringR * Math.sin(a))
        .attr('r', petalR);
    });
    sel.selectAll('.self-halo').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('cx', ringR * Math.cos(a))
        .attr('cy', ringR * Math.sin(a))
        .attr('r', petalR)
        .attr('stroke-width', strokeW * 0.6);
    });
    sel.select('.self-center').attr('cx', 0).attr('cy', 0).attr('r', centerR);
  });
  nodeSelection.classed('node-temp', d => d?.extra?.ttl === 'temp');

  nodeSelection.select('.node-glyph')
    .text(d => getNodeGlyph(d.type))
    .attr('fill', d => getColor(d.type))
    .attr('font-size', d => `${Math.max(6, Math.min(d.radius * 0.92, 9.5))}px`);

  nodeSelection.select('.node-label')
    .text(d => _nodeLabelText(d))
    .attr('dy', 0);

  // Sub-label content (uppercased type) and color (family-stroke when
  // focused, muted otherwise — _applyGraphSelectionStyles refreshes it).
  nodeSelection.select('.node-sub-label')
    .text(d => String(d?.type || '').toUpperCase())
    .attr('fill', 'var(--text-muted)')
    .attr('opacity', 0);  // shown by the auto-label budget alongside the name

  // Focus halo radius tracks the node's bounding extent.
  nodeSelection.select('.node-focus-halo')
    .attr('r', d => (d.radius || 12) + 12)
    .attr('stroke', d => getColor(d.type));
}

function _legendNodeChip(type, color) {
  const glyph = esc(getNodeGlyph(type));
  const d = getNodeShapePath(type, 6.6);
  return `<svg viewBox="-10 -10 20 20" width="14" height="14" aria-hidden="true" style="display:inline-block;vertical-align:middle;overflow:visible">`
    + `<path d="${d}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.2"></path>`
    + `<text x="0" y="1.2" text-anchor="middle" font-family="var(--font-body)" font-size="5.2" font-weight="700" fill="${color}">${glyph}</text>`
    + `</svg>`;
}

function _hideNodePanel() {
  document.getElementById('node-empty').style.display = '';
  document.getElementById('panel-header').style.display = 'none';
  document.getElementById('panel-body').style.display = 'none';
  if (_usesFloatingWindows()) return;
  if (activeRpTabs.has('node-pane')) {
    openRightPanel(lastNonNodeTab, false);
    syncRpButtons();
  }
}

function _showNodePanel(node) {
  document.getElementById('node-empty').style.display = 'none';
  document.getElementById('panel-header').style.display = '';
  document.getElementById('panel-body').style.display = '';
  if (!activeRpTabs.has('node-pane') || _usesFloatingWindows()) openRightPanel('node-pane', false);
  renderPanel(node);
}

function _normalizeSelectionIds(ids) {
  const validIds = new Set(graphData.nodes.map(n => n.id));
  return [...new Set(ids || [])].filter(id => validIds.has(id));
}

function _applyGraphSelectionStyles() {
  const activeIds = selectedNodeIds;
  const primaryId = selectedNode?.id || (activeIds.size === 1 ? [...activeIds][0] : null);

  // Petri-style focus: when something's selected, compute the neighbor set
  // (selection ∪ everything one edge away) and dim everything else. Empty
  // selection returns to the unfocused all-bright state.
  const neighborIds = new Set();
  if (activeIds.size && graphData?.edges) {
    activeIds.forEach(id => neighborIds.add(id));
    for (const e of graphData.edges) {
      const sId = e.source?.id || e.source;
      const tId = e.target?.id || e.target;
      if (activeIds.has(sId)) neighborIds.add(tId);
      if (activeIds.has(tId)) neighborIds.add(sId);
    }
  }

  if (gNodes) {
    gNodes.selectAll('g')
      .classed('graph-node', true)
      .classed('node-selected-multi', d => activeIds.has(d.id) && d.id !== primaryId)
      .classed('node-faded', d => activeIds.size > 0 && !neighborIds.has(d.id));

    gNodes.selectAll('.node-circle')
      .attr('stroke-width', d => {
        const tmp = d?.extra?.ttl === 'temp';
        if (tmp) return 1.2;
        return d.id === primaryId ? 2.4 : (activeIds.has(d.id) ? 2 : 1.6);
      })
      .attr('fill-opacity', d => d?.extra?.ttl === 'temp' ? 0.25 : 1);

    // Focus halo: design's dashed ring around the focused (non-self)
    // node. Self-node has its own activity animation system, so we skip it.
    gNodes.selectAll('.node-focus-halo')
      .attr('opacity', d => (d.id === primaryId && d.type !== 'self') ? 0.55 : 0);

    // Sub-label tint: family-stroke when this is the primary focus,
    // muted otherwise.
    gNodes.selectAll('.node-sub-label')
      .attr('fill', d => d.id === primaryId ? getColor(d.type) : 'var(--text-muted)');
  }

  if (gLinks) {
    gLinks.selectAll('line')
      .classed('edge-highlighted', d => {
        if (!activeIds.size) return false;
        const sourceId = d.source?.id || d.source;
        const targetId = d.target?.id || d.target;
        return activeIds.has(sourceId) || activeIds.has(targetId);
      })
      .classed('edge-faded', d => {
        if (!activeIds.size) return false;
        const sourceId = d.source?.id || d.source;
        const targetId = d.target?.id || d.target;
        return !activeIds.has(sourceId) && !activeIds.has(targetId);
      });
  }

  _scheduleLabelLayout(true);
}

function _setGraphSelection(ids, { panelNode = null } = {}) {
  const nextIds = _normalizeSelectionIds(ids);
  const panelId = panelNode ? (typeof panelNode === 'string' ? panelNode : panelNode.id) : null;

  selectedNodeIds = new Set(nextIds);
  selectedNode = panelId && nextIds.length === 1 && nextIds[0] === panelId
    ? (graphData.nodes.find(n => n.id === panelId) || null)
    : null;

  if (selectedNode) _showNodePanel(selectedNode);
  else _hideNodePanel();

  _applyGraphSelectionStyles();
}

function _restoreGraphSelection() {
  const keepIds = [...selectedNodeIds];
  if (selectedNode?.id) keepIds.push(selectedNode.id);
  _setGraphSelection(keepIds, { panelNode: selectedNode });
}

function hideGraphContextMenu() {
  const menu = document.getElementById('graph-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
}

function showGraphContextMenu(clientX, clientY) {
  if (!selectedNodeIds.size) return;
  const menu = document.getElementById('graph-context-menu');
  if (!menu) return;

  const deleteBtn = menu.querySelector('[data-action="delete-selected-nodes"]');
  const researchBtn = menu.querySelector('[data-action="research-selected-nodes"]');
  const count = selectedNodeIds.size;
  if (deleteBtn) {
    deleteBtn.textContent = count === 1 ? 'delete selected node' : `delete ${count} selected nodes`;
  }
  if (researchBtn) {
    researchBtn.textContent = count === 1 ? 'research selected node' : `research ${count} selected nodes`;
  }

  menu.style.visibility = 'hidden';
  menu.style.display = 'block';

  const pad = 10;
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 80;
  const left = Math.min(clientX, window.innerWidth - width - pad);
  const top = Math.min(clientY, window.innerHeight - height - pad);

  menu.style.left = Math.max(pad, left) + 'px';
  menu.style.top = Math.max(pad, top) + 'px';
  menu.style.visibility = '';
}

function clearGraphSelection() {
  hideGraphContextMenu();
  _setGraphSelection([]);
}

function _clientToSvgPoint(clientX, clientY) {
  if (!svg?.node()) return { x: 0, y: 0 };
  const rect = svg.node().getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function _isMarqueeGesture(e) {
  return e.button === 0 && e.shiftKey && (e.ctrlKey || e.metaKey);
}

function _showSelectionRect(x, y, width, height) {
  if (!_selectionRect) return;
  _selectionRect
    .attr('x', x)
    .attr('y', y)
    .attr('width', width)
    .attr('height', height)
    .style('display', '');
}

function _hideSelectionRect() {
  if (_selectionRect) _selectionRect.style('display', 'none');
  svg?.classed('is-marquee-selecting', false);
}

function _beginGraphMarquee(e) {
  if (!_isMarqueeGesture(e)) return;
  hideGraphContextMenu();
  e.preventDefault();
  e.stopPropagation();

  const pt = _clientToSvgPoint(e.clientX, e.clientY);
  _graphMarquee = { active: true, moved: false, startX: pt.x, startY: pt.y };
  svg?.classed('is-marquee-selecting', true);
  _showSelectionRect(pt.x, pt.y, 0, 0);
}

function _updateGraphMarquee(clientX, clientY) {
  if (!_graphMarquee.active || !svg?.node()) return;

  const pt = _clientToSvgPoint(clientX, clientY);
  const dx = pt.x - _graphMarquee.startX;
  const dy = pt.y - _graphMarquee.startY;
  const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
  if (moved && !_graphMarquee.moved) {
    _graphMarquee.moved = true;
    selectedNode = null;
    _hideNodePanel();
  }

  const x = Math.min(_graphMarquee.startX, pt.x);
  const y = Math.min(_graphMarquee.startY, pt.y);
  const width = Math.abs(dx);
  const height = Math.abs(dy);
  _showSelectionRect(x, y, width, height);

  if (!_graphMarquee.moved) return;

  const t = d3.zoomTransform(svg.node());
  const ids = graphData.nodes
    .filter(n => {
      const sx = t.applyX(n.x);
      const sy = t.applyY(n.y);
      return sx >= x && sx <= x + width && sy >= y && sy <= y + height;
    })
    .map(n => n.id);

  selectedNodeIds = new Set(ids);
  _applyGraphSelectionStyles();
}

function _finishGraphMarquee(cancel = false) {
  if (!_graphMarquee.active) return;
  const { moved } = _graphMarquee;
  _graphMarquee.active = false;
  _hideSelectionRect();

  if (cancel) return;
  if (moved) {
    _suppressNextGraphClick = true;
    if (selectedNodeIds.size === 0) _hideNodePanel();
  }
}

document.addEventListener('mousemove', (e) => _updateGraphMarquee(e.clientX, e.clientY));
document.addEventListener('mouseup', () => _finishGraphMarquee(false));
window.addEventListener('blur', () => _finishGraphMarquee(true));
document.addEventListener('click', (e) => {
  if (!e.target.closest('#graph-context-menu')) hideGraphContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideGraphContextMenu();
    _finishGraphMarquee(true);
  }
});
document.getElementById('graph-context-menu')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const action = btn.dataset.action;
  if (action === 'delete-selected-nodes') await doDeleteSelectedNodes();
  else if (action === 'clear-selection') clearGraphSelection();
  else if (action === 'research-selected-nodes') await doResearchSelectedNodes();
});

async function doResearchSelectedNodes() {
  const ids = Array.from(selectedNodeIds || []);
  if (!ids.length) { toast('No nodes selected', true); return; }
  if (ids.length > 12) { toast('Pick 12 or fewer nodes to research', true); return; }
  hideGraphContextMenu();
  toast(`Researching ${ids.length} node${ids.length === 1 ? '' : 's'}…`);
  try {
    const r = await fetch(API + '/api/graph/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ nodeIds: ids }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast(`Agent is researching — graph will update as new info comes in`);
  } catch (e) {
    toast('Research failed: ' + (e.message || e), true);
  }
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2500);
}

// ── Panel Collapse System ──
const _DESKTOP_WINDOW_BREAKPOINT = 768;
const _FLOATING_WINDOW_STORAGE_PREFIX = '_floatingWindow:';
const _FLOATING_WINDOW_EDGE_GAP = 12;
const _floatingWindowDefaults = {
  'chat-panel': { left: null, top: 18, width: 380, height: Math.min(window.innerHeight - 36, 860), rightOffset: 18 },
  'node-pane': { left: 24, top: 84, width: 360, height: Math.min(window.innerHeight * 0.66, 720) },
  'files-pane': { left: 24, top: Math.max(180, window.innerHeight - Math.min(window.innerHeight * 0.42, 420) - 24), width: 420, height: Math.min(window.innerHeight * 0.42, 420) },
  'logs-pane': { left: 460, top: Math.max(220, window.innerHeight - Math.min(window.innerHeight * 0.32, 320) - 24), width: 460, height: Math.min(window.innerHeight * 0.32, 320) },
  'skills-pane': { left: 520, top: 96, width: 420, height: Math.min(window.innerHeight * 0.58, 620) },
  'terminal-pane': { left: 120, top: 120, width: Math.min(window.innerWidth - 140, 860), height: Math.min(window.innerHeight - 180, 500) },
};
let _floatingZCounter = 60;

function _usesFloatingWindows() {
  return window.innerWidth > _DESKTOP_WINDOW_BREAKPOINT;
}

function _floatingWindowKey(id) {
  return `${_FLOATING_WINDOW_STORAGE_PREFIX}${id}`;
}

function _parseFloatingWindowNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function _clampFloatingWindowRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  let width = _parseFloatingWindowNumber(rect.width);
  let height = _parseFloatingWindowNumber(rect.height);
  let left = _parseFloatingWindowNumber(rect.left);
  let top = _parseFloatingWindowNumber(rect.top);
  if (width === null || height === null || left === null || top === null) return null;
  const minWidth = Math.min(280, Math.max(220, window.innerWidth - (_FLOATING_WINDOW_EDGE_GAP * 2)));
  const minHeight = Math.min(220, Math.max(180, window.innerHeight - (_FLOATING_WINDOW_EDGE_GAP * 2)));
  const maxWidth = Math.max(minWidth, window.innerWidth - (_FLOATING_WINDOW_EDGE_GAP * 2));
  const maxHeight = Math.max(minHeight, window.innerHeight - (_FLOATING_WINDOW_EDGE_GAP * 2));
  width = Math.max(minWidth, Math.min(width, maxWidth));
  height = Math.max(minHeight, Math.min(height, maxHeight));
  const maxLeft = Math.max(_FLOATING_WINDOW_EDGE_GAP, window.innerWidth - width - _FLOATING_WINDOW_EDGE_GAP);
  const maxTop = Math.max(_FLOATING_WINDOW_EDGE_GAP, window.innerHeight - height - _FLOATING_WINDOW_EDGE_GAP);
  left = Math.max(_FLOATING_WINDOW_EDGE_GAP, Math.min(left, maxLeft));
  top = Math.max(_FLOATING_WINDOW_EDGE_GAP, Math.min(top, maxTop));
  return { left, top, width, height };
}

function _applyRectToFloatingWindow(el, rect) {
  if (!el || !rect) return;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function _focusFloatingWindow(id) {
  if (!_usesFloatingWindows()) return;
  const el = document.getElementById(id);
  if (!el) return;
  _floatingZCounter += 1;
  el.style.zIndex = String(_floatingZCounter);
}

function _floatingWindowMaxRect() {
  const width = Math.max(320, window.innerWidth - 24);
  const height = Math.max(240, window.innerHeight - 130);
  return { left: 12, top: 12, width, height };
}

function _updateFloatingWindowChrome(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const maximized = el.classList.contains('window-maximized');
  el.querySelectorAll('[data-window-action="maximize"]').forEach((btn) => {
    // Swap the SVG glyph: square (maximize) ↔ two-square restore.
    btn.innerHTML = maximized
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="9" height="8" rx="1.2"/><path d="M5.5 5V3.5a1.2 1.2 0 0 1 1.2-1.2h6.6a1.2 1.2 0 0 1 1.2 1.2v6.6a1.2 1.2 0 0 1-1.2 1.2H12"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/></svg>';
    btn.setAttribute('title', maximized ? 'Restore window' : 'Maximize window');
    btn.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
  });
}

function _toggleFloatingWindowMaximize(id) {
  if (!_usesFloatingWindows()) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('window-maximized')) {
    el.classList.remove('window-maximized');
    const prev = _clampFloatingWindowRect(JSON.parse(el.dataset.prevRect || 'null')) || _defaultFloatingWindowRect(id);
    _applyRectToFloatingWindow(el, prev);
    delete el.dataset.prevRect;
    _saveFloatingWindowRect(id);
  } else {
    const rect = _clampFloatingWindowRect(el.getBoundingClientRect()) || _defaultFloatingWindowRect(id);
    el.dataset.prevRect = JSON.stringify({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    el.classList.add('window-maximized');
    const maxRect = _floatingWindowMaxRect();
    _applyRectToFloatingWindow(el, maxRect);
  }
  _focusFloatingWindow(id);
  _updateFloatingWindowChrome(id);
  if (id === 'terminal-pane') window._refitTerminalLayout?.();
}

function _defaultFloatingWindowRect(id) {
  const preset = _floatingWindowDefaults[id] || { left: 24, top: 24, width: 360, height: 320 };
  const width = Math.min(preset.width || 360, window.innerWidth - 32);
  const height = Math.min(preset.height || 320, window.innerHeight - 32);
  const left = preset.left === null
    ? Math.max(12, window.innerWidth - width - (preset.rightOffset ?? 18))
    : Math.max(12, Math.min(preset.left, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(preset.top || 24, window.innerHeight - height - 12));
  return _clampFloatingWindowRect({ left, top, width, height }) || { left, top, width, height };
}

function _loadFloatingWindowRect(id) {
  try {
    const parsed = JSON.parse(localStorage.getItem(_floatingWindowKey(id)) || 'null');
    if (!parsed || typeof parsed !== 'object') return _defaultFloatingWindowRect(id);
    return _clampFloatingWindowRect(parsed) || _defaultFloatingWindowRect(id);
  } catch {
    return _defaultFloatingWindowRect(id);
  }
}

function _saveFloatingWindowRect(id) {
  if (!_usesFloatingWindows()) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('window-maximized')) return;
  if (el.getClientRects().length === 0) return;
  const rect = _clampFloatingWindowRect(el.getBoundingClientRect());
  if (!rect || rect.width < 40 || rect.height < 40) return;
  try {
    localStorage.setItem(_floatingWindowKey(id), JSON.stringify(rect));
  } catch {}
}

function _ensureFloatingWindowInViewport(id, rectLike = null) {
  if (!_usesFloatingWindows()) return null;
  const el = document.getElementById(id);
  if (!el) return null;
  if (el.classList.contains('window-maximized')) {
    const maxRect = _floatingWindowMaxRect();
    _applyRectToFloatingWindow(el, maxRect);
    _updateFloatingWindowChrome(id);
    return maxRect;
  }
  const rect = _clampFloatingWindowRect(rectLike) || _loadFloatingWindowRect(id);
  _applyRectToFloatingWindow(el, rect);
  _updateFloatingWindowChrome(id);
  return rect;
}

function _applyFloatingWindowRect(id) {
  if (!_usesFloatingWindows()) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.classList.contains('window-maximized')) {
    const maxRect = _floatingWindowMaxRect();
    _applyRectToFloatingWindow(el, maxRect);
    _updateFloatingWindowChrome(id);
    return;
  }
  _ensureFloatingWindowInViewport(id, _loadFloatingWindowRect(id));
}

function _initFloatingWindow(id, handleSelector) {
  const el = document.getElementById(id);
  if (!el || el.dataset.floatingInit === '1') return;
  const handle = typeof handleSelector === 'string' ? el.querySelector(handleSelector) : handleSelector;
  if (!handle) return;
  el.dataset.floatingInit = '1';
  _applyFloatingWindowRect(id);
  el.addEventListener('pointerdown', () => _focusFloatingWindow(id));
  const closeBtn = el.querySelector('[data-window-action="close"]');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (id === 'chat-panel') togglePanel('chat-panel');
      else if (id === 'terminal-pane') window.toggleTerminal?.();
      else closeRightPanel(id);
      syncRpButtons();
      if (typeof _syncUtilBar === 'function') _syncUtilBar();
    });
  }
  const maxBtn = el.querySelector('[data-window-action="maximize"]');
  if (maxBtn) {
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _toggleFloatingWindowMaximize(id);
    });
  }
  handle.addEventListener('dblclick', (e) => {
    if (!_usesFloatingWindows()) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    _toggleFloatingWindowMaximize(id);
  });

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    const rect = el.getBoundingClientRect();
    const nextLeft = Math.max(_FLOATING_WINDOW_EDGE_GAP, Math.min(startLeft + (e.clientX - startX), window.innerWidth - rect.width - _FLOATING_WINDOW_EDGE_GAP));
    const nextTop = Math.max(_FLOATING_WINDOW_EDGE_GAP, Math.min(startTop + (e.clientY - startY), window.innerHeight - rect.height - _FLOATING_WINDOW_EDGE_GAP));
    el.style.left = `${nextLeft}px`;
    el.style.top = `${nextTop}px`;
  }

  function onPointerUp(e) {
    if (e && e.pointerId !== pointerId) return;
    try { handle.releasePointerCapture(pointerId); } catch {}
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerUp);
    pointerId = null;
    _saveFloatingWindowRect(id);
  }

  handle.addEventListener('pointerdown', (e) => {
    if (!_usesFloatingWindows()) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    if (el.classList.contains('window-maximized')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = parseFloat(el.style.left) || el.getBoundingClientRect().left;
    startTop = parseFloat(el.style.top) || el.getBoundingClientRect().top;
    _focusFloatingWindow(id);
    try { handle.setPointerCapture(pointerId); } catch {}
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (!_usesFloatingWindows()) return;
      if (el.getClientRects().length === 0) return;
      _ensureFloatingWindowInViewport(id, el.getBoundingClientRect());
      _saveFloatingWindowRect(id);
      if (id === 'terminal-pane') window._refitTerminalLayout?.();
    });
    observer.observe(el);
  }
}

function _initDesktopFloatingWindows() {
  // chat-panel is a docked right sidebar (not a floating window) on desktop.
  _initFloatingWindow('node-pane', '.floating-pane-head');
  _initFloatingWindow('files-pane', '.floating-pane-head');
  _initFloatingWindow('logs-pane', '.floating-pane-head');
  _initFloatingWindow('skills-pane', '.floating-pane-head');
  _initFloatingWindow('terminal-pane', '.floating-pane-head');
}

window.addEventListener('resize', () => {
  if (!_usesFloatingWindows()) return;
  ['node-pane', 'files-pane', 'logs-pane', 'skills-pane', 'terminal-pane'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains('window-maximized')) {
      _applyFloatingWindowRect(id);
      return;
    }
    if (el.getClientRects().length === 0) return;
    _ensureFloatingWindowInViewport(id, el.getBoundingClientRect());
    _saveFloatingWindowRect(id);
    if (id === 'terminal-pane') window._refitTerminalLayout?.();
  });
});

const _panels = {
  'right-panel': { el: document.getElementById('right-panel'), handle: 'resize-right', tab: 'tab-right-panel', cls: 'closed', label: 'Sidebar' },
  'canvas':      { el: document.getElementById('canvas'),       handle: null,           tab: 'tab-canvas',      cls: 'panel-collapsed', label: 'Graph' },
  'chat-panel':  { el: document.getElementById('chat-panel'),   handle: 'resize-left',  tab: 'tab-chat',        cls: 'collapsed', label: 'Chat' },
};
let activeRpTab = null;
let activeRpTabs = new Set();
let logsAutoInterval = null;
let lastNonNodeTab = 'files-pane';
function _panelState() {
  try { return JSON.parse(localStorage.getItem('_panelState') || '{}'); } catch { return {}; }
}
function _savePanelState() {
  const s = {};
  for (const [id, p] of Object.entries(_panels)) s[id] = !p.el.classList.contains(p.cls);
  s.floatingTabs = Array.from(activeRpTabs);
  s.lastNonNodeTab = lastNonNodeTab;
  s.terminalOpen = !!document.getElementById('terminal-pane')?.classList.contains('window-open');
  try { localStorage.setItem('_panelState', JSON.stringify(s)); } catch {}
}
function _syncResizeHandles() {
  if (_usesFloatingWindows()) {
    const rl = document.getElementById('resize-left');
    const rr = document.getElementById('resize-right');
    if (rl) rl.style.display = 'none';
    if (rr) rr.style.display = 'none';
    return;
  }
  const chatVisible = !document.getElementById('chat-panel').classList.contains('collapsed');
  const canvasVisible = !document.getElementById('canvas').classList.contains('panel-collapsed');
  const rpVisible = !document.getElementById('right-panel').classList.contains('closed');
  const rl = document.getElementById('resize-left');
  const rr = document.getElementById('resize-right');

  if (canvasVisible) {
    rl.style.display = chatVisible ? '' : 'none';
    rr.style.display = rpVisible ? '' : 'none';
  } else {
    // Canvas collapsed — if both sidebar and chat are visible, show one handle between them
    rl.style.display = 'none';
    rr.style.display = (chatVisible && rpVisible) ? '' : 'none';
  }
}
function _syncPanelFill() {
  if (_usesFloatingWindows()) {
    document.getElementById('chat-panel').classList.remove('fill-remaining');
    document.getElementById('right-panel').classList.remove('fill-remaining');
    return;
  }
  const chatEl = document.getElementById('chat-panel');
  const canvasEl = document.getElementById('canvas');
  const rpEl = document.getElementById('right-panel');
  const chatVis = !chatEl.classList.contains('collapsed');
  const canvasVis = !canvasEl.classList.contains('panel-collapsed');
  const rpVis = !rpEl.classList.contains('closed');

  // Chat flexes to fill when canvas or sidebar is gone (sidebar keeps fixed width for resizing)
  const chatFill = chatVis && (!canvasVis || !rpVis);
  // Sidebar only flexes when it's the sole visible panel
  const rpFill = rpVis && !canvasVis && !chatVis;

  chatEl.classList.toggle('fill-remaining', chatFill);
  rpEl.classList.toggle('fill-remaining', rpFill);
  if (chatFill) { chatEl.style.width = ''; chatEl.style.minWidth = ''; }
  if (rpFill) { rpEl.style.width = ''; rpEl.style.minWidth = ''; }
}
function togglePanel(id) {
  const p = _panels[id];
  if (!p) return;
  if (_usesFloatingWindows() && id === 'canvas') return;
  if (_usesFloatingWindows() && id === 'right-panel') {
    if (activeRpTabs.size > 0) closeRightPanel();
    else openRightPanel(lastNonNodeTab || 'files-pane', false);
    syncRpButtons();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
    return;
  }
  const isVisible = !p.el.classList.contains(p.cls);
  p.el.classList.toggle(p.cls, isVisible);
  const tab = document.getElementById(p.tab);
  if (tab) tab.classList.toggle('active', isVisible);
  if (p.handle) document.getElementById(p.handle).style.display = isVisible ? 'none' : '';
  if (id === 'chat-panel') {
    document.getElementById('btn-toggle-chat').classList.toggle('active', !isVisible);
    _syncChatReopen();
  }
  _syncResizeHandles();
  _syncPanelFill();
  _savePanelState();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}
function restorePanelState() {
  const s = _panelState();
  if (_usesFloatingWindows()) {
    const chatVisible = s['chat-panel'] !== false;
    document.getElementById('chat-panel').classList.toggle('collapsed', !chatVisible);
    document.getElementById('canvas').classList.remove('panel-collapsed');
    document.getElementById('btn-toggle-chat').classList.toggle('active', chatVisible);
    _initDesktopFloatingWindows();
    activeRpTabs.clear();
    activeRpTab = null;
    rpPanes.forEach((pane) => pane.classList.remove('window-open', 'active'));
    const hasStoredTabs = Array.isArray(s.floatingTabs);
    // Default-open panes are creator-only (files + logs). Webapp users get a
    // clean view with just the node pane; they can open others via the tab bar
    // if they want. This also avoids 401 flicker from unauthorized API calls.
    const isCreatorRole = _userRole === 'creator' || _userRole === 'admin';
    const defaultTabs = isCreatorRole ? ['files-pane', 'logs-pane'] : [];
    const ADMIN_ONLY_TABS = new Set(['files-pane', 'logs-pane']);
    const tabsToOpen = hasStoredTabs
      ? s.floatingTabs.filter((id) => !!document.getElementById(id) && (isCreatorRole || !ADMIN_ONLY_TABS.has(id)))
      : defaultTabs;
    if (typeof s.lastNonNodeTab === 'string' && document.getElementById(s.lastNonNodeTab)) {
      lastNonNodeTab = s.lastNonNodeTab;
    }
    if (tabsToOpen.length) {
      tabsToOpen.forEach((tabId, index) => openRightPanel(tabId, index > 0));
    } else {
      document.getElementById('right-panel').classList.add('closed');
    }
    window.__restoreTerminalOnBoot = s.terminalOpen === true;
    _syncResizeHandles();
    _syncPanelFill();
    syncRpButtons();
    _syncChatReopen();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
    return;
  }
  for (const [id, p] of Object.entries(_panels)) {
    const visible = s[id] !== undefined ? s[id] : true;
    p.el.classList.toggle(p.cls, !visible);
    const tab = document.getElementById(p.tab);
    if (tab) tab.classList.toggle('active', !visible);
    if (p.handle) document.getElementById(p.handle).style.display = visible ? '' : 'none';
  }
  document.getElementById('btn-toggle-chat').classList.toggle('active',
    !document.getElementById('chat-panel').classList.contains('collapsed'));
  _syncResizeHandles();
  _syncPanelFill();
  if (typeof _syncChatReopen === 'function') _syncChatReopen();
}
document.getElementById('tab-right-panel').onclick = () => togglePanel('right-panel');
document.getElementById('tab-canvas').onclick = () => togglePanel('canvas');
document.getElementById('tab-chat').onclick = () => togglePanel('chat-panel');
document.getElementById('btn-toggle-chat').onclick = () => togglePanel('chat-panel');
const _chatCollapseBtn = document.getElementById('chat-collapse');
if (_chatCollapseBtn) _chatCollapseBtn.onclick = () => togglePanel('chat-panel');
// Reflect chat-panel collapsed state on the dock chat button (active when
// the sidebar is open). Was a separate floating button; now lives in the
// bottom dock alongside Node / Files / Logs / Terminal / Settings.
function _syncChatReopen() {
  const dockChat = document.getElementById('dock-chat');
  if (!dockChat) return;
  const open = !document.getElementById('chat-panel').classList.contains('collapsed');
  dockChat.classList.toggle('dock-active', open);
}
document.getElementById('dock-chat')?.addEventListener('click', () => {
  togglePanel('chat-panel');
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
});

// ── Chat sidebar resize (drag handle on the left edge) ──
const CHAT_WIDTH_STORAGE_KEY = 'spore-chat-width';
const CHAT_WIDTH_MIN = 320;
function _chatWidthMax() {
  return Math.max(CHAT_WIDTH_MIN, Math.min(900, window.innerWidth * 0.7));
}
function _applyChatWidth(px) {
  const clamped = Math.round(Math.max(CHAT_WIDTH_MIN, Math.min(px, _chatWidthMax())));
  document.documentElement.style.setProperty('--chat-width', clamped + 'px');
  return clamped;
}
function _restoreChatWidth() {
  if (!_usesFloatingWindows()) return;
  try {
    const raw = localStorage.getItem(CHAT_WIDTH_STORAGE_KEY);
    const px = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(px) && px > 0) _applyChatWidth(px);
  } catch {}
}
_restoreChatWidth();
window.addEventListener('resize', () => {
  // Re-clamp if the viewport shrank past the saved width.
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-width'));
  if (Number.isFinite(cur)) _applyChatWidth(cur);
});

// Pan the graph to follow canvas width changes (chat open/close,
// right-panel toggles, viewport resize). Without this the graph stays
// in absolute pixel coords while the canvas shrinks/grows around it,
// so it visibly drifts off-center. Translating the zoom transform by
// half the width delta keeps the visible portion centered.
(function _initGraphFollowsCanvasWidth() {
  const canvasEl = document.getElementById('canvas');
  if (!canvasEl || typeof ResizeObserver === 'undefined') return;
  let prevWidth = canvasEl.clientWidth;
  let pending = false;
  const ro = new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const newWidth = canvasEl.clientWidth;
      const delta = newWidth - prevWidth;
      prevWidth = newWidth;
      if (Math.abs(delta) < 1) return;
      if (typeof svg === 'undefined' || !svg || !zoom) return;
      const t = d3.zoomTransform(svg.node());
      const next = d3.zoomIdentity.translate(t.x + delta / 2, t.y).scale(t.k);
      svg.transition().duration(220).ease(d3.easeCubicOut).call(zoom.transform, next);
    });
  });
  ro.observe(canvasEl);
})();

(function _initChatResizeHandle() {
  const handle = document.getElementById('chat-resize-handle');
  if (!handle) return;
  let dragId = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!_usesFloatingWindows()) return;
    if (document.getElementById('chat-panel').classList.contains('collapsed')) return;
    dragId = e.pointerId;
    handle.classList.add('dragging');
    document.body.classList.add('chat-resizing');
    try { handle.setPointerCapture(dragId); } catch {}
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    // Width = distance from pointer to right viewport edge.
    _applyChatWidth(window.innerWidth - e.clientX);
  });
  function endDrag(e) {
    if (e.pointerId !== dragId) return;
    try { handle.releasePointerCapture(dragId); } catch {}
    handle.classList.remove('dragging');
    document.body.classList.remove('chat-resizing');
    dragId = null;
    try {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-width'));
      if (Number.isFinite(cur)) localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(cur)));
    } catch {}
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  // Double-click resets to default.
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--chat-width');
    try { localStorage.removeItem(CHAT_WIDTH_STORAGE_KEY); } catch {}
  });
})();
const _graphToggleRpBtn = document.getElementById('btn-toggle-graph-rp');
if (_graphToggleRpBtn) _graphToggleRpBtn.onclick = () => togglePanel('canvas');
const _graphToggleChatBtn = document.getElementById('btn-toggle-graph-chat');
if (_graphToggleChatBtn) _graphToggleChatBtn.onclick = () => togglePanel('canvas');
function toggleRightPaneWindow(paneId) {
  if (_usesFloatingWindows()) {
    if (activeRpTabs.has(paneId)) closeRightPanel(paneId);
    else openRightPanel(paneId, true);
  } else {
    openRightPanel(paneId, false);
  }
  syncRpButtons();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}
document.getElementById('btn-toggle-sidebar').onclick = () => {
  toggleRightPaneWindow('files-pane');
};
document.getElementById('btn-open-node').onclick = () => toggleRightPaneWindow('node-pane');
document.getElementById('btn-open-logs').onclick = () => toggleRightPaneWindow('logs-pane');

// ── Util-bar (chat top bar) panel toggles ──
function _syncUtilBar() {
  const sidebarVis = _usesFloatingWindows()
    ? activeRpTabs.has('files-pane')
    : !document.getElementById('right-panel').classList.contains('closed');
  const graphVis = !document.getElementById('canvas').classList.contains('panel-collapsed');
  const nodeVis = activeRpTabs.has('node-pane');
  const logsVis = activeRpTabs.has('logs-pane');
  const chatVis = !document.getElementById('chat-panel').classList.contains('collapsed');
  const terminalVis = document.getElementById('terminal-pane').classList.contains('window-open');
  const ubSidebar = document.getElementById('ub-toggle-sidebar');
  const ubGraph = document.getElementById('ub-toggle-graph');
  const ubNode = document.getElementById('ub-open-node');
  const ubLogs = document.getElementById('ub-open-logs');
  const dockChat = document.getElementById('dock-chat');
  const dockNode = document.getElementById('dock-node');
  const dockFiles = document.getElementById('dock-files');
  const dockLogs = document.getElementById('dock-logs');
  const dockTerminal = document.getElementById('dock-terminal');
  const dockSettings = document.getElementById('dock-settings');
  const settingsOpen = document.getElementById('settings-overlay')?.classList.contains('active');
  if (ubSidebar) { ubSidebar.classList.toggle('ub-on', sidebarVis); ubSidebar.classList.toggle('ub-off', !sidebarVis); }
  if (ubGraph) { ubGraph.classList.toggle('ub-on', graphVis); ubGraph.classList.toggle('ub-off', !graphVis); }
  if (ubNode) { ubNode.classList.toggle('ub-on', nodeVis); ubNode.classList.toggle('ub-off', !nodeVis); }
  if (ubLogs) { ubLogs.classList.toggle('ub-on', logsVis); ubLogs.classList.toggle('ub-off', !logsVis); }
  if (dockChat) dockChat.classList.toggle('dock-active', chatVis);
  if (dockNode) dockNode.classList.toggle('dock-active', nodeVis);
  if (dockFiles) dockFiles.classList.toggle('dock-active', sidebarVis);
  if (dockLogs) dockLogs.classList.toggle('dock-active', logsVis);
  if (dockTerminal) dockTerminal.classList.toggle('dock-active', terminalVis);
  if (dockSettings) dockSettings.classList.toggle('dock-active', !!settingsOpen);
}
document.getElementById('ub-toggle-sidebar')?.addEventListener('click', () => {
  toggleRightPaneWindow('files-pane');
});
document.getElementById('ub-open-node')?.addEventListener('click', () => {
  toggleRightPaneWindow('node-pane');
});
document.getElementById('ub-open-logs')?.addEventListener('click', () => {
  toggleRightPaneWindow('logs-pane');
});
document.getElementById('ub-toggle-graph')?.addEventListener('click', () => {
  togglePanel('canvas'); _syncUtilBar();
});
document.getElementById('ub-focus')?.addEventListener('click', () => {
  const rpVis = _usesFloatingWindows()
    ? activeRpTabs.size > 0
    : !document.getElementById('right-panel').classList.contains('closed');
  const graphVis = !document.getElementById('canvas').classList.contains('panel-collapsed');
  if (rpVis || graphVis) {
    if (rpVis) closeRightPanel();
    if (graphVis) togglePanel('canvas');
  } else {
    togglePanel('canvas');
    openRightPanel(lastNonNodeTab || 'files-pane', _usesFloatingWindows());
  }
  syncRpButtons(); _syncUtilBar();
});
_syncUtilBar();
document.getElementById('dock-node')?.addEventListener('click', () => {
  toggleRightPaneWindow('node-pane');
});
document.getElementById('dock-files')?.addEventListener('click', () => {
  toggleRightPaneWindow('files-pane');
});
document.getElementById('dock-logs')?.addEventListener('click', () => {
  toggleRightPaneWindow('logs-pane');
});
document.getElementById('dock-terminal')?.addEventListener('click', () => {
  window.toggleTerminal?.();
});
document.getElementById('dock-settings')?.addEventListener('click', () => {
  openSettingsPanel();
});

// Settings pane: inline launcher buttons
// Use document-level delegation since these buttons live inside the settings
// pane, which is parsed after this script runs.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.id === 'settings-launch-lme') {
    if (typeof lmeOpen === 'function') lmeOpen();
  } else if (t.id === 'settings-new-graph') {
    if (typeof openNewGraphModal === 'function') openNewGraphModal();
    else if (typeof showNewGraphModal === 'function') showNewGraphModal();
  } else if (t.id === 'settings-maintainer-run') {
    _maintTriggerRun();
  } else if (t.id === 'settings-janitor-run') {
    _janTriggerRun();
  } else if (t.id === 'settings-janitor-empty-bin') {
    _janEmptyBin();
  } else if (t.dataset?.janitorRestore) {
    _janRestore(t.dataset.janitorRestore);
  } else if (t.dataset?.janitorForget) {
    _janForget(t.dataset.janitorForget);
  } else if (t.id === 'settings-backup-run') {
    _bkRunSnapshot();
  } else if (t.dataset?.backupRestore) {
    _bkRestore(t.dataset.backupRestore);
  } else if (t.dataset?.backupDelete) {
    _bkDelete(t.dataset.backupDelete);
  } else if (t.id === 'settings-graph-export') {
    _graphExportDownload();
  } else if (t.id === 'settings-graph-import') {
    document.getElementById('settings-graph-import-file')?.click();
  } else if (t.dataset?.providerTest) {
    runProviderTest(t.dataset.providerTest);
  } else if (t.dataset?.modelTest) {
    runModelTest(t.dataset.modelTest);
  } else if (t.dataset?.websearchTest) {
    runWebSearchTest();
  }
});

// ── Settings: test buttons for providers + model tiers ─────────────
function _collectProviderFormValues(name) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  if (name === 'anthropic') return { apiKey: v('settings-provider-anthropic-key') };
  if (name === 'openai') return { apiKey: v('settings-provider-openai-key'), baseUrl: v('settings-provider-openai-base-url') };
  if (name === 'openrouter') return { apiKey: v('settings-provider-openrouter-key'), baseUrl: v('settings-provider-openrouter-base-url'), referer: v('settings-provider-openrouter-referer') };
  if (name === 'local') return { apiKey: v('settings-provider-local-key'), baseUrl: v('settings-provider-local-base-url') };
  return {};
}
function _collectModelTierFormValues(tier) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const provider = v(`settings-model-${tier}-provider`);
  const model = v(`settings-model-${tier}-name`);
  // Include all provider configs so the backend can build the ephemeral client
  const providers = {
    anthropic: _collectProviderFormValues('anthropic'),
    openai: _collectProviderFormValues('openai'),
    openrouter: _collectProviderFormValues('openrouter'),
    local: _collectProviderFormValues('local'),
    gemini: _collectProviderFormValues('gemini'),
    custom: typeof collectSettingsCustomProviders === 'function' ? collectSettingsCustomProviders() : [],
  };
  // Include the per-tier maxTokens + reasoningEffort overrides so Test
  // respects the values the user just typed (without requiring a Save first).
  const maxOut = parseInt(v(`settings-model-${tier}-maxout`), 10);
  const effort = v(`settings-model-${tier}-effort`);
  return {
    tier, provider, model, providers,
    maxTokens: maxOut > 0 ? maxOut : undefined,
    reasoningEffort: (effort && effort !== 'auto') ? effort : undefined,
  };
}

async function runProviderTest(name) {
  const btn = document.querySelector(`[data-provider-test="${name}"]`);
  const out = document.querySelector(`[data-provider-result="${name}"]`);
  if (!btn || !out) return;
  btn.disabled = true;
  out.className = 'settings-test-result'; out.textContent = '…';
  const t0 = performance.now();
  try {
    const r = await fetch(API + `/api/providers/${encodeURIComponent(name)}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(_collectProviderFormValues(name)),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
    const ms = Math.round(performance.now() - t0);
    out.className = 'settings-test-result ok';
    out.textContent = `ok · ${ms}ms` + (data.model ? ` · ${data.model}` : '');
  } catch (e) {
    out.className = 'settings-test-result err';
    out.textContent = String(e.message || e).slice(0, 120);
  } finally { btn.disabled = false; }
}

async function runModelTest(tier) {
  const btn = document.querySelector(`[data-model-test="${tier}"]`);
  const out = document.querySelector(`[data-model-result="${tier}"]`);
  if (!btn || !out) return;
  btn.disabled = true;
  out.className = 'settings-test-result'; out.textContent = '…';
  const t0 = performance.now();
  try {
    const r = await fetch(API + `/api/models/${encodeURIComponent(tier)}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(_collectModelTierFormValues(tier)),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      // Surface the model's actual reply when only the format check failed,
      // so the user can see whether auth worked but phrasing was off.
      const excerpt = data?.excerpt ? ` · said: "${String(data.excerpt).slice(0, 80)}"` : '';
      const err = new Error((data?.error || ('HTTP ' + r.status)) + excerpt);
      err._title = data?.excerpt || '';
      throw err;
    }
    const ms = Math.round(performance.now() - t0);
    out.className = 'settings-test-result ok';
    const parts = [`ok · ${ms}ms`];
    if (data.ttft_ms != null) parts.push(`ttft ${data.ttft_ms}ms`);
    if (data.excerpt) parts.push(String(data.excerpt).slice(0, 50));
    out.textContent = parts.join(' · ');
    out.title = data.excerpt || '';
  } catch (e) {
    out.className = 'settings-test-result err';
    out.textContent = String(e.message || e).slice(0, 200);
    if (e._title) out.title = e._title;
  } finally { btn.disabled = false; }
}

async function runWebSearchTest() {
  const btn = document.querySelector('[data-websearch-test="1"]');
  const out = document.querySelector('[data-websearch-result="1"]');
  if (!btn || !out) return;
  btn.disabled = true;
  out.className = 'settings-test-result'; out.textContent = '…';
  const payload = {
    searxngUrl: (document.getElementById('settings-websearch-searxng-url')?.value || '').trim(),
    searxngApiKey: (document.getElementById('settings-websearch-searxng-key')?.value || '').trim(),
    braveApiKey: (document.getElementById('settings-websearch-brave-key')?.value || '').trim(),
  };
  try {
    const r = await fetch(API + '/api/websearch/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
    out.className = 'settings-test-result ok';
    const parts = [`ok · ${data.provider}`, `${data.result_count} results`, `${data.latency_ms}ms`];
    out.textContent = parts.join(' · ');
    out.title = data.excerpt || '';
  } catch (e) {
    out.className = 'settings-test-result err';
    out.textContent = String(e.message || e).slice(0, 140);
  } finally { btn.disabled = false; }
}

let _maintPollTimer = null;

async function _maintTriggerRun() {
  const btn = document.getElementById('settings-maintainer-run');
  const el = document.getElementById('settings-maintainer-status');
  if (!btn) return;
  btn.disabled = true;
  if (el) { el.textContent = 'starting…'; el.style.color = 'var(--accent2)'; }
  try {
    const r = await fetch(API + '/api/maintainer/run', { method: 'POST', headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (_maintPollTimer) clearInterval(_maintPollTimer);
    _maintPollTimer = setInterval(async () => {
      await _maintRefreshStatus();
      const s = await fetch(API + '/api/maintainer/status', { headers: authHeaders() }).then(x => x.json()).catch(() => null);
      if (s && (s.job?.state === 'done' || s.job?.state === 'error' || s.job?.state === 'idle')) {
        clearInterval(_maintPollTimer); _maintPollTimer = null;
        btn.disabled = false;
      }
    }, 2500);
  } catch (e) {
    btn.disabled = false;
    if (el) { el.textContent = 'failed: ' + e.message; el.style.color = 'var(--danger)'; }
  }
}
async function _maintRefreshStatus() {
  const el = document.getElementById('settings-maintainer-status');
  if (!el) return;
  try {
    const r = await fetch(API + '/api/maintainer/status', { headers: authHeaders() });
    const d = await r.json();
    const c = d.counts || {};
    const job = d.job || { state: 'idle' };
    if (job.state === 'running') {
      const elapsed = Math.round((Date.now() - job.started) / 1000);
      el.textContent = `running (${elapsed}s)…`;
      el.style.color = 'var(--accent2)';
    } else {
      const parts = [];
      if (c.openGaps != null) parts.push(`${c.openGaps} open gaps`);
      if (c.answeredGaps != null) parts.push(`${c.answeredGaps} answered`);
      if (c.reflections != null) parts.push(`${c.reflections} reflections`);
      if (c.derivedFacts != null) parts.push(`${c.derivedFacts} derived`);
      el.textContent = parts.join(' · ');
      el.style.color = job.state === 'error' ? 'var(--danger)' : 'var(--text-dim)';
      if (job.state === 'error' && job.error) el.textContent += ` · error: ${String(job.error).slice(0,80)}`;
    }
  } catch (e) { el.textContent = 'status unavailable'; }
}
// ── Janitor ───────────────────────────────────────────────────────────
let _janPollTimer = null;

async function _janTriggerRun() {
  const btn = document.getElementById('settings-janitor-run');
  const el = document.getElementById('settings-janitor-status');
  if (!btn) return;
  btn.disabled = true;
  if (el) { el.textContent = 'starting…'; el.style.color = 'var(--accent2)'; }
  try {
    const r = await fetch(API + '/api/janitor/run', { method: 'POST', headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (_janPollTimer) clearInterval(_janPollTimer);
    _janPollTimer = setInterval(async () => {
      await _janRefreshStatus();
      const s = await fetch(API + '/api/janitor/status', { headers: authHeaders() }).then(x => x.json()).catch(() => null);
      if (s && (s.job?.state === 'done' || s.job?.state === 'error' || s.job?.state === 'idle')) {
        clearInterval(_janPollTimer); _janPollTimer = null;
        btn.disabled = false;
        _janLoadBin();
      }
    }, 2500);
  } catch (e) {
    btn.disabled = false;
    if (el) { el.textContent = 'failed: ' + e.message; el.style.color = 'var(--danger)'; }
  }
}

async function _janRefreshStatus() {
  const el = document.getElementById('settings-janitor-status');
  const modeSel = document.getElementById('settings-janitor-mode');
  if (!el) return;
  try {
    const r = await fetch(API + '/api/janitor/status', { headers: authHeaders() });
    const d = await r.json();
    const s = d.stats || {};
    const job = d.job || { state: 'idle' };
    if (modeSel && d.mode && modeSel.value !== d.mode) modeSel.value = d.mode;
    if (job.state === 'running') {
      const elapsed = Math.round((Date.now() - job.started) / 1000);
      el.textContent = `running (${elapsed}s)…`;
      el.style.color = 'var(--accent2)';
    } else {
      const parts = [];
      if (s.cycles != null) parts.push(`${s.cycles} cycles`);
      if (s.tempsTrashed != null) parts.push(`${s.tempsTrashed} temps`);
      if (s.attrsTrashed != null) parts.push(`${s.attrsTrashed} attrs`);
      if (s.nodesTrashed != null) parts.push(`${s.nodesTrashed} nodes`);
      if (s.restored != null) parts.push(`${s.restored} restored`);
      el.textContent = parts.join(' · ') || 'idle';
      el.style.color = job.state === 'error' ? 'var(--danger)' : 'var(--text-dim)';
      if (job.state === 'error' && job.error) el.textContent += ` · error: ${String(job.error).slice(0,80)}`;
    }
    const cc = document.getElementById('settings-janitor-bin-count');
    if (cc) cc.textContent = d.counts?.binItems ? `(${d.counts.binItems} items · auto-empty in ${d.recycle_bin_ttl_days || 14}d)` : `(empty)`;
  } catch (e) { el.textContent = 'status unavailable'; }
}

async function _janLoadBin() {
  const host = document.getElementById('settings-janitor-bin-list');
  if (!host) return;
  try {
    const r = await fetch(API + '/api/janitor/recycle-bin?limit=100', { headers: authHeaders() });
    const d = await r.json();
    const items = d.items || [];
    if (!items.length) {
      host.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:.68rem">Bin is empty.</div>';
      return;
    }
    host.innerHTML = items.map(it => {
      const when = it.deleted_at ? new Date(it.deleted_at.replace(' ', 'T') + 'Z').toLocaleString() : '';
      const conf = typeof it.confidence === 'number' ? ` · conf ${it.confidence.toFixed(2)}` : '';
      const by = it.deleted_by || '';
      const reason = (it.reason || '').replace(/</g, '&lt;');
      const label = (it.label || '').replace(/</g, '&lt;');
      return `<div style="padding:10px 12px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:.72rem;font-weight:600;word-break:break-word">${label} <span style="color:var(--text-dim);font-weight:400">(${it.item_type})</span></div>
            <div style="margin-top:2px;font-size:.64rem;color:var(--text-dim)">"${reason}" · ${when} · ${by}${conf}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="settings-btn-secondary" style="font-size:.62rem;padding:2px 6px" data-janitor-restore="${it.id}">restore</button>
            <button class="settings-btn-secondary" style="font-size:.62rem;padding:2px 6px;color:var(--danger)" data-janitor-forget="${it.id}">forget</button>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = '<div style="padding:12px;color:var(--danger);font-size:.68rem">Failed to load: ' + (e.message || e) + '</div>';
  }
}

async function _janRestore(id) {
  try {
    const r = await fetch(API + '/api/janitor/restore/' + encodeURIComponent(id), { method: 'POST', headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { alert('Restore failed: ' + (d.error || 'unknown')); return; }
    _janLoadBin();
    _janRefreshStatus();
  } catch (e) { alert('Restore error: ' + e.message); }
}

async function _janForget(id) {
  if (!confirm('Permanently forget this item? This cannot be undone.')) return;
  try {
    const r = await fetch(API + '/api/janitor/recycle-bin/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) { alert('Forget failed'); return; }
    _janLoadBin();
    _janRefreshStatus();
  } catch (e) { alert('Forget error: ' + e.message); }
}

async function _janEmptyBin() {
  if (!confirm('Empty the recycling bin? All items will be permanently deleted.')) return;
  try {
    const r = await fetch(API + '/api/janitor/recycle-bin/empty', { method: 'POST', headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { alert('Empty bin failed: ' + (d.error || 'unknown')); return; }
    _janLoadBin();
    _janRefreshStatus();
  } catch (e) { alert('Empty bin error: ' + e.message); }
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.id === 'settings-janitor-mode') {
    const mode = t.value;
    fetch(API + '/api/janitor/settings', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).then(r => r.json()).then(d => {
      if (!d.ok) alert('Mode change failed: ' + (d.error || 'unknown'));
    }).catch(e => alert('Mode change error: ' + e.message));
  }
});

// ── Graph backups ─────────────────────────────────────────────────────
async function _bkLoadStatus() {
  try {
    const r = await fetch(API + '/api/backups/status', { headers: authHeaders() });
    const d = await r.json();
    const intv = document.getElementById('settings-backup-interval');
    const ret = document.getElementById('settings-backup-retention');
    const en = document.getElementById('settings-backup-enabled');
    const oc = document.getElementById('settings-backup-on-change-only');
    if (intv && document.activeElement !== intv) intv.value = d.interval_minutes || 60;
    if (ret && document.activeElement !== ret) ret.value = d.retention || 20;
    if (en) en.checked = d.enabled !== false;
    if (oc) oc.checked = d.on_change_only !== false;
    const el = document.getElementById('settings-backup-status');
    if (el) {
      const s = d.stats || {};
      const parts = [];
      if (s.snapshots != null) parts.push(`${s.snapshots} snapshots`);
      if (s.skipped != null) parts.push(`${s.skipped} skipped`);
      if (s.rotated != null) parts.push(`${s.rotated} rotated`);
      if (s.lastSnapshotAt) parts.push(`last: ${new Date(s.lastSnapshotAt).toLocaleString()}`);
      el.textContent = parts.join(' · ') || 'idle';
    }
  } catch (e) {
    const el = document.getElementById('settings-backup-status');
    if (el) { el.textContent = 'status unavailable'; el.style.color = 'var(--danger)'; }
  }
}

async function _bkLoadList() {
  const host = document.getElementById('settings-backup-list');
  if (!host) return;
  try {
    const r = await fetch(API + '/api/backups', { headers: authHeaders() });
    const d = await r.json();
    const files = d.files || [];
    if (!files.length) {
      host.innerHTML = '<div style="padding:10px;color:var(--text-dim);font-size:.66rem">No snapshots yet — press "Snapshot now".</div>';
      return;
    }
    host.innerHTML = files.map(f => {
      const when = f.created ? new Date(f.created).toLocaleString() : '';
      const kb = (f.size / 1024).toFixed(1);
      const tagLabel = f.tag ? ` <span style="color:var(--accent2)">[${f.tag}]</span>` : '';
      return `<div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-size:.66rem;min-width:0;flex:1;word-break:break-all">
          <div>${f.file}${tagLabel}</div>
          <div style="color:var(--text-dim);margin-top:2px">${when} · ${kb} KB</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="settings-btn-secondary" style="font-size:.62rem;padding:2px 6px" data-backup-restore="${f.file}">restore</button>
          <button class="settings-btn-secondary" style="font-size:.62rem;padding:2px 6px;color:var(--danger)" data-backup-delete="${f.file}">delete</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:.66rem">Failed: ' + (e.message || e) + '</div>';
  }
}

async function _bkRunSnapshot() {
  const btn = document.getElementById('settings-backup-run');
  const el = document.getElementById('settings-backup-status');
  if (btn) btn.disabled = true;
  if (el) { el.textContent = 'snapshotting…'; el.style.color = 'var(--accent2)'; }
  try {
    const r = await fetch(API + '/api/backups/run', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!d.ok && !d.skipped) throw new Error(d.error || 'failed');
    if (el) { el.textContent = d.skipped ? 'skipped — unchanged' : `saved (${((d.size||0)/1024).toFixed(1)} KB)`; el.style.color = 'var(--text-dim)'; }
    _bkLoadList();
    _bkLoadStatus();
  } catch (e) {
    if (el) { el.textContent = 'failed: ' + e.message; el.style.color = 'var(--danger)'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _bkSaveSettings() {
  const intv = Number(document.getElementById('settings-backup-interval')?.value);
  const ret = Number(document.getElementById('settings-backup-retention')?.value);
  const en = !!document.getElementById('settings-backup-enabled')?.checked;
  const oc = !!document.getElementById('settings-backup-on-change-only')?.checked;
  try {
    const r = await fetch(API + '/api/backups/settings', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMinutes: intv, retention: ret, enabled: en, onChangeOnly: oc }),
    });
    const d = await r.json();
    if (!d.ok) { alert('Save failed: ' + (d.error || 'unknown')); return; }
    _bkLoadStatus();
  } catch (e) { alert('Save error: ' + e.message); }
}

async function _bkRestore(filename) {
  if (!confirm(`Restore graph from "${filename}"?\n\nThe current graph will be replaced. A safety snapshot is taken first, so you can undo this by restoring the auto-generated "pre-restore" snapshot.`)) return;
  try {
    const r = await fetch(API + '/api/backups/restore', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: filename }),
    });
    const d = await r.json();
    if (!d.ok) { alert('Restore failed: ' + (d.error || 'unknown')); return; }
    alert(`Restored: ${d.tablesRestored} tables, ${d.rowsRestored} rows. Pre-restore snapshot saved at ${d.preRestoreSnapshot ? d.preRestoreSnapshot.split('/').pop() : '(none)'}. Reloading graph…`);
    try { if (typeof loadGraph === 'function') loadGraph(); } catch {}
    _bkLoadList();
    _bkLoadStatus();
  } catch (e) { alert('Restore error: ' + e.message); }
}

// ── Graph / settings / providers export + import ───────────────────
async function _graphExportDownload() {
  const btn = document.getElementById('settings-graph-export');
  const el = document.getElementById('settings-graph-port-status');
  const wantGraph = document.getElementById('settings-export-graph')?.checked !== false;
  const wantSettings = document.getElementById('settings-export-settings')?.checked !== false;
  const wantProviders = !!document.getElementById('settings-export-providers')?.checked;
  const wantSecrets = wantProviders && !!document.getElementById('settings-export-secrets')?.checked;
  if (wantProviders && wantSecrets) {
    if (!confirm('Including API keys in the export makes the file sensitive — anyone who opens it can authenticate to your providers. Continue?')) return;
  }
  if (btn) btn.disabled = true;
  if (el) { el.textContent = 'exporting…'; el.style.color = 'var(--accent2)'; }
  try {
    const qs = new URLSearchParams({
      graph: wantGraph ? '1' : '0',
      settings: wantSettings ? '1' : '0',
      providers: wantProviders ? '1' : '0',
      secrets: wantSecrets ? '1' : '0',
    }).toString();
    const r = await fetch(API + '/api/graph/export?' + qs, { headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    let filename = 'spore-export.json';
    const cd = r.headers.get('content-disposition');
    if (cd) { const m = cd.match(/filename="?([^"]+)"?/); if (m) filename = m[1]; }
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    try {
      const text = await blob.text();
      const data = JSON.parse(text);
      const parts = [];
      if (data.graph?.stats) parts.push(`${data.graph.stats.exportedNodes || 0} nodes + ${data.graph.stats.exportedEdges || 0} edges`);
      if (data.providers) parts.push(`${Object.keys(data.providers).filter(k => k !== 'custom').length + Object.keys(data.providers.custom || {}).length} providers${data.includesSecrets ? ' (with keys)' : ' (redacted)'}`);
      if (data.settings) parts.push(`${Object.keys(data.settings).length} settings`);
      parts.push(`${(blob.size/1024).toFixed(1)} KB`);
      if (el) { el.textContent = 'exported: ' + parts.join(' · '); el.style.color = 'var(--text-dim)'; }
    } catch {}
  } catch (e) {
    if (el) { el.textContent = 'export failed: ' + e.message; el.style.color = 'var(--danger)'; }
  } finally { if (btn) btn.disabled = false; }
}

async function _graphImportUpload(file) {
  const el = document.getElementById('settings-graph-port-status');
  if (!file) return;
  if (el) { el.textContent = `reading ${file.name}…`; el.style.color = 'var(--accent2)'; }
  try {
    const text = await file.text();
    let preview;
    try { preview = JSON.parse(text); } catch (e) {
      if (el) { el.textContent = 'not valid JSON: ' + e.message; el.style.color = 'var(--danger)'; }
      return;
    }

    // Detect format — v2 bundle ('spore-export') or v1 ('spore-graph-export') or raw graph
    const isBundle = preview.format === 'spore-export';
    const hasGraph = isBundle ? !!preview.graph : preview.format === 'spore-graph-export';
    const hasProviders = isBundle && !!preview.providers;
    const hasSettings = isBundle && !!preview.settings;
    if (!hasGraph && !hasProviders && !hasSettings) {
      if (el) { el.textContent = `file doesn't look like a spore export (format=${preview.format || 'missing'})`; el.style.color = 'var(--danger)'; }
      return;
    }

    // Summarise and ask what to apply
    const parts = [];
    if (hasGraph) {
      const s = (isBundle ? preview.graph.stats : preview.stats) || {};
      parts.push(`graph: ${s.exportedNodes || 0} nodes + ${s.exportedEdges || 0} edges`);
    }
    if (hasProviders) {
      const custom = Object.keys(preview.providers.custom || {}).length;
      const builtIn = Object.keys(preview.providers).filter(k => k !== 'custom').length;
      parts.push(`providers: ${builtIn + custom} (${preview.includesSecrets ? 'with API keys' : 'redacted'})`);
    }
    if (hasSettings) {
      parts.push(`settings: ${Object.keys(preview.settings).length} keys`);
    }

    let msg = `Import from "${file.name}"?\n\nContents:\n  ${parts.join('\n  ')}`;
    if (hasGraph) msg += `\n\nImporting applies the knowledge graph (nodes, aspects, edges).`;
    if (hasProviders) msg += `\nImporting providers ${preview.includesSecrets ? 'WILL overwrite your current API keys and URLs' : 'will set URLs / model selections but NOT overwrite existing keys (values were redacted in the export)'}.`;
    if (hasSettings) msg += `\nImporting settings will update display name, model tiers, janitor/backup knobs, cluster config, etc.`;
    msg += `\n\nA pre-import backup of the graph will be taken. Continue?`;
    if (!confirm(msg)) {
      if (el) { el.textContent = 'import cancelled'; el.style.color = 'var(--text-dim)'; }
      return;
    }

    const qs = new URLSearchParams({
      apply_graph: hasGraph ? '1' : '0',
      apply_providers: hasProviders ? '1' : '0',
      apply_settings: hasSettings ? '1' : '0',
    }).toString();

    const r = await fetch(API + '/api/graph/import?' + qs, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: text,
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      if (el) { el.textContent = 'import failed: ' + (d.error || 'HTTP ' + r.status); el.style.color = 'var(--danger)'; }
      return;
    }
    const rep = d.report || {};
    const lines = [];
    if (rep.graph) {
      const g = rep.graph;
      if (g.error) {
        lines.push(`graph: ${g.error}`);
      } else {
        lines.push(`graph: ${g.nodesImported || 0} nodes · ${g.aspectsImported || 0} aspects · ${g.attributesImported || 0} attrs · ${g.edgesImported || 0} edges · skipped ${(g.nodesSkipped || []).length} nodes + ${(g.edgesSkipped || []).length} edges`);
      }
    }
    if (rep.providers) {
      lines.push(`providers: applied ${rep.providers.applied.length}${rep.providers.skipped.length ? ' · redacted ' + rep.providers.skipped.length : ''}`);
    }
    if (rep.settings) {
      lines.push(`settings: applied ${rep.settings.applied.length}`);
    }
    if (el) { el.textContent = lines.join('\n') || 'imported (no changes)'; el.style.color = 'var(--text)'; }
    try { if (typeof loadGraph === 'function') loadGraph(); } catch {}
  } catch (e) {
    if (el) { el.textContent = 'import error: ' + e.message; el.style.color = 'var(--danger)'; }
  }
}

// Hook the hidden file input
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t && t.id === 'settings-graph-import-file' && t.files?.[0]) {
    const f = t.files[0];
    t.value = ''; // reset so re-selecting the same file still triggers change
    _graphImportUpload(f);
  }
});

async function _bkDelete(filename) {
  if (!confirm(`Permanently delete "${filename}"?`)) return;
  try {
    const r = await fetch(API + '/api/backups/' + encodeURIComponent(filename), { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) { alert('Delete failed'); return; }
    _bkLoadList();
  } catch (e) { alert('Delete error: ' + e.message); }
}


// Refresh status whenever the settings pane is opened
const _origOpenSettings = typeof openSettingsPanel === 'function' ? openSettingsPanel : null;
if (_origOpenSettings && !window.__maintStatusHooked) {
  window.__maintStatusHooked = true;
  const _wrap = async function(...args) {
    const r = await _origOpenSettings.apply(this, args);
    _maintRefreshStatus();
    _janRefreshStatus();
    _janLoadBin();
    _bkLoadStatus();
    _bkLoadList();
    return r;
  };
  window.openSettingsPanel = _wrap;
}
document.getElementById('settings-new-graph')?.addEventListener('click', () => {
  if (typeof openNewGraphModal === 'function') openNewGraphModal();
  else if (typeof showNewGraphModal === 'function') showNewGraphModal();
});

document.getElementById('filter-type').onchange = (e) => {
  const type = e.target.value;
  gNodes.selectAll('g').attr('opacity', d => (!type || d.type === type) ? 1 : 0.12);
  gLinks.selectAll('line').attr('opacity', d => {
    if (!type) return 1;
    const s = d.source.type || graphData.nodes.find(n => n.id === d.source)?.type;
    const t = d.target.type || graphData.nodes.find(n => n.id === d.target)?.type;
    return (s === type || t === type) ? 1 : 0.05;
  });
};

document.getElementById('search-input').oninput = (e) => {
  const q = e.target.value.toLowerCase();
  if (!q) {
    gNodes.selectAll('g').attr('opacity', 1);
    gLinks.selectAll('line').attr('opacity', 1);
    return;
  }
  const matches = new Set(graphData.nodes.filter(n =>
    n.label.toLowerCase().includes(q) || n.id.includes(q) || n.type.includes(q) ||
    (n.description||'').toLowerCase().includes(q)
  ).map(n => n.id));

  gNodes.selectAll('g').attr('opacity', d => matches.has(d.id) ? 1 : 0.1);
  gLinks.selectAll('line').attr('opacity', d => {
    const s = d.source.id || d.source;
    const t = d.target.id || d.target;
    return (matches.has(s) || matches.has(t)) ? 0.5 : 0.03;
  });
};

// ── Resizable Panels ──
function initResize(handleId, targetId, side) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;

  let startX, startW, pointerId;

  function onPointerDown(e) {
    e.preventDefault();
    pointerId = e.pointerId;
    startX = e.clientX;
    startW = target.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    try { handle.setPointerCapture(pointerId); } catch (_) {}
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const newW = side === 'left' ? startW + dx : startW - dx;
    const clamped = Math.max(220, Math.min(newW, window.innerWidth * 0.5));
    target.style.width = clamped + 'px';
    target.style.minWidth = clamped + 'px';
  }

  function onPointerUp(e) {
    if (e && e.pointerId !== pointerId) return;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { handle.releasePointerCapture(pointerId); } catch (_) {}
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerUp);
  }

  handle.addEventListener('pointerdown', onPointerDown);
}

initResize('resize-left', 'chat-panel', 'right');
initResize('resize-right', 'right-panel', 'left');

// Double-click resize handles to collapse the adjacent panel
document.getElementById('resize-left')?.addEventListener('dblclick', () => togglePanel('chat-panel'));
document.getElementById('resize-right')?.addEventListener('dblclick', () => togglePanel('right-panel'));

// ── Mobile Nav ──
document.getElementById('mobile-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  const view = btn.dataset.view;
  document.querySelectorAll('#mobile-nav button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const chat = document.getElementById('chat-panel');
  const canvas = document.getElementById('canvas');
  const rp = document.getElementById('right-panel');

  chat.classList.remove('mobile-active');
  canvas.classList.remove('mobile-active');
  rp.classList.remove('mobile-active');

  if (view === 'chat') chat.classList.add('mobile-active');
  else if (view === 'graph') canvas.classList.add('mobile-active');
  else if (view === 'panel') {
    rp.classList.add('mobile-active');
    rp.classList.remove('closed');
    if (activeRpTabs.size === 0) openRightPanel('files-pane', false);
  }
});

// ── Boot (called after login) ──
let _appBooted = false;
function initApp() {
  if (_appBooted) return;
  _appBooted = true;
  fetchGraph().then(data => initGraph(data)).catch(e => {
    document.getElementById('stats').textContent = 'Failed to load graph: ' + e.message;
  });
  connectWs();
  loadAgentIdentity();
  restorePanelState();
  const rpState = _panelState();
  if (_usesFloatingWindows()) {
    if (activeRpTabs.has('files-pane')) fpLoadDir(fpCurrentPath || '');
    if (activeRpTabs.has('logs-pane')) loadLogs();
    if (activeRpTabs.has('skills-pane')) skLoadList();
    if (window.__restoreTerminalOnBoot && !window.isTerminalOpen?.()) {
      window.__restoreTerminalOnBoot = false;
      window.toggleTerminal?.();
    }
  } else if (rpState['right-panel'] !== false) {
    openRightPanel('files-pane', false);
  }
  syncRpButtons();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}


