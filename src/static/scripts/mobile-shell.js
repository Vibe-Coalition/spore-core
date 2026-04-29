// mobile-shell.js — wires the mobile-viewer.html chrome (#m-header,
// #m-tab-bar, #m-drawer) and moves the desktop chat DOM into the mobile
// chat surface. Loaded ONLY by mobile-viewer.html, AFTER boot.js.
//
// Phase N1 strategy:
//   - Chat: move #chat-messages and #chat-input-area into #m-chat-view
//     so chat.js's WS-driven rendering populates the mobile bubbles
//     (CSS in mobile-shell.css restyles .chat-msg / .chat-row from
//     desktop layout into iMessage-style bubbles).
//   - Graph + Settings: tab views show "coming in N2/N3" placeholders;
//     the desktop graph canvas and settings modal stay hidden.
//   - Drawer (☰): theme toggle, multi-graph picker (reuses tools-menu),
//     desktop-view escape hatch.
//
// Phase N2 + N3 will replace the placeholders with their own
// mobile-native surfaces (graph node list, settings drilldown).

(function initMobileShell() {
  const body = document.body;
  const tabs = document.querySelectorAll('#m-tab-bar button[data-m-view]');
  if (!tabs.length) return; // not mobile shell — bail

  // ── Suppress desktop right-panel auto-restore ──
  // panels.js#restorePanelState reopens whichever pane the user last
  // had open via openRightPanel(). On the mobile shell we never want
  // that; clear floatingTabs / activeRpTab from localStorage before
  // boot.js's await yields back to showApp() → initApp().
  try {
    const STATE_KEY = '_panelState';
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    if ((s.floatingTabs && s.floatingTabs.length) || s.activeRpTab) {
      delete s.floatingTabs;
      delete s.activeRpTab;
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
    }
  } catch {}
  document.getElementById('right-panel')?.classList.add('closed');

  // ── Move the chat DOM into the mobile chat surface ──
  // chat.js's #chat-messages + #chat-input-area carry every message
  // bubble and the composer controls. We move them into our mobile
  // shell so chat.js keeps writing to those nodes and our CSS restyles
  // them as mobile-native bubbles + composer. The original #chat-panel
  // is hidden via mobile-shell.css.
  const chatStream = document.getElementById('m-chat-stream');
  const composer = document.getElementById('m-composer');
  const chatMessages = document.getElementById('chat-messages');
  const chatInputArea = document.getElementById('chat-input-area');
  const subagent = document.getElementById('subagent-container');
  const activity = document.getElementById('agent-activity');
  if (chatStream && chatMessages) chatStream.appendChild(chatMessages);
  if (chatStream && subagent) chatStream.appendChild(subagent);
  if (chatStream && activity) chatStream.appendChild(activity);
  if (composer && chatInputArea) composer.appendChild(chatInputArea);

  // ── Tab bar ──
  function setView(view) {
    body.classList.remove('m-view-chat', 'm-view-graph', 'm-view-settings');
    body.classList.add('m-view-' + view);
    tabs.forEach(t => t.classList.toggle('active', t.dataset.mView === view));
    const title = document.getElementById('m-title');
    if (title) {
      title.textContent = view === 'chat' ? 'spore'
        : view === 'graph' ? 'graph'
        : 'settings';
    }
  }
  tabs.forEach(t => t.addEventListener('click', () => setView(t.dataset.mView)));
  setView('chat');

  // ── Header theme toggle ──
  document.getElementById('m-theme-btn')?.addEventListener('click', () => {
    if (typeof window.toggleTheme === 'function') window.toggleTheme();
    syncThemeIcon();
  });
  function syncThemeIcon() {
    try {
      const t = localStorage.getItem('spore-theme') || 'dark';
      const btn = document.getElementById('m-theme-btn');
      if (btn) btn.textContent = t === 'light' ? '☀' : '🌙';
    } catch {}
  }
  syncThemeIcon();
  setTimeout(syncThemeIcon, 1500);

  // ── Composer: Enter sends, Shift+Enter newline ──
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const sendBtn = document.getElementById('chat-send');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    }
  });

  // ── Auto-scroll: keep stream pinned to bottom on new content ──
  // chat.js does its own scroll, but it reads the desktop container's
  // scroll position. Now that #chat-messages lives inside #m-chat-stream
  // we need to scroll the stream container instead.
  if (chatStream && chatMessages) {
    const mo = new MutationObserver(() => {
      const nearBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80;
      if (nearBottom) chatStream.scrollTop = chatStream.scrollHeight;
    });
    mo.observe(chatMessages, { childList: true, subtree: true, characterData: true });
  }

  // ── Mobile graph view ──
  // Reads window.graphData (populated by graph.js after initApp →
  // fetchGraph → initGraph). Renders a searchable type-filtered list;
  // tapping a row opens a bottom-sheet detail with attributes + edges.
  initMobileGraph();
})();

