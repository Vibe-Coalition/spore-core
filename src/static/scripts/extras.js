// extras.js — secondary inline block from graph-viewer.html (was lines
// 14264-15111 of the pre-split monolith). Loaded after app.js.

(function altViews() {
  const canvasEl = () => document.getElementById('canvas');
  let currentView = 'graph';
  let selectedListId = null;

  function _updateViewModePill() {
    const bar = document.getElementById('view-mode-bar');
    if (!bar) return;
    const pill = bar.querySelector('.vm-pill');
    const active = bar.querySelector('button.active');
    if (!pill || !active) return;
    const barRect = bar.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    pill.style.left = (btnRect.left - barRect.left) + 'px';
    pill.style.width = btnRect.width + 'px';
    pill.style.opacity = '1';
  }

  // Node-pane visibility is per-mode. ANY mode change closes the
  // currently-open node-pane (it doesn't make sense floating over a
  // different view). If it was open while we were in graph mode, we
  // remember and restore it when returning to graph. The typemap
  // drilldown also opens the node-pane on click; that close should
  // also fire when leaving typemap.
  let _savedNodePaneOpen = false;
  function setView(mode) {
    if (currentView === mode) return;
    const c = canvasEl();
    if (!c) return;
    const wasOpen = (typeof activeRpTabs !== 'undefined') && activeRpTabs.has('node-pane');
    if (wasOpen && typeof closeRightPanel === 'function') closeRightPanel('node-pane');
    // Only carry the "was open" memory across the graph ⇄ non-graph
    // boundary, so re-entering graph reopens it. Other transitions just
    // close and don't restore — the user clicking around the typemap
    // shouldn't auto-pop the panel back open on the next switch.
    if (currentView === 'graph' && mode !== 'graph') {
      _savedNodePaneOpen = wasOpen;
    } else if (mode === 'graph' && currentView !== 'graph' && _savedNodePaneOpen) {
      if (typeof openRightPanel === 'function') openRightPanel('node-pane', _usesFloatingWindows ? _usesFloatingWindows() : true);
      _savedNodePaneOpen = false;
    } else if (mode === 'graph') {
      _savedNodePaneOpen = false;
    }
    c.classList.remove('view-graph', 'view-list', 'view-typemap', 'view-work');
    c.classList.add('view-' + mode);
    // Filter on [data-vm] so the theme toggle (also in this bar) isn't
    // treated as a view button.
    document.querySelectorAll('#view-mode-bar button[data-vm]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.vm === mode);
    });
    _updateViewModePill();
    currentView = mode;
    // Defer content render so the fade-out has a frame to start
    const render = () => {
      if (mode === 'list') renderListView();
      else if (mode === 'typemap') renderTypeMap();
      else if (mode === 'work') renderWorkView();
    };
    requestAnimationFrame(() => requestAnimationFrame(render));
  }

  // [data-vm] excludes #theme-toggle, which lives in this same bar but has
  // its own click handler elsewhere — without this filter, clicking the
  // theme button would call setView(undefined) and blank the canvas.
  document.querySelectorAll('#view-mode-bar button[data-vm]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.vm));
  });

  // Initial pill position + reposition on resize/font-load
  requestAnimationFrame(_updateViewModePill);
  window.addEventListener('resize', _updateViewModePill);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(_updateViewModePill);
  // Expose so showApp can reposition after the canvas becomes visible
  // (getBoundingClientRect is useless while the canvas is still hidden behind
  // the login overlay, so the first measurement lands at the wrong spot).
  window._updateViewModePill = _updateViewModePill;

  // ── LIST VIEW ─────────────────────────────────────────────
  function renderListView() {
    const tree = document.getElementById('view-list-tree');
    if (!tree) return;
    const nodes = (graphData?.nodes) || [];
    const byType = new Map();
    for (const n of nodes) {
      const t = String(n.type || 'unknown');
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(n);
    }
    const types = [...byType.keys()].sort((a, b) => byType.get(b).length - byType.get(a).length || a.localeCompare(b));
    const search = (document.getElementById('vl-search')?.value || '').trim().toLowerCase();

    tree.innerHTML = '';
    for (const t of types) {
      const list = byType.get(t)
        .filter(n => !search || (n.label || n.id || '').toLowerCase().includes(search) || t.toLowerCase().includes(search))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.mentions || 0) - (a.mentions || 0));
      if (!list.length) continue;
      const expanded = !!search || list.length <= 6;
      const head = document.createElement('div');
      head.className = 'vlt-type' + (expanded ? ' expanded' : '');
      const colorChip = `<svg class="vlt-shape" viewBox="-10 -10 20 20"><path d="${getNodeShapePath(t, 7)}" fill="${getColor(t)}" fill-opacity="0.3" stroke="${getColor(t)}" stroke-width="1.5"/></svg>`;
      head.innerHTML = `<span class="vlt-chevron">${expanded ? '▾' : '▸'}</span>${colorChip}<span class="vlt-type-label">${esc(t)}</span><span class="vlt-type-count">${list.length}</span>`;
      head.addEventListener('click', () => {
        head.classList.toggle('expanded');
        head.querySelector('.vlt-chevron').textContent = head.classList.contains('expanded') ? '▾' : '▸';
      });
      tree.appendChild(head);
      const wrap = document.createElement('div');
      wrap.className = 'vlt-nodes';
      for (const n of list) {
        const item = document.createElement('div');
        item.className = 'vlt-node' + (n.id === selectedListId ? ' active' : '');
        item.innerHTML = `<span class="vlt-node-imp">${(n.importance || 0).toFixed ? (n.importance||0).toFixed(0) : (n.importance||0)}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(n.label || n.id)}</span>`;
        item.__nodeId = n.id;
        item.addEventListener('click', () => { selectListNode(n.id); });
        wrap.appendChild(item);
      }
      tree.appendChild(wrap);
    }

    if (selectedListId) {
      const stillThere = nodes.find(n => n.id === selectedListId);
      if (!stillThere) selectedListId = null;
    }
    if (selectedListId) renderNodeDetail(selectedListId);
  }

  function selectListNode(id) {
    selectedListId = id;
    document.querySelectorAll('.vlt-node').forEach(el => {
      el.classList.toggle('active', el.__nodeId === id);
    });
    renderNodeDetail(id);
  }

  function renderNodeDetail(id) {
    const node = (graphData?.nodes || []).find(n => n.id === id);
    const empty = document.getElementById('vld-empty');
    const card = document.getElementById('vld-card');
    if (!node) { if (empty) empty.style.display = 'flex'; if (card) card.classList.remove('active'); return; }
    if (empty) empty.style.display = 'none';
    if (!card) return;
    card.classList.add('active');

    const incoming = (graphData.edges || []).filter(e => (e.target?.id || e.target) === id);
    const outgoing = (graphData.edges || []).filter(e => (e.source?.id || e.source) === id);
    const aspects = node.aspects || [];

    let aspectsHtml = '';
    for (const asp of aspects) {
      let attrsHtml = '';
      for (const a of (asp.attributes || [])) {
        attrsHtml += `<div class="vld-attr">${esc(a.content || '')}${a.eventDate ? `<span class="vld-attr-meta">${esc(a.eventDate)}</span>` : ''}</div>`;
      }
      aspectsHtml += `<div class="vld-aspect"><div class="vld-aspect-name">${esc(asp.name)} <span style="opacity:.5">·${asp.weight || 5}</span></div>${attrsHtml || '<div class="vld-attr" style="opacity:.5">(no attributes)</div>'}</div>`;
    }

    let edgesHtml = '<div class="vld-edges-list">';
    for (const e of outgoing) {
      const tid = e.target?.id || e.target;
      const tn = (graphData.nodes || []).find(n => n.id === tid);
      edgesHtml += `<span class="vld-edge-direction">→</span><span class="vld-edge-target" data-target="${esc(tid)}">${esc(tn?.label || tid)}</span><span class="vld-edge-type">${esc(e.type)}</span>`;
    }
    for (const e of incoming) {
      const sid = e.source?.id || e.source;
      const sn = (graphData.nodes || []).find(n => n.id === sid);
      edgesHtml += `<span class="vld-edge-direction">←</span><span class="vld-edge-target" data-target="${esc(sid)}">${esc(sn?.label || sid)}</span><span class="vld-edge-type">${esc(e.type)}</span>`;
    }
    edgesHtml += '</div>';

    card.innerHTML = `
      <div class="vld-header">
        <span class="vld-title">${esc(node.label || node.id)}</span>
        <span class="vld-type-badge">${esc(node.type)}</span>
        <span style="opacity:.5;font-size:.7rem;font-family:var(--font-body)">imp ${node.importance || 0} · ${node.mentions || 0} mentions</span>
      </div>
      ${node.description ? `<div class="vld-section"><div class="vld-section-title">description</div><div class="vld-desc">${esc(node.description)}</div></div>` : ''}
      ${aspects.length ? `<div class="vld-section"><div class="vld-section-title">aspects</div>${aspectsHtml}</div>` : ''}
      ${(incoming.length + outgoing.length) ? `<div class="vld-section"><div class="vld-section-title">connections (${incoming.length + outgoing.length})</div>${edgesHtml}</div>` : ''}
      <div class="vld-section"><div class="vld-section-title">neighborhood</div><div class="vld-mini" id="vld-mini"></div></div>
    `;
    card.querySelectorAll('.vld-edge-target').forEach(el => {
      el.addEventListener('click', () => selectListNode(el.dataset.target));
    });
    drawMiniGraph(id);
  }

  function drawMiniGraph(centerId) {
    const container = document.getElementById('vld-mini');
    if (!container) return;
    const nodes = graphData?.nodes || [];
    const edges = graphData?.edges || [];
    const center = nodes.find(n => n.id === centerId);
    if (!center) return;
    const neighborIds = new Set([centerId]);
    for (const e of edges) {
      const s = e.source?.id || e.source;
      const t = e.target?.id || e.target;
      if (s === centerId) neighborIds.add(t);
      if (t === centerId) neighborIds.add(s);
    }
    const subNodes = nodes.filter(n => neighborIds.has(n.id)).map(n => ({...n, x: undefined, y: undefined, vx: 0, vy: 0}));
    const subEdges = edges.filter(e => {
      const s = e.source?.id || e.source, t = e.target?.id || e.target;
      return neighborIds.has(s) && neighborIds.has(t);
    }).map(e => ({source: e.source?.id || e.source, target: e.target?.id || e.target, type: e.type}));

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 320;
    container.innerHTML = `<svg viewBox="0 0 ${w} ${h}"></svg>`;
    const svgSel = d3.select(container).select('svg');
    const defs = svgSel.append('defs');
    defs.append('marker').attr('id', 'mini-arrow').attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5)
      .attr('orient', 'auto').append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', 'var(--text-dim)');
    const g = svgSel.append('g');
    const linkSel = g.append('g').selectAll('line').data(subEdges).join('line')
      .attr('stroke', 'var(--border)').attr('stroke-opacity', 0.7).attr('stroke-width', 1).attr('marker-end', 'url(#mini-arrow)');
    const nodeSel = g.append('g').selectAll('g').data(subNodes).join('g').attr('class', 'graph-node')
      .style('cursor', 'pointer')
      .on('click', (e, d) => { if (d.id !== centerId) selectListNode(d.id); });
    nodeSel.append('path').attr('d', d => getNodeShapePath(d.type, d.id === centerId ? 14 : 9))
      .attr('fill', d => getFillColor(d.type)).attr('fill-opacity', d => d.id === centerId ? 1 : 0.85)
      .attr('stroke', d => getColor(d.type)).attr('stroke-width', d => d.id === centerId ? 2 : 1.4);
    nodeSel.append('text').text(d => (d.label || d.id).slice(0, 14))
      .attr('font-family', 'var(--font-body)').attr('font-size', d => d.id === centerId ? 11 : 9)
      .attr('fill', 'var(--text)').attr('text-anchor', 'middle').attr('y', d => (d.id === centerId ? 28 : 22));

    const sim = d3.forceSimulation(subNodes)
      .force('link', d3.forceLink(subEdges).id(d => d.id).distance(70).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide().radius(d => d.id === centerId ? 22 : 18))
      .velocityDecay(0.55);
    sim.stop();
    for (let i = 0; i < 200 && sim.alpha() > 0.01; i++) sim.tick();
    sim.alpha(0.0009);
    linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
  }

  document.getElementById('vl-search')?.addEventListener('input', () => {
    if (currentView === 'list') renderListView();
  });

  // ── TYPE MAP VIEW ─────────────────────────────────────────
  // Search state shared across the type-map view + drilldown window.
  let _tmSearch = '';
  let _tmNodeSelRef = null; // last-rendered bubble selection (for re-highlighting)

  function tmSearchMatchSet() {
    const q = _tmSearch.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set();
    for (const n of (graphData?.nodes || [])) {
      const hay = ((n.label || '') + ' ' + (n.id || '') + ' ' + (n.description || '') + ' ' + (n.type || '')).toLowerCase();
      if (hay.includes(q)) matches.add(n.id);
    }
    return matches;
  }

  function applyTmSearchToBubbles() {
    if (!_tmNodeSelRef) return;
    const matches = tmSearchMatchSet();
    const perType = new Map();
    if (matches) {
      for (const id of matches) {
        const node = (graphData?.nodes || []).find(n => n.id === id);
        if (node) perType.set(node.type, (perType.get(node.type) || 0) + 1);
      }
    }

    _tmNodeSelRef.each(function(d) {
      const sel = d3.select(this);
      sel.select('.tm-match-badge').remove();
      if (!matches) {
        sel.classed('tm-match', false).classed('tm-no-match', false);
      } else {
        const cnt = perType.get(d.type) || 0;
        sel.classed('tm-match', cnt > 0).classed('tm-no-match', cnt === 0);
        if (cnt > 0) {
          sel.append('text').attr('class', 'tm-match-badge')
            .attr('y', -d.r - 8)
            .text(`${cnt} match${cnt === 1 ? '' : 'es'}`);
        }
      }
      // Update the inner dots: highlight matching ones
      sel.selectAll('.tm-bubble-dot').classed('tm-dot-match', false);
      if (matches) {
        const items = (graphData?.nodes || []).filter(n => (n.type || 'unknown') === d.type);
        sel.selectAll('.tm-bubble-dot').each(function(_, i) {
          const node = items[i];
          if (node && matches.has(node.id)) this.classList.add('tm-dot-match');
        });
      }
    });

    // Also re-apply inside any open drilldown window
    if (_tmwSim && _tmwNodeSel) {
      _tmwNodeSel.classed('tmw-match', d => matches ? matches.has(d.id) : false);
    }
  }

  function renderTypeMap() {
    const svgEl = document.getElementById('view-typemap-svg');
    if (!svgEl) return;
    const container = svgEl.parentElement;
    const w = container.clientWidth || 1200;
    const h = container.clientHeight || 800;
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const nodes = graphData?.nodes || [];
    const edges = graphData?.edges || [];
    const counts = new Map();
    for (const n of nodes) counts.set(n.type || 'unknown', (counts.get(n.type || 'unknown') || 0) + 1);

    // Bubble radius: log-scaled so big types don't dwarf small ones.
    // Bigger overall so packed dots inside are legible.
    const typeNodes = [...counts.entries()].map(([type, n]) => ({
      id: type, type, count: n,
      r: Math.round(22 + Math.pow(n, 0.6) * 10),
    }));

    const edgeMap = new Map();
    for (const e of edges) {
      const s = nodes.find(n => n.id === (e.source?.id || e.source));
      const t = nodes.find(n => n.id === (e.target?.id || e.target));
      if (!s || !t || s.type === t.type) continue;
      const key = s.type < t.type ? s.type + '|' + t.type : t.type + '|' + s.type;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
    const typeEdges = [...edgeMap.entries()].map(([k, wt]) => {
      const [a, b] = k.split('|');
      return { source: a, target: b, weight: wt };
    });

    const svgSel = d3.select(svgEl);
    svgSel.selectAll('*').remove();

    // Faint dot grid background only — no gradients, no glow, no specular.
    const defs = svgSel.append('defs');
    const grid = defs.append('pattern').attr('id', 'tm-dot-grid').attr('width', 28).attr('height', 28).attr('patternUnits', 'userSpaceOnUse');
    grid.append('circle').attr('cx', 14).attr('cy', 14).attr('r', 0.7).attr('fill', 'var(--graph-hair, rgba(128,128,128,.18))');

    const root = svgSel.append('g');
    root.append('rect').attr('class', 'tm-bg-rect')
      .attr('x', -10000).attr('y', -10000).attr('width', 30000).attr('height', 30000)
      .attr('fill', 'url(#tm-dot-grid)');

    const linkG = root.append('g').attr('class', 'tm-edges-layer');
    const nodeG = root.append('g').attr('class', 'tm-bubbles-layer');

    // Edges: subtle curves between bubbles
    const edgePath = (d) => {
      const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const dx = tx - sx, dy = ty - sy;
      const norm = Math.sqrt(dx * dx + dy * dy) || 1;
      const offX = -dy / norm * Math.min(28, norm * 0.12);
      const offY = dx / norm * Math.min(28, norm * 0.12);
      return `M${sx},${sy} Q${mx + offX},${my + offY} ${tx},${ty}`;
    };

    const linkSel = linkG.selectAll('path').data(typeEdges).join('path')
      .attr('class', 'tm-edge')
      .attr('stroke', 'var(--text-dim, #6a6a7a)')
      .attr('stroke-opacity', d => Math.min(0.32, 0.07 + d.weight * 0.025))
      .attr('stroke-width', d => Math.min(2.4, 0.5 + Math.log(d.weight + 1) * 0.55));

    const nodeSel = nodeG.selectAll('g').data(typeNodes, d => d.id).join('g')
      .attr('class', 'tm-bubble')
      .on('mouseenter', (e, d) => highlightType(d.id))
      .on('mouseleave', () => highlightType(null))
      .on('click', (e, d) => openTypeOverlay(d.type));

    // Family-shape filled background (soft fill from the palette).
    nodeSel.append('path').attr('class', 'tm-bubble-fill')
      .attr('d', d => getNodeShapePath(d.type, d.r))
      .attr('fill', d => getFillColor(d.type))
      .attr('fill-opacity', 0.85);

    // Family-shape outline using the family stroke color.
    nodeSel.append('path').attr('class', 'tm-bubble-circle')
      .attr('d', d => getNodeShapePath(d.type, d.r))
      .attr('stroke', d => getColor(d.type));

    // Pack the actual nodes as small dots inside the bubble — visualizes count.
    nodeSel.each(function(d) {
      const sel = d3.select(this);
      const innerR = Math.max(2, d.r - 5);
      const items = nodes.filter(n => (n.type || 'unknown') === d.type);
      if (!items.length) return;
      if (items.length === 1) {
        sel.append('circle').attr('class', 'tm-bubble-dot')
          .attr('r', Math.min(innerR * 0.55, 5))
          .attr('fill', getColor(d.type))
          .attr('fill-opacity', 0.85);
        return;
      }
      // d3.pack inside a circle of radius innerR.
      // Use sqrt(importance) for a tiny visual weight bias.
      const childData = items.map(n => ({ value: 1 + Math.sqrt(n.importance || 0) * 0.4 }));
      const packRoot = d3.hierarchy({ children: childData }).sum(c => c.value);
      d3.pack().size([innerR * 2, innerR * 2]).padding(1.2)(packRoot);
      const dotG = sel.append('g').attr('class', 'tm-dots').attr('transform', `translate(${-innerR},${-innerR})`);
      dotG.selectAll('circle').data(packRoot.leaves()).join('circle')
        .attr('class', 'tm-bubble-dot')
        .attr('cx', n => n.x).attr('cy', n => n.y)
        .attr('r', n => Math.max(1, Math.min(n.r * 0.92, 6)))
        .attr('fill', getColor(d.type))
        .attr('fill-opacity', 0.78);
    });

    // Label always BELOW
    nodeSel.append('text').attr('class', 'tm-bubble-label')
      .attr('y', d => d.r + 11)
      .text(d => d.type);

    // Count below the label
    nodeSel.append('text').attr('class', 'tm-bubble-count')
      .attr('y', d => d.r + 25)
      .text(d => d.count + ' nodes');

    _tmNodeSelRef = nodeSel;
    applyTmSearchToBubbles();

    const sim = d3.forceSimulation(typeNodes)
      .force('link', d3.forceLink(typeEdges).id(d => d.id).distance(d => 130 + 30 / Math.log(d.weight + 2)).strength(0.12))
      .force('charge', d3.forceManyBody().strength(d => -300 - d.r * 5).distanceMax(800))
      .force('center', d3.forceCenter(w / 2, h / 2))
      // Extra collision radius leaves room for labels + count text below each bubble.
      .force('collision', d3.forceCollide().radius(d => d.r + 32).iterations(3))
      .velocityDecay(0.62);
    sim.stop();
    for (let i = 0; i < 400 && sim.alpha() > 0.005; i++) sim.tick();
    sim.alpha(0.0009);

    linkSel.attr('d', edgePath);
    nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);

    // Hover highlight: dim non-related bubbles + edges
    function highlightType(typeId) {
      if (!typeId) {
        nodeSel.classed('tm-dimmed', false);
        linkSel.classed('tm-edge-hi', false).classed('tm-edge-dim', false);
        return;
      }
      const related = new Set([typeId]);
      for (const e of typeEdges) {
        const sId = e.source.id || e.source;
        const tId = e.target.id || e.target;
        if (sId === typeId) related.add(tId);
        if (tId === typeId) related.add(sId);
      }
      nodeSel.classed('tm-dimmed', d => !related.has(d.id));
      linkSel.classed('tm-edge-hi', d => (d.source.id || d.source) === typeId || (d.target.id || d.target) === typeId);
      linkSel.classed('tm-edge-dim', d => (d.source.id || d.source) !== typeId && (d.target.id || d.target) !== typeId);
    }

    const zoom = d3.zoom().scaleExtent([0.3, 4]).on('zoom', (e) => {
      root.attr('transform', e.transform);
    });
    svgSel.call(zoom);
  }

  // CSS-safe id (replace non-alphanum with _)
  function cssEsc(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

  // Type subgraph window — proper floating pane with full interactive graph inside.
  let _tmwSim = null;
  let _tmwInited = false;
  let _tmwSelectedId = null;
  let _tmwNodeSel = null; // exposed so search can re-highlight on input change

  function openTypeOverlay(type) {
    const winEl = document.getElementById('tm-window');
    const titleEl = document.getElementById('tm-window-title');
    const countEl = document.getElementById('tm-window-count');
    const svgEl = document.getElementById('tm-window-svg');
    const emptyEl = document.getElementById('tm-window-empty');
    if (!winEl || !svgEl) return;

    // Open the window with a generous default size. _initFloatingWindow
    // applies any saved rect from localStorage; if none exists we set a
    // good default. If a saved rect is too small (legacy bug), reset it.
    winEl.classList.add('tm-window-open');
    if (!_tmwInited) {
      // Drop any prior saved rect for this window — earlier code persisted a
      // 360x320 default that's too small for a graph view.
      try {
        const raw = localStorage.getItem('_floatingWindow:tm-window');
        if (raw) {
          const r = JSON.parse(raw);
          if (!r || r.width < 500 || r.height < 360) localStorage.removeItem('_floatingWindow:tm-window');
        }
      } catch {}
      const vw = window.innerWidth, vh = window.innerHeight;
      const dw = Math.min(960, Math.max(640, vw * 0.7));
      const dh = Math.min(720, Math.max(480, vh * 0.7));
      winEl.style.width = dw + 'px';
      winEl.style.height = dh + 'px';
      winEl.style.left = Math.max(24, Math.round((vw - dw) / 2)) + 'px';
      winEl.style.top = Math.max(48, Math.round((vh - dh) / 2)) + 'px';
      if (typeof _initFloatingWindow === 'function') {
        _initFloatingWindow('tm-window', '.floating-pane-head');
      }
      // _initFloatingWindow may have re-applied a saved rect; if the resulting
      // size is still tiny, force ours back.
      const r = winEl.getBoundingClientRect();
      if (r.width < 500 || r.height < 360) {
        winEl.style.width = dw + 'px';
        winEl.style.height = dh + 'px';
        winEl.style.left = Math.max(24, Math.round((vw - dw) / 2)) + 'px';
        winEl.style.top = Math.max(48, Math.round((vh - dh) / 2)) + 'px';
      }
      _tmwInited = true;
    }
    if (typeof _focusFloatingWindow === 'function') _focusFloatingWindow('tm-window');

    const nodes = (graphData?.nodes || []).filter(n => (n.type || 'unknown') === type);
    titleEl.textContent = type;
    countEl.textContent = nodes.length + ' nodes';
    if (!nodes.length) { emptyEl.style.display = 'flex'; svgEl.style.display = 'none'; return; }
    emptyEl.style.display = 'none'; svgEl.style.display = 'block';

    renderTypeSubgraph(svgEl, nodes, type);
  }

  function renderTypeSubgraph(svgEl, nodesIn, type) {
    if (_tmwSim) { _tmwSim.stop(); _tmwSim = null; }
    _tmwSelectedId = null;

    const container = svgEl.parentElement;
    const w = Math.max(300, container.clientWidth || 800);
    const h = Math.max(240, container.clientHeight || 600);
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const ids = new Set(nodesIn.map(n => n.id));
    const subNodes = nodesIn.map(n => ({
      ...n, x: undefined, y: undefined, vx: 0, vy: 0,
      radius: 6 + Math.min(n.importance || 5, 10),
    }));
    const subEdges = (graphData?.edges || []).filter(e => {
      const s = e.source?.id || e.source, t = e.target?.id || e.target;
      return ids.has(s) && ids.has(t);
    }).map(e => ({source: e.source?.id || e.source, target: e.target?.id || e.target, type: e.type}));

    // Pre-seed in a phyllotaxis spread so layout starts well
    const cx = w / 2, cy = h / 2;
    subNodes.forEach((n, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const r = 14 * Math.sqrt(i + 1);
      n.x = cx + Math.cos(angle) * r;
      n.y = cy + Math.sin(angle) * r;
    });

    const svgSel = d3.select(svgEl);
    svgSel.selectAll('*').remove();
    const defs = svgSel.append('defs');
    defs.append('marker').attr('id', 'tmw-arr').attr('viewBox', '0 -5 10 10')
      .attr('refX', 10).attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5)
      .attr('orient', 'auto').append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', 'var(--text-dim)');

    const root = svgSel.append('g');
    const gLinks = root.append('g').attr('class', 'tmw-links');
    const gNodes = root.append('g').attr('class', 'tmw-nodes');

    const linkSel = gLinks.selectAll('line').data(subEdges).join('line')
      .attr('class', 'tmw-edge').attr('marker-end', 'url(#tmw-arr)')
      .attr('stroke', 'var(--border)').attr('stroke-opacity', 0.7);

    const nodeSel = gNodes.selectAll('g').data(subNodes, d => d.id).join('g')
      .attr('class', 'tmw-node')
      .on('click', (e, d) => {
        e.stopPropagation();
        _tmwSelectedId = d.id;
        nodeSel.classed('tmw-selected', n => n.id === d.id);
        // Highlight edges touching this node
        linkSel.classed('tmw-edge-hi', l => (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id);
        // Open the existing right-side node panel for full details/editing
        if (typeof selectNode === 'function') selectNode(d);
      })
      .on('mouseenter', (e, d) => {
        linkSel.each(function(l) {
          const hit = (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id;
          if (hit) this.classList.add('tmw-edge-hi');
        });
      })
      .on('mouseleave', (e, d) => {
        if (_tmwSelectedId === d.id) return;
        linkSel.each(function(l) {
          const stillHi = _tmwSelectedId && ((l.source.id || l.source) === _tmwSelectedId || (l.target.id || l.target) === _tmwSelectedId);
          if (!stillHi) this.classList.remove('tmw-edge-hi');
        });
      });

    nodeSel.append('path').attr('class', 'tmw-shape')
      .attr('d', d => getNodeShapePath(d.type, d.radius))
      .attr('fill', d => getFillColor(d.type)).attr('fill-opacity', 1)
      .attr('stroke', d => getColor(d.type)).attr('stroke-width', 1.6)
      .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
    nodeSel.append('text').attr('class', 'tmw-glyph')
      .attr('fill', d => getColor(d.type))
      .text(d => getNodeGlyph(d.type));
    nodeSel.append('text').attr('class', 'tmw-label')
      .attr('y', d => d.radius + 6)
      .text(d => {
        const txt = String(d.label || d.id);
        return txt.length > 22 ? txt.slice(0, 20) + '…' : txt;
      });

    // Apply current search highlight to matching nodes
    const tmMatches = tmSearchMatchSet();
    if (tmMatches) nodeSel.classed('tmw-match', d => tmMatches.has(d.id));
    _tmwNodeSel = nodeSel;

    const sim = d3.forceSimulation(subNodes)
      .force('link', d3.forceLink(subEdges).id(d => d.id).distance(85).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-160).distanceMax(280))
      .force('center', d3.forceCenter(cx, cy).strength(0.06))
      .force('collision', d3.forceCollide().radius(d => (d.radius || 12) + 24).iterations(2))
      .velocityDecay(0.55);

    function tickRender() {
      linkSel.each(function(d) {
        if (!d.source || !d.target) return;
        const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;
        const tr = (d.target.radius || 12) + 2;
        this.setAttribute('x1', d.source.x);
        this.setAttribute('y1', d.source.y);
        this.setAttribute('x2', d.target.x - dx * tr / dist);
        this.setAttribute('y2', d.target.y - dy * tr / dist);
      });
      nodeSel.each(function(d) { this.setAttribute('transform', `translate(${d.x},${d.y})`); });
    }
    sim.on('tick', tickRender);

    // Pre-bake offscreen so user sees a settled layout
    sim.stop();
    for (let i = 0; i < 350 && sim.alpha() > 0.004; i++) sim.tick();
    tickRender();
    sim.alpha(0.0009);
    _tmwSim = sim;

    // Drag nodes
    const drag = d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.18).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
    nodeSel.call(drag);

    // Pan + zoom
    const zoom = d3.zoom().scaleExtent([0.2, 6]).on('zoom', e => root.attr('transform', e.transform));
    svgSel.call(zoom);
    // Click on empty area: clear selection
    svgSel.on('click', () => {
      _tmwSelectedId = null;
      nodeSel.classed('tmw-selected', false);
      linkSel.classed('tmw-edge-hi', false);
    });
  }

  // Wire up close button (since data-window-action="close" calls closeRightPanel
  // which doesn't know about this window — handle close ourselves).
  document.getElementById('tm-window-close-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const winEl = document.getElementById('tm-window');
    if (!winEl) return;
    winEl.classList.remove('tm-window-open');
    winEl.classList.remove('window-maximized');
    if (_tmwSim) { _tmwSim.stop(); _tmwSim = null; }
    _tmwNodeSel = null;
  });

  // Type-map search wiring
  const tmSearchInput = document.getElementById('tm-search');
  if (tmSearchInput) {
    tmSearchInput.addEventListener('input', (e) => {
      _tmSearch = e.target.value || '';
      applyTmSearchToBubbles();
    });
  }
  const tmSearchClear = document.getElementById('view-typemap-search-clear');
  if (tmSearchClear) {
    tmSearchClear.addEventListener('click', () => {
      _tmSearch = '';
      if (tmSearchInput) tmSearchInput.value = '';
      applyTmSearchToBubbles();
      tmSearchInput?.focus();
    });
  }


  // ── PEOPLE & PROJECTS VIEW (card dashboard) ───────────────────────
  function renderWorkView() {
    const data = (typeof graphData !== 'undefined' && graphData) ? graphData : { nodes: [], edges: [] };
    const allPeople = data.nodes.filter(n => n.type === 'person');
    const projects  = data.nodes.filter(n => n.type === 'project').sort((a,b) => (b.importance||0) - (a.importance||0) || String(a.id).localeCompare(b.id));

    // Build edge index once for fast per-card rendering
    const outs = new Map(), ins = new Map();
    for (const e of (data.edges || [])) {
      const s = e.source?.id || e.source;
      const t = e.target?.id || e.target;
      if (!outs.has(s)) outs.set(s, []);
      outs.get(s).push({ peerId: t, edgeType: e.type });
      if (!ins.has(t)) ins.set(t, []);
      ins.get(t).push({ peerId: s, edgeType: e.type });
    }

    const projectsById = new Map(projects.map(n => [n.id, n]));
    // Only show people who have at least one project-type relation
    const people = allPeople.filter(p => {
      for (const r of (outs.get(p.id) || [])) if (projectsById.has(r.peerId)) return true;
      for (const r of (ins.get(p.id)  || [])) if (projectsById.has(r.peerId)) return true;
      return false;
    }).sort((a,b) => (b.importance||0) - (a.importance||0) || String(a.id).localeCompare(b.id));
    const peopleById = new Map(people.map(n => [n.id, n]));

    const peopleGrid = document.getElementById('vw-people-grid');
    const projGrid   = document.getElementById('vw-projects-grid');
    if (peopleGrid) peopleGrid.innerHTML = people.length
      ? people.map(n => _vwRenderCard(n, outs, ins, projectsById, 'project')).join('')
      : '<div class="vw-empty">no people yet</div>';
    if (projGrid) projGrid.innerHTML = projects.length
      ? projects.map(n => _vwRenderCard(n, outs, ins, peopleById, 'person')).join('')
      : '<div class="vw-empty">no projects yet</div>';

    const pc = document.getElementById('vw-people-count');
    const xc = document.getElementById('vw-projects-count');
    const cc = document.getElementById('vw-count');
    if (pc) pc.textContent = String(people.length);
    if (xc) xc.textContent = String(projects.length);
    if (cc) cc.textContent = `${people.length} people · ${projects.length} projects`;

    // Wire interactions
    document.querySelectorAll('#view-work .vw-rel-chip').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _vwScrollToCard(el.dataset.id);
      });
    });
    document.querySelectorAll('#view-work .vw-title').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setView('list');
        if (typeof selectListNode === 'function') selectListNode(el.dataset.id);
      });
    });
    // Re-apply any current search filter
    if (_vwSearch) _vwApplyFilter();
  }

  function _vwRenderCard(node, outs, ins, peerMap, peerLabel) {
    const color = getColor(node.type);
    const shape = `<svg class="vw-shape" width="16" height="16" viewBox="-9 -9 18 18"><path d="${getNodeShapePath(node.type, 8)}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.5"/></svg>`;
    const imp = Number(node.importance || 0);
    const desc = node.description ? `<div class="vw-desc">${esc(node.description)}</div>` : '';

    // Top 3 aspects by weight, each with up to 3 attributes
    const aspects = (node.aspects || [])
      .slice()
      .sort((a,b) => (b.weight||0) - (a.weight||0))
      .slice(0, 3);
    let aspectsHtml = '';
    if (aspects.length) {
      aspectsHtml = '<div class="vw-aspects">' + aspects.map(a => {
        const attrs = (a.attributes || []).slice(0, 3);
        const attrLines = attrs.map(at => `<div class="vw-attr">${esc((at.content || '').trim())}</div>`).join('');
        return `<div class="vw-aspect"><span class="vw-aspect-name">${esc(a.name)}</span>${attrLines}</div>`;
      }).join('') + '</div>';
    }

    // Relations to peer type, grouped by edge type
    const relMap = new Map(); // edgeType -> Set(peerId)
    const addRel = (edgeType, peerId) => {
      if (!peerMap.has(peerId)) return;
      if (!relMap.has(edgeType)) relMap.set(edgeType, new Set());
      relMap.get(edgeType).add(peerId);
    };
    for (const r of (outs.get(node.id) || [])) addRel(r.edgeType, r.peerId);
    for (const r of (ins.get(node.id) || []))  addRel(r.edgeType, r.peerId);

    let relsHtml = '';
    if (relMap.size) {
      // Sort edge types by count desc, cap at 5 groups
      const typeEntries = [...relMap.entries()]
        .sort((a,b) => b[1].size - a[1].size)
        .slice(0, 5);
      relsHtml = '<div class="vw-rels">' + typeEntries.map(([et, idSet]) => {
        const chips = [...idSet].slice(0, 8).map(id => {
          const peer = peerMap.get(id);
          return `<span class="vw-rel-chip" data-id="${esc(id)}" title="${esc(peer.label || id)}">${esc(peer.label || id)}</span>`;
        }).join('');
        const overflow = idSet.size > 8 ? `<span class="vw-rel-chip" style="background:transparent;cursor:default;border-color:var(--border)" title="+${idSet.size - 8} more">+${idSet.size - 8}</span>` : '';
        return `<div class="vw-rel-row"><span class="vw-rel-label">${esc(et)}</span>${chips}${overflow}</div>`;
      }).join('') + '</div>';
    }

    // Build a search haystack so filter is instant and complete
    const haystackParts = [node.id, node.label, node.description || '', node.type];
    for (const a of (node.aspects || [])) {
      haystackParts.push(a.name || '');
      for (const at of (a.attributes || [])) haystackParts.push(at.content || '');
    }
    const haystack = haystackParts.join(' ').toLowerCase();

    return `<div class="vw-card" data-id="${esc(node.id)}" data-search="${esc(haystack)}">
      <div class="vw-card-head">${shape}<span class="vw-title" data-id="${esc(node.id)}" title="${esc(node.label || node.id)}">${esc(node.label || node.id)}</span><span class="vw-imp" title="importance">${imp}</span></div>
      ${desc}
      ${aspectsHtml}
      ${relsHtml}
    </div>`;
  }

  function _vwScrollToCard(id) {
    const card = document.querySelector(`#view-work .vw-card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('vw-flash');
    void card.offsetWidth; // restart animation
    card.classList.add('vw-flash');
    setTimeout(() => card.classList.remove('vw-flash'), 900);
  }

  let _vwSearch = '';
  function _vwApplyFilter() {
    const q = _vwSearch.trim().toLowerCase();
    document.querySelectorAll('#view-work .vw-card').forEach(card => {
      const hay = card.dataset.search || '';
      card.style.display = (!q || hay.includes(q)) ? '' : 'none';
    });
  }
  document.getElementById('vw-search')?.addEventListener('input', (e) => {
    _vwSearch = e.target.value || '';
    _vwApplyFilter();
  });

  // Re-render when graph data changes (poll-ish — could hook into graphEvents if exposed)
  window._refreshAltViews = function() {
    if (currentView === 'list') renderListView();
    else if (currentView === 'typemap') renderTypeMap();
    else if (currentView === 'work') renderWorkView();
  };
})();
