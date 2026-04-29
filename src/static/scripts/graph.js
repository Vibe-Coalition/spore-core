// graph.js — Real-time graph events, drop menu, performance helpers, viz, node selection,
// editor panel rendering, CRUD, delegated handlers, top-level controls.
// Extracted from src/static/scripts/app.js (was lines 5915-7617 of the post-Phase-2 monolith).

// ── Real-time Graph Events ──
// (The legacy fade-out feed was replaced by #event-log — see addEventToFeed
// below. recentEvents / MAX_FEED_ITEMS are no longer used.)

function handleGraphEvent(evt) {
  addEventToFeed(evt);

  // Reflect background-system activity on the self-node.
  const op = String(evt?.op || '');
  if (op === 'learner:start') _sporeActivityStart('learner');
  else if (op === 'learner:done') _sporeActivityEnd('learner');
  else if (op === 'session:summarize-start') _sporeActivityStart('session-summarize');
  else if (op === 'session:summarize-done') _sporeActivityEnd('session-summarize');
  else if (op === 'session:distill-start') _sporeActivityStart('session-distill');
  else if (op === 'session:distill-done') _sporeActivityEnd('session-distill');
  else if (op === 'tool:call') _sporeActivityPulse('tool', 1500);

  if (evt.op === 'node:create') {
    queueGraphRefresh();
    if (evt.node?.id) pendingAnimations.newNodes.add(evt.node.id);
  } else if (evt.op === 'node:update' || evt.op === 'attribute:create' || evt.op === 'aspect:create' || evt.op === 'reflection:upsert') {
    const nid = evt.nodeId || evt.node?.id;
    if (nid) pendingAnimations.pulseNodes.add(nid);
    queueGraphRefresh();
  } else if (evt.op === 'edge:create') {
    queueGraphRefresh();
    if (evt.edge) pendingAnimations.newEdges.push(evt.edge);
  } else if (evt.op === 'node:delete') {
    const nid = evt.nodeId;
    if (nid && gNodes) {
      gNodes.selectAll('g').filter(d => d.id === nid).classed('node-deleting', true);
      if (gLinks) {
        gLinks.selectAll('line').filter(d => d.source.id === nid || d.target.id === nid).classed('edge-deleting', true);
      }
    }
    setTimeout(() => queueGraphRefresh(), 1300);
  } else if (evt.op === 'edge:delete') {
    if (evt.edge && gLinks) {
      gLinks.selectAll('line')
        .filter(d => d.source.id === evt.edge.source && d.target.id === evt.edge.target && d.type === evt.edge.type)
        .classed('edge-deleting', true);
    }
    setTimeout(() => queueGraphRefresh(), 1100);
  } else if (evt.op === 'node:accessed') {
    const ids = evt.nodeIds || [];
    if (ids.length && gNodes) {
      gNodes.selectAll('g').each(function(d) {
        if (ids.includes(d.id)) {
          const el = d3.select(this);
          el.classed('node-accessed', false);
          void this.offsetWidth;
          el.classed('node-accessed', true);
        }
      });
      setTimeout(() => {
        gNodes.selectAll('g').classed('node-accessed', false);
      }, 1300);
    }
  }
}

const pendingAnimations = { newNodes: new Set(), pulseNodes: new Set(), newEdges: [] };
let refreshTimer = null;
let simLinks = [];

function queueGraphRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      const data = await fetchGraph();
      const anims = { newNodes: new Set(pendingAnimations.newNodes), pulseNodes: new Set(pendingAnimations.pulseNodes), newEdges: [...pendingAnimations.newEdges] };
      pendingAnimations.newNodes.clear();
      pendingAnimations.pulseNodes.clear();
      pendingAnimations.newEdges.length = 0;

      if (!simulation) { initGraph(data); return; }
      mergeGraph(data, anims);
    } catch (e) { console.error('Graph refresh failed:', e); }
  }, 800);
}

// Scales node radius by how much information lives on the node: each aspect
// contributes a base unit, each attribute a fraction. A small importance bump
// keeps high-importance seed nodes visible even when sparse, and a log-shape
// scaling keeps 40-attribute giants from swallowing the graph.
function _computeNodeRadius(n) {
  const aspects = Array.isArray(n?.aspects) ? n.aspects : [];
  const aspectCount = aspects.length;
  let attrCount = 0;
  for (const a of aspects) attrCount += Array.isArray(a.attributes) ? a.attributes.length : 0;
  const info = aspectCount * 2 + attrCount * 0.6;
  const infoRadius = Math.sqrt(info) * 2.4;   // 0 attrs → 0, 1a/1at → ~3.9, 5a/20at → ~10.9, 10a/50at → ~14.6
  const impBonus = Math.max(0, Math.min((Number(n?.importance) || 5) - 5, 5)); // 0..5
  const base = Math.max(6, Math.min(6 + infoRadius + impBonus, 24));
  // The self-node carries the F01 mark — flower-as-graph-node — and is
  // the visual anchor of the graph. Always render it noticeably larger
  // than ordinary nodes regardless of how many aspects/attributes it
  // happens to have.
  if (n?.type === 'self') return Math.max(36, base * 1.8);
  return base;
}

function mergeGraph(newData, anims) {
  const oldIds = new Set(graphData.nodes.map(n => n.id));
  const newIds = new Set(newData.nodes.map(n => n.id));
  const newNodeMap = {};
  newData.nodes.forEach(n => { newNodeMap[n.id] = n; });

  // Preserve positions from existing nodes
  const posMap = {};
  graphData.nodes.forEach(n => { posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy }; });

  // Update existing nodes in place (preserve d3 references)
  for (const n of graphData.nodes) {
    if (newNodeMap[n.id]) {
      const fresh = newNodeMap[n.id];
      n.label = fresh.label; n.type = fresh.type; n.description = fresh.description;
      n.importance = fresh.importance; n.aspects = fresh.aspects; n.aliases = fresh.aliases;
      n.extra = fresh.extra;
      n.radius = _computeNodeRadius(n);
    }
  }

  // Add new nodes
  const addedNodes = newData.nodes.filter(n => !oldIds.has(n.id));
  const canvasEl = document.getElementById('canvas');
  const seedNodeById = {};
  graphData.nodes.forEach((node) => { seedNodeById[node.id] = node; });
  let seedIndex = graphData.nodes.length;
  for (const n of addedNodes) {
    n.radius = _computeNodeRadius(n);
    if (posMap[n.id]?.x != null && posMap[n.id]?.y != null) {
      n.x = posMap[n.id].x;
      n.y = posMap[n.id].y;
    } else {
      const seed = _neighborSeedPosition(
        n.id,
        newData.edges,
        seedNodeById,
        canvasEl.clientWidth,
        canvasEl.clientHeight,
        seedIndex,
      );
      n.x = seed.x;
      n.y = seed.y;
    }
    graphData.nodes.push(n);
    seedNodeById[n.id] = n;
    seedIndex += 1;
  }

  // Remove deleted nodes
  const removedIds = [...oldIds].filter(id => !newIds.has(id));
  if (removedIds.length) {
    const removeSet = new Set(removedIds);
    graphData.nodes = graphData.nodes.filter(n => !removeSet.has(n.id));
    if (hoveredNodeId && removeSet.has(hoveredNodeId)) hoveredNodeId = null;
  }

  // Rebuild edges (use fresh data but resolve to existing node objects)
  const nodeById = {};
  graphData.nodes.forEach(n => { nodeById[n.id] = n; });
  const newLinks = newData.edges
    .filter(e => nodeById[e.source] && nodeById[e.target])
    .map(e => ({ source: nodeById[e.source], target: nodeById[e.target], type: e.type, weight: e.weight }));

  graphData.edges = newData.edges;
  simLinks = newLinks;

  // Re-tune forces for current graph size
  const nodeCount = graphData.nodes.length;
  const profile = _graphForceProfile(nodeCount);
  const forceCanvasEl = document.getElementById('canvas');
  const forceWidth = forceCanvasEl?.clientWidth || window.innerWidth;
  const forceHeight = forceCanvasEl?.clientHeight || window.innerHeight;
  simulation.force('charge').strength(profile.chargeStrength).theta(profile.chargeTheta).distanceMax(profile.chargeMaxDist);
  // parent_of edges (created by drop-on-node "Move under as child") are
  // "sticky" — short distance + high strength so the child visually clings to
  // the parent. Everything else uses the profile defaults.
  simulation.force('link')
    .distance(l => l.type === 'parent_of' ? 28 : profile.linkDistance)
    .strength(l => l.type === 'parent_of' ? 0.95 : profile.linkStrength);
  // Label-box collision force; reinitialize is implicit when nodes change.
  // Rebuild per-node anchor accessors with current type distribution.
  const _typeAnchors2 = _typeClusterAnchors(graphData.nodes, forceWidth, forceHeight);
  simulation.force('clusterX').x(n => (_typeAnchors2.get(String(n.type || 'unknown'))?.x ?? forceWidth / 2)).strength(profile.clusterStrength);
  simulation.force('clusterY').y(n => (_typeAnchors2.get(String(n.type || 'unknown'))?.y ?? forceHeight / 2)).strength(profile.clusterStrength);
  simulation.velocityDecay(profile.velocityDecay);

  const structuralChange = addedNodes.length > 0 || removedIds.length > 0;
  simulation.nodes(graphData.nodes);
  simulation.force('link').links(simLinks);
  if (structuralChange) {
    simulation.alpha(profile.refreshAlpha).restart();
  } else {
    _scheduleTickRender();
  }

  // Re-bindD3 selections
  const link = gLinks.selectAll('line').data(simLinks, d => `${d.source.id}-${d.target.id}-${d.type}`);
  link.exit().remove();
  const linkEnter = link.enter().append('line')
    .attr('marker-end', 'url(#arrowhead)');
  if (anims) {
    linkEnter.each(function(d) {
      const isNew = anims.newEdges.some(e => e.source === d.source.id && e.target === d.target.id);
      if (isNew) d3.select(this).classed('edge-new', true);
    });
  }
  const allLinks = linkEnter.merge(link);

  const nodeG = gNodes.selectAll('g').data(graphData.nodes, d => d.id);
  nodeG.exit().remove();
  const nodeEnter = nodeG.enter().append('g')
    .call(_nodeDragBehavior())
    .on('click', (e, d) => {
      e.stopPropagation();
      if (_suppressNextGraphClick) {
        _suppressNextGraphClick = false;
        return;
      }
      hideGraphContextMenu();
      selectNode(d);
    })
    .on('mouseenter', (_, d) => _setHoveredNode(d.id))
    .on('mouseleave', (_, d) => {
      if (hoveredNodeId === d.id) _setHoveredNode(null);
    });

  if (anims) {
    nodeEnter.each(function(d) {
      if (anims.newNodes.has(d.id)) d3.select(this).classed('node-new', true);
    });
    nodeG.each(function(d) {
      if (anims.pulseNodes.has(d.id)) d3.select(this).classed('node-pulse', true);
    });
  }

  const allNodes = nodeEnter.merge(nodeG).classed('graph-node', true);
  _upsertNodeVisuals(allNodes);

  simulation.on('tick', _scheduleTickRender);

  // Apply semantic zoom to newly added nodes
  _applySemanticZoom(_currentZoomScale);

  // Update stats
  updateStats();

  if (anims) {
    setTimeout(() => {
      allNodes.classed('node-new', false).classed('node-pulse', false).classed('node-accessed', false);
      allLinks.classed('edge-new', false);
    }, 1400);
  }

  _restoreGraphSelection();
}

