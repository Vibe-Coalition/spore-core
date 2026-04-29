// right-panel.js — Unified right pane (Node detail / Files / Logs / Skills tabs) + Local Mount (browser File System Access).
// Extracted from src/static/scripts/app.js (was lines 11187-11761 of the post-Phase-2 monolith).

// ── Unified Right Panel (Node / Files / Logs) ──
const rightPanel = document.getElementById('right-panel');
const rpTabs = document.querySelectorAll('.rp-tab');
const rpPanes = document.querySelectorAll('.rp-pane');

function openRightPanel(tabId, multi) {
  if (_usesFloatingWindows()) {
    rightPanel.classList.remove('closed');
    const pane = document.getElementById(tabId);
    if (!pane) return;
    activeRpTabs.add(tabId);
    activeRpTab = tabId;
    pane.classList.add('window-open');
    pane.classList.add('active');
    _applyFloatingWindowRect(tabId);
    _focusFloatingWindow(tabId);
    if (tabId !== 'node-pane') lastNonNodeTab = tabId;
    if (tabId === 'files-pane') fpLoadDir(fpCurrentPath || '');
    if (tabId === 'logs-pane') loadLogs();
    if (tabId === 'skills-pane') skLoadList();
    _savePanelState();
    _syncResizeHandles();
    _syncPanelFill();
    syncRpButtons();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
    return;
  }
  rightPanel.classList.remove('closed');
  document.getElementById('tab-right-panel').classList.remove('active');
  _savePanelState();

  if (multi) {
    if (activeRpTabs.has(tabId)) {
      activeRpTabs.delete(tabId);
    } else {
      activeRpTabs.add(tabId);
    }
  } else {
    activeRpTabs.clear();
    activeRpTabs.add(tabId);
  }

  if (activeRpTabs.size === 0) { closeRightPanel(); return; }

  rpTabs.forEach(t => t.classList.toggle('active', activeRpTabs.has(t.dataset.pane)));
  rpPanes.forEach(p => p.classList.toggle('active', activeRpTabs.has(p.id)));
  activeRpTab = tabId;

  if (tabId !== 'node-pane') lastNonNodeTab = tabId;
  if (activeRpTabs.has('files-pane')) fpLoadDir(fpCurrentPath || '');
  if (activeRpTabs.has('logs-pane')) loadLogs();
  if (activeRpTabs.has('skills-pane')) skLoadList();
  _syncResizeHandles();
  _syncPanelFill();
  syncRpButtons();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}

function closeRightPanel(tabId = null) {
  if (_usesFloatingWindows()) {
    if (tabId) {
      activeRpTabs.delete(tabId);
      const pane = document.getElementById(tabId);
      pane?.classList.remove('window-open');
      pane?.classList.remove('active');
      if (activeRpTab === tabId) activeRpTab = null;
    } else {
      activeRpTab = null;
      activeRpTabs.clear();
      rpPanes.forEach(p => {
        p.classList.remove('window-open');
        p.classList.remove('active');
      });
    }
    if (activeRpTabs.size === 0) rightPanel.classList.add('closed');
    else rightPanel.classList.remove('closed');
    if (!activeRpTabs.has('logs-pane') && logsAutoInterval) { clearInterval(logsAutoInterval); logsAutoInterval = null; }
    _savePanelState();
    _syncResizeHandles();
    _syncPanelFill();
    syncRpButtons();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
    return;
  }
  rightPanel.classList.add('closed');
  document.getElementById('tab-right-panel').classList.add('active');
  rpTabs.forEach(t => t.classList.remove('active'));
  rpPanes.forEach(p => p.classList.remove('active'));
  activeRpTab = null;
  activeRpTabs.clear();
  if (logsAutoInterval) { clearInterval(logsAutoInterval); logsAutoInterval = null; }
  _savePanelState();
  _syncResizeHandles();
  _syncPanelFill();
  syncRpButtons();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
}

rpTabs.forEach(t => {
  t.onclick = (e) => { openRightPanel(t.dataset.pane, e.shiftKey); syncRpButtons(); };
});
document.getElementById('rp-collapse').onclick = () => { closePanel(); closeRightPanel(); syncRpButtons(); };

