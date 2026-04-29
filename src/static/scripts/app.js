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

// ── First-run onboarding wizard ────────────────────────────────────────
// Two modes share the same overlay infrastructure:
//   'operator' — the long 9-step wizard run on a fresh instance
//   'user'     — the slim 4-step wizard a self-registered guest sees
const OB_STEP_MAP = {
  // Order: welcome → theme → identity → account → plugins → provider TYPE
  // picker → provider config (keys + test) → models → vlm → voice/search
  // → browser. Provider step split into two: 'pp' (which providers do you
  // want?) before '5' (configure + test the picked ones).
  operator: ['1', '2', '3', '4', 'p', 'pp', '5', '6', '7', '8', '9'],
  user: ['1', '2', 'u3', 'u4'],
};

// Map: provider-plugin id → wizard provider tile id. Provider plugins
// are filtered OUT of the plugins step and toggled instead from the
// provider type-picker (step 'pp'). Picking a provider tile flips its
// plugin's enabled flag in _obData.plugins so the standard onboarding
// finish handler installs/skips the right ones.
const OB_PROVIDER_PLUGIN_MAP = {
  'anthropic-provider':  'anthropic',
  'openai-provider':     'openai',
  'openrouter-provider': 'openrouter',
  'gemini-provider':     'gemini',
  'local-oai-provider':  'local',  // tile labelled "OAI-compatible endpoint"; saves baseUrl/apiKey to localModelBaseUrl/localModelApiKey
};

// Reverse map for committing picker selections back into _obData.plugins.
const OB_TILE_TO_PLUGIN = Object.fromEntries(
  Object.entries(OB_PROVIDER_PLUGIN_MAP).map(([plugin, tile]) => [tile, plugin])
);
const OB_OPTIONAL_BY_MODE = {
  operator: new Set([7, 8]),
  user: new Set(),
};
let _obMode = 'operator';
function _obStepCount() { return OB_STEP_MAP[_obMode].length; }
function _obIsOptional(n) { return OB_OPTIONAL_BY_MODE[_obMode].has(n); }
// Legacy aliases — code below still references these names in places.
const OB_TOTAL_STEPS = 9; // upper bound; effective count is _obStepCount()
const OB_OPTIONAL_STEPS = OB_OPTIONAL_BY_MODE.operator;
let _obStep = 1;
let _obData = { theme: 'dark', providers: {} };

function startOnboarding() {
  document.getElementById('app').classList.add('hidden');
  const ov = document.getElementById('onboarding-overlay');
  ov.classList.remove('hidden');
  // Use the canonical F01 mark from brand.js in the persistent header.
  // The big animated version on step 1 is built separately by _obStartHero.
  const headMark = document.getElementById('ob-brand-mark');
  if (headMark && window.BRAND?.chatLogo) headMark.innerHTML = window.BRAND.chatLogo;
  const titleEl = document.getElementById('ob-title');
  if (titleEl && window.BRAND?.Agent) titleEl.textContent = `Welcome to ${window.BRAND.Agent}`;
  _obRenderDots();
  _obRenderThemeGrid();
  _obRenderProvidersList();
  _obShowStep(1);
  const cached = localStorage.getItem('spore-theme');
  if (cached && THEMES[cached]) _obPickTheme(cached);
  document.getElementById('ob-next').addEventListener('click', _obNext);
  document.getElementById('ob-back').addEventListener('click', _obBack);
  document.getElementById('ob-skip').addEventListener('click', _obSkip);
  document.getElementById('ob-voice-enabled').addEventListener('change', (e) => {
    document.getElementById('ob-voice-fields').style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById('ob-websearch-test').addEventListener('click', _obTestWebSearch);
}

async function _obTestWebSearch() {
  const btn = document.getElementById('ob-websearch-test');
  const out = document.getElementById('ob-websearch-result');
  const payload = {
    searxngUrl: document.getElementById('ob-searxng-url').value.trim(),
    searxngApiKey: document.getElementById('ob-searxng-key').value.trim(),
    braveApiKey: document.getElementById('ob-brave-key').value.trim(),
  };
  if (!payload.searxngUrl && !payload.braveApiKey) {
    out.className = 'ob-test-result err'; out.textContent = 'set SearXNG URL or Brave key';
    return;
  }
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    const r = await fetch(API + '/api/websearch/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    out.className = 'ob-test-result ok';
    out.textContent = `ok · ${d.provider} · ${d.result_count} results · ${d.latency_ms}ms`;
    out.title = d.excerpt || '';
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 120);
  } finally { btn.disabled = false; }
}

function _obRenderDots() {
  const el = document.getElementById('onboarding-dots');
  let html = '';
  const count = _obStepCount();
  for (let i = 1; i <= count; i++) html += `<span data-dot="${i}"></span>`;
  el.innerHTML = html;
  _obUpdateDots();
}
function _obUpdateDots() {
  document.querySelectorAll('#onboarding-dots span').forEach(el => {
    const i = parseInt(el.dataset.dot, 10);
    el.classList.toggle('active', i === _obStep);
    el.classList.toggle('done', i < _obStep);
  });
}

function _obShowStep(n) {
  // Leaving step '5' with the provider editor open (e.g. operator typed
  // values then clicked Back) — capture the form into _obProviderEntries
  // first so the input survives the round-trip. Without this, going Back
  // from '5' returns to a re-rendered editor with empty fields.
  const prevKey = _obStep ? OB_STEP_MAP[_obMode][_obStep - 1] : null;
  if (prevKey === '5' && _obProviderEditing != null && typeof _obCaptureEditorForm === 'function' && _obCaptureEditorForm) {
    try { _obCaptureEditorForm(); } catch { /* silent: missing DOM nodes — ignore */ }
  }
  _obStep = n;
  const sectionKey = OB_STEP_MAP[_obMode][n - 1];
  document.querySelectorAll('.ob-step').forEach(s => s.classList.toggle('active', s.dataset.step === sectionKey));
  document.getElementById('ob-back').disabled = n === 1;
  const skipBtn = document.getElementById('ob-skip');
  skipBtn.style.display = _obIsOptional(n) ? '' : 'none';
  const total = _obStepCount();
  document.getElementById('ob-next').textContent = n === total ? 'Finish' : 'Next';
  _obUpdateDots();
  if (n === 1) _obStartHero();
  else _obStopHero();
  if (_obMode === 'operator') {
    // sectionKey-based renders so reordering/inserting steps stays clean.
    if (sectionKey === '6') _obRenderTierRows('ob-tier-rows', ['casual','normal','planner','subagent','learner']);
    if (sectionKey === '7') _obRenderTierRows('ob-vlm-rows', ['imageVlm','videoVlm','audioVlm']);
    if (sectionKey === 'p')  _obRenderPluginPicker();
    if (sectionKey === 'pp') _obRenderProviderTypePicker();
    if (sectionKey === '5')  _obRenderProvidersList();
  }
  if (_obMode === 'user' && sectionKey === 'u3') {
    // Pre-fill display name with username if blank.
    const inp = document.getElementById('ob-user-displayname');
    if (inp && !inp.value) inp.value = _currentUserName || '';
  }
  // Apply the finish gate whenever the step changes — the gate only
  // actually enforces on the final step, but checking on every render
  // means the button text + disabled state stay coherent if the user
  // navigates back from Finish.
  _obUpdateFinishGate();
}

let _obHeroRaf = null;
// F01 Six-petal Spore mark, big, with a subtle staggered bloom — petals
// breathe in/out one after the other, ~3.6s cycle. Spec from
// /design_stuff/spore logo and node/README.md (geometry + amber #c8762c).
// Ink uses currentColor → follows the host CSS theme.
const _OB_PETALS = (() => {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    out.push({ x: 0.62 * Math.cos(a), y: 0.62 * Math.sin(a) });
  }
  return out;
})();
// A06 Wobble — petal offset perpendicular to its spoke by
// `sin(t*1.8 + i*1.1) * 0.04`. Spec says don't use CSS/SMIL: the
// per-petal phase needs continuous t. Honors prefers-reduced-motion
// by rendering the static F01 with no raf.
function _obStartHero() {
  const host = document.getElementById('ob-hero-mark');
  if (!host) return;
  _obStopHero();
  host.innerHTML = `<svg viewBox="-1 -1 2 2" width="160" height="160" style="overflow:visible" aria-label="SPORE">
    <g data-hero-spokes stroke="currentColor" stroke-width="0.04" stroke-linecap="round">
      ${_OB_PETALS.map((_, i) => `<line data-i="${i}" x1="0" y1="0"></line>`).join('')}
    </g>
    <g data-hero-petals fill="#c8762c">
      ${_OB_PETALS.map((_, i) => `<circle data-i="${i}" r="0.16"></circle>`).join('')}
    </g>
    <circle cx="0" cy="0" r="0.18" fill="currentColor"></circle>
  </svg>`;
  const spokes = host.querySelectorAll('[data-hero-spokes] line');
  const petals = host.querySelectorAll('[data-hero-petals] circle');

  // Per-petal perpendicular unit vector (rotate spoke direction by 90°).
  const perp = _OB_PETALS.map(p => {
    const a = Math.atan2(p.y, p.x);
    return { x: -Math.sin(a), y: Math.cos(a) };
  });
  const place = (i, x, y) => {
    spokes[i].setAttribute('x2', x.toFixed(4));
    spokes[i].setAttribute('y2', y.toFixed(4));
    petals[i].setAttribute('cx', x.toFixed(4));
    petals[i].setAttribute('cy', y.toFixed(4));
  };
  // Initial static placement — also the reduced-motion fallback.
  _OB_PETALS.forEach((p, i) => place(i, p.x, p.y));

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;

  const t0 = performance.now() / 1000;
  const tick = () => {
    const t = performance.now() / 1000 - t0;
    for (let i = 0; i < _OB_PETALS.length; i++) {
      const p = _OB_PETALS[i];
      const off = Math.sin(t * 1.8 + i * 1.1) * 0.04;
      place(i, p.x + perp[i].x * off, p.y + perp[i].y * off);
    }
    _obHeroRaf = requestAnimationFrame(tick);
  };
  tick();
}
function _obStopHero() {
  if (_obHeroRaf != null) { cancelAnimationFrame(_obHeroRaf); _obHeroRaf = null; }
  const host = document.getElementById('ob-hero-mark');
  if (host) host.innerHTML = '';
}

function _obRenderThemeGrid() {
  const grid = document.getElementById('ob-theme-grid');
  grid.innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<div class="ob-theme-tile" data-theme="${k}"><div class="swatch" style="background:${t.swatch}"></div><div class="name">${t.label}</div></div>`
  ).join('');
  grid.querySelectorAll('.ob-theme-tile').forEach(el => {
    el.addEventListener('click', () => _obPickTheme(el.dataset.theme));
  });
}
function _obPickTheme(name) {
  _obData.theme = name;
  applyGraphTheme(name);
  document.querySelectorAll('#ob-theme-grid .ob-theme-tile').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === name);
  });
}

const OB_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', sub: 'Claude models', fields: [{ key: 'apiKey', type: 'password', placeholder: 'sk-ant-...' }], modelsPlaceholder: 'claude-sonnet-4-6, claude-haiku-4-5' },
  { id: 'openai', label: 'OpenAI', sub: 'GPT + Whisper', fields: [{ key: 'apiKey', type: 'password', placeholder: 'sk-...' }, { key: 'baseUrl', type: 'text', placeholder: 'optional base url' }], modelsPlaceholder: 'gpt-4o, gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', sub: 'Many models, one key', fields: [{ key: 'apiKey', type: 'password', placeholder: 'sk-or-...' }], modelsPlaceholder: 'anthropic/claude-sonnet-4-6' },
  { id: 'gemini', label: 'Google Gemini', sub: 'Multimodal: vision + audio + video', fields: [{ key: 'apiKey', type: 'password', placeholder: 'AIza...' }], modelsPlaceholder: 'gemini-2.5-flash, gemini-2.0-pro' },
  { id: 'local', label: 'OAI-compatible endpoint', sub: 'Any OpenAI-style API — vLLM, LM Studio, Ollama, llama.cpp, self-hosted, third-party. Use prefix oai/<model>.', fields: [{ key: 'baseUrl', type: 'text', placeholder: 'http://your-host:8080/v1' }, { key: 'apiKey', type: 'password', placeholder: 'optional bearer token' }], modelsPlaceholder: 'glm-5.1-fp8, llama-3.1-8b', authHeaderField: true },
];

// Provider step is state-driven now: operator adds providers one at a
// time via a small flow (Add → pick type → fill form → save → card).
// _obProviderEntries is the source of truth; the legacy _obReadProvider
// / _obReadCustomProviders functions read from it so the rest of the
// wizard (model-tier picker, configured-providers gate, payload
// builder) keeps working unchanged.
let _obProviderEntries = [];
let _obProviderEditing = null; // index into entries, or null when listing
let _obCaptureEditorForm = null; // closure exposed by _obRenderProviderEditor; nulled on close

// Step 'pp' — provider TYPE picker. This is the canonical place to
// enable provider plugins (anthropic-provider, openai-provider, etc.) —
// the plugins step filters them out so the operator picks them here
// alongside their configuration intent. Picking a tile adds an entry to
// _obProviderEntries (which step '5' renders as a fillable card) AND
// flips _obData.plugins[<plugin-id>].enabled so the existing
// onboarding/complete handler installs the right plugins.
function _obRenderProviderTypePicker() {
  const root = document.getElementById('ob-pp-grid');
  if (!root) return;
  const isPicked = (id) => _obProviderEntries.some(e => e.kind === 'builtin' && e.id === id);
  const isPickedCustom = () => _obProviderEntries.some(e => e.kind === 'custom');

  const tile = (id, label, sub, kind = 'builtin') => `
    <label class="ob-pp-tile" style="cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--surface);display:flex;gap:10px;align-items:flex-start">
      <input type="checkbox" data-pp-${kind}="${_settingsEscapeHtml(id)}" ${(kind === 'builtin' ? isPicked(id) : isPickedCustom()) ? 'checked' : ''} style="width:auto;margin-top:3px">
      <div style="flex:1;min-width:0">
        <strong>${_settingsEscapeHtml(label)}</strong>
        <div class="settings-note" style="opacity:.7">${_settingsEscapeHtml(sub)}</div>
      </div>
    </label>`;

  root.innerHTML = OB_PROVIDERS.map(t => tile(t.id, t.label, t.sub)).join('');
}

// Sync the picker checkboxes into _obProviderEntries AND _obData.plugins.
// Newly-checked tiles add fresh entries + mark their plugin enabled;
// unchecked tiles drop existing entries + mark their plugin disabled.
// Existing entries' partial fills (apiKey/baseUrl/etc.) are preserved
// across back-and-forth navigation.
function _obCommitProviderTypeChoices() {
  const builtinChecked = new Set();
  document.querySelectorAll('[data-pp-builtin]').forEach(el => {
    if (el.checked) builtinChecked.add(el.getAttribute('data-pp-builtin'));
  });

  // Drop unchecked builtins from entries.
  _obProviderEntries = _obProviderEntries.filter(e => {
    if (e.kind === 'builtin') return builtinChecked.has(e.id);
    return true; // keep any pre-existing custom entries (e.g. SPORE_PROVIDER_<NAME>_* env vars)
  });
  // Add fresh entries for newly-checked builtins.
  for (const id of builtinChecked) {
    if (!_obProviderEntries.some(e => e.kind === 'builtin' && e.id === id)) {
      _obProviderEntries.push({ kind: 'builtin', id, apiKey: '', baseUrl: '', models: '' });
    }
  }

  // Mirror tile selections to _obData.plugins so the onboarding/complete
  // handler installs the right provider plugins. Each builtin tile maps
  // 1:1 to a plugin id via OB_PROVIDER_PLUGIN_MAP.
  if (!_obData.plugins) _obData.plugins = {};
  for (const [pluginId, tileId] of Object.entries(OB_PROVIDER_PLUGIN_MAP)) {
    if (!_obData.plugins[pluginId]) _obData.plugins[pluginId] = { enabled: false, config: {} };
    _obData.plugins[pluginId].enabled = builtinChecked.has(tileId);
  }
}

function _obRenderProvidersList() {
  const root = document.getElementById('ob-providers-state');
  if (!root) return;
  // Stale-index guard: if _obProviderEditing points past the array
  // (e.g. operator removed the entry from the list, or _obCommitProviderTypeChoices
  // dropped it because the tile got unchecked in step 'pp'), reset to
  // null so we render the list view instead of crashing on
  // _obProviderEntries[i].kind for an undefined entry.
  if (_obProviderEditing != null && !_obProviderEntries[_obProviderEditing]) {
    _obProviderEditing = null;
  }
  if (_obProviderEditing != null) {
    _obRenderProviderEditor(root, _obProviderEditing);
    return;
  }
  // Restrict the picker to providers whose plugin was enabled in step
  // 'p'. If the operator hasn't visited that step yet OR no provider
  // plugins were picked, fall back to ALL OB_PROVIDERS so the wizard
  // remains usable when the plugins step is skipped (e.g. on user-mode
  // re-entry). Custom OAI is always available.
  const enabledProviderTileIds = new Set();
  for (const [pluginId, sel] of Object.entries(_obData.plugins || {})) {
    if (sel?.enabled && OB_PROVIDER_PLUGIN_MAP[pluginId]) {
      enabledProviderTileIds.add(OB_PROVIDER_PLUGIN_MAP[pluginId]);
    }
  }
  const allowedTypes = enabledProviderTileIds.size > 0
    ? OB_PROVIDERS.filter(t => enabledProviderTileIds.has(t.id))
    : OB_PROVIDERS;
  const usedIds = new Set(_obProviderEntries.filter(e => e.kind === 'builtin').map(e => e.id));
  const availableTypes = allowedTypes.filter(t => !usedIds.has(t.id));
  if (_obProviderEntries.length === 0) {
    const emptyHint = 'No providers picked. Go back to "Choose your providers" and tick at least one tile.';
    root.innerHTML = `<div style="padding:22px;border:1px dashed var(--border);border-radius:10px;text-align:center;background:var(--surface)">
      <div style="margin-bottom:8px;color:var(--text-dim,var(--text))">${_settingsEscapeHtml(emptyHint)}</div>
      <button type="button" class="ob-btn" id="ob-add-provider-btn">+ Add a provider</button>
    </div>`;
  } else {
    const cards = _obProviderEntries.map((e, i) => _obRenderProviderCard(e, i)).join('');
    const moreLeft = availableTypes.length > 0;
    root.innerHTML = cards + `<button type="button" class="ob-btn" id="ob-add-provider-btn" style="align-self:flex-start">${moreLeft ? '+ Add another provider' : '+ Add custom provider'}</button>`;
  }
  document.getElementById('ob-add-provider-btn')?.addEventListener('click', () => _obShowProviderPicker(availableTypes));
  root.querySelectorAll('[data-edit-i]').forEach(el => el.addEventListener('click', () => {
    _obProviderEditing = Number(el.dataset.editI);
    _obRenderProvidersList();
  }));
  root.querySelectorAll('[data-remove-i]').forEach(el => el.addEventListener('click', () => {
    const i = Number(el.dataset.removeI);
    _obProviderEntries.splice(i, 1);
    _obRenderProvidersList();
  }));
}

function _obRenderProviderCard(e, i) {
  const t = e.kind === 'builtin' ? OB_PROVIDERS.find(p => p.id === e.id) : null;
  const label = t ? t.label : `Custom: ${e.name || '(unnamed)'}`;
  const sub = t ? t.sub : (e.url || '');
  const keyMask = e.apiKey ? `${e.apiKey.slice(0, 4)}…${e.apiKey.slice(-4)}` : '(no key)';
  const modelsLine = e.models
    ? `<div class="settings-note" style="opacity:.7;margin-top:2px">models: ${_settingsEscapeHtml(String(e.models).slice(0, 100))}</div>`
    : `<div class="settings-note" style="opacity:.55;margin-top:2px">no models declared yet</div>`;
  // Green-test indicator. Required for at least one provider before Finish.
  const testBadge = e.lastTestResult === 'ok'
    ? '<span class="ob-test-result ok" style="margin-left:8px">✓ verified</span>'
    : (e.lastTestResult === 'fail'
        ? '<span class="ob-test-result err" style="margin-left:8px">✗ test failed</span>'
        : '<span class="settings-note" style="opacity:.55;margin-left:8px">untested</span>');
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">
    <div style="flex:1;min-width:0">
      <div><strong>${_settingsEscapeHtml(label)}</strong> <span class="settings-note" style="opacity:.55;margin-left:6px">${_settingsEscapeHtml(sub)}</span>${testBadge}</div>
      <div class="settings-note" style="opacity:.7;margin-top:2px">key: <code>${_settingsEscapeHtml(keyMask)}</code></div>
      ${modelsLine}
    </div>
    <button type="button" class="ob-btn" data-edit-i="${i}">edit</button>
    <button type="button" class="ob-btn" data-remove-i="${i}">remove</button>
  </div>`;
}

function _obShowProviderPicker(availableTypes) {
  const root = document.getElementById('ob-providers-state');
  const tile = (id, label, sub, isCustom = false) => `
    <button type="button" data-pick-${isCustom ? 'custom="1"' : `builtin="${_settingsEscapeHtml(id)}"`} style="text-align:left;border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--surface);cursor:pointer;font:inherit;color:inherit">
      <strong>${_settingsEscapeHtml(label)}</strong>
      <div class="settings-note" style="opacity:.7">${_settingsEscapeHtml(sub)}</div>
    </button>`;
  const items = availableTypes.map(t => tile(t.id, t.label, t.sub)).join('');
  root.innerHTML = `<div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)">
    <div style="margin-bottom:10px"><strong>Pick a provider type</strong></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
      ${items}
      ${tile('custom', 'Custom OAI-compatible', 'Self-hosted or third-party endpoint (vLLM, LM Studio, Ollama, …)', true)}
    </div>
    <div style="margin-top:12px"><button type="button" class="ob-btn" id="ob-picker-cancel">Cancel</button></div>
  </div>`;
  document.getElementById('ob-picker-cancel').addEventListener('click', _obRenderProvidersList);
  root.querySelectorAll('[data-pick-builtin]').forEach(el => el.addEventListener('click', () => {
    _obProviderEntries.push({ kind: 'builtin', id: el.dataset.pickBuiltin, apiKey: '', baseUrl: '', models: '' });
    _obProviderEditing = _obProviderEntries.length - 1;
    _obRenderProvidersList();
  }));
  root.querySelectorAll('[data-pick-custom]').forEach(el => el.addEventListener('click', () => {
    _obProviderEntries.push({ kind: 'custom', name: '', apiKey: '', url: '', authHeader: 'Authorization', models: '' });
    _obProviderEditing = _obProviderEntries.length - 1;
    _obRenderProvidersList();
  }));
}

function _obRenderProviderEditor(root, i) {
  const e = _obProviderEntries[i];
  const esc = _settingsEscapeHtml;
  const closeBar = `<div style="display:flex;gap:8px;margin-top:12px;align-items:center">
      <button type="button" class="ob-btn" id="ob-edit-save">Save</button>
      <button type="button" class="ob-btn" id="ob-edit-cancel">Cancel</button>
      <span style="flex:1"></span>
      <button type="button" class="ob-test-btn" id="ob-edit-populate">populate models</button>
      <button type="button" class="ob-test-btn" id="ob-edit-test">test</button>
      <span class="ob-test-result" id="ob-edit-test-result"></span>
    </div>`;
  if (e.kind === 'builtin') {
    const t = OB_PROVIDERS.find(p => p.id === e.id);
    const baseField = (t.fields || []).find(f => f.key === 'baseUrl');
    const keyField  = (t.fields || []).find(f => f.key === 'apiKey');
    // Auth-header values match OAICompatClient + plugin-pane schema —
    // 'bearer' / 'x-api-key' / 'x-key'. Don't use 'Authorization' as a
    // value (it was an older naming attempt that diverged from the
    // plugin pane and silently shipped the wrong header at chat time).
    const authVal = e.authHeader || 'bearer';
    const authBlock = t.authHeaderField ? `
      <label for="ob-edit-auth">Auth header</label>
      <select id="ob-edit-auth">
        <option value="bearer"${authVal === 'bearer' ? ' selected' : ''}>Authorization (Bearer)</option>
        <option value="x-api-key"${authVal === 'x-api-key' ? ' selected' : ''}>x-api-key</option>
        <option value="x-key"${authVal === 'x-key' ? ' selected' : ''}>x-key</option>
      </select>` : '';
    root.innerHTML = `<div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)">
      <div style="margin-bottom:10px"><strong>${esc(t.label)}</strong> <span class="settings-note" style="opacity:.6">${esc(t.sub)}</span></div>
      <label for="ob-edit-key">API Key</label>
      <input type="password" id="ob-edit-key" placeholder="${esc(keyField?.placeholder || '')}" value="${esc(e.apiKey || '')}">
      ${baseField ? `<label for="ob-edit-base">Base URL (optional)</label>
        <input type="text" id="ob-edit-base" placeholder="${esc(baseField.placeholder || '')}" value="${esc(e.baseUrl || '')}">` : ''}
      ${authBlock}
      <label for="ob-edit-models">Models (comma-separated)</label>
      <input type="text" id="ob-edit-models" placeholder="${esc(t.modelsPlaceholder || '')}" value="${esc(e.models || '')}">
      ${closeBar}
    </div>`;
  } else {
    root.innerHTML = `<div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)">
      <div style="margin-bottom:10px"><strong>Custom OAI-compatible</strong> <span class="settings-note" style="opacity:.6">self-hosted or third-party</span></div>
      <label for="ob-edit-name">Prefix (used as <code>prefix/model</code> in tier routing)</label>
      <input type="text" id="ob-edit-name" placeholder="e.g. glm, qwen, vllm-1" value="${esc(e.name || '')}">
      <label for="ob-edit-url">Base URL</label>
      <input type="text" id="ob-edit-url" placeholder="https://api.example.com/v1" value="${esc(e.url || '')}">
      <label for="ob-edit-key">API Key (optional)</label>
      <input type="password" id="ob-edit-key" value="${esc(e.apiKey || '')}">
      <label for="ob-edit-auth">Auth header</label>
      <select id="ob-edit-auth">
        <option value="Authorization"${e.authHeader === 'Authorization' ? ' selected' : ''}>Authorization (Bearer)</option>
        <option value="x-api-key"${e.authHeader === 'x-api-key' ? ' selected' : ''}>x-api-key</option>
        <option value="x-key"${e.authHeader === 'x-key' ? ' selected' : ''}>x-key</option>
      </select>
      <label for="ob-edit-models">Models (comma-separated)</label>
      <input type="text" id="ob-edit-models" placeholder="my-model-1, my-model-2" value="${esc(e.models || '')}">
      ${closeBar}
    </div>`;
  }
  const get = id => document.getElementById(id)?.value?.trim() || '';
  // Hash the connection-relevant form values (not models — that's
  // metadata, doesn't affect whether the test would pass). If the
  // hash changes after a green test, the lastTestResult flag clears
  // so the operator must re-verify before Finish.
  const hashConnectionFields = () => {
    if (e.kind === 'builtin') {
      return [e.id, e.apiKey || '', e.baseUrl || '', e.authHeader || ''].join('|');
    }
    return [e.url || '', e.apiKey || '', e.authHeader || ''].join('|');
  };
  const captureForm = () => {
    const before = hashConnectionFields();
    if (e.kind === 'builtin') {
      e.apiKey = get('ob-edit-key');
      e.baseUrl = get('ob-edit-base') || '';
      const authEl = document.getElementById('ob-edit-auth');
      if (authEl) e.authHeader = authEl.value || 'bearer';
      e.models = get('ob-edit-models');
    } else {
      e.name = get('ob-edit-name').replace(/[^a-z0-9_-]/gi, '');
      e.apiKey = get('ob-edit-key');
      e.url = get('ob-edit-url');
      e.authHeader = get('ob-edit-auth') || 'Authorization';
      e.models = get('ob-edit-models');
    }
    if (hashConnectionFields() !== before && e.lastTestResult === 'ok') {
      e.lastTestResult = null;
      _obUpdateFinishGate();
    }
  };
  // Expose captureForm so _obNext can call it before validating step '5'
  // (so an operator who hits Next mid-edit doesn't lose typed input or
  // fail the "configure at least one provider" gate spuriously). Cleared
  // when the editor closes (Save / Cancel) so we never read stale DOM.
  _obCaptureEditorForm = captureForm;
  document.getElementById('ob-edit-save').addEventListener('click', () => {
    captureForm();
    _obProviderEditing = null;
    _obCaptureEditorForm = null;
    _obRenderProvidersList();
  });
  document.getElementById('ob-edit-cancel').addEventListener('click', () => {
    // Drop a brand-new entry that the user opened then cancelled out of.
    const isEmpty = e.kind === 'builtin' ? !e.apiKey && !e.baseUrl && !e.models : !e.apiKey && !e.url && !e.name;
    if (isEmpty) _obProviderEntries.splice(i, 1);
    _obProviderEditing = null;
    _obCaptureEditorForm = null;
    _obRenderProvidersList();
  });
  document.getElementById('ob-edit-test').addEventListener('click', async () => {
    captureForm();
    await _obTestEntry(i);
  });
  document.getElementById('ob-edit-populate').addEventListener('click', async () => {
    captureForm();
    await _obPopulateModelsForEntry(i);
  });
}

