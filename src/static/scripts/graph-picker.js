// graph-picker.js — Multi-graph selector dropdown + new-graph modal helpers.
// Extracted from src/static/scripts/app.js (was lines 12307-12463 of the post-Phase-2 monolith).

// ── Multi-Graph Picker ──
const graphPickerEl = document.getElementById('graph-picker');
let _graphPickerOpen = false;
let _graphsList = [];
let _viewedGraphSlug = null;
let _viewedGraphMeta = null;
let _dockGraphMenuOpen = false;

function _isInspectOnlyGraph(g) {
  return !!(g?.readOnly || g?.canManage === false || g?.inspectOnly || g?.activationLocked || g?.managed || g?.protected || g?.role === 'project' || g?.role === 'general_kb');
}

function _canManageGraphsFromPicker() {
  if (typeof _isCreatorRole === 'function') return _isCreatorRole();
  return !_graphsList.length || !_graphsList.every(g => g?.canManage === false || g?.readOnly);
}

function _setViewedGraph(data, fallbackSlug) {
  const graph = data?.graph || null;
  _viewedGraphSlug = graph?.slug || fallbackSlug || null;
  _viewedGraphMeta = graph;
  _syncDockGraphButton();
  if (_dockGraphMenuOpen) renderDockGraphsMenu();
}

function _swapGraphWithFade(renderFn) {
  const canvas = document.getElementById('canvas');
  if (!canvas || typeof renderFn !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    renderFn();
    return Promise.resolve();
  }
  canvas.classList.add('graph-transitioning');
  return new Promise(resolve => {
    window.setTimeout(() => {
      try { renderFn(); } finally {
        requestAnimationFrame(() => {
          canvas.classList.remove('graph-transitioning');
          window.setTimeout(resolve, 180);
        });
      }
    }, 130);
  });
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('tools-menu-wrap');
  if (_graphPickerOpen && wrap && !wrap.contains(e.target)) {
    _graphPickerOpen = false;
    graphPickerEl.classList.remove('open');
  }
  const dock = document.getElementById('desktop-dock');
  if (_dockGraphMenuOpen && dock && !dock.contains(e.target)) {
    closeDockGraphsMenu();
  }
});

async function loadGraphsList() {
  try {
    const res = await fetch(API + '/api/graphs');
    const data = await res.json();
    _graphsList = data.graphs || [];
    renderGraphPicker();
    if (_dockGraphMenuOpen) renderDockGraphsMenu();
  } catch (e) {
    graphPickerEl.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:.75rem">Failed to load graphs</div>';
    if (_dockGraphMenuOpen) renderDockGraphsMenu('Failed to load graphs');
  }
}

function _graphDockBadge(g) {
  if (!g) return '';
  if (g.active) return 'active';
  if (_viewedGraphSlug === g.slug) return 'viewing';
  if (g.role === 'general_kb') return 'kb';
  if (g.role === 'project') return 'project';
  if (g.role === 'channel') return 'channel';
  if (_isInspectOnlyGraph(g)) return 'inspect';
  return 'use';
}

function _syncDockGraphButton() {
  const btn = document.getElementById('dock-graphs');
  if (!btn) return;
  const viewingInactive = !!(_viewedGraphSlug && _viewedGraphMeta && _viewedGraphMeta.active !== true);
  btn.classList.toggle('dock-active', _dockGraphMenuOpen || viewingInactive);
  btn.setAttribute('aria-expanded', _dockGraphMenuOpen ? 'true' : 'false');
}

function _sortDockGraphs(graphs) {
  return [...(graphs || [])].sort((a, b) => {
    const ar = a.active ? 0 : (_viewedGraphSlug === a.slug ? 1 : 2);
    const br = b.active ? 0 : (_viewedGraphSlug === b.slug ? 1 : 2);
    if (ar !== br) return ar - br;
    return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
  });
}

