// longmemeval.js — LongMemEval benchmark UI (operator-only HUD).
// Extracted from src/static/scripts/app.js (was lines 12606-12944 of the post-Phase-2 monolith).

// ── LongMemEval Benchmark ──
const _lme = {
  running: false, passCount: 0, totalJudged: 0, logLines: 0,
  byType: {}, totalInputTokens: 0, totalOutputTokens: 0, totalLatencyMs: 0,
  startedAt: null, elapsedTimer: null,
};

function lmeOpen() {
  const modal = document.getElementById('lme-hud');
  modal.classList.add('open');
  if (!_lme.running) {
    document.getElementById('lme-config').style.display = 'none';
    document.getElementById('lme-progress').style.display = 'none';
    document.getElementById('lme-results').style.display = 'none';
    // Show Enhanced Recall status
    const erEl = document.getElementById('lme-er-status');
    if (erEl) {
      erEl.textContent = _erEnabled
        ? '\u{1F9E0} Enhanced Recall is ON \u2014 LLM query decomposition active'
        : '\u26A0\uFE0F Enhanced Recall is OFF \u2014 toggle it on in the tools menu for best results';
      erEl.style.color = _erEnabled ? 'var(--accent2)' : 'var(--text-dim)';
    }
    fetch(API + '/api/benchmark/longmemeval/results', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        if (data && !data.empty && data.scores) {
          lmeRenderResults(data.scores, data.elapsed, data.stats);
          const container = document.getElementById('lme-results');
          const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : '';
          // Prepend header with timestamp and prominent New Run button
          container.insertAdjacentHTML('afterbegin',
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
            + '<span style="font-size:.55rem;color:var(--text-dim)">Last run: ' + ts + '</span>'
            + '<button class="lme-btn lme-btn-go" onclick="lmeShowConfig()" style="font-size:.6rem;padding:3px 10px">New Run</button>'
            + '</div>'
          );
        } else {
          document.getElementById('lme-config').style.display = '';
        }
      })
      .catch(() => {
        document.getElementById('lme-config').style.display = '';
      });
  }
}

function lmeShowConfig() {
  document.getElementById('lme-config').style.display = '';
  document.getElementById('lme-results').style.display = 'none';
  // Refresh ER status
  const erEl = document.getElementById('lme-er-status');
  if (erEl) {
    erEl.textContent = _erEnabled
      ? '\u{1F9E0} Enhanced Recall is ON \u2014 LLM query decomposition active'
      : '\u26A0\uFE0F Enhanced Recall is OFF \u2014 toggle it on in the tools menu for best results';
    erEl.style.color = _erEnabled ? 'var(--accent2)' : 'var(--text-dim)';
  }
  lmeUpdateCostEst();
}

function lmeClose() {
  document.getElementById('lme-hud').classList.remove('open');
}

document.getElementById('lme-hud')?.addEventListener('click', (e) => {
  if (e.target.id === 'lme-hud') lmeClose();
});

function lmeUpdateCostEst() {
  const v = document.getElementById('lme-variant').value;
  const lm = document.getElementById('lme-learner-model').value;
  const am = document.getElementById('lme-answer-model').value;
  const est = document.getElementById('lme-cost-est');
  const lmSonnet = lm.includes('sonnet');
  const amOpus = am.includes('opus');
  const amSonnet = am.includes('sonnet');
  const baseCalls = v === 'oracle' ? 1000 : v === 's' ? 5000 : 20000;
  const learnCost = baseCalls * (lmSonnet ? 0.006 : 0.002);
  const evalCostPer = amOpus ? 0.10 : amSonnet ? 0.02 : 0.007;
  const evalCost = 500 * evalCostPer;
  const total = learnCost + evalCost;
  const time = v === 'oracle' ? '30\u201345 min' : v === 's' ? '2\u20133 hours' : '8+ hours';
  est.textContent = `~${baseCalls.toLocaleString()} learn + 1,000 eval calls \u2248 $${total < 10 ? total.toFixed(0) : Math.round(total)}\u2013${Math.round(total * 1.5)} \u2022 ~${time}`;
}
document.getElementById('lme-variant')?.addEventListener('change', lmeUpdateCostEst);
document.getElementById('lme-learner-model')?.addEventListener('change', lmeUpdateCostEst);
document.getElementById('lme-answer-model')?.addEventListener('change', lmeUpdateCostEst);

