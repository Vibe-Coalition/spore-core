// panels.js — Floating windows / panel collapse, chat sidebar resize, util-bar,
// settings test buttons, janitor, graph backups, export+import, resizable panels, mobile nav.
// Extracted from src/static/scripts/app.js (was lines 3870-5242 of the post-Phase-2 monolith).

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
  if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return;
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
  if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return;
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
  if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return null;
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
  if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return;
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
      if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return;
      _ensureFloatingWindowInViewport(id, el.getBoundingClientRect());
      _saveFloatingWindowRect(id);
      if (id === 'terminal-pane') window._refitTerminalLayout?.();
    });
    observer.observe(el);
  }
}

function _initDesktopFloatingWindows() {
  _initFloatingWindow('node-pane', '.floating-pane-head');
  _initFloatingWindow('files-pane', '.floating-pane-head');
  _initFloatingWindow('logs-pane', '.floating-pane-head');
  _initFloatingWindow('skills-pane', '.floating-pane-head');
  _initFloatingWindow('terminal-pane', '.floating-pane-head');
}

window.addEventListener('resize', () => {
  if (!_usesFloatingWindows()) {
    _setChatFloatingMode(false, { persist: false, focus: false });
    return;
  }
  if (_panelState().chatFloating === true) _setChatFloatingMode(true, { persist: false, focus: false });
  ['chat-panel', 'node-pane', 'files-pane', 'logs-pane', 'skills-pane', 'terminal-pane'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'chat-panel' && !el.classList.contains('chat-floating')) return;
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
  s.chatFloating = !!document.getElementById('chat-panel')?.classList.contains('chat-floating');
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
function _chatFloatingCloseSvg() {
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
}
function _chatDockedCloseGlyph() {
  return '&#10094;';
}
function _isChatFloating() {
  return !!document.getElementById('chat-panel')?.classList.contains('chat-floating');
}
function _syncChatFloatingChrome() {
  const floating = _isChatFloating();
  const toggle = document.getElementById('chat-float-toggle');
  const max = document.getElementById('chat-window-maximize');
  const close = document.getElementById('chat-collapse');
  document.body.classList.toggle('chat-is-floating', floating);
  if (toggle) {
    toggle.setAttribute('title', floating ? 'Dock chat' : 'Undock chat');
    toggle.setAttribute('aria-label', floating ? 'Dock chat' : 'Undock chat');
    toggle.classList.toggle('is-floating', floating);
  }
  if (max) {
    max.hidden = !floating;
    max.style.display = floating ? '' : 'none';
  }
  if (close) {
    close.innerHTML = floating ? _chatFloatingCloseSvg() : _chatDockedCloseGlyph();
    close.setAttribute('title', floating ? 'Close chat window' : 'Collapse chat sidebar');
    close.setAttribute('aria-label', floating ? 'Close chat window' : 'Collapse chat sidebar');
  }
  _updateFloatingWindowChrome('chat-panel');
}
function _clearChatFloatingInlineRect() {
  const el = document.getElementById('chat-panel');
  if (!el) return;
  el.style.left = '';
  el.style.top = '';
  el.style.right = '';
  el.style.bottom = '';
  el.style.width = '';
  el.style.height = '';
  el.style.zIndex = '';
}
function _setChatFloatingMode(floating, opts = {}) {
  const el = document.getElementById('chat-panel');
  if (!el) return;
  const shouldFloat = !!floating && _usesFloatingWindows();
  const wasFloating = el.classList.contains('chat-floating');
  if (shouldFloat) {
    el.classList.add('chat-floating', 'window-open');
    el.classList.remove('window-maximized', 'fill-remaining');
    _initFloatingWindow('chat-panel', '#chat-header');
    _applyFloatingWindowRect('chat-panel');
    if (opts.focus !== false) _focusFloatingWindow('chat-panel');
  } else {
    el.classList.remove('chat-floating', 'window-open', 'window-maximized');
    delete el.dataset.prevRect;
    _clearChatFloatingInlineRect();
  }
  _syncChatFloatingChrome();
  _syncPanelFill();
  _syncResizeHandles();
  _syncChatReopen();
  if (typeof _syncUtilBar === 'function') _syncUtilBar();
  if (opts.persist !== false && wasFloating !== shouldFloat) _savePanelState();
}
function restorePanelState() {
  const s = _panelState();
  if (_usesFloatingWindows()) {
    const chatVisible = s['chat-panel'] !== false;
    document.getElementById('chat-panel').classList.toggle('collapsed', !chatVisible);
    document.getElementById('canvas').classList.remove('panel-collapsed');
    document.getElementById('btn-toggle-chat').classList.toggle('active', chatVisible);
    _setChatFloatingMode(s.chatFloating === true, { persist: false, focus: false });
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
    _syncChatFloatingChrome();
    if (typeof _syncUtilBar === 'function') _syncUtilBar();
    return;
  }
  _setChatFloatingMode(false, { persist: false, focus: false });
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
  _syncChatFloatingChrome();
}
document.getElementById('tab-right-panel').onclick = () => togglePanel('right-panel');
document.getElementById('tab-canvas').onclick = () => togglePanel('canvas');
document.getElementById('tab-chat').onclick = () => togglePanel('chat-panel');
document.getElementById('btn-toggle-chat').onclick = () => togglePanel('chat-panel');
const _chatCollapseBtn = document.getElementById('chat-collapse');
if (_chatCollapseBtn) _chatCollapseBtn.onclick = () => togglePanel('chat-panel');
document.getElementById('chat-float-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  _setChatFloatingMode(!_isChatFloating());
});
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
  if (_isChatFloating()) return;
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
    if (_isChatFloating()) return;
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
  if (typeof window.toggleDockLogsMenu === 'function') window.toggleDockLogsMenu();
  else toggleRightPaneWindow('logs-pane');
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
  if (t.id === 'settings-new-graph') {
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
  // Reads from the dynamically-rendered provider card —
  // <div data-provider-form="<name>"> wrapping inputs marked with
  // data-provider-field="<key>". One generic walker, no per-vendor
  // hardcoding. Empty fields still emit (blank string) so the server
  // can distinguish "user cleared this" from "field absent".
  const wrap = document.querySelector(`[data-provider-form="${name}"]`);
  if (!wrap) return {};
  const out = {};
  wrap.querySelectorAll('[data-provider-field]').forEach(input => {
    const key = input.getAttribute('data-provider-field');
    if (!key) return;
    out[key] = (input.value || '').trim();
  });
  return out;
}
function _collectModelTierFormValues(tier) {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const provider = v(`settings-model-${tier}-provider`);
  const model = v(`settings-model-${tier}-name`);
  // Include all provider configs so the backend can build the ephemeral client
  const providers = {
    custom: typeof collectSettingsCustomProviders === 'function' ? collectSettingsCustomProviders({ preserveStoredKey: false }) : [],
    __plugins: {},
  };
  document.querySelectorAll('[data-provider-form]').forEach(wrap => {
    const name = wrap.getAttribute('data-provider-form');
    if (!name || name === 'custom') return;
    const values = _collectProviderFormValues(name);
    providers[name] = values;
    const pluginId = wrap.getAttribute('data-provider-plugin-id') || '';
    if (pluginId) providers.__plugins[pluginId] = values;
  });
  if (Object.keys(providers.__plugins).length === 0) delete providers.__plugins;
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
    const r = await fetch(graphApiUrl('/api/graph/export?' + qs), { headers: authHeaders() });
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

    const r = await fetch(graphApiUrl('/api/graph/import?' + qs), {
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
  // Funnel through the unified filter state so it composes with the
  // timeline-filter and the marquee-selection visibility check (a
  // dimmed node from EITHER filter is unselectable). Direct opacity
  // writes here used to clobber whatever the timeline filter had set.
  window._graphFilterState = window._graphFilterState || { typeFilter: '', timeMin: null, timeMax: null };
  window._graphFilterState.typeFilter = e.target.value || '';
  if (typeof window._applyGraphFilters === 'function') window._applyGraphFilters();
};

document.getElementById('search-input').oninput = (e) => {
  // Funnel through the unified filter state — search composes with the
  // type-filter and timeline-filter, and the marquee-selection
  // visibility check skips dimmed nodes for all three.
  window._graphFilterState = window._graphFilterState || { typeFilter: '', timeMin: null, timeMax: null, searchQuery: '' };
  window._graphFilterState.searchQuery = (e.target.value || '').toLowerCase();
  if (typeof window._applyGraphFilters === 'function') window._applyGraphFilters();
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
