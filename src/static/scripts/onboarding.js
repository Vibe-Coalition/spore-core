// onboarding.js — First-run wizard (operator + user variants).
// Extracted from src/static/scripts/app.js (was lines 2019-3386 of the post-Phase-2 monolith).

// ── First-run onboarding wizard ────────────────────────────────────────
// Two modes share the same overlay infrastructure:
//   'operator' — the long wizard run on a fresh instance
//   'user'     — the slim 4-step wizard a self-registered guest sees
const OB_STEP_MAP = {
  // Order: welcome → theme → identity → account → provider TYPE picker
  // → provider config (keys + test) → models → agent effort → vlm →
  // embeddings → voice/search → browser → Spore Code → channels →
  // extra plugins.
  operator: ['1', '2', '3', '4', 'pp', '5', '6', 'a', '7', 'e', '8', '9', 'c', 'ch', 'p'],
  user: ['1', '2', 'u3', 'u4'],
};

// Provider tile ↔ plugin id maps. Populated at runtime by
// _obLoadProviderTiles from /api/onboarding/plugins (which tags each
// plugin's `provider` block when registerProvider was called). This
// replaces the hardcoded list — adding a provider plugin (with
// registerSettingsPane + registerProvider) makes its tile appear in
// step 'pp' automatically.
let OB_PROVIDER_PLUGIN_MAP = {}; // pluginId → tile.id (== provider name)
let OB_TILE_TO_PLUGIN = {};      // tile.id → pluginId
const OB_OPTIONAL_BY_MODE = {
  operator: new Set([8, 10, 12]),
  user: new Set(),
};
const OB_OPTIONAL_KEYS_BY_MODE = {
  operator: new Set(['7', '8', 'c', 'ch']),
  user: new Set(),
};
let _obMode = 'operator';
function _obStepCount() { return OB_STEP_MAP[_obMode].length; }
function _obIsOptional(n) {
  const key = OB_STEP_MAP[_obMode]?.[n - 1];
  return !!(OB_OPTIONAL_KEYS_BY_MODE[_obMode]?.has(key) || OB_OPTIONAL_BY_MODE[_obMode]?.has(n));
}
// Legacy aliases — code below still references these names in places.
const OB_TOTAL_STEPS = 15; // upper bound; effective count is _obStepCount()
const OB_OPTIONAL_STEPS = OB_OPTIONAL_BY_MODE.operator;
let _obStep = 1;
let _obData = { theme: 'dark', providers: {}, agentEffort: 'balanced', enhancedRecall: false };

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
  // Load the provider tile list dynamically from registered provider
  // plugins BEFORE any step renders. Async but step 1 doesn't reference
  // provider data, so it's safe to fire-and-forget — by the time the
  // operator clicks through to step 'pp' the tiles are populated.
  // Re-renders happen automatically when _obShowStep('pp') runs.
  _obLoadProviderTiles().catch(() => {});
  _obRenderDots();
  _obRenderThemeGrid();
  _obRenderProvidersList();
  _obShowStep(1);
  const cached = localStorage.getItem('spore-theme');
  if (cached && THEMES[cached]) _obPickTheme(cached);
  if (!startOnboarding._bound) {
    startOnboarding._bound = true;
    document.getElementById('ob-next')?.addEventListener('click', _obNext);
    document.getElementById('ob-back')?.addEventListener('click', _obBack);
    document.getElementById('ob-skip')?.addEventListener('click', _obSkip);
    document.getElementById('ob-voice-enabled')?.addEventListener('change', (e) => {
      document.getElementById('ob-voice-fields').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('ob-websearch-test')?.addEventListener('click', _obTestWebSearch);
    document.querySelectorAll('input[name="ob-embedding"]').forEach(el => {
      el.addEventListener('change', _obUpdateEmbeddingFields);
    });
    document.querySelectorAll('input[name="ob-search"]').forEach(el => {
      el.addEventListener('change', _obUpdateSearchFields);
    });
  }
}

async function _obTestWebSearch() {
  const btn = document.getElementById('ob-websearch-test');
  const out = document.getElementById('ob-websearch-result');
  const choice = document.querySelector('input[name="ob-search"]:checked')?.value || 'searxng';
  const useSearx = choice === 'searxng' || choice === 'both';
  const useBrave = choice === 'brave' || choice === 'both';
  const payload = {
    searxngUrl: useSearx ? document.getElementById('ob-searxng-url').value.trim() : '',
    searxngApiKey: useSearx ? document.getElementById('ob-searxng-key').value.trim() : '',
    braveApiKey: useBrave ? document.getElementById('ob-brave-key').value.trim() : '',
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
    if (sectionKey === '6') _obRenderTierRows('ob-tier-rows', OB_MODEL_TIERS.main.map(t => t.id));
    if (sectionKey === '7') _obRenderTierRows('ob-vlm-rows', OB_MODEL_TIERS.vlm.map(t => t.id));
    if (sectionKey === 'p')  _obRenderPluginPicker();
    if (sectionKey === 'pp') _obRenderProviderTypePicker();
    if (sectionKey === '5')  _obRenderProvidersList();
    if (sectionKey === 'a')  _obRenderAgentEffortStep();
    if (sectionKey === 'e')  _obRenderEmbeddingStep();
    if (sectionKey === '8')  _obUpdateSearchFields();
    if (sectionKey === 'c')  _obRenderSporeCodeStep();
    if (sectionKey === 'ch') _obRenderChannelsStep();
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
  host.innerHTML = `<svg viewBox="-1 -1 2 2" width="160" height="160" style="overflow:visible" aria-label="Spore Core">
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

// Built-in provider tiles. Populated at wizard-show time by
// _obLoadProviderTiles from /api/onboarding/plugins. Each entry is
// derived from a provider plugin's pane schema:
//   id             — provider name (e.g. 'anthropic', 'zai'); == tile.id
//   label          — plugin's `label` opt on registerProvider
//   sub            — pane.description, truncated
//   fields         — pane.schema entries with type 'text' or 'password',
//                    keyed by their `key` field (apiKey, baseUrl, ...)
//   modelsPlaceholder — best-effort hint per provider name (no plugin
//                       opt for this yet; falls back to a generic string)
//   authHeaderField — true when the schema declares an authHeader key
//                     (only the local-oai-provider currently does)
//   pluginId       — used to flip _obData.plugins[<id>].enabled
let OB_PROVIDERS = [];
// Model tier list — populated by _obLoadProviderTiles from the
// /api/onboarding/plugins response (server reads from the settings
// registry). Falls back to the historical list if the response
// doesn't include modelTiers (e.g. older server).
let OB_MODEL_TIERS = {
  main: [
    { id: 'casual', label: 'Casual model' },
    { id: 'normal', label: 'Normal model' },
    { id: 'planner', label: 'Planner model' },
    { id: 'subagent', label: 'Sub-agent model' },
    { id: 'learner', label: 'Learner model' },
    { id: 'recall', label: 'Recall model' },
  ],
  vlm: [
    { id: 'imageVlm', label: 'Image VLM model' },
    { id: 'videoVlm', label: 'Video VLM model' },
    { id: 'audioVlm', label: 'Audio VLM model' },
  ],
};

// Each provider plugin contributes its own models-placeholder hint
// via `registerProvider({ modelsPlaceholder: '…' })`. The wizard
// reads it from `p.provider.modelsPlaceholder` below — no more
// hardcoded per-provider table to keep in sync.

async function _obLoadProviderTiles() {
  let plugins = [];
  let data = {};
  try {
    const r = await fetch(API + '/api/onboarding/plugins');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
    plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  } catch (e) {
    console.warn('[wizard] failed to load provider tiles:', e?.message || e);
    return;
  }
  const tiles = [];
  const pluginMap = {};
  const tileMap = {};
  for (const p of plugins) {
    if (!p?.provider || !p.provider.name) continue;
    if (p.provider.name === 'custom' || p.provider.name === 'local') continue;
    const schema = p.pane?.schema || [];
    // Filter to text/password fields the wizard knows how to render.
    // Skip the `tab: 'providers'` marker fields. The wizard only needs
    // the basic apiKey + baseUrl + maybe authHeader / referer; richer
    // fields are reachable via Settings post-onboarding.
    const fields = schema
      .filter(f => f && (f.type === 'password' || f.type === 'text'))
      .map(f => ({
        key: f.key,
        label: f.label || f.key,
        type: f.type,
        placeholder: f.placeholder || f.help || '',
      }));
    const tile = {
      id: p.provider.name,
      label: p.provider.label || p.name || p.id,
      sub: (p.pane?.description || '').slice(0, 200),
      fields,
      modelsPlaceholder: p.provider.modelsPlaceholder || '',
      // Plugin-supplied default URL — fed to fresh entries so the
      // editor opens with a sensible value (e.g. localhost:11434/v1
      // for local-oai-provider) instead of an empty input next to a
      // placeholder. Operators can still edit / clear it.
      defaultBaseUrl: p.provider.defaultBaseUrl || '',
      authHeaderField: schema.some(f => f?.key === 'authHeader'),
      pluginId: p.id,
    };
    tiles.push(tile);
    pluginMap[p.id] = tile.id;
    tileMap[tile.id] = p.id;
  }
  // Stable order: prefer the canonical built-ins first when present,
  // then any extras (e.g. zai or future plugins) alphabetically.
  const PRIMARY = ['anthropic', 'openai', 'openrouter', 'gemini'];
  tiles.sort((a, b) => {
    const ai = PRIMARY.indexOf(a.id);
    const bi = PRIMARY.indexOf(b.id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.label.localeCompare(b.label);
  });
  OB_PROVIDERS = tiles;
  OB_PROVIDER_PLUGIN_MAP = pluginMap;
  OB_TILE_TO_PLUGIN = tileMap;
  _obPluginsCache = plugins;

  // Model tier list comes from the registry server-side. Older servers
  // omit this field — the historical list in OB_MODEL_TIERS is the
  // fallback.
  if (data?.modelTiers && typeof data.modelTiers === 'object') {
    OB_MODEL_TIERS = {
      main: Array.isArray(data.modelTiers.main) && data.modelTiers.main.length
        ? data.modelTiers.main
        : OB_MODEL_TIERS.main,
      vlm: Array.isArray(data.modelTiers.vlm) && data.modelTiers.vlm.length
        ? data.modelTiers.vlm
        : OB_MODEL_TIERS.vlm,
    };
  }
}

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
async function _obRenderProviderTypePicker() {
  const root = document.getElementById('ob-pp-grid');
  if (!root) return;
  // If the loader hasn't populated tiles yet (operator clicked
  // through fast), show a placeholder + await the fetch then re-render.
  if (!Array.isArray(OB_PROVIDERS) || OB_PROVIDERS.length === 0) {
    root.innerHTML = '<div class="ob-note" style="opacity:0.6">Loading providers…</div>';
    await _obLoadProviderTiles();
    if (!Array.isArray(OB_PROVIDERS) || OB_PROVIDERS.length === 0) {
      root.innerHTML = '<div class="ob-error">No provider plugins available. Install at least one before continuing.</div>';
      return;
    }
  }
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

  root.innerHTML = OB_PROVIDERS.map(t => tile(t.id, t.label, t.sub)).join('')
    + tile('custom', 'Custom OAI-compatible endpoint', 'Self-hosted or third-party OpenAI-compatible endpoint. Add more endpoints in the next step.', 'custom');
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
  const customChecked = !!document.querySelector('[data-pp-custom="custom"]')?.checked;

  // Drop unchecked builtins/customs from entries.
  _obProviderEntries = _obProviderEntries.filter(e => {
    if (e.kind === 'builtin') return builtinChecked.has(e.id);
    if (e.kind === 'custom') return customChecked;
    return true;
  });
  // Add fresh entries for newly-checked builtins.
  for (const id of builtinChecked) {
    if (!_obProviderEntries.some(e => e.kind === 'builtin' && e.id === id)) {
      const tile = OB_PROVIDERS.find(p => p.id === id);
      _obProviderEntries.push({
        kind: 'builtin', id,
        apiKey: '',
        baseUrl: tile?.defaultBaseUrl || '',
        models: '',
      });
    }
  }
  if (customChecked && !_obProviderEntries.some(e => e.kind === 'custom')) {
    _obProviderEntries.push({
      kind: 'custom',
      name: 'local',
      apiKey: '',
      url: 'http://localhost:11434/v1',
      authHeader: 'bearer',
      models: '',
    });
  }
  // Backfill defaultBaseUrl on any pre-existing builtin entry whose
  // baseUrl is empty so re-entering step 5 after the tiles have
  // loaded shows the plugin-supplied default in the editor.
  for (const entry of _obProviderEntries) {
    if (entry.kind !== 'builtin' || entry.baseUrl) continue;
    const tile = OB_PROVIDERS.find(p => p.id === entry.id);
    if (tile?.defaultBaseUrl) entry.baseUrl = tile.defaultBaseUrl;
  }

  // Mirror tile selections to _obData.plugins so the onboarding/complete
  // handler installs the right provider plugins. Each builtin tile maps
  // 1:1 to a plugin id via OB_PROVIDER_PLUGIN_MAP.
  if (!_obData.plugins) _obData.plugins = {};
  for (const [pluginId, tileId] of Object.entries(OB_PROVIDER_PLUGIN_MAP)) {
    if (!_obData.plugins[pluginId]) _obData.plugins[pluginId] = { enabled: false, config: {} };
    _obData.plugins[pluginId].enabled = builtinChecked.has(tileId);
  }
  if (!_obData.plugins['local-oai-provider']) _obData.plugins['local-oai-provider'] = { enabled: false, config: {} };
  _obData.plugins['local-oai-provider'].enabled = customChecked;
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
  // The "sub" line was static plugin description text for builtins,
  // which made multiple local/custom entries indistinguishable. Prefer
  // the actual URL the operator typed (e.baseUrl for builtins,
  // e.url for customs), falling back to the description only when
  // there's nothing user-entered.
  const userUrl = (e.kind === 'builtin' ? e.baseUrl : e.url) || '';
  const sub = userUrl || (t ? t.sub : '');
  const keyMask = e.apiKey ? `${e.apiKey.slice(0, 4)}…${e.apiKey.slice(-4)}` : '(no key)';
  const authLine = e.authHeader && e.authHeader !== 'Authorization' && e.authHeader !== 'bearer'
    ? `<div class="settings-note" style="opacity:.7;margin-top:2px">auth: <code>${_settingsEscapeHtml(e.authHeader)}</code></div>`
    : '';
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
      <div><strong>${_settingsEscapeHtml(label)}</strong>${testBadge}</div>
      ${sub ? `<div class="settings-note" style="opacity:.7;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${userUrl ? 'url: ' : ''}<code>${_settingsEscapeHtml(sub)}</code></div>` : ''}
      <div class="settings-note" style="opacity:.7;margin-top:2px">key: <code>${_settingsEscapeHtml(keyMask)}</code></div>
      ${authLine}
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
    const id = el.dataset.pickBuiltin;
    const tile = OB_PROVIDERS.find(p => p.id === id);
    _obProviderEntries.push({
      kind: 'builtin', id,
      apiKey: '',
      baseUrl: tile?.defaultBaseUrl || '',
      models: '',
    });
    _obProviderEditing = _obProviderEntries.length - 1;
    _obRenderProvidersList();
  }));
  root.querySelectorAll('[data-pick-custom]').forEach(el => el.addEventListener('click', () => {
    _obProviderEntries.push({ kind: 'custom', name: '', apiKey: '', url: '', authHeader: 'bearer', models: '' });
    _obProviderEditing = _obProviderEntries.length - 1;
    _obRenderProvidersList();
  }));
}