function lmeStart() {
  const variant = document.getElementById('lme-variant').value;
  const maxQuestions = parseInt(document.getElementById('lme-max-q').value) || 500;
  const skipIngestion = document.getElementById('lme-eval-only').checked;
  const forceReeval = document.getElementById('lme-force-reeval').checked;
  const learnerModel = document.getElementById('lme-learner-model').value;
  const answerModel = document.getElementById('lme-answer-model').value;
  const checkedTypes = [...document.querySelectorAll('.lme-type-cb:checked')].map(cb => cb.value);
  const questionTypes = checkedTypes.length === 6 ? null : checkedTypes; // null = all

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

  fetch(API + '/api/benchmark/longmemeval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variant, maxQuestions, skipIngestion, forceReeval, learnerModel, answerModel, questionTypes }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        lmeLogLine('Error: ' + data.error, 'fail');
        _lme.running = false;
      } else {
        lmeLogLine('Benchmark started \u2014 graph: ' + data.slug);
      }
    })
    .catch(e => {
      lmeLogLine('Request failed: ' + e.message, 'fail');
      _lme.running = false;
    });
}

function lmeCancel() {
  fetch(API + '/api/benchmark/longmemeval/cancel', { method: 'POST' })
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

function lmeToggleExpand() {
  document.getElementById('lme-hud').classList.toggle('expanded');
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

function handleBenchmarkWs(msg) {
  if (msg.type === 'benchmark:start') {
    if (!_lme.startedAt) {
      _lme.startedAt = Date.now();
      if (_lme.elapsedTimer) clearInterval(_lme.elapsedTimer);
      _lme.elapsedTimer = setInterval(lmeTickElapsed, 1000);
      lmeTickElapsed();
    }
    lmeLogLine('LongMemEval ' + (msg.variant || '') + ' \u2014 ' + (msg.maxQuestions || 500) + ' questions');
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

    const tag = msg.pass ? '\u2713' : '\u2717';
    const cls = msg.pass ? 'pass' : 'fail';
    const isExpanded = document.getElementById('lme-hud').classList.contains('expanded');
    let logText = tag + ' [' + qType + '] ' + (msg.question || '').substring(0, isExpanded ? 120 : 80);
    if (isExpanded && msg.latencyMs) logText += '  \u23F1' + (msg.latencyMs / 1000).toFixed(1) + 's';
    if (isExpanded && msg.inputTokens) logText += '  ' + ((msg.inputTokens + (msg.outputTokens || 0)) / 1000).toFixed(1) + 'k tok';
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
    { name: 'SPORE (this run)', pct: pctNum, color: '#7aa583' },
    { name: 'GPT-4o baseline', pct: 39.2, color: '#8a8676' },
    { name: 'Llama-3 70B', pct: 24.8, color: '#8a8676' },
  ].sort((a, b) => b.pct - a.pct);

  let refBars = '';
  for (const r of refs) {
    const isThis = r.name.includes('this run');
    const w = (r.pct * 100 / 100).toFixed(1);
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
    + '<div class="lme-score-hero">'
    + '  <div class="pct ' + pctCls + '">' + overallPct + '%</div>'
    + '  <div class="sub">' + (scores?.totalPass || 0) + ' / ' + (scores?.totalQuestions || 0) + ' correct &bull; ' + elapsedMin + ' min</div>'
    + '</div>'
    + '<div class="lme-section"><label>Comparison</label>' + refBars + '</div>'
    + '<div class="lme-section"><label>By Question Type</label>'
    + '<table class="lme-results-table"><tr><th>Type</th><th>Pass</th><th>Accuracy</th></tr>' + typeRows + '</table>'
    + '</div>'
    + '<div class="lme-section"><label>Run Stats</label>'
    + '<div class="lme-stat-row">'
    + '  <div class="lme-stat"><div class="lme-stat-val">' + (stats?.sessionsIngested || 0) + '</div><div class="lme-stat-label">Sessions</div></div>'
    + '  <div class="lme-stat"><div class="lme-stat-val">' + (stats?.nodesCreated || 0) + '</div><div class="lme-stat-label">Nodes</div></div>'
    + '  <div class="lme-stat"><div class="lme-stat-val">' + (stats?.exchangesProcessed || 0) + '</div><div class="lme-stat-label">Exchanges</div></div>'
    + '</div></div>'
    + (scores?.efficiency ? '<div class="lme-section"><label>Efficiency</label><div class="lme-eff-row">'
      + '<div class="lme-eff"><div class="lme-eff-v">' + (scores.efficiency.avgLatencyMs / 1000).toFixed(1) + 's</div><div class="lme-eff-l">Avg latency</div></div>'
      + '<div class="lme-eff"><div class="lme-eff-v">' + (scores.efficiency.totalTokens >= 1e6 ? (scores.efficiency.totalTokens / 1e6).toFixed(1) + 'M' : (scores.efficiency.totalTokens / 1e3).toFixed(0) + 'k') + '</div><div class="lme-eff-l">Total tokens</div></div>'
      + '<div class="lme-eff"><div class="lme-eff-v">$' + scores.efficiency.estimatedCostUsd.toFixed(2) + '</div><div class="lme-eff-l">Est. cost</div></div>'
    + '</div></div>' : '')
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '  <button class="lme-btn lme-btn-ghost" onclick="lmeClose()">Close</button>'
    + '</div>';
}
