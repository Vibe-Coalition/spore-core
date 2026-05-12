(function () {
  'use strict';
  if (window.__CronSettings) return;
  window.__CronSettings = true;

  const PLUGIN_ID = 'cron';
  const apiBase = () => (window.location.pathname.replace(/\/(graph|mobile)\/?$/, '') || '');
  const authHeaders = () => (typeof window.authHeaders === 'function' ? window.authHeaders() : {});
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const attr = esc;

  let mountEl = null;
  let jobs = [];
  let status = null;
  let editing = null;

  function injectStyle() {
    if (document.getElementById('cron-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'cron-settings-style';
    style.textContent = `
      .cron-settings { display:flex; flex-direction:column; gap:10px; }
      .cron-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
      .cron-meta { color:var(--text-dim); font-size:.68rem; }
      .cron-job-list { display:flex; flex-direction:column; gap:8px; }
      .cron-job { border:1px solid var(--border); border-radius:8px; padding:10px; background:color-mix(in srgb, var(--surface) 90%, transparent); }
      .cron-job-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
      .cron-job-title { display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--text-bright); font-weight:650; }
      .cron-badge { border:1px solid var(--border); border-radius:999px; padding:1px 7px; color:var(--text-dim); font-size:.58rem; font-weight:500; }
      .cron-badge.ok { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 38%, var(--border)); }
      .cron-badge.raw { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 38%, var(--border)); }
      .cron-job-grid { display:grid; grid-template-columns:88px 1fr; gap:4px 10px; margin-top:8px; font-size:.68rem; }
      .cron-job-grid span:nth-child(odd) { color:var(--text-dim); }
      .cron-code { font-family:var(--font-mono); word-break:break-all; color:var(--text); }
      .cron-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
      .cron-empty { color:var(--text-dim); border:1px dashed var(--border); border-radius:8px; padding:12px; font-size:.72rem; }
      .cron-form { border:1px solid var(--border); border-radius:8px; padding:10px; display:grid; gap:8px; background:color-mix(in srgb, var(--surface) 94%, transparent); }
      .cron-form-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; }
      .cron-form label { display:flex; flex-direction:column; gap:4px; color:var(--text-dim); font-size:.64rem; }
      .cron-form input, .cron-form select, .cron-form textarea {
        width:100%; box-sizing:border-box; border:1px solid var(--border); border-radius:6px;
        background:var(--input-bg, var(--surface)); color:var(--text); padding:7px 8px; font:inherit; font-size:.72rem;
      }
      .cron-form textarea { min-height:70px; resize:vertical; font-family:var(--font-mono); }
      .cron-form-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
      .cron-danger { color:var(--danger) !important; border-color:color-mix(in srgb, var(--danger) 38%, var(--border)) !important; }
      @media (max-width: 760px) { .cron-form-grid, .cron-job-grid { grid-template-columns:1fr; } }
    `;
    document.head.appendChild(style);
  }

  function baseHtml() {
    return `
      <div class="cron-settings">
        <div class="cron-head">
          <div>
            <div class="settings-note settings-muted">Container cron uses the container local timezone. Docker defaults to UTC unless TZ is configured.</div>
            <div class="cron-meta" data-cron-meta>Loading cron status...</div>
          </div>
          <span class="settings-plugin-actions tight">
            <button type="button" class="settings-btn-secondary settings-compact-btn" data-cron-refresh>Refresh</button>
            <button type="button" class="settings-btn-secondary settings-compact-btn" data-cron-new>New job</button>
          </span>
        </div>
        <div data-cron-form></div>
        <div data-cron-list class="cron-job-list"></div>
        <div class="settings-note settings-muted-soft">Use managed jobs for anything created here. They are wrapped with <code>SPORE-CRON-BEGIN/END</code> markers so edits do not delete unrelated cron jobs.</div>
      </div>
    `;
  }

  function render() {
    if (!mountEl) return;
    if (!mountEl.querySelector('[data-cron-list]')) mountEl.innerHTML = baseHtml();
    const meta = mountEl.querySelector('[data-cron-meta]');
    const list = mountEl.querySelector('[data-cron-list]');
    if (meta) {
      const daemon = status?.daemon?.running ? `running pid ${status.daemon.pid}` : 'not running';
      const tz = status?.time?.timezone || 'container-local';
      meta.textContent = `daemon ${daemon} · timezone ${tz} · ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    }
    if (list) {
      list.innerHTML = jobs.length ? jobs.map(renderJob).join('') : '<div class="cron-empty">No cron jobs registered.</div>';
    }
    renderForm();
  }

  function renderJob(job, index) {
    const target = job.channelId || '';
    const mode = job.mode || (job.proactive ? 'proactive' : 'command');
    return `<div class="cron-job" data-cron-index="${index}">
      <div class="cron-job-top">
        <div class="cron-job-title">
          <span>${esc(job.name || 'cron-job')}</span>
          <span class="cron-badge ${job.managed ? 'ok' : 'raw'}">${job.managed ? 'managed' : 'raw'}</span>
          <span class="cron-badge">${esc(mode)}</span>
        </div>
        <div class="cron-actions">
          <button type="button" class="settings-btn-secondary settings-compact-btn" data-cron-edit="${index}">Edit</button>
          <button type="button" class="settings-btn-secondary settings-compact-btn cron-danger" data-cron-delete="${index}">Delete</button>
        </div>
      </div>
      <div class="cron-job-grid">
        <span>Schedule</span><span><strong>${esc(job.summary || job.schedule)}</strong> <code>${esc(job.schedule)}</code></span>
        ${target ? `<span>Target</span><span>${esc(target)}</span>` : ''}
        ${job.message ? `<span>Message</span><span>${esc(job.message)}</span>` : ''}
        ${job.logPath ? `<span>Log</span><span><code>${esc(job.logPath)}</code></span>` : ''}
        <span>Command</span><span class="cron-code">${esc(job.command)}</span>
      </div>
    </div>`;
  }

  function blankJob() {
    return {
      name: 'cron-job',
      schedule: '0 9 * * *',
      mode: 'notify',
      message: 'Scheduled cron trigger',
      channelId: '',
      logPath: '/workspace/logs/cron-cron-job.log',
      command: '',
      customCommand: false,
    };
  }

  function editableFromJob(job) {
    return {
      name: job.name || 'cron-job',
      schedule: job.schedule || '0 9 * * *',
      mode: (job.mode === 'agent' || job.mode === 'notify') ? job.mode : 'custom',
      message: job.message || '',
      channelId: job.channelId || '',
      logPath: job.logPath || `/workspace/logs/cron-${job.name || 'job'}.log`,
      command: job.command || '',
      customCommand: !(job.proactive && (job.mode === 'agent' || job.mode === 'notify')),
      originalEntry: job.entry,
      managed: !!job.managed,
    };
  }

  function renderForm() {
    const host = mountEl?.querySelector('[data-cron-form]');
    if (!host) return;
    if (!editing) {
      host.innerHTML = '';
      return;
    }
    const isCustom = editing.mode === 'custom' || editing.customCommand;
    host.innerHTML = `<div class="cron-form">
      <div class="cron-form-grid">
        <label>Name <input data-cron-field="name" value="${attr(editing.name)}" autocomplete="off"></label>
        <label>Schedule <input data-cron-field="schedule" value="${attr(editing.schedule)}" placeholder="*/10 * * * *" autocomplete="off"></label>
        <label>Mode
          <select data-cron-field="mode">
            <option value="notify"${editing.mode === 'notify' ? ' selected' : ''}>Notify channel</option>
            <option value="agent"${editing.mode === 'agent' ? ' selected' : ''}>Start agent turn</option>
            <option value="custom"${isCustom ? ' selected' : ''}>Custom command</option>
          </select>
        </label>
        <label>Target <input data-cron-field="channelId" value="${attr(editing.channelId)}" placeholder="telegram:123456 or web:control-panel" autocomplete="off"></label>
      </div>
      <label ${isCustom ? 'hidden' : ''}>Message <textarea data-cron-field="message">${esc(editing.message)}</textarea></label>
      <label ${isCustom ? '' : 'hidden'}>Command <textarea data-cron-field="command">${esc(editing.command)}</textarea></label>
      <label>Log path <input data-cron-field="logPath" value="${attr(editing.logPath)}" placeholder="/workspace/logs/cron-name.log" autocomplete="off"></label>
      <div class="cron-form-actions">
        <button type="button" class="settings-btn-secondary settings-compact-btn" data-cron-cancel>Cancel</button>
        <button type="button" class="settings-btn-secondary settings-compact-btn" data-cron-save>${editing.originalEntry ? 'Update job' : 'Create job'}</button>
      </div>
      <div class="settings-note settings-muted-soft">Schedules are standard five-field cron expressions, for example <code>* * * * *</code> or <code>30 20 * * 1-5</code>.</div>
    </div>`;
  }

  function readForm() {
    const get = (key) => mountEl?.querySelector(`[data-cron-field="${key}"]`)?.value?.trim() || '';
    const mode = get('mode') || 'notify';
    return {
      name: get('name') || 'cron-job',
      schedule: get('schedule') || '0 9 * * *',
      mode,
      message: get('message') || 'Scheduled cron trigger',
      channelId: get('channelId'),
      logPath: get('logPath'),
      command: mode === 'custom' ? get('command') : '',
    };
  }

  async function refresh() {
    if (!mountEl) return;
    const list = mountEl.querySelector('[data-cron-list]');
    if (list) list.innerHTML = '<div class="cron-empty">Loading cron jobs...</div>';
    try {
      const r = await fetch(apiBase() + '/api/plugins/cron/jobs', { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      jobs = Array.isArray(d.jobs) ? d.jobs : [];
      status = d.status || null;
    } catch (e) {
      jobs = [];
      status = null;
      if (list) list.innerHTML = `<div class="cron-empty" style="color:var(--danger)">Failed to load cron jobs: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  async function save() {
    const body = readForm();
    if (!body.name || !body.schedule) return alert('Name and schedule are required.');
    const r = await fetch(apiBase() + '/api/plugins/cron/jobs', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d.ok === false) {
      const warnings = d.validation?.warnings?.map(w => w.message).join('\n') || '';
      alert('Cron save failed: ' + (d.error || `HTTP ${r.status}`) + (warnings ? `\n${warnings}` : ''));
      return;
    }
    editing = null;
    await refresh();
  }

  async function removeJob(index) {
    const job = jobs[index];
    if (!job) return;
    if (!confirm(`Delete cron job "${job.name}"?`)) return;
    const body = job.managed ? { name: job.name } : { entry: job.entry };
    const r = await fetch(apiBase() + '/api/plugins/cron/jobs', {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d.ok === false) {
      alert('Delete failed: ' + (d.error || `HTTP ${r.status}`));
      return;
    }
    await refresh();
  }

  function onClick(e) {
    const btn = e.target instanceof Element ? e.target.closest('[data-cron-refresh],[data-cron-new],[data-cron-edit],[data-cron-delete],[data-cron-save],[data-cron-cancel]') : null;
    if (!btn) return;
    if (btn.hasAttribute('data-cron-refresh')) refresh();
    else if (btn.hasAttribute('data-cron-new')) { editing = blankJob(); renderForm(); }
    else if (btn.hasAttribute('data-cron-edit')) { editing = editableFromJob(jobs[Number(btn.getAttribute('data-cron-edit'))]); renderForm(); }
    else if (btn.hasAttribute('data-cron-delete')) removeJob(Number(btn.getAttribute('data-cron-delete')));
    else if (btn.hasAttribute('data-cron-save')) save();
    else if (btn.hasAttribute('data-cron-cancel')) { editing = null; renderForm(); }
  }

  function onInput(e) {
    const field = e.target instanceof Element ? e.target.closest('[data-cron-field]') : null;
    if (!field || !editing) return;
    if (field.getAttribute('data-cron-field') === 'mode') {
      editing.mode = field.value;
      editing.customCommand = field.value === 'custom';
      renderForm();
    }
  }

  function mount(el) {
    injectStyle();
    mountEl = el;
    mountEl.innerHTML = baseHtml();
    mountEl.removeEventListener('click', onClick);
    mountEl.removeEventListener('input', onInput);
    mountEl.addEventListener('click', onClick);
    mountEl.addEventListener('input', onInput);
    refresh();
  }

  document.addEventListener('spore-plugin-panes-rendered', () => {
    const el = document.querySelector(`[data-plugin-pane="${PLUGIN_ID}"] [data-plugin-mount="${PLUGIN_ID}"]`);
    if (el) mount(el);
  });
})();
