// graph-picker.js — Multi-graph selector dropdown + new-graph modal helpers.
// Extracted from src/static/scripts/app.js (was lines 12307-12463 of the post-Phase-2 monolith).

// ── Multi-Graph Picker ──
const graphPickerEl = document.getElementById('graph-picker');
let _graphPickerOpen = false;
let _graphsList = [];

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('tools-menu-wrap');
  if (_graphPickerOpen && wrap && !wrap.contains(e.target)) {
    _graphPickerOpen = false;
    graphPickerEl.classList.remove('open');
  }
});

async function loadGraphsList() {
  try {
    const res = await fetch(API + '/api/graphs');
    const data = await res.json();
    _graphsList = data.graphs || [];
    renderGraphPicker();
  } catch (e) {
    graphPickerEl.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:.75rem">Failed to load graphs</div>';
  }
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
    html += `<div class="gp-item${g.active ? ' active' : ''}" data-slug="${esc(g.slug)}">`;
    html += `<div class="gp-name" title="${esc(g.description || '')}">${esc(g.name)}</div>`;
    html += `<div class="gp-meta">${nodes}n · ${date}</div>`;
    if (g.active) {
      html += `<span class="gp-active-badge">ACTIVE</span>`;
    } else {
      html += `<div class="gp-actions">`;
      html += `<button onclick="event.stopPropagation();switchToGraph('${esc(g.slug)}')" title="Switch to this graph">use</button>`;
      html += `<button onclick="event.stopPropagation();duplicateGraph('${esc(g.slug)}','${esc(g.name)}')" title="Duplicate">dup</button>`;
      html += `<button class="gp-del" onclick="event.stopPropagation();deleteGraph('${esc(g.slug)}','${esc(g.name)}')" title="Delete">del</button>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  html += `<div class="gp-footer"><button class="gp-new" onclick="openNewGraphModal()">+ New Graph</button></div>`;

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
      if (g && !g.active) switchToGraph(slug);
    });
  });
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
    const graphData_ = await fetchGraph();
    initGraph(graphData_);
    loadGraphsList();
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
