// tools-menu.js — Header tools menu dropdown wiring + Enhanced Recall toggle.
// Extracted from src/static/scripts/app.js (was lines 757-832 of the post-Phase-2 monolith).

// ── Tools menu ──
const toolsMenuBtn = document.getElementById('btn-tools-menu');
const toolsMenu = document.getElementById('tools-menu');
let _toolsMenuOpen = false;

function closeToolsSubmenus() {
  if (_graphPickerOpen) { _graphPickerOpen = false; graphPickerEl?.classList.remove('open'); }
}

toolsMenuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  _toolsMenuOpen = !_toolsMenuOpen;
  toolsMenu.style.display = _toolsMenuOpen ? 'block' : 'none';
  if (!_toolsMenuOpen) closeToolsSubmenus();
});

document.addEventListener('click', e => {
  const wrap = document.getElementById('tools-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    _toolsMenuOpen = false;
    toolsMenu.style.display = 'none';
    closeToolsSubmenus();
  }
});

document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleTheme();
});

document.getElementById('tmi-settings')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettingsPanel();
});

document.getElementById('tmi-graphs')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsMenu.style.display = 'none';
  _toolsMenuOpen = false;
  _graphPickerOpen = !_graphPickerOpen;
  if (_graphPickerOpen) { loadGraphsList(); graphPickerEl?.classList.add('open'); }
  else { graphPickerEl?.classList.remove('open'); }
});

document.getElementById('tmi-longmemeval')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsMenu.style.display = 'none';
  _toolsMenuOpen = false;
  lmeOpen();
});

// Enhanced Recall toggle
let _erEnabled = false;
const erBadge = document.getElementById('er-badge');
function updateErBadge(on) {
  _erEnabled = on;
  if (!erBadge) return;
  erBadge.textContent = on ? 'ON' : 'OFF';
  erBadge.style.background = on ? 'var(--accent2)' : 'var(--border)';
  erBadge.style.color = on ? 'var(--bg)' : 'var(--text-dim)';
}
fetch(API + '/api/enhanced-recall', { headers: authHeaders() }).then(r => r.json()).then(d => {
  updateErBadge(!!d.enhancedRecall);
}).catch(() => {});
document.getElementById('tmi-enhanced-recall')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const newState = !_erEnabled;
  updateErBadge(newState);
  fetch(API + '/api/enhanced-recall', {
    method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: newState }),
  }).then(r => r.json()).then(d => {
    toast(d.enhancedRecall ? 'Enhanced Recall ON — LLM search active' : 'Enhanced Recall OFF');
  }).catch(() => { updateErBadge(!newState); toast('Failed to update', true); });
});