function _obRenderProviderEditor(root, i) {
  const e = _obProviderEntries[i];
  const t = e.kind === 'builtin' ? OB_PROVIDERS.find(p => p.id === e.id) : null;
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
    const fields = Array.isArray(t?.fields) ? t.fields : [];
    const baseField = fields.find(f => f.key === 'baseUrl');
    const keyField  = fields.find(f => f.key === 'apiKey');
    const extraFields = fields.filter(f => !['apiKey', 'baseUrl', 'authHeader'].includes(f.key));
    const renderExtraField = (field) => {
      const key = field.key;
      const id = `ob-edit-field-${key}`;
      const type = field.type === 'password' ? 'password' : 'text';
      return `<label for="${esc(id)}">${esc(field.label || key)}</label>
        <input type="${type}" id="${esc(id)}" placeholder="${esc(field.placeholder || '')}" value="${esc(e[key] || '')}">`;
    };
    // Auth-header values match OAICompatClient + plugin-pane schema —
    // 'bearer' / 'x-api-key' / 'x-key'. Don't use 'Authorization' as a
    // value (it was an older naming attempt that diverged from the
    // plugin pane and silently shipped the wrong header at chat time).
    const authVal = e.authHeader || 'bearer';
    const authBlock = t?.authHeaderField ? `
      <label for="ob-edit-auth">Auth header</label>
      <select id="ob-edit-auth">
        <option value="bearer"${authVal === 'bearer' ? ' selected' : ''}>Authorization (Bearer)</option>
        <option value="x-api-key"${authVal === 'x-api-key' ? ' selected' : ''}>x-api-key</option>
        <option value="x-key"${authVal === 'x-key' ? ' selected' : ''}>x-key</option>
      </select>` : '';
    root.innerHTML = `<div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)">
      <div style="margin-bottom:10px"><strong>${esc(t?.label || e.id)}</strong> <span class="settings-note" style="opacity:.6">${esc(t?.sub || '')}</span></div>
      ${keyField ? `<label for="ob-edit-key">${esc(keyField.label || 'API Key')}</label>
        <input type="password" id="ob-edit-key" placeholder="${esc(keyField?.placeholder || '')}" value="${esc(e.apiKey || '')}">` : ''}
      ${baseField ? `<label for="ob-edit-base">Base URL (optional)</label>
        <input type="text" id="ob-edit-base" placeholder="${esc(baseField.placeholder || '')}" value="${esc(e.baseUrl || '')}">` : ''}
      ${authBlock}
      ${extraFields.map(renderExtraField).join('')}
      <label for="ob-edit-models">Models (comma-separated)</label>
      <input type="text" id="ob-edit-models" placeholder="${esc(t?.modelsPlaceholder || '')}" value="${esc(e.models || '')}">
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
        <option value="bearer"${e.authHeader === 'bearer' || !e.authHeader ? ' selected' : ''}>Authorization (Bearer)</option>
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
      const fields = Array.isArray(t?.fields) ? t.fields : [];
      const keys = ['apiKey', 'baseUrl', 'authHeader']
        .concat(fields.map(f => f.key).filter(k => k && !['apiKey', 'baseUrl', 'authHeader'].includes(k)));
      return [e.id, ...keys.map(key => e[key] || '')].join('|');
    }
    return [e.name || '', e.url || '', e.apiKey || '', e.authHeader || ''].join('|');
  };
  const canAutoProbe = () => {
    if (e.kind === 'custom') return !!(e.name && e.url);
    const fields = Array.isArray(t?.fields) ? t.fields : [];
    const hasSecret = fields.some(f => f?.key === 'apiKey' || f?.type === 'password');
    if (hasSecret && !e.apiKey) return false;
    return fields.some(f => {
      const key = f?.key;
      return key && !['models', 'authHeader', 'referer'].includes(key) && !!String(e[key] || '').trim();
    });
  };
  const scheduleAutoProbe = () => {
    const hash = hashConnectionFields();
    clearTimeout(e._autoProbeTimer);
    if (!canAutoProbe()) return;
    if (e._autoProbeHash === hash && e.lastTestResult === 'ok') return;
    const out = document.getElementById('ob-edit-test-result');
    if (out) { out.className = 'ob-test-result'; out.textContent = 'auto-probing…'; }
    e._autoProbeTimer = setTimeout(() => _obAutoProbeEntry(i, hash), 900);
  };
  const captureForm = () => {
    const before = hashConnectionFields();
    if (e.kind === 'builtin') {
      e.apiKey = get('ob-edit-key');
      e.baseUrl = get('ob-edit-base') || '';
      const authEl = document.getElementById('ob-edit-auth');
      if (authEl) e.authHeader = authEl.value || 'bearer';
      for (const field of (Array.isArray(t?.fields) ? t.fields : [])) {
        if (!field?.key || ['apiKey', 'baseUrl', 'authHeader'].includes(field.key)) continue;
        e[field.key] = get(`ob-edit-field-${field.key}`);
      }
      e.models = get('ob-edit-models');
    } else {
      e.name = get('ob-edit-name').replace(/[^a-z0-9_-]/gi, '');
      e.apiKey = get('ob-edit-key');
      e.url = get('ob-edit-url');
      e.authHeader = get('ob-edit-auth') || 'bearer';
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
  root.querySelectorAll('input,select').forEach(el => {
    if (el.id === 'ob-edit-models') return;
    const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(eventName, () => {
      captureForm();
      scheduleAutoProbe();
    });
  });
  scheduleAutoProbe();
}

async function _obAutoProbeEntry(i, expectedHash) {
  const e = _obProviderEntries[i];
  if (!e || e._autoProbeInflight) return;
  if (_obProviderEditing !== i) return;
  if (expectedHash && e._autoProbeHash === expectedHash && e.lastTestResult === 'ok') return;
  e._autoProbeInflight = true;
  try {
    const populated = await _obPopulateModelsForEntry(i);
    if (!populated) return;
    if (expectedHash && e._autoProbeHash && e._autoProbeHash !== expectedHash) return;
    const tested = await _obTestEntry(i);
    if (tested) e._autoProbeHash = expectedHash || '';
  } finally {
    e._autoProbeInflight = false;
  }
}

async function _obTestEntry(i) {
  const e = _obProviderEntries[i];
  const out = document.getElementById('ob-edit-test-result');
  const btn = document.getElementById('ob-edit-test');
  if (!e || !out || !btn) return false;
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
        body: JSON.stringify(_obReadProvider(e.id)),
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
    return true;
  } catch (err) {
    e.lastTestResult = 'fail';
    out.className = 'ob-test-result err';
    out.textContent = String(err.message || err).slice(0, 120);
    _obUpdateFinishGate();
    return false;
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
  const errEl = document.getElementById('ob-finish-error');
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
    if (errEl) errEl.textContent = '';
    return;
  }
  const ok = _obIsAnyProviderVerified();
  btn.disabled = !ok;
  btn.title = ok ? '' : 'Run the test on at least one provider before finishing.';
  if (errEl) errEl.textContent = ok ? '' : 'Run the test on at least one provider before finishing.';
}

async function _obPopulateModelsForEntry(i) {
  const e = _obProviderEntries[i];
  const out = document.getElementById('ob-edit-test-result');
  const btn = document.getElementById('ob-edit-populate');
  const inp = document.getElementById('ob-edit-models');
  if (!e || !out || !btn || !inp) return false;
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  try {
    // _listModelsForProvider expects `baseUrl` (not `url`) for both the
    // builtin and custom branches — keep the field name consistent on
    // the wire even though our entry stores `e.url` for customs.
    // For the OAI-compatible builtin, populate via 'custom' kind so
    // authHeader gets through (the 'local' kind doesn't accept it
    // server-side, but its connection shape is identical).
    const body = e.kind === 'builtin'
      ? { kind: e.id, ..._obReadProvider(e.id) }
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
    return true;
  } catch (err) {
    out.className = 'ob-test-result err';
    out.textContent = String(err.message || err).slice(0, 100);
    return false;
  } finally { btn.disabled = false; }
}

// Map: <full model ref> → { contextLength }. Built up as the user populates
// providers in step 5; consulted in step 6 to pre-fill Max ctx.
const _obKnownModelLimits = {};

function _obRecordModelLimits(providerPrefix, modelObjs) {
  let count = 0;
  for (const m of (modelObjs || [])) {
    if (!m?.id || !m?.contextLength) continue;
    const ref = _obModelRef(providerPrefix, m.id);
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
      body: JSON.stringify({ kind: providerId, ...v }),
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
  const out = {
    apiKey: e.apiKey || '',
    baseUrl: e.baseUrl || '',
    authHeader: e.authHeader || '',
    models: e.models || '',
  };
  const tile = OB_PROVIDERS.find(p => p.id === id);
  for (const field of (Array.isArray(tile?.fields) ? tile.fields : [])) {
    if (!field?.key || Object.prototype.hasOwnProperty.call(out, field.key)) continue;
    out[field.key] = e[field.key] || '';
  }
  return out;
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

function _obModelRef(provider, modelId) {
  const prov = String(provider || 'anthropic').trim().toLowerCase();
  const model = String(modelId || '').trim();
  return (prov && prov !== 'anthropic') ? `${prov}/${model}` : model;
}

function _obEntryProviderName(entry) {
  if (!entry) return '';
  if (entry.kind === 'builtin') return String(entry.id || '').trim().toLowerCase();
  return String(entry.name || '').trim().toLowerCase();
}

function _obEntryHasConfig(entry) {
  if (!entry) return false;
  if (entry.kind === 'custom') return !!(entry.name && entry.url);
  const vals = _obReadProvider(entry.id);
  return Object.entries(vals)
    .some(([key, value]) => !['models', 'authHeader', 'referer'].includes(key) && !!String(value || '').trim());
}

// Returns a map: { providerName: [model, model, ...], ... } for every configured provider
// that the user declared models for. Used to populate the tier model dropdowns.
function _obAllConfiguredModels() {
  const out = {};
  for (const entry of _obProviderEntries) {
    const provider = _obEntryProviderName(entry);
    if (!provider || !_obEntryHasConfig(entry)) continue;
    const models = _obParseModels(entry.models);
    if (!models.length) continue;
    const bucket = out[provider] || [];
    for (const model of models) {
      if (!bucket.includes(model)) bucket.push(model);
    }
    out[provider] = bucket;
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
    return Object.entries(v).some(([key, value]) => !['models', 'authHeader', 'referer'].includes(key) && !!String(value || '').trim());
  }).map(p => p.id);
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
      authHeader: e.authHeader || 'bearer',
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

const OB_FEATURE_PLUGIN_IDS = new Set([
  'local-oai-provider',
  'embedder-gemma', 'gemini-embedder',
  'browser-core', 'zendriver', 'playwright',
  'spore-code', 'session-graph',
  'discord', 'telegram', 'slack',
]);

function _obEnsurePluginSelection(pluginId, enabled, configPatch = null) {
  if (!_obData.plugins) _obData.plugins = {};
  const cur = _obData.plugins[pluginId] || { enabled: false, config: {} };
  const nextConfig = configPatch
    ? { ...(cur.config || {}), ...configPatch }
    : (cur.config || {});
  _obData.plugins[pluginId] = { enabled: !!enabled, config: nextConfig };
}

function _obIsFeaturePlugin(p) {
  return !!(p && OB_FEATURE_PLUGIN_IDS.has(p.id));
}

function _obIsChannelPlugin(p) {
  return !!(p && (p.channel || p.category === 'channels' || ['discord', 'telegram', 'slack'].includes(p.id)));
}

async function _obRenderPluginPicker() {
  const list = document.getElementById('ob-plugin-list');
  list.innerHTML = '<div class="ob-note">Loading available plugins…</div>';
  try {
    const r = await fetch(API + '/api/onboarding/plugins');
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
  const visiblePlugins = _obPluginsCache.filter(p => !OB_PROVIDER_PLUGIN_MAP[p.id] && !_obIsFeaturePlugin(p) && !_obIsChannelPlugin(p));
  list.innerHTML = visiblePlugins.length
    ? visiblePlugins.map(p => _obRenderPluginCard(p)).join('')
    : '<div class="ob-note">No extra plugins available. Core feature plugins were handled in earlier steps.</div>';

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
  const desc = _settingsEscapeHtml(_obPluginDescription(p));
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

function _obPluginDescription(p) {
  const explicit = String(p?.pane?.description || p?.description || '').trim();
  if (explicit) return _obClampPluginDescription(explicit);

  const bits = [];
  const tools = Number(p?.toolCount || 0);
  const gateways = Number(p?.gatewayCount || 0);
  if (tools > 0) bits.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  if (gateways > 0) bits.push(`${gateways} gateway${gateways === 1 ? '' : 's'}`);
  if (p?.hasReferenceNodes) bits.push('reference nodes');
  if (bits.length) {
    return `Adds ${bits.join(', ')} to the agent. Configure or remove it later from Settings -> Plugins.`;
  }

  const label = p?.name || p?.id || 'This plugin';
  return `${label} extends the agent. Configure or remove it later from Settings -> Plugins.`;
}

function _obClampPluginDescription(text, max = 260) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const sentenceCut = clean.slice(0, max).lastIndexOf('. ');
  const cut = sentenceCut >= 100 ? sentenceCut + 1 : clean.slice(0, max - 3).lastIndexOf(' ');
  return clean.slice(0, cut > 100 ? cut : max - 3).trim() + '...';
}

// Snapshot the current selections into _obData.plugins so navigation /
// finish both have a consistent view.
//
// IMPORTANT: skip provider and first-class feature plugins. They are
// filtered out of the rendered picker and controlled by their dedicated
// wizard steps. Without this skip, missing checkboxes would fall back
// to plugin defaults and overwrite the operator's feature choices.
function _obSnapshotPluginPicker() {
  if (!_obPluginsCache) return;
  if (!_obData.plugins) _obData.plugins = {};
  for (const p of _obPluginsCache) {
    if (OB_PROVIDER_PLUGIN_MAP[p.id]) continue;
    if (_obIsFeaturePlugin(p)) continue;
    if (_obIsChannelPlugin(p)) continue;
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

async function _obRenderChannelsStep() {
  const list = document.getElementById('ob-channel-list');
  if (!list) return;
  if (!_obPluginsCache) {
    list.innerHTML = '<div class="ob-note">Loading channel plugins…</div>';
    try {
      const r = await fetch(API + '/api/onboarding/plugins');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      _obPluginsCache = data.plugins || [];
    } catch (e) {
      list.innerHTML = `<div class="ob-error">Failed to load channels: ${_settingsEscapeHtml(e.message || String(e))}</div>`;
      return;
    }
  }
  const channels = _obPluginsCache.filter(_obIsChannelPlugin);
  if (!channels.length) {
    list.innerHTML = '<div class="ob-note">No channel plugins are available. Web and CLI will still work.</div>';
    return;
  }
  list.innerHTML = channels.map(_obRenderChannelCard).join('');
  for (const p of channels) {
    const saved = _obData.plugins?.[p.id];
    const cb = document.getElementById(`ob-channel-on-${p.id}`);
    if (cb) cb.checked = !!saved?.enabled;
    for (const f of (p.pane?.schema || [])) {
      if (!f?.key || f.key === 'enabled') continue;
      const input = document.getElementById(`ob-channel-${p.id}-${f.key}`);
      if (!input) continue;
      const savedValue = saved?.config?.[f.key];
      const paneValue = p.pane?.values?.[f.key];
      const value = savedValue !== undefined ? savedValue
        : (paneValue !== undefined && paneValue !== null ? paneValue
          : (f.default !== undefined ? f.default : ''));
      if (f.type === 'toggle') input.checked = !!value;
      else if (f.type !== 'password') input.value = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
  }
}

function _obRenderChannelCard(p) {
  const id = _settingsEscapeHtml(p.id);
  const name = _settingsEscapeHtml(p.name || p.id);
  const desc = _settingsEscapeHtml(_obPluginDescription(p));
  const fields = [];
  for (const f of (p.pane?.schema || [])) {
    if (!f?.key || f.key === 'enabled') continue;
    const fieldId = `ob-channel-${p.id}-${_settingsEscapeHtml(f.key)}`;
    const key = _settingsEscapeHtml(f.key);
    const label = _settingsEscapeHtml(f.label || f.key);
    const help = f.help ? `<div class="ob-note" style="margin-top:3px">${_settingsEscapeHtml(f.help)}</div>` : '';
    const paneValue = p.pane?.values?.[f.key];
    const value = paneValue !== undefined && paneValue !== null ? paneValue : (f.default !== undefined ? f.default : '');
    if (f.type === 'password') {
      const placeholder = p.pane?.meta?.[f.key]?.isSet ? 'stored - leave blank to keep' : (f.placeholder || '');
      fields.push(`<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <input type="password" id="${fieldId}" placeholder="${_settingsEscapeHtml(placeholder)}" data-channel-plugin="${id}" data-channel-key="${key}" data-channel-secret="1">${help}`);
    } else if (f.type === 'number') {
      fields.push(`<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <input type="number" id="${fieldId}" value="${_settingsEscapeHtml(String(value ?? ''))}" data-channel-plugin="${id}" data-channel-key="${key}">${help}`);
    } else if (f.type === 'select') {
      const opts = (f.options || []).map(o => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? (o.label || o.value) : o;
        return `<option value="${_settingsEscapeHtml(v)}"${String(v) === String(value) ? ' selected' : ''}>${_settingsEscapeHtml(l)}</option>`;
      }).join('');
      fields.push(`<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <select id="${fieldId}" data-channel-plugin="${id}" data-channel-key="${key}">${opts}</select>${help}`);
    } else if (f.type === 'toggle') {
      fields.push(`<label class="ob-choice-card" style="margin-top:8px">
        <input type="checkbox" id="${fieldId}" ${value ? 'checked' : ''} data-channel-plugin="${id}" data-channel-key="${key}" style="width:auto">
        <span>${label}${help}</span>
      </label>`);
    } else {
      fields.push(`<label for="${fieldId}" style="margin-top:8px">${label}</label>
        <input type="text" id="${fieldId}" value="${_settingsEscapeHtml(Array.isArray(value) ? value.join(', ') : String(value ?? ''))}" data-channel-plugin="${id}" data-channel-key="${key}">${help}`);
    }
  }
  return `<div class="ob-plugin-card ob-channel-card" style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-soft)">
    <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--text)">
      <input type="checkbox" id="ob-channel-on-${id}" data-channel-toggle="${id}" style="width:auto;margin-top:3px">
      <div style="flex:1;min-width:0">
        <div><strong>${name}</strong> <span class="settings-note" style="opacity:.55">channel plugin</span></div>
        <div class="settings-note" style="opacity:.7;margin-top:3px">${desc}</div>
      </div>
    </label>
    ${fields.length ? `<div data-channel-form="${id}" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">${fields.join('')}</div>` : ''}
  </div>`;
}

function _obSnapshotChannelsStep() {
  if (!_obPluginsCache) return;
  if (!_obData.plugins) _obData.plugins = {};
  for (const p of _obPluginsCache.filter(_obIsChannelPlugin)) {
    const cb = document.getElementById(`ob-channel-on-${p.id}`);
    const enabled = cb ? cb.checked : false;
    const config = { enabled };
    for (const f of (p.pane?.schema || [])) {
      if (!f?.key || f.key === 'enabled') continue;
      const input = document.getElementById(`ob-channel-${p.id}-${f.key}`);
      if (!input) continue;
      let value;
      if (f.type === 'toggle') value = !!input.checked;
      else if (f.type === 'number') {
        if (input.value === '') continue;
        const n = Number(input.value);
        if (!Number.isFinite(n)) continue;
        value = n;
      } else {
        value = (input.value || '').trim();
        if (!value && (f.secret || f.type === 'password')) continue;
      }
      config[f.key] = value;
    }
    _obEnsurePluginSelection(p.id, enabled, config);
  }
}

function _obRenderAgentEffortStep() {
  const value = _obData.agentEffort || 'balanced';
  const radio = document.querySelector(`input[name="ob-agent-effort"][value="${value}"]`);
  if (radio) radio.checked = true;
  _obUpdateAgentEffortSummary();
  document.querySelectorAll('input[name="ob-agent-effort"]').forEach(el => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('change', () => {
      _obSnapshotAgentEffortStep();
      _obUpdateAgentEffortSummary();
    });
  });
}

function _obSnapshotAgentEffortStep() {
  const value = document.querySelector('input[name="ob-agent-effort"]:checked')?.value || 'balanced';
  _obData.agentEffort = ['quick', 'balanced', 'deep'].includes(value) ? value : 'balanced';
}

function _obUpdateAgentEffortSummary() {
  const el = document.getElementById('ob-agent-effort-summary');
  if (!el) return;
  const value = document.querySelector('input[name="ob-agent-effort"]:checked')?.value || _obData.agentEffort || 'balanced';
  const summaries = {
    quick: 'Lower token budgets and iteration caps. Best for lightweight chat and cheaper day-to-day use.',
    balanced: 'Default operating point. Good for general chat, tool use, and normal coding/debugging work.',
    deep: 'Higher budgets, more iterations, and more sub-agent fan-out. Best for long research/coding tasks; costs more per turn.',
  };
  el.textContent = summaries[value] || summaries.balanced;
}

function _obExistingGeminiKey() {
  const providerEntry = _obProviderEntries.find(e => e.kind === 'builtin' && e.id === 'gemini');
  const providerKey = (providerEntry?.apiKey || '').trim();
  const pluginKey = (_obData.plugins?.['gemini-provider']?.config?.apiKey || '').trim();
  const embeddingKey = (_obData.embeddingGeminiApiKey || '').trim();
  return embeddingKey || providerKey || pluginKey;
}

function _obBuiltinProviderSelected(id) {
  return _obProviderEntries.some(e => e.kind === 'builtin' && e.id === id);
}

function _obUpdateEmbeddingFields() {
  const choice = document.querySelector('input[name="ob-embedding"]:checked')?.value || 'gemma';
  const gemma = document.getElementById('ob-embedding-gemma-fields');
  const gemini = document.getElementById('ob-embedding-gemini-fields');
  if (gemma) gemma.style.display = choice === 'gemma' ? '' : 'none';
  if (gemini) gemini.style.display = choice === 'gemini' ? '' : 'none';
}

function _obRenderEmbeddingStep() {
  const choice = _obData.embeddingChoice || 'gemma';
  const radio = document.querySelector(`input[name="ob-embedding"][value="${choice}"]`);
  if (radio) radio.checked = true;

  const gemmaCfg = _obData.plugins?.['embedder-gemma']?.config || {};
  const dtype = document.getElementById('ob-embed-gemma-dtype');
  const dim = document.getElementById('ob-embed-gemma-dim');
  if (dtype && gemmaCfg.dtype) dtype.value = gemmaCfg.dtype;
  if (dim && gemmaCfg.dim) dim.value = String(gemmaCfg.dim);

  const geminiCfg = _obData.plugins?.['gemini-embedder']?.config || {};
  const geminiKey = document.getElementById('ob-embed-gemini-key');
  const geminiModel = document.getElementById('ob-embed-gemini-model');
  if (geminiKey && _obExistingGeminiKey()) geminiKey.value = _obExistingGeminiKey();
  if (geminiModel && (geminiCfg.model || _obData.embeddingGeminiModel)) {
    geminiModel.value = geminiCfg.model || _obData.embeddingGeminiModel;
  }
  _obUpdateEmbeddingFields();
}

function _obSnapshotEmbeddingStep() {
  const choice = document.querySelector('input[name="ob-embedding"]:checked')?.value || 'gemma';
  _obData.embeddingChoice = choice;

  if (choice === 'gemma') {
    const dtype = document.getElementById('ob-embed-gemma-dtype')?.value || 'q4';
    const dimRaw = document.getElementById('ob-embed-gemma-dim')?.value || '768';
    _obData.embedder = 'gemma-300m';
    _obEnsurePluginSelection('embedder-gemma', true, { dtype, dim: dimRaw });
    _obEnsurePluginSelection('gemini-embedder', false);
    if (!_obBuiltinProviderSelected('gemini')) _obEnsurePluginSelection('gemini-provider', false);
    return;
  }

  if (choice === 'gemini') {
    const apiKey = (document.getElementById('ob-embed-gemini-key')?.value || '').trim();
    const model = (document.getElementById('ob-embed-gemini-model')?.value || 'gemini-embedding-2-preview').trim();
    _obData.embedder = 'gemini';
    _obData.embeddingGeminiApiKey = apiKey;
    _obData.embeddingGeminiModel = model;
    _obEnsurePluginSelection('embedder-gemma', false);
    _obEnsurePluginSelection('gemini-provider', true, apiKey ? { apiKey } : {});
    _obEnsurePluginSelection('gemini-embedder', true, model ? { model } : {});
    return;
  }

  _obData.embedder = null;
  _obEnsurePluginSelection('embedder-gemma', false);
  _obEnsurePluginSelection('gemini-embedder', false);
  if (!_obBuiltinProviderSelected('gemini')) _obEnsurePluginSelection('gemini-provider', false);
}

function _obUpdateSearchFields() {
  const choice = document.querySelector('input[name="ob-search"]:checked')?.value || 'searxng';
  const showSearx = choice === 'searxng' || choice === 'both';
  const showBrave = choice === 'brave' || choice === 'both';
  const searx = document.getElementById('ob-searxng-fields');
  const brave = document.getElementById('ob-brave-fields');
  if (searx) searx.style.display = showSearx ? '' : 'none';
  if (brave) brave.style.display = showBrave ? '' : 'none';
}

function _obSnapshotBrowserStep() {
  const backend = document.querySelector('input[name="ob-browser"]:checked')?.value || 'zendriver';
  _obData.browserBackend = backend;
  _obEnsurePluginSelection('browser-core', true);
  _obEnsurePluginSelection('zendriver', backend === 'zendriver');
  _obEnsurePluginSelection('playwright', backend === 'playwright');
}

function _obRenderSporeCodeStep() {
  const cb = document.getElementById('ob-spore-code-enabled');
  const recallCb = document.getElementById('ob-enhanced-recall-enabled');
  if (!cb && !recallCb) return;
  const saved = _obData.plugins?.['spore-code'];
  if (cb) cb.checked = saved?.enabled !== false;
  if (recallCb) recallCb.checked = _obData.enhancedRecall === true;
}

function _obSnapshotSporeCodeStep() {
  const enabled = document.getElementById('ob-spore-code-enabled')?.checked !== false;
  _obData.enhancedRecall = !!document.getElementById('ob-enhanced-recall-enabled')?.checked;
  _obData.sporeCodeEnabled = enabled;
  _obEnsurePluginSelection('spore-code', enabled);
  _obEnsurePluginSelection('session-graph', enabled);
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
  // Tier labels come from the registry (via OB_MODEL_TIERS) — short
  // names with the 'model' suffix stripped, plus a `*` on the planner
  // to flag it as required by the wizard.
  const labelByTier = {};
  for (const t of [...OB_MODEL_TIERS.main, ...OB_MODEL_TIERS.vlm]) {
    labelByTier[t.id] = String(t.label || t.id).replace(/\s*model$/i, '');
  }
  if (labelByTier.planner) labelByTier.planner = labelByTier.planner + ' *';
  const tierLabels = labelByTier;
  const header = `
    <div class="ob-tier-header">
      <div>Tier</div><div>Model</div>
      <div title="Max tokens the model can hold">Max ctx</div>
      <div title="Compact history when above this — defaults to 85% of Max ctx">Compact at</div>
      <div></div><div></div>
    </div>`;
  // Tier rows: single combobox per tier, driven by the wizard-local
  // model cache (_obKnownModelLimits + textarea-pasted models). State
  // is held in _obTierValues (provider+modelId per tier) — no hidden
  // selects in the DOM, so the grid stays predictable.
  container.innerHTML = header + tiers.map(t => `
    <div class="ob-tier-row" data-tier="${t}">
      <div class="label">${tierLabels[t]}</div>
      <div class="ob-tier-combobox" data-ob-tier-combo="${t}"></div>
      <input type="number" data-ob-tier-ctx="${t}" placeholder="auto" min="1" step="1024">
      <input type="number" data-ob-tier-compact="${t}" placeholder="auto" min="1" step="1024">
      <button type="button" class="ob-test-btn" data-ob-tier-test="${t}">test</button>
      <span class="ob-test-result" data-ob-tier-result="${t}"></span>
    </div>
  `).join('');
  container.dataset.builtTiers = tiers.join(',');
  container.querySelectorAll('[data-ob-tier-test]').forEach(btn => {
    btn.addEventListener('click', () => _obTestTier(btn.dataset.obTierTest));
  });
  // Mount the combobox per tier.
  if (window.ModelLibrary?.attachTierCombobox) {
    container.querySelectorAll('[data-ob-tier-combo]').forEach(slot => {
      const tier = slot.dataset.obTierCombo;
      const initial = _obTierValues[tier] || { provider: 'anthropic', modelId: '' };
      const combo = window.ModelLibrary.attachTierCombobox(slot, {
        value: initial,
        placeholder: `Pick a ${tierLabels[tier].replace(/\s\*$/, '')} model`,
        getEntries: () => _obWizardEntries(),
        onChange: ({ provider, modelId, libraryEntry }) => {
          _obTierValues[tier] = { provider, modelId };
          _obAutoFillEmptyTiers(tier);
          _obPrefillTierCtx(tier);
          // If the user picked a library entry with ctx metadata,
          // also pre-fill the row's ctx input.
          if (libraryEntry?.contextWindow) {
            const ctxInp = document.querySelector(`[data-ob-tier-ctx="${tier}"]`);
            if (ctxInp && !ctxInp.value) ctxInp.value = libraryEntry.contextWindow;
          }
        },
      });
      slot._comboInstance = combo;
    });
    // First render: if there's exactly one configured model AND no
    // tier has a value yet, default every tier to that single model.
    _obAutoFillFromSingleModel();
    // Refresh visible value displays for any tier that already has
    // a value in _obTierValues (e.g. coming back from later steps).
    container.querySelectorAll('[data-ob-tier-combo]').forEach(slot => {
      const tier = slot.dataset.obTierCombo;
      const v = _obTierValues[tier];
      if (v && v.modelId) slot._comboInstance?.setValue(v);
    });
  }
}

/**
 * Persistent per-tier value map for the wizard. Replaces the DOM-side
 * hidden <select>s — _obCollectPayload reads from this instead.
 *   _obTierValues[tier] = { provider, modelId } | undefined
 */
const _obTierValues = {};

/**
 * If only one model is configured across all providers AND every tier
 * is empty, default every tier to that one model. Called once at the
 * top of step 6's render — gives the easy single-model setup the
 * user expected.
 */
function _obAutoFillFromSingleModel() {
  const entries = _obWizardEntries();
  if (entries.length !== 1) return;
  const anyTierSet = Object.values(_obTierValues).some(v => v && v.modelId);
  if (anyTierSet) return;
  const only = entries[0];
  const tiers = [...OB_MODEL_TIERS.main, ...OB_MODEL_TIERS.vlm].map(t => t.id);
  for (const t of tiers) {
    _obTierValues[t] = { provider: only.provider, modelId: only.modelId };
  }
}

/**
 * After the user picks the only configured model in any tier, fill any
 * OTHER tier that's still empty with the same value. Avoids the
 * single-model footgun without making a multi-provider setup look like
 * only one provider is available.
 */
function _obAutoFillEmptyTiers(sourceTier) {
  if (_obWizardEntries().length !== 1) return;
  const v = _obTierValues[sourceTier];
  if (!v || !v.modelId) return;
  const tiers = [...OB_MODEL_TIERS.main, ...OB_MODEL_TIERS.vlm].map(t => t.id);
  let changed = false;
  for (const t of tiers) {
    if (t === sourceTier) continue;
    if (_obTierValues[t]?.modelId) continue;
    _obTierValues[t] = { ...v };
    changed = true;
  }
  if (changed) {
    document.querySelectorAll('[data-ob-tier-combo]').forEach(slot => {
      const t = slot.dataset.obTierCombo;
      if (t === sourceTier) return;
      const tv = _obTierValues[t];
      if (tv) slot._comboInstance?.setValue(tv);
    });
  }
}

/**
 * Aggregate the wizard's in-memory model knowledge into the shape
 * the combobox expects: [{ provider, modelId, contextWindow,
 * capabilities, enabled }]. Sources:
 *
 *   - _obKnownModelLimits — full refs from the "Populate" probe in
 *     step 5 (the richest source — has ctx + capabilities)
 *   - _obAllConfiguredModels() — model ids the operator pasted into
 *     the textareas, even without a probe (no ctx)
 */
function _obWizardEntries() {
  const out = [];
  const seen = new Set();
  const grouped = _obAllConfiguredModels();
  const isStillConfigured = (provider, modelId) => {
    const ids = grouped[provider] || [];
    return ids.includes(modelId);
  };
  // Probed (rich)
  for (const ref of Object.keys(_obKnownModelLimits || {})) {
    if (seen.has(ref)) continue;
    const slash = ref.indexOf('/');
    const provider = slash > 0 ? ref.slice(0, slash).toLowerCase() : 'anthropic';
    const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
    if (!isStillConfigured(provider, modelId)) continue;
    seen.add(ref);
    const meta = _obKnownModelLimits[ref] || {};
    out.push({
      provider, modelId,
      contextWindow: meta.contextLength || null,
      capabilities: meta.capabilities || {},
      enabled: true,
    });
  }
  // Pasted (no ctx)
  for (const [provider, ids] of Object.entries(grouped || {})) {
    for (const modelId of ids) {
      const ref = _obModelRef(provider, modelId);
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ provider, modelId, contextWindow: null, capabilities: {}, enabled: true });
    }
  }
  return out;
}
function _obRefreshTierComboboxes() {
  document.querySelectorAll('[data-ob-tier-combo]').forEach(slot => {
    slot._comboInstance?.refresh?.();
  });
}
// Legacy hook — provider/model state moved to _obTierValues +
// combobox. Keep it as a refresh bridge for older callers.
function _obSyncTierProviderOptions() { _obRefreshTierComboboxes(); }
// _obSyncTierModelOptions removed in Phase 3 — tier values now live
// in _obTierValues (in-memory map) and the combobox renders directly
// from _obWizardEntries(). Provider sync stays for legacy callers that
// might still expect the no-op.
function _obSyncTierModelOptions(_tier) { /* legacy no-op */ }

// Track which tier inputs were auto-prefilled so we can safely replace them
// when the model changes. Manual user edits are preserved.
const _obAutoFilledCtx = new Set();
const OB_DEFAULT_CTX = 200000;
function _obPrefillTierCtx(tier) {
  const ctxInput = document.querySelector(`[data-ob-tier-ctx="${tier}"]`);
  const compactInput = document.querySelector(`[data-ob-tier-compact="${tier}"]`);
  if (!ctxInput) return;
  const tv = _obTierValues[tier] || {};
  const provId = tv.provider || '';
  const modelId = tv.modelId || '';
  const ref = _obModelRef(provId, modelId);
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
      const cur = _obTierValues[tier] || {};
      const r = _obModelRef(cur.provider, cur.modelId);
      const expected = _obKnownModelLimits[r]?.contextLength ?? null;
      if (Number(ctxInput.value) !== expected) _obAutoFilledCtx.delete(tier);
      const eff = Number(ctxInput.value) > 0 ? Number(ctxInput.value) : OB_DEFAULT_CTX;
      if (compactInput) compactInput.placeholder = `${Math.floor(eff * 0.85).toLocaleString()} (85%)`;
    });
  }
}
async function _obTestTier(tier) {
  const out = document.querySelector(`[data-ob-tier-result="${tier}"]`);
  const btn = document.querySelector(`[data-ob-tier-test="${tier}"]`);
  const tv = _obTierValues[tier] || {};
  const provider = tv.provider;
  const model = (tv.modelId || '').trim();
  if (!provider || !model) { out.className = 'ob-test-result err'; out.textContent = 'provider + model required'; return; }
  btn.disabled = true; out.className = 'ob-test-result'; out.textContent = '…';
  const providers = { __plugins: {} };
  for (const p of OB_PROVIDERS) {
    const values = _obReadProvider(p.id);
    providers[p.id] = values;
    const pluginId = OB_TILE_TO_PLUGIN[p.id];
    if (pluginId) providers.__plugins[pluginId] = values;
  }
  if (Object.keys(providers.__plugins).length === 0) delete providers.__plugins;
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
    err('ob-account-error', '');
    // Hold the credentials in client memory only — they're submitted
    // to the server as part of the final /api/onboarding/complete
    // payload. Avoids creating a half-account on disk if the operator
    // bails mid-wizard. The server uses these to bootstrap the
    // operator's webapp user + session at finish time.
    _obData.account = { username: u, password: p1 };
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
    const planner = (_obTierValues.planner?.modelId || '').trim();
    if (!planner) { err('ob-models-error', 'Planner model is required.'); return; }
    err('ob-models-error', '');
  }
  if (_obMode === 'operator' && key === 'a') {
    _obSnapshotAgentEffortStep();
  }
  if (_obMode === 'operator' && key === 'e') {
    _obSnapshotEmbeddingStep();
    if (_obData.embeddingChoice === 'gemini' && !_obExistingGeminiKey()) {
      err('ob-embedding-error', 'Enter a Gemini API key here, or configure the Gemini provider in the provider step.');
      return;
    }
    err('ob-embedding-error', '');
  }
  if (_obMode === 'operator' && key === '9') {
    _obSnapshotBrowserStep();
  }
  if (_obMode === 'operator' && key === 'c') {
    _obSnapshotSporeCodeStep();
  }
  if (_obMode === 'operator' && key === 'ch') {
    _obSnapshotChannelsStep();
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
  // Final pass: collect feature-specific steps even if the user
  // navigated back/forward and changed a value after its Next handler
  // last ran.
  try { _obSnapshotEmbeddingStep(); } catch { /* step not mounted */ }
  try { _obSnapshotAgentEffortStep(); } catch { /* step not mounted */ }
  try { _obSnapshotBrowserStep(); } catch { /* step not mounted */ }
  try { _obSnapshotSporeCodeStep(); } catch { /* step not mounted */ }
  try { _obSnapshotChannelsStep(); } catch { /* plugin cache not loaded */ }
  try { _obSnapshotPluginPicker(); } catch { /* plugin cache not loaded */ }

  const displayName = document.getElementById('ob-display-name').value.trim();
  const nicknames = document.getElementById('ob-nicknames').value.split(',').map(s => s.trim()).filter(Boolean);
  // Plugin selections — collected by _obSnapshotPluginPicker on Next-from-step-p.
  // Wizard sends `pluginActions: { disabled: [...], configs: { id: {...} } }`.
  // Key is intentionally NOT `plugins`: the server's _persistSettingsPatch
  // body.plugins handler treats every top-level key as a plugin id, and
  // would write `disabled` and `configs` as synthetic plugin slots in
  // spore.json. Renaming keeps the wizard's intent-based payload (install
  // these / disable those) separate from per-plugin slot patches.
  const pluginActionsPayload = { disabled: [], configs: {} };
  const providers = {};
  for (const entry of _obProviderEntries) {
    if (entry.kind !== 'builtin') continue;
    const vals = _obReadProvider(entry.id);
    const hasConfig = Object.entries(vals).some(([key, value]) => !['models', 'authHeader', 'referer'].includes(key) && !!String(value || '').trim());
    if (!hasConfig) continue;
    providers[entry.id] = vals;
    const pluginId = OB_TILE_TO_PLUGIN[entry.id];
    if (pluginId) {
      const cfg = {};
      for (const [key, value] of Object.entries(vals)) {
        if (key === 'models') continue;
        const trimmed = String(value || '').trim();
        if (!trimmed) continue;
        cfg[key] = trimmed;
      }
      if (Object.keys(cfg).length) {
        pluginActionsPayload.configs[pluginId] = { ...(pluginActionsPayload.configs[pluginId] || {}), ...cfg };
      }
    }
  }
  const customProviders = _obReadCustomProviders();
  if (customProviders.length > 0) providers.custom = customProviders;
  if (_obData.embeddingChoice === 'gemini' && _obData.embeddingGeminiApiKey) {
    providers.gemini = { ...(providers.gemini || {}), apiKey: _obData.embeddingGeminiApiKey };
  }
  // When empty, omit the `custom` key entirely so _persistSettingsPatch leaves
  // existing custom providers alone instead of wiping them.
  const models = {};
  const modelLimits = {};
  const tiers = [...OB_MODEL_TIERS.main, ...OB_MODEL_TIERS.vlm].map(t => t.id);
  for (const t of tiers) {
    const tv = _obTierValues[t];
    const prov = (tv?.provider || '').trim();
    const model = (tv?.modelId || '').trim();
    if (!model) continue;
    models[t] = { provider: prov || 'anthropic', model };
    const ctx = parseInt(document.querySelector(`[data-ob-tier-ctx="${t}"]`)?.value, 10);
    const cmp = parseInt(document.querySelector(`[data-ob-tier-compact="${t}"]`)?.value, 10);
    if (ctx > 0 || cmp > 0) {
      // Key by full model ref (provider/model) so multiple tiers sharing a model share limits.
      const key = _obModelRef(prov, model);
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
  const searchChoice = document.querySelector('input[name="ob-search"]:checked')?.value || 'searxng';
  const useSearx = searchChoice === 'searxng' || searchChoice === 'both';
  const useBrave = searchChoice === 'brave' || searchChoice === 'both';
  const webSearch = {
    searxngUrl: useSearx ? document.getElementById('ob-searxng-url').value.trim() : '',
    searxngApiKey: useSearx ? document.getElementById('ob-searxng-key').value.trim() : '',
    braveApiKey: useBrave ? document.getElementById('ob-brave-key').value.trim() : '',
  };
  const browserBackend = _obData.browserBackend || document.querySelector('input[name="ob-browser"]:checked')?.value || 'zendriver';
  for (const [id, sel] of Object.entries(_obData.plugins || {})) {
    if (!sel.enabled) pluginActionsPayload.disabled.push(id);
    else if (sel.config && Object.keys(sel.config).length > 0) {
      pluginActionsPayload.configs[id] = { ...(pluginActionsPayload.configs[id] || {}), ...sel.config };
    }
  }
  return {
    theme: _obData.theme,
    displayName, nicknames,
    providers, models, modelLimits, voice, webSearch,
    enhancedRecall: !!_obData.enhancedRecall,
    agentEffort: _obData.agentEffort || 'balanced',
    embedder: _obData.embedder,
    browser: { backend: browserBackend },
    ensureInviteKey: _obData.sporeCodeEnabled === true,
    pluginActions: pluginActionsPayload,
    // Operator credentials — only present in operator mode. The
    // server creates the webapp user + session inline at finish
    // time and sets the cookie. Lets the wizard be transactional:
    // bailing mid-flow leaves nothing on disk.
    account: (_obMode === 'operator' && _obData.account && _obData.account.username && _obData.account.password)
      ? { username: _obData.account.username, password: _obData.account.password }
      : undefined,
  };
}

/**
 * Push every model the operator populated during step 5 into the
 * persistent library. Mirrors the wizard's _obKnownModelLimits cache
 * (full ref → { contextLength, maxOutput?, capabilities? }) into
 * /api/models/library entries so the post-wizard Settings → Models
 * pane is populated and tier rows light up with metadata.
 *
 * Idempotent: the backend's add(upsert: false) returns created=false
 * for duplicates, so re-runs after a partial wizard re-launch don't
 * double-write.
 */
async function _obSeedLibraryFromWizard() {
  const refs = Object.keys(_obKnownModelLimits || {});
  if (!refs.length) return;
  for (const ref of refs) {
    const slash = ref.indexOf('/');
    const provider = slash > 0 ? ref.slice(0, slash).toLowerCase() : 'anthropic';
    const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
    const meta = _obKnownModelLimits[ref] || {};
    const payload = {
      provider, modelId,
      contextWindow: meta.contextLength || null,
      maxOutput: meta.maxOutput || null,
      capabilities: meta.capabilities || {},
      source: 'auto',
    };
    try {
      await fetch(API + '/api/models/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch { /* best effort; log already happens at a higher level */ }
  }
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
    if (d.secrets?.inviteKey) {
      try { sessionStorage.setItem('spore-onboarding-invite-key', d.secrets.inviteKey); } catch {}
    }
    // Seed the curated model library from the wizard's known-models
    // cache. Each model the operator populated during step 5 lands as
    // a library row so the post-wizard Settings → Models pane is
    // already populated and the tier dropdowns have rich metadata.
    // Best-effort: failure here doesn't roll back the wizard finish.
    try { await _obSeedLibraryFromWizard(); } catch (e) {
      console.warn('[wizard] library seed failed:', e?.message || e);
    }
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
  document.getElementById('ob-subtitle').textContent = `Welcome to ${(window.BRAND?.Agent || 'Spore Core')}.`;
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