function updateStats() {
  const typeCounts = {};
  graphData.nodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });
  const legendItems = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const color = TYPE_COLORS[type] || DEFAULT_COLOR;
      return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px">` +
        _legendNodeChip(type, color) +
        `<span>${type}</span><span style="opacity:0.5">${count}</span></span>`;
    }).join('');
  const typeCount = Object.keys(typeCounts).length;
  const statsEl = document.getElementById('stats');
  statsEl.innerHTML =
    `<div class="stats-line" id="stats-toggle" title="Toggle type breakdown">` +
      `<span class="stats-chevron">▸</span>` +
      `<span>${graphData.nodes.length} nodes · ${graphData.edges.length} edges · ${typeCount} types</span>` +
    `</div>` +
    `<div id="stats-legend">${legendItems}</div>`;
  document.getElementById('stats-toggle').addEventListener('click', () => {
    statsEl.classList.toggle('stats-open');
  });
}

// Localized resettlement after a drop — run the simulation briefly, but pin
// every node outside `radius` of (cx, cy) so only the neighbours adjust.
// Far-away clusters stay frozen; no global pulsating.
//
// Timeline:
//   0   → active phase at targetAlpha (local motion has energy)
//   40% → alphaTarget(0); sim decays naturally → smooth slowdown
//   100%→ stop() + unpin far nodes → everything goes still, no global winch
function _localResettle(cx, cy, radius = 220, duration = 1400, targetAlpha = 0.09) {
  if (!simulation || !graphData?.nodes) return;
  const r2 = radius * radius;
  const tempPinned = [];
  for (const n of graphData.nodes) {
    if (n.fx != null || n.fy != null) continue;
    const dx = (n.x ?? 0) - cx;
    const dy = (n.y ?? 0) - cy;
    if (dx * dx + dy * dy > r2) {
      n.fx = n.x;
      n.fy = n.y;
      tempPinned.push(n);
    }
  }
  if (_dragRestartTimer) { clearTimeout(_dragRestartTimer); _dragRestartTimer = null; }
  if (_dragDecayTimer) { clearTimeout(_dragDecayTimer); _dragDecayTimer = null; }
  simulation.alphaTarget(targetAlpha).restart();
  // Let the sim decay smoothly from ~40% through the window — creates a
  // gentle wind-down instead of a sudden stop.
  _dragDecayTimer = setTimeout(() => {
    if (simulation) simulation.alphaTarget(0);
    _dragDecayTimer = null;
  }, Math.round(duration * 0.4));
  // Hard stop + unpin at the end. Far nodes stay frozen through the decay
  // tail, so even the tiny residual alpha can't yank them.
  _dragRestartTimer = setTimeout(() => {
    if (simulation) simulation.stop();
    for (const n of tempPinned) { n.fx = null; n.fy = null; }
    _scheduleTickRender();
    _dragRestartTimer = null;
  }, duration);
}

function _nodeDragBehavior() {
  return d3.drag()
    .filter(e => e.button === 0 && !_isMarqueeGesture(e))
    .on('start', _dragStart)
    .on('drag', _dragging)
    .on('end', _dragEnd);
}

// Drag state — used by the hit-test + drop-menu logic below.
let _dragSourceId = null;
let _dragTargetId = null;
let _dragIsLifted = false;
let _dragRestartTimer = null;
let _dragDecayTimer = null;
let _dragMoved = false;   // set true on first real drag motion; clicks stay false

function _dragStart(e, d) {
  if (!simulation) return;
  // Don't stop the sim yet and don't mark as lifted — a pure click also fires
  // start+end with no drag motion in between. If we freeze the sim or add the
  // pointer-events:none class here, we'd swallow the click (mouseup never
  // lands on the node → no click event → node menu never opens).
  _dragSourceId = d?.id || null;
  _dragTargetId = null;
  _dragMoved = false;
  _dragIsLifted = false;
}
function _dragging(e, d) {
  // First-motion transition: promote this gesture from "maybe a click" to a
  // real drag. Freeze the sim, pin the node, add the lifted visuals.
  if (!_dragIsLifted) {
    simulation.stop();
    _dragIsLifted = true;
    _dragMoved = true;
    d.fx = d.x;
    d.fy = d.y;
    try {
      document.querySelectorAll('.node-dragging').forEach(n => n.classList.remove('node-dragging'));
      const host = _nodeDomFromId(_dragSourceId);
      if (host) host.classList.add('node-dragging');
    } catch {}
  }
  // Sim is stopped, so no tick copies fx→x. _renderTick reads d.x/d.y for the
  // node transform, so we must write both — otherwise the node doesn't move
  // visibly during drag.
  d.fx = e.x;
  d.fy = e.y;
  d.x = e.x;
  d.y = e.y;
  _scheduleTickRender();
  // Hit-test: which node (if any) is under the cursor right now?
  // Walk ALL elements at the point (elementsFromPoint) and pick the first
  // graph-node that isn't the one being dragged. pointer-events:none on the
  // dragged node (CSS) usually means it isn't in the stack at all, but this
  // is belt-and-suspenders for older behaviour / stacking quirks.
  try {
    const clientX = e.sourceEvent?.clientX;
    const clientY = e.sourceEvent?.clientY;
    if (clientX == null || clientY == null) return;
    const stack = (typeof document.elementsFromPoint === 'function')
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)];
    let targetId = null;
    for (const el of stack) {
      const hitId = _nodeIdFromDomElement(el);
      if (hitId && hitId !== _dragSourceId) { targetId = hitId; break; }
    }
    if (targetId !== _dragTargetId) _setDragTargetId(targetId);
    // Update the dashed connector line from source → target (or source → cursor)
    _updateDragConnector(d, targetId, e);
  } catch {}
}
function _dragEnd(e, d) {
  if (!simulation) return;
  const hadTarget = !!_dragTargetId;
  const targetId = _dragTargetId;
  const sourceId = _dragSourceId;
  const moved = _dragMoved;
  // Clear drag visuals regardless of outcome.
  try { document.querySelectorAll('.node-dragging').forEach(n => n.classList.remove('node-dragging')); } catch {}
  _setDragTargetId(null);
  _hideDragConnector();

  // Pure click (no motion): don't touch the simulation. The d3 click handler
  // on the node group will fire next and open the node menu.
  if (!moved) {
    _dragIsLifted = false;
    _dragSourceId = null;
    _dragMoved = false;
    return;
  }

  if (hadTarget && sourceId && sourceId !== targetId) {
    // Keep the dragged node pinned at its drop coords while the menu is open.
    // Menu actions (or Cancel) decide whether to release it.
    const clientX = e.sourceEvent?.clientX ?? 0;
    const clientY = e.sourceEvent?.clientY ?? 0;
    _showDropMenu(clientX, clientY, { source: sourceId, target: targetId, draggedNode: d });
  } else {
    // No drop target — release the pin and run a *localized* resettle so
    // only nodes near the drop position adjust. Far-away nodes stay frozen
    // (we pin them for the duration of the settle, then unpin).
    const cx = d.x, cy = d.y;
    d.fx = null;
    d.fy = null;
    _localResettle(cx, cy);
    _scheduleLabelLayout(true);
  }

  _dragIsLifted = false;
  _dragSourceId = null;
  _dragMoved = false;
  // _dragTargetId already null after _setDragTargetId(null)
}

