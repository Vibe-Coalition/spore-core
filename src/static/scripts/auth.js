// auth.js — Auth check, login redirect, role gating, post-login initApp().
// Extracted from src/static/scripts/app.js (was lines 833-897 + 998-1025 of the post-Phase-2 monolith).

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
  // Plugin-contributed UI (longmemeval HUD, etc.) is gated at the
  // plugin's own boot path — see plugins/longmemeval/static/longmemeval.js.
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