function renderDockGraphsMenu(error = null) {
  const menu = document.getElementById('dock-graphs-menu');
  if (!menu) return;
  const graphs = _sortDockGraphs(_graphsList);
  let html = '<div class="dock-graphs-head"><span>Knowledge Graphs</span><button type="button" id="dock-graphs-refresh" title="Refresh graphs" aria-label="Refresh graphs">↻</button></div>';
  html += '<div class="dock-graphs-list">';
  if (error) {
    html += `<div class="dock-graphs-empty">${esc(error)}</div>`;
  } else if (!graphs.length) {
    html += '<div class="dock-graphs-empty">No graphs found</div>';
  } else {
    for (const g of graphs) {
      const badge = _graphDockBadge(g);
      const nodes = g.nodeCount != null ? `${g.nodeCount}n` : '?n';
      const role = g.role ? ` · ${esc(g.role)}` : '';
      const stateClass = g.active ? ' active' : (_viewedGraphSlug === g.slug ? ' viewing' : '');
      html += `<button type="button" class="dock-graph-choice${stateClass}" role="menuitem" data-slug="${esc(g.slug)}">`;
      html += '<span class="dock-graph-main">';
      html += `<span class="dock-graph-name">${esc(g.name || g.slug)}</span>`;
      html += `<span class="dock-graph-meta">${nodes}${role}</span>`;
      html += '</span>';
      html += `<span class="dock-graph-badge">${esc(badge)}</span>`;
      html += '</button>';
    }
  }
  html += '</div>';
  menu.innerHTML = html;

  document.getElementById('dock-graphs-refresh')?.addEventListener('click', (e) => {
    e.stopPropagation();
    loadGraphsList();
  });
  menu.querySelectorAll('.dock-graph-choice[data-slug]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug;
      const g = _graphsList.find(x => x.slug === slug);
      await handleDockGraphChoice(g);
    });
  });
}

async function handleDockGraphChoice(g) {
  if (!g?.slug) return;
  closeDockGraphsMenu();
  if (_isInspectOnlyGraph(g)) {
    await inspectGraph(g.slug);
  } else if (g.active) {
    await viewActiveGraph(g.slug);
  } else {
    await quickSwitchToGraph(g.slug);
  }
}

async function quickSwitchToGraph(slug) {
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    const graphData_ = await fetchGraph({ slug: data.slug || slug, preserveViewed: false });
    _setViewedGraph({ graph: { slug: data.slug || slug, name: data.name || slug, active: true } }, data.slug || slug);
    await _swapGraphWithFade(() => initGraph(graphData_));
    toast(`Switched to "${data.name || slug}"`);
    await loadGraphsList();
    if (typeof renderSettingsGraphsList === 'function') renderSettingsGraphsList();
  } catch (e) {
    toast('Switch failed: ' + e.message, true);
  }
}

function openDockGraphsMenu() {
  const dock = document.getElementById('desktop-dock');
  const btn = document.getElementById('dock-graphs');
  if (!dock || !btn) return;
  if (typeof _closeDockLogsMenu === 'function') _closeDockLogsMenu();
  _dockGraphMenuOpen = true;
  dock.classList.add('graphs-menu-open');
  btn.setAttribute('aria-expanded', 'true');
  _syncDockGraphButton();
  renderDockGraphsMenu();
  loadGraphsList();
}

function closeDockGraphsMenu() {
  const dock = document.getElementById('desktop-dock');
  _dockGraphMenuOpen = false;
  dock?.classList.remove('graphs-menu-open');
  _syncDockGraphButton();
}

function initDockGraphsMenu() {
  const btn = document.getElementById('dock-graphs');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_dockGraphMenuOpen) closeDockGraphsMenu();
    else openDockGraphsMenu();
  });
  _syncDockGraphButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDockGraphsMenu);
} else {
  initDockGraphsMenu();
}