async function _obTestEntry(i) {
  const e = _obProviderEntries[i];
  const out = document.getElementById('ob-edit-test-result');
  const btn = document.getElementById('ob-edit-test');
  // Clear any prior pass on this entry — test we're about to run is the
  // truth. Editing fields after a pass clears via captureForm below.
  e.lastTestResult = null;
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    let r, d;
    if (e.kind === 'builtin') {
      // Builtins go through the provider-specific test endpoint, which
      // does a real chat probe (or /models call for `local`). authHeader
      // is only used by the local OAI-compatible test (others ignore it).
      r = await fetch(API + `/api/providers/${encodeURIComponent(e.id)}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: e.apiKey, baseUrl: e.baseUrl, authHeader: e.authHeader }),
      });
      d = await r.json();
    } else {
      // Custom OAI-compatible: no chat-probe path on the server side
      // (that would need a model name). Use the /models listing as a
      // connectivity + auth check — same call shape as the populate
      // button uses, and a non-empty model list tells us the endpoint
      // is reachable and the key is valid.
      r = await fetch(API + '/api/providers/list-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'custom', baseUrl: e.url, apiKey: e.apiKey, authHeader: e.authHeader }),
      });
      d = await r.json();
      if (d.ok) d = { ok: true, model: `${(d.models || []).length} models listed` };
    }
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    e.lastTestResult = 'ok';
    out.className = 'ob-test-result ok';
    out.textContent = 'ok' + (d.model ? ` · ${d.model}` : '') + (d.latency_ms ? ` · ${d.latency_ms}ms` : '');
    _obUpdateFinishGate();
  } catch (err) {
    e.lastTestResult = 'fail';
    out.className = 'ob-test-result err';
    out.textContent = String(err.message || err).slice(0, 120);
    _obUpdateFinishGate();
  } finally { btn.disabled = false; }
}

// Finish gate — operator can't reach Finish until at least one provider
// has been tested green this session. Editing the form after a green
// test clears the pass (see captureForm in _obRenderProviderEditor).
function _obIsAnyProviderVerified() {
  return _obProviderEntries.some(e => e.lastTestResult === 'ok');
}
function _obUpdateFinishGate() {
  const btn = document.getElementById('ob-next');
  if (!btn) return;
  const total = _obStepCount();
  // Off the Finish step, always re-enable: the gate only applies on
  // the very last step. Without this, navigating back from the Finish
  // step leaves btn.disabled=true stuck through every prior step,
  // until the operator either finds the Finish step again with a
  // verified provider OR refreshes the page. Only Skip stays usable
  // since it has its own button.
  if (_obStep !== total || _obMode !== 'operator') {
    btn.disabled = false;
    btn.title = '';
    return;
  }
  const ok = _obIsAnyProviderVerified();
  btn.disabled = !ok;
  btn.title = ok ? '' : 'Run the test on at least one provider before finishing.';
}

async function _obPopulateModelsForEntry(i) {
  const e = _obProviderEntries[i];
  const out = document.getElementById('ob-edit-test-result');
  const btn = document.getElementById('ob-edit-populate');
  const inp = document.getElementById('ob-edit-models');
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    // _listModelsForProvider expects `baseUrl` (not `url`) for both the
    // builtin and custom branches — keep the field name consistent on
    // the wire even though our entry stores `e.url` for customs.
    // For the OAI-compatible builtin, populate via 'custom' kind so
    // authHeader gets through (the 'local' kind doesn't accept it
    // server-side, but its connection shape is identical).
    const body = e.kind === 'builtin'
      ? (e.id === 'local'
          ? { kind: 'custom', baseUrl: e.baseUrl, apiKey: e.apiKey, authHeader: e.authHeader }
          : { kind: e.id, apiKey: e.apiKey, baseUrl: e.baseUrl })
      : { kind: 'custom', baseUrl: e.url, apiKey: e.apiKey, authHeader: e.authHeader };
    const r = await fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    inp.value = d.models.map(m => m.id).join(', ');
    e.models = inp.value;
    const withCtx = _obRecordModelLimits(e.kind === 'builtin' ? e.id : e.name, d.models);
    out.className = 'ob-test-result ok';
    out.textContent = `${d.models.length} models${withCtx ? ` · ${withCtx} with ctx` : ''}`;
  } catch (err) {
    out.className = 'ob-test-result err';
    out.textContent = String(err.message || err).slice(0, 100);
  } finally { btn.disabled = false; }
}

// Map: <full model ref> → { contextLength }. Built up as the user populates
// providers in step 5; consulted in step 6 to pre-fill Max ctx.
const _obKnownModelLimits = {};

function _obRecordModelLimits(providerPrefix, modelObjs) {
  let count = 0;
  for (const m of (modelObjs || [])) {
    if (!m?.id || !m?.contextLength) continue;
    const ref = (providerPrefix && providerPrefix !== 'anthropic') ? `${providerPrefix}/${m.id}` : m.id;
    // Cache maxOutput + capabilities too — the wizard finish payload
    // doesn't ship caps directly (modelLimits only carries ctx/compact/
    // maxTokens/effort form fields), but the server's _enrichModelLimits
    // re-runs each provider's listModels and persists capabilities into
    // modelLimits[ref].capabilities. Storing them here means future
    // wizard UI (per-tier modality filters, custom-OAI capability
    // checkboxes) can read straight from the cache without a re-probe.
    _obKnownModelLimits[ref] = {
      contextLength: m.contextLength,
      ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
      ...(m.capabilities ? { capabilities: m.capabilities } : {}),
    };
    count++;
  }
  return count;
}

async function _obPopulateBuiltinModels(providerId) {
  const btn = document.querySelector(`[data-ob-populate-builtin="${providerId}"]`);
  const out = document.querySelector(`[data-ob-populate-result="${providerId}"]`);
  const input = document.getElementById(`ob-p-${providerId}-models`);
  if (!btn || !out || !input) return;
  const v = _obReadProvider(providerId);
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    const r = await fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: providerId, apiKey: v.apiKey, baseUrl: v.baseUrl }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    input.value = d.models.map(m => m.id).join(', ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const withCtx = _obRecordModelLimits(providerId, d.models);
    out.className = 'ob-test-result ok';
    out.textContent = `${d.models.length} models${withCtx ? ` · ${withCtx} with ctx` : ''}`;
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 100);
  } finally { btn.disabled = false; }
}
// Builtins: state-driven shim. Returns the same shape callers expect
// ({ apiKey, baseUrl, models, ... }), reading from _obProviderEntries.
// authHeader is only meaningful for the OAI-compatible builtin (id='local')
// — other builtins pin to Authorization Bearer server-side.
function _obReadProvider(id) {
  const e = _obProviderEntries.find(x => x.kind === 'builtin' && x.id === id);
  if (!e) return {};
  return {
    apiKey: e.apiKey || '',
    baseUrl: e.baseUrl || '',
    authHeader: e.authHeader || '',
    models: e.models || '',
    referer: '',
  };
}
function _obSyncProviderCards() {
  // Legacy hook — kept as a no-op for callers that still trigger a sync
  // after a typed-in change. The state-driven render is what actually
  // updates the visible card list.
  _obSyncTierProviderOptions?.();
}

function _obParseModels(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Returns a map: { providerName: [model, model, ...], ... } for every configured provider
// that the user declared models for. Used to populate the tier model dropdowns.
function _obAllConfiguredModels() {
  const out = {};
  for (const p of OB_PROVIDERS) {
    const v = _obReadProvider(p.id);
    if (!v.apiKey) continue;
    const models = _obParseModels(v.models);
    if (models.length) out[p.id] = models;
  }
  for (const c of _obReadCustomProviders()) {
    if (!c.name || !c.url) continue;
    if (c.models && c.models.length) out[c.name] = c.models;
  }
  return out;
}
async function _obTestProvider(name) {
  const out = document.querySelector(`[data-ob-provider-result="${name}"]`);
  const btn = document.querySelector(`[data-ob-provider-test="${name}"]`);
  if (!out || !btn) return;
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  const vals = _obReadProvider(name);
  try {
    const r = await fetch(API + `/api/providers/${encodeURIComponent(name)}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vals),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    out.className = 'ob-test-result ok'; out.textContent = 'ok' + (d.model ? ` · ${d.model}` : '');
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 80);
  } finally { btn.disabled = false; }
}

function _obConfiguredProviderIds() {
  const builtins = OB_PROVIDERS.filter(p => {
    const v = _obReadProvider(p.id);
    return !!(v.apiKey || (p.id === 'local' && v.baseUrl));
  }).map(p => p.id).filter(id => id !== 'gemini');
  const customs = _obReadCustomProviders().filter(p => p.name && p.url).map(p => p.name);
  return [...builtins, ...customs];
}

let _obCustomSeq = 0;
function _obInitCustomProviders() {
  const list = document.getElementById('ob-custom-list');
  if (!list) return;
  document.getElementById('ob-custom-add').addEventListener('click', () => _obAddCustomRow());
}
function _obAddCustomRow(preset = {}) {
  const list = document.getElementById('ob-custom-list');
  const seq = ++_obCustomSeq;
  const row = document.createElement('div');
  row.className = 'ob-custom-row';
  row.dataset.seq = String(seq);
  // (Uses the script-scope esc() defined further down — handles all five
  // critical HTML characters, not just the double-quote.)
  row.innerHTML = `
    <div class="ob-custom-row-head">
      <input type="text" data-cp-field="name" placeholder="prefix (e.g. glm)" value="${esc(preset.name)}">
      <select data-cp-field="authHeader" title="Auth header">
        <option value="bearer"${preset.authHeader === 'bearer' || !preset.authHeader ? ' selected' : ''}>Bearer</option>
        <option value="x-api-key"${preset.authHeader === 'x-api-key' ? ' selected' : ''}>x-api-key</option>
        <option value="x-key"${preset.authHeader === 'x-key' ? ' selected' : ''}>x-key</option>
      </select>
      <button type="button" class="ob-custom-row-remove" data-cp-remove="${seq}" title="Remove">&times;</button>
    </div>
    <div class="ob-custom-row-fields">
      <div>
        <label>Base URL</label>
        <input type="text" data-cp-field="url" placeholder="https://host/v1" value="${esc(preset.url)}">
      </div>
      <div>
        <label>API key (optional)</label>
        <input type="password" data-cp-field="key" placeholder="sk-..." value="${esc(preset.key)}">
      </div>
    </div>
    <label>Models (comma-separated)</label>
    <div class="ob-models-row">
      <input type="text" data-cp-field="models" placeholder="model-a, model-b/full-path" value="${esc((preset.models || []).join(', '))}">
      <button type="button" class="ob-test-btn" data-cp-populate="${seq}" title="Fetch model list from this endpoint">populate</button>
    </div>
    <div class="ob-custom-row-test-row">
      <button type="button" class="ob-test-btn" data-cp-test="${seq}">test</button>
      <span class="ob-test-result" data-cp-result="${seq}"></span>
    </div>
  `;
  list.appendChild(row);
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
    const name = row.querySelector('[data-cp-field="name"]').value.trim();
    const url = row.querySelector('[data-cp-field="url"]').value.trim();
    row.classList.toggle('has-key', !!(name && url));
    _obSyncTierProviderOptions();
  }));
  row.querySelector(`[data-cp-test="${seq}"]`).addEventListener('click', () => _obTestCustomRow(seq));
  row.querySelector(`[data-cp-populate="${seq}"]`).addEventListener('click', () => _obPopulateCustomRow(seq));
  row.querySelector(`[data-cp-remove="${seq}"]`).addEventListener('click', () => { row.remove(); _obSyncTierProviderOptions(); });
}

async function _obPopulateCustomRow(seq) {
  const row = document.querySelector(`.ob-custom-row[data-seq="${seq}"]`);
  const btn = row.querySelector(`[data-cp-populate="${seq}"]`);
  const out = row.querySelector(`[data-cp-result="${seq}"]`);
  const input = row.querySelector('[data-cp-field="models"]');
  const v = _obReadCustomRow(row);
  if (!v.url) { out.className = 'ob-test-result err'; out.textContent = 'url required'; return; }
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    const r = await fetch(API + '/api/providers/list-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'custom', baseUrl: v.url, apiKey: v.key, authHeader: v.authHeader }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    input.value = d.models.map(m => m.id).join(', ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const withCtx = _obRecordModelLimits(v.name, d.models);
    out.className = 'ob-test-result ok';
    out.textContent = `${d.models.length} models${withCtx ? ` · ${withCtx} with ctx` : ''}`;
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 100);
  } finally { btn.disabled = false; }
}
function _obReadCustomRow(row) {
  const name = row.querySelector('[data-cp-field="name"]').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const url = row.querySelector('[data-cp-field="url"]').value.trim();
  const key = row.querySelector('[data-cp-field="key"]').value.trim();
  const authHeader = row.querySelector('[data-cp-field="authHeader"]').value;
  const models = _obParseModels(row.querySelector('[data-cp-field="models"]')?.value);
  return { name, url, key, authHeader, models };
}
function _obReadCustomProviders() {
  const seen = new Set();
  const out = [];
  for (const e of _obProviderEntries) {
    if (e.kind !== 'custom') continue;
    if (!e.name || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({
      name: e.name,
      url: e.url,
      key: e.apiKey || '',
      authHeader: e.authHeader || 'Authorization',
      models: _obParseModels(e.models),
    });
  }
  return out;
}
async function _obTestCustomRow(seq) {
  const row = document.querySelector(`.ob-custom-row[data-seq="${seq}"]`);
  const out = row.querySelector(`[data-cp-result="${seq}"]`);
  const btn = row.querySelector(`[data-cp-test="${seq}"]`);
  const v = _obReadCustomRow(row);
  if (!v.name) { out.className = 'ob-test-result err'; out.textContent = 'name required'; return; }
  if (!v.url) { out.className = 'ob-test-result err'; out.textContent = 'url required'; return; }
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  const t0 = performance.now();
  try {
    const url = v.url.replace(/\/$/, '') + '/models';
    const headers = {};
    if (v.key) {
      if (v.authHeader === 'x-api-key') headers['x-api-key'] = v.key;
      else if (v.authHeader === 'x-key') headers['x-key'] = v.key;
      else headers['Authorization'] = `Bearer ${v.key}`;
    }
    const r = await fetch(url, { headers });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) { out.className = 'ob-test-result err'; out.textContent = `HTTP ${r.status} · ${ms}ms`; return; }
    const d = await r.json().catch(() => ({}));
    const count = Array.isArray(d?.data) ? d.data.length : 0;
    out.className = 'ob-test-result ok';
    out.textContent = `ok · ${count} models · ${ms}ms`;
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 80);
  } finally { btn.disabled = false; }
}

// Wizard plugin picker — fetches /api/onboarding/plugins, renders a card
// per available plugin with toggle + (if pane has fields) inline form.
// Saved values land in _obData.plugins on next-button so _obFinish can
// ship them to /api/onboarding/complete.
let _obPluginsCache = null;

async function _obRenderPluginPicker() {
  const list = document.getElementById('ob-plugin-list');
  list.innerHTML = '<div class="ob-note">Loading available plugins…</div>';
  try {
    const r = await fetch('/api/onboarding/plugins');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _obPluginsCache = data.plugins || [];
  } catch (e) {
    list.innerHTML = `<div class="ob-error">Failed to load plugins: ${_settingsEscapeHtml(e.message || String(e))}</div>`;
    return;
  }
  // Filter LLM provider plugins out of this step — they're toggled
  // separately in the "Choose your providers" step. Operator picks them
  // there to bring up tile + key form together.
  const visiblePlugins = _obPluginsCache.filter(p => !OB_PROVIDER_PLUGIN_MAP[p.id]);
  list.innerHTML = visiblePlugins.map(p => _obRenderPluginCard(p)).join('');

  // Restore prior toggle state if user is navigating back
  for (const p of visiblePlugins) {
    const cb = document.getElementById(`ob-plugin-on-${p.id}`);
    if (!cb) continue;
    const saved = _obData.plugins?.[p.id];
    if (saved && typeof saved.enabled === 'boolean') cb.checked = saved.enabled;
    else cb.checked = !!p.recommended;
    if (saved?.config) {
      for (const [k, v] of Object.entries(saved.config)) {
        const inp = document.getElementById(`ob-plugin-${p.id}-${k}`);
        if (inp) inp.value = v;
      }
    }
  }
}

function _obRenderPluginCard(p) {
  const id = _settingsEscapeHtml(p.id);
  const name = _settingsEscapeHtml(p.name || p.id);
  const desc = _settingsEscapeHtml(p.pane?.description || '');
  const kind = _settingsEscapeHtml(p.kind || '');
  const recommended = p.recommended ? '<span class="settings-note" style="color:var(--accent);margin-left:6px">recommended</span>' : '';
  const deps = (p.depends || []).length ? `<span class="settings-note" style="opacity:.6;margin-left:6px">requires: ${p.depends.map(_settingsEscapeHtml).join(', ')}</span>` : '';

  // Schema-driven form. Skip 'toggle' fields with no help and 'select' fields
  // that have only one option — keep the wizard tight. The full editor lives
  // in the plugin's settings pane.
  let formFields = '';
  const schema = (p.pane?.schema || []);
  for (const f of schema) {
    const fieldId = `ob-plugin-${p.id}-${_settingsEscapeHtml(f.key)}`;
    const label = _settingsEscapeHtml(f.label || f.key);
    if (f.type === 'password' || f.type === 'text' || f.type === 'number') {
      const ph = _settingsEscapeHtml(f.help || f.placeholder || '');
      formFields += `<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <input type="${f.type}" id="${fieldId}" placeholder="${ph}" data-plugin="${id}" data-key="${_settingsEscapeHtml(f.key)}">`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map(o => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? (o.label || o.value) : o;
        return `<option value="${_settingsEscapeHtml(v)}"${String(v) === String(f.default || '') ? ' selected' : ''}>${_settingsEscapeHtml(l)}</option>`;
      }).join('');
      formFields += `<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <select id="${fieldId}" data-plugin="${id}" data-key="${_settingsEscapeHtml(f.key)}">${opts}</select>`;
    }
  }

  return `<div class="ob-plugin-card" style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-soft)">
    <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--text)">
      <input type="checkbox" id="ob-plugin-on-${id}" data-plugin-toggle="${id}" style="width:auto;margin-top:3px">
      <div style="flex:1;min-width:0">
        <div><strong>${name}</strong> <span class="settings-note" style="opacity:.55">${kind}</span>${recommended}${deps}</div>
        ${desc ? `<div class="settings-note" style="opacity:.7;margin-top:3px">${desc}</div>` : ''}
        ${formFields ? `<div data-plugin-form="${id}" style="margin-top:6px">${formFields}</div>` : ''}
      </div>
    </label>
  </div>`;
}

// Snapshot the current selections into _obData.plugins so navigation /
// finish both have a consistent view.
//
// IMPORTANT: skip provider plugins. They're filtered out of the
// rendered picker (see _obRenderPluginPicker) and toggled instead
// by step 'pp' (the provider tile picker). Without this skip,
// `cb` is null for provider plugins → `enabled = !!p.recommended`
// overrides the operator's tile selection from step 'pp', and the
// next render of 'pp' shows the tile unchecked → _obCommitProviderTypeChoices
// drops the entry → _obProviderEditing now points at a missing index →
// editor on step '5' renders against undefined and breaks the wizard.
function _obSnapshotPluginPicker() {
  if (!_obPluginsCache) return;
  if (!_obData.plugins) _obData.plugins = {};
  for (const p of _obPluginsCache) {
    if (OB_PROVIDER_PLUGIN_MAP[p.id]) continue;
    const cb = document.getElementById(`ob-plugin-on-${p.id}`);
    const enabled = cb ? cb.checked : !!p.recommended;
    const config = {};
    for (const f of (p.pane?.schema || [])) {
      const inp = document.getElementById(`ob-plugin-${p.id}-${f.key}`);
      if (!inp) continue;
      const v = (inp.value || '').trim();
      if (v) config[f.key] = (f.type === 'number' && Number.isFinite(Number(v))) ? Number(v) : v;
    }
    _obData.plugins[p.id] = { enabled, config };
  }
}

function _obRenderTierRows(containerId, tiers) {
  const container = document.getElementById(containerId);
  // Only build rows once. On revisit, just refresh the available-provider
  // options so newly-configured providers show up — but never wipe the
  // user's existing picks.
  if (container.dataset.builtTiers === tiers.join(',')) {
    _obSyncTierProviderOptions();
    return;
  }
  const tierLabels = { casual: 'Casual', normal: 'Normal', planner: 'Planner *', subagent: 'Subagent', learner: 'Learner', imageVlm: 'Image VLM', videoVlm: 'Video VLM', audioVlm: 'Audio VLM' };
  const header = `
    <div class="ob-tier-header">
      <div>Tier</div><div>Provider</div><div>Model</div>
      <div title="Max tokens the model can hold">Max ctx</div>
      <div title="Compact history when above this — defaults to 85% of Max ctx">Compact at</div>
      <div></div><div></div>
    </div>`;
  container.innerHTML = header + tiers.map(t => `
    <div class="ob-tier-row" data-tier="${t}">
      <div class="label">${tierLabels[t]}</div>
      <select data-ob-tier-provider="${t}"></select>
      <select data-ob-tier-model="${t}"></select>
      <input type="number" data-ob-tier-ctx="${t}" placeholder="auto" min="1" step="1024">
      <input type="number" data-ob-tier-compact="${t}" placeholder="auto" min="1" step="1024">
      <button type="button" class="ob-test-btn" data-ob-tier-test="${t}">test</button>
      <span class="ob-test-result" data-ob-tier-result="${t}"></span>
    </div>
  `).join('');
  container.dataset.builtTiers = tiers.join(',');
  _obSyncTierProviderOptions();
  container.querySelectorAll('[data-ob-tier-provider]').forEach(sel => {
    sel.addEventListener('change', () => _obSyncTierModelOptions(sel.dataset.obTierProvider));
  });
  container.querySelectorAll('[data-ob-tier-test]').forEach(btn => {
    btn.addEventListener('click', () => _obTestTier(btn.dataset.obTierTest));
  });
}
function _obSyncTierProviderOptions() {
  const ids = _obConfiguredProviderIds();
  document.querySelectorAll('[data-ob-tier-provider]').forEach(sel => {
    const tier = sel.dataset.obTierProvider;
    const current = sel.value;
    sel.innerHTML = ids.length
      ? ids.map(id => `<option value="${id}">${id}</option>`).join('')
      : '<option value="">(configure a provider in step 5)</option>';
    if (ids.includes(current)) sel.value = current;
    _obSyncTierModelOptions(tier);
  });
}
function _obSyncTierModelOptions(tier) {
  const providerSel = document.querySelector(`[data-ob-tier-provider="${tier}"]`);
  const modelSel = document.querySelector(`[data-ob-tier-model="${tier}"]`);
  if (!modelSel || !providerSel) return;
  const all = _obAllConfiguredModels();
  const provId = providerSel.value;
  const models = all[provId] || [];
  const current = modelSel.value;
  modelSel.innerHTML = models.length
    ? models.map(m => `<option value="${m}">${m}</option>`).join('')
    : '<option value="">(add models to this provider)</option>';
  if (models.includes(current)) modelSel.value = current;
  // Bind once: when the model selection changes, prefill the Max ctx input
  // from _obKnownModelLimits if we know the limit and the input is blank.
  if (!modelSel.dataset.ctxBound) {
    modelSel.dataset.ctxBound = '1';
    modelSel.addEventListener('change', () => _obPrefillTierCtx(tier));
  }
  _obPrefillTierCtx(tier);
}

