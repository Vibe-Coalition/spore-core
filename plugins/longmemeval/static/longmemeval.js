// longmemeval.js — LongMemEval benchmark UI (operator-only).
//
// Self-installing plugin asset: injects the floating pane HTML, plugin
// CSS, and exposes `window.__lmeOpen()` so the settings-pane button
// (and any future dock item) can launch it. Runs once when graph-viewer
// fetches the manifest at /api/plugins/frontend-assets and inserts a
// <script> tag for this file.
//
// The pane uses the standard floating-window pattern (.rp-pane +
// .floating-pane-head + .floating-pane-body). It registers itself with
// the host's _floatingWindowDefaults map so it gets the same drag /
// resize / maximize / position-persist behaviour as Node, Files, Logs,
// Skills, Terminal — i.e. _initFloatingWindow handles all of that.
//
// Server-side talks to it via:
//   • POST  /api/plugins/longmemeval/run        — start
//   • GET   /api/plugins/longmemeval/status     — current phase/progress
//   • GET   /api/plugins/longmemeval/results    — last run's saved JSON
//   • POST  /api/plugins/longmemeval/cancel     — stop + restore graph
//   • WS    benchmark:{start,progress,question,done,error}
//     (chat.js's WS dispatch routes these to handleBenchmarkWs below)

