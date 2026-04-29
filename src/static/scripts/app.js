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