function initMobileGraph() {
  const listEl = document.getElementById('m-g-list');
  const searchEl = document.getElementById('m-g-search');
  const filtersEl = document.getElementById('m-g-filters');
  const statsEl = document.getElementById('m-g-stats');
  if (!listEl || !searchEl || !filtersEl) return;

  // ── Glyph helpers ──
  // graph.js exposes getColor() / TYPE_VISUALS via top-level globals
  // (effects.js / core.js). We read them lazily in renderRow because
  // they may not be defined until the foundation modules complete
  // their top-level execution.
  function glyphFor(node) {
    const visuals = window.TYPE_VISUALS || {};
    return visuals[node.type]?.glyph || (node.type || '?')[0]?.toUpperCase() || '?';
  }
  function colorFor(node) {
    return (typeof window.getColor === 'function')
      ? window.getColor(node.type)
      : 'var(--text-dim)';
  }

  let activeFilter = ''; // empty = all
  let searchTerm = '';
  let renderTimer = null;

  function nodes() {
    return (window.graphData?.nodes) || [];
  }
  function edges() {
    return (window.graphData?.edges) || [];
  }

  function renderFilters() {
    const counts = new Map();
    for (const n of nodes()) {
      const t = n.type || 'unknown';
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const types = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    filtersEl.innerHTML = '';
    const all = makeChip('all', '', nodes().length);
    if (!activeFilter) all.classList.add('active');
    filtersEl.appendChild(all);
    for (const [t, c] of types) {
      const chip = makeChip(t, t, c);
      if (activeFilter === t) chip.classList.add('active');
      filtersEl.appendChild(chip);
    }
  }
  function makeChip(label, value, count) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-g-chip';
    b.dataset.filter = value;
    b.innerHTML = `<span>${escapeAttr(label)}</span><span class="m-g-chip-count">${count}</span>`;
    b.addEventListener('click', () => {
      activeFilter = (activeFilter === value) ? '' : value;
      renderFilters();
      renderList();
    });
    return b;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function nodeMatchesSearch(n, q) {
    if (!q) return true;
    const hay = ((n.label || '') + ' ' + (n.id || '') + ' ' + (n.type || '') + ' ' + (n.description || '')).toLowerCase();
    return hay.includes(q);
  }

  function renderList() {
    const q = searchTerm.toLowerCase().trim();
    const all = nodes()
      .filter(n => !activeFilter || (n.type || 'unknown') === activeFilter)
      .filter(n => nodeMatchesSearch(n, q))
      .sort((a, b) => {
        const ai = a.importance || 0;
        const bi = b.importance || 0;
        if (ai !== bi) return bi - ai;
        return String(a.label || a.id).localeCompare(String(b.label || b.id));
      });

    statsEl.textContent = all.length === nodes().length
      ? `${all.length} nodes`
      : `${all.length} of ${nodes().length} nodes`;

    if (!all.length) {
      listEl.innerHTML = `<div class="m-g-empty">${nodes().length ? 'no nodes match' : 'no nodes in this graph yet'}</div>`;
      return;
    }
    // Build all rows in a fragment for performance.
    const frag = document.createDocumentFragment();
    for (const n of all) {
      const row = document.createElement('div');
      row.className = 'm-g-row';
      row.setAttribute('role', 'listitem');
      row.dataset.nodeId = n.id;
      const color = colorFor(n);
      row.innerHTML = `
        <div class="m-g-row-glyph" style="color:${color}">${escapeAttr(glyphFor(n))}</div>
        <div class="m-g-row-body">
          <div class="m-g-row-label">${escapeAttr(n.label || n.id)}</div>
          <div class="m-g-row-type">${escapeAttr(n.type || 'unknown')}</div>
        </div>
        <div class="m-g-row-chev">›</div>
      `;
      row.addEventListener('click', () => openSheet(n.id));
      frag.appendChild(row);
    }
    listEl.replaceChildren(frag);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderFilters();
      renderList();
    }, 150);
  }

  // ── Search input ──
  searchEl.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    scheduleRender();
  });

  // ── Watch graphData for changes ──
  // graph.js mutates window.graphData when nodes/edges arrive over the
  // WS. We re-render on any DOM mutation that flips the canvas (cheap
  // proxy) plus poll for the first paint.
  let lastSize = -1;
  function pollGraphReady() {
    const size = nodes().length + edges().length;
    if (size !== lastSize) {
      lastSize = size;
      renderFilters();
      renderList();
    }
  }
  setInterval(pollGraphReady, 1500);
  pollGraphReady();

  // ── Sheet ──
  const sheetEl = document.getElementById('m-g-sheet');
  const scrimEl = document.getElementById('m-g-sheet-scrim');
  document.getElementById('m-g-sheet-close')?.addEventListener('click', closeSheet);
  scrimEl?.addEventListener('click', closeSheet);

  function openSheet(nodeId) {
    const n = nodes().find(x => x.id === nodeId);
    if (!n) return;
    document.getElementById('m-g-sheet-glyph').style.color = colorFor(n);
    document.getElementById('m-g-sheet-glyph').textContent = glyphFor(n);
    document.getElementById('m-g-sheet-label').textContent = n.label || n.id;
    document.getElementById('m-g-sheet-type').textContent = n.type || 'unknown';
    // Description
    const descEl = document.getElementById('m-g-sheet-desc');
    if (n.description) {
      descEl.innerHTML = `<div class="m-g-sheet-section-title">description</div>${escapeAttr(n.description).replace(/\n/g, '<br>')}`;
    } else {
      descEl.innerHTML = '';
    }
    // Attributes
    const attrsEl = document.getElementById('m-g-sheet-attrs');
    const attrEntries = collectAttrs(n);
    if (attrEntries.length) {
      attrsEl.innerHTML = `<div class="m-g-sheet-section-title">attributes</div>` +
        attrEntries.map(([k, v]) => `<div class="m-g-attr"><div class="m-g-attr-key">${escapeAttr(k)}</div><div class="m-g-attr-val">${escapeAttr(v)}</div></div>`).join('');
    } else {
      attrsEl.innerHTML = '';
    }
    // Edges
    const edgesEl = document.getElementById('m-g-sheet-edges');
    const incoming = edges().filter(e => (e.target?.id || e.target) === n.id);
    const outgoing = edges().filter(e => (e.source?.id || e.source) === n.id);
    const edgeRows = [
      ...outgoing.map(e => ({ dir: '→', other: e.target?.id || e.target, type: e.type })),
      ...incoming.map(e => ({ dir: '←', other: e.source?.id || e.source, type: e.type })),
    ];
    if (edgeRows.length) {
      edgesEl.innerHTML = `<div class="m-g-sheet-section-title">edges (${edgeRows.length})</div>` +
        edgeRows.map(e => {
          const target = nodes().find(x => x.id === e.other);
          const targetLabel = target ? (target.label || target.id) : e.other;
          return `<div class="m-g-edge" data-other="${escapeAttr(e.other)}"><div class="m-g-edge-arrow">${e.dir}</div><div class="m-g-edge-target">${escapeAttr(targetLabel)}</div><div class="m-g-edge-type">${escapeAttr(e.type || '')}</div></div>`;
        }).join('');
      edgesEl.querySelectorAll('.m-g-edge').forEach(row => {
        row.addEventListener('click', () => openSheet(row.dataset.other));
      });
    } else {
      edgesEl.innerHTML = '';
    }
    document.body.classList.add('m-g-sheet-open');
    sheetEl.setAttribute('aria-hidden', 'false');
  }

  function closeSheet() {
    document.body.classList.remove('m-g-sheet-open');
    sheetEl?.setAttribute('aria-hidden', 'true');
  }

  function collectAttrs(n) {
    const out = [];
    // Common informative fields
    if (n.importance != null) out.push(['importance', String(n.importance)]);
    if (n.created_at) out.push(['created', n.created_at]);
    if (n.updated_at) out.push(['updated', n.updated_at]);
    // Inline attrs (object) — common shape
    if (n.attrs && typeof n.attrs === 'object') {
      for (const [k, v] of Object.entries(n.attrs)) {
        if (v && typeof v === 'object') out.push([k, JSON.stringify(v)]);
        else out.push([k, String(v ?? '')]);
      }
    }
    // Aspects (rich attributes per name) — collapse for list view
    if (Array.isArray(n.aspects)) {
      for (const a of n.aspects) {
        if (a?.name && a?.value) out.push([a.name, String(a.value)]);
      }
    }
    return out;
  }

  // Swipe-down to close the sheet
  let touchStartY = null;
  sheetEl?.addEventListener('touchstart', (e) => {
    const offset = e.touches[0].clientY - sheetEl.getBoundingClientRect().top;
    if (offset > 60) return; // only from the handle / head area
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  sheetEl?.addEventListener('touchmove', (e) => {
    if (touchStartY == null) return;
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 0) sheetEl.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheetEl?.addEventListener('touchend', (e) => {
    if (touchStartY == null) return;
    const dy = (e.changedTouches[0].clientY - touchStartY);
    sheetEl.style.transform = '';
    if (dy > 100) closeSheet();
    touchStartY = null;
  }, { passive: true });
}