function syncRpButtons() {
  document.getElementById('btn-open-node')?.classList.toggle('active', activeRpTabs.has('node-pane'));
  document.getElementById('btn-toggle-sidebar')?.classList.toggle('active', activeRpTabs.has('files-pane'));
  document.getElementById('btn-open-logs')?.classList.toggle('active', activeRpTabs.has('logs-pane'));
}

// ── Logs ──
const logsContent = document.getElementById('logs-content');
async function loadLogs() {
  logsContent.textContent = 'Loading...';
  try {
    const r = await fetch(API + '/api/logs?lines=500', { headers: authHeaders() });
    logsContent.textContent = await r.text();
    logsContent.scrollTop = logsContent.scrollHeight;
  } catch (e) { logsContent.textContent = 'Failed to load logs: ' + e.message; }
}

document.getElementById('logs-refresh').onclick = loadLogs;
document.getElementById('logs-auto').onclick = function() {
  if (logsAutoInterval) {
    clearInterval(logsAutoInterval); logsAutoInterval = null;
    this.style.borderColor = ''; this.style.color = '';
  } else {
    logsAutoInterval = setInterval(loadLogs, 3000);
    this.style.borderColor = 'var(--accent)'; this.style.color = 'var(--accent)';
    loadLogs();
  }
};

// ── Local Mount (Browser File System Access API) ──
const _LM_DB_NAME = 'spore-local-mount';
const _LM_DB_VERSION = 1;
const _LM_BINARY_EXTS = new Set(['png','jpg','jpeg','gif','bmp','ico','webp','svg','mp4','webm','mov','avi','mp3','wav','ogg','flac','zip','tar','gz','bz2','7z','rar','pdf','exe','dll','so','dylib','woff','woff2','ttf','eot','bin','dat','db','sqlite','pyc','pyo','class','o','obj']);

class LocalMount {
  constructor() {
    this.dirHandle = null;
    this.mountName = '';
    this.mode = 'rw';
    this.ignorePatterns = [];
    this.skipBinary = true;
    this.cleanOnUnmount = false;
    this.localIndex = new Map();
    this.remoteIndex = new Map();
    this._watchTimer = null;
    this._remoteTimer = null;
    this._syncing = false;
    this._status = 'idle';
    this._mounted = false;
    this._totalFiles = 0;
    this._syncedFiles = 0;
  }

  get serverPath() { return `local-mount/${this.mountName}`; }

  _shouldIgnore(relPath) {
    const name = relPath.split('/').pop();
    for (const pat of this.ignorePatterns) {
      if (!pat) continue;
      if (pat.endsWith('/') && relPath.includes(pat.slice(0, -1))) return true;
      if (pat.startsWith('*.')) { if (name.endsWith(pat.slice(1))) return true; }
      else if (name === pat) return true;
    }
    if (this.skipBinary) {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      if (_LM_BINARY_EXTS.has(ext)) return true;
    }
    return false;
  }