// Track which tier inputs were auto-prefilled so we can safely replace them
// when the model changes. Manual user edits are preserved.
const _obAutoFilledCtx = new Set();
const OB_DEFAULT_CTX = 200000;
function _obPrefillTierCtx(tier) {
  const providerSel = document.querySelector(`[data-ob-tier-provider="${tier}"]`);
  const modelSel = document.querySelector(`[data-ob-tier-model="${tier}"]`);
  const ctxInput = document.querySelector(`[data-ob-tier-ctx="${tier}"]`);
  const compactInput = document.querySelector(`[data-ob-tier-compact="${tier}"]`);
  if (!providerSel || !modelSel || !ctxInput) return;
  const provId = providerSel.value;
  const modelId = modelSel.value;
  const ref = (provId && provId !== 'anthropic') ? `${provId}/${modelId}` : modelId;
  const known = modelId ? _obKnownModelLimits[ref] : null;

  // Update the auto-fill value when the input is empty or was previously auto.
  if (!ctxInput.value || _obAutoFilledCtx.has(tier)) {
    if (known?.contextLength) {
      ctxInput.value = known.contextLength;
      _obAutoFilledCtx.add(tier);
    } else {
      ctxInput.value = '';
      _obAutoFilledCtx.delete(tier);
    }
  }

  // Always update placeholders so the user can see the effective value even
  // when leaving inputs blank.
  const effectiveCtx = Number(ctxInput.value) > 0 ? Number(ctxInput.value) : OB_DEFAULT_CTX;
  ctxInput.placeholder = `${effectiveCtx.toLocaleString()} (default)`;
  if (compactInput) {
    const effectiveCompact = Math.floor(effectiveCtx * 0.85);
    compactInput.placeholder = `${effectiveCompact.toLocaleString()} (85%)`;
  }

  // Track manual edits so subsequent model swaps stop overwriting.
  if (!ctxInput.dataset.manualBound) {
    ctxInput.dataset.manualBound = '1';
    ctxInput.addEventListener('input', () => {
      const m = modelSel.value;
      const p = providerSel.value;
      const r = (p && p !== 'anthropic') ? `${p}/${m}` : m;
      const expected = _obKnownModelLimits[r]?.contextLength ?? null;
      if (Number(ctxInput.value) !== expected) _obAutoFilledCtx.delete(tier);
      // Refresh compact placeholder to match new ctx.
      const eff = Number(ctxInput.value) > 0 ? Number(ctxInput.value) : OB_DEFAULT_CTX;
      if (compactInput) compactInput.placeholder = `${Math.floor(eff * 0.85).toLocaleString()} (85%)`;
    });
  }
}
async function _obTestTier(tier) {
  const out = document.querySelector(`[data-ob-tier-result="${tier}"]`);
  const btn = document.querySelector(`[data-ob-tier-test="${tier}"]`);
  const provider = document.querySelector(`[data-ob-tier-provider="${tier}"]`)?.value;
  const model = document.querySelector(`[data-ob-tier-model="${tier}"]`)?.value.trim();
  if (!provider || !model) { out.className = 'ob-test-result err'; out.textContent = 'provider + model required'; return; }
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  const providers = {};
  for (const p of OB_PROVIDERS) providers[p.id] = _obReadProvider(p.id);
  providers.custom = _obReadCustomProviders();
  try {
    const r = await fetch(API + `/api/models/${encodeURIComponent(tier)}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, provider, model, providers }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      // If the model replied but its text didn't match the tier's expected
      // format, surface what it DID say — otherwise the user has no idea
      // whether auth failed or the model just formatted its answer oddly.
      const excerpt = d?.excerpt ? ` · said: "${String(d.excerpt).slice(0, 60)}"` : '';
      throw new Error((d?.error || ('HTTP ' + r.status)) + excerpt);
    }
    out.className = 'ob-test-result ok';
    out.textContent = 'ok' + (d.ttft_ms ? ` · ttft ${d.ttft_ms}ms` : '');
    if (d.excerpt) out.title = d.excerpt;
  } catch (e) {
    out.className = 'ob-test-result err'; out.textContent = String(e.message || e).slice(0, 160);
  } finally { btn.disabled = false; }
}

async function _obNext() {
  const err = (id, msg) => { const el = document.getElementById(id); if (el) el.textContent = msg; };
  // sectionKey-based validation — robust against step reordering.
  const key = OB_STEP_MAP[_obMode][_obStep - 1];
  if (_obMode === 'operator' && key === '3') {
    const dn = document.getElementById('ob-display-name').value.trim();
    if (!dn) { err('ob-identity-error', 'Display name is required'); return; }
    err('ob-identity-error', '');
  }
  if (_obMode === 'operator' && key === '4') {
    const u = document.getElementById('ob-username').value.trim();
    const p1 = document.getElementById('ob-password').value;
    const p2 = document.getElementById('ob-password2').value;
    if (!u) { err('ob-account-error', 'Username is required'); return; }
    if (p1.length < 8) { err('ob-account-error', 'Password must be at least 8 characters'); return; }
    if (p1 !== p2) { err('ob-account-error', 'Passwords do not match'); return; }
    err('ob-account-error', 'Creating account…');
    try {
      const r = await fetch(API + '/api/webapp/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p1 }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Failed to create account');
      _obData.account = { username: u };
      err('ob-account-error', '');
    } catch (e) { err('ob-account-error', String(e.message || e)); return; }
  }
  if (_obMode === 'operator' && key === 'pp') {
    // Provider TYPE picker — sync the checkbox grid into _obProviderEntries
    // (add new entries for newly-checked types, drop entries for unchecked).
    _obCommitProviderTypeChoices();
    if (_obProviderEntries.length === 0) {
      err('ob-pp-error', 'Pick at least one provider to continue.'); return;
    }
    err('ob-pp-error', '');
  }
  if (_obMode === 'operator' && key === '5') {
    // If the editor is open, capture its form values into _obProviderEntries
    // before validating. Without this, an operator who fills the form and
    // hits Next without first clicking Save would lose their typed input
    // AND fail the "Configure at least one provider" check (the entry's
    // own apiKey/baseUrl stay empty since captureForm wasn't called).
    if (_obProviderEditing != null && typeof _obCaptureEditorForm === 'function' && _obCaptureEditorForm) {
      _obCaptureEditorForm();
    }
    if (_obConfiguredProviderIds().length === 0) {
      err('ob-provider-error', 'Configure at least one provider.'); return;
    }
    err('ob-provider-error', '');
  }
  if (_obMode === 'operator' && key === '6') {
    const planner = document.querySelector('[data-ob-tier-model="planner"]')?.value.trim();
    if (!planner) { err('ob-models-error', 'Planner model is required.'); return; }
    err('ob-models-error', '');
  }
  // Plugin picker step — snapshot toggles + form fields into _obData.plugins
  // before moving on, so back/forward nav preserves state.
  if (_obMode === 'operator' && key === 'p') {
    _obSnapshotPluginPicker();
  }
  if (_obStep === _obStepCount()) {
    if (_obMode === 'user') { await _obFinishUserWizard(); return; }
    await _obFinish(); return;
  }
  _obShowStep(_obStep + 1);
}
function _obBack() { if (_obStep > 1) _obShowStep(_obStep - 1); }
function _obSkip() { if (_obIsOptional(_obStep)) _obShowStep(_obStep + 1); }

function _obCollectPayload() {
  const displayName = document.getElementById('ob-display-name').value.trim();
  const nicknames = document.getElementById('ob-nicknames').value.split(',').map(s => s.trim()).filter(Boolean);
  const providers = {
    anthropic: _obReadProvider('anthropic'),
    openai: _obReadProvider('openai'),
    openrouter: _obReadProvider('openrouter'),
    local: _obReadProvider('local'),
  };
  const customProviders = _obReadCustomProviders();
  if (customProviders.length > 0) providers.custom = customProviders;
  // When empty, omit the `custom` key entirely so _persistSettingsPatch leaves
  // existing custom providers alone instead of wiping them.
  const models = {};
  const modelLimits = {};
  const tiers = ['casual','normal','planner','subagent','learner','imageVlm','videoVlm','audioVlm'];
  for (const t of tiers) {
    const prov = document.querySelector(`[data-ob-tier-provider="${t}"]`)?.value || '';
    const model = (document.querySelector(`[data-ob-tier-model="${t}"]`)?.value || '').trim();
    if (!model) continue;
    models[t] = { provider: prov || 'anthropic', model };
    const ctx = parseInt(document.querySelector(`[data-ob-tier-ctx="${t}"]`)?.value, 10);
    const cmp = parseInt(document.querySelector(`[data-ob-tier-compact="${t}"]`)?.value, 10);
    if (ctx > 0 || cmp > 0) {
      // Key by full model ref (provider/model) so multiple tiers sharing a model share limits.
      const key = (prov && prov !== 'anthropic') ? `${prov}/${model}` : model;
      const entry = modelLimits[key] || {};
      if (ctx > 0) entry.contextWindow = ctx;
      if (cmp > 0) entry.compactAt = cmp;
      modelLimits[key] = entry;
    }
  }
  const voiceEnabled = document.getElementById('ob-voice-enabled').checked;
  const voice = { enabled: voiceEnabled };
  if (voiceEnabled) {
    voice.sttProvider = document.getElementById('ob-voice-stt').value;
    voice.ttsProvider = document.getElementById('ob-voice-tts').value;
  }
  const webSearch = {
    searxngUrl: document.getElementById('ob-searxng-url').value.trim(),
    searxngApiKey: document.getElementById('ob-searxng-key').value.trim(),
    braveApiKey: document.getElementById('ob-brave-key').value.trim(),
  };
  const browserBackend = document.querySelector('input[name="ob-browser"]:checked')?.value || 'zendriver';
  // Plugin selections — collected by _obSnapshotPluginPicker on Next-from-step-p.
  // Wizard sends `pluginActions: { disabled: [...], configs: { id: {...} } }`.
  // Key is intentionally NOT `plugins`: the server's _persistSettingsPatch
  // body.plugins handler treats every top-level key as a plugin id, and
  // would write `disabled` and `configs` as synthetic plugin slots in
  // spore.json. Renaming keeps the wizard's intent-based payload (install
  // these / disable those) separate from per-plugin slot patches.
  const pluginActionsPayload = { disabled: [], configs: {} };
  for (const [id, sel] of Object.entries(_obData.plugins || {})) {
    if (!sel.enabled) pluginActionsPayload.disabled.push(id);
    else if (sel.config && Object.keys(sel.config).length > 0) pluginActionsPayload.configs[id] = sel.config;
  }
  return {
    theme: _obData.theme,
    displayName, nicknames,
    providers, models, modelLimits, voice, webSearch,
    browser: { backend: browserBackend },
    pluginActions: pluginActionsPayload,
  };
}

async function _obFinish() {
  const errEl = document.getElementById('ob-finish-error');
  errEl.textContent = 'Saving…';
  const btn = document.getElementById('ob-next');
  btn.disabled = true;
  try {
    const payload = _obCollectPayload();
    const r = await fetch(API + '/api/onboarding/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    // Persisted event log can carry stale "whisper:ready" / similar
    // entries from plugins the operator just uninstalled — clear it so
    // the post-wizard event panel reflects only the new state.
    try { localStorage.removeItem('spore-event-log'); } catch {}
    // Full reload — discards any plugin frontend-assets that the page
    // already loaded at boot (e.g. window.WhisperSTT) for plugins the
    // operator chose to disable. The new /api/plugins/frontend-assets
    // manifest reflects the post-wizard disabled list.
    window.location.reload();
  } catch (e) {
    errEl.textContent = String(e.message || e);
    btn.disabled = false;
  }
}

// User wizard — slim 4-step variant for self-registered guests.
function startUserWizard() {
  _obMode = 'user';
  document.getElementById('app').classList.add('hidden');
  const ov = document.getElementById('onboarding-overlay');
  ov.classList.remove('hidden');
  const headMark = document.getElementById('ob-brand-mark');
  if (headMark && window.BRAND?.chatLogo) headMark.innerHTML = window.BRAND.chatLogo;
  // Repaint the header copy for guest context.
  document.getElementById('ob-title').textContent = 'Set up your account';
  document.getElementById('ob-subtitle').textContent = `Welcome to ${(window.BRAND?.Agent || 'SPORE')}.`;
  _obRenderDots();
  _obRenderThemeGrid();
  _obShowStep(1);
  // Prefer the agent's saved theme as a starting point.
  const cached = localStorage.getItem('spore-theme');
  if (cached && THEMES[cached]) _obPickTheme(cached);
  // Re-bind nav buttons (may have been bound already; harmless).
  if (!document.getElementById('ob-next').dataset.boundUserNav) {
    document.getElementById('ob-next').dataset.boundUserNav = '1';
    document.getElementById('ob-next').addEventListener('click', _obNext);
    document.getElementById('ob-back').addEventListener('click', _obBack);
  }
}

async function _obFinishUserWizard() {
  const errEl = document.getElementById('ob-user-finish-error');
  const btn = document.getElementById('ob-next');
  btn.disabled = true;
  if (errEl) errEl.textContent = 'Saving…';
  try {
    const displayName = (document.getElementById('ob-user-displayname')?.value || '').trim();
    const r = await fetch(API + '/api/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ theme: _obData.theme, displayName, wizardCompleted: true }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    document.getElementById('onboarding-overlay').classList.add('hidden');
    showApp();
  } catch (e) {
    if (errEl) errEl.textContent = String(e.message || e);
    btn.disabled = false;
  }
}

// Bootstrap: first-run → operator wizard; authed → slim wizard if needed else
// the app; unauthed → bounce to /login (the standalone page handles credentials
// and registration, then redirects back here).
(async () => {
  if (window.__ONBOARDING__?.needed) { startOnboarding(); return; }
  const auth = await checkAuthState();
  if (!auth.ok) {
    const base = (window.location.pathname || '/').replace(/\/(graph|index\.html|login)?\/?$/, '');
    window.location.replace((base || '') + '/login');
    return;
  }
  if (auth.wizardNeeded) { startUserWizard(); return; }
  showApp();
})();

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

// ── REST API helpers ──
async function fetchGraph() {
  const res = await fetch(API + '/api/graph');
  return res.json();
}

async function saveNode(data) {
  const res = await fetch(API + '/api/graph/node', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteNode(id) {
  const res = await fetch(API + '/api/graph/node/' + encodeURIComponent(id), { method: 'DELETE' });
  return res.json();
}

async function saveAspect(data) {
  const res = await fetch(API + '/api/graph/aspect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteAspect(id) {
  const res = await fetch(API + '/api/graph/aspect/' + id, { method: 'DELETE' });
  return res.json();
}

async function updateAttribute(id, data) {
  const res = await fetch(API + '/api/graph/attribute/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteAttribute(id) {
  const res = await fetch(API + '/api/graph/attribute/' + id, { method: 'DELETE' });
  return res.json();
}

async function saveEdge(data) {
  const res = await fetch(API + '/api/graph/edge', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

async function deleteEdge(data) {
  const res = await fetch(API + '/api/graph/edge', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

// ── WebSocket Connection ──
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
const WS_RECONNECT_MIN = 1000;
const WS_RECONNECT_MAX = 30000;
let chatBusy = false;
let _chatStopped = false;
let streamingMsgEl = null;
let streamChunks = [];
let _streamDelta = '';
let _thinkingDelta = '';

function setChatBusy(busy) {
  chatBusy = busy;
  if (busy) _chatStopped = false;
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');
  sendBtn.textContent = busy ? 'send ⏎' : 'send';
  sendBtn.style.display = '';
  stopBtn.style.display = busy ? '' : 'none';
  if (busy) _sporeActivityStart('chat');
  else {
    _sporeActivityEnd('chat');
    _chatLastDoneAt = Date.now();   // mid-flight straggler guard for the heuristic
  }
}
let _userWasAtBottom = true;

async function getWsUrl() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${loc.host}${API}`;
  // Always refresh from /api/ws-token so we use the CURRENT cookie session,
  // not a stale cached token from a previous user on this tab.
  try {
    const res = await fetch(API + '/api/ws-token', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        window._wsAuth = data.token;
        return `${base}/ws?token=${encodeURIComponent(data.token)}`;
      }
    }
  } catch {}
  // No valid session-cookie → drop any cached token and connect anonymously.
  // The chat handler will refuse anonymous messages and reload to login.
  window._wsAuth = null;
  return `${base}/ws`;
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  const jitter = Math.random() * wsReconnectDelay * 0.3;
  const delay = Math.min(wsReconnectDelay + jitter, WS_RECONNECT_MAX);
  wsReconnectTimer = setTimeout(connectWs, delay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
}

async function connectWs() {
  wsReconnectTimer = null;
  if (ws && ws.readyState <= 1) return;
  const statusEl = document.getElementById('ws-status');
  statusEl.className = 'connecting'; statusEl.title = 'Connecting…';

  try {
    const url = await getWsUrl();
    ws = new WebSocket(url);
    window._ws = ws;
  } catch (e) {
    statusEl.className = 'disconnected'; statusEl.title = 'Connection error';
    scheduleReconnect();
    return;
  }

  let _wsPingTimer = null;
  let _wsLastPong = Date.now();

  ws.onopen = () => {
    statusEl.className = 'connected'; statusEl.title = 'Connected';
    document.getElementById('chat-send').disabled = false;
    wsReconnectDelay = WS_RECONNECT_MIN;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (!agentNames.length) loadAgentIdentity();
    _wsLastPong = Date.now();
    if (_wsPingTimer) clearInterval(_wsPingTimer);
    _wsPingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - _wsLastPong > 45000) {
        console.warn('[ws] No pong in 45s — forcing reconnect');
        try { ws.close(); } catch {}
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }, 15000);
    try { ws.send(JSON.stringify({ type: 'terminal:hosts:list' })); } catch {}
    if (window._reconnectTerminals) window._reconnectTerminals();
  };

  ws.onclose = () => {
    statusEl.className = 'disconnected'; statusEl.title = 'Disconnected';
    document.getElementById('chat-send').disabled = true;
    if (_wsPingTimer) { clearInterval(_wsPingTimer); _wsPingTimer = null; }
    scheduleReconnect();
  };

  ws.onerror = () => {
    statusEl.className = 'disconnected'; statusEl.title = 'Connection error';
  };

  ws.binaryType = 'arraybuffer';
  ws.onmessage = (evt) => {
    _wsLastPong = Date.now();
    if (evt.data instanceof ArrayBuffer) {
      handleBrowserFrame(evt.data);
      return;
    }
    if (evt.data instanceof Blob) {
      evt.data.arrayBuffer().then(buf => handleBrowserFrame(buf)).catch(() => {});
      return;
    }
    let msg;
    try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data)); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'browser:open' || msg.type === 'browser:closed') {
      handleBrowserControl(msg);
      return;
    }
    if (msg.type && msg.type.startsWith('code:')) {
      handleCodeEvent(msg);
      return;
    }
    if (msg.type === 'notification') {
      showNotification(msg);
      return;
    }
    handleWsMessage(msg);
  };
}

let _chatToolCount = 0;

function setActivity(text) {
  const bar = document.getElementById('agent-activity');
  const label = document.getElementById('activity-text');
  if (text) { label.textContent = text; bar.classList.add('active'); }
  else { bar.classList.remove('active'); }
}

function chatShouldAutoScroll() {
  const c = document.getElementById('chat-messages');
  if (!c) return true;
  return (c.scrollHeight - c.scrollTop - c.clientHeight) < 80;
}

function chatScrollToBottom() {
  const c = document.getElementById('chat-messages');
  if (c) c.scrollTop = c.scrollHeight;
}

function finalizeStreamingMsg() {
  if (!streamingMsgEl) return;
  streamingMsgEl.classList.remove('streaming');
  var thinkingUseful = _thinkingDelta && _thinkingDelta.trim().length > 20;
  if (!_streamDelta && thinkingUseful) {
    streamingMsgEl.classList.add('thinking-done');
    streamingMsgEl.onclick = function() { this.classList.toggle('expanded'); };
  } else if (!_streamDelta) {
    // Remove the bubble AND its row wrapper if present.
    const row = streamingMsgEl.closest('.chat-row');
    (row || streamingMsgEl).remove();
  }
  streamingMsgEl = null;
}

// Lazy-create the streaming assistant bubble. Lets us avoid blank
// bubbles between tool calls — only materializes the bubble when
// there's actual content (thinking / delta / chunk) to put in it.
function _ensureStreamingBubble() {
  if (streamingMsgEl) return streamingMsgEl;
  streamingMsgEl = addChatMessage('assistant', '');
  streamingMsgEl.classList.add('streaming');
  return streamingMsgEl;
}

// Render a "tool used" card inline in the chat. Carries the tool name
// plus a brief input snippet (when available) so the user actually
// sees what the agent did, instead of an empty "⚙ web_search" line.
function _renderToolCard(toolName, toolInput) {
  const container = document.getElementById('chat-messages');
  const card = document.createElement('div');
  card.className = 'chat-msg tool-card';
  // Pick the most informative-looking field from the input object.
  let summary = '';
  if (toolInput && typeof toolInput === 'object') {
    const candidates = ['query', 'q', 'url', 'path', 'command', 'cmd', 'message', 'description', 'task', 'text', 'name'];
    for (const k of candidates) {
      const v = toolInput[k];
      if (typeof v === 'string' && v.trim()) { summary = v.trim(); break; }
    }
    if (!summary) {
      try { summary = JSON.stringify(toolInput); } catch {}
    }
  } else if (typeof toolInput === 'string') {
    summary = toolInput;
  }
  if (summary.length > 140) summary = summary.slice(0, 137) + '…';
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-card-name';
  nameEl.textContent = toolName || 'tool';
  card.appendChild(document.createTextNode('⚙ '));
  card.appendChild(nameEl);
  if (summary) {
    const sep = document.createElement('span');
    sep.className = 'tool-card-sep';
    sep.textContent = ' · ';
    card.appendChild(sep);
    const sumEl = document.createElement('span');
    sumEl.className = 'tool-card-input';
    sumEl.textContent = summary;
    card.appendChild(sumEl);
  }
  container.appendChild(card);
  if (chatShouldAutoScroll()) container.scrollTop = container.scrollHeight;
  return card;
}