function renderGraphPicker(filter) {
  const q = (filter || '').toLowerCase().trim();
  const filtered = q ? _graphsList.filter(g =>
    g.name.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q) || g.slug.includes(q)
  ) : _graphsList;

  let html = `<div class="gp-header"><h3>Knowledge Graphs</h3></div>`;
  html += `<input class="gp-search" type="text" placeholder="Search graphs..." id="gp-search-input" value="${esc(filter || '')}">`;
  html += `<div class="gp-list">`;

  if (filtered.length === 0) {
    html += `<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:.75rem">${q ? 'No matches' : 'No graphs yet'}</div>`;
  }

  for (const g of filtered) {
    const nodes = g.nodeCount != null ? g.nodeCount : '?';
    const date = g.created ? new Date(g.created).toLocaleDateString() : '';
    const inspectOnly = _isInspectOnlyGraph(g);
    const canManage = g?.canManage !== false && !g?.readOnly && _canManageGraphsFromPicker();
    const viewing = _viewedGraphSlug === g.slug && !g.active;
    const backlog = Number(g.embeddingBacklog || 0);
    const maint = g.maintenanceStatus === 'running'
      ? 'maintaining'
      : (g.communityState === 'unclustered'
        ? 'unclustered'
        : (backlog > 0 ? `${backlog} embed` : (g.lastMaintainedAt ? 'maintained' : 'new')));
    html += `<div class="gp-item${g.active ? ' active' : ''}${viewing ? ' viewing' : ''}${inspectOnly ? ' protected' : ''}" data-slug="${esc(g.slug)}">`;
    html += `<div class="gp-name" title="${esc(g.description || '')}">${esc(g.name)}</div>`;
    html += `<div class="gp-meta">${nodes}n · ${date}${g.role ? ` · ${esc(g.role)}` : ''} · ${esc(maint)}</div>`;
    if (g.active) {
      html += `<span class="gp-active-badge">ACTIVE</span>`;
    } else if (viewing) {
      html += `<span class="gp-active-badge">VIEWING</span>`;
    } else if (inspectOnly) {
      html += `<span class="gp-active-badge">${g.role === 'project' ? 'PROJECT' : 'SYSTEM'}</span>`;
      html += `<div class="gp-actions">`;
      if (canManage) html += `<button onclick="event.stopPropagation();maintainGraph('${esc(g.slug)}')" title="Run safe graph maintenance">maintain</button>`;
      html += `<button onclick="event.stopPropagation();inspectGraph('${esc(g.slug)}')" title="Inspect managed graph">inspect</button>`;
      html += `</div>`;
    } else {
      html += `<div class="gp-actions">`;
      html += `<button onclick="event.stopPropagation();maintainGraph('${esc(g.slug)}')" title="Run graph maintenance">maintain</button>`;
      html += `<button onclick="event.stopPropagation();switchToGraph('${esc(g.slug)}')" title="Switch to this graph">use</button>`;
      html += `<button onclick="event.stopPropagation();duplicateGraph('${esc(g.slug)}','${esc(g.name)}')" title="Duplicate">dup</button>`;
      html += `<button class="gp-del" onclick="event.stopPropagation();deleteGraph('${esc(g.slug)}','${esc(g.name)}')" title="Delete">del</button>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  if (_canManageGraphsFromPicker()) {
    html += `<div class="gp-footer"><button class="gp-new" onclick="openNewGraphModal()">+ New Graph</button></div>`;
  }

  graphPickerEl.innerHTML = html;

  const searchInput = document.getElementById('gp-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => renderGraphPicker(e.target.value));
    if (filter) searchInput.focus();
  }

  graphPickerEl.querySelectorAll('.gp-item[data-slug]').forEach(el => {
    el.addEventListener('click', () => {
      const slug = el.dataset.slug;
      const g = _graphsList.find(x => x.slug === slug);
      if (_isInspectOnlyGraph(g)) inspectGraph(slug);
      else if (g?.active && _viewedGraphSlug !== slug) viewActiveGraph(slug);
      else if (g && !g.active) switchToGraph(slug);
    });
  });
}

async function maintainGraph(slug) {
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/maintenance/run`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true, reason: 'graph-picker' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { toast(data.error || 'Maintenance failed', true); return; }
    toast(`Maintained "${slug}"`);
    await loadGraphsList();
    if (_viewedGraphSlug === slug) inspectGraph(slug);
  } catch (e) {
    toast('Maintenance failed: ' + e.message, true);
  }
}

