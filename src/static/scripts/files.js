// files.js — File manager panel: list/browse/view/edit/upload/new-folder.
// Extracted from src/static/scripts/app.js (was lines 11763-12306 of the post-Phase-2 monolith).

// ── File Manager Panel ──
const fpList = document.getElementById('fp-list');
const fpBreadcrumb = document.getElementById('fp-breadcrumb');
const fpDropzone = document.getElementById('fp-dropzone');
const fpViewer = document.getElementById('fp-viewer');
const fpViewerContent = document.getElementById('fp-viewer-content');
const fpViewerName = document.getElementById('fp-viewer-name');
const fpBody = document.getElementById('fp-body');
const fpSourceSelect = document.getElementById('fp-source');
let fpCurrentPath = '';
let _fpHosts = [];

function fpIsRemote() { return fpSourceSelect.value !== 'local' && fpSourceSelect.value !== 'local-mount'; }
function fpIsLocalMount() { return fpSourceSelect.value === 'local-mount'; }
function fpHostId() { return fpSourceSelect.value; }

fpSourceSelect.addEventListener('change', () => {
  if (fpIsLocalMount() && _localMount._mounted) {
    fpCurrentPath = _localMount.serverPath;
    fpLoadDir(fpCurrentPath);
  } else {
    fpCurrentPath = '';
    fpLoadDir('');
  }
});