function handleWsMessage(msg) {
  if (window._onWsMessage && window._onWsMessage(msg)) return;
  // After user clicks stop, suppress stale server messages until the run finishes
  if (_chatStopped) {
    if (msg.type === 'chat:done') { _chatStopped = false; setChatBusy(false); return; }
    if (msg.type === 'chat:delta' || msg.type === 'chat:thinking' || msg.type === 'chat:tool'
        || msg.type === 'chat:status' || msg.type === 'chat:chunk') return;
  }
  // On page refresh during an in-flight turn we may join after chat:start has
  // already shipped. Any subsequent in-flight event (delta/thinking/tool/etc.)
  // implies a chat is running — flip busy ON so the activity tracker (and the
  // self-node animation) catches up. Cheaper than a server snapshot and self-
  // contained.
  //
  // BUT: only fire if we're not in a "just finished" window. Servers (and our
  // own pipeline) sometimes emit a tail chat:status/chat:chunk shortly after
  // chat:done — without this guard the heuristic re-arms busy without any
  // future chat:done coming, leaving 'chat' in _sporeActiveSources until the
  // 90s watchdog evicts it. The 1500ms grace is well past anything legitimate.
  if (!chatBusy && (msg.type === 'chat:delta' || msg.type === 'chat:thinking'
      || msg.type === 'chat:tool' || msg.type === 'chat:status'
      || msg.type === 'chat:chunk')) {
    if (Date.now() - _chatLastDoneAt > 1500) {
      setChatBusy(true);
      setActivity('thinking...');
    }
  }
  // Same idea for subagents — receiving an iter/heartbeat without a prior
  // start means we joined mid-flight; mark the activity source so the
  // self-node pulses for the rest of the run.
  if (msg.type && msg.taskId && msg.type.startsWith('subagent:')
      && msg.type !== 'subagent:start' && msg.type !== 'subagent:done'
      && msg.type !== 'subagent:error' && msg.type !== 'subagent:result') {
    if (!_sporeActiveSources.has('subagent:' + msg.taskId)) {
      _sporeActivityStart('subagent:' + msg.taskId);
    }
  }
  if (msg.type === 'chat:busy') {
    setChatBusy(true);
    setActivity('thinking...');
    streamChunks = [];
    _streamDelta = '';
    finalizeStreamingMsg();
    streamingMsgEl = null;
  } else if (msg.type === 'chat:start') {
    setChatBusy(true);
    _chatToolCount = 0;
    streamChunks = [];
    _streamDelta = '';
    _userWasAtBottom = chatShouldAutoScroll();
    finalizeStreamingMsg();
    // Don't pre-create an empty assistant bubble. Let the first
    // chat:thinking / chat:delta / chat:chunk lazily create it via
    // _ensureStreamingBubble \u2014 keeps blank bubbles from flashing
    // between tool calls when the model goes straight from one tool
    // call to the next.
    streamingMsgEl = null;
    setActivity('thinking...');
    _thinkingDelta = '';
  } else if (msg.type === 'chat:thinking') {
    _thinkingDelta += msg.text;
    if (!_streamDelta) {
      _ensureStreamingBubble();
      streamingMsgEl.textContent = _thinkingDelta;
      streamingMsgEl.classList.add('thinking-stream');
      if (_userWasAtBottom) chatScrollToBottom();
    }
  } else if (msg.type === 'chat:delta') {
    if (_thinkingDelta && !_streamDelta) {
      if (streamingMsgEl) streamingMsgEl.classList.remove('thinking-stream');
    }
    _streamDelta += msg.text;
    setActivity('responding...');
    _ensureStreamingBubble();
    streamingMsgEl.textContent = _streamDelta;
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:tool') {
    _chatToolCount++;
    if (streamingMsgEl && _streamDelta.trim()) {
      streamingMsgEl.classList.remove('streaming');
      streamingMsgEl.innerHTML = rewriteMediaUrlsInHtml(renderMarkdown(_streamDelta));
      streamingMsgEl = null;
    } else {
      finalizeStreamingMsg();
    }
    _renderToolCard(msg.tool, msg.input);
    setActivity('using ' + msg.tool + (_chatToolCount > 1 ? '  (' + _chatToolCount + ' tools)' : ''));
    _streamDelta = '';
    // Don't immediately create a new empty bubble for the next iteration.
    // The next chat:thinking/delta/chunk will create one if needed.
    streamingMsgEl = null;
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:status') {
    const s = msg.status;
    if (s === 'thinking_start') {
      setActivity('thinking deeply...');
    } else if (s === 'thinking') {
      const snippet = msg.snippet ? ' \u2014 ' + msg.snippet.substring(0, 140) : '';
      setActivity('thinking (' + (msg.tokens || 0) + ' tokens)' + snippet);
    } else if (s === 'thinking_done') {
      setActivity('composing response...');
    } else if (s === 'tool_progress') {
      const kb = Math.round((msg.bytes || 0) / 1024);
      const label = kb > 0 ? kb + 'KB' : (msg.bytes || 0) + 'B';
      setActivity('writing ' + (msg.tool || '') + ' ' + label + '...');
    } else if (s === 'tool_exec_start') {
      const d = msg.detail ? ': ' + msg.detail.substring(0, 60) : '';
      setActivity('running ' + msg.tool + d + '...');
    } else if (s === 'tool_exec_done') {
      const sec = msg.durationMs >= 1000 ? (msg.durationMs / 1000).toFixed(1) + 's' : msg.durationMs + 'ms';
      const d = msg.detail ? ' — ' + msg.detail.substring(0, 40) : '';
      setActivity(msg.tool + ' done (' + sec + ')' + d);
    } else if (s === 'truncated') {
      setActivity('output truncated — retrying with smaller output...');
      addChatMessage('system', '\u26a0 Output truncated at token limit — retrying');
    } else if (s === 'parallel_exec') {
      setActivity('running ' + msg.count + ' tools in parallel...');
    } else if (s === 'heartbeat') {
      const label = msg.phase === 'thinking' ? 'thinking deeply' : msg.phase === 'generating' ? 'responding' : msg.phase === 'tool_call' ? (msg.toolName ? 'using ' + msg.toolName : 'calling tool') : msg.phase;
      setActivity(label + '... (' + msg.elapsed + 's)');
    } else if (s === 'interjected') {
      // Gateway acknowledging we queued the user's follow-up into an in-flight run.
      setActivity('interjection queued — the agent will address it next iteration');
      addChatMessage('system', '\u21bb Follow-up queued — the agent is still working, will fold this into its reply.');
    } else if (s === 'interjection') {
      // Loop picked up the interjection at the next iteration boundary.
      const n = msg.count || 1;
      setActivity(`interjecting${n > 1 ? ` (${n} message${n === 1 ? '' : 's'})` : ''}... the agent is reading the follow-up now`);
      addChatMessage('system', `\u27f3 Agent is now folding your follow-up${n > 1 ? `s (${n})` : ''} into its response.`);
    }
  } else if (msg.type === 'chat:chunk') {
    streamChunks.push(msg.text);
    _ensureStreamingBubble();
    streamingMsgEl.textContent = msg.text;
    _streamDelta = msg.text;
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:done') {
    setActivity(null);
    if (streamingMsgEl) {
      streamingMsgEl.classList.remove('streaming', 'thinking-stream');
      const content = _streamDelta || '';
      if (content.trim()) {
        streamingMsgEl.innerHTML = formatAssistantMsg(content, msg);
      } else if (_thinkingDelta) {
        streamingMsgEl.classList.add('thinking-done');
        streamingMsgEl.onclick = function() { this.classList.toggle('expanded'); };
      } else {
        streamingMsgEl.remove();
        // Append tool tags and usage to the last assistant bubble
        if (msg.toolUsage || msg.usage) {
          const allAssistant = document.getElementById('chat-messages').querySelectorAll('.chat-msg.assistant');
          const lastBubble = allAssistant.length ? allAssistant[allAssistant.length - 1] : null;
          if (lastBubble) {
            let extra = '';
            if (msg.toolUsage && typeof msg.toolUsage === 'object') {
              const entries = Object.entries(msg.toolUsage);
              if (entries.length) {
                extra += '<div style="margin-top:8px">';
                for (const [tool, count] of entries) extra += `<span class="tool-tag">${esc(tool)}${count > 1 ? ' \u00d7' + count : ''}</span>`;
                extra += '</div>';
              }
            }
            if (msg.usage) extra += _formatUsageTag(msg.usage, msg.iterations);
            if (extra) lastBubble.insertAdjacentHTML('beforeend', extra);
          }
        }
      }
    }
    streamingMsgEl = null;
    setChatBusy(false);
    if (_userWasAtBottom) chatScrollToBottom();
  } else if (msg.type === 'chat:error') {
    setActivity(null);
    finalizeStreamingMsg();
    addChatMessage('system', 'Error: ' + msg.error);
    setChatBusy(false);
    // Session expired — reload to surface the login screen so the user can re-auth.
    if (msg.code === 'auth-required' && !window._wsAuthRedirected) {
      window._wsAuthRedirected = true;
      setTimeout(() => { try { window.location.reload(); } catch {} }, 1500);
    }
  } else if (msg.type === 'chat:history') {
    const container = document.getElementById('chat-messages');
    const welcome = document.getElementById('chat-welcome');
    // Clear existing messages on reconnect to avoid duplicates
    const welcomeRef = welcome ? welcome.cloneNode(true) : null;
    container.innerHTML = '';
    if (welcomeRef) container.appendChild(welcomeRef);
    if (msg.messages?.length) {
      if (welcomeRef) welcomeRef.style.display = 'none';
      for (const m of msg.messages) {
        if (m.role === 'notification') {
          addChatMessage('system', '\ud83d\udcec ' + m.text);
          continue;
        }
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const el = document.createElement('div');
        el.className = 'chat-msg ' + role;
        if (role === 'assistant') {
          let html = rewriteMediaUrlsInHtml(renderMarkdown(m.text));
          const media = detectMediaInText(m.text);
          if (media.length) html += '<div class="media-grid">' + renderMediaHtml(media) + '</div>';
          el.innerHTML = html;
        } else {
          el.textContent = m.text;
        }
        container.appendChild(_wrapChatBubble(el, role));
      }
      container.scrollTop = container.scrollHeight;
    }
  } else if (msg.type === 'chat:cleared') {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const welcome = document.getElementById('chat-welcome');
    if (welcome) { welcome.style.display = ''; container.appendChild(welcome); }
  } else if (msg.type === 'graph:event') {
    handleGraphEvent(msg);
  } else if (msg.type && msg.type.startsWith('voice:')) {
    handleVoiceMessage(msg);
  } else if (msg.type && msg.type.startsWith('subagent:')) {
    handleSubagentMessage(msg);
  } else if (msg.type && msg.type.startsWith('benchmark:')) {
    handleBenchmarkWs(msg);
  } else if (msg.type === 'ask_user') {
    renderAskUserCard(msg);
  } else if (msg.type === 'ask_user_answer_ack') {
    // ack landed — picker already disabled; nothing to do
  } else if (msg.type === 'plan_proposal' || msg.type === 'plan_applied'
             || msg.type === 'plan_rejected' || msg.type === 'plan_mode') {
    handlePlanModeMessage(msg);
  }
}

// ── ask_user picker card ──
function renderAskUserCard(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'chat-msg agent chat-ask-user';
  card.dataset.qid = msg.qid;
  const opts = (msg.options || []).map((o, i) =>
    `<label class="au-option"><input type="radio" name="au-${msg.qid}" value="${(o.label || '').replace(/"/g, '&quot;')}" ${i === 0 ? 'checked' : ''}> <strong>${escapeHtml(o.label || '')}</strong>${o.description ? `<div class="au-desc">${escapeHtml(o.description)}</div>` : ''}</label>`
  ).join('');
  card.innerHTML = `
    <div class="au-question">${escapeHtml(msg.question || '')}</div>
    <div class="au-options">${opts}</div>
    <button class="au-submit">Submit</button>
    <div class="au-status"></div>
  `;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  const submitBtn = card.querySelector('.au-submit');
  submitBtn.addEventListener('click', () => {
    const picked = card.querySelector(`input[name="au-${msg.qid}"]:checked`);
    if (!picked) { card.querySelector('.au-status').textContent = 'Pick one first.'; return; }
    submitBtn.disabled = true;
    card.querySelectorAll('input').forEach(i => i.disabled = true);
    try {
      ws.send(JSON.stringify({ type: 'ask_user_answer', qid: msg.qid, answer: picked.value }));
      card.querySelector('.au-status').textContent = `Sent: ${picked.value}`;
    } catch (e) {
      submitBtn.disabled = false;
      card.querySelectorAll('input').forEach(i => i.disabled = false);
      card.querySelector('.au-status').textContent = 'Failed to send — reconnect?';
    }
  });
}

// Tiny HTML escaper for the picker (the chat otherwise renders markdown).
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Plan-mode UI ──
let _planModeEnabled = false;
function handlePlanModeMessage(msg) {
  const card = document.getElementById('plan-proposals-card');
  if (msg.type === 'plan_mode') {
    _planModeEnabled = !!msg.enabled;
    _refreshPlanModeBadge();
    return;
  }
  if (msg.type === 'plan_proposal') {
    _refreshPlanProposals();
    return;
  }
  if (msg.type === 'plan_applied') {
    const container = document.getElementById('chat-messages');
    if (container) {
      const el = document.createElement('div');
      el.className = 'chat-msg system';
      const lines = (msg.results || []).map(r => `${r.ok ? '✓' : '✗'} ${r.tool} — ${r.summary || ''}${r.error ? ' · ' + r.error : ''}`);
      el.textContent = `[plan] Applied ${msg.results?.filter(r => r.ok).length}/${msg.results?.length}\n${lines.join('\n')}`;
      container.appendChild(el);
      container.scrollTop = container.scrollHeight;
    }
    _refreshPlanProposals();
    return;
  }
  if (msg.type === 'plan_rejected') {
    _refreshPlanProposals();
    return;
  }
}

async function _refreshPlanProposals() {
  const sessionKey = _currentSessionKeyForPlan();
  if (!sessionKey) return;
  try {
    const r = await fetch(API + '/api/plan/pending?sessionKey=' + encodeURIComponent(sessionKey), { headers: authHeaders() });
    const d = await r.json();
    _renderPlanCard(d.proposals || [], sessionKey);
  } catch {}
}

function _currentSessionKeyForPlan() {
  // Same keying as the server: `dm:<username>` for normal sessions.
  if (_userRole === 'creator' || _userRole === 'admin' || _userRole === 'webapp') {
    return 'dm:' + (_currentUserName || 'operator');
  }
  return null;
}

function _renderPlanCard(proposals, sessionKey) {
  let card = document.getElementById('plan-proposals-card');
  if (!proposals.length) {
    if (card) card.remove();
    return;
  }
  if (!card) {
    card = document.createElement('div');
    card.id = 'plan-proposals-card';
    card.className = 'plan-card';
    const container = document.getElementById('chat-messages');
    if (container) container.appendChild(card);
  }
  const rows = proposals.map(p => `<div class="plan-row"><span class="plan-seq">${p.sequence}.</span> <span class="plan-tool">${escapeHtml(p.tool)}</span> <span class="plan-summary">${escapeHtml(p.summary || '')}</span></div>`).join('');
  card.innerHTML = `
    <div class="plan-header">Pending plan (${proposals.length} step${proposals.length !== 1 ? 's' : ''})</div>
    <div class="plan-rows">${rows}</div>
    <div class="plan-buttons">
      <button class="plan-approve">Approve</button>
      <button class="plan-reject">Reject</button>
    </div>
  `;
  card.querySelector('.plan-approve').addEventListener('click', () => _approvePlan(sessionKey));
  card.querySelector('.plan-reject').addEventListener('click', () => _rejectPlan(sessionKey));
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

async function _approvePlan(sessionKey) {
  const card = document.getElementById('plan-proposals-card');
  if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + '/api/plan/approve', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey }) });
    const d = await r.json();
    if (!d.ok) toast('Approve failed: ' + (d.error || 'unknown'), true);
  } catch (e) { toast('Approve error: ' + e.message, true); }
  _refreshPlanProposals();
}

async function _rejectPlan(sessionKey) {
  const card = document.getElementById('plan-proposals-card');
  if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await fetch(API + '/api/plan/reject', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey }) });
    await r.json();
  } catch {}
  _refreshPlanProposals();
}

function _togglePlanMode() {
  const sessionKey = _currentSessionKeyForPlan();
  if (!sessionKey) return;
  const next = !_planModeEnabled;
  fetch(API + '/api/plan/mode', { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey, enabled: next }) })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        _planModeEnabled = d.planMode;
        _refreshPlanModeBadge();
        toast(_planModeEnabled ? 'Plan mode ON — mutating tools will queue for approval' : 'Plan mode OFF');
      }
    })
    .catch(e => toast('Plan mode toggle failed: ' + e.message, true));
}

function _refreshPlanModeBadge() {
  const btn = document.getElementById('plan-mode-toggle');
  if (!btn) return;
  btn.classList.toggle('on', !!_planModeEnabled);
  btn.textContent = _planModeEnabled ? 'Plan: ON' : 'Plan: off';
}

// ── Subagent Activity (multi-agent) ──
const _saAgents = new Map();

function _saGetOrCreate(taskId) {
  if (_saAgents.has(taskId)) return _saAgents.get(taskId);
  const container = document.getElementById('subagent-container');
  if (!container) return null;

  const panel = document.createElement('div');
  panel.className = 'sa-panel';
  panel.id = 'sa-panel-' + taskId;

  const shortId = taskId.split('_').pop();
  panel.innerHTML = `<div class="sa-panel-header" onclick="this.nextElementSibling.classList.toggle('collapsed')"><span class="sa-panel-title">SUB ${esc(shortId)}</span><span class="sa-panel-status"></span></div><div class="sa-panel-body"></div>`;
  container.prepend(panel);
  container.classList.add('active');

  const state = { taskId, panel, lines: [], body: panel.querySelector('.sa-panel-body'), status: panel.querySelector('.sa-panel-status'), title: panel.querySelector('.sa-panel-title') };
  _saAgents.set(taskId, state);
  return state;
}

function saAddLine(state, cls, text) {
  if (!state?.body) return;
  const el = document.createElement('div');
  el.className = 'sa-line ' + cls;
  el.textContent = text;
  state.body.appendChild(el);
  state.lines.push(el);
  if (state.lines.length > 60) { state.lines.shift()?.remove(); }
  state.body.scrollTop = state.body.scrollHeight;
}

function handleSubagentMessage(msg) {
  const container = document.getElementById('subagent-container');
  if (!container) return;

  const tid = msg.taskId;
  if (!tid) return;

  if (msg.type === 'subagent:start') {
    _sporeActivityStart('subagent:' + tid);
    const s = _saGetOrCreate(tid);
    if (!s) return;
    s.body.innerHTML = '';
    s.body.classList.remove('collapsed');
    s.lines = [];
    s.status.textContent = 'starting...';
    s.status.className = 'sa-panel-status sa-pulse';
    saAddLine(s, '', '\u25b6 ' + (msg.model || '') + ' — ' + (msg.task || ''));
    s._startTime = Date.now();
    _saResetStaleTimer(tid);
    if (s._timer) clearInterval(s._timer);
    s._timer = setInterval(() => {
      const el = Math.round((Date.now() - s._startTime) / 1000);
      if (!s.status.textContent.startsWith('done') && !s.status.textContent.startsWith('error')) {
        const label = s.status.textContent.replace(/\s*\(\d+s\)$/, '');
        s.status.textContent = (label || 'working') + ' (' + el + 's)';
      }
    }, 1000);
    return;
  }

  const s = _saAgents.get(tid);
  if (!s) return;
  _saResetStaleTimer(tid);

  if (msg.type === 'subagent:iter') {
    s.status.textContent = 'thinking (' + msg.iteration + '/' + msg.maxIter + ')';
  } else if (msg.type === 'subagent:iter_done') {
    const line = '\u2502 iter ' + msg.iteration + ': ' + msg.durationMs + 'ms, ' + msg.toolCount + ' tools, ' + msg.textChars + ' chars, stop=' + (msg.stopReason || '?');
    saAddLine(s, msg.toolCount === 0 && msg.textChars > 500 ? 'warn' : 'text', line);
  } else if (msg.type === 'subagent:thinking_start') {
    saAddLine(s, 'thinking sa-pulse', '\u25c6 thinking...');
  } else if (msg.type === 'subagent:thinking') {
    const last = s.lines[s.lines.length - 1];
    if (last && last.classList.contains('thinking')) {
      const snippet = msg.snippet ? ' \u2014 ' + msg.snippet : '';
      last.textContent = '\u25c6 ' + msg.tokens + ' tokens' + snippet;
      last.title = msg.snippet || '';
    }
    s.status.textContent = 'thinking (' + msg.tokens + ' tokens)';
  } else if (msg.type === 'subagent:text') {
    const last = s.lines[s.lines.length - 1];
    if (last && last.classList.contains('thinking')) last.classList.remove('sa-pulse');
    if (last && last.classList.contains('streaming-text')) {
      const cur = last.textContent;
      if (cur.length < 200) last.textContent = cur + msg.text;
    } else {
      const el = document.createElement('div');
      el.className = 'sa-line text streaming-text';
      el.textContent = msg.text;
      s.body.appendChild(el);
      s.lines.push(el);
    }
  } else if (msg.type === 'subagent:heartbeat') {
    if (msg.toolBytes > 0) {
      s.status.textContent = 'writing ' + (msg.toolName || '') + ' ' + Math.round(msg.toolBytes / 1024) + 'KB';
    } else if (msg.tools > 0) {
      s.status.textContent = 'executing tools';
    } else if (msg.thinking > 0) {
      s.status.textContent = 'thinking (' + msg.thinking + ' tokens)';
    } else {
      s.status.textContent = 'thinking';
    }
    s.status.className = 'sa-panel-status sa-pulse';
  } else if (msg.type === 'subagent:tool_progress') {
    const last = s.lines[s.lines.length - 1];
    const kb = Math.round((msg.bytes || 0) / 1024);
    if (last && last.classList.contains('tool')) {
      last.textContent = '\u2699 ' + (msg.tool || '') + ' \u2014 writing ' + kb + 'KB...';
    }
    s.status.textContent = 'writing ' + (msg.tool || '') + ' ' + kb + 'KB';
    s.status.className = 'sa-panel-status sa-pulse';
  } else if (msg.type === 'subagent:tool_start' || msg.type === 'subagent:tool_call') {
    const tool = msg.tool || '';
    let input = msg.input ? ' ' + msg.input.substring(0, 120) : '';
    input = input
      .replace(/(?:KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIALS)[=:]\\{0,2}["']?\s*([A-Za-z0-9_\-.]{8,})/gi,
        (m, val) => m.replace(val, val.slice(0, 4) + '***'))
      .replace(/(?:sk-|pk-|key-|tok-|Bearer\s+)([A-Za-z0-9_\-.]{8,})/g,
        (m, val) => m.replace(val, val.slice(0, 4) + '***'));
    saAddLine(s, 'tool', '\u2699 ' + tool + input);
  } else if (msg.type === 'subagent:warn') {
    saAddLine(s, 'warn', '\u26a0 ' + (msg.message || ''));
    s.status.className = 'sa-panel-status warn';
  } else if (msg.type === 'subagent:finishing') {
    s.status.textContent = 'finishing up...';
    s.status.className = 'sa-panel-status';
    saAddLine(s, 'done', '\u2713 task complete \u2014 generating summary');
    if (s._staleTimer) clearTimeout(s._staleTimer);
    s._staleTimer = setTimeout(() => { _saCleanup(tid); }, 30000);
  } else if (msg.type === 'subagent:done') {
    _sporeActivityEnd('subagent:' + tid);
    if (s._timer) { clearInterval(s._timer); s._timer = null; }
    _saCleanup(tid);
  } else if (msg.type === 'subagent:error') {
    _sporeActivityEnd('subagent:' + tid);
    s.status.textContent = 'error';
    s.status.className = 'sa-panel-status';
    if (s._timer) { clearInterval(s._timer); s._timer = null; }
    saAddLine(s, 'error', '\u2717 ' + (msg.error || 'unknown error'));
    setTimeout(() => { _saCleanup(tid); }, 10000);
  } else if (msg.type === 'subagent:result') {
    _sporeActivityEnd('subagent:' + tid);
    _saCleanup(tid);
    if (msg.status === 'completed') {
      setActivity('processing result...');
    }
  }
}

function _saCleanup(taskId) {
  const s = _saAgents.get(taskId);
  if (!s) return;
  if (s._timer) { clearInterval(s._timer); s._timer = null; }
  if (s._staleTimer) { clearTimeout(s._staleTimer); s._staleTimer = null; }
  s.panel.remove();
  _saAgents.delete(taskId);
  const container = document.getElementById('subagent-container');
  if (container && _saAgents.size === 0) container.classList.remove('active');
}
function _saResetStaleTimer(taskId) {
  const s = _saAgents.get(taskId);
  if (!s) return;
  if (s._staleTimer) clearTimeout(s._staleTimer);
  const elapsed = s._startTime ? (Date.now() - s._startTime) / 1000 : 0;
  const timeout = elapsed > 120 ? 300000 : 120000;
  s._staleTimer = setTimeout(() => { _saCleanup(taskId); }, timeout);
}

// ── Browser Live Preview ──
let _browserFrameUrl = null;
let _browserFrameCount = 0;
let _browserLastFrameTime = 0;

function _clampBrowserPanel(panel) {
  requestAnimationFrame(() => {
    const r = panel.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = r.width || 420, ph = r.height || 320;
    let x = r.left, y = r.top;
    // If panel ended up at 0,0 or completely off-screen, reset to top-right
    if ((x === 0 && y === 0) || x + pw < 20 || y + ph < 20 || x > vw - 20 || y > vh - 20) {
      x = Math.max(10, vw - pw - 20);
      y = 10;
      localStorage.removeItem('_browserPreviewPos');
    }
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
}

function handleBrowserFrame(arrayBuf) {
  const view = new DataView(arrayBuf);
  if (arrayBuf.byteLength < 4) return;
  const headerLen = view.getUint32(0, false);
  if (arrayBuf.byteLength < 4 + headerLen) return;

  const headerBytes = new Uint8Array(arrayBuf, 4, headerLen);
  let header;
  try { header = JSON.parse(new TextDecoder().decode(headerBytes)); } catch { return; }

  const jpegBytes = new Uint8Array(arrayBuf, 4 + headerLen);
  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);

  const panel = document.getElementById('browser-preview');
  const img = document.getElementById('browser-preview-img');
  const status = document.getElementById('browser-preview-status');

  if (_browserFrameUrl) URL.revokeObjectURL(_browserFrameUrl);
  _browserFrameUrl = url;
  img.src = url;

  if (!panel.classList.contains('active')) {
    panel.classList.add('active');
    _clampBrowserPanel(panel);
  }
  _browserFrameCount++;
  _browserLastFrameTime = Date.now();
  if (_browserFrameCount % 10 === 0) {
    status.textContent = _browserFrameCount + ' frames | ' + (header.w || '?') + 'x' + (header.h || '?');
  }
}

// ── Notification Toasts ──────────────────────────────────────────────
function showNotification(msg) {
  let container = document.querySelector('.spore-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'spore-toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'spore-toast' + (msg.urgent ? ' urgent' : '');

  const source = msg.source || msg.from || 'Notification';
  toast.innerHTML = `
    <div class="spore-toast-source">${source}</div>
    <div class="spore-toast-body"></div>
    <button class="spore-toast-close">&times;</button>
  `;
  toast.querySelector('.spore-toast-body').textContent = msg.message || '';
  toast.querySelector('.spore-toast-close').onclick = () => dismissToast(toast);
  container.appendChild(toast);

  // Also add to chat so it persists
  addChatMessage('system', `📬 **${source}**: ${msg.message || ''}`);

  // Auto-dismiss after 15s (30s if urgent)
  const ttl = msg.urgent ? 30000 : 15000;
  setTimeout(() => dismissToast(toast), ttl);
}

function dismissToast(el) {
  if (!el || el._dismissed) return;
  el._dismissed = true;
  el.style.animation = 'toast-fade-out .3s ease forwards';
  setTimeout(() => el.remove(), 300);
}

function handleBrowserControl(msg) {
  const panel = document.getElementById('browser-preview');
  if (msg.type === 'browser:open') {
    panel.classList.add('active');
    _clampBrowserPanel(panel);
    _browserFrameCount = 0;
    document.getElementById('browser-preview-status').textContent = 'connected — waiting for frames...';
  } else if (msg.type === 'browser:closed') {
    panel.classList.remove('active');
    _browserFrameCount = 0;
  }
}

function _initBrowserPreview() {
  const panel = document.getElementById('browser-preview');
  const header = document.getElementById('browser-preview-header');
  const closeBtn = document.getElementById('browser-preview-close');
  const resizeHandle = document.getElementById('browser-preview-resize');
  if (!panel || !header || !closeBtn) return;

  // Restore saved position/size — default to top-right
  try {
    const saved = JSON.parse(localStorage.getItem('_browserPreviewPos') || '{}');
    if (saved.x !== undefined && saved.y !== undefined) {
      panel.style.left = saved.x + 'px'; panel.style.top = saved.y + 'px';
    } else {
      panel.style.left = Math.max(10, window.innerWidth - 440) + 'px'; panel.style.top = '10px';
    }
    if (saved.w) panel.style.width = saved.w + 'px';
    if (saved.h) panel.style.height = saved.h + 'px';
  } catch { panel.style.left = Math.max(10, window.innerWidth - 440) + 'px'; panel.style.top = '10px'; }

  function savePos() {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem('_browserPreviewPos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    } catch {}
  }

  closeBtn.addEventListener('click', () => { panel.classList.remove('active'); });

  // Drag from header
  let mode = null, startX, startY, startLeft, startTop, startW, startH;

  header.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    e.preventDefault();
    mode = 'drag';
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  // Resize from corner handle
  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      mode = 'resize';
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!mode) return;
    if (mode === 'drag') {
      const pw = panel.offsetWidth || 420;
      const x = Math.max(-pw + 60, Math.min(startLeft + e.clientX - startX, window.innerWidth - 60));
      const y = Math.max(-20, Math.min(startTop + e.clientY - startY, window.innerHeight - 30));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    } else if (mode === 'resize') {
      const w = Math.max(200, startW + e.clientX - startX);
      const h = Math.max(150, startH + e.clientY - startY);
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (mode) { savePos(); mode = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initBrowserPreview);
} else {
  _initBrowserPreview();
}

// ═══════════════════════════════════════════════════════════════════════
// Code Viewer (docked in canvas tab or floating)
// ═══════════════════════════════════════════════════════════════════════
const _cvTabs = [];        // { id, path, mode, content, language, badge }
let _cvActiveTabId = null;
let _cvAutoHideTimer = null;
const CV_MAX_TABS = 8;
const CV_AUTO_HIDE_MS = 120000;
let _cvMode = localStorage.getItem('cv-mode') || 'on-request';
let _cvPendingCount = 0;
let _cvDocked = localStorage.getItem('cv-docked') !== 'false'; // default docked

// ── Canvas Tab System ──
function _ctSetActiveTab(tabName) {
  const canvas = document.getElementById('canvas');
  const tabBar = document.getElementById('canvas-tabs');
  if (!tabBar) return;
  tabBar.querySelectorAll('.canvas-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.ct === tabName);
  });
  if (tabName === 'code') {
    canvas.classList.add('cv-tab-active');
    const cv = document.getElementById('code-viewer');
    if (cv && cv.classList.contains('cv-docked')) {
      cv.classList.remove('cv-entering');
      void cv.offsetWidth;
      cv.classList.add('cv-entering');
      cv.addEventListener('animationend', () => cv.classList.remove('cv-entering'), { once: true });
    }
    if (_cvAceEditor) setTimeout(() => _cvAceEditor.resize(), 50);
  } else {
    canvas.classList.remove('cv-tab-active');
  }
}

function _ctShowTabBar() {
  const tabBar = document.getElementById('canvas-tabs');
  if (tabBar) tabBar.classList.add('active');
}

function _ctHideTabBar() {
  const tabBar = document.getElementById('canvas-tabs');
  const canvas = document.getElementById('canvas');
  if (tabBar) tabBar.classList.remove('active');
  if (canvas) canvas.classList.remove('cv-tab-active');
}

function _ctUpdateCodeBadge() {
  const codeTab = document.querySelector('.canvas-tab[data-ct="code"]');
  if (!codeTab) return;
  const existing = codeTab.querySelector('.ct-badge');
  if (_cvTabs.length > 0 && _cvPendingCount > 0) {
    if (existing) { existing.textContent = _cvPendingCount; }
    else {
      const b = document.createElement('span');
      b.className = 'ct-badge';
      b.textContent = _cvPendingCount;
      codeTab.insertBefore(b, codeTab.querySelector('.canvas-tab-close'));
    }
  } else if (existing) {
    existing.remove();
  }
}

function _cvSetDocked(docked) {
  _cvDocked = docked;
  localStorage.setItem('cv-docked', docked ? 'true' : 'false');
  const panel = document.getElementById('code-viewer');
  if (!panel) return;

  if (docked) {
    panel.classList.add('cv-docked');
    panel.style.left = ''; panel.style.top = '';
    panel.style.width = ''; panel.style.height = '';
    if (_cvTabs.length > 0 && panel.classList.contains('active')) {
      _ctShowTabBar();
      _ctSetActiveTab('code');
    }
  } else {
    panel.classList.remove('cv-docked');
    // Restore floating position
    try {
      const saved = JSON.parse(localStorage.getItem('_codeViewerPos') || '{}');
      if (saved.x != null) panel.style.left = saved.x + 'px';
      if (saved.y != null) panel.style.top = saved.y + 'px';
      if (saved.w) panel.style.width = saved.w + 'px';
      if (saved.h) panel.style.height = saved.h + 'px';
    } catch {}
    _ctSetActiveTab('graph');
    if (_cvTabs.length === 0) _ctHideTabBar();
  }
  if (_cvAceEditor) setTimeout(() => _cvAceEditor.resize(), 50);
}

function _initCanvasTabs() {
  const tabBar = document.getElementById('canvas-tabs');
  if (!tabBar) return;

  tabBar.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-ct-close]');
    if (closeEl) {
      // Close the code tab — hide the code viewer
      const panel = document.getElementById('code-viewer');
      if (_cvEditing) _cvExitEditMode(false);
      panel.classList.remove('active');
      _ctSetActiveTab('graph');
      if (_cvTabs.length === 0) _ctHideTabBar();
      return;
    }
    const tab = e.target.closest('[data-ct]');
    if (!tab) return;
    const name = tab.dataset.ct;
    _ctSetActiveTab(name);
  });

  // Double-click code tab to pop out to floating
  tabBar.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('[data-ct="code"]');
    if (tab && _cvDocked) {
      _cvSetDocked(false);
    }
  });
}

