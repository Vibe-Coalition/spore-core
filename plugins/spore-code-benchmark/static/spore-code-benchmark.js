// Spore Code Benchmark HUD.

(function installSporeCodeBenchmarkPane() {
  if (typeof _userRole !== 'undefined' && _userRole !== 'admin' && _userRole !== 'creator') return;

  const API = '/api/plugins/spore-code-benchmark';
  let pollTimer = null;

  function ensurePane() {
    if (document.getElementById('scb-pane')) return;
    const style = document.createElement('style');
    style.setAttribute('data-plugin', 'spore-code-benchmark');
    style.textContent = `
      #scb-pane { width: 430px; height: min(680px, calc(100vh - 80px)); min-width: 320px; min-height: 360px; }
      #scb-pane .scb-scroll { padding: 12px 14px; overflow: auto; flex: 1; min-height: 0; }
      .scb-row { display: flex; gap: 8px; align-items: center; margin: 7px 0; }
      .scb-row label { min-width: 88px; color: var(--text-dim); font-size: .64rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
      .scb-input { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 5px; padding: 5px 8px; font: inherit; font-size: .72rem; width: 90px; }
      .scb-input.wide { width: 100%; min-height: 62px; resize: vertical; }
      .scb-input:focus { outline: none; border-color: var(--accent); }
      .scb-check { min-width: auto !important; text-transform: none !important; letter-spacing: 0 !important; font-size: .72rem !important; font-weight: 500 !important; }
      .scb-actions { display: flex; gap: 8px; margin: 10px 0; }
      .scb-btn { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 5px; padding: 6px 11px; font: inherit; font-size: .72rem; cursor: pointer; }
      .scb-btn.primary { background: var(--text-bright); color: var(--bg); border-color: var(--text-bright); font-weight: 700; }
      .scb-btn.danger { background: var(--danger, #ef4444); color: #fff; border-color: transparent; }
      .scb-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 10px 0; }
      .scb-kpi { border: 1px solid var(--border); border-radius: 6px; padding: 7px 6px; text-align: center; }
      .scb-kpi-v { font-size: 1rem; font-weight: 800; line-height: 1.1; }
      .scb-kpi-l { color: var(--text-dim); font-size: .55rem; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
      .scb-status { color: var(--accent); font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
      .scb-log { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; font-size: .65rem; color: var(--text-dim); white-space: pre-wrap; max-height: 260px; overflow: auto; }
      .scb-scenario-list { max-height: 150px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; padding: 6px; margin: 8px 0; }
      .scb-scenario { display: flex; align-items: center; gap: 7px; padding: 3px 0; font-size: .68rem; }
      .scb-scenario span { color: var(--text-dim); }
    `;
    document.head.appendChild(style);

    const maxIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/></svg>';
    const closeIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    document.body.insertAdjacentHTML('beforeend', `
      <div class="rp-pane" id="scb-pane">
        <div class="floating-pane-head">
          <span class="floating-pane-title">Spore Code Benchmark</span>
          <div class="floating-pane-actions">
            <button class="floating-pane-btn" type="button" data-window-action="maximize" title="Maximize" aria-label="Maximize">${maxIcon}</button>
            <button class="floating-pane-btn" type="button" data-scb-close="1" title="Close" aria-label="Close">${closeIcon}</button>
          </div>
        </div>
        <div class="floating-pane-body">
          <div class="scb-scroll">
            <div class="scb-row"><label>Max repos</label><input id="scb-max" class="scb-input" type="number" min="1" max="10" value="3"></div>
            <div class="scb-row"><label>Tasks/repo</label><input id="scb-tasks" class="scb-input" type="number" min="1" max="10" value="3"></div>
            <div class="scb-row"><label>Max turns</label><input id="scb-turns" class="scb-input" type="number" min="1" max="30" value="30"></div>
            <div class="scb-row"><label>Parallel</label><input id="scb-parallel" class="scb-input" type="number" min="1" max="10" value="2"></div>
            <div class="scb-row"><label>Settle ms</label><input id="scb-settle" class="scb-input" type="number" min="0" max="600000" value="90000"></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-dry" type="checkbox" checked> Dry run</label></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-actor" type="checkbox"> LLM actor</label></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-verify" type="checkbox" checked> Verification</label></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-summary" type="checkbox" checked> Planner summary</label></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-judge" type="checkbox"> LLM judge</label></div>
            <div class="scb-row"><label class="scb-check"><input id="scb-trace" type="checkbox"> Raw trace</label></div>
            <div class="scb-row" style="align-items:flex-start"><label>Actor guide</label><textarea id="scb-actor-guide" class="scb-input wide" placeholder="Optional: tell the simulated user what to care about."></textarea></div>
            <div id="scb-scenarios" class="scb-scenario-list"></div>
            <div class="scb-actions">
              <button id="scb-start" class="scb-btn primary" type="button">Start</button>
              <button id="scb-cancel" class="scb-btn danger" type="button">Cancel</button>
              <button id="scb-refresh" class="scb-btn" type="button">Refresh</button>
            </div>
            <div class="scb-status" id="scb-phase">Idle</div>
            <div class="scb-kpis">
              <div class="scb-kpi"><div class="scb-kpi-v" id="scb-k-complete">0</div><div class="scb-kpi-l">Done</div></div>
              <div class="scb-kpi"><div class="scb-kpi-v" id="scb-k-total">0</div><div class="scb-kpi-l">Total</div></div>
              <div class="scb-kpi"><div class="scb-kpi-v" id="scb-k-success">0</div><div class="scb-kpi-l">Likely</div></div>
              <div class="scb-kpi"><div class="scb-kpi-v" id="scb-k-leaks">0</div><div class="scb-kpi-l">Leaks</div></div>
            </div>
            <div class="scb-log" id="scb-log"></div>
          </div>
        </div>
      </div>
    `);
    if (typeof _floatingWindowDefaults !== 'undefined') {
      _floatingWindowDefaults['scb-pane'] = {
        left: null,
        top: 70,
        width: 430,
        height: Math.min(window.innerHeight - 100, 680),
        rightOffset: 22,
      };
    }
    if (typeof _initFloatingWindow === 'function') _initFloatingWindow('scb-pane', '.floating-pane-head');
    document.querySelector('#scb-pane [data-scb-close]')?.addEventListener('click', () => scbClose());
    document.getElementById('scb-start')?.addEventListener('click', scbStart);
    document.getElementById('scb-cancel')?.addEventListener('click', scbCancel);
    document.getElementById('scb-refresh')?.addEventListener('click', scbRefresh);
    scbLoadCatalog();
  }

  function openPane() {
    ensurePane();
    document.getElementById('scb-pane')?.classList.add('window-open');
    scbRefresh();
  }

  function scbClose() {
    document.getElementById('scb-pane')?.classList.remove('window-open');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function apiJson(path, opts) {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...(opts || {}),
    });
    return res.json();
  }

  async function scbLoadCatalog() {
    const box = document.getElementById('scb-scenarios');
    if (!box) return;
    try {
      const data = await apiJson('/catalog');
      box.innerHTML = (data.scenarios || []).map(s => `
        <label class="scb-scenario">
          <input type="checkbox" value="${s.id}" checked>
          <b>${s.id}</b> <span>${s.domain} · ${s.taskCount || 1} tasks</span>
        </label>
      `).join('');
    } catch (e) {
      box.textContent = e.message;
    }
  }

  async function scbStart() {
    const ids = Array.from(document.querySelectorAll('#scb-scenarios input:checked')).map(x => x.value);
    const body = {
      scenarioIds: ids,
      maxScenarios: Number(document.getElementById('scb-max')?.value || 3),
      maxTasksPerRepo: Number(document.getElementById('scb-tasks')?.value || 3),
      maxTurnsPerTask: Number(document.getElementById('scb-turns')?.value || 30),
      parallel: Number(document.getElementById('scb-parallel')?.value || 2),
      sessionSettleMs: Number(document.getElementById('scb-settle')?.value || 0),
      dryRun: !!document.getElementById('scb-dry')?.checked,
      actor: !!document.getElementById('scb-actor')?.checked,
      actorGuidance: document.getElementById('scb-actor-guide')?.value || '',
      runVerification: !!document.getElementById('scb-verify')?.checked,
      experienceSummary: !!document.getElementById('scb-summary')?.checked,
      judge: !!document.getElementById('scb-judge')?.checked,
      includeTrace: !!document.getElementById('scb-trace')?.checked,
    };
    const data = await apiJson('/run', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('scb-log').textContent = data.error ? data.error : `Started ${data.runId || ''}`;
    if (!pollTimer) pollTimer = setInterval(scbRefresh, 2000);
    scbRefresh();
  }

  async function scbCancel() {
    await apiJson('/cancel', { method: 'POST', body: '{}' });
    scbRefresh();
  }

  async function scbRefresh() {
    try {
      const status = await apiJson('/status');
      document.getElementById('scb-phase').textContent = status.phase || 'idle';
      document.getElementById('scb-k-complete').textContent = status.progress?.current ?? 0;
      document.getElementById('scb-k-total').textContent = status.progress?.total ?? 0;
      document.getElementById('scb-k-success').textContent = status.summary?.likelySuccess ?? 0;
      document.getElementById('scb-k-leaks').textContent = status.summary?.leakageHits ?? 0;
      const lines = [
        status.runId ? `run: ${status.runId}` : '',
        status.startedAt ? `started: ${status.startedAt}` : '',
        status.error ? `error: ${status.error}` : '',
        status.summary ? JSON.stringify(status.summary, null, 2) : '',
      ].filter(Boolean);
      document.getElementById('scb-log').textContent = lines.join('\n');
      if (['done', 'error', 'cancelled', 'idle'].includes(status.phase) && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (e) {
      const log = document.getElementById('scb-log');
      if (log) log.textContent = e.message;
    }
  }

  window.__scbOpen = openPane;
  document.addEventListener('spore-plugin-panes-rendered', () => {
    const root = document.querySelector('[data-plugin-pane="spore-code-benchmark"], [data-plugin-custom="spore-code-benchmark"]');
    const btn = root ? Array.from(root.querySelectorAll('button')).find(b => /open benchmark/i.test(b.textContent || '')) : null;
    if (btn && !btn.dataset.scbWired) {
      btn.dataset.scbWired = '1';
      btn.addEventListener('click', ev => { ev.preventDefault(); openPane(); });
    }
  });
})();