function _nodeDomFromId(id) {
  if (!id) return null;
  // <g class="graph-node" data-node-id="..."> wrapper set at render time.
  // CSS.escape (not HTML escape — different rules) for the selector value.
  const cssId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  return document.querySelector(`g.graph-node[data-node-id="${cssId}"]`);
}

function _nodeIdFromDomElement(el) {
  if (!el) return null;
  let n = el;
  while (n && n !== document) {
    if (n.classList && n.classList.contains('graph-node') && n.dataset?.nodeId) return n.dataset.nodeId;
    n = n.parentNode;
  }
  return null;
}

function _setDragTargetId(id) {
  if (_dragTargetId === id) return;
  // Strip highlight from previous target
  if (_dragTargetId) {
    const prev = _nodeDomFromId(_dragTargetId);
    if (prev) prev.classList.remove('node-drag-target');
  }
  _dragTargetId = id;
  if (id) {
    const next = _nodeDomFromId(id);
    if (next) next.classList.add('node-drag-target');
  }
}

let _dragConnectorLine = null;
function _updateDragConnector(sourceNode, targetId, e) {
  try {
    // Append inside the zoomed <g> (parent of gLinks) so the connector shares
    // the same pan/zoom transform as the nodes — otherwise its coords are off
    // by the current zoom offset.
    const parentG = gLinks?.node()?.parentNode;
    if (!parentG) return;
    if (!_dragConnectorLine) {
      const ns = 'http://www.w3.org/2000/svg';
      _dragConnectorLine = document.createElementNS(ns, 'line');
      _dragConnectorLine.setAttribute('stroke', 'var(--accent)');
      _dragConnectorLine.setAttribute('stroke-width', '1.5');
      _dragConnectorLine.setAttribute('stroke-dasharray', '4 3');
      _dragConnectorLine.setAttribute('pointer-events', 'none');
      _dragConnectorLine.setAttribute('opacity', '0');
      parentG.appendChild(_dragConnectorLine);
    }
    // Compute graph coords from the source node + target node (or cursor).
    const sx = sourceNode.x ?? 0;
    const sy = sourceNode.y ?? 0;
    let tx, ty;
    if (targetId) {
      const t = (graphData?.nodes || []).find(n => n.id === targetId);
      if (!t) return;
      tx = t.x ?? 0; ty = t.y ?? 0;
    } else {
      tx = e.x; ty = e.y;
    }
    _dragConnectorLine.setAttribute('x1', sx);
    _dragConnectorLine.setAttribute('y1', sy);
    _dragConnectorLine.setAttribute('x2', tx);
    _dragConnectorLine.setAttribute('y2', ty);
    _dragConnectorLine.setAttribute('opacity', targetId ? '0.95' : '0.4');
  } catch {}
}
function _hideDragConnector() {
  if (_dragConnectorLine) {
    try { _dragConnectorLine.remove(); } catch {}
    _dragConnectorLine = null;
  }
}

// ── Drop menu ────────────────────────────────────────────────────────
// Shown after a drag ends on top of another node. Actions either mutate the
// graph server-side (fast path: link/child) or kick off an agent loop that
// performs a semantic merge (merge).
let _dropMenuState = null;   // { source, target, draggedNode }

function _showDropMenu(clientX, clientY, state) {
  const menu = document.getElementById('graph-drop-menu');
  if (!menu || !state?.source || !state?.target) return;
  _dropMenuState = state;
  const srcEl = menu.querySelector('[data-drop-source]');
  const tgtEl = menu.querySelector('[data-drop-target]');
  if (srcEl) srcEl.textContent = state.source;
  if (tgtEl) tgtEl.textContent = state.target;
  // Position at cursor, clamped to viewport.
  const pad = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(clientX, vw - 260) + 'px';
  menu.style.top = Math.min(clientY, vh - 220) + 'px';
  menu.classList.add('open');
  // Defer the outside-click listener so the mouseup that ended the drag
  // doesn't immediately close the menu.
  setTimeout(() => {
    document.addEventListener('click', _dropMenuOutsideClick, true);
    document.addEventListener('keydown', _dropMenuKey, true);
  }, 0);
}

function _hideDropMenu(releasePinnedNode = true) {
  const menu = document.getElementById('graph-drop-menu');
  if (menu) menu.classList.remove('open');
  document.removeEventListener('click', _dropMenuOutsideClick, true);
  document.removeEventListener('keydown', _dropMenuKey, true);
  if (releasePinnedNode && _dropMenuState?.draggedNode) {
    const d = _dropMenuState.draggedNode;
    d.fx = null;
    d.fy = null;
    _scheduleTickRender();
  }
  _dropMenuState = null;
}

function _dropMenuOutsideClick(e) {
  const menu = document.getElementById('graph-drop-menu');
  if (menu && !menu.contains(e.target)) _hideDropMenu(true);
}
function _dropMenuKey(e) {
  if (e.key === 'Escape') _hideDropMenu(true);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const action = t.getAttribute?.('data-drop-action');
  if (!action) return;
  const state = _dropMenuState;
  if (!state) return;
  e.preventDefault();
  e.stopPropagation();
  if (action === 'cancel') { _hideDropMenu(true); return; }
  _executeDropAction(action, state);
});