function _cvLangAlias(lang) {
  const map = { javascript: 'js', typescript: 'ts', python: 'py', markdown: 'md', bash: 'sh', yaml: 'yml' };
  return map[lang] || lang || 'text';
}

function _cvFileName(p) {
  if (!p) return 'untitled';
  return p.split('/').pop();
}

function _cvShortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : p;
}

function _cvPrismLang(language) {
  if (typeof Prism === 'undefined') return null;
  const aliases = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', yml: 'yaml', md: 'markdown', text: null };
  const lang = aliases[language] || language;
  return Prism.languages[lang] || null;
}

function _cvHighlight(code, language) {
  const grammar = _cvPrismLang(language);
  if (grammar) {
    try { return Prism.highlight(code, grammar, language); } catch { }
  }
  const el = document.createElement('span');
  el.textContent = code;
  return el.innerHTML;
}

function _cvComputeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const hunks = [];
  let oi = 0, ni = 0;
  // Simple line-by-line LCS-style diff
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      hunks.push({ type: 'ctx', text: oldLines[oi] });
      oi++; ni++;
    } else {
      // Find next common line within a lookahead window
      let foundOld = -1, foundNew = -1;
      const window = 20;
      outer:
      for (let d = 1; d < window; d++) {
        for (let s = 0; s <= d; s++) {
          if (oi + s < oldLines.length && ni + d < newLines.length && oldLines[oi + s] === newLines[ni + d]) {
            foundOld = s; foundNew = d; break outer;
          }
          if (ni + s < newLines.length && oi + d < oldLines.length && oldLines[oi + d] === newLines[ni + s]) {
            foundOld = d; foundNew = s; break outer;
          }
        }
      }
      if (foundOld === -1) {
        // No convergence in window — emit remaining as del/add
        while (oi < oldLines.length) { hunks.push({ type: 'del', text: oldLines[oi++] }); }
        while (ni < newLines.length) { hunks.push({ type: 'add', text: newLines[ni++] }); }
      } else {
        for (let i = 0; i < foundOld; i++) { hunks.push({ type: 'del', text: oldLines[oi++] }); }
        for (let i = 0; i < foundNew; i++) { hunks.push({ type: 'add', text: newLines[ni++] }); }
      }
    }
  }
  return hunks;
}

function _cvRenderDiff(hunks, language) {
  // Trim leading/trailing context to keep it tight, show up to 3 ctx lines around changes
  const condensed = [];
  let lastChangeIdx = -999;
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'ctx') { lastChangeIdx = i; }
  }
  let prevChangeIdx = -999;
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'ctx') {
      prevChangeIdx = i;
      condensed.push(hunks[i]);
    } else {
      // Next change index
      let nextChange = hunks.length;
      for (let j = i + 1; j < hunks.length; j++) {
        if (hunks[j].type !== 'ctx') { nextChange = j; break; }
      }
      const distBefore = i - prevChangeIdx;
      const distAfter = nextChange - i;
      if (distBefore <= 3 || distAfter <= 3) {
        condensed.push(hunks[i]);
      } else if (distBefore === 4 || distAfter === 4) {
        // Show the separator line
        condensed.push(hunks[i]);
      } else if (condensed.length > 0 && condensed[condensed.length - 1].type !== 'sep') {
        condensed.push({ type: 'sep' });
      }
    }
  }

  let html = '';
  for (const h of condensed) {
    if (h.type === 'sep') {
      html += '<span class="cv-diff-line cv-diff-hunk">───</span>';
      continue;
    }
    const prefix = h.type === 'add' ? '+' : h.type === 'del' ? '-' : ' ';
    const cls = h.type === 'add' ? 'cv-diff-add' : h.type === 'del' ? 'cv-diff-del' : 'cv-diff-ctx';
    const highlighted = _cvHighlight(h.text, language);
    html += `<span class="cv-diff-line ${cls}"><span class="cv-diff-prefix">${prefix}</span>${highlighted}</span>`;
  }
  return html;
}

function _cvRenderLineNumbers(lineCount) {
  const el = document.querySelector('#code-viewer .cv-line-numbers');
  if (!el) return;
  if (lineCount > 2000) { el.innerHTML = ''; return; }
  let html = '';
  for (let i = 1; i <= lineCount; i++) html += `<span>${i}</span>`;
  el.innerHTML = html;
}

function _cvRenderTab(tab) {
  const panel = document.getElementById('code-viewer');
  const pathEl = document.getElementById('code-viewer-path');
  const badgeEl = document.getElementById('code-viewer-badge');
  const codeEl = document.getElementById('code-viewer-code');
  const langEl = document.getElementById('code-viewer-lang');
  const infoEl = document.getElementById('code-viewer-info');
  const contentEl = document.getElementById('code-viewer-content');

  pathEl.textContent = _cvShortPath(tab.path);
  pathEl.title = tab.path;

  if (tab.badge === 'new') {
    badgeEl.textContent = 'NEW'; badgeEl.className = 'cv-badge cv-badge-new';
  } else if (tab.badge === 'edit') {
    badgeEl.textContent = 'EDIT'; badgeEl.className = 'cv-badge cv-badge-edit';
  } else {
    badgeEl.textContent = 'READ'; badgeEl.className = 'cv-badge cv-badge-read';
  }

  const toolbar = document.getElementById('code-viewer-toolbar');
  const editBtn = document.getElementById('code-viewer-edit-btn');

  // Media branch: if the tab's path has a known media extension, render an
  // <img>/<video>/<audio> instead of the code+line-numbers view. No edit UI.
  const mediaExtMatch = (tab.path || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const mediaExt = mediaExtMatch ? mediaExtMatch[1] : null;
  let mediaType = null;
  if (mediaExt) {
    if (MEDIA_EXTS.image.includes(mediaExt)) mediaType = 'image';
    else if (MEDIA_EXTS.video.includes(mediaExt)) mediaType = 'video';
    else if (MEDIA_EXTS.audio.includes(mediaExt)) mediaType = 'audio';
  }
  if (mediaType && tab.mode !== 'diff') {
    contentEl.classList.remove('has-lines');
    document.querySelector('#code-viewer .cv-line-numbers').innerHTML = '';
    const workspacePath = tab.path.startsWith('/workspace/') ? tab.path : `/workspace/${tab.path.replace(/^\/+/, '')}`;
    const mediaUrl = resolveAnimaMediaUrl(workspacePath);
    const escUrl = esc(mediaUrl);
    if (mediaType === 'image') {
      codeEl.innerHTML = `<div class="cv-media"><img src="${escUrl}" alt="${esc(tab.path)}" loading="lazy" onclick="window.open(this.src,'_blank')"></div>`;
    } else if (mediaType === 'video') {
      codeEl.innerHTML = `<div class="cv-media"><video src="${escUrl}" controls preload="metadata"></video></div>`;
    } else {
      codeEl.innerHTML = `<div class="cv-media"><audio src="${escUrl}" controls preload="metadata"></audio></div>`;
    }
    langEl.textContent = mediaType;
    infoEl.textContent = mediaExt.toUpperCase();
    toolbar.classList.remove('active');
    panel.classList.remove('editing');
    contentEl.scrollTop = 0;
    _cvRenderTabBar();
    if (_cvMode === 'auto' || panel.classList.contains('active')) {
      panel.classList.add('active');
      _cvPendingCount = 0;
      _cvUpdatePendingBadge();
      if (_cvDocked) { _ctShowTabBar(); _ctSetActiveTab('code'); }
    } else if (_cvMode === 'on-request') {
      _cvPendingCount++;
      _cvUpdatePendingBadge();
      _ctUpdateCodeBadge();
    }
    return;
  }

  if (tab.mode === 'diff') {
    contentEl.classList.remove('has-lines');
    document.querySelector('#code-viewer .cv-line-numbers').innerHTML = '';
    codeEl.innerHTML = tab.content;
    langEl.textContent = _cvLangAlias(tab.language);
    infoEl.textContent = 'diff';
    toolbar.classList.remove('active');
  } else {
    contentEl.classList.add('has-lines');
    codeEl.innerHTML = _cvHighlight(tab.content, tab.language);
    const lineCount = tab.content.split('\n').length;
    _cvRenderLineNumbers(lineCount);
    langEl.textContent = _cvLangAlias(tab.language);
    infoEl.textContent = `${lineCount} lines`;
    // Show toolbar with Edit button for viewable files
    toolbar.classList.add('active');
    editBtn.style.display = '';
    document.getElementById('code-viewer-save-btn').style.display = 'none';
    document.getElementById('code-viewer-discard-btn').style.display = 'none';
    document.getElementById('code-viewer-save-status').textContent = '';
  }

  panel.classList.remove('editing');

  // Scroll to top
  contentEl.scrollTop = 0;

  // Update tab bar
  _cvRenderTabBar();

  if (_cvMode === 'auto' || panel.classList.contains('active')) {
    panel.classList.add('active');
    _cvPendingCount = 0;
    _cvUpdatePendingBadge();
    if (_cvDocked) {
      _ctShowTabBar();
      _ctSetActiveTab('code');
    }
  } else if (_cvMode === 'on-request') {
    _cvPendingCount++;
    _cvUpdatePendingBadge();
    _ctUpdateCodeBadge();
  }
  _cvResetAutoHide();
}

function _cvRenderTabBar() {
  const bar = document.getElementById('code-viewer-tabs');
  if (!bar) return;
  if (_cvTabs.length <= 1) { bar.innerHTML = ''; return; }
  bar.innerHTML = _cvTabs.map(t => {
    const active = t.id === _cvActiveTabId ? ' active' : '';
    const name = _cvFileName(t.path);
    const icon = t.badge === 'edit' ? '~' : t.badge === 'new' ? '+' : '';
    return `<span class="cv-tab${active}" data-cv-tab="${t.id}">${icon ? `<span style="color:var(--accent2)">${icon}</span> ` : ''}${name}<span class="cv-tab-close" data-cv-close="${t.id}">&times;</span></span>`;
  }).join('');
}

function _cvAddTab(path, mode, content, language, badge) {
  // Reuse existing tab for same path, or create new
  let tab = _cvTabs.find(t => t.path === path);
  if (tab) {
    tab.mode = mode;
    tab.content = content;
    tab.language = language;
    tab.badge = badge;
  } else {
    if (_cvTabs.length >= CV_MAX_TABS) _cvTabs.shift();
    tab = { id: 'cv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), path, mode, content, language, badge };
    _cvTabs.push(tab);
  }
  _cvActiveTabId = tab.id;
  _cvRenderTab(tab);
}

function _cvSwitchTab(tabId) {
  const tab = _cvTabs.find(t => t.id === tabId);
  if (!tab) return;
  _cvActiveTabId = tabId;
  _cvRenderTab(tab);
}

function _cvCloseTab(tabId) {
  const idx = _cvTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  _cvTabs.splice(idx, 1);
  if (_cvTabs.length === 0) {
    document.getElementById('code-viewer').classList.remove('active');
    if (_cvDocked) { _ctSetActiveTab('graph'); _ctHideTabBar(); }
    return;
  }
  if (_cvActiveTabId === tabId) {
    _cvActiveTabId = _cvTabs[Math.min(idx, _cvTabs.length - 1)].id;
    _cvRenderTab(_cvTabs.find(t => t.id === _cvActiveTabId));
  } else {
    _cvRenderTabBar();
  }
}

function _cvResetAutoHide() {
  if (_cvAutoHideTimer) clearTimeout(_cvAutoHideTimer);
  _cvAutoHideTimer = setTimeout(() => {
    // Don't auto-hide, just dim the border
  }, CV_AUTO_HIDE_MS);
}

function _cvUpdatePendingBadge() {
  const badge = document.getElementById('cv-pending-badge');
  if (!badge) return;
  if (_cvPendingCount > 0 && _cvMode === 'on-request' && !document.getElementById('code-viewer').classList.contains('active')) {
    badge.textContent = '{ } ' + _cvPendingCount + ' file' + (_cvPendingCount === 1 ? '' : 's');
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function _cvShowFromBadge() {
  _cvPendingCount = 0;
  _cvUpdatePendingBadge();
  _ctUpdateCodeBadge();
  const panel = document.getElementById('code-viewer');
  if (_cvTabs.length > 0) {
    panel.classList.add('active');
    const tab = _cvTabs.find(t => t.id === _cvActiveTabId) || _cvTabs[_cvTabs.length - 1];
    if (tab) _cvRenderTab(tab);
    if (_cvDocked) { _ctShowTabBar(); _ctSetActiveTab('code'); }
  }
}

let _cvEditing = false;
let _cvOriginalContent = '';
let _cvAceEditor = null;

const _cvAceModeMap = {
  javascript: 'javascript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  python: 'python', py: 'python', ruby: 'ruby', rb: 'ruby',
  go: 'golang', rust: 'rust', rs: 'rust', java: 'java',
  c: 'c_cpp', cpp: 'c_cpp', h: 'c_cpp',
  html: 'html', htm: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  markdown: 'markdown', md: 'markdown',
  sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
  xml: 'xml', svg: 'xml', php: 'php', swift: 'swift',
  kotlin: 'kotlin', kt: 'kotlin', lua: 'lua', perl: 'perl',
  dockerfile: 'dockerfile', makefile: 'makefile',
  text: 'text',
};

function _cvGetAceMode(language) {
  return _cvAceModeMap[language] || _cvAceModeMap[language?.toLowerCase()] || 'text';
}

function _cvEnsureAce() {
  if (_cvAceEditor) return _cvAceEditor;
  if (typeof ace === 'undefined') return null;

  _cvAceEditor = ace.edit('code-viewer-ace', {
    theme: 'ace/theme/one_dark',
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', 'Consolas', monospace",
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false,
    enableBasicAutocompletion: false,
    highlightActiveLine: true,
    showGutter: true,
    animatedScroll: false,
  });

  // Load the one_dark theme — fall back to monokai if unavailable
  try {
    ace.config.set('basePath', 'https://cdn.jsdelivr.net/npm/ace-builds@1.36.5/src-min-noconflict');
    _cvAceEditor.setTheme('ace/theme/one_dark');
  } catch {
    try { _cvAceEditor.setTheme('ace/theme/monokai'); } catch { }
  }

  // Ctrl+S / Cmd+S to save
  _cvAceEditor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: _cvSave,
  });

  return _cvAceEditor;
}

function _cvEnterEditMode() {
  const panel = document.getElementById('code-viewer');
  const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
  if (!tab || tab.mode === 'diff') return;

  const editor = _cvEnsureAce();
  if (!editor) return;

  _cvEditing = true;
  _cvOriginalContent = tab.content;
  panel.classList.add('editing');

  const aceMode = _cvGetAceMode(tab.language);
  editor.session.setMode('ace/mode/' + aceMode);
  editor.setValue(tab.content, -1);
  editor.clearSelection();
  editor.focus();
  editor.gotoLine(1, 0, false);

  // Resize ace to fit the container
  setTimeout(() => editor.resize(), 50);

  document.getElementById('code-viewer-toolbar').classList.add('active');
  document.getElementById('code-viewer-edit-btn').style.display = 'none';
  document.getElementById('code-viewer-save-btn').style.display = '';
  document.getElementById('code-viewer-discard-btn').style.display = '';
  document.getElementById('code-viewer-save-status').textContent = '';

  document.getElementById('code-viewer-info').textContent = 'editing';
}

function _cvExitEditMode(keepChanges) {
  const panel = document.getElementById('code-viewer');

  if (keepChanges && _cvAceEditor) {
    const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
    if (tab) {
      tab.content = _cvAceEditor.getValue();
      _cvRenderTab(tab);
    }
  }

  _cvEditing = false;
  panel.classList.remove('editing');
  document.getElementById('code-viewer-edit-btn').style.display = '';
  document.getElementById('code-viewer-save-btn').style.display = 'none';
  document.getElementById('code-viewer-discard-btn').style.display = 'none';
}

function _cvSave() {
  const tab = _cvTabs.find(t => t.id === _cvActiveTabId);
  if (!tab || !_cvAceEditor) return;

  const newContent = _cvAceEditor.getValue();
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const statusEl = document.getElementById('code-viewer-save-status');

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';

  if (window._ws && window._ws.readyState === 1) {
    window._ws.send(JSON.stringify({
      type: 'code:save',
      path: tab.path,
      content: newContent,
    }));
  } else {
    statusEl.textContent = 'Error: no connection';
    saveBtn.disabled = false;
  }
}

function handleCodeEvent(msg) {
  if (_cvMode === 'off') return;

  if (msg.type === 'code:view') {
    if (_cvEditing) _cvExitEditMode(false);
    const badge = msg.isNew ? 'new' : 'read';
    _cvAddTab(msg.path, 'view', msg.content, msg.language, badge);
  } else if (msg.type === 'code:diff') {
    if (_cvEditing) _cvExitEditMode(false);
    const hunks = _cvComputeDiff(msg.oldText, msg.newText);
    const diffHtml = _cvRenderDiff(hunks, msg.language);
    _cvAddTab(msg.path, 'diff', diffHtml, msg.language, 'edit');
  } else if (msg.type === 'code:close') {
    if (_cvEditing) _cvExitEditMode(false);
    document.getElementById('code-viewer').classList.remove('active');
    if (_cvDocked) { _ctSetActiveTab('graph'); }
  } else if (msg.type === 'code:saved') {
    const statusEl = document.getElementById('code-viewer-save-status');
    const saveBtn = document.getElementById('code-viewer-save-btn');
    if (msg.error) {
      statusEl.textContent = 'Error: ' + msg.error;
      saveBtn.disabled = false;
    } else {
      statusEl.textContent = 'Saved ✓';
      saveBtn.disabled = false;
      const tab = _cvTabs.find(t => t.path === msg.path);
      if (tab && _cvAceEditor) {
        tab.content = _cvAceEditor.getValue();
      }
      setTimeout(() => {
        _cvExitEditMode(true);
        statusEl.textContent = '';
      }, 800);
    }
  }
}

function _initCodeViewer() {
  const panel = document.getElementById('code-viewer');
  const header = document.getElementById('code-viewer-header');
  const closeBtn = document.getElementById('code-viewer-close');
  const resizeHandle = document.getElementById('code-viewer-resize');
  const tabBar = document.getElementById('code-viewer-tabs');
  const editBtn = document.getElementById('code-viewer-edit-btn');
  const saveBtn = document.getElementById('code-viewer-save-btn');
  const discardBtn = document.getElementById('code-viewer-discard-btn');
  const dockBtn = document.getElementById('cv-dock-btn');
  if (!panel || !header) return;

  // Apply initial docked state
  if (_cvDocked) {
    panel.classList.add('cv-docked');
  } else {
    panel.classList.remove('cv-docked');
  }

  // Mode selector
  const modeSelect = document.getElementById('code-viewer-mode');
  if (modeSelect) {
    modeSelect.value = _cvMode;
    modeSelect.addEventListener('change', () => {
      _cvMode = modeSelect.value;
      localStorage.setItem('cv-mode', _cvMode);
      if (_cvMode === 'off') {
        panel.classList.remove('active');
        _cvPendingCount = 0;
        _cvUpdatePendingBadge();
        if (_cvDocked) { _ctSetActiveTab('graph'); _ctHideTabBar(); }
      }
    });
    modeSelect.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Restore floating position/size (only applied when floating)
  if (!_cvDocked) {
    try {
      const saved = JSON.parse(localStorage.getItem('_codeViewerPos') || '{}');
      if (saved.x != null && saved.y != null) {
        panel.style.left = saved.x + 'px'; panel.style.top = saved.y + 'px';
      }
      if (saved.w) panel.style.width = saved.w + 'px';
      if (saved.h) panel.style.height = saved.h + 'px';
    } catch { }
  }

  function savePos() {
    if (_cvDocked) return;
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem('_codeViewerPos', JSON.stringify({
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      }));
    } catch { }
  }

  // Dragging (only when floating)
  let dragX, dragY, startX, startY;
  header.addEventListener('mousedown', (e) => {
    if (_cvDocked) return;
    if (e.target.closest('button') || e.target.closest('select')) return;
    e.preventDefault();
    dragX = e.clientX; dragY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startX = rect.left; startY = rect.top;
    const onMove = (ev) => {
      panel.style.left = (startX + ev.clientX - dragX) + 'px';
      panel.style.top = (startY + ev.clientY - dragY) + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); savePos(); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click header to toggle docked/floating
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || e.target.closest('select')) return;
    _cvSetDocked(!_cvDocked);
  });

  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e) => {
      if (_cvDocked) return;
      e.preventDefault(); e.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const onMove = (ev) => {
        const w = Math.max(400, ev.clientX - rect.left);
        const h = Math.max(250, ev.clientY - rect.top);
        panel.style.width = w + 'px'; panel.style.height = h + 'px';
        if (_cvAceEditor) _cvAceEditor.resize();
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); savePos(); if (_cvAceEditor) _cvAceEditor.resize(); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  closeBtn.addEventListener('click', () => {
    if (_cvEditing) _cvExitEditMode(false);
    panel.classList.remove('active');
    if (_cvDocked) { _ctSetActiveTab('graph'); if (_cvTabs.length === 0) _ctHideTabBar(); }
  });

  // Dock button (only visible when floating)
  if (dockBtn) {
    dockBtn.addEventListener('click', () => _cvSetDocked(true));
  }

  // Edit / Save / Discard buttons
  editBtn.addEventListener('click', _cvEnterEditMode);
  saveBtn.addEventListener('click', _cvSave);
  discardBtn.addEventListener('click', () => _cvExitEditMode(false));

  // Tab clicks
  tabBar.addEventListener('click', (e) => {
    const closeEl = e.target.closest('[data-cv-close]');
    if (closeEl) {
      if (_cvEditing) _cvExitEditMode(false);
      _cvCloseTab(closeEl.dataset.cvClose);
      return;
    }
    const tabEl = e.target.closest('[data-cv-tab]');
    if (tabEl) {
      if (_cvEditing) _cvExitEditMode(false);
      _cvSwitchTab(tabEl.dataset.cvTab);
    }
  });

  _initCanvasTabs();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initCodeViewer);
} else {
  _initCodeViewer();
}