async function inspectGraph(slug) {
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/data`);
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    _setViewedGraph(data, slug);
    await _swapGraphWithFade(() => { if (typeof initGraph === 'function') initGraph(data); });
    toast(`Inspecting "${data.graph?.name || slug}"`);
    _graphPickerOpen = false;
    graphPickerEl.classList.remove('open');
    renderGraphPicker();
    if (typeof renderSettingsGraphsList === 'function') renderSettingsGraphsList();
  } catch (e) {
    toast('Inspect failed: ' + e.message, true);
  }
}

async function viewActiveGraph(slug = null) {
  try {
    const data = await fetchGraph({ preserveViewed: false });
    const active = _graphsList.find(g => g.active) || null;
    _setViewedGraph({
      graph: active || {
        slug: slug || data?.graph?.slug || 'default',
        name: data?.graph?.name || slug || 'Default',
        active: true,
      },
    }, active?.slug || slug || 'default');
    await _swapGraphWithFade(() => { if (typeof initGraph === 'function') initGraph(data); });
    if (slug || active?.name) toast(`Viewing "${active?.name || slug}"`);
    renderGraphPicker();
    if (typeof renderSettingsGraphsList === 'function') renderSettingsGraphsList();
  } catch (e) {
    toast('Graph reload failed: ' + e.message, true);
  }
}

async function switchToGraph(slug) {
  if (!confirm('Switch to a different knowledge graph? The agent will use the new graph immediately.')) return;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Switched to "${data.name || slug}"`);
    _graphPickerOpen = false;
    graphPickerEl.classList.remove('open');
    // Reload the graph visualization
    const graphData_ = await fetchGraph({ slug: data.slug || slug, preserveViewed: false });
    _setViewedGraph({ graph: { slug: data.slug || slug, name: data.name || slug, active: true } }, data.slug || slug);
    await _swapGraphWithFade(() => initGraph(graphData_));
    await loadGraphsList();
    if (typeof renderSettingsGraphsList === 'function') {
      renderSettingsGraphsList();
    }
  } catch (e) {
    toast('Switch failed: ' + e.message, true);
  }
}

async function duplicateGraph(slug, name) {
  const newName = prompt(`Duplicate "${name}" as:`, `${name} (copy)`);
  if (!newName) return;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Created "${newName}"`);
    loadGraphsList();
  } catch (e) {
    toast('Duplicate failed: ' + e.message, true);
  }
}

async function deleteGraph(slug, name) {
  if (!confirm(`Delete graph "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(API + `/api/graphs/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Deleted "${name}"`);
    loadGraphsList();
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}



function openNewGraphModal() {
  _graphPickerOpen = false;
  graphPickerEl.classList.remove('open');
  document.getElementById('graph-modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('gm-name').focus(), 100);
}

function closeNewGraphModal() {
  document.getElementById('graph-modal-overlay').classList.remove('open');
  document.getElementById('gm-name').value = '';
  document.getElementById('gm-desc').value = '';
}

async function createNewGraph() {
  const name = document.getElementById('gm-name').value.trim();
  const description = document.getElementById('gm-desc').value.trim();
  if (!name) { toast('Name is required', true); return; }
  try {
    const res = await fetch(API + '/api/graphs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast(`Created graph "${name}"`);
    closeNewGraphModal();
    loadGraphsList();
  } catch (e) {
    toast('Create failed: ' + e.message, true);
  }
}