async function _executeDropAction(action, state) {
  const { source, target } = state;
  if (action === 'merge') {
    // Pin the source node at drop coords (already pinned); don't release yet.
    // Agent will actually delete it when merge completes. If it fails, the
    // node stays where it was — the operator can drag it back.
    toast(`Merging ${source} into ${target} — agent is working`);
    _hideDropMenu(false);
    try {
      const r = await fetch(API + '/api/graph/merge', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceNodeId: source, targetNodeId: target, mode: 'merge' }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
      // Agent will emit graphEvents as it mutates; viewer updates live.
    } catch (e) {
      toast('Merge kickoff failed: ' + (e.message || e), true);
      // Release the pin and do a localized resettle around the drop point.
      if (state.draggedNode) {
        const cx = state.draggedNode.x, cy = state.draggedNode.y;
        state.draggedNode.fx = null;
        state.draggedNode.fy = null;
        _localResettle(cx, cy);
      }
    }
    return;
  }
  if (action === 'link' || action === 'child') {
    _hideDropMenu(false); // release pin manually below
    // 'link' now routes through the agent (it decides relationship type or
    // declines if unrelated); 'child' is still a fast-path parent_of edge.
    if (action === 'link') {
      toast(`Asking the agent how ${source} relates to ${target}…`);
    }
    try {
      const body = action === 'child'
        ? { sourceNodeId: source, targetNodeId: target, mode: 'child' }
        : { sourceNodeId: source, targetNodeId: target, mode: 'link' };
      const r = await fetch(API + '/api/graph/merge', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
      if (action === 'child') toast(`Moved ${source} under ${target}`);
    } catch (e) {
      toast((action === 'child' ? 'Child link' : 'Link') + ' failed: ' + (e.message || e), true);
    }
    // Release the pin. For 'child', snap the dragged node right next to its
    // new parent so they're visibly stuck together. For 'link', leave it
    // where dropped. Either way, run a localized resettle so neighbours
    // adjust but the far-away graph stays still.
    if (state.draggedNode) {
      if (action === 'child') {
        const parent = (graphData?.nodes || []).find(n => n.id === target);
        if (parent && typeof parent.x === 'number') {
          const pr = parent.radius || 16;
          const cr = state.draggedNode.radius || 16;
          state.draggedNode.x = parent.x + pr + cr + 6;
          state.draggedNode.y = parent.y;
        }
      }
      const cx = state.draggedNode.x, cy = state.draggedNode.y;
      state.draggedNode.fx = null;
      state.draggedNode.fy = null;
      _localResettle(cx, cy);
    }
  }
}

// Event log widget — persistent history, clickable to expand.
// Replaces the old fade-out toast feed. addEventToFeed() keeps the same
// signature so every existing caller works unchanged.
const EVENT_LOG_MAX = 200;
const EVENT_LOG_STORAGE_KEY = 'spore-event-log';
const _eventLog = [];           // { ts, op, detail, source, html }
let _eventLogIdleTimer = null;
let _eventLogSaveTimer = null;

function _eventLogPersist() {
  // Debounced — bursts of 50 events don't hammer localStorage.
  if (_eventLogSaveTimer) return;
  _eventLogSaveTimer = setTimeout(() => {
    _eventLogSaveTimer = null;
    try {
      const plain = _eventLog.map(e => ({ ts: e.ts, op: e.op, detail: e.detail, source: e.source }));
      localStorage.setItem(EVENT_LOG_STORAGE_KEY, JSON.stringify(plain));
    } catch {}
  }, 400);
}

function _eventLogRestore() {
  try {
    const raw = localStorage.getItem(EVENT_LOG_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      _eventLog.push({
        ts: Number(e.ts) || Date.now(),
        op: String(e.op || 'event'),
        detail: String(e.detail || ''),
        source: String(e.source || ''),
        html: null,
      });
    }
    while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  } catch {}
}

function _eventLogFormat(evt) {
  const op = String(evt?.op || 'event');
  const source = String(evt?.source || '');
  let detail = '';
  if (evt?.node?.id) detail = evt.node.id;
  else if (evt?.nodeId) detail = evt.nodeId;
  else if (evt?.edge) detail = `${evt.edge.source} → ${evt.edge.target}`;
  else if (evt?.tool) detail = evt.tool;
  else if (evt?.attributeId) detail = `attr#${evt.attributeId}`;
  else if (evt?.detail) detail = String(evt.detail).slice(0, 120); // generic carrier for read-path events (recall, scan, etc.)
  return { op, detail, source };
}

// Live stack state — shows up to STACK_MAX rows when events are coming in
// quickly. After STACK_COLLAPSE_MS of quiet it contracts back to the single
// most-recent row so the dock stays compact.
const EVENT_LOG_STACK_MAX = 5;
const EVENT_LOG_COLLAPSE_MS = 3500;
const _eventLogStack = []; // newest last

function _eventLogRowHtml(entry, asIdle = false) {
  if (asIdle) return `<div class="event-log-row idle">idle</div>`;
  const bits = [`<span class="ev-op">${esc(entry.op)}</span>`];
  if (entry.detail) bits.push(`<span class="ev-detail">${esc(entry.detail)}</span>`);
  if (entry.source) bits.push(`<span class="ev-src">${esc(entry.source)}</span>`);
  return `<div class="event-log-row">${bits.join(' ')}</div>`;
}

function _eventLogRenderStack() {
  const stack = document.getElementById('event-log-stack');
  if (!stack) return;
  if (!_eventLogStack.length) {
    stack.innerHTML = _eventLogRowHtml(null, true);
    stack.style.setProperty('--row-count', '1');
    return;
  }
  stack.innerHTML = _eventLogStack.map(e => _eventLogRowHtml(e)).join('');
  // Drive the container's max-height transition via the row count so the
  // stack grows/shrinks smoothly when events fire and when it collapses.
  stack.style.setProperty('--row-count', String(_eventLogStack.length));
}

function _eventLogBumpStack(entry) {
  _eventLogStack.push(entry);
  while (_eventLogStack.length > EVENT_LOG_STACK_MAX) _eventLogStack.shift();
  _eventLogRenderStack();
  const widget = document.getElementById('event-log');
  if (widget) widget.classList.add('has-activity');
  if (_eventLogIdleTimer) clearTimeout(_eventLogIdleTimer);
  _eventLogIdleTimer = setTimeout(() => {
    // Collapse back to just the most recent row + drop the edge animation.
    if (_eventLogStack.length > 1) {
      _eventLogStack.splice(0, _eventLogStack.length - 1);
      _eventLogRenderStack();
    }
    const w = document.getElementById('event-log');
    if (w) w.classList.remove('has-activity');
  }, EVENT_LOG_COLLAPSE_MS);
}

function _eventLogRenderTicker(entry) {
  // Legacy name kept for _eventLogBootstrap. Non-bump render: just set
  // the stack to the single entry (used on initial restore from storage).
  if (!entry) { _eventLogStack.length = 0; _eventLogRenderStack(); return; }
  _eventLogStack.length = 0;
  _eventLogStack.push({ op: entry.op, detail: entry.detail, source: entry.source });
  _eventLogRenderStack();
}

function _eventLogRenderPanel() {
  const list = document.getElementById('event-log-list');
  if (!list) return;
  if (!_eventLog.length) {
    list.innerHTML = '<div class="event-item" style="opacity:.5">(no events yet)</div>';
    return;
  }
  // Newest first. Also memoize the HTML per entry to avoid re-escaping.
  const rows = [];
  for (let i = _eventLog.length - 1; i >= 0; i--) {
    const e = _eventLog[i];
    if (!e.html) {
      const hhmmss = new Date(e.ts).toLocaleTimeString(undefined, { hour12: false });
      e.html = `<div class="event-item" title="${esc(JSON.stringify(e))}">
        <span class="ev-time">${hhmmss}</span>
        <span class="ev-op">${esc(e.op)}</span>
        ${esc(e.detail)}
        ${e.source ? `<span class="ev-src">${esc(e.source)}</span>` : ''}
      </div>`;
    }
    rows.push(e.html);
  }
  list.innerHTML = rows.join('');
}

function addEventToFeed(evt) {
  const formatted = _eventLogFormat(evt);
  const entry = {
    ts: Date.now(),
    op: formatted.op,
    detail: formatted.detail,
    source: formatted.source,
    html: null,
  };
  _eventLog.push(entry);
  while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  _eventLogBumpStack({ op: formatted.op, detail: formatted.detail, source: formatted.source });
  const widget = document.getElementById('event-log');
  if (widget?.classList.contains('open')) _eventLogRenderPanel();
  _eventLogPersist();
}

function _eventLogOpen() {
  const widget = document.getElementById('event-log');
  if (!widget) return;
  widget.classList.add('open');
  widget.setAttribute('aria-expanded', 'true');
  _eventLogRenderPanel();
  document.addEventListener('click', _eventLogOutsideClick, true);
}
function _eventLogClose() {
  const widget = document.getElementById('event-log');
  if (!widget) return;
  widget.classList.remove('open');
  widget.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _eventLogOutsideClick, true);
}
function _eventLogOutsideClick(e) {
  const widget = document.getElementById('event-log');
  if (widget && !widget.contains(e.target)) _eventLogClose();
}
function _eventLogClear() {
  _eventLog.length = 0;
  _eventLogRenderTicker(null);
  _eventLogRenderPanel();
  try { localStorage.removeItem(EVENT_LOG_STORAGE_KEY); } catch {}
}

// Restore persisted log on first evaluation of this block so the ticker
// shows the last known event + the expand-panel has history. Runs right
// after DOM is ready (this script block lives after the elements).
(function _eventLogBootstrap() {
  _eventLogRestore();
  const tick = () => {
    const last = _eventLog[_eventLog.length - 1];
    if (last) _eventLogRenderTicker({ op: last.op, detail: last.detail, source: last.source });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    tick();
  }
})();

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('#event-log-close')) { _eventLogClose(); e.stopPropagation(); return; }
  if (t.closest('#event-log-clear')) { _eventLogClear(); e.stopPropagation(); return; }
  const clickedStack = t.closest('#event-log-stack');
  const widget = document.getElementById('event-log');
  if (clickedStack && widget) {
    if (widget.classList.contains('open')) _eventLogClose();
    else _eventLogOpen();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const widget = document.getElementById('event-log');
  if (document.activeElement !== widget) return;
  e.preventDefault();
  if (widget.classList.contains('open')) _eventLogClose();
  else _eventLogOpen();
});

// ── Graph Performance Helpers ──
function _scheduleTickRender() {
  if (_tickScheduled) return;
  _needsTick = true;
  _tickScheduled = true;
  requestAnimationFrame(_renderTick);
}