const MEDIA_EXTS = {
  image: ['png','jpg','jpeg','gif','webp','svg','avif','bmp'],
  video: ['mp4','webm','mov','avi','mkv'],
  audio: ['mp3','wav','ogg','flac','m4a','aac'],
};

// Normalize any media URL string to a same-origin URL the current UI can load.
// This makes media rendering robust across topologies (localhost, reverse proxy,
// tunnels, subpath mounts): the agent can emit absolute or relative URLs and the
// UI rewrites them to resolve against whichever origin served the chat.
function resolveAnimaMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return url;

  let parsed;
  try { parsed = new URL(url, window.location.href); } catch { return url; }

  // 1. Any /workspace/<rest> path (regardless of origin) → same-origin /files/<rest>
  const wsIdx = parsed.pathname.indexOf('/workspace/');
  if (wsIdx !== -1) {
    const rel = parsed.pathname.slice(wsIdx + '/workspace/'.length);
    return `${API}/files/${rel}${parsed.search}`;
  }

  // 2. Already same-origin → trust it
  if (parsed.origin === window.location.origin) return url;

  // 3. Cross-origin but points at a "local" hostname → rewrite to same-origin /files/.
  // Any path served from a localhost origin is treated as a workspace file: either
  // after an explicit /files/ segment, or (when the agent served it via its own port
  // with no prefix) the full pathname as the file key.
  const host = parsed.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocalHost) {
    const filesIdx = parsed.pathname.lastIndexOf('/files/');
    if (filesIdx !== -1) {
      const rel = parsed.pathname.slice(filesIdx + '/files/'.length);
      return `${API}/files/${rel}${parsed.search}`;
    }
    // Bare http://localhost:PORT/foo.png → web_serve static root (/workspace/web/)
    const rel = parsed.pathname.replace(/^\/+/, '');
    if (rel) return `${API}/files/web/${rel}${parsed.search}`;
  }

  // 4. External URL (CDN, YouTube, etc.) — leave alone
  return url;
}

function detectMediaInText(text) {
  // Match /workspace/... paths (internal) and absolute URLs ending in a known media ext.
  const patterns = [
    /[`'("<]?(\/workspace\/[^\s"'<>`)]+\.(\w+))[`'")>]?/gi,
    /[`'("<]?(https?:\/\/[^\s"'<>`)]+\.(\w+))[`'")>]?/gi,
  ];
  const found = [];
  const seen = new Set();
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[1];
      const ext = m[2].toLowerCase();
      if (seen.has(raw)) continue;
      let type = null;
      if (MEDIA_EXTS.image.includes(ext)) type = 'image';
      else if (MEDIA_EXTS.video.includes(ext)) type = 'video';
      else if (MEDIA_EXTS.audio.includes(ext)) type = 'audio';
      if (!type) continue;
      const resolved = resolveAnimaMediaUrl(raw);
      seen.add(raw);
      found.push({ url: resolved, type, raw });
    }
  }
  return found;
}

// Walk an HTML string and rewrite media src attributes through resolveAnimaMediaUrl.
// Heals markdown-rendered <img>/<video>/<audio> that contain baked-in absolute URLs.
function rewriteMediaUrlsInHtml(html) {
  if (!html || typeof html !== 'string') return html;
  const tmpl = document.createElement('template');
  tmpl.innerHTML = html;
  tmpl.content.querySelectorAll('img, video, audio, source').forEach(el => {
    const src = el.getAttribute('src');
    if (src) {
      const fixed = resolveAnimaMediaUrl(src);
      if (fixed !== src) el.setAttribute('src', fixed);
    }
    const poster = el.getAttribute('poster');
    if (poster) {
      const fixed = resolveAnimaMediaUrl(poster);
      if (fixed !== poster) el.setAttribute('poster', fixed);
    }
  });
  return tmpl.innerHTML;
}

function renderMediaHtml(media) {
  return media.map(m => {
    if (m.type === 'image') return `<img src="${esc(m.url)}" alt="image" loading="lazy" onclick="window.open(this.src,'_blank')">`;
    if (m.type === 'video') return `<video src="${esc(m.url)}" controls preload="metadata"></video>`;
    if (m.type === 'audio') return `<audio src="${esc(m.url)}" controls preload="metadata"></audio>`;
    return '';
  }).join('');
}

const _markedRenderer = (() => {
  if (typeof marked === 'undefined') return null;
  const renderer = new marked.Renderer();
  renderer.link = function({ href, title, text }) {
    const t = title ? ` title="${esc(title)}"` : '';
    return `<a href="${esc(href)}"${t} target="_blank" rel="noopener">${text}</a>`;
  };
  renderer.code = function({ text, lang }) {
    if (lang === 'diff' || (!lang && text.match(/^[+-@]/m) && text.includes('@@'))) {
      const lines = text.split('\n').map(line => {
        const cls = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : 'context';
        return `<div class="diff-line ${cls}">${esc(line)}</div>`;
      }).join('');
      return `<div class="diff-block">${lines}</div>`;
    }
    const language = lang && Prism.languages[lang] ? lang : '';
    const label = lang ? `<div style="display:flex;justify-content:flex-end;padding:4px 10px 0;font-family:var(--font-mono);font-size:.58rem;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;user-select:none">${esc(lang)}</div>` : '';
    if (language) {
      const highlighted = Prism.highlight(text, Prism.languages[language], language);
      return `<pre class="language-${language}">${label}<code class="language-${language}">${highlighted}</code></pre>`;
    }
    return `<pre>${label}<code>${esc(text)}</code></pre>`;
  };
  marked.setOptions({
    renderer,
    gfm: true,
    breaks: true,
  });
  return renderer;
})();

function renderMarkdown(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    let raw = marked.parse(text);
    raw = raw.replace(/(^|[^"'>])(https?:\/\/[^\s<"']+)/g, (m, pre, url) => {
      if (pre.endsWith('href="') || pre.endsWith("href='") || pre.endsWith('src="')) return m;
      return `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
    });
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
      ALLOWED_TAGS: ['p','br','strong','em','a','code','pre','h1','h2','h3','h4','h5','h6',
        'ul','ol','li','blockquote','table','thead','tbody','tr','th','td','hr','del','span','div','img','video','audio'],
    });
  }
  let s = esc(text);
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function _formatUsageTag(usage, iterations) {
  const inTok = (usage.input_tokens||0).toLocaleString();
  const outTok = (usage.output_tokens||0).toLocaleString();
  const iters = iterations || 1;
  const cached = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  let cacheHint = '';
  if (cached > 0 || cacheWrite > 0) {
    const total = (usage.input_tokens||0);
    const pct = total > 0 ? Math.round(cached / total * 100) : 0;
    cacheHint = ` · ${pct}% cached`;
  }
  return `<span class="usage-tag">${inTok} in / ${outTok} out · ${iters} iteration${iters>1?'s':''}${cacheHint}</span>`;
}

function formatAssistantMsg(text, meta) {
  let html = rewriteMediaUrlsInHtml(renderMarkdown(text));
  const media = detectMediaInText(text);
  if (media.length) {
    html += '<div class="media-grid">' + renderMediaHtml(media) + '</div>';
  }
  if (meta?.toolUsage && typeof meta.toolUsage === 'object') {
    const entries = Object.entries(meta.toolUsage);
    if (entries.length) {
      html += '<div style="margin-top:8px">';
      for (const [tool, count] of entries) {
        html += `<span class="tool-tag">${esc(tool)}${count > 1 ? ' ×' + count : ''}</span>`;
      }
      html += '</div>';
    }
  }
  if (meta?.usage) {
    html += _formatUsageTag(meta.usage, meta.iterations);
  }
  return html;
}

// Avatars for the chat row. Assistant uses the F01 spore mark (inherits
// brand.chatLogo if present, falls back to an inline SVG). User gets a
// generic person silhouette.
const _USER_AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';
function _assistantAvatarHtml() {
  if (window.BRAND && window.BRAND.chatLogo) return window.BRAND.chatLogo;
  // Fallback F01 mark (small).
  return '<svg viewBox="-1 -1 2 2" aria-hidden="true"><g stroke="currentColor" stroke-width="0.06" stroke-linecap="round"><line x1="0" y1="0" x2="0" y2="-0.62"/><line x1="0" y1="0" x2="0.5369" y2="-0.31"/><line x1="0" y1="0" x2="0.5369" y2="0.31"/><line x1="0" y1="0" x2="0" y2="0.62"/><line x1="0" y1="0" x2="-0.5369" y2="0.31"/><line x1="0" y1="0" x2="-0.5369" y2="-0.31"/></g><g fill="#c8762c"><circle cx="0" cy="-0.62" r="0.18"/><circle cx="0.5369" cy="-0.31" r="0.18"/><circle cx="0.5369" cy="0.31" r="0.18"/><circle cx="0" cy="0.62" r="0.18"/><circle cx="-0.5369" cy="0.31" r="0.18"/><circle cx="-0.5369" cy="-0.31" r="0.18"/></g><circle cx="0" cy="0" r="0.2" fill="currentColor"/></svg>';
}
// Wrap a user/assistant bubble in a row with an avatar. Returns the row.
// Pass-through for system/agent/etc. roles — they don't get avatars.
function _wrapChatBubble(bubbleEl, role) {
  if (role !== 'user' && role !== 'assistant') return bubbleEl;
  const row = document.createElement('div');
  row.className = 'chat-row ' + role;
  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar ' + role;
  avatar.innerHTML = role === 'assistant' ? _assistantAvatarHtml() : _USER_AVATAR_SVG;
  // row-reverse on .user already places the avatar on the right; we just
  // append in the same order both ways.
  row.appendChild(avatar);
  row.appendChild(bubbleEl);
  return row;
}

function addChatMessage(role, text, attachments) {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  el.textContent = text;
  if (attachments?.length && role === 'user') {
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const a of attachments) {
      if (a.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        img.alt = a.name;
        grid.appendChild(img);
      } else if (a.type.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = a.dataUrl; vid.controls = true; vid.preload = 'metadata';
        grid.appendChild(vid);
      } else if (a.type.startsWith('audio/')) {
        const aud = document.createElement('audio');
        aud.src = a.dataUrl; aud.controls = true; aud.preload = 'metadata';
        grid.appendChild(aud);
      }
    }
    el.appendChild(grid);
  }
  const wasAtBottom = chatShouldAutoScroll();
  container.appendChild(_wrapChatBubble(el, role));
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  return el;
}

function showTyping(show) {
  let el = document.querySelector('.chat-typing');
  if (show && !el) {
    el = document.createElement('div');
    el.className = 'chat-typing';
    el.innerHTML = 'thinking<span class="dots"></span>';
    document.getElementById('chat-messages').appendChild(el);
  } else if (!show && el) {
    el.remove();
  }
}


// ── Real-time Graph Events ──
// (The legacy fade-out feed was replaced by #event-log — see addEventToFeed
// below. recentEvents / MAX_FEED_ITEMS are no longer used.)

function handleGraphEvent(evt) {
  addEventToFeed(evt);

  // Reflect background-system activity on the self-node.
  const op = String(evt?.op || '');
  if (op === 'learner:start') _sporeActivityStart('learner');
  else if (op === 'learner:done') _sporeActivityEnd('learner');
  else if (op === 'session:summarize-start') _sporeActivityStart('session-summarize');
  else if (op === 'session:summarize-done') _sporeActivityEnd('session-summarize');
  else if (op === 'session:distill-start') _sporeActivityStart('session-distill');
  else if (op === 'session:distill-done') _sporeActivityEnd('session-distill');
  else if (op === 'tool:call') _sporeActivityPulse('tool', 1500);

  if (evt.op === 'node:create') {
    queueGraphRefresh();
    if (evt.node?.id) pendingAnimations.newNodes.add(evt.node.id);
  } else if (evt.op === 'node:update' || evt.op === 'attribute:create' || evt.op === 'aspect:create' || evt.op === 'reflection:upsert') {
    const nid = evt.nodeId || evt.node?.id;
    if (nid) pendingAnimations.pulseNodes.add(nid);
    queueGraphRefresh();
  } else if (evt.op === 'edge:create') {
    queueGraphRefresh();
    if (evt.edge) pendingAnimations.newEdges.push(evt.edge);
  } else if (evt.op === 'node:delete') {
    const nid = evt.nodeId;
    if (nid && gNodes) {
      gNodes.selectAll('g').filter(d => d.id === nid).classed('node-deleting', true);
      if (gLinks) {
        gLinks.selectAll('line').filter(d => d.source.id === nid || d.target.id === nid).classed('edge-deleting', true);
      }
    }
    setTimeout(() => queueGraphRefresh(), 1300);
  } else if (evt.op === 'edge:delete') {
    if (evt.edge && gLinks) {
      gLinks.selectAll('line')
        .filter(d => d.source.id === evt.edge.source && d.target.id === evt.edge.target && d.type === evt.edge.type)
        .classed('edge-deleting', true);
    }
    setTimeout(() => queueGraphRefresh(), 1100);
  } else if (evt.op === 'node:accessed') {
    const ids = evt.nodeIds || [];
    if (ids.length && gNodes) {
      gNodes.selectAll('g').each(function(d) {
        if (ids.includes(d.id)) {
          const el = d3.select(this);
          el.classed('node-accessed', false);
          void this.offsetWidth;
          el.classed('node-accessed', true);
        }
      });
      setTimeout(() => {
        gNodes.selectAll('g').classed('node-accessed', false);
      }, 1300);
    }
  }
}

const pendingAnimations = { newNodes: new Set(), pulseNodes: new Set(), newEdges: [] };
let refreshTimer = null;
let simLinks = [];

function queueGraphRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      const data = await fetchGraph();
      const anims = { newNodes: new Set(pendingAnimations.newNodes), pulseNodes: new Set(pendingAnimations.pulseNodes), newEdges: [...pendingAnimations.newEdges] };
      pendingAnimations.newNodes.clear();
      pendingAnimations.pulseNodes.clear();
      pendingAnimations.newEdges.length = 0;

      if (!simulation) { initGraph(data); return; }
      mergeGraph(data, anims);
    } catch (e) { console.error('Graph refresh failed:', e); }
  }, 800);
}

// Scales node radius by how much information lives on the node: each aspect
// contributes a base unit, each attribute a fraction. A small importance bump
// keeps high-importance seed nodes visible even when sparse, and a log-shape
// scaling keeps 40-attribute giants from swallowing the graph.
function _computeNodeRadius(n) {
  const aspects = Array.isArray(n?.aspects) ? n.aspects : [];
  const aspectCount = aspects.length;
  let attrCount = 0;
  for (const a of aspects) attrCount += Array.isArray(a.attributes) ? a.attributes.length : 0;
  const info = aspectCount * 2 + attrCount * 0.6;
  const infoRadius = Math.sqrt(info) * 2.4;   // 0 attrs → 0, 1a/1at → ~3.9, 5a/20at → ~10.9, 10a/50at → ~14.6
  const impBonus = Math.max(0, Math.min((Number(n?.importance) || 5) - 5, 5)); // 0..5
  const base = Math.max(6, Math.min(6 + infoRadius + impBonus, 24));
  // The self-node carries the F01 mark — flower-as-graph-node — and is
  // the visual anchor of the graph. Always render it noticeably larger
  // than ordinary nodes regardless of how many aspects/attributes it
  // happens to have.
  if (n?.type === 'self') return Math.max(36, base * 1.8);
  return base;
}

function mergeGraph(newData, anims) {
  const oldIds = new Set(graphData.nodes.map(n => n.id));
  const newIds = new Set(newData.nodes.map(n => n.id));
  const newNodeMap = {};
  newData.nodes.forEach(n => { newNodeMap[n.id] = n; });

  // Preserve positions from existing nodes
  const posMap = {};
  graphData.nodes.forEach(n => { posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy }; });

  // Update existing nodes in place (preserve d3 references)
  for (const n of graphData.nodes) {
    if (newNodeMap[n.id]) {
      const fresh = newNodeMap[n.id];
      n.label = fresh.label; n.type = fresh.type; n.description = fresh.description;
      n.importance = fresh.importance; n.aspects = fresh.aspects; n.aliases = fresh.aliases;
      n.extra = fresh.extra;
      n.radius = _computeNodeRadius(n);
    }
  }

  // Add new nodes
  const addedNodes = newData.nodes.filter(n => !oldIds.has(n.id));
  const canvasEl = document.getElementById('canvas');
  const seedNodeById = {};
  graphData.nodes.forEach((node) => { seedNodeById[node.id] = node; });
  let seedIndex = graphData.nodes.length;
  for (const n of addedNodes) {
    n.radius = _computeNodeRadius(n);
    if (posMap[n.id]?.x != null && posMap[n.id]?.y != null) {
      n.x = posMap[n.id].x;
      n.y = posMap[n.id].y;
    } else {
      const seed = _neighborSeedPosition(
        n.id,
        newData.edges,
        seedNodeById,
        canvasEl.clientWidth,
        canvasEl.clientHeight,
        seedIndex,
      );
      n.x = seed.x;
      n.y = seed.y;
    }
    graphData.nodes.push(n);
    seedNodeById[n.id] = n;
    seedIndex += 1;
  }

  // Remove deleted nodes
  const removedIds = [...oldIds].filter(id => !newIds.has(id));
  if (removedIds.length) {
    const removeSet = new Set(removedIds);
    graphData.nodes = graphData.nodes.filter(n => !removeSet.has(n.id));
    if (hoveredNodeId && removeSet.has(hoveredNodeId)) hoveredNodeId = null;
  }

  // Rebuild edges (use fresh data but resolve to existing node objects)
  const nodeById = {};
  graphData.nodes.forEach(n => { nodeById[n.id] = n; });
  const newLinks = newData.edges
    .filter(e => nodeById[e.source] && nodeById[e.target])
    .map(e => ({ source: nodeById[e.source], target: nodeById[e.target], type: e.type, weight: e.weight }));

  graphData.edges = newData.edges;
  simLinks = newLinks;

  // Re-tune forces for current graph size
  const nodeCount = graphData.nodes.length;
  const profile = _graphForceProfile(nodeCount);
  const forceCanvasEl = document.getElementById('canvas');
  const forceWidth = forceCanvasEl?.clientWidth || window.innerWidth;
  const forceHeight = forceCanvasEl?.clientHeight || window.innerHeight;
  simulation.force('charge').strength(profile.chargeStrength).theta(profile.chargeTheta).distanceMax(profile.chargeMaxDist);
  // parent_of edges (created by drop-on-node "Move under as child") are
  // "sticky" — short distance + high strength so the child visually clings to
  // the parent. Everything else uses the profile defaults.
  simulation.force('link')
    .distance(l => l.type === 'parent_of' ? 28 : profile.linkDistance)
    .strength(l => l.type === 'parent_of' ? 0.95 : profile.linkStrength);
  // Label-box collision force; reinitialize is implicit when nodes change.
  // Rebuild per-node anchor accessors with current type distribution.
  const _typeAnchors2 = _typeClusterAnchors(graphData.nodes, forceWidth, forceHeight);
  simulation.force('clusterX').x(n => (_typeAnchors2.get(String(n.type || 'unknown'))?.x ?? forceWidth / 2)).strength(profile.clusterStrength);
  simulation.force('clusterY').y(n => (_typeAnchors2.get(String(n.type || 'unknown'))?.y ?? forceHeight / 2)).strength(profile.clusterStrength);
  simulation.velocityDecay(profile.velocityDecay);

  const structuralChange = addedNodes.length > 0 || removedIds.length > 0;
  simulation.nodes(graphData.nodes);
  simulation.force('link').links(simLinks);
  if (structuralChange) {
    simulation.alpha(profile.refreshAlpha).restart();
  } else {
    _scheduleTickRender();
  }

  // Re-bindD3 selections
  const link = gLinks.selectAll('line').data(simLinks, d => `${d.source.id}-${d.target.id}-${d.type}`);
  link.exit().remove();
  const linkEnter = link.enter().append('line')
    .attr('marker-end', 'url(#arrowhead)');
  if (anims) {
    linkEnter.each(function(d) {
      const isNew = anims.newEdges.some(e => e.source === d.source.id && e.target === d.target.id);
      if (isNew) d3.select(this).classed('edge-new', true);
    });
  }
  const allLinks = linkEnter.merge(link);

  const nodeG = gNodes.selectAll('g').data(graphData.nodes, d => d.id);
  nodeG.exit().remove();
  const nodeEnter = nodeG.enter().append('g')
    .call(_nodeDragBehavior())
    .on('click', (e, d) => {
      e.stopPropagation();
      if (_suppressNextGraphClick) {
        _suppressNextGraphClick = false;
        return;
      }
      hideGraphContextMenu();
      selectNode(d);
    })
    .on('mouseenter', (_, d) => _setHoveredNode(d.id))
    .on('mouseleave', (_, d) => {
      if (hoveredNodeId === d.id) _setHoveredNode(null);
    });

  if (anims) {
    nodeEnter.each(function(d) {
      if (anims.newNodes.has(d.id)) d3.select(this).classed('node-new', true);
    });
    nodeG.each(function(d) {
      if (anims.pulseNodes.has(d.id)) d3.select(this).classed('node-pulse', true);
    });
  }

  const allNodes = nodeEnter.merge(nodeG).classed('graph-node', true);
  _upsertNodeVisuals(allNodes);

  simulation.on('tick', _scheduleTickRender);

  // Apply semantic zoom to newly added nodes
  _applySemanticZoom(_currentZoomScale);

  // Update stats
  updateStats();

  if (anims) {
    setTimeout(() => {
      allNodes.classed('node-new', false).classed('node-pulse', false).classed('node-accessed', false);
      allLinks.classed('edge-new', false);
    }, 1400);
  }

  _restoreGraphSelection();
}

function updateStats() {
  const typeCounts = {};
  graphData.nodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
  const legendItems = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const color = TYPE_COLORS[type] || DEFAULT_COLOR;
      return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px">` +
        _legendNodeChip(type, color) +
        `<span>${type}</span><span style="opacity:0.5">${count}</span></span>`;
    }).join('');
  const typeCount = Object.keys(typeCounts).length;
  const statsEl = document.getElementById('stats');
  statsEl.innerHTML =
    `<div class="stats-line" id="stats-toggle" title="Toggle type breakdown">` +
      `<span class="stats-chevron">▸</span>` +
      `<span>${graphData.nodes.length} nodes · ${graphData.edges.length} edges · ${typeCount} types</span>` +
    `</div>` +
    `<div id="stats-legend">${legendItems}</div>`;
  document.getElementById('stats-toggle').addEventListener('click', () => {
    statsEl.classList.toggle('stats-open');
  });
}

// Localized resettlement after a drop — run the simulation briefly, but pin
// every node outside `radius` of (cx, cy) so only the neighbours adjust.
// Far-away clusters stay frozen; no global pulsating.
//
// Timeline:
//   0   → active phase at targetAlpha (local motion has energy)
//   40% → alphaTarget(0); sim decays naturally → smooth slowdown
//   100%→ stop() + unpin far nodes → everything goes still, no global winch
function _localResettle(cx, cy, radius = 220, duration = 1400, targetAlpha = 0.09) {
  if (!simulation || !graphData?.nodes) return;
  const r2 = radius * radius;
  const tempPinned = [];
  for (const n of graphData.nodes) {
    if (n.fx != null || n.fy != null) continue;
    const dx = (n.x ?? 0) - cx;
    const dy = (n.y ?? 0) - cy;
    if (dx * dx + dy * dy > r2) {
      n.fx = n.x;
      n.fy = n.y;
      tempPinned.push(n);
    }
  }
  if (_dragRestartTimer) { clearTimeout(_dragRestartTimer); _dragRestartTimer = null; }
  if (_dragDecayTimer) { clearTimeout(_dragDecayTimer); _dragDecayTimer = null; }
  simulation.alphaTarget(targetAlpha).restart();
  // Let the sim decay smoothly from ~40% through the window — creates a
  // gentle wind-down instead of a sudden stop.
  _dragDecayTimer = setTimeout(() => {
    if (simulation) simulation.alphaTarget(0);
    _dragDecayTimer = null;
  }, Math.round(duration * 0.4));
  // Hard stop + unpin at the end. Far nodes stay frozen through the decay
  // tail, so even the tiny residual alpha can't yank them.
  _dragRestartTimer = setTimeout(() => {
    if (simulation) simulation.stop();
    for (const n of tempPinned) { n.fx = null; n.fy = null; }
    _scheduleTickRender();
    _dragRestartTimer = null;
  }, duration);
}

function _nodeDragBehavior() {
  return d3.drag()
    .filter(e => e.button === 0 && !_isMarqueeGesture(e))
    .on('start', _dragStart)
    .on('drag', _dragging)
    .on('end', _dragEnd);
}

// Drag state — used by the hit-test + drop-menu logic below.
let _dragSourceId = null;
let _dragTargetId = null;
let _dragIsLifted = false;
let _dragRestartTimer = null;
let _dragDecayTimer = null;
let _dragMoved = false;   // set true on first real drag motion; clicks stay false

function _dragStart(e, d) {
  if (!simulation) return;
  // Don't stop the sim yet and don't mark as lifted — a pure click also fires
  // start+end with no drag motion in between. If we freeze the sim or add the
  // pointer-events:none class here, we'd swallow the click (mouseup never
  // lands on the node → no click event → node menu never opens).
  _dragSourceId = d?.id || null;
  _dragTargetId = null;
  _dragMoved = false;
  _dragIsLifted = false;
}
function _dragging(e, d) {
  // First-motion transition: promote this gesture from "maybe a click" to a
  // real drag. Freeze the sim, pin the node, add the lifted visuals.
  if (!_dragIsLifted) {
    simulation.stop();
    _dragIsLifted = true;
    _dragMoved = true;
    d.fx = d.x;
    d.fy = d.y;
    try {
      document.querySelectorAll('.node-dragging').forEach(n => n.classList.remove('node-dragging'));
      const host = _nodeDomFromId(_dragSourceId);
      if (host) host.classList.add('node-dragging');
    } catch {}
  }
  // Sim is stopped, so no tick copies fx→x. _renderTick reads d.x/d.y for the
  // node transform, so we must write both — otherwise the node doesn't move
  // visibly during drag.
  d.fx = e.x;
  d.fy = e.y;
  d.x = e.x;
  d.y = e.y;
  _scheduleTickRender();
  // Hit-test: which node (if any) is under the cursor right now?
  // Walk ALL elements at the point (elementsFromPoint) and pick the first
  // graph-node that isn't the one being dragged. pointer-events:none on the
  // dragged node (CSS) usually means it isn't in the stack at all, but this
  // is belt-and-suspenders for older behaviour / stacking quirks.
  try {
    const clientX = e.sourceEvent?.clientX;
    const clientY = e.sourceEvent?.clientY;
    if (clientX == null || clientY == null) return;
    const stack = (typeof document.elementsFromPoint === 'function')
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)];
    let targetId = null;
    for (const el of stack) {
      const hitId = _nodeIdFromDomElement(el);
      if (hitId && hitId !== _dragSourceId) { targetId = hitId; break; }
    }
    if (targetId !== _dragTargetId) _setDragTargetId(targetId);
    // Update the dashed connector line from source → target (or source → cursor)
    _updateDragConnector(d, targetId, e);
  } catch {}
}
function _dragEnd(e, d) {
  if (!simulation) return;
  const hadTarget = !!_dragTargetId;
  const targetId = _dragTargetId;
  const sourceId = _dragSourceId;
  const moved = _dragMoved;
  // Clear drag visuals regardless of outcome.
  try { document.querySelectorAll('.node-dragging').forEach(n => n.classList.remove('node-dragging')); } catch {}
  _setDragTargetId(null);
  _hideDragConnector();

  // Pure click (no motion): don't touch the simulation. The d3 click handler
  // on the node group will fire next and open the node menu.
  if (!moved) {
    _dragIsLifted = false;
    _dragSourceId = null;
    _dragMoved = false;
    return;
  }

  if (hadTarget && sourceId && sourceId !== targetId) {
    // Keep the dragged node pinned at its drop coords while the menu is open.
    // Menu actions (or Cancel) decide whether to release it.
    const clientX = e.sourceEvent?.clientX ?? 0;
    const clientY = e.sourceEvent?.clientY ?? 0;
    _showDropMenu(clientX, clientY, { source: sourceId, target: targetId, draggedNode: d });
  } else {
    // No drop target — release the pin and run a *localized* resettle so
    // only nodes near the drop position adjust. Far-away nodes stay frozen
    // (we pin them for the duration of the settle, then unpin).
    const cx = d.x, cy = d.y;
    d.fx = null;
    d.fy = null;
    _localResettle(cx, cy);
    _scheduleLabelLayout(true);
  }

  _dragIsLifted = false;
  _dragSourceId = null;
  _dragMoved = false;
  // _dragTargetId already null after _setDragTargetId(null)
}

