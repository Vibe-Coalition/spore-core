// onboarding.js — First-run wizard (operator + user variants).
// Extracted from src/static/scripts/app.js (was lines 2019-3386 of the post-Phase-2 monolith).

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