function _renderTick() {
  _tickScheduled = false;
  if (!_needsTick) return;
  _needsTick = false;

  const linkEls = gLinks.node().children;
  for (let i = 0, len = linkEls.length; i < len; i++) {
    const el = linkEls[i];
    const d = el.__data__;
    if (!d || !d.source || !d.target) continue;
    const dx = d.target.x - d.source.x;
    const dy = d.target.y - d.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const tr = (d.target.radius || 12) + 2;
    el.setAttribute('x1', d.source.x);
    el.setAttribute('y1', d.source.y);
    el.setAttribute('x2', d.target.x - dx * tr / dist);
    el.setAttribute('y2', d.target.y - dy * tr / dist);
  }

  const nodeEls = gNodes.node().children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const el = nodeEls[i];
    const d = el.__data__;
    if (!d) continue;
    el.setAttribute('transform', `translate(${d.x},${d.y})`);
  }

  _scheduleLabelLayout();
}

function _updateNodeLabelVisibility(scale = _currentZoomScale) {
  if (!gNodes || !svg) return;
  const nodeLayer = gNodes.node();
  if (!nodeLayer) return;
  const nodeEls = Array.from(nodeLayer.children);
  if (!nodeEls.length) return;

  const svgNode = svg.node();
  const centerX = (svgNode?.clientWidth || window.innerWidth) / 2;
  const centerY = (svgNode?.clientHeight || window.innerHeight) / 2;
  const nodes = nodeEls.map((el) => ({
    data: el.__data__,
    labelEl: el.querySelector('text.node-label'),
    subEl:   el.querySelector('text.node-sub-label'),
  })).filter((entry) => entry.data && entry.labelEl);

  // Only show as many labels as the current zoom can support without
  // visual collision pile-up. Importance-ranked: most important nodes first,
  // hovered/selected always shown.
  const budget = _autoLabelBudget(scale, nodes.length);
  const opacity = _autoLabelOpacity(scale);

  const ranked = nodes.slice().sort((a, b) => {
    const ia = a.data.importance || 0;
    const ib = b.data.importance || 0;
    if (ib !== ia) return ib - ia;
    // Tiebreak by mention count, then by id for stability
    const ma = a.data.mentions || 0, mb = b.data.mentions || 0;
    if (mb !== ma) return mb - ma;
    return String(a.data.id).localeCompare(String(b.data.id));
  });

  const visible = new Set();
  for (let i = 0; i < Math.min(budget, ranked.length); i++) {
    visible.add(ranked[i].data.id);
  }
  if (hoveredNodeId) visible.add(hoveredNodeId);
  if (selectedNodeIds && selectedNodeIds.size) {
    for (const id of selectedNodeIds) visible.add(id);
  }

  for (const entry of nodes) {
    if (visible.has(entry.data.id)) {
      const placement = _preferredLabelPlacement(entry.data, centerX, centerY);
      _setLabelPlacement(entry.labelEl, placement);
      _setLabelVisible(entry.labelEl, opacity);
      // Stack the mono uppercase sub-label one line below the name with
      // matching anchor + baseline. ~1em (12px) below.
      if (entry.subEl) {
        entry.subEl.setAttribute('x', placement.attrs.x);
        entry.subEl.setAttribute('y', Number(placement.attrs.y) + 12);
        entry.subEl.setAttribute('text-anchor', placement.attrs.anchor);
        entry.subEl.setAttribute('dominant-baseline', placement.attrs.baseline);
        entry.subEl.style.opacity = String(Math.max(0, Math.min(1, opacity * 0.85)));
      }
    } else {
      _setLabelHidden(entry.labelEl);
      if (entry.subEl) entry.subEl.style.opacity = '0';
    }
  }
}

function _applySemanticZoom(scale) {
  if (!gNodes) return;
  const showGlyphs = scale > 0.14;
  const showArrows = scale > 0.25;
  const nodeEls = gNodes.node().children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const glyphEl = nodeEls[i].querySelector('text.node-glyph');
    if (glyphEl) glyphEl.style.display = showGlyphs ? '' : 'none';
  }
  _scheduleLabelLayout();
  if (gLinks) {
    const lines = gLinks.node().children;
    const markerVal = showArrows ? 'url(#arrowhead)' : '';
    for (let i = 0, len = lines.length; i < len; i++) {
      if (lines[i].getAttribute('marker-end') !== markerVal) {
        lines[i].setAttribute('marker-end', markerVal);
      }
    }
  }
}