function _nodeDomFromId(id) {
  if (!id) return null;
  // <g class="graph-node" data-node-id="..."> wrapper set at render time.
  // CSS.escape (not HTML escape — different rules) for the selector value.
  const cssId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  return document.querySelector(`g.graph-node[data-node-id="${cssId}"]`);
}

function _nodeIdFromDomElement(el) {
  if (!el) return null;
  let n = el;
  while (n && n !== document) {
    if (n.classList && n.classList.contains('graph-node') && n.dataset?.nodeId) return n.dataset.nodeId;
    n = n.parentNode;
  }
  return null;
}

function _setDragTargetId(id) {
  if (_dragTargetId === id) return;
  // Strip highlight from previous target
  if (_dragTargetId) {
    const prev = _nodeDomFromId(_dragTargetId);
    if (prev) prev.classList.remove('node-drag-target');
  }
  _dragTargetId = id;
  if (id) {
    const next = _nodeDomFromId(id);
    if (next) next.classList.add('node-drag-target');
  }
}

let _dragConnectorLine = null;
function _updateDragConnector(sourceNode, targetId, e) {
  try {
    // Append inside the zoomed <g> (parent of gLinks) so the connector shares
    // the same pan/zoom transform as the nodes — otherwise its coords are off
    // by the current zoom offset.
    const parentG = gLinks?.node()?.parentNode;
    if (!parentG) return;
    if (!_dragConnectorLine) {
      const ns = 'http://www.w3.org/2000/svg';
      _dragConnectorLine = document.createElementNS(ns, 'line');
      _dragConnectorLine.setAttribute('stroke', 'var(--accent)');
      _dragConnectorLine.setAttribute('stroke-width', '1.5');
      _dragConnectorLine.setAttribute('stroke-dasharray', '4 3');
      _dragConnectorLine.setAttribute('pointer-events', 'none');
      _dragConnectorLine.setAttribute('opacity', '0');
      parentG.appendChild(_dragConnectorLine);
    }
    // Compute graph coords from the source node + target node (or cursor).
    const sx = sourceNode.x ?? 0;
    const sy = sourceNode.y ?? 0;
    let tx, ty;
    if (targetId) {
      const t = (graphData?.nodes || []).find(n => n.id === targetId);
      if (!t) return;
      tx = t.x ?? 0; ty = t.y ?? 0;
    } else {
      tx = e.x; ty = e.y;
    }
    _dragConnectorLine.setAttribute('x1', sx);
    _dragConnectorLine.setAttribute('y1', sy);
    _dragConnectorLine.setAttribute('x2', tx);
    _dragConnectorLine.setAttribute('y2', ty);
    _dragConnectorLine.setAttribute('opacity', targetId ? '0.95' : '0.4');
  } catch {}
}
function _hideDragConnector() {
  if (_dragConnectorLine) {
    try { _dragConnectorLine.remove(); } catch {}
    _dragConnectorLine = null;
  }
}

// ── Drop menu ────────────────────────────────────────────────────────
// Shown after a drag ends on top of another node. Actions either mutate the
// graph server-side (fast path: link/child) or kick off an agent loop that
// performs a semantic merge (merge).
let _dropMenuState = null;   // { source, target, draggedNode }

function _showDropMenu(clientX, clientY, state) {
  const menu = document.getElementById('graph-drop-menu');
  if (!menu || !state?.source || !state?.target) return;
  _dropMenuState = state;
  const srcEl = menu.querySelector('[data-drop-source]');
  const tgtEl = menu.querySelector('[data-drop-target]');
  if (srcEl) srcEl.textContent = state.source;
  if (tgtEl) tgtEl.textContent = state.target;
  // Position at cursor, clamped to viewport.
  const pad = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(clientX, vw - 260) + 'px';
  menu.style.top = Math.min(clientY, vh - 220) + 'px';
  menu.classList.add('open');
  // Defer the outside-click listener so the mouseup that ended the drag
  // doesn't immediately close the menu.
  setTimeout(() => {
    document.addEventListener('click', _dropMenuOutsideClick, true);
    document.addEventListener('keydown', _dropMenuKey, true);
  }, 0);
}

function _hideDropMenu(releasePinnedNode = true) {
  const menu = document.getElementById('graph-drop-menu');
  if (menu) menu.classList.remove('open');
  document.removeEventListener('click', _dropMenuOutsideClick, true);
  document.removeEventListener('keydown', _dropMenuKey, true);
  if (releasePinnedNode && _dropMenuState?.draggedNode) {
    const d = _dropMenuState.draggedNode;
    d.fx = null;
    d.fy = null;
    _scheduleTickRender();
  }
  _dropMenuState = null;
}

function _dropMenuOutsideClick(e) {
  const menu = document.getElementById('graph-drop-menu');
  if (menu && !menu.contains(e.target)) _hideDropMenu(true);
}
function _dropMenuKey(e) {
  if (e.key === 'Escape') _hideDropMenu(true);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const action = t.getAttribute?.('data-drop-action');
  if (!action) return;
  const state = _dropMenuState;
  if (!state) return;
  e.preventDefault();
  e.stopPropagation();
  if (action === 'cancel') { _hideDropMenu(true); return; }
  _executeDropAction(action, state);
});

async function _executeDropAction(action, state) {
  const { source, target } = state;
  if (action === 'merge') {
    // Pin the source node at drop coords (already pinned); don't release yet.
    // Agent will actually delete it when merge completes. If it fails, the
    // node stays where it was — the operator can drag it back.
    toast(`Merging ${source} into ${target} — agent is working`);
    _hideDropMenu(false);
    try {
      const r = await fetch(API + '/api/graph/merge', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceNodeId: source, targetNodeId: target, mode: 'merge' }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
      // Agent will emit graphEvents as it mutates; viewer updates live.
    } catch (e) {
      toast('Merge kickoff failed: ' + (e.message || e), true);
      // Release the pin and do a localized resettle around the drop point.
      if (state.draggedNode) {
        const cx = state.draggedNode.x, cy = state.draggedNode.y;
        state.draggedNode.fx = null;
        state.draggedNode.fy = null;
        _localResettle(cx, cy);
      }
    }
    return;
  }
  if (action === 'link' || action === 'child') {
    _hideDropMenu(false); // release pin manually below
    // 'link' now routes through the agent (it decides relationship type or
    // declines if unrelated); 'child' is still a fast-path parent_of edge.
    if (action === 'link') {
      toast(`Asking the agent how ${source} relates to ${target}…`);
    }
    try {
      const body = action === 'child'
        ? { sourceNodeId: source, targetNodeId: target, mode: 'child' }
        : { sourceNodeId: source, targetNodeId: target, mode: 'link' };
      const r = await fetch(API + '/api/graph/merge', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
      if (action === 'child') toast(`Moved ${source} under ${target}`);
    } catch (e) {
      toast((action === 'child' ? 'Child link' : 'Link') + ' failed: ' + (e.message || e), true);
    }
    // Release the pin. For 'child', snap the dragged node right next to its
    // new parent so they're visibly stuck together. For 'link', leave it
    // where dropped. Either way, run a localized resettle so neighbours
    // adjust but the far-away graph stays still.
    if (state.draggedNode) {
      if (action === 'child') {
        const parent = (graphData?.nodes || []).find(n => n.id === target);
        if (parent && typeof parent.x === 'number') {
          const pr = parent.radius || 16;
          const cr = state.draggedNode.radius || 16;
          state.draggedNode.x = parent.x + pr + cr + 6;
          state.draggedNode.y = parent.y;
        }
      }
      const cx = state.draggedNode.x, cy = state.draggedNode.y;
      state.draggedNode.fx = null;
      state.draggedNode.fy = null;
      _localResettle(cx, cy);
    }
  }
}

// Event log widget — persistent history, clickable to expand.
// Replaces the old fade-out toast feed. addEventToFeed() keeps the same
// signature so every existing caller works unchanged.
const EVENT_LOG_MAX = 200;
const EVENT_LOG_STORAGE_KEY = 'spore-event-log';
const _eventLog = [];           // { ts, op, detail, source, html }
let _eventLogIdleTimer = null;
let _eventLogSaveTimer = null;

function _eventLogPersist() {
  // Debounced — bursts of 50 events don't hammer localStorage.
  if (_eventLogSaveTimer) return;
  _eventLogSaveTimer = setTimeout(() => {
    _eventLogSaveTimer = null;
    try {
      const plain = _eventLog.map(e => ({ ts: e.ts, op: e.op, detail: e.detail, source: e.source }));
      localStorage.setItem(EVENT_LOG_STORAGE_KEY, JSON.stringify(plain));
    } catch {}
  }, 400);
}

function _eventLogRestore() {
  try {
    const raw = localStorage.getItem(EVENT_LOG_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      _eventLog.push({
        ts: Number(e.ts) || Date.now(),
        op: String(e.op || 'event'),
        detail: String(e.detail || ''),
        source: String(e.source || ''),
        html: null,
      });
    }
    while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  } catch {}
}

function _eventLogFormat(evt) {
  const op = String(evt?.op || 'event');
  const source = String(evt?.source || '');
  let detail = '';
  if (evt?.node?.id) detail = evt.node.id;
  else if (evt?.nodeId) detail = evt.nodeId;
  else if (evt?.edge) detail = `${evt.edge.source} → ${evt.edge.target}`;
  else if (evt?.tool) detail = evt.tool;
  else if (evt?.attributeId) detail = `attr#${evt.attributeId}`;
  return { op, detail, source };
}

// Live stack state — shows up to STACK_MAX rows when events are coming in
// quickly. After STACK_COLLAPSE_MS of quiet it contracts back to the single
// most-recent row so the dock stays compact.
const EVENT_LOG_STACK_MAX = 5;
const EVENT_LOG_COLLAPSE_MS = 3500;
const _eventLogStack = []; // newest last

function _eventLogRowHtml(entry, asIdle = false) {
  if (asIdle) return `<div class="event-log-row idle">idle</div>`;
  const bits = [`<span class="ev-op">${esc(entry.op)}</span>`];
  if (entry.detail) bits.push(`<span class="ev-detail">${esc(entry.detail)}</span>`);
  if (entry.source) bits.push(`<span class="ev-src">${esc(entry.source)}</span>`);
  return `<div class="event-log-row">${bits.join(' ')}</div>`;
}

function _eventLogRenderStack() {
  const stack = document.getElementById('event-log-stack');
  if (!stack) return;
  if (!_eventLogStack.length) {
    stack.innerHTML = _eventLogRowHtml(null, true);
    stack.style.setProperty('--row-count', '1');
    return;
  }
  stack.innerHTML = _eventLogStack.map(e => _eventLogRowHtml(e)).join('');
  // Drive the container's max-height transition via the row count so the
  // stack grows/shrinks smoothly when events fire and when it collapses.
  stack.style.setProperty('--row-count', String(_eventLogStack.length));
}

function _eventLogBumpStack(entry) {
  _eventLogStack.push(entry);
  while (_eventLogStack.length > EVENT_LOG_STACK_MAX) _eventLogStack.shift();
  _eventLogRenderStack();
  const widget = document.getElementById('event-log');
  if (widget) widget.classList.add('has-activity');
  if (_eventLogIdleTimer) clearTimeout(_eventLogIdleTimer);
  _eventLogIdleTimer = setTimeout(() => {
    // Collapse back to just the most recent row + drop the edge animation.
    if (_eventLogStack.length > 1) {
      _eventLogStack.splice(0, _eventLogStack.length - 1);
      _eventLogRenderStack();
    }
    const w = document.getElementById('event-log');
    if (w) w.classList.remove('has-activity');
  }, EVENT_LOG_COLLAPSE_MS);
}

function _eventLogRenderTicker(entry) {
  // Legacy name kept for _eventLogBootstrap. Non-bump render: just set
  // the stack to the single entry (used on initial restore from storage).
  if (!entry) { _eventLogStack.length = 0; _eventLogRenderStack(); return; }
  _eventLogStack.length = 0;
  _eventLogStack.push({ op: entry.op, detail: entry.detail, source: entry.source });
  _eventLogRenderStack();
}

function _eventLogRenderPanel() {
  const list = document.getElementById('event-log-list');
  if (!list) return;
  if (!_eventLog.length) {
    list.innerHTML = '<div class="event-item" style="opacity:.5">(no events yet)</div>';
    return;
  }
  // Newest first. Also memoize the HTML per entry to avoid re-escaping.
  const rows = [];
  for (let i = _eventLog.length - 1; i >= 0; i--) {
    const e = _eventLog[i];
    if (!e.html) {
      const hhmmss = new Date(e.ts).toLocaleTimeString(undefined, { hour12: false });
      e.html = `<div class="event-item" title="${esc(JSON.stringify(e))}">
        <span class="ev-time">${hhmmss}</span>
        <span class="ev-op">${esc(e.op)}</span>
        ${esc(e.detail)}
        ${e.source ? `<span class="ev-src">${esc(e.source)}</span>` : ''}
      </div>`;
    }
    rows.push(e.html);
  }
  list.innerHTML = rows.join('');
}

function addEventToFeed(evt) {
  const formatted = _eventLogFormat(evt);
  const entry = {
    ts: Date.now(),
    op: formatted.op,
    detail: formatted.detail,
    source: formatted.source,
    html: null,
  };
  _eventLog.push(entry);
  while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  _eventLogBumpStack({ op: formatted.op, detail: formatted.detail, source: formatted.source });
  const widget = document.getElementById('event-log');
  if (widget?.classList.contains('open')) _eventLogRenderPanel();
  _eventLogPersist();
}

function _eventLogOpen() {
  const widget = document.getElementById('event-log');
  if (!widget) return;
  widget.classList.add('open');
  widget.setAttribute('aria-expanded', 'true');
  _eventLogRenderPanel();
  document.addEventListener('click', _eventLogOutsideClick, true);
}
function _eventLogClose() {
  const widget = document.getElementById('event-log');
  if (!widget) return;
  widget.classList.remove('open');
  widget.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _eventLogOutsideClick, true);
}
function _eventLogOutsideClick(e) {
  const widget = document.getElementById('event-log');
  if (widget && !widget.contains(e.target)) _eventLogClose();
}
function _eventLogClear() {
  _eventLog.length = 0;
  _eventLogRenderTicker(null);
  _eventLogRenderPanel();
  try { localStorage.removeItem(EVENT_LOG_STORAGE_KEY); } catch {}
}

// Restore persisted log on first evaluation of this block so the ticker
// shows the last known event + the expand-panel has history. Runs right
// after DOM is ready (this script block lives after the elements).
(function _eventLogBootstrap() {
  _eventLogRestore();
  const tick = () => {
    const last = _eventLog[_eventLog.length - 1];
    if (last) _eventLogRenderTicker({ op: last.op, detail: last.detail, source: last.source });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    tick();
  }
})();

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('#event-log-close')) { _eventLogClose(); e.stopPropagation(); return; }
  if (t.closest('#event-log-clear')) { _eventLogClear(); e.stopPropagation(); return; }
  const clickedStack = t.closest('#event-log-stack');
  const widget = document.getElementById('event-log');
  if (clickedStack && widget) {
    if (widget.classList.contains('open')) _eventLogClose();
    else _eventLogOpen();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const widget = document.getElementById('event-log');
  if (document.activeElement !== widget) return;
  e.preventDefault();
  if (widget.classList.contains('open')) _eventLogClose();
  else _eventLogOpen();
});

// ── Graph Performance Helpers ──
function _scheduleTickRender() {
  if (_tickScheduled) return;
  _needsTick = true;
  _tickScheduled = true;
  requestAnimationFrame(_renderTick);
}

function _renderTick() {
  _tickScheduled = false;
  if (!_needsTick) return;
  _needsTick = false;

  const linkEls = gLinks.node().children;
  for (let i = 0, len = linkEls.length; i < len; i++) {
    const el = linkEls[i];
    const d = el.__data__;
    if (!d || !d.source || !d.target) continue;
    const dx = d.target.x - d.source.x;
    const dy = d.target.y - d.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const tr = (d.target.radius || 12) + 2;
    el.setAttribute('x1', d.source.x);
    el.setAttribute('y1', d.source.y);
    el.setAttribute('x2', d.target.x - dx * tr / dist);
    el.setAttribute('y2', d.target.y - dy * tr / dist);
  }

  const nodeEls = gNodes.node().children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const el = nodeEls[i];
    const d = el.__data__;
    if (!d) continue;
    el.setAttribute('transform', `translate(${d.x},${d.y})`);
  }

  _scheduleLabelLayout();
}

function _updateNodeLabelVisibility(scale = _currentZoomScale) {
  if (!gNodes || !svg) return;
  const nodeLayer = gNodes.node();
  if (!nodeLayer) return;
  const nodeEls = Array.from(nodeLayer.children);
  if (!nodeEls.length) return;

  const svgNode = svg.node();
  const centerX = (svgNode?.clientWidth || window.innerWidth) / 2;
  const centerY = (svgNode?.clientHeight || window.innerHeight) / 2;
  const nodes = nodeEls.map((el) => ({
    data: el.__data__,
    labelEl: el.querySelector('text.node-label'),
    subEl:   el.querySelector('text.node-sub-label'),
  })).filter((entry) => entry.data && entry.labelEl);

  // Only show as many labels as the current zoom can support without
  // visual collision pile-up. Importance-ranked: most important nodes first,
  // hovered/selected always shown.
  const budget = _autoLabelBudget(scale, nodes.length);
  const opacity = _autoLabelOpacity(scale);

  const ranked = nodes.slice().sort((a, b) => {
    const ia = a.data.importance || 0;
    const ib = b.data.importance || 0;
    if (ib !== ia) return ib - ia;
    // Tiebreak by mention count, then by id for stability
    const ma = a.data.mentions || 0, mb = b.data.mentions || 0;
    if (mb !== ma) return mb - ma;
    return String(a.data.id).localeCompare(String(b.data.id));
  });

  const visible = new Set();
  for (let i = 0; i < Math.min(budget, ranked.length); i++) {
    visible.add(ranked[i].data.id);
  }
  if (hoveredNodeId) visible.add(hoveredNodeId);
  if (selectedNodeIds && selectedNodeIds.size) {
    for (const id of selectedNodeIds) visible.add(id);
  }

  for (const entry of nodes) {
    if (visible.has(entry.data.id)) {
      const placement = _preferredLabelPlacement(entry.data, centerX, centerY);
      _setLabelPlacement(entry.labelEl, placement);
      _setLabelVisible(entry.labelEl, opacity);
      // Stack the mono uppercase sub-label one line below the name with
      // matching anchor + baseline. ~1em (12px) below.
      if (entry.subEl) {
        entry.subEl.setAttribute('x', placement.attrs.x);
        entry.subEl.setAttribute('y', Number(placement.attrs.y) + 12);
        entry.subEl.setAttribute('text-anchor', placement.attrs.anchor);
        entry.subEl.setAttribute('dominant-baseline', placement.attrs.baseline);
        entry.subEl.style.opacity = String(Math.max(0, Math.min(1, opacity * 0.85)));
      }
    } else {
      _setLabelHidden(entry.labelEl);
      if (entry.subEl) entry.subEl.style.opacity = '0';
    }
  }
}

function _applySemanticZoom(scale) {
  if (!gNodes) return;
  const showGlyphs = scale > 0.14;
  const showArrows = scale > 0.25;
  const nodeEls = gNodes.node().children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const glyphEl = nodeEls[i].querySelector('text.node-glyph');
    if (glyphEl) glyphEl.style.display = showGlyphs ? '' : 'none';
  }
  _scheduleLabelLayout();
  if (gLinks) {
    const lines = gLinks.node().children;
    const markerVal = showArrows ? 'url(#arrowhead)' : '';
    for (let i = 0, len = lines.length; i < len; i++) {
      if (lines[i].getAttribute('marker-end') !== markerVal) {
        lines[i].setAttribute('marker-end', markerVal);
      }
    }
  }
}