function fpPopulateHosts(hosts) {
  _fpHosts = hosts || [];
  const cur = fpSourceSelect.value;
  fpSourceSelect.innerHTML = '<option value="local">local</option>';
  for (const h of _fpHosts) {
    const opt = document.createElement('option');
    opt.value = h.id;
    opt.textContent = h.name || h.hostname;
    fpSourceSelect.appendChild(opt);
  }
  if ([...fpSourceSelect.options].some(o => o.value === cur)) fpSourceSelect.value = cur;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fpBuildBreadcrumb(subpath) {
  const parts = subpath ? subpath.replace(/^\//, '').split('/').filter(Boolean) : [];
  const remote = fpIsRemote();
  const isMount = fpIsLocalMount();
  const rootLabel = remote ? (fpSourceSelect.selectedOptions[0]?.textContent || 'remote')
    : isMount ? _localMount.mountName : 'workspace';
  const rootPath = remote ? '/' : isMount ? _localMount.serverPath : '';
  let html = `<span class="fp-crumb" onclick="fpLoadDir('${esc(rootPath)}')">${esc(rootLabel)}</span>`;
  if (remote) html += `<span class="fp-remote-badge">SSH</span>`;
  if (isMount) html += `<span class="lm-local-badge">LOCAL</span>`;
  let acc = remote ? '' : '';
  for (const p of parts) {
    acc = remote ? (acc ? acc + '/' + p : '/' + p) : (acc ? acc + '/' + p : p);
    html += ` <span style="color:var(--text-dim)">/</span> <span class="fp-crumb" onclick="fpLoadDir('${esc(acc)}')">${esc(p)}</span>`;
  }
  fpBreadcrumb.innerHTML = html;
}

const TEXT_EXTS = new Set(['js','ts','py','json','md','txt','html','css','sh','yaml','yml','env','log','csv','toml','xml','ini','cfg','conf','sql','jsx','tsx','rb','go','rs','java','c','h','cpp','hpp','mjs','cjs','lock','gitignore','dockerignore','Dockerfile','Makefile']);
const IMG_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','avif']);
const VIDEO_EXTS = new Set(['mp4','webm','mov','avi','mkv']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac']);
const PDF_EXTS = new Set(['pdf']);
const HTML_EXTS = new Set(['html','htm']);
const CSV_EXTS = new Set(['csv','tsv']);
const MD_EXTS = new Set(['md','markdown']);

function getFileExt(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function isTextFile(name) { return TEXT_EXTS.has(getFileExt(name)) || TEXT_EXTS.has(name); }
function isImageFile(name) { return IMG_EXTS.has(getFileExt(name)); }
function isVideoFile(name) { return VIDEO_EXTS.has(getFileExt(name)); }
function isAudioFile(name) { return AUDIO_EXTS.has(getFileExt(name)); }
function isPdfFile(name) { return PDF_EXTS.has(getFileExt(name)); }
function isHtmlFile(name) { return HTML_EXTS.has(getFileExt(name)); }
function isCsvFile(name) { return CSV_EXTS.has(getFileExt(name)); }
function isMarkdownFile(name) { return MD_EXTS.has(getFileExt(name)); }

// Minimal RFC-4180 CSV/TSV parser — handles quoted fields with embedded delims & newlines.
function parseDelimited(text, delim) {
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const PRISM_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  css: 'css', html: 'markup', xml: 'markup', svg: 'markup',
  sh: 'bash', bash: 'bash', sql: 'sql',
  md: 'markdown', Dockerfile: 'docker', dockerignore: 'docker',
  env: 'bash', conf: 'bash', cfg: 'bash', ini: 'bash',
};
function prismLang(name) {
  const ext = getFileExt(name);
  return PRISM_MAP[ext] || PRISM_MAP[name] || null;
}

async function fpLoadDir(subpath) {
  fpCurrentPath = subpath;
  fpViewer.classList.remove('active');
  fpBody.style.display = '';
  fpDropzone.classList.add('active');
  fpBuildBreadcrumb(subpath);
  fpList.innerHTML = '<div style="padding:14px;color:var(--text-dim)">Loading...</div>';
  try {
    const remote = fpIsRemote();
    const url = remote
      ? `${API}/api/remote/ls?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(subpath || '/')}`
      : `${API}/api/workspace?path=${encodeURIComponent(subpath)}`;
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) { const t = await r.text(); throw new Error(t || `Server returned ${r.status}`); }
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    if (!Array.isArray(data.entries)) throw new Error('No entries returned');
    let html = '';
    const entries = data.entries.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
    for (const e of entries) {
      const icon = e.isDir ? '/' : '';
      const full = remote
        ? (subpath === '/' || subpath === '' ? '/' + e.name : subpath + '/' + e.name)
        : (subpath ? `${subpath}/${e.name}` : e.name);
      const size = e.isDir ? '' : formatBytes(e.size);
      const onclick = e.isDir ? `fpLoadDir('${esc(full)}')` : `fpViewFile('${esc(full)}','${esc(e.name)}')`;
      html += `<div class="fp-entry" onclick="${onclick}">
        <span class="fp-icon">${icon}</span>
        <span class="fp-name" title="${esc(e.name)}">${esc(e.name)}</span>
        <span class="fp-meta">${size}</span>
        <span class="fp-actions">
          ${e.isDir ? '' : `<button class="fp-action" onclick="event.stopPropagation();fpDownload('${esc(full)}')" title="Download">&#8681;</button>`}
          <button class="fp-action danger" onclick="event.stopPropagation();fpDelete('${esc(full)}',${e.isDir})" title="Delete">&#10005;</button>
        </span>
      </div>`;
    }
    fpList.innerHTML = html || '<div style="padding:14px;color:var(--text-dim)">Empty directory</div>';
  } catch (e) { fpList.innerHTML = `<div style="padding:14px;color:var(--danger)">Failed: ${esc(e.message)}</div>`; }
}

// ── File Viewer ──
async function fpViewFile(filePath, name) {
  fpBody.style.display = 'none';
  fpExitEdit();
  fpViewer.classList.add('active');
  fpViewerName.textContent = name;
  fpViewerContent.innerHTML = '<div style="padding:14px;color:var(--text-dim)">Loading...</div>';
  fpViewer.dataset.path = filePath;
  fpViewer.dataset.remote = fpIsRemote() ? fpHostId() : '';
  fpEditBtn.style.display = isTextFile(name) ? '' : 'none';

  const remote = fpIsRemote();
  const fileUrl = remote
    ? `${API}/api/remote/read?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(filePath)}`
    : `${API}/files/${encodeURIComponent(filePath)}`;

  if (isImageFile(name)) {
    const bustUrl = fileUrl + (fileUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    if (remote) {
      try {
        const r = await fetch(bustUrl, { headers: authHeaders() });
        const blob = await r.blob();
        fpViewerContent.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="${esc(name)}">`;
      } catch { fpViewerContent.innerHTML = '<div style="padding:14px;color:var(--danger)">Failed to load image</div>'; }
    } else {
      fpViewerContent.innerHTML = `<img src="${bustUrl}" alt="${esc(name)}">`;
    }
    return;
  }
  if (isVideoFile(name) && !remote) {
    fpViewerContent.innerHTML = `<video src="${esc(fileUrl)}" controls preload="metadata" style="max-width:100%;max-height:calc(100vh - 200px);background:#000;border-radius:6px;"></video>`;
    return;
  }
  if (isAudioFile(name) && !remote) {
    fpViewerContent.innerHTML = `<div style="padding:24px;text-align:center"><audio src="${esc(fileUrl)}" controls preload="metadata" style="width:100%;max-width:500px"></audio></div>`;
    return;
  }
  if (isPdfFile(name) && !remote) {
    fpViewerContent.innerHTML = `<iframe src="${esc(fileUrl)}" style="width:100%;height:calc(100vh - 180px);border:0;border-radius:6px;background:#fff"></iframe>`;
    return;
  }
  if (isHtmlFile(name) && !remote) {
    // Prefetch source so the Edit button doesn't inherit the previous file's buffer.
    try { const r = await fetch(fileUrl, { headers: authHeaders() }); fpEditRawText = await r.text(); } catch { fpEditRawText = ''; }
    // Sandboxed: allow-scripts but no allow-same-origin — agent HTML cannot touch cookies/session.
    // "View raw" link opens source via the text branch.
    fpViewerContent.innerHTML = `
      <div style="display:flex;padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg-alt);font-size:12px">
        <a href="#" id="fp-html-raw" style="margin-left:auto;color:var(--accent)">View source</a>
      </div>
      <iframe src="${fileUrl}" sandbox="allow-scripts allow-forms allow-popups" style="width:100%;height:calc(100vh - 220px);border:0;background:#fff"></iframe>`;
    const rawLink = document.getElementById('fp-html-raw');
    if (rawLink) rawLink.onclick = async (e) => {
      e.preventDefault();
      try {
        const r = await fetch(fileUrl, { headers: authHeaders() });
        const text = await r.text();
        const codeEl = document.createElement('code');
        codeEl.className = 'language-html'; codeEl.textContent = text;
        const pre = document.createElement('pre'); pre.className = 'line-numbers'; pre.appendChild(codeEl);
        fpViewerContent.innerHTML = ''; fpViewerContent.appendChild(pre);
        if (window.Prism) Prism.highlightElement(codeEl);
      } catch {}
    };
    return;
  }
  if (isCsvFile(name)) {
    try {
      const r = await fetch(fileUrl, { headers: authHeaders() });
      const text = await r.text();
      fpEditRawText = text;
      const delim = getFileExt(name) === 'tsv' ? '\t' : ',';
      const rows = parseDelimited(text, delim);
      const MAX = 1000;
      const shown = rows.slice(0, MAX);
      const header = shown[0] || [];
      const body = shown.slice(1);
      let html = '<div style="padding:12px;overflow:auto;max-height:calc(100vh - 180px)">';
      if (rows.length > MAX) {
        html += `<div style="padding:6px 0;color:var(--text-dim);font-size:12px">Showing first ${MAX} of ${rows.length} rows</div>`;
      }
      html += '<table style="border-collapse:collapse;font-size:12px;font-family:ui-monospace,monospace"><thead><tr>';
      for (const h of header) html += `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid var(--border);position:sticky;top:0;background:var(--bg-alt);white-space:nowrap">${esc(h)}</th>`;
      html += '</tr></thead><tbody>';
      for (const row of body) {
        html += '<tr>';
        for (const cell of row) html += `<td style="padding:4px 10px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis" title="${esc(cell)}">${esc(cell)}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      fpViewerContent.innerHTML = html;
    } catch (e) { fpViewerContent.innerHTML = `<div style="padding:14px;color:var(--danger)">Failed to load ${esc(name)}</div>`; }
    return;
  }
  if (isMarkdownFile(name)) {
    try {
      const r = await fetch(fileUrl, { headers: authHeaders() });
      const text = await r.text();
      fpEditRawText = text;
      const rendered = (typeof renderMarkdown === 'function') ? renderMarkdown(text) : esc(text);
      fpViewerContent.innerHTML = `
        <div style="display:flex;gap:10px;padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg-alt);font-size:12px">
          <a href="#" id="fp-md-toggle" style="color:var(--accent);margin-left:auto">View source</a>
        </div>
        <div id="fp-md-body" class="markdown-body" style="padding:16px 20px;overflow:auto;max-height:calc(100vh - 220px);line-height:1.6">${rendered}</div>`;
      const toggle = document.getElementById('fp-md-toggle');
      let showingSource = false;
      toggle.onclick = (e) => {
        e.preventDefault();
        const body = document.getElementById('fp-md-body');
        showingSource = !showingSource;
        if (showingSource) {
          const codeEl = document.createElement('code'); codeEl.className = 'language-markdown'; codeEl.textContent = text;
          const pre = document.createElement('pre'); pre.className = 'line-numbers'; pre.appendChild(codeEl);
          body.innerHTML = ''; body.appendChild(pre);
          if (window.Prism) Prism.highlightElement(codeEl);
          toggle.textContent = 'View rendered';
        } else {
          body.innerHTML = rendered;
          toggle.textContent = 'View source';
        }
      };
    } catch (e) { fpViewerContent.innerHTML = `<div style="padding:14px;color:var(--danger)">Failed to load ${esc(name)}</div>`; }
    return;
  }
  if (isTextFile(name)) {
    try {
      const r = await fetch(fileUrl, { headers: authHeaders() });
      const text = await r.text();
      fpEditRawText = text;
      const lang = prismLang(name);
      const codeEl = document.createElement('code');
      codeEl.className = lang ? `language-${lang}` : '';
      codeEl.textContent = text;
      const preEl = document.createElement('pre');
      preEl.className = 'line-numbers';
      preEl.appendChild(codeEl);
      fpViewerContent.innerHTML = '';
      fpViewerContent.appendChild(preEl);
      if (lang && window.Prism) Prism.highlightElement(codeEl);
    } catch (e) { fpViewerContent.innerHTML = `<div style="padding:14px;color:var(--danger)">Failed to load file</div>`; }
    return;
  }
  fpViewerContent.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-dim)">
    <div>${esc(name)}</div>
    <div style="margin-top:12px"><button class="fp-btn" onclick="fpDownload('${esc(filePath)}')">Download file</button></div>
  </div>`;
}

const fpEditor = document.getElementById('fp-editor');
const fpEditWrap = document.getElementById('fp-edit-wrap');
const fpHighlightCode = document.getElementById('fp-edit-highlight-code');
const fpHighlightPre = document.getElementById('fp-edit-highlight');
const fpEditBtn = document.getElementById('fp-viewer-edit');
const fpSaveBtn = document.getElementById('fp-viewer-save');
const fpCancelBtn = document.getElementById('fp-viewer-cancel');
let fpEditRawText = '';
let fpEditLang = '';

document.getElementById('fp-viewer-back').onclick = () => {
  fpExitEdit();
  fpViewer.classList.remove('active'); fpBody.style.display = '';
};
document.getElementById('fp-viewer-download').onclick = () => {
  const p = fpViewer.dataset.path;
  if (!p) return;
  if (fpViewer.dataset.remote) {
    const origSource = fpSourceSelect.value;
    fpSourceSelect.value = fpViewer.dataset.remote;
    fpDownload(p);
    fpSourceSelect.value = origSource;
  } else {
    fpDownload(p);
  }
};

function fpSyncHighlight() {
  fpHighlightCode.textContent = fpEditor.value + '\n';
  fpHighlightCode.className = fpEditLang ? `language-${fpEditLang}` : '';
  if (fpEditLang && window.Prism) Prism.highlightElement(fpHighlightCode);
}

fpEditBtn.onclick = () => {
  const name = fpViewerName.textContent;
  if (!isTextFile(name)) return;
  fpEditLang = prismLang(name) || '';
  fpViewerContent.style.display = 'none';
  fpEditWrap.classList.add('active');
  fpEditor.value = fpEditRawText;
  fpSyncHighlight();
  fpEditBtn.style.display = 'none';
  fpSaveBtn.style.display = '';
  fpCancelBtn.style.display = '';
  fpEditor.focus();
};

fpEditor.addEventListener('input', fpSyncHighlight);
fpEditor.addEventListener('scroll', () => {
  fpHighlightPre.style.transform = `translate(-${fpEditor.scrollLeft}px, -${fpEditor.scrollTop}px)`;
});

fpCancelBtn.onclick = fpExitEdit;

function fpExitEdit() {
  fpEditWrap.classList.remove('active');
  fpViewerContent.style.display = '';
  fpEditBtn.style.display = '';
  fpSaveBtn.style.display = 'none';
  fpCancelBtn.style.display = 'none';
}

fpSaveBtn.onclick = async () => {
  const p = fpViewer.dataset.path;
  if (!p) return;
  fpSaveBtn.textContent = 'Saving...';
  fpSaveBtn.disabled = true;
  try {
    const remoteHost = fpViewer.dataset.remote;
    let r;
    if (remoteHost) {
      r = await fetch(`${API}/api/remote/write?host=${encodeURIComponent(remoteHost)}&path=${encodeURIComponent(p)}`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
        body: fpEditor.value,
      });
    } else {
      r = await fetch(`${API}/api/workspace/save?path=${encodeURIComponent(p)}`, {
        method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
        body: fpEditor.value,
      });
    }
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    fpEditRawText = fpEditor.value;
    fpExitEdit();
    fpViewFile(p, fpViewerName.textContent);
  } catch (e) { alert('Save failed: ' + e.message); }
  fpSaveBtn.textContent = '\u2713 Save';
  fpSaveBtn.disabled = false;
};

fpEditor.addEventListener('keydown', (e) => {
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    fpSaveBtn.click();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = fpEditor.selectionStart;
    const end = fpEditor.selectionEnd;
    fpEditor.value = fpEditor.value.substring(0, start) + '  ' + fpEditor.value.substring(end);
    fpEditor.selectionStart = fpEditor.selectionEnd = start + 2;
    fpSyncHighlight();
  }
});

function fpDownload(filePath) {
  const remote = fpIsRemote();
  const url = remote
    ? `${API}/api/remote/read?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(filePath)}&download=1`
    : `${API}/files/${encodeURIComponent(filePath)}?download=1`;
  if (remote) {
    fetch(url, { headers: authHeaders() })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filePath.split('/').pop();
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      })
      .catch(e => alert('Download failed: ' + e.message));
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filePath.split('/').pop();
    document.body.appendChild(a); a.click(); a.remove();
  }
}