// ── Graph Visualization ──
function initGraph(data) {
  graphData = data;
  const canvasEl = document.getElementById('canvas');
  const width = canvasEl.clientWidth;
  const height = canvasEl.clientHeight;
  const nodeCount = data.nodes.length;
  const profile = _graphForceProfile(nodeCount);

  svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
    .attr('refX', 10).attr('refY', 0).attr('markerWidth', 4).attr('markerHeight', 4)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L10,0L0,4');

  // Backdrop from design_handoff_node_graph: a 24×24 dotted grid plus a
  // soft radial vignette darkening the corners. Sits behind the zoomable
  // group so neither moves/scales with pan-zoom — keeps the canvas
  // grounded at any zoom level. Plus mono corner-tick labels (0,0 / W,0 /
  // 0,H) for a "field notebook" feel.
  const gridPat = defs.append('pattern')
    .attr('id', 'graph-grid-dots')
    .attr('width', 24).attr('height', 24)
    .attr('patternUnits', 'userSpaceOnUse');
  gridPat.append('circle')
    .attr('cx', 0.6).attr('cy', 0.6).attr('r', 0.6)
    .attr('fill', 'var(--graph-hair, var(--border-subtle))');
  const vignette = defs.append('radialGradient')
    .attr('id', 'graph-vignette')
    .attr('cx', '50%').attr('cy', '50%').attr('r', '60%');
  vignette.append('stop').attr('offset', '55%').attr('stop-color', 'rgba(0,0,0,0)');
  vignette.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(0,0,0,0.045)');
  svg.append('rect')
    .attr('class', 'graph-grid-bg')
    .attr('x', 0).attr('y', 0)
    .attr('width', '100%').attr('height', '100%')
    .attr('fill', 'url(#graph-grid-dots)')
    .attr('opacity', 0.7)
    .attr('pointer-events', 'none');
  svg.append('rect')
    .attr('class', 'graph-vignette-bg')
    .attr('x', 0).attr('y', 0)
    .attr('width', '100%').attr('height', '100%')
    .attr('fill', 'url(#graph-vignette)')
    .attr('pointer-events', 'none');

  const g = svg.append('g');

  zoom = d3.zoom()
    .filter(e => {
      if (_isMarqueeGesture(e)) return false;
      return (!e.ctrlKey || e.type === 'wheel') && !e.button;
    })
    .scaleExtent([0.1, 8]).on('zoom', e => {
    g.attr('transform', e.transform);
    const newScale = e.transform.k;
    if (Math.abs(newScale - _currentZoomScale) > 0.05 || (newScale < 0.4) !== (_currentZoomScale < 0.4)) {
      _currentZoomScale = newScale;
      _applySemanticZoom(newScale);
    }
  });
  svg.call(zoom);

  _selectionRect = svg.append('rect')
    .attr('class', 'graph-selection-rect')
    .style('display', 'none');

  gLinks = g.append('g').attr('class', 'links');
  gNodes = g.append('g').attr('class', 'nodes');

  const nodeMap = {};
  data.nodes.forEach(n => { nodeMap[n.id] = n; n.radius = _computeNodeRadius(n); });
  hoveredNodeId = nodeMap[hoveredNodeId] ? hoveredNodeId : null;
  simLinks = data.edges.filter(e => nodeMap[e.source] && nodeMap[e.target]).map(e => ({...e}));

  // Place each node inside its type's anchor cell BEFORE the simulation starts.
  _seedNodesByType(data.nodes, width, height);

  // Per-node anchors: each node gets pulled toward its TYPE's grid cell, not
  // toward viewport center. No global forceCenter / global axis forces — they
  // would fight the per-type pull and produce a "smear" instead of clusters.
  const _typeAnchors = _typeClusterAnchors(data.nodes, width, height);
  const _anchorX = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.x ?? width / 2);
  const _anchorY = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.y ?? height / 2);

  simulation = d3.forceSimulation(data.nodes)
    // Weak link strength so cross-type edges don't drag nodes out of their
    // treemap rect. Edges are still drawn; they just don't dominate layout.
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(l => l.type === 'parent_of' ? 28 : profile.linkDistance)
      .strength(l => l.type === 'parent_of' ? 0.95 : profile.linkStrength))
    // Charge limited to local range so a far-away node never throws another
    // node out of its cluster. Without distanceMax, a 300-node graph means
    // every node feels every other → instant scattering of pre-seeded clusters.
    .force('charge', d3.forceManyBody().strength(profile.chargeStrength).theta(profile.chargeTheta).distanceMax(profile.chargeMaxDist))
    .force('clusterX', d3.forceX(_anchorX).strength(profile.clusterStrength))
    .force('clusterY', d3.forceY(_anchorY).strength(profile.clusterStrength))
    .force('collision', _createLabelBoxCollide().strength(1.0).padding(4).iterations(profile.collisionIterations + 1))
    .velocityDecay(profile.velocityDecay)
    .on('tick', _scheduleTickRender);

  // Pre-bake synchronously: tick until alpha is low enough that visible motion
  // is invisible, capped by a wall-clock budget so the page never freezes.
  // Then PARK the simulation (alpha below alphaMin) so it stays still until
  // user interaction (drag) explicitly restarts it.
  {
    simulation.stop();
    const bakeBudget = 700; // ms hard cap
    const start = performance.now();
    let ticked = 0;
    while (simulation.alpha() > 0.003 && ticked < 800) {
      simulation.tick();
      ticked++;
      if ((ticked & 15) === 0 && (performance.now() - start) > bakeBudget) break;
    }
    simulation.alpha(0.0009); // < default alphaMin (0.001) — parks the timer
  }

  // Stroke color comes from the CSS rule (#graph-svg g.links line) so it
  // resolves --text correctly per active theme. SVG presentation
  // attributes don't expand var(), so setting it inline here would
  // produce a literal "var(--text)" string and fall back to black.
  const link = gLinks.selectAll('line').data(simLinks).join('line')
    .attr('marker-end', 'url(#arrowhead)')
    .attr('data-edge-kind', d => getEdgeKind(d))
    .attr('stroke-linecap', 'round')
    .attr('stroke-width', d => EDGE_KIND[getEdgeKind(d)].width)
    .attr('stroke-opacity', d => EDGE_KIND[getEdgeKind(d)].opacity)
    .attr('stroke-dasharray', d => EDGE_KIND[getEdgeKind(d)].dash || null);

  const nodeG = gNodes.selectAll('g').data(data.nodes, d => d.id).join('g')
    .classed('graph-node', true)
    .attr('data-node-id', d => d.id)
    .call(_nodeDragBehavior())
    .on('click', (e, d) => {
      e.stopPropagation();
      if (_suppressNextGraphClick) {
        _suppressNextGraphClick = false;
        return;
      }
      hideGraphContextMenu();
      selectNode(d);
    })
    .on('dblclick', (e, d) => {
      e.stopPropagation();
      e.preventDefault();
      _focusGraphOnNode(d.id);
    })
    .on('mouseenter', (_, d) => _setHoveredNode(d.id))
    .on('mouseleave', (_, d) => {
      if (hoveredNodeId === d.id) _setHoveredNode(null);
    });

  _upsertNodeVisuals(nodeG);

  svg.on('mousedown.marquee', (e) => _beginGraphMarquee(e));

  // Right-click (desktop) and long-press (touch) both open the same
  // context menu. Shared body extracted so the touch path doesn't
  // drift from the mouse path.
  function _openCtxMenuAt(targetEl, clientX, clientY) {
    const nodeEl = targetEl?.closest?.('g.graph-node');
    const node = nodeEl?.__data__ || null;
    if (node) {
      if (!selectedNodeIds.has(node.id) || selectedNodeIds.size !== 1) {
        _setGraphSelection([node.id]);
      }
    } else if (!selectedNodeIds.size) {
      hideGraphContextMenu();
      return false;
    }
    if (!selectedNodeIds.size) return false;
    showGraphContextMenu(clientX, clientY);
    return true;
  }

  svg.on('contextmenu.graphmenu', (e) => {
    if (_openCtxMenuAt(e.target, e.clientX, e.clientY)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ── Touch long-press → context menu ──
  // d3-zoom v7 already handles pinch-zoom + two-finger pan via
  // pointer events. The remaining touch gap is the right-click
  // equivalent. 500ms hold without movement >10px fires the same
  // menu at the touch point. Movement cancels (treats as drag/pan),
  // early release cancels. Mouse events ignored — they go through
  // the contextmenu handler above.
  const svgNode = svg.node();
  let _lpTimer = null;
  let _lpStart = null; // { x, y, target }
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_THRESHOLD = 10;
  const _cancelLongPress = () => {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    _lpStart = null;
  };
  svgNode.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    _lpStart = { x: e.clientX, y: e.clientY, target: e.target };
    _lpTimer = setTimeout(() => {
      if (!_lpStart) return;
      const fired = _openCtxMenuAt(_lpStart.target, _lpStart.x, _lpStart.y);
      if (fired) _suppressNextGraphClick = true; // prevent the post-release click from clearing selection
      _lpTimer = null;
      _lpStart = null;
    }, LONG_PRESS_MS);
  }, { passive: true });
  svgNode.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !_lpStart) return;
    const dx = e.clientX - _lpStart.x;
    const dy = e.clientY - _lpStart.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) _cancelLongPress();
  }, { passive: true });
  svgNode.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    _cancelLongPress();
  }, { passive: true });
  svgNode.addEventListener('pointercancel', () => _cancelLongPress(), { passive: true });
  svg.on('click', () => {
    if (_suppressNextGraphClick) {
      _suppressNextGraphClick = false;
      return;
    }
    if (_graphFocusedId) { _unfocusGraph(); return; }
    clearGraphSelection();
  });

  // Populate filter
  const types = [...new Set(data.nodes.map(n => n.type))].sort();
  const filterEl = document.getElementById('filter-type');
  filterEl.innerHTML = '<option value="">all types</option>';
  types.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; filterEl.appendChild(o); });

  updateStats();
  _restoreGraphSelection();
  _applySemanticZoom(_currentZoomScale);
  _scheduleTickRender();
}

// ── Node Selection / Editor Panel ──
function selectNode(node) {
  _setGraphSelection([node.id], { panelNode: node });
}

// Focus mode: hide everything except the given node + its direct neighbors,
// then fit-to-view. Click background to restore.
function _focusGraphOnNode(nodeId) {
  if (!gNodes || !gLinks || !graphData) return;
  const neighbors = new Set([nodeId]);
  for (const e of (graphData.edges || [])) {
    const s = e.source?.id || e.source;
    const t = e.target?.id || e.target;
    if (s === nodeId) neighbors.add(t);
    if (t === nodeId) neighbors.add(s);
  }
  _graphFocusedId = nodeId;
  _graphPreFocusTransform = svg ? d3.zoomTransform(svg.node()) : null;

  gNodes.selectAll('g')
    .attr('opacity', d => neighbors.has(d.id) ? 1 : 0)
    .style('pointer-events', d => neighbors.has(d.id) ? '' : 'none');
  gLinks.selectAll('line')
    .attr('opacity', d => {
      const s = d.source.id || d.source;
      const t = d.target.id || d.target;
      return (s === nodeId || t === nodeId) ? 1 : 0;
    });

  // Add edge-type labels along visible edges, oriented in the source→target direction.
  const innerG = d3.select(gNodes.node().parentNode);
  let labelsG = innerG.select('g.focus-edge-labels');
  if (labelsG.empty()) labelsG = innerG.append('g').attr('class', 'focus-edge-labels');
  const visibleEdges = (typeof simLinks !== 'undefined' ? simLinks : []).filter(d => {
    const s = d.source?.id || d.source;
    const t = d.target?.id || d.target;
    return s === nodeId || t === nodeId;
  });
  labelsG.selectAll('text').data(visibleEdges).join('text')
    .attr('class', 'focus-edge-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .text(d => d.type || 'related')
    .attr('transform', d => {
      const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
      const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      let deg = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI;
      // Keep text upright — flip if reading direction would be upside down
      if (deg > 90 || deg < -90) deg += 180;
      // Lift the label slightly off the line (perpendicular offset)
      const perpAngle = (deg + 90) * Math.PI / 180;
      const lift = 9;
      const ox = Math.cos(perpAngle) * lift;
      const oy = Math.sin(perpAngle) * lift;
      return `translate(${mx + ox},${my + oy}) rotate(${deg})`;
    });

  const visible = (graphData.nodes || []).filter(n => neighbors.has(n.id) && Number.isFinite(n.x) && Number.isFinite(n.y));
  if (visible.length && svg && zoom) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of visible) {
      const r = (n.radius || 12) + 30; // include label area
      if (n.x - r < minX) minX = n.x - r;
      if (n.x + r > maxX) maxX = n.x + r;
      if (n.y - r < minY) minY = n.y - r;
      if (n.y + r > maxY) maxY = n.y + r;
    }
    const w = svg.node().clientWidth || window.innerWidth;
    const h = svg.node().clientHeight || window.innerHeight;
    const pad = 60;
    const sx = (w - pad * 2) / Math.max(40, maxX - minX);
    const sy = (h - pad * 2) / Math.max(40, maxY - minY);
    const scale = Math.max(0.4, Math.min(2.2, Math.min(sx, sy)));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tx = w / 2 - cx * scale;
    const ty = h / 2 - cy * scale;
    svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }
}