// ── Graph Visualization ──
function initGraph(data) {
  graphData = data;
  const canvasEl = document.getElementById('canvas');
  const width = canvasEl.clientWidth;
  const height = canvasEl.clientHeight;
  const nodeCount = data.nodes.length;
  const profile = _graphForceProfile(nodeCount);

  svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
    .attr('refX', 10).attr('refY', 0).attr('markerWidth', 4).attr('markerHeight', 4)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L10,0L0,4');

  // Backdrop from design_handoff_node_graph: a 24×24 dotted grid plus a
  // soft radial vignette darkening the corners. Sits behind the zoomable
  // group so neither moves/scales with pan-zoom — keeps the canvas
  // grounded at any zoom level. Plus mono corner-tick labels (0,0 / W,0 /
  // 0,H) for a "field notebook" feel.
  const gridPat = defs.append('pattern')
    .attr('id', 'graph-grid-dots')
    .attr('width', 24).attr('height', 24)
    .attr('patternUnits', 'userSpaceOnUse');
  gridPat.append('circle')
    .attr('cx', 0.6).attr('cy', 0.6).attr('r', 0.6)
    .attr('fill', 'var(--graph-hair, var(--border-subtle))');
  const vignette = defs.append('radialGradient')
    .attr('id', 'graph-vignette')
    .attr('cx', '50%').attr('cy', '50%').attr('r', '60%');
  vignette.append('stop').attr('offset', '55%').attr('stop-color', 'rgba(0,0,0,0)');
  vignette.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(0,0,0,0.045)');
  svg.append('rect')
    .attr('class', 'graph-grid-bg')
    .attr('x', 0).attr('y', 0)
    .attr('width', '100%').attr('height', '100%')
    .attr('fill', 'url(#graph-grid-dots)')
    .attr('opacity', 0.7)
    .attr('pointer-events', 'none');
  svg.append('rect')
    .attr('class', 'graph-vignette-bg')
    .attr('x', 0).attr('y', 0)
    .attr('width', '100%').attr('height', '100%')
    .attr('fill', 'url(#graph-vignette)')
    .attr('pointer-events', 'none');

  const g = svg.append('g');

  zoom = d3.zoom()
    .filter(e => {
      if (_isMarqueeGesture(e)) return false;
      return (!e.ctrlKey || e.type === 'wheel') && !e.button;
    })
    .scaleExtent([0.1, 8]).on('zoom', e => {
    g.attr('transform', e.transform);
    const newScale = e.transform.k;
    if (Math.abs(newScale - _currentZoomScale) > 0.05 || (newScale < 0.4) !== (_currentZoomScale < 0.4)) {
      _currentZoomScale = newScale;
      _applySemanticZoom(newScale);
    }
  });
  svg.call(zoom);

  _selectionRect = svg.append('rect')
    .attr('class', 'graph-selection-rect')
    .style('display', 'none');

  gLinks = g.append('g').attr('class', 'links');
  gNodes = g.append('g').attr('class', 'nodes');

  const nodeMap = {};
  data.nodes.forEach(n => { nodeMap[n.id] = n; n.radius = _computeNodeRadius(n); });
  hoveredNodeId = nodeMap[hoveredNodeId] ? hoveredNodeId : null;
  simLinks = data.edges.filter(e => nodeMap[e.source] && nodeMap[e.target]).map(e => ({...e}));

  // Place each node inside its type's anchor cell BEFORE the simulation starts.
  _seedNodesByType(data.nodes, width, height);

  // Per-node anchors: each node gets pulled toward its TYPE's grid cell, not
  // toward viewport center. No global forceCenter / global axis forces — they
  // would fight the per-type pull and produce a "smear" instead of clusters.
  const _typeAnchors = _typeClusterAnchors(data.nodes, width, height);
  const _anchorX = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.x ?? width / 2);
  const _anchorY = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.y ?? height / 2);

  simulation = d3.forceSimulation(data.nodes)
    // Weak link strength so cross-type edges don't drag nodes out of their
    // treemap rect. Edges are still drawn; they just don't dominate layout.
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(l => l.type === 'parent_of' ? 28 : profile.linkDistance)
      .strength(l => l.type === 'parent_of' ? 0.95 : profile.linkStrength))
    // Charge limited to local range so a far-away node never throws another
    // node out of its cluster. Without distanceMax, a 300-node graph means
    // every node feels every other → instant scattering of pre-seeded clusters.
    .force('charge', d3.forceManyBody().strength(profile.chargeStrength).theta(profile.chargeTheta).distanceMax(profile.chargeMaxDist))
    .force('clusterX', d3.forceX(_anchorX).strength(profile.clusterStrength))
    .force('clusterY', d3.forceY(_anchorY).strength(profile.clusterStrength))
    .force('collision', _createLabelBoxCollide().strength(1.0).padding(4).iterations(profile.collisionIterations + 1))
    .velocityDecay(profile.velocityDecay)
    .on('tick', _scheduleTickRender);

  // Pre-bake synchronously: tick until alpha is low enough that visible motion
  // is invisible, capped by a wall-clock budget so the page never freezes.
  // Then PARK the simulation (alpha below alphaMin) so it stays still until
  // user interaction (drag) explicitly restarts it.
  {
    simulation.stop();
    const bakeBudget = 700; // ms hard cap
    const start = performance.now();
    let ticked = 0;
    while (simulation.alpha() > 0.003 && ticked < 800) {
      simulation.tick();
      ticked++;
      if ((ticked & 15) === 0 && (performance.now() - start) > bakeBudget) break;
    }
    simulation.alpha(0.0009); // < default alphaMin (0.001) — parks the timer
  }

  // Stroke color comes from the CSS rule (#graph-svg g.links line) so it
  // resolves --text correctly per active theme. SVG presentation
  // attributes don't expand var(), so setting it inline here would
  // produce a literal "var(--text)" string and fall back to black.
  const link = gLinks.selectAll('line').data(simLinks).join('line')
    .attr('marker-end', 'url(#arrowhead)')
    .attr('data-edge-kind', d => getEdgeKind(d))
    .attr('stroke-linecap', 'round')
    .attr('stroke-width', d => EDGE_KIND[getEdgeKind(d)].width)
    .attr('stroke-opacity', d => EDGE_KIND[getEdgeKind(d)].opacity)
    .attr('stroke-dasharray', d => EDGE_KIND[getEdgeKind(d)].dash || null);

  const nodeG = gNodes.selectAll('g').data(data.nodes, d => d.id).join('g')
    .classed('graph-node', true)
    .attr('data-node-id', d => d.id)
    .call(_nodeDragBehavior())
    .on('click', (e, d) => {
      e.stopPropagation();
      if (_suppressNextGraphClick) {
        _suppressNextGraphClick = false;
        return;
      }
      hideGraphContextMenu();
      selectNode(d);
    })
    .on('dblclick', (e, d) => {
      e.stopPropagation();
      e.preventDefault();
      _focusGraphOnNode(d.id);
    })
    .on('mouseenter', (_, d) => _setHoveredNode(d.id))
    .on('mouseleave', (_, d) => {
      if (hoveredNodeId === d.id) _setHoveredNode(null);
    });

  _upsertNodeVisuals(nodeG);

  svg.on('mousedown.marquee', (e) => _beginGraphMarquee(e));
  svg.on('contextmenu.graphmenu', (e) => {
    const nodeEl = e.target.closest('g.graph-node');
    const node = nodeEl?.__data__ || null;

    if (node) {
      if (!selectedNodeIds.has(node.id) || selectedNodeIds.size !== 1) {
        _setGraphSelection([node.id]);
      }
    } else if (!selectedNodeIds.size) {
      hideGraphContextMenu();
      return;
    }

    if (!selectedNodeIds.size) return;
    e.preventDefault();
    e.stopPropagation();
    showGraphContextMenu(e.clientX, e.clientY);
  });
  svg.on('click', () => {
    if (_suppressNextGraphClick) {
      _suppressNextGraphClick = false;
      return;
    }
    if (_graphFocusedId) { _unfocusGraph(); return; }
    clearGraphSelection();
  });

  // Populate filter
  const types = [...new Set(data.nodes.map(n => n.type))].sort();
  const filterEl = document.getElementById('filter-type');
  filterEl.innerHTML = '<option value="">all types</option>';
  types.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; filterEl.appendChild(o); });

  updateStats();
  _restoreGraphSelection();
  _applySemanticZoom(_currentZoomScale);
  _scheduleTickRender();
}

// ── Node Selection / Editor Panel ──
function selectNode(node) {
  _setGraphSelection([node.id], { panelNode: node });
}

// Focus mode: hide everything except the given node + its direct neighbors,
// then fit-to-view. Click background to restore.
function _focusGraphOnNode(nodeId) {
  if (!gNodes || !gLinks || !graphData) return;
  const neighbors = new Set([nodeId]);
  for (const e of (graphData.edges || [])) {
    const s = e.source?.id || e.source;
    const t = e.target?.id || e.target;
    if (s === nodeId) neighbors.add(t);
    if (t === nodeId) neighbors.add(s);
  }
  _graphFocusedId = nodeId;
  _graphPreFocusTransform = svg ? d3.zoomTransform(svg.node()) : null;

  gNodes.selectAll('g')
    .attr('opacity', d => neighbors.has(d.id) ? 1 : 0)
    .style('pointer-events', d => neighbors.has(d.id) ? '' : 'none');
  gLinks.selectAll('line')
    .attr('opacity', d => {
      const s = d.source.id || d.source;
      const t = d.target.id || d.target;
      return (s === nodeId || t === nodeId) ? 1 : 0;
    });

  // Add edge-type labels along visible edges, oriented in the source→target direction.
  const innerG = d3.select(gNodes.node().parentNode);
  let labelsG = innerG.select('g.focus-edge-labels');
  if (labelsG.empty()) labelsG = innerG.append('g').attr('class', 'focus-edge-labels');
  const visibleEdges = (typeof simLinks !== 'undefined' ? simLinks : []).filter(d => {
    const s = d.source?.id || d.source;
    const t = d.target?.id || d.target;
    return s === nodeId || t === nodeId;
  });
  labelsG.selectAll('text').data(visibleEdges).join('text')
    .attr('class', 'focus-edge-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .text(d => d.type || 'related')
    .attr('transform', d => {
      const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
      const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      let deg = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI;
      // Keep text upright — flip if reading direction would be upside down
      if (deg > 90 || deg < -90) deg += 180;
      // Lift the label slightly off the line (perpendicular offset)
      const perpAngle = (deg + 90) * Math.PI / 180;
      const lift = 9;
      const ox = Math.cos(perpAngle) * lift;
      const oy = Math.sin(perpAngle) * lift;
      return `translate(${mx + ox},${my + oy}) rotate(${deg})`;
    });

  const visible = (graphData.nodes || []).filter(n => neighbors.has(n.id) && Number.isFinite(n.x) && Number.isFinite(n.y));
  if (visible.length && svg && zoom) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of visible) {
      const r = (n.radius || 12) + 30; // include label area
      if (n.x - r < minX) minX = n.x - r;
      if (n.x + r > maxX) maxX = n.x + r;
      if (n.y - r < minY) minY = n.y - r;
      if (n.y + r > maxY) maxY = n.y + r;
    }
    const w = svg.node().clientWidth || window.innerWidth;
    const h = svg.node().clientHeight || window.innerHeight;
    const pad = 60;
    const sx = (w - pad * 2) / Math.max(40, maxX - minX);
    const sy = (h - pad * 2) / Math.max(40, maxY - minY);
    const scale = Math.max(0.4, Math.min(2.2, Math.min(sx, sy)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tx = w / 2 - cx * scale;
    const ty = h / 2 - cy * scale;
    svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }
}

function _unfocusGraph() {
  if (!_graphFocusedId) return;
  _graphFocusedId = null;
  if (gNodes) gNodes.selectAll('g').attr('opacity', 1).style('pointer-events', '');
  if (gLinks) gLinks.selectAll('line').attr('opacity', 1);
  if (gNodes) {
    const innerG = d3.select(gNodes.node().parentNode);
    innerG.select('g.focus-edge-labels').remove();
  }
  if (svg && zoom && _graphPreFocusTransform) {
    svg.transition().duration(450).call(zoom.transform, _graphPreFocusTransform);
  }
  _graphPreFocusTransform = null;
}

function closePanel() {
  clearGraphSelection();
}

// ── Token Dashboard ──
async function renderTokenDashboard(body) {
  body.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;padding:8px 0">Loading token data…</div>';
  let data;
  try {
    const res = await fetch(API + '/api/tokens');
    data = await res.json();
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  if (data.error) {
    body.innerHTML = `<div style="color:var(--text-dim);font-size:0.8rem;padding:8px 0">${esc(data.error)}</div>`;
    return;
  }

  function fmtN(n) { return (n||0).toLocaleString(); }
  function fmtCost(c) { return c == null ? '—' : `$${parseFloat(c).toFixed(4)}`; }

  function statCard(label, input, output, calls, cost) {
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-family:var(--font-body);font-size:0.8rem">
        <div><span style="color:var(--text-dim)">in </span><span style="color:var(--accent2)">${fmtN(input)}</span></div>
        <div><span style="color:var(--text-dim)">out </span><span style="color:var(--accent3)">${fmtN(output)}</span></div>
        <div><span style="color:var(--text-dim)">calls </span><span style="color:var(--text)">${fmtN(calls)}</span></div>
        <div><span style="color:var(--text-dim)">est. </span><span style="color:var(--warn)">${fmtCost(cost)}</span></div>
      </div>
    </div>`;
  }

  const daily = (data.daily || []).slice(0, 14).reverse();
  const maxTotal = Math.max(...daily.map(d => (d.input||0) + (d.output||0)), 1);
  const barChart = daily.length ? `
    <div class="section">
      <div class="section-title">Last 14 Days</div>
      <div style="display:flex;align-items:flex-end;gap:3px;height:60px;padding:4px 0">
        ${daily.map(d => {
          const total = (d.input||0) + (d.output||0);
          const pct = Math.max(2, Math.round((total / maxTotal) * 56));
          const day = d.date.slice(5);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
            <div title="${day}: ${fmtN(total)} tokens, ${d.calls} calls, est. ${fmtCost(d.totalCost)}"
              style="width:100%;height:${pct}px;background:var(--accent2);border-radius:2px 2px 0 0;opacity:0.75;cursor:default"></div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-dim);font-family:var(--font-body);margin-top:2px">
        <span>${daily[0]?.date.slice(5)||''}</span>
        <span>${daily[daily.length-1]?.date.slice(5)||''}</span>
      </div>
    </div>` : '';

  const channelRows = Object.entries(data.byChannel || {})
    .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
  const channelTable = channelRows.length ? `
    <div class="section">
      <div class="section-title">By Channel (all time)</div>
      <table style="width:100%;font-size:0.75rem;font-family:var(--font-body);border-collapse:collapse">
        <thead><tr style="color:var(--text-dim);font-size:0.65rem">
          <th style="text-align:left;padding:3px 0">channel</th>
          <th style="text-align:right">in</th>
          <th style="text-align:right">out</th>
          <th style="text-align:right">calls</th>
        </tr></thead>
        <tbody>
          ${channelRows.map(([ch, s]) => `<tr style="border-top:1px solid var(--border)">
            <td style="padding:4px 0;color:var(--text-dim)">${ch}</td>
            <td style="text-align:right;color:var(--accent2)">${fmtN(s.input)}</td>
            <td style="text-align:right;color:var(--accent3)">${fmtN(s.output)}</td>
            <td style="text-align:right">${fmtN(s.calls)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const rates = data.costRates || {};

  body.innerHTML = `
    <div style="font-size:0.65rem;color:var(--text-dim);font-family:var(--font-body);margin-bottom:12px">
      est. @ $${rates.inputPerM}/M in · $${rates.outputPerM}/M out (Sonnet pricing)
    </div>
    <div class="section">
      <div class="section-title">Usage</div>
      ${statCard('Today',     data.today?.input,          data.today?.output,          data.today?.calls,          data.today?.totalCost)}
      ${statCard('Yesterday', data.yesterday?.input,      data.yesterday?.output,      data.yesterday?.calls,      data.yesterday?.totalCost)}
      ${statCard('7 days',    data.windows?.['7d']?.input, data.windows?.['7d']?.output, data.windows?.['7d']?.calls, data.windows?.['7d']?.totalCost)}
      ${statCard('30 days',   data.windows?.['30d']?.input, data.windows?.['30d']?.output, data.windows?.['30d']?.calls, data.windows?.['30d']?.totalCost)}
      ${statCard('All time',  data.windows?.allTime?.input, data.windows?.allTime?.output, data.windows?.allTime?.calls, data.windows?.allTime?.totalCost)}
    </div>
    ${barChart}
    ${channelTable}
  `;
}

// ── Editor Panel Rendering ──
function renderPanel(node) {
  document.querySelector('#panel-title h2').textContent = node.label;
  document.querySelector('#panel-title .node-type').textContent = node.type;
  document.querySelector('#panel-title .node-type').style.color = getColor(node.type);

  const body = document.getElementById('panel-body');

  if (node.id === 'spore-token-log') {
    renderTokenDashboard(body);
    return;
  }

  const outEdges = graphData.edges.filter(e => (e.source.id || e.source) === node.id);
  const inEdges = graphData.edges.filter(e => (e.target.id || e.target) === node.id);

  body.innerHTML = `
    <div class="section">
      <div class="section-title">Identity</div>
      <div class="field"><label>ID</label><input id="edit-id" value="${esc(node.id)}" disabled></div>
      <div class="field"><label>Label</label><input id="edit-label" value="${esc(node.label)}"></div>
      <div class="field"><label>Type</label>
        <select id="edit-type">
          ${[...new Set(['self','person','channel','concept','rule','project','tool','memory','skill','capability',
            'preference','event','organization','topic','location','group','interest','emotion','belief','relationship',
            ...(node.type && !['self','person','channel','concept','rule','project','tool','memory','skill','capability',
            'preference','event','organization','topic','location','group','interest','emotion','belief','relationship'].includes(node.type) ? [node.type] : [])])
          ].map(t => `<option value="${t}" ${t===node.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Description</label><textarea id="edit-desc" rows="3">${esc(node.description)}</textarea></div>
      <div class="field"><label>Importance (1-10)</label><input type="number" id="edit-imp" min="1" max="10" value="${node.importance||5}"></div>
      <div class="btn-row">
        <button class="btn btn-save" data-action="save-node">save node</button>
        <button class="btn btn-danger" data-action="delete-node" data-id="${escAttr(node.id)}">delete</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Aspects <button data-action="new-aspect" data-node-id="${escAttr(node.id)}">+ add</button></div>
      <div id="aspects-list">
        ${(node.aspects||[]).map((a, i) => `
          <div class="aspect-card" data-aspect-idx="${i}">
            <div class="aspect-header">
              <span class="aspect-name">${esc(a.name)}</span>
              <span class="aspect-weight">w:${a.weight||5}
                <button class="btn btn-danger" style="font-size:0.55rem;padding:1px 5px;margin-left:6px"
                  data-action="delete-aspect" data-node-id="${escAttr(node.id)}" data-name="${escAttr(a.name)}" data-aspect-id="${a.id||0}">×</button>
              </span>
            </div>
            ${(a.attributes||[]).map(at => {
              const atId = at.id || 0;
              const atContent = typeof at === 'string' ? at : at.content;
              return `
              <div class="attr-item" style="display:flex;align-items:start;gap:4px;group">
                <span class="attr-text" style="flex:1;cursor:pointer" data-action="edit-attr" data-attr-id="${atId}"
                  data-node-id="${escAttr(node.id)}" data-aspect-name="${escAttr(a.name)}" data-weight="${a.weight||5}"
                  title="Click to edit">${esc(atContent)}</span>
                ${at.eventDate ? `<span class="attr-date" style="font-family:var(--font-body);font-size:0.55rem;color:var(--accent2);white-space:nowrap;flex-shrink:0">${esc(at.eventDate)}</span>` : ''}
                ${at.importance ? `<span class="attr-importance"> (${at.importance})</span>` : ''}
                ${atId ? `<button class="btn btn-danger" style="font-size:0.5rem;padding:0px 4px;flex-shrink:0;opacity:0.5"
                  data-action="delete-attr" data-attr-id="${atId}" title="Delete attribute">×</button>` : ''}
              </div>`;
            }).join('')}
            <div style="margin-top:8px">
              <input placeholder="add attribute..." style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:0.75rem"
                data-action="add-attr" data-node-id="${escAttr(node.id)}" data-name="${escAttr(a.name)}" data-weight="${a.weight||5}">
            </div>
          </div>
        `).join('') || '<div style="color:var(--text-dim);font-size:0.8rem">No aspects</div>'}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Edges <button data-action="new-edge" data-node-id="${escAttr(node.id)}">+ add</button></div>
      ${outEdges.map(e => `
        <div class="edge-item">
          <span class="edge-type">${esc(e.type)}</span>
          <span>→</span>
          <span class="edge-target" data-action="navigate" data-id="${escAttr(e.target.id||e.target)}">${esc(getNodeLabel(e.target))}</span>
          <button class="btn btn-danger" style="font-size:0.5rem;padding:1px 4px;margin-left:auto"
            data-action="delete-edge" data-source="${escAttr(e.source.id||e.source)}" data-target="${escAttr(e.target.id||e.target)}" data-type="${escAttr(e.type)}">×</button>
        </div>
      `).join('')}
      ${inEdges.map(e => `
        <div class="edge-item">
          <span class="edge-target" data-action="navigate" data-id="${escAttr(e.source.id||e.source)}">${esc(getNodeLabel(e.source))}</span>
          <span>→</span>
          <span class="edge-type">${esc(e.type)}</span>
          <span>→ this</span>
        </div>
      `).join('')}
      ${(!outEdges.length && !inEdges.length) ? '<div style="color:var(--text-dim);font-size:0.8rem">No edges</div>' : ''}
    </div>

    <div class="section">
      <div class="section-title">Aliases</div>
      <div style="color:var(--text-dim);font-size:0.8rem">
        ${(node.aliases||[]).map(a => esc(a)).join(', ') || 'none'}
      </div>
    </div>
  `;
}

// ── Helpers ──
function esc(s) {
  if (!s) return '';
  const str = typeof s === 'object' ? (s.id || String(s)) : String(s);
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s) {
  return esc(s).replace(/\\/g,'\\\\');
}

function getNodeLabel(ref) {
  const id = ref.id || ref;
  const n = graphData.nodes.find(n => n.id === id);
  return n ? n.label : id;
}

function navigateNode(id) {
  const n = graphData.nodes.find(n => n.id === id);
  if (n) selectNode(n);
}

// ── CRUD Operations ──
async function doSaveNode() {
  const data = {
    id: document.getElementById('edit-id').value,
    label: document.getElementById('edit-label').value,
    type: document.getElementById('edit-type').value,
    description: document.getElementById('edit-desc').value,
    importance: parseInt(document.getElementById('edit-imp').value) || 5,
  };
  try {
    await saveNode(data);
    const n = graphData.nodes.find(n => n.id === data.id);
    if (n) { Object.assign(n, data); selectNode(n); }
    toast('Node saved');
  } catch (e) { toast('Save failed: ' + e.message, true); }
}

async function doDeleteNode(id) {
  if (!confirm('Delete node "' + id + '" and all its aspects/edges?')) return;
  try {
    hideGraphContextMenu();
    await deleteNode(id);
    toast('Node deleted');
    closePanel();
    reload();
  } catch (e) { toast('Delete failed: ' + e.message, true); }
}

async function doDeleteSelectedNodes() {
  const ids = [...selectedNodeIds];
  if (!ids.length) return;

  const label = ids.length === 1
    ? `Delete node "${ids[0]}" and all its aspects/edges?`
    : `Delete ${ids.length} selected nodes and all their aspects/edges?`;
  if (!confirm(label)) return;

  hideGraphContextMenu();

  const failures = [];
  for (const id of ids) {
    try {
      await deleteNode(id);
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
    }
  }

  clearGraphSelection();
  await reload();

  if (!failures.length) {
    toast(ids.length === 1 ? 'Node deleted' : `${ids.length} nodes deleted`);
  } else {
    const successCount = ids.length - failures.length;
    toast(`Deleted ${successCount}/${ids.length} nodes. ${failures[0]}`, true);
  }
}

async function doDeleteAspect(nodeId, name, aspectId) {
  if (!aspectId) {
    const node = graphData.nodes.find(n => n.id === nodeId);
    const aspect = node?.aspects?.find(a => a.name === name);
    aspectId = aspect?.id;
  }
  if (aspectId) {
    try { await deleteAspect(aspectId); toast('Aspect deleted'); reload(); }
    catch (e) { toast('Failed: ' + e.message, true); }
  } else {
    await saveAspect({ nodeId, name, weight: 0, attributes: [] });
    toast('Aspect cleared'); reload();
  }
}

async function doNewAspect(nodeId) {
  const name = prompt('Aspect name (e.g. personality, interests, preferences):');
  if (!name) return;
  const content = prompt('First attribute (a fact or detail):');
  try {
    await saveAspect({ nodeId, name, weight: 7, attributes: content ? [{ content, importance: 7 }] : [] });
    toast('Aspect added');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doAddAttr(nodeId, aspectName, inputEl, weight) {
  const content = inputEl.value.trim();
  if (!content) return;
  const res = await fetch(API + '/api/graph');
  const fresh = await res.json();
  const node = fresh.nodes.find(n => n.id === nodeId);
  const aspect = node?.aspects?.find(a => a.name === aspectName);
  const existingAttrs = aspect?.attributes || [];
  existingAttrs.push({ content, importance: 7 });
  try {
    await saveAspect({ nodeId, name: aspectName, weight, attributes: existingAttrs });
    toast('Attribute added');
    inputEl.value = '';
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doDeleteAttr(attrId) {
  if (!attrId) return;
  try {
    await deleteAttribute(attrId);
    toast('Attribute deleted');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doEditAttr(attrId, el) {
  if (!attrId) return;
  const currentText = el.textContent.trim();
  const newText = prompt('Edit attribute:', currentText);
  if (newText === null || newText.trim() === currentText) return;
  if (!newText.trim()) {
    await doDeleteAttr(attrId);
    return;
  }
  try {
    await updateAttribute(attrId, { content: newText.trim(), importance: 7 });
    toast('Attribute updated');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doNewEdge(sourceId) {
  const target = prompt('Target node ID:');
  if (!target) return;
  const type = prompt('Relationship type (e.g. knows, uses, created):');
  if (!type) return;
  try {
    await saveEdge({ source: sourceId, target, type, weight: 1 });
    toast('Edge added');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doDeleteEdge(source, target, type) {
  try {
    await deleteEdge({ source, target, type });
    toast('Edge removed');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function reload() {
  const data = await fetchGraph();
  // Incremental merge when the graph is already running — preserves the
  // user's current zoom + pan + force layout. Full initGraph wipes the SVG
  // (including the zoom transform) which feels like the camera "jumping"
  // every time you delete a node or aspect.
  if (simulation) {
    mergeGraph(data, { newNodes: new Set(), pulseNodes: new Set(), newEdges: [] });
  } else {
    initGraph(data);
  }
}

function showNewNodeModal() {
  const id = prompt('Node ID (lowercase-hyphenated, e.g. "my-concept"):');
  if (!id) return;
  const label = prompt('Label (display name):');
  if (!label) return;
  const type = prompt('Type (person, concept, project, rule, channel, etc.):') || 'concept';
  saveNode({ id, label, type, description: '', importance: 5 })
    .then(() => { toast('Node created'); reload(); })
    .catch(e => toast('Failed: ' + e.message, true));
}

// ── Delegated Event Handlers ──
document.getElementById('panel-body')?.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'save-node') doSaveNode();
  else if (action === 'delete-node') doDeleteNode(el.dataset.id);
  else if (action === 'delete-aspect') doDeleteAspect(el.dataset.nodeId, el.dataset.name, parseInt(el.dataset.aspectId));
  else if (action === 'new-aspect') doNewAspect(el.dataset.nodeId);
  else if (action === 'new-edge') doNewEdge(el.dataset.nodeId);
  else if (action === 'delete-edge') doDeleteEdge(el.dataset.source, el.dataset.target, el.dataset.type);
  else if (action === 'navigate') navigateNode(el.dataset.id);
  else if (action === 'delete-attr') doDeleteAttr(parseInt(el.dataset.attrId));
  else if (action === 'edit-attr') doEditAttr(parseInt(el.dataset.attrId), el);
});
document.getElementById('panel-body')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-action="add-attr"]');
  if (!el) return;
  doAddAttr(el.dataset.nodeId, el.dataset.name, el, parseInt(el.dataset.weight));
});

// ── Top-level Controls ──
// panel-close handled by rp-close
document.getElementById('btn-center').onclick = () => {
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
};
document.getElementById('btn-new-node').onclick = showNewNodeModal;
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