(function installLmePane() {
  // Operator-only — webapp / guest users don't see the pane. Both
  // 'creator' and 'admin' are treated as the operator role across
  // the rest of the app.
  if (typeof _userRole !== 'undefined' && _userRole !== 'admin' && _userRole !== 'creator') return;
  if (document.getElementById('lme-pane')) return;

  // Plugin-internal styles only. The window chrome (background,
  // border, drag handle, resize, z-index) comes from .rp-pane /
  // .floating-pane-* in panes.css.
  const css = `
  #lme-pane { width: 360px; height: min(640px, calc(100vh - 80px)); min-width: 280px; min-height: 320px; }
  #lme-pane .lme-body-scroll { padding: 12px 14px; overflow-y: auto; flex: 1; min-height: 0; }
  .lme-select, .lme-input { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:5px 8px; border-radius:5px; font-family:inherit; font-size:.7rem; width:100%; box-sizing:border-box; }
  .lme-select:focus, .lme-input:focus { outline:none; border-color:var(--accent); }
  .lme-row { display:flex; gap:8px; align-items:center; margin-bottom:6px; }
  .lme-row label { font-size:.62rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-dim); font-weight:600; min-width:52px; flex-shrink:0; }
  .lme-btn { padding:5px 14px; border:none; border-radius:5px; font-family:inherit; font-size:.7rem; cursor:pointer; font-weight:600; transition:opacity .15s, filter .15s; }
  .lme-btn-go { background:var(--text-bright); color:var(--bg); }
  .lme-btn-go:hover { opacity:.85; filter:brightness(1.15); }
  .lme-btn-stop { background:var(--danger,#ef4444); color:#fff; }
  .lme-btn-stop:hover { filter:brightness(1.15); }
  .lme-chip { display:inline-flex; align-items:center; gap:3px; font-size:.58rem !important; min-width:auto !important; padding:2px 7px; border-radius:4px; border:1px solid var(--border); cursor:pointer; transition:all .15s; text-transform:none !important; font-weight:500 !important; }
  .lme-chip:has(input:checked) { background:var(--accent2); border-color:var(--accent2); color:var(--bg); }
  .lme-chip input { display:none; }
  .lme-cost { font-size:.6rem; color:var(--text-dim); margin:6px 0 8px; }
  .lme-bar { width:100%; height:6px; background:var(--bg); border-radius:3px; overflow:hidden; margin:6px 0; }
  .lme-bar-fill { height:100%; background:var(--accent); border-radius:3px; transition:width .3s; }
  .lme-phase-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
  .lme-phase { font-size:.62rem; text-transform:uppercase; letter-spacing:.05em; color:var(--accent); font-weight:700; }
  .lme-pct { font-size:.62rem; color:var(--text-dim); }
  .lme-stats { display:flex; gap:10px; margin:6px 0; flex-wrap:wrap; }
  .lme-st { text-align:center; flex:1; min-width:55px; }
  .lme-st-v { font-size:1rem; font-weight:700; line-height:1.2; }
  .lme-st-v.good { color:#22c55e; }
  .lme-st-v.ok { color:#eab308; }
  .lme-st-v.bad { color:#ef4444; }
  .lme-st-l { font-size:.55rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-dim); }
  .lme-log { max-height:160px; overflow-y:auto; font-size:.58rem; color:var(--text-dim); border-top:1px solid var(--border); margin-top:6px; padding-top:6px; }
  .lme-log-line { padding:1px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lme-log-line.pass { color:#22c55e; }
  .lme-log-line.fail { color:#ef4444; }
  .lme-cat-table { width:100%; border-collapse:collapse; font-size:.6rem; margin:4px 0; }
  .lme-cat-table th { text-align:left; padding:2px 5px; font-size:.5rem; text-transform:uppercase; color:var(--text-dim); letter-spacing:.03em; border-bottom:1px solid var(--border); }
  .lme-cat-table td { padding:2px 5px; border-bottom:1px solid rgba(var(--hl-rgb),.04); }
  .lme-cat-table .cat-acc { font-weight:700; text-align:right; }
  .lme-cat-table .cat-acc.good { color:#22c55e; }
  .lme-cat-table .cat-acc.ok { color:#eab308; }
  .lme-cat-table .cat-acc.bad { color:#ef4444; }
  .lme-eff-row { display:flex; gap:6px; margin:6px 0; flex-wrap:wrap; }
  .lme-eff { text-align:center; flex:1; min-width:55px; }
  .lme-eff-v { font-size:.75rem; font-weight:700; line-height:1.2; color:var(--text); }
  .lme-eff-l { font-size:.48rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-dim); }
  .lme-elapsed { font-size:.6rem; color:var(--text-dim); font-variant-numeric:tabular-nums; margin-right:8px; }
  .lme-results-table { width:100%; border-collapse:collapse; margin:6px 0; font-size:.65rem; }
  .lme-results-table th { text-align:left; padding:4px 6px; border-bottom:1px solid var(--border); font-size:.55rem; text-transform:uppercase; color:var(--text-dim); }
  .lme-results-table td { padding:3px 6px; border-bottom:1px solid var(--border); }
  .lme-results-table .pass-rate { font-weight:700; }
  .lme-hero { text-align:center; padding:8px 0; }
  .lme-hero .pct { font-size:2rem; font-weight:900; letter-spacing:-.03em; }
  .lme-hero .pct.good { color:#22c55e; }
  .lme-hero .pct.ok { color:#eab308; }
  .lme-hero .pct.bad { color:#ef4444; }
  .lme-hero .sub { font-size:.6rem; color:var(--text-dim); }
  .lme-section { margin: 10px 0; }
  .lme-section > label { font-size:.55rem; text-transform:uppercase; letter-spacing:.05em; color:var(--text-dim); display:block; margin-bottom:4px; }
  .lme-ref-bar { display:flex; align-items:center; gap:6px; margin:2px 0; font-size:.6rem; }
  .lme-ref-bar .bar-track { flex:1; height:8px; background:var(--bg); border-radius:3px; overflow:hidden; max-width:140px; }
  .lme-ref-bar .bar-fill { height:100%; border-radius:3px; }
  .lme-ref-bar .bar-label { width:120px; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lme-ref-bar .bar-val { font-weight:600; width:42px; text-align:right; }`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  styleEl.setAttribute('data-plugin', 'longmemeval');
  document.head.appendChild(styleEl);

  // SVG glyphs match the rest of the floating-pane buttons (see
  // panels.js _updateFloatingWindowChrome for the canonical icons).
  const maxIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/></svg>';
  const closeIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';

  const html = `
    <div class="rp-pane" id="lme-pane">
      <div class="floating-pane-head">
        <span class="floating-pane-title">LongMemEval</span>
        <div class="floating-pane-actions">
          <button class="floating-pane-btn" type="button" data-window-action="maximize" title="Maximize" aria-label="Maximize">${maxIcon}</button>
          <button class="floating-pane-btn" type="button" data-lme-close="1" title="Close" aria-label="Close">${closeIcon}</button>
        </div>
      </div>
      <div class="floating-pane-body">
        <div class="lme-body-scroll">
          <div id="lme-config">
            <div class="lme-row"><label>Mode</label><select class="lme-select" id="lme-mode"><option value="focused" selected>Focused slice (10 sessions / 50 Q)</option><option value="standard">Standard LongMemEval</option></select></div>
            <div class="lme-row"><label>Variant</label><select class="lme-select" id="lme-variant"><option value="oracle" selected>Oracle (~15 MB)</option><option value="s">Small (~277 MB)</option><option value="m">Medium (~2.7 GB)</option></select></div>
            <div class="lme-row"><label>Max Q</label><input type="number" class="lme-input" id="lme-max-q" value="50" min="1" max="500" style="width:70px"><span id="lme-q-note" style="font-size:.6rem;color:var(--text-dim)">focused cap</span></div>
            <div class="lme-row" id="lme-session-cap-row"><label>Max sessions</label><input type="number" class="lme-input" id="lme-max-sessions" value="10" min="1" max="100" style="width:70px"><span style="font-size:.6rem;color:var(--text-dim)">shared haystack sessions</span></div>
            <div class="lme-row" style="flex-wrap:wrap;gap:4px"><label style="width:100%">Question Types</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="temporal-reasoning" checked> Temporal</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="multi-session" checked> Multi-session</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="knowledge-update" checked> Knowledge Update</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="single-session-user" checked> Single User</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="single-session-assistant" checked> Single Asst</label>
              <label class="lme-chip"><input type="checkbox" class="lme-type-cb" value="single-session-preference" checked> Preferences</label>
            </div>
            <div class="lme-row"><label>Learner</label><select class="lme-select" id="lme-learner-model"><option value="">Loading models…</option></select></div>
            <div class="lme-row"><label>Answering</label><select class="lme-select" id="lme-answer-model"><option value="">Loading models…</option></select></div>
            <div class="lme-row"><label><input type="checkbox" id="lme-eval-only"> Eval only (skip ingestion)</label></div>
            <div class="lme-row"><label><input type="checkbox" id="lme-force-reeval"> Fresh eval (ignore cached answers)</label></div>
            <div class="lme-row" id="lme-er-status" style="font-size:.65rem;color:var(--text-dim)"></div>
            <div class="lme-cost" id="lme-cost-est">~$3-5 &bull; ~30-45 min (oracle)</div>
            <div class="lme-row" style="margin-top:4px"><button class="lme-btn lme-btn-go" id="lme-start-btn">Start</button></div>
          </div>
          <div id="lme-progress" style="display:none">
            <div class="lme-phase-row">
              <span class="lme-phase" id="lme-phase-label">STARTING</span>
              <span class="lme-elapsed" id="lme-elapsed">00:00</span>
            </div>
            <div class="lme-bar"><div class="lme-bar-fill" id="lme-bar" style="width:0%"></div></div>
            <div class="lme-pct" id="lme-pct-label">0 / 0</div>
            <div class="lme-stats">
              <div class="lme-st"><div class="lme-st-v" id="lme-st-sessions">0</div><div class="lme-st-l">Sessions</div></div>
              <div class="lme-st"><div class="lme-st-v" id="lme-st-nodes">0</div><div class="lme-st-l">Nodes</div></div>
              <div class="lme-st"><div class="lme-st-v" id="lme-st-questions">0</div><div class="lme-st-l">Answered</div></div>
              <div class="lme-st"><div class="lme-st-v" id="lme-st-accuracy">--</div><div class="lme-st-l">Accuracy</div></div>
            </div>
            <table class="lme-cat-table" id="lme-cat-table">
              <thead><tr><th>Category</th><th>Pass</th><th style="text-align:right">Acc</th></tr></thead>
              <tbody id="lme-cat-tbody"></tbody>
            </table>
            <div class="lme-eff-row">
              <div class="lme-eff"><div class="lme-eff-v" id="lme-eff-latency">--</div><div class="lme-eff-l">Avg lat</div></div>
              <div class="lme-eff"><div class="lme-eff-v" id="lme-eff-input">--</div><div class="lme-eff-l">In tok</div></div>
              <div class="lme-eff"><div class="lme-eff-v" id="lme-eff-output">--</div><div class="lme-eff-l">Out tok</div></div>
              <div class="lme-eff"><div class="lme-eff-v" id="lme-eff-cost">--</div><div class="lme-eff-l">Est cost</div></div>
            </div>
            <div class="lme-log" id="lme-log"></div>
            <div style="margin-top:6px"><button class="lme-btn lme-btn-stop" id="lme-cancel-btn">Cancel</button></div>
          </div>
          <div id="lme-results" style="display:none"></div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);

  // Register the pane's default rect so _initFloatingWindow places it
  // in the top-right by default. Anchored to right (left:null) with
  // an 18px right offset matches chat-panel's pattern.
  if (typeof _floatingWindowDefaults !== 'undefined') {
    _floatingWindowDefaults['lme-pane'] = {
      left: null,
      top: 60,
      width: 380,
      height: Math.min(window.innerHeight - 100, 640),
      rightOffset: 18,
    };
  }

  // Wire the standard floating-window behaviour (drag / maximize /
  // resize / z-stack focus / position-persist). We let the host handle
  // everything except close — its built-in close calls closeRightPanel
  // which has side effects on the right-sidebar state machine, and
  // this pane isn't part of that. Our own close button (data-lme-close)
  // just removes window-open.
  if (typeof _initFloatingWindow === 'function') {
    _initFloatingWindow('lme-pane', '.floating-pane-head');
  }
  document.querySelector('#lme-pane [data-lme-close]')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    lmeClose();
  });
  // Wire form buttons (replaces the old inline onclick="lmeStart()" etc.)
  document.getElementById('lme-start-btn')?.addEventListener('click', lmeStart);
  document.getElementById('lme-cancel-btn')?.addEventListener('click', lmeCancel);
  document.getElementById('lme-mode')?.addEventListener('change', lmeUpdateModeDefaults);
  document.getElementById('lme-variant')?.addEventListener('change', lmeUpdateCostEst);
  document.getElementById('lme-max-sessions')?.addEventListener('input', lmeUpdateCostEst);
  document.getElementById('lme-learner-model')?.addEventListener('change', lmeUpdateCostEst);
  document.getElementById('lme-answer-model')?.addEventListener('change', lmeUpdateCostEst);
  lmeUpdateModeDefaults();
})();

// Stable name for the settings-pane button (and any future dock item).
window.__lmeOpen = function () { try { lmeOpen(); } catch (e) { console.warn('[lme]', e); } };

// Settings-pane "Run benchmark" button — wire on render so it works
// even after a dynamic install/uninstall (the pane gets re-rendered
// without a page reload). The inline onclick in pane.html is a backup.
function _lmeWireSettingsButton() {
  const root = document.querySelector('[data-plugin-pane="longmemeval"], [data-plugin-custom="longmemeval"]');
  if (!root) return;
  const btn = Array.from(root.querySelectorAll('button')).find(b => /run benchmark/i.test(b.textContent || ''));
  if (!btn || btn.dataset.lmeWired) return;
  btn.dataset.lmeWired = '1';
  btn.addEventListener('click', (ev) => { ev.preventDefault(); window.__lmeOpen(); });
}
document.addEventListener('spore-plugin-panes-rendered', () => {
  _lmeWireSettingsButton();
  // Settings was just rendered → operator may have changed providers.
  // Drop the cached model list so the next HUD open re-fetches.
  _lmeModelsCache = null;
});
setTimeout(_lmeWireSettingsButton, 0);

// ── State + open/close ──
const _lme = {
  running: false, passCount: 0, totalJudged: 0, logLines: 0,
  byType: {}, totalInputTokens: 0, totalOutputTokens: 0, totalLatencyMs: 0,
  startedAt: null, elapsedTimer: null,
};

function lmeOpen() {
  const pane = document.getElementById('lme-pane');
  if (!pane) { console.warn('[lme] pane not installed (asset gated by user role)'); return; }
  // Close Settings — user just told the system to do something with the
  // pane, so put it in front instead of behind the modal.
  const settings = document.getElementById('settings-pane');
  if (settings && settings.classList.contains('settings-pane-open')) {
    settings.classList.remove('settings-pane-open');
  }
  pane.classList.add('window-open');
  if (typeof _focusFloatingWindow === 'function') _focusFloatingWindow('lme-pane');

  if (!_lme.running) {
    // Show the form immediately. If a previous run's saved results
    // come back from /results we swap to the results view; if not
    // (empty / 401 / network error) the form stays up.
    document.getElementById('lme-config').style.display = '';
    document.getElementById('lme-progress').style.display = 'none';
    document.getElementById('lme-results').style.display = 'none';
    const erEl = document.getElementById('lme-er-status');
    if (erEl) {
      const erOn = (typeof _erEnabled !== 'undefined') && _erEnabled;
      erEl.textContent = erOn
        ? '\u{1F9E0} Enhanced Recall is ON — LLM query decomposition active'
        : '⚠️ Enhanced Recall is OFF — toggle it on in the tools menu for best results';
      erEl.style.color = erOn ? 'var(--accent2)' : 'var(--text-dim)';
    }
    lmeLoadModels();
    lmeUpdateCostEst();
    fetch(API + '/api/plugins/longmemeval/results', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        if (data && !data.empty && data.scores) {
          document.getElementById('lme-config').style.display = 'none';
          lmeRenderResults(data.scores, data.elapsed, data.stats);
          const container = document.getElementById('lme-results');
          const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : '';
          container.insertAdjacentHTML('afterbegin',
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
            + '<span style="font-size:.55rem;color:var(--text-dim)">Last run: ' + ts + '</span>'
            + '<button class="lme-btn lme-btn-go" id="lme-new-run-btn" style="font-size:.6rem;padding:3px 10px">New Run</button>'
            + '</div>'
          );
          document.getElementById('lme-new-run-btn')?.addEventListener('click', lmeShowConfig);
        }
      })
      .catch(() => { /* form is already showing */ });
  } else {
    // A run is in progress; pick up the live status so the user sees
    // current state instead of a frozen UI snapshot.
    fetch(API + '/api/plugins/longmemeval/status', { headers: authHeaders() })
      .then(r => r.json())
      .then(s => {
        if (s && s.phase && s.phase !== 'idle') {
          document.getElementById('lme-config').style.display = 'none';
          document.getElementById('lme-progress').style.display = '';
          if (s.phase) document.getElementById('lme-phase-label').textContent = String(s.phase).toUpperCase();
        }
      })
      .catch(() => {});
  }
}

function lmeShowConfig() {
  document.getElementById('lme-config').style.display = '';
  document.getElementById('lme-results').style.display = 'none';
  const erEl = document.getElementById('lme-er-status');
  if (erEl) {
    const erOn = (typeof _erEnabled !== 'undefined') && _erEnabled;
    erEl.textContent = erOn
      ? '\u{1F9E0} Enhanced Recall is ON — LLM query decomposition active'
      : '⚠️ Enhanced Recall is OFF — toggle it on in the tools menu for best results';
    erEl.style.color = erOn ? 'var(--accent2)' : 'var(--text-dim)';
  }
  lmeLoadModels();
  lmeUpdateCostEst();
}

// Cache so we don't refetch on every open. Cleared on hot install /
// uninstall by listening for the panes-rendered event below — that
// fires whenever Settings is opened, which is also when the operator
// is most likely to have changed providers.
let _lmeModelsCache = null;

function lmeLoadModels() {
  // Re-render from cache instantly, then background-refresh.
  if (_lmeModelsCache) lmeRenderModelOptions(_lmeModelsCache);
  fetch(API + '/api/plugins/longmemeval/available-models', { headers: authHeaders() })
    .then(r => r.json())
    .then(data => {
      if (!data || data.error) {
        if (!_lmeModelsCache) {
          // Fall back: keep the placeholder so the user knows something's
          // wrong, plus a single "use default" option that sends '' on /run
          // (the runner will fall back to config.casualModel server-side).
          for (const id of ['lme-learner-model', 'lme-answer-model']) {
            const sel = document.getElementById(id);
            if (sel) sel.innerHTML = '<option value="">(use server default)</option>';
          }
        }
        return;
      }
      _lmeModelsCache = data;
      lmeRenderModelOptions(data);
    })
    .catch(() => { /* offline / 401 — keep whatever's there */ });
}

function lmeRenderModelOptions(data) {
  const models = data?.models || [];
  const current = data?.current || {};
  // Group by provider for <optgroup>.
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, { label: m.label || m.provider, items: [] });
    byProvider.get(m.provider).items.push(m);
  }
  function buildOptions(selectedRef, defaultRef) {
    const parts = [];
    if (models.length === 0) {
      parts.push('<option value="">(no providers configured)</option>');
    } else {
      // Empty value = "use the server-side default" — show what that
      // would actually be so the operator isn't picking blind. The
      // runner falls back to config.learnerModel / config.casualModel
      // when the request body's model field is empty.
      const defLabel = defaultRef ? `(server default — ${defaultRef})` : '(use server default)';
      parts.push(`<option value="">${_lmeEsc(defLabel)}</option>`);
    }
    let preselected = false;
    for (const [, group] of byProvider) {
      parts.push(`<optgroup label="${_lmeEsc(group.label)}">`);
      for (const m of group.items) {
        const sel = m.ref === selectedRef ? ' selected' : '';
        if (sel) preselected = true;
        const ctx = m.contextLength ? ` · ${(m.contextLength / 1000).toFixed(0)}k` : '';
        parts.push(`<option value="${_lmeEsc(m.ref)}"${sel}>${_lmeEsc(m.id)}${ctx}</option>`);
      }
      parts.push('</optgroup>');
    }
    // If the configured default isn't in the list (e.g. provider key
    // got removed but config.learnerModel still references it), surface
    // it explicitly so the operator can still pick something sensible.
    if (selectedRef && !preselected) {
      parts.push('<optgroup label="Configured but unavailable">');
      parts.push(`<option value="${_lmeEsc(selectedRef)}" selected>${_lmeEsc(selectedRef)} (provider not reachable)</option>`);
      parts.push('</optgroup>');
    }
    return parts.join('');
  }
  const learnerSel = document.getElementById('lme-learner-model');
  const answerSel = document.getElementById('lme-answer-model');
  const learnerDefault = current.learner || current.casual;
  const answerDefault = current.normal || current.planner || current.casual;
  if (learnerSel) learnerSel.innerHTML = buildOptions(learnerDefault, learnerDefault);
  if (answerSel) answerSel.innerHTML = buildOptions(answerDefault, answerDefault);
}

function _lmeEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

function lmeClose() {
  const pane = document.getElementById('lme-pane');
  if (!pane) return;
  pane.classList.remove('window-open');
  pane.classList.remove('window-maximized');
}

function lmeUpdateModeDefaults() {
  const mode = document.getElementById('lme-mode')?.value || 'focused';
  const q = document.getElementById('lme-max-q');
  const qNote = document.getElementById('lme-q-note');
  const sessionRow = document.getElementById('lme-session-cap-row');
  if (q && !q.dataset.userEdited) {
    q.value = mode === 'focused' ? '50' : '500';
  }
  if (q) {
    q.oninput = () => { q.dataset.userEdited = '1'; lmeUpdateCostEst(); };
  }
  if (qNote) {
    qNote.textContent = mode === 'focused'
      ? 'questions must fit inside session cap'
      : '/500 (stratified)';
  }
  if (sessionRow) sessionRow.style.display = mode === 'focused' ? '' : 'none';
  lmeUpdateCostEst();
}

function lmeUpdateCostEst() {
  const mode = document.getElementById('lme-mode')?.value || 'focused';
  const v = document.getElementById('lme-variant')?.value;
  const maxQ = parseInt(document.getElementById('lme-max-q')?.value, 10) || (mode === 'focused' ? 50 : 500);
  const maxSessions = parseInt(document.getElementById('lme-max-sessions')?.value, 10) || 10;
  const lm = (document.getElementById('lme-learner-model')?.value || '').toLowerCase();
  const am = (document.getElementById('lme-answer-model')?.value || '').toLowerCase();
  const est = document.getElementById('lme-cost-est');
  if (!est) return;
  if (mode === 'focused') {
    est.textContent = `Focused slice: up to ${maxSessions} sessions + ${maxQ} questions • usually minutes, not hours`;
    return;
  }
  const baseCalls = v === 'oracle' ? 1000 : v === 's' ? 5000 : 20000;
  const time = v === 'oracle' ? '30–45 min' : v === 's' ? '2–3 hours' : '8+ hours';
  // Cost-per-call only known for the Claude family — fall back to a
  // family-agnostic line otherwise. The runner reports actual cost in
  // the Run Stats footer once questions start coming back.
  const isClaudeFamily = (m) => /haiku|sonnet|opus/.test(m);
  if (!lm || !am || !isClaudeFamily(lm) || !isClaudeFamily(am)) {
    est.textContent = `~${baseCalls.toLocaleString()} learn + 1,000 eval calls • ~${time}`;
    return;
  }
  const lmSonnet = lm.includes('sonnet');
  const amOpus = am.includes('opus');
  const amSonnet = am.includes('sonnet');
  const learnCost = baseCalls * (lmSonnet ? 0.006 : 0.002);
  const evalCostPer = amOpus ? 0.10 : amSonnet ? 0.02 : 0.007;
  const evalCost = 500 * evalCostPer;
  const total = learnCost + evalCost;
  est.textContent = `~${baseCalls.toLocaleString()} learn + 1,000 eval calls ≈ $${total < 10 ? total.toFixed(0) : Math.round(total)}–${Math.round(total * 1.5)} • ~${time}`;
}

function lmeStart() {
  const mode = document.getElementById('lme-mode')?.value || 'focused';
  const variant = document.getElementById('lme-variant').value;
  const maxQuestions = parseInt(document.getElementById('lme-max-q').value) || 500;
  const maxSessions = parseInt(document.getElementById('lme-max-sessions')?.value, 10) || 10;
  const skipIngestion = document.getElementById('lme-eval-only').checked;
  const forceReeval = document.getElementById('lme-force-reeval').checked;
  const learnerModel = document.getElementById('lme-learner-model').value;
  const answerModel = document.getElementById('lme-answer-model').value;
  const checkedTypes = [...document.querySelectorAll('.lme-type-cb:checked')].map(cb => cb.value);
  const questionTypes = checkedTypes.length === 6 ? null : checkedTypes;

  document.getElementById('lme-config').style.display = 'none';
  document.getElementById('lme-progress').style.display = '';
  document.getElementById('lme-results').style.display = 'none';
  document.getElementById('lme-phase-label').textContent = skipIngestion ? 'EVAL ONLY' : 'STARTING';
  document.getElementById('lme-bar').style.width = '0%';
  document.getElementById('lme-pct-label').textContent = 'Initializing...';
  document.getElementById('lme-log').innerHTML = '';
  document.getElementById('lme-st-sessions').textContent = skipIngestion ? '—' : '0';
  document.getElementById('lme-st-nodes').textContent = skipIngestion ? '—' : '0';
  document.getElementById('lme-st-questions').textContent = '0';
  document.getElementById('lme-st-accuracy').textContent = '--';
  _lme.running = true;
  _lme.passCount = 0;
  _lme.totalJudged = 0;
  _lme.logLines = 0;
  _lme.byType = {};
  _lme.totalInputTokens = 0;
  _lme.totalOutputTokens = 0;
  _lme.totalLatencyMs = 0;
  _lme.startedAt = Date.now();
  if (_lme.elapsedTimer) clearInterval(_lme.elapsedTimer);
  _lme.elapsedTimer = setInterval(lmeTickElapsed, 1000);
  lmeTickElapsed();
  document.getElementById('lme-cat-tbody').innerHTML = '';
  lmeRenderEfficiency();

  fetch(API + '/api/plugins/longmemeval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mode, variant, maxQuestions, maxSessions, skipIngestion, forceReeval, learnerModel, answerModel, questionTypes }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        lmeLogLine('Error: ' + data.error, 'fail');
        _lme.running = false;
      } else {
        lmeLogLine('Benchmark started — graph: ' + data.slug);
      }
    })
    .catch(e => {
      lmeLogLine('Request failed: ' + e.message, 'fail');
      _lme.running = false;
    });
}

function lmeCancel() {
  fetch(API + '/api/plugins/longmemeval/cancel', {
    method: 'POST',
    headers: authHeaders(),
  })
    .then(r => r.json())
    .then(() => {
      _lme.running = false;
      if (_lme.elapsedTimer) { clearInterval(_lme.elapsedTimer); _lme.elapsedTimer = null; }
      lmeLogLine('Benchmark cancelled.');
    })
    .catch(() => {});
}

function lmeLogLine(text, cls) {
  const log = document.getElementById('lme-log');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'lme-log-line' + (cls ? ' ' + cls : '');
  el.textContent = text;
  log.appendChild(el);
  _lme.logLines++;
  if (_lme.logLines > 200) {
    const first = log.querySelector('.lme-log-line');
    if (first) first.remove();
  }
  log.scrollTop = log.scrollHeight;
}

function lmeTickElapsed() {
  if (!_lme.startedAt) return;
  const s = Math.floor((Date.now() - _lme.startedAt) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const el = document.getElementById('lme-elapsed');
  if (el) el.textContent = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function lmeRenderCategoryTable() {
  const tbody = document.getElementById('lme-cat-tbody');
  if (!tbody) return;
  const entries = Object.entries(_lme.byType).sort((a, b) => a[0].localeCompare(b[0]));
  let html = '';
  for (const [type, d] of entries) {
    const acc = d.total > 0 ? (d.pass / d.total * 100) : 0;
    const cls = acc >= 60 ? 'good' : acc >= 40 ? 'ok' : 'bad';
    html += '<tr><td>' + type + '</td><td>' + d.pass + '/' + d.total + '</td><td class="cat-acc ' + cls + '">' + acc.toFixed(1) + '%</td></tr>';
  }
  tbody.innerHTML = html;
}

function lmeRenderEfficiency() {
  const n = _lme.totalJudged || 0;
  const avgLat = n > 0 ? Math.round(_lme.totalLatencyMs / n) : 0;
  const totalIn = _lme.totalInputTokens;
  const totalOut = _lme.totalOutputTokens;
  const cost = (totalIn * 3 / 1e6 + totalOut * 15 / 1e6);
  const fmt = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v);
  const el = id => document.getElementById(id);
  if (el('lme-eff-latency')) el('lme-eff-latency').textContent = n > 0 ? (avgLat / 1000).toFixed(1) + 's' : '--';
  if (el('lme-eff-input')) el('lme-eff-input').textContent = n > 0 ? fmt(totalIn) : '--';
  if (el('lme-eff-output')) el('lme-eff-output').textContent = n > 0 ? fmt(totalOut) : '--';
  if (el('lme-eff-cost')) el('lme-eff-cost').textContent = n > 0 ? '$' + cost.toFixed(2) : '--';
}

// chat.js's WS dispatch routes msg.type === 'benchmark:*' here.
function handleBenchmarkWs(msg) {
  if (msg.type === 'benchmark:start') {
    if (!_lme.startedAt) {
      _lme.startedAt = Date.now();
      if (_lme.elapsedTimer) clearInterval(_lme.elapsedTimer);
      _lme.elapsedTimer = setInterval(lmeTickElapsed, 1000);
      lmeTickElapsed();
    }
    const scope = msg.mode === 'focused'
      ? `focused ${msg.maxSessions || 10} sessions / ${msg.maxQuestions || 50} questions`
      : `${msg.maxQuestions || 500} questions`;
    lmeLogLine('LongMemEval ' + (msg.variant || '') + ' — ' + scope);
  } else if (msg.type === 'benchmark:progress') {
    const phase = msg.phase || '';
    document.getElementById('lme-phase-label').textContent = phase.toUpperCase();
    if (msg.current != null && msg.total) {
      const pct = Math.round((msg.current / msg.total) * 100);
      document.getElementById('lme-bar').style.width = pct + '%';
      document.getElementById('lme-pct-label').textContent = msg.current + ' / ' + msg.total + ' (' + pct + '%)';
    }
    if (msg.message) lmeLogLine(msg.message);
    if (msg.stats) {
      if (msg.stats.sessionsIngested != null) document.getElementById('lme-st-sessions').textContent = msg.stats.sessionsIngested;
      if (msg.stats.nodesCreated != null) document.getElementById('lme-st-nodes').textContent = msg.stats.nodesCreated;
      if (msg.stats.questionsAnswered != null) document.getElementById('lme-st-questions').textContent = msg.stats.questionsAnswered;
    }
  } else if (msg.type === 'benchmark:question') {
    _lme.totalJudged++;
    if (msg.pass) _lme.passCount++;
    const accPct = _lme.totalJudged > 0 ? ((_lme.passCount / _lme.totalJudged) * 100).toFixed(1) + '%' : '--';
    const accNum = _lme.totalJudged > 0 ? (_lme.passCount / _lme.totalJudged) * 100 : 0;
    const accEl = document.getElementById('lme-st-accuracy');
    accEl.textContent = accPct;
    accEl.className = 'lme-st-v ' + (accNum >= 60 ? 'good' : accNum >= 40 ? 'ok' : 'bad');
    document.getElementById('lme-st-questions').textContent = msg.current || _lme.totalJudged;
    const pct = msg.total ? Math.round((msg.current / msg.total) * 100) : 0;
    document.getElementById('lme-bar').style.width = pct + '%';
    document.getElementById('lme-pct-label').textContent = (msg.current || _lme.totalJudged) + ' / ' + (msg.total || '?') + ' (' + pct + '%)';

    const qType = msg.questionType || 'unknown';
    if (!_lme.byType[qType]) _lme.byType[qType] = { pass: 0, total: 0 };
    _lme.byType[qType].total++;
    if (msg.pass) _lme.byType[qType].pass++;

    _lme.totalInputTokens += (msg.inputTokens || 0);
    _lme.totalOutputTokens += (msg.outputTokens || 0);
    _lme.totalLatencyMs += (msg.latencyMs || 0);

    lmeRenderCategoryTable();
    lmeRenderEfficiency();

    const tag = msg.pass ? '✓' : '✗';
    const cls = msg.pass ? 'pass' : 'fail';
    let logText = tag + ' [' + qType + '] ' + (msg.question || '').substring(0, 100);
    if (msg.latencyMs) logText += '  ⏱' + (msg.latencyMs / 1000).toFixed(1) + 's';
    lmeLogLine(logText, cls);
  } else if (msg.type === 'benchmark:done') {
    _lme.running = false;
    if (_lme.elapsedTimer) { clearInterval(_lme.elapsedTimer); _lme.elapsedTimer = null; }
    lmeRenderResults(msg.scores, msg.elapsed, msg.stats);
  } else if (msg.type === 'benchmark:error') {
    _lme.running = false;
    if (_lme.elapsedTimer) { clearInterval(_lme.elapsedTimer); _lme.elapsedTimer = null; }
    lmeLogLine('Error: ' + (msg.message || 'Unknown error'), 'fail');
  }
}

function lmeRenderResults(scores, elapsed, stats) {
  document.getElementById('lme-progress').style.display = 'none';
  const container = document.getElementById('lme-results');
  container.style.display = '';

  const overallPct = scores?.overall != null ? (scores.overall * 100).toFixed(1) : '0.0';
  const pctNum = parseFloat(overallPct);
  const pctCls = pctNum >= 60 ? 'good' : pctNum >= 40 ? 'ok' : 'bad';
  const elapsedMin = elapsed ? Math.round(elapsed / 60000) : '?';

  const refs = [
    { name: 'Hindsight (TEMPR)', pct: 91.4, color: '#e08a4e' },
    { name: 'Spore Core (this run)', pct: pctNum, color: '#7aa583' },
    { name: 'GPT-4o baseline', pct: 39.2, color: '#8a8676' },
    { name: 'Llama-3 70B', pct: 24.8, color: '#8a8676' },
  ].sort((a, b) => b.pct - a.pct);

  let refBars = '';
  for (const r of refs) {
    const isThis = r.name.includes('this run');
    const w = r.pct.toFixed(1);
    refBars += '<div class="lme-ref-bar"><span class="bar-label"' + (isThis ? ' style="font-weight:700;color:var(--text)"' : '') + '>' + r.name + '</span><div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + r.color + '"></div></div><span class="bar-val"' + (isThis ? ' style="color:' + r.color + '"' : '') + '>' + r.pct.toFixed(1) + '%</span></div>';
  }

  let typeRows = '';
  if (scores?.byType) {
    for (const [type, data] of Object.entries(scores.byType)) {
      const acc = (data.accuracy * 100).toFixed(1);
      const accNum = parseFloat(acc);
      const cls = accNum >= 60 ? 'good' : accNum >= 40 ? 'ok' : 'bad';
      typeRows += '<tr><td>' + (data.label || type) + '</td><td>' + data.pass + '/' + data.total + '</td><td class="pass-rate ' + cls + '">' + acc + '%</td></tr>';
    }
  }
  if (scores?.abstention) {
    const aAcc = (scores.abstention.accuracy * 100).toFixed(1);
    const aCls = parseFloat(aAcc) >= 60 ? 'good' : parseFloat(aAcc) >= 40 ? 'ok' : 'bad';
    typeRows += '<tr><td>Abstention</td><td>' + scores.abstention.pass + '/' + scores.abstention.total + '</td><td class="pass-rate ' + aCls + '">' + aAcc + '%</td></tr>';
  }

  container.innerHTML = ''
    + '<div class="lme-hero">'
    + '  <div class="pct ' + pctCls + '">' + overallPct + '%</div>'
    + '  <div class="sub">' + (scores?.totalPass || 0) + ' / ' + (scores?.totalQuestions || 0) + ' correct • ' + elapsedMin + ' min</div>'
    + '</div>'
    + '<div class="lme-section"><label>Comparison</label>' + refBars + '</div>'
    + '<div class="lme-section"><label>By Question Type</label>'
    + '<table class="lme-results-table"><tr><th>Type</th><th>Pass</th><th>Accuracy</th></tr>' + typeRows + '</table>'
    + '</div>'
    + '<div class="lme-section"><label>Run Stats</label>'
    + '<div class="lme-eff-row">'
    + '  <div class="lme-eff"><div class="lme-eff-v">' + (stats?.sessionsIngested || 0) + '</div><div class="lme-eff-l">Sessions</div></div>'
    + '  <div class="lme-eff"><div class="lme-eff-v">' + (stats?.nodesCreated || 0) + '</div><div class="lme-eff-l">Nodes</div></div>'
    + '  <div class="lme-eff"><div class="lme-eff-v">' + (stats?.exchangesProcessed || 0) + '</div><div class="lme-eff-l">Exchanges</div></div>'
    + '</div></div>'
    + (scores?.efficiency ? '<div class="lme-section"><label>Efficiency</label><div class="lme-eff-row">'
      + '<div class="lme-eff"><div class="lme-eff-v">' + (scores.efficiency.avgLatencyMs / 1000).toFixed(1) + 's</div><div class="lme-eff-l">Avg latency</div></div>'
      + '<div class="lme-eff"><div class="lme-eff-v">' + (scores.efficiency.totalTokens >= 1e6 ? (scores.efficiency.totalTokens / 1e6).toFixed(1) + 'M' : (scores.efficiency.totalTokens / 1e3).toFixed(0) + 'k') + '</div><div class="lme-eff-l">Total tokens</div></div>'
      + '<div class="lme-eff"><div class="lme-eff-v">$' + scores.efficiency.estimatedCostUsd.toFixed(2) + '</div><div class="lme-eff-l">Est. cost</div></div>'
    + '</div></div>' : '');
}