function _unfocusGraph() {
  if (!_graphFocusedId) return;
  _graphFocusedId = null;
  if (gNodes) gNodes.selectAll('g').attr('opacity', 1).style('pointer-events', '');
  if (gLinks) gLinks.selectAll('line').attr('opacity', 1);
  if (gNodes) {
    const innerG = d3.select(gNodes.node().parentNode);
    innerG.select('g.focus-edge-labels').remove();
  }
  if (svg && zoom && _graphPreFocusTransform) {
    svg.transition().duration(450).call(zoom.transform, _graphPreFocusTransform);
  }
  _graphPreFocusTransform = null;
}

function closePanel() {
  clearGraphSelection();
}

// ── Token Dashboard ──
async function renderTokenDashboard(body) {
  body.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;padding:8px 0">Loading token data…</div>';
  let data;
  try {
    const res = await fetch(API + '/api/tokens');
    data = await res.json();
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  if (data.error) {
    body.innerHTML = `<div style="color:var(--text-dim);font-size:0.8rem;padding:8px 0">${esc(data.error)}</div>`;
    return;
  }

  function fmtN(n) { return (n||0).toLocaleString(); }
  function fmtCost(c) { return c == null ? '—' : `$${parseFloat(c).toFixed(4)}`; }

  function statCard(label, input, output, calls, cost) {
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-family:var(--font-body);font-size:0.8rem">
        <div><span style="color:var(--text-dim)">in </span><span style="color:var(--accent2)">${fmtN(input)}</span></div>
        <div><span style="color:var(--text-dim)">out </span><span style="color:var(--accent3)">${fmtN(output)}</span></div>
        <div><span style="color:var(--text-dim)">calls </span><span style="color:var(--text)">${fmtN(calls)}</span></div>
        <div><span style="color:var(--text-dim)">est. </span><span style="color:var(--warn)">${fmtCost(cost)}</span></div>
      </div>
    </div>`;
  }

  const daily = (data.daily || []).slice(0, 14).reverse();
  const maxTotal = Math.max(...daily.map(d => (d.input||0) + (d.output||0)), 1);
  const barChart = daily.length ? `
    <div class="section">
      <div class="section-title">Last 14 Days</div>
      <div style="display:flex;align-items:flex-end;gap:3px;height:60px;padding:4px 0">
        ${daily.map(d => {
          const total = (d.input||0) + (d.output||0);
          const pct = Math.max(2, Math.round((total / maxTotal) * 56));
          const day = d.date.slice(5);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
            <div title="${day}: ${fmtN(total)} tokens, ${d.calls} calls, est. ${fmtCost(d.totalCost)}"
              style="width:100%;height:${pct}px;background:var(--accent2);border-radius:2px 2px 0 0;opacity:0.75;cursor:default"></div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:0.6rem;color:var(--text-dim);font-family:var(--font-body);margin-top:2px">
        <span>${daily[0]?.date.slice(5)||''}</span>
        <span>${daily[daily.length-1]?.date.slice(5)||''}</span>
      </div>
    </div>` : '';

  const channelRows = Object.entries(data.byChannel || {})
    .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
  const channelTable = channelRows.length ? `
    <div class="section">
      <div class="section-title">By Channel (all time)</div>
      <table style="width:100%;font-size:0.75rem;font-family:var(--font-body);border-collapse:collapse">
        <thead><tr style="color:var(--text-dim);font-size:0.65rem">
          <th style="text-align:left;padding:3px 0">channel</th>
          <th style="text-align:right">in</th>
          <th style="text-align:right">out</th>
          <th style="text-align:right">calls</th>
        </tr></thead>
        <tbody>
          ${channelRows.map(([ch, s]) => `<tr style="border-top:1px solid var(--border)">
            <td style="padding:4px 0;color:var(--text-dim)">${ch}</td>
            <td style="text-align:right;color:var(--accent2)">${fmtN(s.input)}</td>
            <td style="text-align:right;color:var(--accent3)">${fmtN(s.output)}</td>
            <td style="text-align:right">${fmtN(s.calls)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const rates = data.costRates || {};

  body.innerHTML = `
    <div style="font-size:0.65rem;color:var(--text-dim);font-family:var(--font-body);margin-bottom:12px">
      est. @ $${rates.inputPerM}/M in · $${rates.outputPerM}/M out (Sonnet pricing)
    </div>
    <div class="section">
      <div class="section-title">Usage</div>
      ${statCard('Today',     data.today?.input,          data.today?.output,          data.today?.calls,          data.today?.totalCost)}
      ${statCard('Yesterday', data.yesterday?.input,      data.yesterday?.output,      data.yesterday?.calls,      data.yesterday?.totalCost)}
      ${statCard('7 days',    data.windows?.['7d']?.input, data.windows?.['7d']?.output, data.windows?.['7d']?.calls, data.windows?.['7d']?.totalCost)}
      ${statCard('30 days',   data.windows?.['30d']?.input, data.windows?.['30d']?.output, data.windows?.['30d']?.calls, data.windows?.['30d']?.totalCost)}
      ${statCard('All time',  data.windows?.allTime?.input, data.windows?.allTime?.output, data.windows?.allTime?.calls, data.windows?.allTime?.totalCost)}
    </div>
    ${barChart}
    ${channelTable}
  `;
}

// ── Editor Panel Rendering ──
function renderPanel(node) {
  document.querySelector('#panel-title h2').textContent = node.label;
  document.querySelector('#panel-title .node-type').textContent = node.type;
  document.querySelector('#panel-title .node-type').style.color = getColor(node.type);

  const body = document.getElementById('panel-body');

  if (node.id === 'spore-token-log') {
    renderTokenDashboard(body);
    return;
  }

  const outEdges = graphData.edges.filter(e => (e.source.id || e.source) === node.id);
  const inEdges = graphData.edges.filter(e => (e.target.id || e.target) === node.id);

  body.innerHTML = `
    <div class="section">
      <div class="section-title">Identity</div>
      <div class="field"><label>ID</label><input id="edit-id" value="${esc(node.id)}" disabled></div>
      <div class="field"><label>Label</label><input id="edit-label" value="${esc(node.label)}"></div>
      <div class="field"><label>Type</label>
        <select id="edit-type">
          ${[...new Set(['self','person','channel','concept','rule','project','tool','memory','skill','capability',
            'preference','event','organization','topic','location','group','interest','emotion','belief','relationship',
            ...(node.type && !['self','person','channel','concept','rule','project','tool','memory','skill','capability',
            'preference','event','organization','topic','location','group','interest','emotion','belief','relationship'].includes(node.type) ? [node.type] : [])])
          ].map(t => `<option value="${t}" ${t===node.type?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Description</label><textarea id="edit-desc" rows="3">${esc(node.description)}</textarea></div>
      <div class="field"><label>Importance (1-10)</label><input type="number" id="edit-imp" min="1" max="10" value="${node.importance||5}"></div>
      <div class="btn-row">
        <button class="btn btn-save" data-action="save-node">save node</button>
        <button class="btn btn-danger" data-action="delete-node" data-id="${escAttr(node.id)}">delete</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Aspects <button data-action="new-aspect" data-node-id="${escAttr(node.id)}">+ add</button></div>
      <div id="aspects-list">
        ${(node.aspects||[]).map((a, i) => `
          <div class="aspect-card" data-aspect-idx="${i}">
            <div class="aspect-header">
              <span class="aspect-name">${esc(a.name)}</span>
              <span class="aspect-weight">w:${a.weight||5}
                <button class="btn btn-danger" style="font-size:0.55rem;padding:1px 5px;margin-left:6px"
                  data-action="delete-aspect" data-node-id="${escAttr(node.id)}" data-name="${escAttr(a.name)}" data-aspect-id="${a.id||0}">×</button>
              </span>
            </div>
            ${(a.attributes||[]).map(at => {
              const atId = at.id || 0;
              const atContent = typeof at === 'string' ? at : at.content;
              return `
              <div class="attr-item" style="display:flex;align-items:start;gap:4px;group">
                <span class="attr-text" style="flex:1;cursor:pointer" data-action="edit-attr" data-attr-id="${atId}"
                  data-node-id="${escAttr(node.id)}" data-aspect-name="${escAttr(a.name)}" data-weight="${a.weight||5}"
                  title="Click to edit">${esc(atContent)}</span>
                ${at.eventDate ? `<span class="attr-date" style="font-family:var(--font-body);font-size:0.55rem;color:var(--accent2);white-space:nowrap;flex-shrink:0">${esc(at.eventDate)}</span>` : ''}
                ${at.importance ? `<span class="attr-importance"> (${at.importance})</span>` : ''}
                ${atId ? `<button class="btn btn-danger" style="font-size:0.5rem;padding:0px 4px;flex-shrink:0;opacity:0.5"
                  data-action="delete-attr" data-attr-id="${atId}" title="Delete attribute">×</button>` : ''}
              </div>`;
            }).join('')}
            <div style="margin-top:8px">
              <input placeholder="add attribute..." style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:0.75rem"
                data-action="add-attr" data-node-id="${escAttr(node.id)}" data-name="${escAttr(a.name)}" data-weight="${a.weight||5}">
            </div>
          </div>
        `).join('') || '<div style="color:var(--text-dim);font-size:0.8rem">No aspects</div>'}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Edges <button data-action="new-edge" data-node-id="${escAttr(node.id)}">+ add</button></div>
      ${outEdges.map(e => `
        <div class="edge-item">
          <span class="edge-type">${esc(e.type)}</span>
          <span>→</span>
          <span class="edge-target" data-action="navigate" data-id="${escAttr(e.target.id||e.target)}">${esc(getNodeLabel(e.target))}</span>
          <button class="btn btn-danger" style="font-size:0.5rem;padding:1px 4px;margin-left:auto"
            data-action="delete-edge" data-source="${escAttr(e.source.id||e.source)}" data-target="${escAttr(e.target.id||e.target)}" data-type="${escAttr(e.type)}">×</button>
        </div>
      `).join('')}
      ${inEdges.map(e => `
        <div class="edge-item">
          <span class="edge-target" data-action="navigate" data-id="${escAttr(e.source.id||e.source)}">${esc(getNodeLabel(e.source))}</span>
          <span>→</span>
          <span class="edge-type">${esc(e.type)}</span>
          <span>→ this</span>
        </div>
      `).join('')}
      ${(!outEdges.length && !inEdges.length) ? '<div style="color:var(--text-dim);font-size:0.8rem">No edges</div>' : ''}
    </div>

    <div class="section">
      <div class="section-title">Aliases</div>
      <div style="color:var(--text-dim);font-size:0.8rem">
        ${(node.aliases||[]).map(a => esc(a)).join(', ') || 'none'}
      </div>
    </div>
  `;
}

// ── Helpers ──
function esc(s) {
  if (!s) return '';
  const str = typeof s === 'object' ? (s.id || String(s)) : String(s);
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s) {
  return esc(s).replace(/\\/g,'\\\\');
}

function getNodeLabel(ref) {
  const id = ref.id || ref;
  const n = graphData.nodes.find(n => n.id === id);
  return n ? n.label : id;
}

function navigateNode(id) {
  const n = graphData.nodes.find(n => n.id === id);
  if (n) selectNode(n);
}

// ── CRUD Operations ──
async function doSaveNode() {
  const data = {
    id: document.getElementById('edit-id').value,
    label: document.getElementById('edit-label').value,
    type: document.getElementById('edit-type').value,
    description: document.getElementById('edit-desc').value,
    importance: parseInt(document.getElementById('edit-imp').value) || 5,
  };
  try {
    await saveNode(data);
    const n = graphData.nodes.find(n => n.id === data.id);
    if (n) { Object.assign(n, data); selectNode(n); }
    toast('Node saved');
  } catch (e) { toast('Save failed: ' + e.message, true); }
}

async function doDeleteNode(id) {
  if (!confirm('Delete node "' + id + '" and all its aspects/edges?')) return;
  try {
    hideGraphContextMenu();
    await deleteNode(id);
    toast('Node deleted');
    closePanel();
    reload();
  } catch (e) { toast('Delete failed: ' + e.message, true); }
}

async function doDeleteSelectedNodes() {
  const ids = [...selectedNodeIds];
  if (!ids.length) return;

  const label = ids.length === 1
    ? `Delete node "${ids[0]}" and all its aspects/edges?`
    : `Delete ${ids.length} selected nodes and all their aspects/edges?`;
  if (!confirm(label)) return;

  hideGraphContextMenu();

  const failures = [];
  for (const id of ids) {
    try {
      await deleteNode(id);
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
    }
  }

  clearGraphSelection();
  await reload();

  if (!failures.length) {
    toast(ids.length === 1 ? 'Node deleted' : `${ids.length} nodes deleted`);
  } else {
    const successCount = ids.length - failures.length;
    toast(`Deleted ${successCount}/${ids.length} nodes. ${failures[0]}`, true);
  }
}

async function doDeleteAspect(nodeId, name, aspectId) {
  if (!aspectId) {
    const node = graphData.nodes.find(n => n.id === nodeId);
    const aspect = node?.aspects?.find(a => a.name === name);
    aspectId = aspect?.id;
  }
  if (aspectId) {
    try { await deleteAspect(aspectId); toast('Aspect deleted'); reload(); }
    catch (e) { toast('Failed: ' + e.message, true); }
  } else {
    await saveAspect({ nodeId, name, weight: 0, attributes: [] });
    toast('Aspect cleared'); reload();
  }
}

async function doNewAspect(nodeId) {
  const name = prompt('Aspect name (e.g. personality, interests, preferences):');
  if (!name) return;
  const content = prompt('First attribute (a fact or detail):');
  try {
    await saveAspect({ nodeId, name, weight: 7, attributes: content ? [{ content, importance: 7 }] : [] });
    toast('Aspect added');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doAddAttr(nodeId, aspectName, inputEl, weight) {
  const content = inputEl.value.trim();
  if (!content) return;
  const res = await fetch(API + '/api/graph');
  const fresh = await res.json();
  const node = fresh.nodes.find(n => n.id === nodeId);
  const aspect = node?.aspects?.find(a => a.name === aspectName);
  const existingAttrs = aspect?.attributes || [];
  existingAttrs.push({ content, importance: 7 });
  try {
    await saveAspect({ nodeId, name: aspectName, weight, attributes: existingAttrs });
    toast('Attribute added');
    inputEl.value = '';
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doDeleteAttr(attrId) {
  if (!attrId) return;
  try {
    await deleteAttribute(attrId);
    toast('Attribute deleted');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doEditAttr(attrId, el) {
  if (!attrId) return;
  const currentText = el.textContent.trim();
  const newText = prompt('Edit attribute:', currentText);
  if (newText === null || newText.trim() === currentText) return;
  if (!newText.trim()) {
    await doDeleteAttr(attrId);
    return;
  }
  try {
    await updateAttribute(attrId, { content: newText.trim(), importance: 7 });
    toast('Attribute updated');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doNewEdge(sourceId) {
  const target = prompt('Target node ID:');
  if (!target) return;
  const type = prompt('Relationship type (e.g. knows, uses, created):');
  if (!type) return;
  try {
    await saveEdge({ source: sourceId, target, type, weight: 1 });
    toast('Edge added');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function doDeleteEdge(source, target, type) {
  try {
    await deleteEdge({ source, target, type });
    toast('Edge removed');
    reload();
  } catch (e) { toast('Failed: ' + e.message, true); }
}

async function reload() {
  const data = await fetchGraph();
  // Incremental merge when the graph is already running — preserves the
  // user's current zoom + pan + force layout. Full initGraph wipes the SVG
  // (including the zoom transform) which feels like the camera "jumping"
  // every time you delete a node or aspect.
  if (simulation) {
    mergeGraph(data, { newNodes: new Set(), pulseNodes: new Set(), newEdges: [] });
  } else {
    initGraph(data);
  }
}

function showNewNodeModal() {
  const id = prompt('Node ID (lowercase-hyphenated, e.g. "my-concept"):');
  if (!id) return;
  const label = prompt('Label (display name):');
  if (!label) return;
  const type = prompt('Type (person, concept, project, rule, channel, etc.):') || 'concept';
  saveNode({ id, label, type, description: '', importance: 5 })
    .then(() => { toast('Node created'); reload(); })
    .catch(e => toast('Failed: ' + e.message, true));
}

// ── Delegated Event Handlers ──
document.getElementById('panel-body')?.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'save-node') doSaveNode();
  else if (action === 'delete-node') doDeleteNode(el.dataset.id);
  else if (action === 'delete-aspect') doDeleteAspect(el.dataset.nodeId, el.dataset.name, parseInt(el.dataset.aspectId));
  else if (action === 'new-aspect') doNewAspect(el.dataset.nodeId);
  else if (action === 'new-edge') doNewEdge(el.dataset.nodeId);
  else if (action === 'delete-edge') doDeleteEdge(el.dataset.source, el.dataset.target, el.dataset.type);
  else if (action === 'navigate') navigateNode(el.dataset.id);
  else if (action === 'delete-attr') doDeleteAttr(parseInt(el.dataset.attrId));
  else if (action === 'edit-attr') doEditAttr(parseInt(el.dataset.attrId), el);
});
document.getElementById('panel-body')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-action="add-attr"]');
  if (!el) return;
  doAddAttr(el.dataset.nodeId, el.dataset.name, el, parseInt(el.dataset.weight));
});

// ── Top-level Controls ──
// panel-close handled by rp-close
document.getElementById('btn-center').onclick = () => {
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
};
document.getElementById('btn-new-node').onclick = showNewNodeModal;