  async _walkDir(dirHandle, prefix = '') {
    const entries = [];
    for await (const [name, handle] of dirHandle) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (this._shouldIgnore(rel)) continue;
      if (handle.kind === 'directory') {
        entries.push(...await this._walkDir(handle, rel));
      } else {
        try {
          const file = await handle.getFile();
          entries.push({ path: rel, size: file.size, mtime: file.lastModified, handle });
        } catch {}
      }
    }
    return entries;
  }

  async _readFileHandle(fileHandle) {
    const file = await fileHandle.getFile();
    return file;
  }

  async _writeToLocal(relPath, data) {
    const parts = relPath.split('/');
    let dirH = this.dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dirH = await dirH.getDirectoryHandle(parts[i], { create: true });
    }
    const fileH = await dirH.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileH.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async _pushFile(relPath, fileHandle) {
    const file = await fileHandle.getFile();
    if (file.size > 10 * 1024 * 1024) return;
    const fd = new FormData();
    fd.append(relPath, file, relPath);
    await fetch(`${API}/api/workspace/upload-batch?path=${encodeURIComponent(this.serverPath)}`, {
      method: 'POST', headers: authHeaders(), body: fd,
    });
  }

  async _pushBatch(entries) {
    const BATCH_SIZE = 20;
    const MAX_BATCH_BYTES = 30 * 1024 * 1024;
    let batch = [];
    let batchBytes = 0;

    const flush = async (b) => {
      if (!b.length) return;
      const fd = new FormData();
      for (const { path: p, file } of b) fd.append(p, file, p);
      await fetch(`${API}/api/workspace/upload-batch?path=${encodeURIComponent(this.serverPath)}`, {
        method: 'POST', headers: authHeaders(), body: fd,
      });
    };

    for (const entry of entries) {
      const file = await entry.handle.getFile();
      if (file.size > 10 * 1024 * 1024) { this._syncedFiles++; continue; }
      batch.push({ path: entry.path, file });
      batchBytes += file.size;
      if (batch.length >= BATCH_SIZE || batchBytes >= MAX_BATCH_BYTES) {
        await flush(batch);
        this._syncedFiles += batch.length;
        this._updateProgress();
        batch = []; batchBytes = 0;
      }
    }
    await flush(batch);
    this._syncedFiles += batch.length;
    this._updateProgress();
  }

  async _fetchRemoteTree() {
    const r = await fetch(`${API}/api/workspace/tree?path=${encodeURIComponent(this.serverPath)}`, {
      headers: authHeaders(),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data.files || [];
  }

  async _pullFile(relPath) {
    const r = await fetch(`${API}/files/${encodeURIComponent(this.serverPath + '/' + relPath)}`, {
      headers: authHeaders(),
    });
    if (!r.ok) return;
    const blob = await r.blob();
    await this._writeToLocal(relPath, blob);
  }

  async initialSync() {
    this._setStatus('syncing');
    this._showProgress('Scanning local files...');
    const entries = await this._walkDir(this.dirHandle);
    this._totalFiles = entries.length;
    this._syncedFiles = 0;
    this._showProgress(`Uploading ${entries.length} files...`);
    this.localIndex.clear();
    for (const e of entries) this.localIndex.set(e.path, { size: e.size, mtime: e.mtime, handle: e.handle });
    await this._pushBatch(entries);
    this._hideProgress();
    this._setStatus('idle');
  }

  async syncLocal() {
    if (this._syncing || !this._mounted) return;
    this._syncing = true;
    try {
      const entries = await this._walkDir(this.dirHandle);
      const currentPaths = new Set();
      const toUpload = [];

      for (const e of entries) {
        currentPaths.add(e.path);
        const prev = this.localIndex.get(e.path);
        if (!prev || prev.mtime !== e.mtime || prev.size !== e.size) {
          toUpload.push(e);
          this.localIndex.set(e.path, { size: e.size, mtime: e.mtime, handle: e.handle });
        }
      }

      for (const [p] of this.localIndex) {
        if (!currentPaths.has(p)) {
          this.localIndex.delete(p);
          try {
            await fetch(`${API}/api/workspace/file?path=${encodeURIComponent(this.serverPath + '/' + p)}`, {
              method: 'DELETE', headers: authHeaders(),
            });
          } catch {}
        }
      }

      if (toUpload.length > 0) {
        this._setStatus('syncing');
        this._totalFiles = toUpload.length;
        this._syncedFiles = 0;
        await this._pushBatch(toUpload);
        this._setStatus('idle');
      }
    } catch (e) {
      console.warn('[local-mount] sync error:', e);
      this._setStatus('error');
    }
    this._syncing = false;
  }

  async syncRemote() {
    if (this.mode !== 'rw' || this._syncing || !this._mounted) return;
    this._syncing = true;
    try {
      const remoteFiles = await this._fetchRemoteTree();
      const localPaths = new Set(this.localIndex.keys());

      for (const rf of remoteFiles) {
        const local = this.localIndex.get(rf.path);
        if (!local) {
          await this._pullFile(rf.path);
          this.localIndex.set(rf.path, { size: rf.size, mtime: rf.mtime, handle: null });
        } else if (rf.mtime > local.mtime + 1000) {
          await this._pullFile(rf.path);
          this.localIndex.set(rf.path, { ...local, size: rf.size, mtime: rf.mtime });
        }
      }
    } catch (e) {
      console.warn('[local-mount] remote sync error:', e);
    }
    this._syncing = false;
  }

  startWatching() {
    this._watchTimer = setInterval(() => this.syncLocal(), 5000);
    if (this.mode === 'rw') {
      this._remoteTimer = setInterval(() => this.syncRemote(), 10000);
    }
  }

  stopWatching() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    if (this._remoteTimer) { clearInterval(this._remoteTimer); this._remoteTimer = null; }
  }

  async mount(dirHandle, opts = {}) {
    this.dirHandle = dirHandle;
    this.mountName = dirHandle.name;
    this.mode = opts.mode || 'rw';
    this.ignorePatterns = opts.ignorePatterns || [];
    this.skipBinary = opts.skipBinary !== false;
    this.cleanOnUnmount = opts.cleanOnUnmount || false;
    this._mounted = true;
    await this._saveHandleToIDB();
    await this.initialSync();
    this.startWatching();
    lmUpdateUI();
  }

  async unmount() {
    this.stopWatching();
    this._mounted = false;
    if (this.cleanOnUnmount) {
      try {
        await fetch(`${API}/api/workspace/file?path=${encodeURIComponent(this.serverPath)}`, {
          method: 'DELETE', headers: authHeaders(),
        });
      } catch {}
    }
    this.dirHandle = null;
    this.localIndex.clear();
    this.remoteIndex.clear();
    this._setStatus('idle');
    await this._clearIDB();
    lmUpdateUI();
  }

  async _saveHandleToIDB() {
    try {
      const db = await this._openDB();
      const tx = db.transaction('mounts', 'readwrite');
      tx.objectStore('mounts').put({
        id: 'current',
        handle: this.dirHandle,
        mountName: this.mountName,
        mode: this.mode,
        ignorePatterns: this.ignorePatterns,
        skipBinary: this.skipBinary,
        cleanOnUnmount: this.cleanOnUnmount,
      });
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = fail; });
    } catch (e) { console.warn('[local-mount] IDB save failed:', e); }
  }

  async _clearIDB() {
    try {
      const db = await this._openDB();
      const tx = db.transaction('mounts', 'readwrite');
      tx.objectStore('mounts').delete('current');
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = fail; });
    } catch {}
  }

  async tryRestoreFromIDB() {
    try {
      const db = await this._openDB();
      const tx = db.transaction('mounts', 'readonly');
      const req = tx.objectStore('mounts').get('current');
      const result = await new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = fail; });
      if (!result || !result.handle) return false;
      const perm = await result.handle.queryPermission({ mode: result.mode === 'rw' ? 'readwrite' : 'read' });
      if (perm === 'granted') {
        this.dirHandle = result.handle;
        this.mountName = result.mountName;
        this.mode = result.mode;
        this.ignorePatterns = result.ignorePatterns || [];
        this.skipBinary = result.skipBinary !== false;
        this.cleanOnUnmount = result.cleanOnUnmount || false;
        this._mounted = true;
        this.startWatching();
        this.syncLocal();
        lmUpdateUI();
        return true;
      }
      return false;
    } catch { return false; }
  }

  _openDB() {
    return new Promise((ok, fail) => {
      const req = indexedDB.open(_LM_DB_NAME, _LM_DB_VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore('mounts', { keyPath: 'id' }); };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  }

  _setStatus(s) {
    this._status = s;
    const el = document.getElementById('lm-sync-indicator');
    const label = document.getElementById('lm-sync-label');
    if (!el) return;
    el.className = `lm-sync-indicator ${this._mounted ? 'active' : ''} ${s}`;
    label.textContent = s === 'syncing' ? 'syncing...' : s === 'error' ? 'sync error' : 'synced';
  }

  _showProgress(text) {
    const el = document.getElementById('lm-progress');
    const txt = document.getElementById('lm-progress-text');
    if (el) { el.classList.add('active'); txt.textContent = text; }
    this._updateProgress();
  }

  _hideProgress() {
    const el = document.getElementById('lm-progress');
    if (el) el.classList.remove('active');
  }

  _updateProgress() {
    const fill = document.getElementById('lm-progress-fill');
    const txt = document.getElementById('lm-progress-text');
    if (!fill) return;
    const pct = this._totalFiles > 0 ? Math.round((this._syncedFiles / this._totalFiles) * 100) : 0;
    fill.style.width = pct + '%';
    if (txt && this._totalFiles > 0) txt.textContent = `Syncing ${this._syncedFiles}/${this._totalFiles} files (${pct}%)`;
  }
}

const _localMount = new LocalMount();

function lmUpdateUI() {
  const mountBtn = document.getElementById('lm-mount-btn');
  const indicator = document.getElementById('lm-sync-indicator');
  const banner = document.getElementById('lm-banner');
  const bannerPath = document.getElementById('lm-banner-path');

  if (_localMount._mounted) {
    if (mountBtn) mountBtn.style.display = 'none';
    if (indicator) indicator.classList.add('active');
    if (banner) { banner.classList.add('active'); bannerPath.textContent = `/workspace/${_localMount.serverPath}/`; }

    if (!fpSourceSelect.querySelector('option[value="local-mount"]')) {
      const opt = document.createElement('option');
      opt.value = 'local-mount';
      opt.textContent = _localMount.mountName;
      fpSourceSelect.appendChild(opt);
    }
    fpSourceSelect.value = 'local-mount';
    fpCurrentPath = _localMount.serverPath;
    fpLoadDir(fpCurrentPath);
  } else {
    if (mountBtn) mountBtn.style.display = '';
    if (indicator) indicator.classList.remove('active');
    if (banner) banner.classList.remove('active');
    const opt = fpSourceSelect.querySelector('option[value="local-mount"]');
    if (opt) opt.remove();
    if (fpSourceSelect.value === 'local-mount' || !fpSourceSelect.value) {
      fpSourceSelect.value = 'local';
      fpCurrentPath = '';
      fpLoadDir('');
    }
  }
}

function lmOpenSettings() {
  document.getElementById('lm-settings-overlay').classList.add('active');
}

function lmCloseSettings() {
  document.getElementById('lm-settings-overlay').classList.remove('active');
}

async function lmConfirmMount() {
  lmCloseSettings();
  const mode = document.getElementById('lm-access').value;
  const ignoreText = document.getElementById('lm-ignore').value;
  const skipBinary = document.getElementById('lm-skip-binary').checked;
  const cleanOnUnmount = document.getElementById('lm-clean-unmount').checked;
  const ignorePatterns = ignoreText.split('\n').map(l => l.trim()).filter(Boolean);

  try {
    const fsMode = mode === 'rw' ? 'readwrite' : 'read';
    const dirHandle = await window.showDirectoryPicker({ mode: fsMode });
    await _localMount.mount(dirHandle, { mode, ignorePatterns, skipBinary, cleanOnUnmount });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('[local-mount] mount failed:', e);
      alert('Failed to mount folder: ' + e.message);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const mountBtn = document.getElementById('lm-mount-btn');
  if (mountBtn) {
    mountBtn.addEventListener('click', () => {
      if (!window.showDirectoryPicker) {
        alert('Your browser does not support the File System Access API.\nPlease use Chrome or Edge.');
        return;
      }
      lmOpenSettings();
    });
  }

  const unmountBtn = document.getElementById('lm-unmount-btn');
  if (unmountBtn) {
    unmountBtn.addEventListener('click', () => {
      if (confirm('Unmount local folder? Sync will stop.')) {
        _localMount.unmount();
      }
    });
  }

  _localMount.tryRestoreFromIDB();
});

window.addEventListener('beforeunload', (e) => {
  if (_localMount._mounted) {
    e.preventDefault();
    e.returnValue = 'Local folder sync is active. Closing this tab will stop syncing.';
  }
});