async function fpDelete(filePath, isDir) {
  const label = isDir ? 'directory' : 'file';
  if (!confirm(`Delete ${label} "${filePath.split('/').pop()}"?`)) return;
  try {
    const remote = fpIsRemote();
    const url = remote
      ? `${API}/api/remote/file?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(filePath)}`
      : `${API}/api/workspace/file?path=${encodeURIComponent(filePath)}`;
    const r = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    fpLoadDir(fpCurrentPath);
  } catch (e) { alert('Delete failed: ' + e.message); }
}

// ── Upload ──
document.getElementById('fp-btn-upload').onclick = () => {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true;
  input.onchange = () => { if (input.files.length) fpUploadFiles(input.files); };
  input.click();
};

fpDropzone.onclick = () => document.getElementById('fp-btn-upload').click();

fpDropzone.addEventListener('dragover', (e) => { e.preventDefault(); fpDropzone.classList.add('dragover'); });
fpDropzone.addEventListener('dragleave', () => fpDropzone.classList.remove('dragover'));
fpDropzone.addEventListener('drop', (e) => {
  e.preventDefault(); fpDropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) fpUploadFiles(e.dataTransfer.files);
});

async function fpUploadFiles(files) {
  const fd = new FormData();
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { alert(`File "${f.name}" exceeds 10MB limit`); return; }
    fd.append('files', f);
  }
  fpList.innerHTML = `<div style="padding:14px;color:var(--accent)">Uploading ${files.length} file(s)...</div>`;
  try {
    const h = authHeaders(); delete h['Content-Type'];
    const remote = fpIsRemote();
    const url = remote
      ? `${API}/api/remote/write?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(fpCurrentPath || '/')}`
      : `${API}/api/workspace/upload?path=${encodeURIComponent(fpCurrentPath)}`;
    const r = await fetch(url, { method: 'POST', headers: h, body: fd });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    fpLoadDir(fpCurrentPath);
  } catch (e) { alert('Upload failed: ' + e.message); fpLoadDir(fpCurrentPath); }
}

// ── New Folder ──
document.getElementById('fp-btn-mkdir').onclick = async () => {
  const name = prompt('Folder name:');
  if (!name || !name.trim()) return;
  try {
    const remote = fpIsRemote();
    const url = remote
      ? `${API}/api/remote/mkdir?host=${encodeURIComponent(fpHostId())}&path=${encodeURIComponent(fpCurrentPath || '/')}&name=${encodeURIComponent(name.trim())}`
      : `${API}/api/workspace/mkdir?path=${encodeURIComponent(fpCurrentPath)}&name=${encodeURIComponent(name.trim())}`;
    const r = await fetch(url, { method: 'POST', headers: authHeaders() });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    fpLoadDir(fpCurrentPath);
  } catch (e) { alert('Failed to create folder: ' + e.message); }
};

// Boot is handled by initApp() after successful auth

// Load local Whisper model only when no server STT (Deepgram) is configured.
// Called from loadAgentIdentity() once sttEnabled is known.
function initWhisperSTT() {
  let _lastWhisperLog = '';
  const _logWhisper = (op, source) => {
    const key = op + '|' + source;
    if (key === _lastWhisperLog) return;
    _lastWhisperLog = key;
    try { addEventToFeed({ op, source }); } catch {}
  };
  WhisperSTT.init(
    // Status callback — text + phase. Routed to event log.
    (status, phase) => {
      console.log('[whisper]', phase, status);
      if (phase === 'ready' || phase === 'ready-warmup') {
        _logWhisper('whisper:ready', status);
      } else if (phase === 'error') {
        _logWhisper('whisper:error', status);
      } else if (phase === 'shader') {
        _logWhisper('whisper:shader', 'compiling shaders');
      } else {
        _logWhisper('whisper', status);
      }
    },
    // Progress callback — file download events from transformers.js. Only the
    // milestone events (initiate / done) hit the event log; per-byte progress
    // ticks would flood it.
    (info) => {
      if (!info) return;
      if (info.status === 'initiate') {
        const file = (info.file || '').split('/').pop() || 'file';
        _logWhisper('whisper:fetch', file.substring(0, 32));
      } else if (info.status === 'done') {
        const file = (info.file || '').split('/').pop() || 'file';
        _logWhisper('whisper:done', file.substring(0, 32));
      }
    }
  );
}
