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

  if (!_graphEventTargetsViewedGraph(evt)) return;

  if (evt.op === 'node:create') {
    queueGraphRefresh({ delay: 500, minInterval: 1200 });
    if (evt.node?.id) pendingAnimations.newNodes.add(evt.node.id);
  } else if (evt.op === 'node:update') {
    const nid = evt.nodeId || evt.node?.id;
    if (nid) pendingAnimations.pulseNodes.add(nid);
    queueGraphRefresh({ delay: 900, minInterval: 1800 });
  } else if (evt.op === 'attribute:create' || evt.op === 'attribute:update' || evt.op === 'attribute:delete' || evt.op === 'aspect:create' || evt.op === 'aspect:update' || evt.op === 'aspect:delete' || evt.op === 'reflection:upsert') {
    const nid = evt.nodeId || evt.node?.id;
    if (nid) pendingAnimations.pulseNodes.add(nid);
    queueGraphRefresh({ delay: 2800, minInterval: 6500 });
  } else if (evt.op === 'edge:create') {
    queueGraphRefresh({ delay: 700, minInterval: 1400 });
    if (evt.edge) pendingAnimations.newEdges.push(evt.edge);
  } else if (evt.op === 'node:delete') {
    const nid = evt.nodeId;
    if (nid && gNodes) {
      gNodes.selectAll('g').filter(d => d.id === nid).classed('node-deleting', true);
      if (gLinks) {
        gLinks.selectAll('line').filter(d => d.source.id === nid || d.target.id === nid).classed('edge-deleting', true);
      }
    }
    setTimeout(() => queueGraphRefresh({ delay: 200, minInterval: 1200 }), 1300);
  } else if (evt.op === 'edge:delete') {
    if (evt.edge && gLinks) {
      gLinks.selectAll('line')
        .filter(d => d.source.id === evt.edge.source && d.target.id === evt.edge.target && d.type === evt.edge.type)
        .classed('edge-deleting', true);
    }
    setTimeout(() => queueGraphRefresh({ delay: 200, minInterval: 1200 }), 1100);
  } else if (evt.op === 'node:accessed') {
    _queueNodeAccessPulse(evt.nodeIds || []);
  }
}

function _graphEventTargetsViewedGraph(evt) {
  const eventSlugs = [];
  if (Array.isArray(evt?.graphs)) {
    for (const g of evt.graphs) if (g) eventSlugs.push(String(g));
  }
  for (const g of [evt?.graph, evt?.graphSlug, evt?.slug]) {
    if (!g) continue;
    for (const part of String(g).split(',')) {
      const trimmed = part.trim();
      if (trimmed) eventSlugs.push(trimmed);
    }
  }
  if (!eventSlugs.length) return true;
  const viewedSlug = typeof _viewedGraphSlug !== 'undefined' ? _viewedGraphSlug : null;
  if (!viewedSlug) return true;
  return eventSlugs.includes(String(viewedSlug));
}

const pendingAnimations = { newNodes: new Set(), pulseNodes: new Set(), newEdges: [] };
let refreshTimer = null;
let refreshInFlight = false;
let refreshPending = false;
let lastGraphRefreshAt = 0;
let simLinks = [];
const _pendingNodeAccessPulseIds = new Set();
let _nodeAccessPulseTimer = null;
let _lastNodeAccessPulseAt = 0;
const _pendingEdgeConnectLines = new Set();
let _edgeConnectRaf = null;

let _graphNodePerformanceMetricViz = !!window.__sporeNodePerformanceMetricViz;

function _graphNodePerformanceMetricVizEnabled() {
  return !!_graphNodePerformanceMetricViz;
}

function _setGraphNodePerformanceMetricViz(enabled, opts = {}) {
  _graphNodePerformanceMetricViz = !!enabled;
  window.__sporeNodePerformanceMetricViz = _graphNodePerformanceMetricViz;
  if (opts.refreshStats !== false && typeof updateStats === 'function' && document.getElementById('stats')) {
    try { updateStats(); } catch {}
  }
}

async function _loadGraphNodePerformanceMetricVizSetting() {
  if (typeof fetch !== 'function' || typeof API === 'undefined') return;
  try {
    const r = await fetch(API + '/api/settings', {
      headers: typeof authHeaders === 'function' ? authHeaders() : {},
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return;
    const values = data?.values || data?.settings?.values || {};
    if (Object.prototype.hasOwnProperty.call(values, 'nodePerformanceMetricViz')) {
      _setGraphNodePerformanceMetricViz(!!values.nodePerformanceMetricViz);
    }
  } catch {}
}

window._setGraphNodePerformanceMetricViz = _setGraphNodePerformanceMetricViz;
window._graphNodePerformanceMetricVizEnabled = _graphNodePerformanceMetricVizEnabled;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _loadGraphNodePerformanceMetricVizSetting, { once: true });
} else {
  _loadGraphNodePerformanceMetricVizSetting();
}
let _viewportCullRaf = null;
let _viewportCullingActive = false;
let _lastCullStats = { nodes: 0, edges: 0, totalNodes: 0, totalEdges: 0 };
let _webglGraph = null;
let _webglResizeCommitTimer = null;
let _hybridFullWebglData = null;
let _hybridSwitchRaf = null;
let _hybridSwitching = false;
let _graphFocusTransitioning = false;
let _graphRendererTransitionToken = 0;
let _hybridLastSvgKey = '';
let _hybridLastSwitchAt = 0;
let _zoomInteractionTimer = null;
let _lastSvgLabelLayoutKey = '';
const HYBRID_SVG_NODE_LIMIT = 500;
const HYBRID_WEBGL_NODE_LIMIT = 600;
const HYBRID_SVG_EDGE_LIMIT = 2400;
const HYBRID_CONTEXT_NODE_LIMIT = 180;
const HYBRID_CONTEXT_EDGES_PER_NODE = 5;
const HYBRID_EVAL_IDLE_MS = 160;
const HYBRID_SWITCH_COOLDOWN_MS = 420;
const FOCUS_NEIGHBOR_LIMIT = 96;
const FOCUS_EDGE_LIMIT = 420;
const SVG_LABEL_SCREEN_FONT_PX = 10.5;
const SVG_SUB_LABEL_SCREEN_FONT_PX = 8.5;
const SVG_EDGE_STROKE_MIN = 0.05;
const SVG_EDGE_STROKE_MAX = 0.2;
const SVG_EDGE_CONNECT_START_STROKE = 1.0;
const SMALL_SHARED_LAYOUT_COMPACT_LIMIT = 72;
const SHARED_LAYOUT_SETTLE_MAX_TICKS = 420;
window._graphViewState = window._graphViewState || { mode: 'auto', root: null };

function _cancelSvgLabelLayoutTimer() {
  if (typeof _labelLayoutTimer !== 'undefined' && _labelLayoutTimer) {
    clearTimeout(_labelLayoutTimer);
    _labelLayoutTimer = null;
  }
}

function _beginSvgLabelRefresh() {
  _cancelSvgLabelLayoutTimer();
  _lastSvgLabelLayoutKey = '';
  if (svg) svg.classed('labels-settling', true);
}

function _finishSvgLabelRefresh() {
  _cancelSvgLabelLayoutTimer();
  _lastSvgLabelLayoutKey = '';
  if (typeof _scheduleLabelLayout === 'function') _scheduleLabelLayout(true);
  const svgRef = svg;
  requestAnimationFrame(() => {
    if (svgRef?.node?.()) svgRef.classed('labels-settling', false);
  });
}

function _setGraphViewState(mode, root = null) {
  window._graphViewState = {
    mode: mode || 'auto',
    root: root || null,
  };
}

function _graphLayoutCacheKey(data = graphData) {
  const slug = (typeof _viewedGraphSlug !== 'undefined' && _viewedGraphSlug) || data?.graph?.slug || 'active';
  const meta = data?.meta || {};
  const mode = meta.requestedMode || meta.mode || window._graphViewState?.mode || 'auto';
  const root = meta.root || window._graphViewState?.root || 'all';
  return `spore:graph-layout:${slug}:${mode}:${root}`;
}

function _graphNodeHasApiPosition(node) {
  return Number.isFinite(Number(node?.x)) && Number.isFinite(Number(node?.y));
}

function _graphUsesSharedLayout(data = graphData) {
  const nodes = data?.nodes || [];
  return !!data?.meta?.layout && nodes.length > 0 && nodes.every(_graphNodeHasApiPosition);
}

function _graphSelfNodeId(nodes = graphData?.nodes || []) {
  const self = (nodes || []).find((node) => {
    const id = String(node?.id || '').toLowerCase();
    const type = String(node?.type || '').toLowerCase();
    return type === 'self'
      || id === 'self'
      || id === 'spore'
      || id === 'spore-core'
      || id.includes('spore-self');
  });
  return self?.id || null;
}

function _graphEdgeNodeId(ref) {
  return ref?.id || ref;
}

function _graphEdgeTouchesNode(edge, nodeId) {
  if (!nodeId) return false;
  return _graphEdgeNodeId(edge?.source) === nodeId || _graphEdgeNodeId(edge?.target) === nodeId;
}

function _smallSharedLayoutCompactScale(nodeCount = 0) {
  if (nodeCount <= 1 || nodeCount > SMALL_SHARED_LAYOUT_COMPACT_LIMIT) return 1;
  if (nodeCount <= 8) return 0.46;
  if (nodeCount <= 16) return 0.55;
  if (nodeCount <= 32) return 0.68;
  if (nodeCount <= 48) return 0.78;
  return 0.88;
}

function _compactSmallSharedLayout(data = graphData, selfId = null) {
  if (!_graphUsesSharedLayout(data)) return 1;
  const nodes = data?.nodes || [];
  const scale = _smallSharedLayoutCompactScale(nodes.length);
  if (scale >= 0.999) return 1;
  const selfNode = nodes.find(n => n?.id === selfId) || null;
  const originX = Number.isFinite(Number(selfNode?.x)) ? Number(selfNode.x) : 0;
  const originY = Number.isFinite(Number(selfNode?.y)) ? Number(selfNode.y) : 0;
  for (const node of nodes) {
    if (!Number.isFinite(Number(node?.x)) || !Number.isFinite(Number(node?.y))) continue;
    if (node.id === selfId || node.type === 'self') {
      node.x = originX;
      node.y = originY;
      continue;
    }
    node.x = originX + ((Number(node.x) - originX) * scale);
    node.y = originY + ((Number(node.y) - originY) * scale);
  }
  if (data.meta) data.meta.clientCompactScale = scale;
  return scale;
}

function _centerSharedLayoutOnSelf(data = graphData, selfId = null) {
  if (!_graphUsesSharedLayout(data) || !selfId) return false;
  const nodes = data?.nodes || [];
  const selfNode = nodes.find(n => n?.id === selfId);
  const originX = Number(selfNode?.x);
  const originY = Number(selfNode?.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return false;
  if (Math.abs(originX) < 0.001 && Math.abs(originY) < 0.001) return true;
  for (const node of nodes) {
    if (!Number.isFinite(Number(node?.x)) || !Number.isFinite(Number(node?.y))) continue;
    node.x = Number(node.x) - originX;
    node.y = Number(node.y) - originY;
  }
  selfNode.x = 0;
  selfNode.y = 0;
  return true;
}

function _graphStableUnit(value, salt = 0) {
  let hash = 2166136261;
  const text = `${value || ''}:${salt}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function _graphAdjacency(edges = []) {
  const adjacency = new Map();
  const touch = (a, b) => {
    if (!a || !b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const edge of edges || []) {
    const source = _graphEdgeNodeId(edge?.source);
    const target = _graphEdgeNodeId(edge?.target);
    touch(source, target);
    touch(target, source);
  }
  return adjacency;
}

function _applySmallSharedRadialLayout(data = graphData, selfId = null, edges = []) {
  if (!_graphUsesSharedLayout(data)) return false;
  const nodes = data?.nodes || [];
  if (nodes.length <= 1 || nodes.length > SMALL_SHARED_LAYOUT_COMPACT_LIMIT) return false;
  const selfNode = nodes.find(n => n?.id === selfId) || null;
  if (!selfNode) return false;
  const adjacency = _graphAdjacency(edges);
  const selfNeighbors = adjacency.get(selfId) || new Set();
  const others = nodes
    .filter(n => n && n.id !== selfId && n.type !== 'self')
    .sort((a, b) => {
      const as = selfNeighbors.has(a.id) ? 1 : 0;
      const bs = selfNeighbors.has(b.id) ? 1 : 0;
      if (bs !== as) return bs - as;
      const ad = adjacency.get(a.id)?.size || 0;
      const bd = adjacency.get(b.id)?.size || 0;
      if (bd !== ad) return bd - ad;
      const ai = Number(a.importance) || 0;
      const bi = Number(b.importance) || 0;
      if (bi !== ai) return bi - ai;
      const am = Number(a.mentions) || 0;
      const bm = Number(b.mentions) || 0;
      if (bm !== am) return bm - am;
      return String(a.id).localeCompare(String(b.id));
    });

  selfNode.x = 0;
  selfNode.y = 0;
  selfNode._sharedAnchorX = 0;
  selfNode._sharedAnchorY = 0;

  const count = others.length;
  if (!count) return true;
  const firstRadius = Math.max(96, Math.min(172, 92 + count * 5));
  const ringGap = count <= 24 ? 92 : 102;
  const minArc = count <= 16 ? 84 : 92;
  const ySquash = 0.84;
  let cursor = 0;
  let ring = 0;
  const graphKey = data?.graph?.slug || data?.meta?.mode || 'graph';
  while (cursor < count) {
    const radius = firstRadius + ring * ringGap;
    const naturalCapacity = Math.max(4, Math.floor((Math.PI * 2 * radius) / minArc));
    const remaining = count - cursor;
    const capacity = count <= 14 ? remaining : Math.min(remaining, naturalCapacity);
    const start = capacity === 2
      ? 0.08
      : (-Math.PI / 2) + (Math.PI / Math.max(3, capacity)) + (ring * 0.37) + ((_graphStableUnit(graphKey, ring + 11) - 0.5) * 0.22);
    for (let i = 0; i < capacity; i++) {
      const node = others[cursor + i];
      const angle = start + (i * Math.PI * 2 / capacity);
      const radialJitter = (_graphStableUnit(node.id, 3) - 0.5) * 8;
      const r = radius + radialJitter;
      node.x = Math.round(Math.cos(angle) * r * 10) / 10;
      node.y = Math.round(Math.sin(angle) * r * ySquash * 10) / 10;
      node._sharedAnchorX = node.x;
      node._sharedAnchorY = node.y;
      node.vx = 0;
      node.vy = 0;
    }
    cursor += capacity;
    ring++;
  }
  if (data.meta) data.meta.clientLayout = 'small-radial';
  return true;
}

function _sharedLayoutDistanceScale(nodeCount = 0) {
  if (nodeCount <= 1 || nodeCount > SMALL_SHARED_LAYOUT_COMPACT_LIMIT) return 1;
  if (nodeCount <= 8) return 0.58;
  if (nodeCount <= 16) return 0.66;
  if (nodeCount <= 32) return 0.76;
  if (nodeCount <= 48) return 0.86;
  return 0.94;
}

function _sharedLayoutLinkDistance(edge, selfId, nodeCount = 0) {
  if (nodeCount > 1 && nodeCount <= SMALL_SHARED_LAYOUT_COMPACT_LIMIT) {
    if (_graphEdgeTouchesNode(edge, selfId)) return nodeCount <= 12 ? 104 : 118;
    if (edge?.type === 'parent_of') return 96;
    return 126;
  }
  const scale = _sharedLayoutDistanceScale(nodeCount);
  if (_graphEdgeTouchesNode(edge, selfId)) return 112 * scale;
  if (edge?.type === 'parent_of') return 76 * scale;
  return 118 * scale;
}

function _sharedLayoutLinkStrength(edge, selfId) {
  if (_graphEdgeTouchesNode(edge, selfId)) return 0.24;
  if (edge?.type === 'parent_of') return 0.22;
  return 0.07;
}

function _sharedLayoutOriginStrength(node, selfId, nodeCount = 0) {
  if (node?.id === selfId || node?.type === 'self') return 0.72;
  if (nodeCount <= SMALL_SHARED_LAYOUT_COMPACT_LIMIT && Number.isFinite(Number(node?._sharedAnchorX))) return 0.1;
  if (nodeCount <= 16) return 0.03;
  if (nodeCount <= 48) return 0.02;
  if (nodeCount > 300) return 0.004;
  if (nodeCount > 150) return 0.007;
  return 0.012;
}

function _parkSharedLayoutSimulation(data = graphData) {
  if (!simulation) return;
  const setStrength = (name, value) => {
    try {
      const force = simulation.force(name);
      if (force && typeof force.strength === 'function') force.strength(value);
    } catch {}
  };
  try {
    const linkForce = simulation.force('link');
    if (linkForce && typeof linkForce.distance === 'function') linkForce.distance(1);
    if (linkForce && typeof linkForce.strength === 'function') linkForce.strength(0);
  } catch {}
  setStrength('charge', 0);
  setStrength('clusterX', 0);
  setStrength('clusterY', 0);
  setStrength('collision', 0);
  for (const node of data?.nodes || []) {
    node.vx = 0;
    node.vy = 0;
  }
  simulation.alphaTarget(0).stop().alpha(0.0009);
}

function _restoreGraphLayout(data) {
  try {
    if (_graphUsesSharedLayout(data)) return 0;
    const raw = localStorage.getItem(_graphLayoutCacheKey(data));
    if (!raw) return 0;
    const cached = JSON.parse(raw);
    const positions = cached?.positions || {};
    let restored = 0;
    for (const n of data.nodes || []) {
      const p = positions[n.id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      n.x = p.x;
      n.y = p.y;
      n.vx = 0;
      n.vy = 0;
      restored++;
    }
    return restored;
  } catch {
    return 0;
  }
}

function _saveGraphLayout(data = graphData) {
  try {
    if (_graphUsesSharedLayout(data)) return;
    const nodes = data?.nodes || [];
    if (!nodes.length || nodes.length > 1600) return;
    const positions = {};
    for (const n of nodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y)) positions[n.id] = { x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10 };
    }
    localStorage.setItem(_graphLayoutCacheKey(data), JSON.stringify({ at: Date.now(), positions }));
  } catch {
    // Browser storage can be unavailable or full; layout caching is optional.
  }
}

async function loadGraphMode(mode, root = null) {
  try {
    if (mode === 'full') {
      const total = graphData?.meta?.nodeCount || graphData?.nodes?.length || 0;
      if (total > 2000 && !confirm(`Load the full ${total.toLocaleString()} node graph? This can be slow.`)) return;
    }
    _setGraphViewState(mode, root);
    const data = await fetchGraph({ mode, root });
    await _swapGraphWithFade(() => {
      renderGraphPayload(data);
    });
    const label = mode === 'slice' && root ? 'slice' : (mode === 'auto' ? 'graph' : mode);
    toast(`Loaded ${label} view`);
  } catch (e) {
    toast('Graph load failed: ' + e.message, true);
  }
}

function renderGraphPayload(data) {
  if (data?.meta?.mode === 'webgl') initWebglGraph(data);
  else initGraph(data);
}
window.renderGraphPayload = renderGraphPayload;

async function fetchNodeDetails(nodeId) {
  const res = await fetch(graphApiUrl('/api/graph/node/' + encodeURIComponent(nodeId)));
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Node details failed');
  return data;
}

function _mergeNodeDetails(payload) {
  const detail = payload?.node;
  if (!detail?.id || !graphData?.nodes) return null;
  let node = graphData.nodes.find(n => n.id === detail.id);
  if (!node) {
    node = detail;
    graphData.nodes.push(node);
  } else {
    Object.assign(node, detail);
  }
  if (Array.isArray(payload?.edges)) node._detailEdges = payload.edges;
  if (Array.isArray(payload?.neighbors)) node._detailNeighbors = payload.neighbors;
  node._detailsLoaded = true;
  node.radius = _computeNodeRadius(node);
  if (_webglGraph?.idToIndex?.has(detail.id)) {
    const webglNode = _webglGraph.data.nodes[_webglGraph.idToIndex.get(detail.id)];
    if (webglNode && webglNode !== node) Object.assign(webglNode, node);
  }
  return node;
}

async function _loadNodeDetails(nodeId) {
  try {
    const payload = await fetchNodeDetails(nodeId);
    const node = _mergeNodeDetails(payload);
    if (node && selectedNodeIds?.has(nodeId)) {
      _setGraphSelection([nodeId], { panelNode: node });
    }
    if (node) _refreshCurrentAltView();
  } catch (e) {
    console.warn('Node details failed:', e);
  }
}

function _refreshCurrentAltView() {
  try {
    if (typeof window._refreshAltViews === 'function') window._refreshAltViews();
  } catch (e) {
    console.warn('Alternate graph view refresh failed:', e);
  }
}

function _graphViewportBounds(transform = null) {
  if (!svg?.node()) return null;
  const node = svg.node();
  const width = node.clientWidth || window.innerWidth || 1;
  const height = node.clientHeight || window.innerHeight || 1;
  const t = transform || d3.zoomTransform(node);
  const k = Math.max(0.001, t.k || 1);
  const padPx = Math.max(160, Math.min(360, 220 / Math.max(0.7, Math.min(2.4, k))));
  return {
    minX: (0 - padPx - t.x) / k,
    maxX: (width + padPx - t.x) / k,
    minY: (0 - padPx - t.y) / k,
    maxY: (height + padPx - t.y) / k,
  };
}

function _fitSharedGraphLayout(data = graphData, opts = {}) {
  if (!_graphUsesSharedLayout(data) || !svg?.node() || !zoom) return false;
  const nodes = data.nodes || [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = Number(node.x);
    const y = Number(node.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const r = (node.radius || _computeNodeRadius(node) || 10) + 18;
    if (x - r < minX) minX = x - r;
    if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r;
    if (y + r > maxY) maxY = y + r;
  }
  if (!Number.isFinite(minX)) return false;
  const svgNode = svg.node();
  const width = svgNode.clientWidth || window.innerWidth || 1;
  const height = svgNode.clientHeight || window.innerHeight || 1;
  const pad = Number.isFinite(opts.pad) ? opts.pad : 64;
  const sx = (width - pad * 2) / Math.max(40, maxX - minX);
  const sy = (height - pad * 2) / Math.max(40, maxY - minY);
  const scale = Math.max(0.08, Math.min(5, Math.min(sx, sy)));
  const selfId = _graphSelfNodeId(nodes);
  const selfNode = selfId ? nodes.find(n => n?.id === selfId) : null;
  const centerOnSelf = nodes.length <= SMALL_SHARED_LAYOUT_COMPACT_LIMIT
    && Number.isFinite(Number(selfNode?.x))
    && Number.isFinite(Number(selfNode?.y));
  const cx = centerOnSelf ? Number(selfNode.x) : (minX + maxX) / 2;
  const cy = centerOnSelf ? Number(selfNode.y) : (minY + maxY) / 2;
  const transform = d3.zoomIdentity
    .translate(width / 2 - cx * scale, height / 2 - cy * scale)
    .scale(scale);
  if (opts.animate) svg.transition().duration(opts.duration || 350).call(zoom.transform, transform);
  else svg.call(zoom.transform, transform);
  _currentZoomScale = scale;
  return true;
}

function _captureGraphRendererSnapshot(host) {
  const rect = host?.getBoundingClientRect?.();
  if (!rect || rect.width < 2 || rect.height < 2) return null;
  const canvas = document.getElementById('graph-webgl');
  const svgEl = document.getElementById('graph-svg');
  const usingWebgl = host.classList.contains('webgl-active') && canvas && canvas.style.display !== 'none';
  if (usingWebgl && canvas) {
    try {
      const state = _webglGraph;
      if (state) _webglDraw(state);
      const gl = state?.gl || canvas.getContext('webgl');
      if (!gl) return null;
      gl.finish();
      const width = Math.max(1, gl.drawingBufferWidth || canvas.width || Math.round(rect.width));
      const height = Math.max(1, gl.drawingBufferHeight || canvas.height || Math.round(rect.height));
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const snap = document.createElement('canvas');
      snap.className = 'graph-renderer-snapshot graph-renderer-snapshot-canvas';
      snap.setAttribute('aria-hidden', 'true');
      snap.width = width;
      snap.height = height;
      snap.style.width = `${rect.width}px`;
      snap.style.height = `${rect.height}px`;
      const ctx = snap.getContext('2d');
      if (!ctx) return null;
      const image = ctx.createImageData(width, height);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y++) {
        const sourceStart = (height - 1 - y) * rowBytes;
        image.data.set(pixels.subarray(sourceStart, sourceStart + rowBytes), y * rowBytes);
      }
      ctx.putImageData(image, 0, 0);
      return snap;
    } catch {
      return null;
    }
  }
  if (svgEl) {
    const clone = svgEl.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('graph-renderer-snapshot', 'graph-renderer-snapshot-svg');
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('width', String(Math.round(rect.width)));
    clone.setAttribute('height', String(Math.round(rect.height)));
    return clone;
  }
  return null;
}

function _graphRendererCrossfade(work, opts = {}) {
  const host = document.getElementById('canvas');
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!host || reduceMotion) {
    work?.();
    return Promise.resolve();
  }
  const duration = Number(opts.duration) || 240;
  const token = ++_graphRendererTransitionToken;
  host.querySelectorAll('.graph-renderer-snapshot').forEach(el => el.remove());
  const snapshot = _captureGraphRendererSnapshot(host);
  if (!snapshot) {
    work?.();
    return Promise.resolve();
  }
  host.appendChild(snapshot);
  host.classList.remove('graph-renderer-fading', 'graph-renderer-revealing', 'graph-structure-transitioning', 'graph-structure-revealing');
  host.classList.add('graph-renderer-entering');
  return new Promise(resolve => {
    try {
      work?.();
    } finally {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (token !== _graphRendererTransitionToken) {
            snapshot.remove();
            resolve();
            return;
          }
          host.classList.remove('graph-renderer-entering');
          host.classList.add('graph-renderer-fading', 'graph-renderer-revealing');
          setTimeout(() => {
            if (token === _graphRendererTransitionToken) {
              snapshot.remove();
              host.classList.remove('graph-renderer-fading', 'graph-renderer-revealing');
            }
            resolve();
          }, duration);
        });
      });
    }
  });
}

function _graphStructureTransition(work, opts = {}) {
  return _graphRendererCrossfade(work, { duration: Number(opts.duration) || Number(opts.inMs) || 220 });
}

function _nodeInViewport(node, bounds) {
  if (!node || !bounds || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return true;
  const r = Math.max(18, (node.radius || 10) + 36);
  return node.x + r >= bounds.minX
    && node.x - r <= bounds.maxX
    && node.y + r >= bounds.minY
    && node.y - r <= bounds.maxY;
}

function _setCulled(el, culled) {
  if (!el) return;
  const value = culled ? 'true' : 'false';
  if (el.dataset.culled === value) return;
  el.dataset.culled = value;
  if (culled) {
    el.style.display = 'none';
    el.dataset.cullPointerEvents = el.style.pointerEvents || '';
    el.style.pointerEvents = 'none';
  } else {
    el.style.removeProperty('display');
    if (el.dataset.cullPointerEvents) el.style.pointerEvents = el.dataset.cullPointerEvents;
    else if (!el.style.getPropertyPriority('pointer-events')) el.style.removeProperty('pointer-events');
    delete el.dataset.cullPointerEvents;
  }
}

function _graphNeedsViewportCulling() {
  const nodeCount = graphData?.nodes?.length || 0;
  const edgeCount = simLinks?.length || graphData?.edges?.length || graphData?.webglEdges?.length || 0;
  return !!graphData?.meta?.hybridSubset || nodeCount > 500 || edgeCount > 1600;
}

function _clearViewportCulling() {
  if (_viewportCullRaf) {
    cancelAnimationFrame(_viewportCullRaf);
    _viewportCullRaf = null;
  }
  if (_viewportCullingActive) {
    const nodeEls = gNodes?.node()?.children || [];
    for (let i = 0, len = nodeEls.length; i < len; i++) {
      _setCulled(nodeEls[i], false);
    }
    const linkEls = gLinks?.node()?.children || [];
    for (let i = 0, len = linkEls.length; i < len; i++) {
      _setCulled(linkEls[i], false);
    }
  }
  _viewportCullingActive = false;
  _lastCullStats = { nodes: 0, edges: 0, totalNodes: 0, totalEdges: 0 };
}

function _scheduleViewportCulling(immediate = false) {
  if (!gNodes || !gLinks || !svg) return;
  if (!_graphNeedsViewportCulling()) {
    _clearViewportCulling();
    return;
  }
  if (immediate) {
    if (_viewportCullRaf) {
      cancelAnimationFrame(_viewportCullRaf);
      _viewportCullRaf = null;
    }
    _applyViewportCulling();
    return;
  }
  if (_viewportCullRaf) return;
  _viewportCullRaf = requestAnimationFrame(() => {
    _viewportCullRaf = null;
    _applyViewportCulling();
  });
}

function _applyViewportCulling() {
  if (!gNodes || !gLinks || !svg || !graphData?.nodes) return;
  const bounds = _graphViewportBounds();
  const visibleNodeIds = new Set();
  const filterVisibleNodeIds = new Set();
  const passesFilters = (typeof window._isNodeVisible === 'function')
    ? window._isNodeVisible
    : () => true;
  const nodeLayer = gNodes.node();
  const linkLayer = gLinks.node();
  if (!bounds || !nodeLayer || !linkLayer) return;

  const nodeEls = nodeLayer.children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const el = nodeEls[i];
    const d = el.__data__;
    const culled = !_nodeInViewport(d, bounds);
    _setCulled(el, culled);
    if (!culled && d?.id) {
      visibleNodeIds.add(d.id);
      if (passesFilters(d)) {
        filterVisibleNodeIds.add(d.id);
        el.style.removeProperty('opacity');
        if (!el.style.getPropertyPriority('pointer-events')) el.style.removeProperty('pointer-events');
      } else {
        el.style.setProperty('opacity', '0.08', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      }
    }
  }

  let visibleEdges = 0;
  const linkEls = linkLayer.children;
  for (let i = 0, len = linkEls.length; i < len; i++) {
    const el = linkEls[i];
    const d = el.__data__;
    const sourceId = d?.source?.id || d?.source;
    const targetId = d?.target?.id || d?.target;
    const culled = !(visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId));
    _setCulled(el, culled);
    if (!culled) {
      visibleEdges++;
      const passesEdgeFilters = filterVisibleNodeIds.has(sourceId) && filterVisibleNodeIds.has(targetId);
      if (passesEdgeFilters) {
        el.style.removeProperty('opacity');
        if (!el.style.getPropertyPriority('pointer-events')) el.style.removeProperty('pointer-events');
      } else {
        el.style.setProperty('opacity', '0.04', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      }
    }
  }

  _lastCullStats = {
    nodes: visibleNodeIds.size,
    edges: visibleEdges,
    totalNodes: nodeEls.length,
    totalEdges: linkEls.length,
  };
  _viewportCullingActive = true;
  const readout = document.getElementById('graph-rendered-count');
  if (readout) {
    readout.textContent = `rendering ${visibleNodeIds.size.toLocaleString()} nodes · ${visibleEdges.toLocaleString()} edges`;
  }
  _scheduleLabelLayout();
}

function _queueGraphRefreshDelay(opts = {}) {
  const delay = Math.max(0, Number(opts.delay ?? 800) || 0);
  const minInterval = Math.max(0, Number(opts.minInterval ?? 0) || 0);
  const sinceLast = Date.now() - lastGraphRefreshAt;
  return Math.max(delay, minInterval > sinceLast ? minInterval - sinceLast : 0);
}

function queueGraphRefresh(opts = {}) {
  refreshPending = true;
  if (refreshTimer) return;
  const wait = _queueGraphRefreshDelay(opts);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (refreshInFlight) {
      queueGraphRefresh({ delay: 900, minInterval: 1500 });
      return;
    }
    refreshPending = false;
    refreshInFlight = true;
    lastGraphRefreshAt = Date.now();
    try {
      const data = await fetchGraph();
      const anims = { newNodes: new Set(pendingAnimations.newNodes), pulseNodes: new Set(pendingAnimations.pulseNodes), newEdges: [...pendingAnimations.newEdges] };
      pendingAnimations.newNodes.clear();
      pendingAnimations.pulseNodes.clear();
      pendingAnimations.newEdges.length = 0;

      if (data?.meta?.mode === 'webgl') { initWebglGraph(data); return; }
      if (!simulation) { initGraph(data); return; }
      mergeGraph(data, anims);
    } catch (e) { console.error('Graph refresh failed:', e); }
    finally {
      refreshInFlight = false;
      if (refreshPending) queueGraphRefresh({ delay: 1200, minInterval: 1800 });
    }
  }, wait);
}

function _runNodeAccessPulse() {
  _nodeAccessPulseTimer = null;
  if (!gNodes || !_pendingNodeAccessPulseIds.size) return;
  const ids = new Set(_pendingNodeAccessPulseIds);
  _pendingNodeAccessPulseIds.clear();
  _lastNodeAccessPulseAt = Date.now();
  let touched = false;
  gNodes.selectAll('g').each(function(d) {
    if (!ids.has(d.id)) return;
    touched = true;
    const el = d3.select(this);
    el.classed('node-accessed', false);
    void this.offsetWidth;
    el.classed('node-accessed', true);
  });
  if (touched) {
    setTimeout(() => {
      if (!gNodes) return;
      gNodes.selectAll('g').classed('node-accessed', false);
    }, 1200);
  }
}

function _queueNodeAccessPulse(ids = []) {
  if (!ids?.length || !gNodes) return;
  for (const id of ids) if (id) _pendingNodeAccessPulseIds.add(id);
  if (_nodeAccessPulseTimer) return;
  const since = Date.now() - _lastNodeAccessPulseAt;
  const wait = since > 1800 ? 120 : 1800 - since;
  _nodeAccessPulseTimer = setTimeout(_runNodeAccessPulse, wait);
}

function _edgeKindDash(edge) {
  return EDGE_KIND[getEdgeKind(edge)]?.dash || '';
}

function _svgEdgeStrokeWidth(scale = _currentZoomScale, edge = null) {
  const k = Math.max(0.1, Math.min(8, Number(scale) || 1));
  const t = Math.max(0, Math.min(1, (Math.sqrt(k) - Math.sqrt(0.1)) / (Math.sqrt(8) - Math.sqrt(0.1))));
  const kind = getEdgeKind(edge);
  const kindMultiplier = kind === 'strong' ? 1.18 : (kind === 'soft' ? 0.82 : 1);
  const width = (SVG_EDGE_STROKE_MIN + ((SVG_EDGE_STROKE_MAX - SVG_EDGE_STROKE_MIN) * t)) * kindMultiplier;
  return Math.max(SVG_EDGE_STROKE_MIN, Math.min(SVG_EDGE_STROKE_MAX, width));
}

function _styleGraphLinks(selection) {
  return selection
    .classed('hybrid-context-edge', d => !!d.contextEdge)
    .attr('marker-end', 'url(#arrowhead)')
    .attr('data-edge-kind', d => getEdgeKind(d))
    .attr('data-edge-dash', d => _edgeKindDash(d))
    .attr('stroke-linecap', 'round')
    .attr('stroke-width', d => _svgEdgeStrokeWidth(_currentZoomScale, d).toFixed(3))
    .attr('stroke-opacity', d => EDGE_KIND[getEdgeKind(d)].opacity)
    .attr('stroke-dasharray', d => _edgeKindDash(d) || null);
}

function _applySvgEdgeStrokeScale(scale = _currentZoomScale) {
  if (!gLinks) return;
  const lines = gLinks.node()?.children || [];
  for (let i = 0, len = lines.length; i < len; i++) {
    const el = lines[i];
    const edge = el.__data__;
    el.style.strokeWidth = `${_svgEdgeStrokeWidth(scale, edge).toFixed(3)}px`;
  }
}

function _lineDrawLength(el, edge) {
  try {
    const total = el.getTotalLength();
    if (Number.isFinite(total) && total > 2) return total;
  } catch {}
  const x1 = Number(el.getAttribute('x1'));
  const y1 = Number(el.getAttribute('y1'));
  const x2 = Number(el.getAttribute('x2'));
  const y2 = Number(el.getAttribute('y2'));
  const attrLen = Math.hypot(x2 - x1, y2 - y1);
  if (Number.isFinite(attrLen) && attrLen > 2) return attrLen;
  const sx = Number(edge?.source?.x);
  const sy = Number(edge?.source?.y);
  const tx = Number(edge?.target?.x);
  const ty = Number(edge?.target?.y);
  const dataLen = Math.hypot(tx - sx, ty - sy);
  return Number.isFinite(dataLen) && dataLen > 2 ? dataLen : 0;
}

function _queueEdgeConnectAnimation(selection) {
  if (!selection || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  selection
    .classed('edge-connect-pending', true)
    .each(function() { _pendingEdgeConnectLines.add(this); });
  if (_edgeConnectRaf) return;
  _edgeConnectRaf = requestAnimationFrame(() => {
    _edgeConnectRaf = requestAnimationFrame(_runEdgeConnectAnimation);
  });
}

function _finishEdgeConnect(el, edge, finalMarker, finalStrokeWidth = null) {
  if (!el?.isConnected) return;
  const finalDash = _edgeKindDash(edge);
  el.classList.remove('edge-connecting', 'edge-connect-pending');
  el.style.transition = '';
  el.style.strokeDasharray = '';
  el.style.strokeDashoffset = '';
  if (Number.isFinite(finalStrokeWidth)) {
    el.style.strokeWidth = `${finalStrokeWidth.toFixed(3)}px`;
  }
  if (finalDash) el.setAttribute('stroke-dasharray', finalDash);
  else el.removeAttribute('stroke-dasharray');
  if (finalMarker) el.setAttribute('marker-end', finalMarker);
}

function _runEdgeConnectAnimation() {
  _edgeConnectRaf = null;
  const lines = Array.from(_pendingEdgeConnectLines).filter(el => el?.isConnected);
  _pendingEdgeConnectLines.clear();
  lines.forEach((el, i) => {
    const edge = el.__data__;
    const len = _lineDrawLength(el, edge);
    if (!len) {
      el.classList.remove('edge-connect-pending');
      return;
    }
    const finalMarker = el.getAttribute('marker-end') || '';
    const finalStrokeWidth = _svgEdgeStrokeWidth(_currentZoomScale, edge);
    const duration = 720;
    const delay = Math.min(i * 9, 320);
    el.classList.remove('edge-connect-pending');
    el.classList.add('edge-connecting');
    el.style.transition = 'none';
    el.style.strokeDasharray = `${len} ${len}`;
    el.style.strokeDashoffset = `${len}`;
    el.style.strokeWidth = `${SVG_EDGE_CONNECT_START_STROKE.toFixed(3)}px`;
    el.setAttribute('marker-end', '');
    void el.getBoundingClientRect();
    window.setTimeout(() => {
      if (!el.isConnected) return;
      el.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(.2,.8,.2,1), stroke-width ${duration}ms cubic-bezier(.2,.8,.2,1), opacity 220ms ease`;
      el.style.strokeDashoffset = '0';
      el.style.strokeWidth = `${finalStrokeWidth.toFixed(3)}px`;
      window.setTimeout(() => _finishEdgeConnect(el, edge, finalMarker, finalStrokeWidth), duration + 80);
    }, delay);
  });
}

// Scales node radius by how much information lives on the node: each aspect
// contributes a base unit, each attribute a fraction. A small importance bump
// keeps high-importance seed nodes visible even when sparse, and a log-shape
// scaling keeps 40-attribute giants from swallowing the graph.
function _computeNodeRadius(n) {
  if (n?.extra?.aggregate) {
    const memberCount = Number(n.extra.memberCount ?? n.mentions ?? 0);
    return Math.max(22, Math.min(74, 20 + Math.log1p(Math.max(0, memberCount)) * 4));
  }
  const aspects = Array.isArray(n?.aspects) ? n.aspects : [];
  let aspectCount = Number(n?.aspectCount ?? n?.aspect_count);
  if (!Number.isFinite(aspectCount)) aspectCount = aspects.length;
  let attrCount = Number(n?.attributeCount ?? n?.attribute_count);
  if (!Number.isFinite(attrCount)) {
    attrCount = 0;
    for (const a of aspects) attrCount += Array.isArray(a.attributes) ? a.attributes.length : 0;
  }
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

function _graphNodeCreatedMs(node) {
  const raw = node?.created ?? node?.created_at ?? node?.createdAt ?? null;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return raw > 0 && raw < 1e12 ? raw * 1000 : raw;
  }
  const str = String(raw).trim();
  if (!str) return null;
  const norm = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
  const t = Date.parse(norm);
  return Number.isFinite(t) ? t : null;
}

function _refreshTypeFilterOptions(nodes = graphData?.nodes || []) {
  const filterEl = document.getElementById('filter-type');
  if (!filterEl) return;
  const prior = filterEl.value || window._graphFilterState?.typeFilter || '';
  const types = [...new Set(nodes.map(n => n.type).filter(Boolean))].sort();
  filterEl.innerHTML = '<option value="">all types</option>';
  types.forEach(t => {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    filterEl.appendChild(o);
  });
  if (prior && types.includes(prior)) {
    filterEl.value = prior;
  } else {
    filterEl.value = '';
    if (window._graphFilterState) window._graphFilterState.typeFilter = '';
  }
}

function _refreshActiveGraphFilters() {
  if (typeof window._tlfRefresh === 'function') {
    window._tlfRefresh();
  } else if (typeof window._applyGraphFilters === 'function') {
    window._applyGraphFilters();
  }
}

function mergeGraph(newData, anims) {
  _lastSvgLabelLayoutKey = '';
  _beginSvgLabelRefresh();
  const usesSharedLayout = _graphUsesSharedLayout(newData) || _graphUsesSharedLayout(graphData);
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
      n.importance = fresh.importance;
      n.aspectCount = Number(fresh.aspectCount ?? fresh.aspect_count ?? n.aspectCount ?? 0) || 0;
      n.attributeCount = Number(fresh.attributeCount ?? fresh.attribute_count ?? n.attributeCount ?? 0) || 0;
      if (!n._detailsLoaded || (fresh.aspects || []).length) n.aspects = fresh.aspects;
      if (!n._detailsLoaded || (fresh.aliases || []).length) n.aliases = fresh.aliases;
      if (fresh._detailsLoaded) n._detailsLoaded = true;
      n.mentions = fresh.mentions; n.created = fresh.created; n.updated = fresh.updated;
      n.extra = fresh.extra;
      n.radius = _computeNodeRadius(n);
      if (!_graphNodeHasApiPosition(n) && _graphNodeHasApiPosition(fresh)) {
        n.x = Number(fresh.x);
        n.y = Number(fresh.y);
        n.vx = 0;
        n.vy = 0;
      }
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
    if (_graphNodeHasApiPosition(n)) {
      n.x = Number(n.x);
      n.y = Number(n.y);
      n.vx = 0;
      n.vy = 0;
    } else if (posMap[n.id]?.x != null && posMap[n.id]?.y != null) {
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
  graphData.meta = newData.meta || graphData.meta || {};
  graphData.graph = newData.graph || graphData.graph || null;
  if (graphData.meta?.mode) _setGraphViewState(graphData.meta.requestedMode || graphData.meta.mode, graphData.meta.root || null);
  simLinks = newLinks;

  const structuralChange = addedNodes.length > 0 || removedIds.length > 0;

  // Re-tune forces for current graph size
  const nodeCount = graphData.nodes.length;
  const profile = _graphForceProfile(nodeCount);
  const forceCanvasEl = document.getElementById('canvas');
  const forceWidth = forceCanvasEl?.clientWidth || window.innerWidth;
  const forceHeight = forceCanvasEl?.clientHeight || window.innerHeight;
  simulation.nodes(graphData.nodes);
  simulation.force('link').links(simLinks);
  if (usesSharedLayout) {
    simulation.force('charge').strength(0);
    simulation.force('link').distance(1).strength(0);
    simulation.force('clusterX').strength(0);
    simulation.force('clusterY').strength(0);
    simulation.force('collision').strength(0);
    simulation.stop().alpha(0.0009);
    _scheduleTickRender();
  } else {
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
    if (structuralChange) {
      simulation.alpha(profile.refreshAlpha).restart();
    } else {
      _scheduleTickRender();
    }
  }

  // Re-bindD3 selections
  const link = gLinks.selectAll('line').data(simLinks, d => `${d.source.id}-${d.target.id}-${d.type}`);
  link.exit().remove();
  const linkEnter = link.enter().append('line');
  if (anims) {
    linkEnter.each(function(d) {
      const isNew = anims.newEdges.some(e => e.source === d.source.id && e.target === d.target.id);
      if (isNew) d3.select(this).classed('edge-new', true);
    });
  }
  const allLinks = linkEnter.merge(link);
  _styleGraphLinks(allLinks);
  _applySvgEdgeStrokeScale(_currentZoomScale);
  _scheduleTickRender();
  if (!graphData?.meta?.hybridSubset && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    const structuralIds = new Set(addedNodes.map(n => n.id));
    const animatedLinks = structuralIds.size
      ? allLinks.filter(d => structuralIds.has(d.source.id) || structuralIds.has(d.target.id))
      : linkEnter;
    _queueEdgeConnectAnimation(animatedLinks);
  }

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
    .on('dblclick', (e, d) => {
      e.stopPropagation();
      e.preventDefault();
      if ((graphData?.meta?.mode || window._graphViewState?.mode) === 'overview') loadGraphMode('slice', d.id);
      else _enterGraphStructureFocus(d.id);
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

  const allNodes = nodeEnter.merge(nodeG)
    .classed('graph-node', true)
    .classed('hybrid-context-node', d => !!d.extra?.hybridContext)
    .attr('data-node-id', d => d.id);
  _upsertNodeVisuals(allNodes);

  simulation.on('tick', _scheduleTickRender);

  // Apply semantic zoom to newly added nodes
  _applySemanticZoom(_currentZoomScale);

  // Update stats
  _refreshTypeFilterOptions(graphData.nodes);
  updateStats();
  _refreshActiveGraphFilters();
  _saveGraphLayout(graphData);
  _scheduleViewportCulling(true);

  if (anims) {
    setTimeout(() => {
      allNodes.classed('node-new', false).classed('node-pulse', false).classed('node-accessed', false);
      allLinks.classed('edge-new', false);
    }, 1400);
  }

  _restoreGraphSelection();
  _refreshCurrentAltView();
  _finishSvgLabelRefresh();
}

function updateStats() {
  const meta = graphData.meta || {};
  const mode = meta.mode || window._graphViewState?.mode || 'full';
  const requestedMode = meta.requestedMode || window._graphViewState?.mode || mode;
  const isAggregateOverview = mode === 'overview' && !!meta.aggregated;
  const isWebgl = mode === 'webgl';
  const loadedTypeCounts = {};
  graphData.nodes.forEach(n => { loadedTypeCounts[n.type] = (loadedTypeCounts[n.type] || 0) + 1; });
  const legendEntries = (isAggregateOverview || isWebgl) && Array.isArray(meta.typeCounts)
    ? meta.typeCounts.map(row => [row.type || 'unknown', row.count || 0])
    : Object.entries(loadedTypeCounts);
  const legendItems = legendEntries.sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const color = TYPE_COLORS[type] || DEFAULT_COLOR;
      return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:10px">` +
        _legendNodeChip(type, color) +
        `<span>${type}</span><span style="opacity:0.5">${count}</span></span>`;
    }).join('');
  const typeCount = legendEntries.length || Object.keys(loadedTypeCounts).length;
  const statsEl = document.getElementById('stats');
  const totalNodes = meta.nodeCount ?? graphData.nodes.length;
  const displayedNodes = meta.displayedNodeCount ?? graphData.nodes.length;
  const displayedEdges = meta.displayedEdgeCount ?? graphData.webglEdges?.length ?? graphData.edges.length;
  const totalEdges = meta.edgeCount ?? displayedEdges;
  const representedNodes = meta.representedNodeCount ?? totalNodes;
  const representedEdges = meta.representedEdgeCount ?? totalEdges;
  const comparisonNodes = (isAggregateOverview || isWebgl) ? displayedNodes : representedNodes;
  const comparisonEdges = (isAggregateOverview || isWebgl) ? displayedEdges : totalEdges;
  const dedupedEdgeCount = Number(meta.dedupedEdgeCount || 0);
  const comparableDisplayedEdges = displayedEdges + dedupedEdgeCount;
  const isTruncated = !!meta.truncated || (!isAggregateOverview && !isWebgl && (displayedNodes < comparisonNodes || comparableDisplayedEdges < comparisonEdges));
  const selectedId = selectedNodeIds?.size === 1 ? [...selectedNodeIds][0] : '';
  const modeLabel = isWebgl
    ? (requestedMode === 'auto' ? 'auto: webgl' : 'webgl')
    : (mode === 'slice' && meta.sliceKind === 'type'
      ? `type slice: ${esc(meta.rootType || meta.root)}`
      : (mode === 'slice' && meta.root
        ? `slice: ${esc(meta.root)}`
        : (requestedMode === 'auto' ? 'auto: svg' : mode)));
  const modeActions = [
    requestedMode !== 'auto' ? `<button type="button" data-graph-mode="auto">auto</button>` : '',
    !isWebgl && Number(totalNodes) > Number(meta.autoRendererThreshold || 1800) ? `<button type="button" data-graph-mode="webgl">webgl</button>` : '',
    isWebgl && Number(totalNodes) <= Number(meta.autoRendererThreshold || 1800) ? `<button type="button" data-graph-mode="full">svg</button>` : '',
    selectedId ? `<button type="button" data-graph-mode="slice" data-root="${escAttr(selectedId)}">expand</button>` : '',
    mode === 'slice' ? `<button type="button" data-graph-mode="auto">all</button>` : '',
  ].filter(Boolean).join('');
  const renderedLabel = isWebgl
    ? `webgl rendering ${Number(displayedNodes).toLocaleString()} nodes · ${Number(displayedEdges).toLocaleString()} edges`
    : _lastCullStats.totalNodes
    ? `rendering ${_lastCullStats.nodes.toLocaleString()} nodes · ${_lastCullStats.edges.toLocaleString()} edges`
    : `rendering ${displayedNodes.toLocaleString()} nodes · ${displayedEdges.toLocaleString()} edges`;
  const loadedLabel = isAggregateOverview
    ? `represents ${Number(representedNodes).toLocaleString()} nodes as ${displayedNodes.toLocaleString()} groups`
    : isWebgl
    ? `loaded ${displayedNodes.toLocaleString()} of ${Number(representedNodes).toLocaleString()} nodes`
    : isTruncated
    ? `loaded ${displayedNodes.toLocaleString()} of ${Number(representedNodes).toLocaleString()}`
    : `loaded ${displayedNodes.toLocaleString()}`;
  const summaryLine = isAggregateOverview
    ? `${displayedNodes.toLocaleString()} groups / ${Number(representedNodes).toLocaleString()} nodes · ${displayedEdges.toLocaleString()} group links / ${Number(representedEdges).toLocaleString()} edges · ${typeCount} types`
    : isWebgl
    ? `${displayedNodes.toLocaleString()} / ${Number(representedNodes).toLocaleString()} nodes · ${displayedEdges.toLocaleString()} / ${Number(representedEdges).toLocaleString()} edges · ${typeCount} types`
    : (mode === 'slice' && meta.sliceKind === 'type'
      ? `${displayedNodes.toLocaleString()} / ${Number(representedNodes).toLocaleString()} ${esc(meta.rootType || 'type')} nodes · ${displayedEdges.toLocaleString()} loaded edges · ${typeCount} loaded types`
      : `${displayedNodes.toLocaleString()} / ${Number(totalNodes).toLocaleString()} nodes · ${displayedEdges.toLocaleString()} / ${Number(totalEdges).toLocaleString()} edges · ${typeCount} types`);
  const showPerformanceLine = _graphNodePerformanceMetricVizEnabled();
  const modeActionsHtml = modeActions ? `<span class="graph-mode-actions">${modeActions}</span>` : '';
  statsEl.innerHTML =
    `<div class="stats-line" id="stats-toggle" title="Toggle type breakdown">` +
      `<span class="stats-chevron">▸</span>` +
      `<span>${summaryLine}</span>` +
      (!showPerformanceLine ? modeActionsHtml : '') +
    `</div>` +
    (showPerformanceLine
      ? `<div class="graph-mode-line" data-truncated="${isTruncated ? 'true' : 'false'}">` +
          `<span>${modeLabel}</span>` +
          `<span>${loadedLabel}</span>` +
          `<span id="graph-rendered-count">${renderedLabel}</span>` +
          modeActionsHtml +
        `</div>`
      : '') +
    `<div id="stats-legend">${legendItems}</div>`;
  document.getElementById('stats-toggle').addEventListener('click', () => {
    statsEl.classList.toggle('stats-open');
  });
  statsEl.querySelectorAll('[data-graph-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadGraphMode(btn.dataset.graphMode, btn.dataset.root || null);
    });
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
  if (_graphUsesSharedLayout(graphData)) {
    if (_dragRestartTimer) { clearTimeout(_dragRestartTimer); _dragRestartTimer = null; }
    if (_dragDecayTimer) { clearTimeout(_dragDecayTimer); _dragDecayTimer = null; }
    _parkSharedLayoutSimulation(graphData);
    _scheduleTickRender();
    _scheduleLabelLayout(true);
    return;
  }
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

function _syncHybridSourceNodePosition(node) {
  if (_graphFocusedId) return;
  if (!node?.id || !_hybridFullWebglData?.nodes) return;
  const x = Number(node.x);
  const y = Number(node.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const sourceNode = _hybridFullWebglData.nodes.find(n => n?.id === node.id);
  if (sourceNode) {
    sourceNode.x = x;
    sourceNode.y = y;
  }
  const idx = _webglGraph?.idToIndex?.get?.(node.id);
  if (idx != null && _webglGraph?.layout) {
    _webglGraph.layout.x[idx] = x;
    _webglGraph.layout.y[idx] = y;
  }
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
  _syncHybridSourceNodePosition(d);
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
    if (_graphFocusedId) {
      d.fx = null;
      d.fy = null;
      _scheduleTickRender();
    } else {
      _localResettle(cx, cy);
    }
    _scheduleLabelLayout(true);
  }
  _syncHybridSourceNodePosition(d);
  if (!_graphFocusedId) _saveGraphLayout(graphData);

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
      const r = await fetch(graphApiUrl('/api/graph/merge'), {
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
      const r = await fetch(graphApiUrl('/api/graph/merge'), {
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
const _eventLog = [];           // { ts, op, detail, source, graph, html }
let _eventLogIdleTimer = null;
let _eventLogSaveTimer = null;
let _eventLogStatusTimer = null;

function _eventLogPersist() {
  // Debounced — bursts of 50 events don't hammer localStorage.
  if (_eventLogSaveTimer) return;
  _eventLogSaveTimer = setTimeout(() => {
    _eventLogSaveTimer = null;
    try {
      const plain = _eventLog.map(e => ({ ts: e.ts, op: e.op, detail: e.detail, source: e.source, graph: e.graph }));
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
        graph: String(e.graph || ''),
        html: null,
      });
    }
    while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  } catch {}
}

function _eventLogGraphLabel(evt) {
  let graph = '';
  if (Array.isArray(evt?.graphs) && evt.graphs.length) {
    graph = evt.graphs.filter(Boolean).map(String).join(', ');
  } else if (evt?.graph || evt?.graphSlug || evt?.slug) {
    graph = String(evt.graph || evt.graphSlug || evt.slug);
  }
  if (!graph) return '';
  const name = evt?.graphName ? String(evt.graphName) : '';
  if (name && name !== graph && !graph.includes(',')) return `${name} [${graph}]`;
  return graph;
}

function _eventLogFormat(evt) {
  const op = String(evt?.op || 'event');
  const source = String(evt?.source || '');
  const graph = _eventLogGraphLabel(evt);
  let detail = '';
  if (evt?.node?.id) detail = evt.node.id;
  else if (evt?.nodeId) detail = evt.nodeId;
  else if (Array.isArray(evt?.nodeIds) && evt.nodeIds.length) detail = `${evt.nodeIds.length} nodes`;
  else if (evt?.edge) detail = `${evt.edge.source} → ${evt.edge.target}`;
  else if (evt?.tool) detail = evt.tool;
  else if (evt?.attributeId) detail = `attr#${evt.attributeId}`;
  else if (evt?.aspectId) detail = `aspect#${evt.aspectId}`;
  else if (evt?.detail) detail = String(evt.detail).slice(0, 120); // generic carrier for read-path events (recall, scan, etc.)
  return { op, detail, source, graph };
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
  if (entry.graph) bits.push(`<span class="ev-graph">graph:${esc(entry.graph)}</span>`);
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

function setEventLogStatus(status) {
  const widget = document.getElementById('event-log');
  if (!widget) return;
  let row = document.getElementById('event-log-status');
  if (!row) {
    row = document.createElement('div');
    row.id = 'event-log-status';
    const stack = document.getElementById('event-log-stack');
    widget.insertBefore(row, stack || widget.firstChild);
  }

  const text = typeof status === 'string' ? status : (status?.detail || '');
  if (!text) {
    widget.classList.remove('has-status');
    row.innerHTML = '';
    if (_eventLogStatusTimer) { clearTimeout(_eventLogStatusTimer); _eventLogStatusTimer = null; }
    if (!_eventLogIdleTimer) widget.classList.remove('has-activity');
    return;
  }

  const op = typeof status === 'object' && status?.op ? String(status.op) : 'chat';
  const source = typeof status === 'object' && status?.source ? String(status.source) : '';
  const graph = typeof status === 'object' ? _eventLogGraphLabel(status) : '';
  row.innerHTML = _eventLogRowHtml({ op, detail: String(text).slice(0, 140), source, graph });
  widget.classList.add('has-status', 'has-activity');
  if (_eventLogStatusTimer) clearTimeout(_eventLogStatusTimer);
  _eventLogStatusTimer = setTimeout(() => {
    const w = document.getElementById('event-log');
    if (w && !w.classList.contains('has-status')) w.classList.remove('has-activity');
  }, EVENT_LOG_COLLAPSE_MS);
}
window.setEventLogStatus = setEventLogStatus;

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
  _eventLogStack.push({ op: entry.op, detail: entry.detail, source: entry.source, graph: entry.graph });
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
        ${e.graph ? `<span class="ev-graph">graph:${esc(e.graph)}</span>` : ''}
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
    graph: formatted.graph,
    html: null,
  };
  _eventLog.push(entry);
  while (_eventLog.length > EVENT_LOG_MAX) _eventLog.shift();
  _eventLogBumpStack({ op: formatted.op, detail: formatted.detail, source: formatted.source, graph: formatted.graph });
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
  const visualScale = _svgSemanticVisualScale(_currentZoomScale);
  const zoomScale = Math.max(1, Number(_currentZoomScale) || 1);
  for (let i = 0, len = linkEls.length; i < len; i++) {
    const el = linkEls[i];
    if (el.dataset.culled === 'true') continue;
    const d = el.__data__;
    if (!d || !d.source || !d.target) continue;
    const dx = d.target.x - d.source.x;
    const dy = d.target.y - d.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const tr = ((d.target.radius || 12) * visualScale) + (2 / zoomScale);
    el.setAttribute('x1', d.source.x);
    el.setAttribute('y1', d.source.y);
    el.setAttribute('x2', d.target.x - dx * tr / dist);
    el.setAttribute('y2', d.target.y - dy * tr / dist);
  }

  const nodeEls = gNodes.node().children;
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const el = nodeEls[i];
    if (el.dataset.culled === 'true') continue;
    const d = el.__data__;
    if (!d) continue;
    el.setAttribute('transform', `translate(${d.x},${d.y})`);
  }

  _updateFocusEdgeLabels();
  _scheduleViewportCulling();
  _scheduleLabelLayout();
}

function _svgSemanticVisualScale(scale = _currentZoomScale) {
  const k = Math.max(0.001, Number(scale) || 1);
  if (k <= 1) return 1;
  return Math.max(0.14, Math.min(1, Math.pow(k, -0.72)));
}

function _svgLabelCounterScale(scale = _currentZoomScale) {
  return Math.max(1, Math.min(10, Number(scale) || 1));
}

function _svgLabelText(node) {
  return typeof _nodeLabelText === 'function'
    ? _nodeLabelText(node)
    : String(node?.label || node?.id || '');
}

function _svgLabelMetrics(node, scale = _currentZoomScale) {
  const counterScale = _svgLabelCounterScale(scale);
  const screenWidth = Math.min(Math.max(_svgLabelText(node).length * 6.1, 18), 150);
  const screenHeight = 12;
  return {
    localWidth: screenWidth / counterScale,
    localHeight: screenHeight / counterScale,
    width: screenWidth,
    height: screenHeight,
  };
}

function _svgSemanticLabelPlacement(node, scale, metrics) {
  const counterScale = _svgLabelCounterScale(scale);
  const visualScale = _svgSemanticVisualScale(scale);
  const gap = ((node?.radius || 12) * visualScale) + (5 / counterScale);
  const y = gap + (metrics.localHeight / 2);
  return {
    attrs: { x: 0, y, anchor: 'middle', baseline: 'middle' },
    box: {
      left: -(metrics.localWidth / 2),
      right: metrics.localWidth / 2,
      top: gap,
      bottom: gap + metrics.localHeight,
    },
  };
}

function _svgLabelBudget(baseBudget, candidateCount) {
  const svgNode = svg?.node?.();
  const width = svgNode?.clientWidth || window.innerWidth || 900;
  const height = svgNode?.clientHeight || window.innerHeight || 700;
  const screenArea = Math.max(1, width * height);
  const hybrid = !!graphData?.meta?.hybridSubset;
  const packing = hybrid ? 7 : 5;
  const areaBudget = Math.floor(screenArea / (SVG_LABEL_SCREEN_FONT_PX * 19 * packing));
  const scale = Math.max(0.001, Number(_currentZoomScale) || 1);
  const hardCap = hybrid ? 36 : (scale > 2.6 ? 96 : (scale > 1.4 ? 72 : 48));
  return Math.max(0, Math.min(baseBudget, candidateCount, hardCap, Math.max(8, areaBudget)));
}

function _applySvgSemanticVisualScale(scale = _currentZoomScale) {
  if (!gNodes) return;
  const visualScale = _svgSemanticVisualScale(scale);
  const transform = Math.abs(visualScale - 1) < 0.001 ? null : `scale(${visualScale.toFixed(4)})`;
  const selectors = [
    '.node-shape',
    '.node-focus-halo',
    '.self-spoke',
    '.self-halo',
    '.self-petal',
    '.self-center',
  ];
  const nodeEls = gNodes.node()?.children || [];
  for (let i = 0, len = nodeEls.length; i < len; i++) {
    const nodeEl = nodeEls[i];
    const parts = nodeEl._semanticVisualParts || (nodeEl._semanticVisualParts = Array.from(nodeEl.querySelectorAll(selectors.join(','))));
    for (const el of parts) {
      if (transform) el.setAttribute('transform', transform);
      else el.removeAttribute('transform');
    }
    const glyph = nodeEl._semanticGlyph || (nodeEl._semanticGlyph = nodeEl.querySelector('text.node-glyph'));
    const d = nodeEl.__data__;
    if (glyph && d) {
      const base = Math.max(6, Math.min((d.radius || 10) * 0.92, 9.5));
      glyph.removeAttribute('transform');
      glyph.setAttribute('x', '0');
      glyph.setAttribute('y', `${(1 * visualScale).toFixed(3)}`);
      glyph.setAttribute('font-size', `${(base * visualScale).toFixed(3)}px`);
      glyph.setAttribute('text-anchor', 'middle');
      glyph.setAttribute('dominant-baseline', 'middle');
    }
  }
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
    el,
    data: el.__data__,
    labelEl: el._nodeLabelEl || (el._nodeLabelEl = el.querySelector('text.node-label')),
    subEl:   el._nodeSubLabelEl || (el._nodeSubLabelEl = el.querySelector('text.node-sub-label')),
  })).filter((entry) => entry.data && entry.labelEl && entry.el.dataset.culled !== 'true');
  const passesFilters = (typeof window._isNodeVisible === 'function')
    ? window._isNodeVisible
    : () => true;
  const labelCandidates = nodes.filter(entry => passesFilters(entry.data));

  // Only show as many labels as the current zoom can support without
  // visual collision pile-up. Importance-ranked: most important nodes first,
  // hovered/selected always shown.
  const budget = _svgLabelBudget(_autoLabelBudget(scale, labelCandidates.length), labelCandidates.length);
  const opacity = _autoLabelOpacity(scale);
  const labelCounterScale = _svgLabelCounterScale(scale);
  const labelFontSize = SVG_LABEL_SCREEN_FONT_PX / labelCounterScale;
  const subLabelFontSize = SVG_SUB_LABEL_SCREEN_FONT_PX / labelCounterScale;
  const showSubLabels = scale >= 2.15;

  const ranked = labelCandidates.slice().sort((a, b) => {
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
  const layoutKey = [
    Math.round(scale * 20),
    budget,
    _lastCullStats.nodes,
    labelCandidates.length,
    hoveredNodeId || '',
    selectedNodeIds ? Array.from(selectedNodeIds).sort().join(',') : '',
    Array.from(visible).sort().join(',')
  ].join('|');
  if (layoutKey === _lastSvgLabelLayoutKey) return;
  _lastSvgLabelLayoutKey = layoutKey;

  for (const entry of nodes) {
    if (!passesFilters(entry.data)) {
      _setLabelHidden(entry.labelEl);
      if (entry.subEl) {
        entry.subEl.style.display = 'none';
        entry.subEl.style.opacity = '0';
      }
      continue;
    }
    if (visible.has(entry.data.id)) {
      const metrics = _svgLabelMetrics(entry.data, scale);
      const placement = _svgSemanticLabelPlacement(entry.data, scale, metrics);
      entry.labelEl.setAttribute('font-size', `${labelFontSize.toFixed(3)}px`);
      _setLabelPlacement(entry.labelEl, placement);
      _setLabelVisible(entry.labelEl, opacity);
      // Stack the mono uppercase sub-label one line below the name with
      // matching anchor + baseline. ~1em (12px) below.
      if (entry.subEl) {
        const selectedOrHovered = entry.data.id === hoveredNodeId || selectedNodeIds?.has?.(entry.data.id);
        if (showSubLabels || selectedOrHovered) {
          entry.subEl.style.removeProperty('display');
          entry.subEl.setAttribute('font-size', `${subLabelFontSize.toFixed(3)}px`);
          entry.subEl.setAttribute('x', placement.attrs.x);
          entry.subEl.setAttribute('y', Number(placement.attrs.y) + ((SVG_LABEL_SCREEN_FONT_PX + 2) / labelCounterScale));
          entry.subEl.setAttribute('text-anchor', placement.attrs.anchor);
          entry.subEl.setAttribute('dominant-baseline', placement.attrs.baseline);
          entry.subEl.style.opacity = String(Math.max(0, Math.min(1, opacity * 0.85)));
        } else {
          entry.subEl.style.display = 'none';
          entry.subEl.style.opacity = '0';
        }
      }
    } else {
      _setLabelHidden(entry.labelEl);
      if (entry.subEl) {
        entry.subEl.style.display = 'none';
        entry.subEl.style.opacity = '0';
      }
    }
  }
}

function _applySemanticZoom(scale) {
  if (!gNodes) return;
  const showGlyphs = scale > 0.14;
  const showArrows = scale > 0.25;
  _applySvgSemanticVisualScale(scale);
  _applySvgEdgeStrokeScale(scale);
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

// ── WebGL all-node renderer ──
function _destroyWebglGraph() {
  const state = _webglGraph;
  _webglGraph = null;
  if (_webglResizeCommitTimer) {
    clearTimeout(_webglResizeCommitTimer);
    _webglResizeCommitTimer = null;
  }
  if (state?.raf) cancelAnimationFrame(state.raf);
  if (state?.cleanup) {
    for (const fn of state.cleanup) {
      try { fn(); } catch {}
    }
  }
  const canvas = document.getElementById('graph-webgl');
  if (canvas) canvas.style.display = 'none';
  document.getElementById('canvas')?.classList.remove('webgl-active');
}

function _hash32(value) {
  let h = 2166136261;
  const str = String(value || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _hashUnit(value, salt = 0) {
  return ((_hash32(`${value}:${salt}`) >>> 0) / 4294967295);
}

function _webglColorFromCss(value, fallback = [0.6, 0.58, 0.5]) {
  const raw = String(value || '').trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let s = hex[1];
    if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
    return [
      parseInt(s.slice(0, 2), 16) / 255,
      parseInt(s.slice(2, 4), 16) / 255,
      parseInt(s.slice(4, 6), 16) / 255,
    ];
  }
  const rgb = raw.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(',').map(v => Number(v.trim()));
    if (parts.length >= 3 && parts.every((v, i) => i >= 3 || Number.isFinite(v))) {
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
    }
  }
  return fallback;
}

function _webglCompile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(shader) || 'shader compile failed';
    gl.deleteShader(shader);
    throw new Error(msg);
  }
  return shader;
}

function _webglProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vs = _webglCompile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = _webglCompile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const msg = gl.getProgramInfoLog(program) || 'program link failed';
    gl.deleteProgram(program);
    throw new Error(msg);
  }
  return program;
}

function _webglBuildLayout(data) {
  const nodes = data.nodes || [];
  const rawEdges = data.webglEdges || data.edges || [];
  const nodeCount = nodes.length;
  const edgeCount = rawEdges.length;
  const x = new Float32Array(nodeCount);
  const y = new Float32Array(nodeCount);
  const anchorX = new Float32Array(nodeCount);
  const anchorY = new Float32Array(nodeCount);
  const src = new Uint32Array(edgeCount);
  const dst = new Uint32Array(edgeCount);
  const hasApiLayout = nodeCount > 0 && nodes.every(_graphNodeHasApiPosition);
  for (let i = 0; i < edgeCount; i++) {
    const edge = rawEdges[i] || [];
    src[i] = edge[0] >>> 0;
    dst[i] = edge[1] >>> 0;
  }
  if (hasApiLayout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const typeStats = new Map();
    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i];
      const px = Number(node.x);
      const py = Number(node.y);
      x[i] = px;
      y[i] = py;
      anchorX[i] = px;
      anchorY[i] = py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      const type = node.type || 'unknown';
      let stat = typeStats.get(type);
      if (!stat) {
        stat = { type, x: 0, y: 0, count: 0 };
        typeStats.set(type, stat);
      }
      stat.x += px;
      stat.y += py;
      stat.count++;
    }
    if (!Number.isFinite(minX)) {
      minX = -1; minY = -1; maxX = 1; maxY = 1;
    }
    const typeAnchors = Array.from(typeStats.values())
      .map(stat => ({
        type: stat.type,
        x: stat.x / Math.max(1, stat.count),
        y: stat.y / Math.max(1, stat.count),
        count: stat.count,
      }))
      .sort((a, b) => (b.count - a.count) || String(a.type).localeCompare(String(b.type)));
    return { x, y, src, dst, typeAnchors, bounds: { minX, minY, maxX, maxY }, source: 'api' };
  }

  const typeList = [...new Set(nodes.map(n => n.type || 'unknown'))].sort();
  const typeIndex = new Map(typeList.map((type, index) => [type, index]));
  const typeCounts = new Map();
  for (const n of nodes) typeCounts.set(n.type || 'unknown', (typeCounts.get(n.type || 'unknown') || 0) + 1);
  const cols = Math.max(1, Math.ceil(Math.sqrt(typeList.length || 1)));
  const rows = Math.max(1, Math.ceil((typeList.length || 1) / cols));
  const typeSpacing = Math.max(130, Math.min(260, Math.sqrt(Math.max(1, nodeCount)) * 0.72));
  const clusterSpread = typeSpacing * 0.22;
  const typeAnchors = typeList.map((type, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      type,
      x: (col - (cols - 1) / 2) * typeSpacing,
      y: (row - (rows - 1) / 2) * typeSpacing,
      count: typeCounts.get(type) || 0,
    };
  });

  for (let i = 0; i < nodeCount; i++) {
    const n = nodes[i];
    const type = n.type || 'unknown';
    const ti = typeIndex.get(type) || 0;
    const col = ti % cols;
    const row = Math.floor(ti / cols);
    const typeX = (col - (cols - 1) / 2) * typeSpacing;
    const typeY = (row - (rows - 1) / 2) * typeSpacing;
    const clusterKey = n.cluster == null ? `type:${n.type || 'unknown'}` : `cluster:${n.cluster}`;
    const clusterAngle = _hashUnit(clusterKey, 1) * Math.PI * 2;
    const clusterRadius = Math.sqrt(_hashUnit(clusterKey, 2)) * clusterSpread;
    const localAngle = _hashUnit(n.id, 3) * Math.PI * 2;
    const localRadius = Math.sqrt(_hashUnit(n.id, 4)) * (n.cluster == null ? typeSpacing * 0.1 : 9);
    const cx = typeX + Math.cos(clusterAngle) * clusterRadius;
    const cy = typeY + Math.sin(clusterAngle) * clusterRadius;
    anchorX[i] = cx;
    anchorY[i] = cy;
    x[i] = cx + Math.cos(localAngle) * localRadius;
    y[i] = cy + Math.sin(localAngle) * localRadius;
  }

  const iterations = nodeCount > 180000 ? 5 : (nodeCount > 80000 ? 8 : 12);
  for (let iter = 0; iter < iterations; iter++) {
    const anchorPull = 0.012 + iter * 0.001;
    for (let i = 0; i < nodeCount; i++) {
      x[i] += (anchorX[i] - x[i]) * anchorPull;
      y[i] += (anchorY[i] - y[i]) * anchorPull;
    }
    const edgePull = 0.0038;
    for (let i = 0; i < edgeCount; i++) {
      const s = src[i];
      const t = dst[i];
      const dx = (x[t] - x[s]) * edgePull;
      const dy = (y[t] - y[s]) * edgePull;
      x[s] += dx; y[s] += dy;
      x[t] -= dx; y[t] -= dy;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < nodeCount; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  if (!Number.isFinite(minX)) {
    minX = -1; minY = -1; maxX = 1; maxY = 1;
  }
  return { x, y, src, dst, typeAnchors, bounds: { minX, minY, maxX, maxY } };
}

function _webglShapeIdForType(type) {
  const shape = (typeof getNodeVisual === 'function' ? getNodeVisual(type)?.shape : null) || 'circle';
  if (shape === 'square' || shape === 'rounded-square') return 1;
  if (shape === 'diamond') return 2;
  if (shape === 'triangle') return 3;
  if (shape === 'hexagon' || shape === 'octagon') return 4;
  if (shape === 'pentagon' || shape === 'shield') return 5;
  if (shape === 'pill') return 6;
  return 0;
}

function _webglInitBuffers(state) {
  const { gl, data, layout } = state;
  const nodes = data.nodes || [];
  const rawEdges = data.webglEdges || [];
  const nodeCount = nodes.length;
  const edgeCount = rawEdges.length;

  const nodePos = new Float32Array(nodeCount * 2);
  const nodeColor = new Float32Array(nodeCount * 3);
  const nodeSize = new Float32Array(nodeCount);
  const nodeAlpha = new Float32Array(nodeCount);
  const nodeShape = new Float32Array(nodeCount);
  state.idToIndex = new Map();
  for (let i = 0; i < nodeCount; i++) {
    state.idToIndex.set(nodes[i].id, i);
    nodePos[i * 2] = layout.x[i];
    nodePos[i * 2 + 1] = layout.y[i];
    const c = _webglColorFromCss(getColor(nodes[i].type), [0.55, 0.53, 0.46]);
    nodeColor[i * 3] = c[0];
    nodeColor[i * 3 + 1] = c[1];
    nodeColor[i * 3 + 2] = c[2];
    const imp = Math.max(1, Math.min(10, Number(nodes[i].importance) || 5));
    nodeSize[i] = 9.5 + imp * 0.9;
    nodeAlpha[i] = 0.92;
    nodeShape[i] = _webglShapeIdForType(nodes[i].type);
  }

  const edgePos = new Float32Array(edgeCount * 4);
  const edgeAlpha = new Float32Array(edgeCount * 2);
  for (let i = 0; i < edgeCount; i++) {
    const s = layout.src[i];
    const t = layout.dst[i];
    edgePos[i * 4] = layout.x[s];
    edgePos[i * 4 + 1] = layout.y[s];
    edgePos[i * 4 + 2] = layout.x[t];
    edgePos[i * 4 + 3] = layout.y[t];
    edgeAlpha[i * 2] = 0.08;
    edgeAlpha[i * 2 + 1] = 0.08;
  }

  const makeBuffer = (array, usage = gl.STATIC_DRAW) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, array, usage);
    return buffer;
  };
  state.nodeAlpha = nodeAlpha;
  state.edgeAlpha = edgeAlpha;
  state.labelRank = nodes.map((node, index) => ({ node, index }))
    .sort((a, b) =>
      ((b.node.importance || 0) - (a.node.importance || 0)) ||
      ((b.node.mentions || 0) - (a.node.mentions || 0)) ||
      String(a.node.id).localeCompare(String(b.node.id))
    )
    .map(entry => entry.index);
  state.visibleNodeCount = nodeCount;
  state.visibleEdgeCount = edgeCount;
  state.buffers = {
    nodePos: makeBuffer(nodePos),
    nodeColor: makeBuffer(nodeColor),
    nodeSize: makeBuffer(nodeSize),
    nodeAlpha: makeBuffer(nodeAlpha, gl.DYNAMIC_DRAW),
    nodeShape: makeBuffer(nodeShape),
    edgePos: makeBuffer(edgePos),
    edgeAlpha: makeBuffer(edgeAlpha, gl.DYNAMIC_DRAW),
  };
  state.nodeCount = nodeCount;
  state.edgeVertexCount = edgeCount * 2;
}

function _webglResize(state) {
  const rect = state.canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (state.canvas.width !== width || state.canvas.height !== height) {
    state.canvas.width = width;
    state.canvas.height = height;
  }
  state.dpr = dpr;
  state.cssWidth = Math.max(1, rect.width);
  state.cssHeight = Math.max(1, rect.height);
  state.gl.viewport(0, 0, width, height);
}

function _webglFit(state) {
  _webglResize(state);
  const b = state.layout.bounds;
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const pad = 56;
  const fitScale = Math.min((state.cssWidth - pad * 2) / bw, (state.cssHeight - pad * 2) / bh);
  state.view.scale = Math.max(0.02, fitScale * 0.9);
  state.view.tx = state.cssWidth / 2 - ((b.minX + b.maxX) / 2) * state.view.scale;
  state.view.ty = state.cssHeight / 2 - ((b.minY + b.maxY) / 2) * state.view.scale;
}

function _webglDraw(state, opts = {}) {
  state.raf = null;
  if (!opts.skipResize) _webglResize(state);
  const { gl } = state;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const scale = state.view.scale * state.dpr;
  const tx = state.view.tx * state.dpr;
  const ty = state.view.ty * state.dpr;
  const resolution = [state.canvas.width, state.canvas.height];

  gl.useProgram(state.edgeProgram.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.edgePos);
  gl.enableVertexAttribArray(state.edgeProgram.aPosition);
  gl.vertexAttribPointer(state.edgeProgram.aPosition, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.edgeAlpha);
  gl.enableVertexAttribArray(state.edgeProgram.aAlpha);
  gl.vertexAttribPointer(state.edgeProgram.aAlpha, 1, gl.FLOAT, false, 0, 0);
  gl.uniform2f(state.edgeProgram.uResolution, resolution[0], resolution[1]);
  gl.uniform2f(state.edgeProgram.uTranslate, tx, ty);
  gl.uniform1f(state.edgeProgram.uScale, scale);
  const textColor = _webglColorFromCss(getComputedStyle(document.documentElement).getPropertyValue('--text'), [0.75, 0.72, 0.64]);
  gl.uniform3f(state.edgeProgram.uColor, textColor[0], textColor[1], textColor[2]);
  gl.drawArrays(gl.LINES, 0, state.edgeVertexCount);

  gl.useProgram(state.nodeProgram.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodePos);
  gl.enableVertexAttribArray(state.nodeProgram.aPosition);
  gl.vertexAttribPointer(state.nodeProgram.aPosition, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodeColor);
  gl.enableVertexAttribArray(state.nodeProgram.aColor);
  gl.vertexAttribPointer(state.nodeProgram.aColor, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodeSize);
  gl.enableVertexAttribArray(state.nodeProgram.aSize);
  gl.vertexAttribPointer(state.nodeProgram.aSize, 1, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodeAlpha);
  gl.enableVertexAttribArray(state.nodeProgram.aAlpha);
  gl.vertexAttribPointer(state.nodeProgram.aAlpha, 1, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodeShape);
  gl.enableVertexAttribArray(state.nodeProgram.aShape);
  gl.vertexAttribPointer(state.nodeProgram.aShape, 1, gl.FLOAT, false, 0, 0);
  gl.uniform2f(state.nodeProgram.uResolution, resolution[0], resolution[1]);
  gl.uniform2f(state.nodeProgram.uTranslate, tx, ty);
  gl.uniform1f(state.nodeProgram.uScale, scale);
  gl.drawArrays(gl.POINTS, 0, state.nodeCount);
}

function _webglSchedule(state = _webglGraph) {
  if (!state || state.raf) return;
  state.raf = requestAnimationFrame(() => _webglDraw(state));
}

function _webglScreenPoint(state, index) {
  return {
    x: state.layout.x[index] * state.view.scale + state.view.tx,
    y: state.layout.y[index] * state.view.scale + state.view.ty,
  };
}

function _webglVisibleOnScreen(state, point, pad = 36) {
  return point.x >= -pad && point.x <= (state.cssWidth || 0) + pad
    && point.y >= -pad && point.y <= (state.cssHeight || 0) + pad;
}

function _webglVisibleByFilter(node) {
  return (typeof window._isNodeVisible === 'function') ? window._isNodeVisible(node) : true;
}

function _webglSelectionNeighbors(state) {
  const ids = selectedNodeIds || new Set();
  if (!ids.size) return null;
  const selectedIndexes = new Set();
  const neighbors = new Set();
  for (const id of ids) {
    const idx = state.idToIndex?.get(id);
    if (idx != null) {
      selectedIndexes.add(idx);
      neighbors.add(idx);
    }
  }
  const rawEdges = state.data.webglEdges || [];
  for (let i = 0; i < rawEdges.length; i++) {
    const edge = rawEdges[i];
    const s = edge[0] >>> 0;
    const t = edge[1] >>> 0;
    if (selectedIndexes.has(s)) neighbors.add(t);
    if (selectedIndexes.has(t)) neighbors.add(s);
  }
  return neighbors;
}

function _webglApplyFilters(state = _webglGraph) {
  if (!state?.gl) return false;
  const nodes = state.data.nodes || [];
  const rawEdges = state.data.webglEdges || [];
  const selected = selectedNodeIds || new Set();
  const primaryId = selectedNode?.id || (selected.size === 1 ? [...selected][0] : null);
  const neighborSet = _webglSelectionNeighbors(state);
  const visibleMask = state.visibleMask || new Uint8Array(nodes.length);
  state.visibleMask = visibleMask;
  let visibleNodeCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    const filterVisible = _webglVisibleByFilter(nodes[i]);
    visibleMask[i] = filterVisible ? 1 : 0;
    if (filterVisible) visibleNodeCount++;
    const selectedBoost = selected.has(nodes[i].id) ? 1 : 0;
    const focusVisible = !neighborSet || neighborSet.has(i);
    let alpha = filterVisible ? 0.92 : 0.035;
    if (!focusVisible) alpha = Math.min(alpha, 0.1);
    if (selectedBoost) alpha = 1;
    state.nodeAlpha[i] = alpha;
  }

  let visibleEdgeCount = 0;
  for (let i = 0; i < rawEdges.length; i++) {
    const s = rawEdges[i][0] >>> 0;
    const t = rawEdges[i][1] >>> 0;
    const endpointsVisible = visibleMask[s] && visibleMask[t];
    const selectedEdge = primaryId && (nodes[s]?.id === primaryId || nodes[t]?.id === primaryId);
    const focusVisible = !neighborSet || (neighborSet.has(s) && neighborSet.has(t));
    let alpha = state.view.scale < 0.2 ? 0.055 : 0.09;
    if (!endpointsVisible) alpha = 0.015;
    if (!focusVisible) alpha = Math.min(alpha, 0.025);
    if (selectedEdge) alpha = 0.22;
    if (endpointsVisible && focusVisible) visibleEdgeCount++;
    state.edgeAlpha[i * 2] = alpha;
    state.edgeAlpha[i * 2 + 1] = alpha;
  }

  const gl = state.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.nodeAlpha);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.nodeAlpha);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffers.edgeAlpha);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.edgeAlpha);
  state.visibleNodeCount = visibleNodeCount;
  state.visibleEdgeCount = visibleEdgeCount;
  _lastCullStats = {
    nodes: visibleNodeCount,
    edges: visibleEdgeCount,
    totalNodes: nodes.length,
    totalEdges: rawEdges.length,
  };
  const readout = document.getElementById('graph-rendered-count');
  if (readout) readout.textContent = `webgl rendering ${visibleNodeCount.toLocaleString()} nodes · ${visibleEdgeCount.toLocaleString()} edges`;
  _webglRefreshOverlay(state);
  _webglSchedule(state);
  if (state.data?.meta?.requestedMode === 'auto') _scheduleHybridEvaluation();
  return true;
}

function _webglRefreshOverlay(state = _webglGraph) {
  if (!state || !svg) return;
  _webglResize(state);
  svg
    .attr('width', state.cssWidth)
    .attr('height', state.cssHeight)
    .attr('viewBox', `0 0 ${state.cssWidth} ${state.cssHeight}`);
  const overlay = svg.selectAll('g.webgl-overlay').data([null]).join('g').attr('class', 'webgl-overlay');
  const wanted = new Map();
  const occupied = [];
  const canPlace = (point, minDist = 82) => {
    const min2 = minDist * minDist;
    for (const p of occupied) {
      const dx = p.x - point.x;
      const dy = p.y - point.y;
      if (dx * dx + dy * dy < min2) return false;
    }
    occupied.push(point);
    return true;
  };
  const addNode = (node, kind = 'label', opts = {}) => {
    const idx = state.idToIndex?.get(node?.id);
    if (idx == null) return;
    if (state.visibleMask && !state.visibleMask[idx]) return;
    const p = _webglScreenPoint(state, idx);
    if (!_webglVisibleOnScreen(state, p)) return;
    if (!opts.force && !canPlace(p, opts.minDist || 82)) return;
    if (opts.force) occupied.push(p);
    wanted.set(node.id, { node, idx, kind, ...p });
  };

  if (hoveredNodeId) addNode(state.data.nodes[state.idToIndex.get(hoveredNodeId)], 'hover', { force: true });
  if (selectedNodeIds?.size) {
    for (const id of selectedNodeIds) addNode(state.data.nodes[state.idToIndex.get(id)], id === selectedNode?.id ? 'primary' : 'selected', { force: true });
  }

  const q = window._graphFilterState?.searchQuery || '';
  if (q && wanted.size < 20) {
    for (const node of state.data.nodes || []) {
      if (wanted.size >= 20) break;
      if (!_webglVisibleByFilter(node)) continue;
      addNode(node, 'search', { minDist: 68 });
    }
  }

  if (!q) {
    const labelBudget = state.view.scale > 2.2 ? 140
      : state.view.scale > 1.1 ? 96
      : state.view.scale > 0.5 ? 58
      : state.view.scale > 0.22 ? 34
      : 18;
    for (const idx of state.labelRank || []) {
      if (wanted.size >= labelBudget) break;
      const node = state.data.nodes[idx];
      if (!node || wanted.has(node.id) || !_webglVisibleByFilter(node)) continue;
      addNode(node, 'auto', { minDist: state.view.scale > 1.1 ? 72 : 96 });
    }
  }

  const items = Array.from(wanted.values());
  overlay.selectAll('text.webgl-type-label').remove();

  const groups = overlay.selectAll('g.webgl-overlay-item').data(items, d => d.node.id);
  groups.exit().remove();
  const enter = groups.enter().append('g').attr('class', 'webgl-overlay-item');
  enter.append('circle').attr('class', 'webgl-overlay-ring');
  enter.append('text').attr('class', 'webgl-overlay-label');
  const merged = enter.merge(groups)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .attr('data-kind', d => d.kind);
  merged.select('circle')
    .attr('r', d => d.kind === 'primary' ? 11 : 8)
    .attr('stroke', d => getColor(d.node.type))
    .attr('fill', 'none');
  merged.select('text')
    .attr('x', 12)
    .attr('y', -10)
    .text(d => d.node.label || d.node.id);
}

window._webglApplyFilters = _webglApplyFilters;
window._webglRefreshOverlay = _webglRefreshOverlay;
window._fitWebglGraph = function () {
  if (!_webglGraph) return false;
  _webglFit(_webglGraph);
  _webglApplyFilters(_webglGraph);
  _scheduleHybridEvaluation();
  return true;
};
window._webglHandleContainerResize = function (deltaWidth = 0, deltaHeight = 0) {
  const state = _webglGraph;
  if (!state) return false;
  const dx = Number(deltaWidth) || 0;
  const dy = Number(deltaHeight) || 0;
  if (Math.abs(dx) >= 1) state.view.tx += dx / 2;
  if (Math.abs(dy) >= 1) state.view.ty += dy / 2;
  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = null;
  }
  _webglDraw(state, { skipResize: true });
  if (_webglResizeCommitTimer) clearTimeout(_webglResizeCommitTimer);
  _webglResizeCommitTimer = setTimeout(() => {
    _webglResizeCommitTimer = null;
    if (state !== _webglGraph) return;
    _webglResize(state);
    _webglRefreshOverlay(state);
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = null;
    }
    _webglDraw(state);
    _scheduleHybridEvaluation();
  }, 140);
  return true;
};

function _webglCenterNode(nodeId, state = _webglGraph) {
  const idx = state?.idToIndex?.get(nodeId);
  if (idx == null) return false;
  _webglResize(state);
  state.view.tx = (state.cssWidth || 1) / 2 - state.layout.x[idx] * state.view.scale;
  state.view.ty = (state.cssHeight || 1) / 2 - state.layout.y[idx] * state.view.scale;
  _webglApplyFilters(state);
  _scheduleHybridEvaluation();
  return true;
}
window._webglCenterNode = _webglCenterNode;

function _webglRevealNode(nodeId, state = _webglGraph, opts = {}) {
  const idx = state?.idToIndex?.get(nodeId);
  if (idx == null) return false;
  const targetScale = Number(opts.scale);
  if (Number.isFinite(targetScale)) {
    state.view.scale = Math.max(0.04, Math.min(12, targetScale));
  } else {
    state.view.scale = Math.max(state.view.scale || 0.04, 1.35);
  }
  return _webglCenterNode(nodeId, state);
}

function _webglFocusNodeClone(nodeLike, state, origin, ordinal = 0) {
  if (!nodeLike?.id) return null;
  const idx = state?.idToIndex?.get(nodeLike.id);
  const fullNode = idx == null ? null : state.data.nodes[idx];
  const node = { ...(fullNode || {}), ...nodeLike };
  if (idx != null && state?.layout) {
    node.x = state.layout.x[idx];
    node.y = state.layout.y[idx];
  } else if (!Number.isFinite(Number(node.x)) || !Number.isFinite(Number(node.y))) {
    const angle = ordinal * Math.PI * (3 - Math.sqrt(5));
    const radius = 118 + Math.sqrt(Math.max(1, ordinal)) * 18;
    node.x = (origin?.x || 0) + Math.cos(angle) * radius;
    node.y = (origin?.y || 0) + Math.sin(angle) * radius;
  }
  node.vx = 0;
  node.vy = 0;
  return node;
}

function _webglBuildFocusSvgPayload(nodeId, details, state = _webglGraph, opts = {}) {
  if (!state?.data?.nodes || !details?.node) return null;
  const centerIdx = state.idToIndex?.get(nodeId);
  const origin = centerIdx == null
    ? { x: 0, y: 0 }
    : { x: state.layout.x[centerIdx], y: state.layout.y[centerIdx] };
  const nodeMap = new Map();
  const addNode = (nodeLike, ordinal = 0) => {
    const node = _webglFocusNodeClone(nodeLike, state, origin, ordinal);
    if (!node?.id) return;
    const existing = nodeMap.get(node.id);
    nodeMap.set(node.id, existing ? { ...existing, ...node, x: existing.x, y: existing.y } : node);
  };
  addNode({ ...details.node, _detailsLoaded: true, _detailEdges: details.edges || [], _detailNeighbors: details.neighbors || [] }, 0);
  (details.neighbors || []).forEach((node, index) => addNode(node, index + 1));

  const ids = new Set(nodeMap.keys());
  const edges = (details.edges || [])
    .filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type || 'related',
      weight: Number(edge.weight) || 1,
    }));
  const sourceMeta = state.data.meta || {};
  return {
    ...(state.data.graph ? { graph: state.data.graph } : {}),
    nodes: Array.from(nodeMap.values()),
    edges,
    meta: {
      ...sourceMeta,
      mode: 'full',
      renderer: 'svg',
      requestedMode: sourceMeta.requestedMode || 'auto',
      hybridSubset: true,
      hybridFocus: true,
      hybridSourceRenderer: 'webgl',
      returnToWebglOnUnfocus: opts.returnToWebglOnUnfocus !== false,
      root: nodeId,
      displayedNodeCount: nodeMap.size,
      displayedEdgeCount: edges.length,
      representedNodeCount: sourceMeta.representedNodeCount || sourceMeta.nodeCount || state.data.nodes.length,
      representedEdgeCount: sourceMeta.representedEdgeCount || sourceMeta.edgeCount || state.data.webglEdges?.length || edges.length,
      truncated: true,
    },
  };
}

function _hybridSourceStateFromData(data = _hybridFullWebglData) {
  if (!data?.nodes?.length) return null;
  const idToIndex = new Map();
  const x = new Float32Array(data.nodes.length);
  const y = new Float32Array(data.nodes.length);
  for (let i = 0; i < data.nodes.length; i++) {
    const node = data.nodes[i];
    idToIndex.set(node.id, i);
    x[i] = Number(node.x) || 0;
    y[i] = Number(node.y) || 0;
  }
  return { data, idToIndex, layout: { x, y } };
}

async function _webglFocusGraphOnNode(nodeId, state = _webglGraph, opts = {}) {
  const idx = state?.idToIndex?.get(nodeId);
  if (idx == null) return false;
  const fullNode = state.data.nodes[idx];
  const returnView = opts.returnView || {
    scale: Number(state.view?.scale) || 1,
    tx: Number(state.view?.tx) || 0,
    ty: Number(state.view?.ty) || 0,
  };
  _graphFocusTransitioning = true;
  _setGraphSelection([nodeId], { panelNode: fullNode });
  updateStats();
  try {
    const details = await fetchNodeDetails(nodeId);
    const payload = _webglBuildFocusSvgPayload(nodeId, details, state, opts);
    if (!payload) throw new Error('Focus payload unavailable');
    const priorOrigin = _graphFocusState?.origin || null;
    await _graphStructureTransition(() => {
      _hybridFullWebglData = state.data;
      _hybridLastSvgKey = `focus:${nodeId}`;
      const focusNode = payload.nodes.find(node => node.id === nodeId) || payload.nodes[0];
      _setGraphSelection([nodeId], { panelNode: focusNode });
      initGraph(payload, { hybridSwitch: true });
      _hybridLastSwitchAt = performance.now();
      _focusGraphOnNode(nodeId, {
        fitAnimate: false,
        origin: priorOrigin,
        restoreOnUnfocus: opts.restoreOnUnfocus || null,
        returnTransform: returnView,
      });
    });
    return true;
  } catch (e) {
    console.warn('WebGL focus reveal failed:', e);
    if (state?.canvas && state?.view) {
      _webglRevealNode(nodeId, state, { scale: Math.max(state.view.scale || 1, 1.8) });
    }
    return false;
  } finally {
    _graphFocusTransitioning = false;
  }
}

function _webglPickNode(state, clientX, clientY) {
  const rect = state.canvas.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const wx = (sx - state.view.tx) / state.view.scale;
  const wy = (sy - state.view.ty) / state.view.scale;
  const threshold = Math.max(5, 12 / Math.max(0.05, state.view.scale));
  const threshold2 = threshold * threshold;
  let best = -1;
  let bestD = threshold2;
  for (let i = 0; i < state.nodeCount; i++) {
    if (state.visibleMask && !state.visibleMask[i]) continue;
    const dx = state.layout.x[i] - wx;
    const dy = state.layout.y[i] - wy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? state.data.nodes[best] : null;
}

function _hybridNodePassesFilter(node) {
  return (typeof window._isNodeVisible === 'function') ? window._isNodeVisible(node) : true;
}

function _hybridVisibleIndicesFromWebgl(state, limit = HYBRID_SVG_NODE_LIMIT + 1, pad = 72) {
  if (!state?.layout || !state?.data?.nodes) return { indices: [], overflow: false };
  _webglResize(state);
  const scale = Math.max(0.0001, state.view.scale || 1);
  const minX = (-pad - state.view.tx) / scale;
  const maxX = ((state.cssWidth || 1) + pad - state.view.tx) / scale;
  const minY = (-pad - state.view.ty) / scale;
  const maxY = ((state.cssHeight || 1) + pad - state.view.ty) / scale;
  const indices = [];
  const nodes = state.data.nodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!_hybridNodePassesFilter(node)) continue;
    const x = state.layout.x[i];
    const y = state.layout.y[i];
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    indices.push(i);
    if (indices.length > limit) return { indices, overflow: true };
  }
  return { indices, overflow: false };
}

function _hybridVisibleIndicesFromSvgTransform(transform, limit = HYBRID_SVG_NODE_LIMIT + 1, pad = 72) {
  const data = _hybridFullWebglData;
  if (!data?.nodes?.length || !svg?.node()) return { indices: [], overflow: false };
  const node = svg.node();
  const width = node.clientWidth || window.innerWidth || 1;
  const height = node.clientHeight || window.innerHeight || 1;
  const t = transform || d3.zoomTransform(node);
  const scale = Math.max(0.0001, t.k || 1);
  const minX = (-pad - t.x) / scale;
  const maxX = (width + pad - t.x) / scale;
  const minY = (-pad - t.y) / scale;
  const maxY = (height + pad - t.y) / scale;
  const indices = [];
  for (let i = 0; i < data.nodes.length; i++) {
    const n = data.nodes[i];
    if (!_hybridNodePassesFilter(n)) continue;
    const x = Number(n.x);
    const y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    indices.push(i);
    if (indices.length > limit) return { indices, overflow: true };
  }
  return { indices, overflow: false };
}

function _hybridVisibleKey(indices) {
  return indices.join(',');
}

function _hybridCloneSubsetNode(sourceNode, x, y, extra = {}) {
  return {
    ...sourceNode,
    x: Number(x),
    y: Number(y),
    vx: 0,
    vy: 0,
    ...(Object.keys(extra).length ? { extra: { ...(sourceNode.extra || {}), ...extra } } : {}),
  };
}

function _hybridBuildSvgSubset(indices, viewInfo = {}) {
  const source = _hybridFullWebglData;
  if (!source?.nodes?.length) return null;
  const visibleIndexSet = new Set(indices);
  const includedIndexSet = new Set(indices);
  const indexToNodeId = new Map();
  const nodes = indices.map(index => {
    const srcNode = source.nodes[index];
    indexToNodeId.set(index, srcNode.id);
    return _hybridCloneSubsetNode(srcNode, srcNode.x, srcNode.y);
  });
  const rawEdges = source.webglEdges || source.edges || [];
  const contextCounts = new Map();
  const addContextNode = (contextIndex, anchorIndex) => {
    if (includedIndexSet.has(contextIndex)) return true;
    if (nodes.length >= indices.length + HYBRID_CONTEXT_NODE_LIMIT) return false;
    const contextNode = source.nodes[contextIndex];
    const anchorNode = source.nodes[anchorIndex];
    if (!contextNode || !anchorNode || !_hybridNodePassesFilter(contextNode)) return false;
    const used = contextCounts.get(anchorIndex) || 0;
    if (used >= HYBRID_CONTEXT_EDGES_PER_NODE) return false;
    contextCounts.set(anchorIndex, used + 1);
    const ax = Number(anchorNode.x);
    const ay = Number(anchorNode.y);
    const cx = Number(contextNode.x);
    const cy = Number(contextNode.y);
    let dx = cx - ax;
    let dy = cy - ay;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1) {
      const angle = _hashUnit(contextNode.id || contextIndex, used + 31) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    }
    const len = Math.hypot(dx, dy) || 1;
    const dist = 82 + (used % 4) * 18;
    const px = ax + (dx / len) * dist;
    const py = ay + (dy / len) * dist;
    includedIndexSet.add(contextIndex);
    indexToNodeId.set(contextIndex, contextNode.id);
    nodes.push(_hybridCloneSubsetNode(contextNode, px, py, {
      hybridContext: true,
      hybridContextOf: anchorNode.id,
    }));
    return true;
  };
  for (const edge of rawEdges) {
    if (nodes.length >= indices.length + HYBRID_CONTEXT_NODE_LIMIT) break;
    const s = edge?.[0] >>> 0;
    const t = edge?.[1] >>> 0;
    const sVisible = visibleIndexSet.has(s);
    const tVisible = visibleIndexSet.has(t);
    if (sVisible === tVisible) continue;
    if (sVisible) addContextNode(t, s);
    else addContextNode(s, t);
  }
  const edges = [];
  for (const edge of rawEdges) {
    const s = edge?.[0] >>> 0;
    const t = edge?.[1] >>> 0;
    if (!includedIndexSet.has(s) || !includedIndexSet.has(t)) continue;
    const contextEdge = !visibleIndexSet.has(s) || !visibleIndexSet.has(t);
    edges.push({
      source: indexToNodeId.get(s),
      target: indexToNodeId.get(t),
      type: edge?.[3] || 'related',
      weight: Number(edge?.[2]) || 1,
      contextEdge,
    });
    if (edges.length >= HYBRID_SVG_EDGE_LIMIT) break;
  }
  const meta = source.meta || {};
  return {
    ...(source.graph ? { graph: source.graph } : {}),
    nodes,
    edges,
    meta: {
      ...meta,
      mode: 'full',
      renderer: 'svg',
      requestedMode: 'auto',
      hybridSubset: true,
      hybridSourceRenderer: 'webgl',
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edges.length,
      viewportNodeCount: indices.length,
      contextNodeCount: nodes.length - indices.length,
      representedNodeCount: meta.representedNodeCount || meta.nodeCount || source.nodes.length,
      representedEdgeCount: meta.representedEdgeCount || meta.edgeCount || rawEdges.length,
      truncated: nodes.length < (meta.representedNodeCount || meta.nodeCount || source.nodes.length),
      hybridView: viewInfo,
    },
  };
}

function _scheduleHybridEvaluation(delay = HYBRID_EVAL_IDLE_MS) {
  if (_hybridSwitching || _graphFocusTransitioning) return;
  if (_hybridSwitchRaf) {
    clearTimeout(_hybridSwitchRaf);
    _hybridSwitchRaf = null;
  }
  _hybridSwitchRaf = setTimeout(() => {
    _hybridSwitchRaf = null;
    requestAnimationFrame(() => _evaluateHybridRenderer());
  }, Math.max(0, Number(delay) || 0));
}

function _hybridInSwitchCooldown() {
  if (!_hybridLastSwitchAt) return false;
  return (performance.now() - _hybridLastSwitchAt) < HYBRID_SWITCH_COOLDOWN_MS;
}

function _hybridSwitchToSvgFromWebgl(state, visible) {
  if (!state?.data || !visible?.indices?.length || visible.overflow) return false;
  _hybridSwitching = true;
  try {
    _hybridFullWebglData = state.data;
    const key = _hybridVisibleKey(visible.indices);
    _hybridLastSvgKey = key;
    const initialTransform = { x: state.view.tx, y: state.view.ty, k: state.view.scale };
    const subset = _hybridBuildSvgSubset(visible.indices, {
      scale: initialTransform.k,
      tx: initialTransform.x,
      ty: initialTransform.y,
    });
    if (!subset) return false;
    _graphRendererCrossfade(() => {
      initGraph(subset, { initialTransform, preserveCamera: true, hybridSwitch: true });
      _hybridLastSwitchAt = performance.now();
    }, { duration: 260 });
    return true;
  } finally {
    _hybridSwitching = false;
  }
}

function _hybridSwitchToWebglFromSvg(transform = null) {
  if (!_hybridFullWebglData) return false;
  _hybridSwitching = true;
  try {
    const explicitView = transform && Number.isFinite(Number(transform.scale))
      ? {
        scale: Number(transform.scale) || 1,
        tx: Number(transform.tx) || 0,
        ty: Number(transform.ty) || 0,
      }
      : null;
    const t = explicitView ? null : (transform || (svg?.node() ? d3.zoomTransform(svg.node()) : d3.zoomIdentity));
    const focusId = _graphFocusedId || null;
    const selectedId = focusId || selectedNode?.id || (selectedNodeIds?.size === 1 ? [...selectedNodeIds][0] : null);
    _graphFocusedId = null;
    _graphFocusState = null;
    _graphPreFocusTransform = null;
    _graphRendererCrossfade(() => {
      initWebglGraph(_hybridFullWebglData, {
        initialView: explicitView || { scale: t.k || 1, tx: t.x || 0, ty: t.y || 0 },
        hybridSwitch: true,
      });
      if (selectedId && _webglGraph?.idToIndex?.has(selectedId)) {
        const node = _webglGraph.data.nodes[_webglGraph.idToIndex.get(selectedId)];
        _setGraphSelection([selectedId], { panelNode: node });
        if (!explicitView) _webglRevealNode(selectedId, _webglGraph, { scale: Math.max(Number(t.k) || 1, focusId ? 1.65 : 1.25) });
      }
      _hybridLastSwitchAt = performance.now();
    }, { duration: 260 });
    return true;
  } finally {
    _hybridSwitching = false;
  }
}

function _evaluateHybridRenderer() {
  if (_hybridSwitching || _graphFocusTransitioning) return;
  if (_graphFocusedId) return;
  if (_hybridInSwitchCooldown()) {
    _scheduleHybridEvaluation(HYBRID_SWITCH_COOLDOWN_MS);
    return;
  }
  if (_webglGraph?.data?.meta?.requestedMode === 'auto') {
    const visible = _hybridVisibleIndicesFromWebgl(_webglGraph, HYBRID_SVG_NODE_LIMIT + 1);
    if (!visible.overflow && visible.indices.length > 0 && visible.indices.length <= HYBRID_SVG_NODE_LIMIT) {
      _hybridSwitchToSvgFromWebgl(_webglGraph, visible);
    }
    return;
  }
  if (graphData?.meta?.hybridSubset && _hybridFullWebglData && svg?.node()) {
    if (graphData?.meta?.hybridFocus && _graphFocusedId) return;
    const t = d3.zoomTransform(svg.node());
    const visible = _hybridVisibleIndicesFromSvgTransform(t, HYBRID_WEBGL_NODE_LIMIT + 1);
    if (visible.overflow || visible.indices.length > HYBRID_WEBGL_NODE_LIMIT) {
      _hybridSwitchToWebglFromSvg(t);
    }
  }
}

function initWebglGraph(data, opts = {}) {
  _destroyWebglGraph();
  if (simulation) {
    simulation.stop();
    simulation = null;
  }
  svg = d3.select('#graph-svg');
  _beginSvgLabelRefresh();
  svg.selectAll('*').remove();

  const canvas = document.getElementById('graph-webgl');
  const canvasHost = document.getElementById('canvas');
  if (!canvas || !canvasHost) throw new Error('WebGL canvas missing');
  canvas.style.display = 'block';
  canvasHost.classList.add('webgl-active');
  const gl = canvas.getContext('webgl', { antialias: false, alpha: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL is not available in this browser');

  data.webglEdges = data.webglEdges || data.edges || [];
  data.edges = [];
  graphData = data;
  if (data?.meta?.requestedMode === 'auto') _hybridFullWebglData = data;
  if (!opts.hybridSwitch) _hybridLastSvgKey = '';
  _lastCullStats = {
    nodes: data.nodes?.length || 0,
    edges: data.webglEdges?.length || 0,
    totalNodes: data.nodes?.length || 0,
    totalEdges: data.webglEdges?.length || 0,
  };
  _setGraphViewState(data?.meta?.requestedMode === 'auto' ? 'auto' : 'webgl', null);

  const vertexBase = `
    attribute vec2 a_position;
    attribute float a_alpha;
    uniform vec2 u_resolution;
    uniform vec2 u_translate;
    uniform float u_scale;
    varying float v_alpha;
    void main() {
      vec2 screen = a_position * u_scale + u_translate;
      vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_alpha = a_alpha;
    }`;
  const edgeProgram = _webglProgram(gl, vertexBase, `
    precision mediump float;
    uniform vec3 u_color;
    varying float v_alpha;
    void main() { gl_FragColor = vec4(u_color, v_alpha); }`);
  const nodeProgram = _webglProgram(gl, `
    attribute vec2 a_position;
    attribute vec3 a_color;
    attribute float a_size;
    attribute float a_alpha;
    attribute float a_shape;
    uniform vec2 u_resolution;
    uniform vec2 u_translate;
    uniform float u_scale;
    varying vec3 v_color;
    varying float v_alpha;
    varying float v_shape;
    void main() {
      vec2 screen = a_position * u_scale + u_translate;
      vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      gl_PointSize = clamp(a_size * pow(max(u_scale, 0.01), 0.38), 5.5, 34.0);
      v_color = a_color;
      v_alpha = a_alpha;
      v_shape = a_shape;
    }`, `
    precision mediump float;
    varying vec3 v_color;
    varying float v_alpha;
    varying float v_shape;

    float shapeAlpha(vec2 p, float shape) {
      float ax = abs(p.x);
      float ay = abs(p.y);
      if (shape < 0.5) {
        return 1.0 - smoothstep(0.82, 1.0, length(p));
      }
      if (shape < 1.5) {
        return 1.0 - smoothstep(0.86, 1.0, max(ax, ay));
      }
      if (shape < 2.5) {
        return 1.0 - smoothstep(0.88, 1.05, ax + ay);
      }
      if (shape < 3.5) {
        float side = 0.96 - max(p.y, -0.75) * 0.58;
        float inside = min(0.92 - p.y, side - ax);
        inside = min(inside, p.y + 0.86);
        return smoothstep(-0.08, 0.08, inside);
      }
      if (shape < 4.5) {
        float d = max(ay, ax * 0.8660254 + ay * 0.5);
        return 1.0 - smoothstep(0.82, 0.98, d);
      }
      if (shape < 5.5) {
        float side = 0.86 - max(p.y, -0.2) * 0.2;
        float inside = min(side - ax, 0.94 - ay);
        return smoothstep(-0.08, 0.08, inside);
      }
      vec2 q = vec2(max(ax - 0.48, 0.0), ay);
      return 1.0 - smoothstep(0.36, 0.52, length(q));
    }

    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float alpha = shapeAlpha(p, v_shape);
      if (alpha <= 0.01) discard;
      gl_FragColor = vec4(v_color, alpha * v_alpha);
    }`);

  const state = {
    canvas,
    gl,
    data,
    layout: _webglBuildLayout(data),
    view: { scale: 1, tx: 0, ty: 0 },
    cleanup: [],
    edgeProgram: {
      program: edgeProgram,
      aPosition: gl.getAttribLocation(edgeProgram, 'a_position'),
      aAlpha: gl.getAttribLocation(edgeProgram, 'a_alpha'),
      uResolution: gl.getUniformLocation(edgeProgram, 'u_resolution'),
      uTranslate: gl.getUniformLocation(edgeProgram, 'u_translate'),
      uScale: gl.getUniformLocation(edgeProgram, 'u_scale'),
      uColor: gl.getUniformLocation(edgeProgram, 'u_color'),
    },
    nodeProgram: {
      program: nodeProgram,
      aPosition: gl.getAttribLocation(nodeProgram, 'a_position'),
      aColor: gl.getAttribLocation(nodeProgram, 'a_color'),
      aSize: gl.getAttribLocation(nodeProgram, 'a_size'),
      aAlpha: gl.getAttribLocation(nodeProgram, 'a_alpha'),
      aShape: gl.getAttribLocation(nodeProgram, 'a_shape'),
      uResolution: gl.getUniformLocation(nodeProgram, 'u_resolution'),
      uTranslate: gl.getUniformLocation(nodeProgram, 'u_translate'),
      uScale: gl.getUniformLocation(nodeProgram, 'u_scale'),
    },
  };
  _webglInitBuffers(state);
  if (opts.initialView) {
    _webglResize(state);
    state.view.scale = Number(opts.initialView.scale) || 1;
    state.view.tx = Number(opts.initialView.tx) || 0;
    state.view.ty = Number(opts.initialView.ty) || 0;
  } else {
    _webglFit(state);
  }
  _webglGraph = state;

  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  const on = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    state.cleanup.push(() => target.removeEventListener(type, handler, opts));
  };
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - state.view.tx) / state.view.scale;
    const wy = (my - state.view.ty) / state.view.scale;
    const factor = Math.exp(-e.deltaY * 0.0012);
    state.view.scale = Math.max(0.015, Math.min(12, state.view.scale * factor));
    state.view.tx = mx - wx * state.view.scale;
    state.view.ty = my - wy * state.view.scale;
    _webglRefreshOverlay(state);
    _webglSchedule(state);
    _scheduleHybridEvaluation();
  }, { passive: false });
  on(canvas, 'pointerdown', (e) => {
    dragging = true;
    moved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });
  on(canvas, 'pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    state.view.tx += dx;
    state.view.ty += dy;
    _webglRefreshOverlay(state);
    _webglSchedule(state);
    _scheduleHybridEvaluation();
  });
  on(canvas, 'pointermove', (e) => {
    if (dragging) return;
    const node = _webglPickNode(state, e.clientX, e.clientY);
    const nextId = node?.id || null;
    if (hoveredNodeId !== nextId) {
      hoveredNodeId = nextId;
      canvas.style.cursor = nextId ? 'pointer' : 'grab';
      _webglRefreshOverlay(state);
    }
  });
  on(canvas, 'pointerleave', () => {
    if (hoveredNodeId) {
      hoveredNodeId = null;
      canvas.style.cursor = 'grab';
      _webglRefreshOverlay(state);
    }
  });
  on(canvas, 'pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    if (!moved) {
      const node = _webglPickNode(state, e.clientX, e.clientY);
      if (node) selectNode(node);
      else clearGraphSelection();
    }
  });
  on(canvas, 'dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const node = _webglPickNode(state, e.clientX, e.clientY);
    if (node) {
      _webglFocusGraphOnNode(node.id, state);
      return;
    }
    _webglFit(state);
    _webglApplyFilters(state);
    _scheduleHybridEvaluation();
  });
  on(canvas, 'contextmenu', (e) => {
    e.preventDefault();
    const node = _webglPickNode(state, e.clientX, e.clientY);
    if (node && !selectedNodeIds.has(node.id)) selectNode(node);
    if (selectedNodeIds.size || node) showGraphContextMenu(e.clientX, e.clientY);
  });
  on(window, 'resize', () => {
    _webglResize(state);
    _webglRefreshOverlay(state);
    _webglSchedule(state);
    _scheduleHybridEvaluation();
  });

  _refreshTypeFilterOptions(data.nodes || []);
  _webglApplyFilters(state);
  updateStats();
  _refreshCurrentAltView();
}

// ── Graph Visualization ──
function initGraph(data, opts = {}) {
  _destroyWebglGraph();
  graphData = data;
  _lastSvgLabelLayoutKey = '';
  if (!data?.meta?.hybridSubset && !opts.hybridSwitch && data?.meta?.requestedMode !== 'auto') {
    _hybridFullWebglData = null;
    _hybridLastSvgKey = '';
  }
  const usesSharedLayout = _graphUsesSharedLayout(data);
  _lastCullStats = { nodes: 0, edges: 0, totalNodes: 0, totalEdges: 0 };
  if (data?.meta?.mode) _setGraphViewState(data.meta.requestedMode || data.meta.mode, data.meta.root || null);
  if (!usesSharedLayout) _restoreGraphLayout(data);
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
    window._graphZoomInteracting = true;
    if (_zoomInteractionTimer) clearTimeout(_zoomInteractionTimer);
    _zoomInteractionTimer = setTimeout(() => {
      window._graphZoomInteracting = false;
      _zoomInteractionTimer = null;
      _lastSvgLabelLayoutKey = '';
      if (typeof _scheduleLabelLayout === 'function') _scheduleLabelLayout(true);
    }, 130);
    g.attr('transform', e.transform);
    _scheduleViewportCulling();
    const newScale = e.transform.k;
    const semanticScaleChanged = Math.abs(newScale - _currentZoomScale) > 0.05 || (newScale < 0.4) !== (_currentZoomScale < 0.4);
    _currentZoomScale = newScale;
    _updateFocusEdgeLabels();
    if (semanticScaleChanged) {
      _applySemanticZoom(newScale);
    }
    if (graphData?.meta?.hybridSubset) _scheduleHybridEvaluation();
  });
  svg.call(zoom);

  _selectionRect = svg.append('rect')
    .attr('class', 'graph-selection-rect')
    .style('display', 'none');

  gLinks = g.append('g').attr('class', 'links');
  gNodes = g.append('g').attr('class', 'nodes');

  if (usesSharedLayout) {
    data.nodes.forEach((node) => {
      node.x = Number(node.x);
      node.y = Number(node.y);
      node.vx = 0;
      node.vy = 0;
    });
  }
  const nodeMap = {};
  data.nodes.forEach(n => { nodeMap[n.id] = n; n.radius = _computeNodeRadius(n); });
  hoveredNodeId = nodeMap[hoveredNodeId] ? hoveredNodeId : null;
  simLinks = data.edges.filter(e => nodeMap[e.source] && nodeMap[e.target]).map(e => ({...e}));

  // Place each node inside its type's anchor cell BEFORE the simulation starts.
  if (!usesSharedLayout) _seedNodesByType(data.nodes, width, height);

  // Per-node anchors: local layouts get pulled toward their TYPE's grid cell.
  // Shared server layouts already arrive in world coordinates centered around
  // the self node, so they get a weak origin pull instead of viewport anchors.
  const _typeAnchors = _typeClusterAnchors(data.nodes, width, height);
  const _anchorX = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.x ?? width / 2);
  const _anchorY = (n) => (_typeAnchors.get(String(n.type || 'unknown'))?.y ?? height / 2);
  const selfNodeId = _graphSelfNodeId(data.nodes);
  let usingSmallSharedRadialLayout = false;
  if (usesSharedLayout) {
    _centerSharedLayoutOnSelf(data, selfNodeId);
    usingSmallSharedRadialLayout = _applySmallSharedRadialLayout(data, selfNodeId, simLinks);
    if (!usingSmallSharedRadialLayout) _compactSmallSharedLayout(data, selfNodeId);
    _centerSharedLayoutOnSelf(data, selfNodeId);
  }
  const linkDistance = usesSharedLayout
    ? (l => _sharedLayoutLinkDistance(l, selfNodeId, nodeCount))
    : (l => l.type === 'parent_of' ? 28 : profile.linkDistance);
  const linkStrength = usesSharedLayout
    ? (l => _sharedLayoutLinkStrength(l, selfNodeId))
    : (l => l.type === 'parent_of' ? 0.95 : profile.linkStrength);
  const chargeStrength = usesSharedLayout
    ? Math.max(profile.chargeStrength * 0.42, -16)
    : profile.chargeStrength;
  const chargeMaxDist = usesSharedLayout
    ? Math.max(140, profile.chargeMaxDist * 1.8)
    : profile.chargeMaxDist;
  const collisionPadding = usesSharedLayout
    ? Math.max(7, profile.collisionPad)
    : Math.max(4, profile.collisionPad);
  const collisionIterations = usesSharedLayout
    ? profile.collisionIterations + 3
    : profile.collisionIterations + 1;
  const xForce = usesSharedLayout
    ? d3.forceX(n => usingSmallSharedRadialLayout ? (Number(n?._sharedAnchorX) || 0) : 0)
      .strength(n => _sharedLayoutOriginStrength(n, selfNodeId, nodeCount))
    : d3.forceX(_anchorX).strength(profile.clusterStrength);
  const yForce = usesSharedLayout
    ? d3.forceY(n => usingSmallSharedRadialLayout ? (Number(n?._sharedAnchorY) || 0) : 0)
      .strength(n => _sharedLayoutOriginStrength(n, selfNodeId, nodeCount))
    : d3.forceY(_anchorY).strength(profile.clusterStrength);

  simulation = d3.forceSimulation(data.nodes)
    // Weak link strength so cross-type edges don't drag nodes out of their
    // treemap rect. Edges are still drawn; they just don't dominate layout.
    .force('link', d3.forceLink(simLinks).id(d => d.id)
      .distance(linkDistance)
      .strength(linkStrength))
    // Charge limited to local range so a far-away node never throws another
    // node out of its cluster. Without distanceMax, a 300-node graph means
    // every node feels every other → instant scattering of pre-seeded clusters.
    .force('charge', d3.forceManyBody().strength(chargeStrength).theta(profile.chargeTheta).distanceMax(chargeMaxDist))
    .force('clusterX', xForce)
    .force('clusterY', yForce)
    .force('collision', _createLabelBoxCollide().strength(1.0).padding(collisionPadding).iterations(collisionIterations))
    .velocityDecay(profile.velocityDecay)
    .on('tick', _scheduleTickRender);

  // Pre-bake synchronously: tick until alpha is low enough that visible motion
  // is invisible, capped by a wall-clock budget so the page never freezes.
  // Then PARK the simulation (alpha below alphaMin) so it stays still until
  // user interaction (drag) explicitly restarts it.
  if (usesSharedLayout) {
    if (selfNodeId && nodeMap[selfNodeId]) {
      nodeMap[selfNodeId].x = 0;
      nodeMap[selfNodeId].y = 0;
      nodeMap[selfNodeId].fx = 0;
      nodeMap[selfNodeId].fy = 0;
      nodeMap[selfNodeId].vx = 0;
      nodeMap[selfNodeId].vy = 0;
    }
    simulation.stop();
    const bakeBudget = nodeCount > 300 ? 260 : 420;
    const start = performance.now();
    let ticked = 0;
    while (simulation.alpha() > 0.004 && ticked < SHARED_LAYOUT_SETTLE_MAX_TICKS) {
      simulation.tick();
      ticked++;
      if ((ticked & 15) === 0 && (performance.now() - start) > bakeBudget) break;
    }
    if (selfNodeId && nodeMap[selfNodeId]) {
      nodeMap[selfNodeId].x = 0;
      nodeMap[selfNodeId].y = 0;
      nodeMap[selfNodeId].vx = 0;
      nodeMap[selfNodeId].vy = 0;
      nodeMap[selfNodeId].fx = null;
      nodeMap[selfNodeId].fy = null;
    }
    _parkSharedLayoutSimulation(data);
  } else {
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
  _saveGraphLayout(data);

  // Stroke color comes from the CSS rule (#graph-svg g.links line) so it
  // resolves --text correctly per active theme. SVG presentation
  // attributes don't expand var(), so setting it inline here would
  // produce a literal "var(--text)" string and fall back to black.
  const link = gLinks.selectAll('line').data(simLinks).join('line')
    .call(_styleGraphLinks);

  const nodeG = gNodes.selectAll('g').data(data.nodes, d => d.id).join('g')
    .classed('graph-node', true)
    .classed('hybrid-context-node', d => !!d.extra?.hybridContext)
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
      if ((graphData?.meta?.mode || window._graphViewState?.mode) === 'overview') loadGraphMode('slice', d.id);
      else _enterGraphStructureFocus(d.id);
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
      // Right-clicking a node that's already part of a multi-selection
      // KEEPS the selection — the menu's "delete/research selected nodes"
      // then operates on all of them. Only collapse to a single-node
      // selection when right-clicking a node OUTSIDE the current
      // selection (treat that as "switch focus to this one").
      if (!selectedNodeIds.has(node.id)) {
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
    if (_graphFocusedId) { _exitGraphStructureFocus(); return; }
    clearGraphSelection();
  });

  _refreshTypeFilterOptions(data.nodes);

  updateStats();
  _restoreGraphSelection();
  if (opts.initialTransform && svg && zoom) {
    const t = d3.zoomIdentity
      .translate(Number(opts.initialTransform.x) || 0, Number(opts.initialTransform.y) || 0)
      .scale(Number(opts.initialTransform.k) || 1);
    svg.call(zoom.transform, t);
  } else if (usesSharedLayout) {
    _fitSharedGraphLayout(data, { animate: false });
  }
  _applySemanticZoom(_currentZoomScale);
  _needsTick = true;
  _renderTick();
  if (!data?.meta?.hybridSubset) _queueEdgeConnectAnimation(link);
  // Recompute timeline bounds and re-apply the unified filter state
  // after every full graph render.
  _refreshActiveGraphFilters();
  _scheduleViewportCulling(true);
  _refreshCurrentAltView();
  _finishSvgLabelRefresh();
}

// ── Node Selection / Editor Panel ──
function selectNode(node) {
  _setGraphSelection([node.id], { panelNode: node });
  updateStats();
  if (node?.extra?.aggregate) return;
  if (!node._detailsLoaded) _loadNodeDetails(node.id);
}

// Focus mode: hide everything except the given node + its direct neighbors,
// then fit-to-view. Click background to restore.
let _graphFocusState = null;

function _edgeEndpointId(endpoint) {
  return endpoint?.id || endpoint;
}

function _cloneGraphForRestore(data) {
  if (!data) return null;
  const clonePlain = (value, fallback) => {
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
  };
  const nodes = clonePlain(data.nodes || [], []);
  const edges = (data.edges || []).map(edge => ({
    ...clonePlain(edge, {}),
    source: _edgeEndpointId(edge?.source),
    target: _edgeEndpointId(edge?.target),
  }));
  return {
    ...clonePlain(data, {}),
    nodes,
    edges,
    meta: clonePlain(data.meta || {}, {}),
  };
}

function _currentSvgTransformSnapshot() {
  if (!svg?.node()) return null;
  const t = d3.zoomTransform(svg.node());
  return { x: t.x || 0, y: t.y || 0, k: t.k || 1 };
}

function _focusEdgeVisible(edge, focusIds) {
  const s = _edgeEndpointId(edge?.source);
  const t = _edgeEndpointId(edge?.target);
  return focusIds.has(s) && focusIds.has(t);
}

function _focusEdgeRank(edge, nodeId, nodeById) {
  const s = _edgeEndpointId(edge?.source);
  const t = _edgeEndpointId(edge?.target);
  const otherId = s === nodeId ? t : s;
  const other = nodeById.get(otherId);
  const weight = Number(edge?.weight) || 1;
  return (weight * 10000) + ((other?.importance || 0) * 100) + (other?.mentions || 0);
}

function _focusNeighborhood(nodeId, edges, nodeById) {
  const focusIds = new Set([nodeId]);
  const incident = [];
  for (const edge of edges || []) {
    const s = _edgeEndpointId(edge?.source);
    const t = _edgeEndpointId(edge?.target);
    if (s !== nodeId && t !== nodeId) continue;
    const otherId = s === nodeId ? t : s;
    if (!nodeById.has(otherId)) continue;
    incident.push(edge);
  }
  incident.sort((a, b) => _focusEdgeRank(b, nodeId, nodeById) - _focusEdgeRank(a, nodeId, nodeById));
  for (const edge of incident) {
    if (focusIds.size > FOCUS_NEIGHBOR_LIMIT) break;
    const s = _edgeEndpointId(edge?.source);
    const t = _edgeEndpointId(edge?.target);
    focusIds.add(s === nodeId ? t : s);
  }
  const focusEdges = (edges || [])
    .filter(edge => _focusEdgeVisible(edge, focusIds))
    .sort((a, b) => {
      const ac = _edgeEndpointId(a?.source) === nodeId || _edgeEndpointId(a?.target) === nodeId ? 1 : 0;
      const bc = _edgeEndpointId(b?.source) === nodeId || _edgeEndpointId(b?.target) === nodeId ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (Number(b?.weight) || 1) - (Number(a?.weight) || 1);
    })
    .slice(0, FOCUS_EDGE_LIMIT);
  return { focusIds, focusEdges };
}

function _restoreFocusPositions() {
  if (!_graphFocusState?.positions || !graphData?.nodes) return;
  const byId = new Map(graphData.nodes.map(node => [node.id, node]));
  for (const [id, pos] of _graphFocusState.positions.entries()) {
    const node = byId.get(id);
    if (!node) continue;
    node.x = pos.x;
    node.y = pos.y;
    node.vx = pos.vx || 0;
    node.vy = pos.vy || 0;
    node.fx = pos.fx ?? null;
    node.fy = pos.fy ?? null;
  }
  _needsTick = true;
  _renderTick();
}

function _focusLayoutNodes(centerNode, nodes, edges, opts = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const neighbors = nodes
    .filter(node => node.id !== centerNode.id)
    .sort((a, b) => {
      const ea = edges.find(edge => _edgeEndpointId(edge.source) === a.id || _edgeEndpointId(edge.target) === a.id);
      const eb = edges.find(edge => _edgeEndpointId(edge.source) === b.id || _edgeEndpointId(edge.target) === b.id);
      const ta = String(ea?.type || a.type || '');
      const tb = String(eb?.type || b.type || '');
      if (ta !== tb) return ta.localeCompare(tb);
      return ((b.importance || 0) - (a.importance || 0)) || String(a.id).localeCompare(String(b.id));
    });

  const originX = Number.isFinite(Number(opts.origin?.x))
    ? Number(opts.origin.x)
    : (Number.isFinite(Number(centerNode.x)) ? Number(centerNode.x) : 0);
  const originY = Number.isFinite(Number(opts.origin?.y))
    ? Number(opts.origin.y)
    : (Number.isFinite(Number(centerNode.y)) ? Number(centerNode.y) : 0);
  centerNode.x = originX;
  centerNode.y = originY;
  centerNode.vx = 0;
  centerNode.vy = 0;
  const maxRadius = Math.max(18, ...nodes.map(node => node.radius || 12));
  const spacing = Math.max(86, (maxRadius * 2) + 46);
  const focusAngle = (count, i, ring) => {
    if (count === 1) return -Math.PI * 0.35 + ring * 0.42;
    if (count === 2) return [-Math.PI * 0.74, -Math.PI * 0.22][i] + ring * 0.28;
    if (count === 3) return (-Math.PI * 0.78) + (i * Math.PI * 0.58) + ring * 0.18;
    return ((ring % 2 ? Math.PI / count : 0) - Math.PI / 2) + (i / count) * Math.PI * 2 + ring * 0.09;
  };
  let index = 0;
  let ring = 0;
  while (index < neighbors.length) {
    const radius = 118 + (ring * Math.max(78, spacing * 0.72));
    const capacity = Math.max(6, Math.floor((Math.PI * 2 * radius) / spacing));
    const count = Math.min(capacity, neighbors.length - index);
    for (let i = 0; i < count; i++) {
      const node = neighbors[index + i];
      const angle = focusAngle(count, i, ring);
      const jitter = (_hashUnit(node.id, ring + 17) - 0.5) * Math.min(16, spacing * 0.14);
      node.x = originX + Math.cos(angle) * (radius + jitter);
      node.y = originY + Math.sin(angle) * (radius + jitter);
      node.vx = 0;
      node.vy = 0;
    }
    index += count;
    ring++;
  }

  if (typeof d3 !== 'undefined' && nodes.length > 2) {
    const focusLinks = edges
      .map(edge => {
        const source = byId.get(_edgeEndpointId(edge.source));
        const target = byId.get(_edgeEndpointId(edge.target));
        return source && target ? { source, target } : null;
      })
      .filter(Boolean);
    centerNode.fx = originX;
    centerNode.fy = originY;
    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(focusLinks).distance(edge => {
        const centered = edge.source.id === centerNode.id || edge.target.id === centerNode.id;
        return centered ? 118 : 84;
      }).strength(0.42))
      .force('charge', d3.forceManyBody().strength(-95).distanceMax(260))
      .force('collide', d3.forceCollide(node => (node.radius || 12) + 30).iterations(3))
      .force('x', d3.forceX(node => node.x).strength(0.26))
      .force('y', d3.forceY(node => node.y).strength(0.26))
      .stop();
    for (let i = 0; i < 160; i++) sim.tick();
    centerNode.fx = null;
    centerNode.fy = null;
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
    }
  }
}

function _focusEdgeLabelData(edges) {
  const byConnectionType = new Map();
  for (const edge of edges) {
    const type = String(edge?.type || 'related').trim() || 'related';
    const sourceId = edge?.source?.id || edge?.source || '';
    const targetId = edge?.target?.id || edge?.target || '';
    const pairKey = sourceId < targetId ? `${sourceId}<->${targetId}` : `${targetId}<->${sourceId}`;
    const key = `${pairKey}|${type}`;
    let group = byConnectionType.get(key);
    if (!group) {
      group = { type, edges: [], key, pairKey, representative: null };
      byConnectionType.set(key, group);
    }
    group.edges.push(edge);
    const sx = edge.source?.x ?? 0;
    const sy = edge.source?.y ?? 0;
    const tx = edge.target?.x ?? 0;
    const ty = edge.target?.y ?? 0;
    const length = Math.hypot(tx - sx, ty - sy);
    const current = group.representative;
    const currentLength = current
      ? Math.hypot((current.target?.x ?? 0) - (current.source?.x ?? 0), (current.target?.y ?? 0) - (current.source?.y ?? 0))
      : -1;
    if (!current || length > currentLength) group.representative = edge;
  }
  const pairStacks = new Map();
  return Array.from(byConnectionType.values()).map((group, index) => {
    const edge = group.representative || group.edges?.[0];
    const sourceId = edge?.source?.id || edge?.source || '';
    const targetId = edge?.target?.id || edge?.target || '';
    const pairKey = sourceId < targetId ? `${sourceId}<->${targetId}` : `${targetId}<->${sourceId}`;
    const stackIndex = pairStacks.get(pairKey) || 0;
    pairStacks.set(pairKey, stackIndex + 1);
    return {
      ...group,
      index,
      count: group.edges.length,
      pairKey,
      stackIndex,
      key: group.key,
    };
  });
}

function _focusEdgeLabelText(entry) {
  return `${entry?.type || 'related'}${entry?.count > 1 ? ` ×${entry.count}` : ''}`;
}

function _focusEdgeLabelWidth(entry) {
  const text = _focusEdgeLabelText(entry);
  return Math.max(30, Math.min(128, (text.length * 5.8) + 18));
}

function _updateFocusEdgeLabels() {
  if (!_graphFocusState || !gNodes) return;
  const labelsG = d3.select(gNodes.node().parentNode).select('g.focus-edge-labels');
  if (labelsG.empty()) return;
  const labelScale = 1 / Math.max(1, Number(_currentZoomScale) || 1);
  labelsG.selectAll('g.focus-edge-label')
    .attr('transform', entry => {
      const edge = entry.representative || entry.edge || entry.edges?.[0];
      if (!edge) return 'translate(0,0)';
      const sx = edge.source?.x ?? 0;
      const sy = edge.source?.y ?? 0;
      const tx = edge.target?.x ?? 0;
      const ty = edge.target?.y ?? 0;
      const dx = tx - sx;
      const dy = ty - sy;
      const mx = sx + dx * 0.52;
      const my = sy + dy * 0.52;
      let deg = Math.atan2(dy, dx) * 180 / Math.PI;
      if (deg > 90 || deg < -90) deg += 180;
      const lineOffset = 7 + (entry.stackIndex || 0) * 8;
      return `translate(${mx},${my}) rotate(${deg}) scale(${labelScale}) translate(0,${lineOffset})`;
    });
}

function _fitFocusNodes(nodes, opts = {}) {
  if (!nodes.length || !svg || !zoom) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = (n.radius || 12) + 58;
    if (n.x - r < minX) minX = n.x - r;
    if (n.x + r > maxX) maxX = n.x + r;
    if (n.y - r < minY) minY = n.y - r;
    if (n.y + r > maxY) maxY = n.y + r;
  }
  const w = svg.node().clientWidth || window.innerWidth;
  const h = svg.node().clientHeight || window.innerHeight;
  const pad = 96;
  const sx = (w - pad * 2) / Math.max(80, maxX - minX);
  const sy = (h - pad * 2) / Math.max(80, maxY - minY);
  const scale = Math.max(0.16, Math.min(2.6, Math.min(sx, sy)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const tx = w / 2 - cx * scale;
  const ty = h / 2 - cy * scale;
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
  if (opts.animate === false) svg.call(zoom.transform, transform);
  else svg.transition().duration(420).call(zoom.transform, transform);
}

function _enterGraphStructureFocus(nodeId) {
  if (!nodeId) return;
  if (_webglGraph && graphData?.meta?.mode === 'webgl') {
    _webglFocusGraphOnNode(nodeId, _webglGraph);
    return;
  }
  if (graphData?.meta?.hybridSubset && _hybridFullWebglData) {
    _webglFocusGraphOnNode(nodeId, _hybridSourceStateFromData(), {
      returnToWebglOnUnfocus: false,
      restoreOnUnfocus: {
        data: _cloneGraphForRestore(graphData),
        transform: _currentSvgTransformSnapshot(),
      },
    });
    return;
  }
  _graphStructureTransition(() => _focusGraphOnNode(nodeId, { fitAnimate: false }));
}

function _exitGraphStructureFocus() {
  _graphStructureTransition(() => _unfocusGraph({ animate: false }), { outMs: 110, inMs: 160 });
}

function _focusGraphOnNode(nodeId, opts = {}) {
  if (!gNodes || !gLinks || !graphData) return;
  const priorOrigin = opts.origin || _graphFocusState?.origin || null;
  if (_graphFocusedId) {
    _restoreFocusPositions();
    d3.select(gNodes.node().parentNode).select('g.focus-edge-labels').remove();
  }
  if (simulation) simulation.stop();
  const nodeById = new Map((graphData.nodes || []).map(node => [node.id, node]));
  const centerNode = nodeById.get(nodeId);
  if (!centerNode) return;
  const candidateEdges = (Array.isArray(simLinks) && simLinks.length) ? simLinks : (graphData.edges || []);
  const { focusIds, focusEdges } = _focusNeighborhood(nodeId, candidateEdges, nodeById);
  const focusNodes = (graphData.nodes || []).filter(n => focusIds.has(n.id));
  const originalPositions = new Map(focusNodes.map(n => [n.id, {
    x: n.x,
    y: n.y,
    vx: n.vx || 0,
    vy: n.vy || 0,
    fx: n.fx ?? null,
    fy: n.fy ?? null,
  }]));
  _graphFocusedId = nodeId;
  _graphPreFocusTransform = opts.returnTransform || (svg ? d3.zoomTransform(svg.node()) : null);
  const origin = priorOrigin || {
    x: Number.isFinite(Number(centerNode.x)) ? Number(centerNode.x) : 0,
    y: Number.isFinite(Number(centerNode.y)) ? Number(centerNode.y) : 0,
  };
  _graphFocusState = {
    nodeId,
    nodeIds: focusIds,
    positions: originalPositions,
    edges: focusEdges,
    origin,
    restoreOnUnfocus: opts.restoreOnUnfocus || null,
  };

  _focusLayoutNodes(centerNode, focusNodes, focusEdges, { origin });
  const focusEdgeSet = new Set(focusEdges);

  gNodes.selectAll('g')
    .classed('node-focus-hidden', d => !focusIds.has(d.id))
    .attr('opacity', d => focusIds.has(d.id) ? 1 : 0)
    .style('pointer-events', d => focusIds.has(d.id) ? '' : 'none');
  gLinks.selectAll('line')
    .classed('edge-focus-hidden', d => !focusEdgeSet.has(d))
    .attr('opacity', d => focusEdgeSet.has(d) ? 1 : 0)
    .style('pointer-events', d => focusEdgeSet.has(d) ? '' : 'none');

  // Add edge-type labels along visible edges, oriented in the source→target direction.
  const innerG = d3.select(gNodes.node().parentNode);
  let labelsG = innerG.select('g.focus-edge-labels');
  if (labelsG.empty()) labelsG = innerG.append('g').attr('class', 'focus-edge-labels');
  const labelGroups = labelsG.selectAll('g.focus-edge-label')
    .data(_focusEdgeLabelData(focusEdges), d => d.key)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'focus-edge-label');
        g.append('text')
          .attr('class', 'focus-edge-label-text')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central');
        return g;
      },
      update => update,
      exit => exit.remove()
    );
  labelGroups.select('rect.focus-edge-label-bg').remove();
  labelGroups.select('text.focus-edge-label-text')
    .attr('y', 0.4)
    .text(d => _focusEdgeLabelText(d));

  _needsTick = true;
  _renderTick();
  _queueEdgeConnectAnimation(gLinks.selectAll('line').filter(d => focusEdgeSet.has(d)));
  _fitFocusNodes(focusNodes, { animate: opts.fitAnimate !== false });
  _scheduleViewportCulling(true);
  _scheduleLabelLayout(true);
}

function _unfocusGraph(opts = {}) {
  if (!_graphFocusedId) return;
  const restoreOnUnfocus = _graphFocusState?.restoreOnUnfocus || null;
  const returnToWebgl = !!(
    graphData?.meta?.hybridFocus
    && graphData?.meta?.returnToWebglOnUnfocus !== false
    && _hybridFullWebglData
  );
  const returnTransform = _graphPreFocusTransform;
  if (restoreOnUnfocus?.data) {
    _graphFocusedId = null;
    _graphFocusState = null;
    _graphPreFocusTransform = null;
    initGraph(_cloneGraphForRestore(restoreOnUnfocus.data), {
      initialTransform: restoreOnUnfocus.transform || returnTransform,
      preserveCamera: true,
      hybridSwitch: true,
    });
    _hybridLastSwitchAt = performance.now();
    return;
  }
  _restoreFocusPositions();
  _graphFocusedId = null;
  _graphFocusState = null;
  if (gNodes) gNodes.selectAll('g').classed('node-focus-hidden', false).attr('opacity', 1).style('pointer-events', '');
  if (gLinks) gLinks.selectAll('line').classed('edge-focus-hidden', false).attr('opacity', 1).style('pointer-events', '');
  if (gNodes) {
    const innerG = d3.select(gNodes.node().parentNode);
    innerG.select('g.focus-edge-labels').remove();
  }
  if (svg && zoom && _graphPreFocusTransform) {
    if (opts.animate === false) svg.call(zoom.transform, _graphPreFocusTransform);
    else svg.transition().duration(450).call(zoom.transform, _graphPreFocusTransform);
  }
  _graphPreFocusTransform = null;
  if (returnToWebgl) _hybridSwitchToWebglFromSvg(returnTransform);
}

function closePanel() {
  clearGraphSelection();
}

function _aspectDisplayKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _attrDisplayKey(attr) {
  const content = typeof attr === 'string' ? attr : attr?.content;
  return String(content || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function dedupeNodeAspects(aspects = []) {
  const out = [];
  const byName = new Map();
  for (const aspect of aspects || []) {
    const key = _aspectDisplayKey(aspect?.name);
    if (!key) continue;
    let merged = byName.get(key);
    if (!merged) {
      merged = {
        ...aspect,
        name: String(aspect.name || '').trim(),
        weight: Number(aspect.weight) || 5,
        attributes: [],
        duplicateIds: [],
      };
      byName.set(key, merged);
      out.push(merged);
    } else {
      merged.weight = Math.max(Number(merged.weight) || 5, Number(aspect.weight) || 5);
    }
    if (aspect?.id != null && !merged.duplicateIds.includes(aspect.id)) merged.duplicateIds.push(aspect.id);
    const seenAttrs = merged._seenAttrs || (merged._seenAttrs = new Set());
    for (const attr of aspect?.attributes || []) {
      const attrKey = _attrDisplayKey(attr);
      if (!attrKey || seenAttrs.has(attrKey)) continue;
      seenAttrs.add(attrKey);
      merged.attributes.push(attr);
    }
  }
  for (const aspect of out) {
    aspect.duplicateCount = aspect.duplicateIds.length;
    delete aspect._seenAttrs;
  }
  return out;
}
window.dedupeNodeAspects = dedupeNodeAspects;

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
  function valIn(s) { return s?.in ?? s?.input ?? 0; }
  function valOut(s) { return s?.out ?? s?.output ?? 0; }
  function valCost(s) { return s?.totalCost ?? null; }

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
    .sort((a, b) => (valIn(b[1]) + valOut(b[1])) - (valIn(a[1]) + valOut(a[1])));
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
            <td style="padding:4px 0;color:var(--text-dim)">${esc(ch)}</td>
            <td style="text-align:right;color:var(--accent2)">${fmtN(valIn(s))}</td>
            <td style="text-align:right;color:var(--accent3)">${fmtN(valOut(s))}</td>
            <td style="text-align:right">${fmtN(s.calls)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const rates = data.costRates || {};
  const modelRows = Object.entries(data.byModel || {})
    .sort((a, b) => (valIn(b[1]) + valOut(b[1])) - (valIn(a[1]) + valOut(a[1])));
  const modelTable = modelRows.length ? `
    <div class="section">
      <div class="section-title">By Model (all time)</div>
      <table style="width:100%;font-size:0.72rem;font-family:var(--font-body);border-collapse:collapse;table-layout:fixed">
        <thead><tr style="color:var(--text-dim);font-size:0.62rem">
          <th style="text-align:left;padding:3px 0;width:42%">model</th>
          <th style="text-align:right">in</th>
          <th style="text-align:right">out</th>
          <th style="text-align:right">calls</th>
          <th style="text-align:right">cost</th>
        </tr></thead>
        <tbody>
          ${modelRows.map(([model, s]) => `<tr style="border-top:1px solid var(--border)">
            <td title="${escAttr(model)}" style="padding:5px 6px 5px 0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(model)}</td>
            <td style="text-align:right;color:var(--accent2)">${fmtN(valIn(s))}</td>
            <td style="text-align:right;color:var(--accent3)">${fmtN(valOut(s))}</td>
            <td style="text-align:right">${fmtN(s.calls)}</td>
            <td style="text-align:right;color:var(--warn)">${fmtCost(valCost(s))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const pricingText = JSON.stringify(data.pricing || { default: rates }, null, 2);
  const pricingEditor = `
    <div class="section">
      <div class="section-title">Pricing Baselines</div>
      <div style="color:var(--text-dim);font-size:0.72rem;line-height:1.35;margin-bottom:8px">
        USD per million tokens. Use <code>default</code>, exact model refs like <code>openai/gpt-5.5</code>, or provider wildcards like <code>openai/*</code>.
      </div>
      <textarea id="token-pricing-json" spellcheck="false" style="width:100%;min-height:150px;box-sizing:border-box;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font:0.72rem/1.4 var(--font-mono);resize:vertical">${esc(pricingText)}</textarea>
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <button id="token-pricing-save" class="btn btn-save" type="button">Save pricing</button>
        <span id="token-pricing-status" style="color:var(--text-dim);font-size:0.7rem"></span>
      </div>
    </div>`;

  body.innerHTML = `
    <div style="font-size:0.65rem;color:var(--text-dim);font-family:var(--font-body);margin-bottom:12px">
      default estimate @ $${rates.inputPerM}/M in · $${rates.outputPerM}/M out
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
    ${modelTable}
    ${channelTable}
    ${pricingEditor}
  `;

  const pricingSave = body.querySelector('#token-pricing-save');
  const pricingStatus = body.querySelector('#token-pricing-status');
  pricingSave?.addEventListener('click', async () => {
    const raw = body.querySelector('#token-pricing-json')?.value || '{}';
    let pricing;
    try {
      pricing = JSON.parse(raw);
      if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new Error('Pricing must be a JSON object');
    } catch (e) {
      if (pricingStatus) {
        pricingStatus.textContent = e.message;
        pricingStatus.style.color = 'var(--danger)';
      }
      return;
    }
    try {
      pricingSave.disabled = true;
      if (pricingStatus) {
        pricingStatus.textContent = 'saving…';
        pricingStatus.style.color = 'var(--text-dim)';
      }
      const res = await fetch(API + '/api/tokens/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) throw new Error(out.error || `HTTP ${res.status}`);
      await renderTokenDashboard(body);
    } catch (e) {
      pricingSave.disabled = false;
      if (pricingStatus) {
        pricingStatus.textContent = e.message;
        pricingStatus.style.color = 'var(--danger)';
      }
    }
  });
}

// ── Editor Panel Rendering ──
function _fmtGraphCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : String(value || 0);
}

function renderAggregatePanel(node, body) {
  const extra = node.extra || {};
  const memberCount = extra.memberCount ?? node.mentions ?? 0;
  const internalEdgeCount = extra.internalEdgeCount ?? 0;
  const panelEdges = (graphData.edges && graphData.edges.length) ? graphData.edges : (node._detailEdges || []);
  const outEdges = panelEdges.filter(e => (e.source.id || e.source) === node.id);
  const inEdges = panelEdges.filter(e => (e.target.id || e.target) === node.id);
  const linked = outEdges.concat(inEdges).slice(0, 12);
  body.innerHTML = `
    <div class="section">
      <div class="section-title">Overview Group</div>
      <div class="field"><label>Represents</label><input value="${esc(_fmtGraphCount(memberCount))} nodes" disabled></div>
      <div class="field"><label>Type</label><input value="${esc(extra.type || node.type || 'unknown')}" disabled></div>
      <div class="field"><label>Internal edges</label><input value="${esc(_fmtGraphCount(internalEdgeCount))}" disabled></div>
      <div style="color:var(--text-dim);font-size:0.8rem;line-height:1.45;margin-top:6px">${esc(node.description || '')}</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-save" data-action="expand-aggregate" data-root="${escAttr(node.id)}">open type slice</button>
        <button class="btn" data-action="load-full-graph">load all raw nodes</button>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Visible Group Links</div>
      ${linked.map(e => {
        const sourceId = e.source.id || e.source;
        const targetId = e.target.id || e.target;
        const otherId = sourceId === node.id ? targetId : sourceId;
        const direction = sourceId === node.id ? '→' : '←';
        return `
          <div class="edge-item">
            <span class="edge-type">${esc(e.type || 'linked')}</span>
            <span>${direction}</span>
            <span class="edge-target" data-action="navigate" data-id="${escAttr(otherId)}">${esc(getNodeLabel(otherId))}</span>
            ${e.count ? `<span style="margin-left:auto;color:var(--text-dim);font-size:0.7rem">${esc(_fmtGraphCount(e.count))}</span>` : ''}
          </div>`;
      }).join('') || '<div style="color:var(--text-dim);font-size:0.8rem">No visible group links</div>'}
    </div>
  `;
}

function _panelEdgeGroups(edges, nodeId, direction) {
  const byType = new Map();
  for (const edge of edges || []) {
    const type = String(edge?.type || 'linked').trim() || 'linked';
    let group = byType.get(type);
    if (!group) {
      group = { type, direction, edges: [], peers: [] };
      byType.set(type, group);
    }
    const sourceId = edge.source?.id || edge.source;
    const targetId = edge.target?.id || edge.target;
    const peerId = direction === 'out' ? targetId : sourceId;
    group.edges.push(edge);
    if (peerId && !group.peers.includes(peerId)) group.peers.push(peerId);
  }
  return Array.from(byType.values()).sort((a, b) => (b.edges.length - a.edges.length) || a.type.localeCompare(b.type));
}

function _panelEdgeGroupHtml(group, nodeId) {
  const count = group.edges.length;
  const shownPeers = group.peers.slice(0, 8);
  const peerText = shownPeers.map(id => getNodeLabel(id)).join(', ');
  const overflow = group.peers.length > shownPeers.length ? ` +${group.peers.length - shownPeers.length} more` : '';
  const first = group.edges[0] || {};
  const sourceId = first.source?.id || first.source;
  const targetId = first.target?.id || first.target;
  const canDeleteOne = count === 1 && sourceId && targetId;
  if (group.direction === 'out') {
    return `
      <div class="edge-item">
        <span class="edge-type">${esc(group.type)}${count > 1 ? ` ×${count}` : ''}</span>
        <span>→</span>
        <span class="edge-target">${esc(peerText || '(none)')}${esc(overflow)}</span>
        ${canDeleteOne ? `<button class="btn btn-danger" style="font-size:0.5rem;padding:1px 4px;margin-left:auto"
          data-action="delete-edge" data-source="${escAttr(sourceId)}" data-target="${escAttr(targetId)}" data-type="${escAttr(group.type)}">×</button>` : ''}
      </div>`;
  }
  return `
    <div class="edge-item">
      <span class="edge-target">${esc(peerText || '(none)')}${esc(overflow)}</span>
      <span>→</span>
      <span class="edge-type">${esc(group.type)}${count > 1 ? ` ×${count}` : ''}</span>
      <span>→ this</span>
    </div>`;
}

function renderPanel(node) {
  document.querySelector('#panel-title h2').textContent = node.label;
  document.querySelector('#panel-title .node-type').textContent = node.type;
  document.querySelector('#panel-title .node-type').style.color = getColor(node.type);

  const body = document.getElementById('panel-body');

  if (node.id === 'spore-token-log') {
    renderTokenDashboard(body);
    return;
  }

  if (node?.extra?.aggregate) {
    renderAggregatePanel(node, body);
    return;
  }

  const panelEdges = (graphData.edges && graphData.edges.length) ? graphData.edges : (node._detailEdges || []);
  const outEdges = panelEdges.filter(e => (e.source.id || e.source) === node.id);
  const inEdges = panelEdges.filter(e => (e.target.id || e.target) === node.id);
  const displayAspects = dedupeNodeAspects(node.aspects || []);
  const detailsLoading = !node._detailsLoaded;
  const outEdgeGroups = _panelEdgeGroups(outEdges, node.id, 'out');
  const inEdgeGroups = _panelEdgeGroups(inEdges, node.id, 'in');

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
        ${detailsLoading
          ? `<div style="color:var(--text-dim);font-size:0.8rem">Loading node details...</div>`
          : displayAspects.map((a, i) => `
          <div class="aspect-card" data-aspect-idx="${i}">
            <div class="aspect-header">
              <span class="aspect-name">${esc(a.name)}</span>
              <span class="aspect-weight">w:${a.weight||5}${a.duplicateCount > 1 ? ` · ${a.duplicateCount} merged` : ''}
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
      ${outEdgeGroups.map(group => _panelEdgeGroupHtml(group, node.id)).join('')}
      ${inEdgeGroups.map(group => _panelEdgeGroupHtml(group, node.id)).join('')}
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
  if (n) {
    selectNode(n);
    if (typeof window._webglCenterNode === 'function') window._webglCenterNode(id);
  }
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
    let node = graphData.nodes.find(n => n.id === nodeId);
    if (!node?._detailsLoaded) {
      try { node = (await fetchNodeDetails(nodeId)).node; } catch {}
    }
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
  const fresh = await fetchNodeDetails(nodeId);
  const node = fresh.node;
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
  if (data?.meta?.mode === 'webgl') { initWebglGraph(data); return; }
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
  else if (action === 'expand-aggregate') loadGraphMode('slice', el.dataset.root);
  else if (action === 'load-full-graph') loadGraphMode('full');
});
document.getElementById('panel-body')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-action="add-attr"]');
  if (!el) return;
  doAddAttr(el.dataset.nodeId, el.dataset.name, el, parseInt(el.dataset.weight));
});

// ── Top-level Controls ──
// panel-close handled by rp-close
document.getElementById('btn-new-node').onclick = showNewNodeModal;
document.getElementById('btn-center')?.addEventListener('click', () => {
  if (typeof window._fitWebglGraph === 'function' && window._fitWebglGraph()) return;
  if (_fitSharedGraphLayout(graphData, { animate: true })) return;
  if (svg && zoom) svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity);
});

// Unified visibility predicate. Each filter (type dropdown, timeline
// slider) writes its current state into _graphFilterState and calls
// _applyGraphFilters(). Marquee selection consults _isNodeVisible so
// dimmed nodes can't be picked up. Without this, multi-select silently
// includes the very nodes the user has filtered away.
window._graphFilterState = {
  typeFilter: '',     // '' = no type filter
  timeMin: null,      // ms or null
  timeMax: null,      // ms or null
  searchQuery: '',    // lowercased substring; '' = no search filter
};
window._isNodeVisible = function (node) {
  if (!node) return true;
  const s = window._graphFilterState;
  if (s.typeFilter && node.type !== s.typeFilter) return false;
  if (s.timeMin != null || s.timeMax != null) {
    const t = _graphNodeCreatedMs(node);
    if (t == null) return false;
    if (s.timeMin != null && t < s.timeMin) return false;
    if (s.timeMax != null && t > s.timeMax) return false;
  }
  if (s.searchQuery) {
    const q = s.searchQuery;
    const hit = (node.label || '').toLowerCase().includes(q)
      || String(node.id || '').toLowerCase().includes(q)
      || String(node.type || '').toLowerCase().includes(q)
      || (node.description || '').toLowerCase().includes(q);
    if (!hit) return false;
  }
  return true;
};
window._applyGraphFilters = function () {
  if (typeof window._webglApplyFilters === 'function' && window._webglApplyFilters()) return;
  if (typeof gNodes === 'undefined' || !gNodes) return;
  if (typeof graphData === 'undefined' || !graphData?.nodes) return;
  // We dim filtered-out nodes by setting inline `style.opacity`, with
  // !important so it beats every existing rule (class rules like
  // `.node-temp { opacity: 0.7 }`, `.node-faded { opacity: 0.22 }`,
  // and any future ones we don't know about). For visible nodes we
  // CLEAR the inline so those class rules can still apply (temp
  // nodes should keep their 0.7 transient look while visible).
  gNodes.selectAll('g').each(function (d) {
    if (window._isNodeVisible(d)) {
      this.style.removeProperty('opacity');
      this.style.removeProperty('pointer-events');
    } else {
      this.style.setProperty('opacity', '0.08', 'important');
      this.style.setProperty('pointer-events', 'none', 'important');
    }
  });
  const nodeById = new Map(graphData.nodes.map(n => [n.id, n]));
  gLinks.selectAll('line').each(function (d) {
    const sId = d.source?.id || d.source;
    const tId = d.target?.id || d.target;
    const sn = nodeById.get(sId);
    const tn = nodeById.get(tId);
    const visible = !sn || !tn || (window._isNodeVisible(sn) && window._isNodeVisible(tn));
    if (visible) {
      this.style.removeProperty('opacity');
      this.style.removeProperty('pointer-events');
    } else {
      this.style.setProperty('opacity', '0.04', 'important');
      this.style.setProperty('pointer-events', 'none', 'important');
    }
  });
  if (typeof _scheduleViewportCulling === 'function') _scheduleViewportCulling(true);
  if (typeof _scheduleLabelLayout === 'function') _scheduleLabelLayout();
  if (graphData?.meta?.hybridSubset) _scheduleHybridEvaluation();
};

// ── Timeline filter ────────────────────────────────────────────────
// Dual-range slider over [oldestNode.created, newestNode.created]. The
// slider position is mapped onto unix-epoch ms; nodes whose `created`
// falls outside [minMs, maxMs] are dimmed (same opacity treatment as
// the type filter). Edges fade if either endpoint is dimmed.
//
// Why a dual-range and not a single threshold: dragging only the left
// thumb to "isolate recently-added nodes" is the primary use, BUT the
// right thumb lets you clip a window in the past too (e.g. "what got
// added between yesterday and the day before"). The right thumb is
// optional — leaving it at max disables that clip.
(() => {
  const wrap = document.getElementById('timeline-filter');
  if (!wrap) return;
  const minInp = document.getElementById('tlf-min');
  const maxInp = document.getElementById('tlf-max');
  const fill = document.getElementById('tlf-fill');
  const readout = document.getElementById('tlf-readout');
  const RES = 1000;  // slider granularity (matches min/max attrs)
  const baseTitle = wrap.getAttribute('title') || '';

  let _tlfMs = { oldest: null, newest: null };
  let _tlfDegenerate = false;

  function _refreshBounds() {
    if (typeof graphData === 'undefined' || !graphData?.nodes) return;
    let lo = Infinity, hi = -Infinity;
    let datedCount = 0;
    for (const n of graphData.nodes) {
      const t = _graphNodeCreatedMs(n);
      if (t == null) continue;
      datedCount += 1;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || datedCount === 0) {
      _tlfMs = { oldest: null, newest: null };
      _tlfDegenerate = false;
      wrap.dataset.degenerate = 'false';
      minInp.disabled = false;
      maxInp.disabled = false;
      wrap.title = baseTitle;
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    _tlfMs = { oldest: lo, newest: hi };
    _tlfDegenerate = hi === lo;
    wrap.dataset.degenerate = _tlfDegenerate ? 'true' : 'false';
    minInp.disabled = _tlfDegenerate;
    maxInp.disabled = _tlfDegenerate;
    wrap.title = _tlfDegenerate
      ? 'Timeline filter is visible but disabled because every node in this graph has the same creation timestamp. It will activate after nodes are added at different times.'
      : baseTitle;
  }

  function _clampMs(ms) {
    const { oldest, newest } = _tlfMs;
    return Math.max(oldest, Math.min(newest, ms));
  }

  function _slotToMs(v) {
    const { oldest, newest } = _tlfMs;
    if (oldest == null) return null;
    if (newest === oldest) return oldest;
    return oldest + (newest - oldest) * (Number(v) / RES);
  }

  function _msToSlot(ms) {
    const { oldest, newest } = _tlfMs;
    if (oldest == null || newest == null || newest === oldest) return 0;
    return Math.max(0, Math.min(RES, Math.round(((ms - oldest) / (newest - oldest)) * RES)));
  }

  function _fmtRange(minMs, maxMs) {
    const { oldest, newest } = _tlfMs;
    if (oldest == null) return '';
    if (_tlfDegenerate) {
      const dt = new Date(oldest);
      const day = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `single: ${day} ${time}`;
    }
    const fullDays = (newest - oldest) / 86400000;
    const fmt = (ms) => {
      if (fullDays < 2) {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
    };
    return `${fmt(minMs)} → ${fmt(maxMs)}`;
  }

  function _applyFilter() {
    if (typeof graphData === 'undefined' || !graphData) return;
    if (_tlfMs.oldest == null || _tlfDegenerate) {
      window._graphFilterState.timeMin = null;
      window._graphFilterState.timeMax = null;
      readout.textContent = _tlfDegenerate ? _fmtRange(_tlfMs.oldest, _tlfMs.newest) : '';
      fill.style.left = '0%';
      fill.style.width = '100%';
      wrap.dataset.active = 'false';
    } else {
      const minMs = _slotToMs(minInp.value);
      const maxMs = _slotToMs(maxInp.value);
      // If the slider is at its endpoints (full range), null out the
      // filter state so _isNodeVisible doesn't even check timestamps.
      const atFullRange = Number(minInp.value) === 0 && Number(maxInp.value) === RES;
      window._graphFilterState.timeMin = atFullRange ? null : minMs;
      window._graphFilterState.timeMax = atFullRange ? null : maxMs;
      readout.textContent = _fmtRange(minMs, maxMs);
      const a = (Number(minInp.value) / RES) * 100;
      const b = (Number(maxInp.value) / RES) * 100;
      fill.style.left = a + '%';
      fill.style.width = Math.max(0, b - a) + '%';
      wrap.dataset.active = atFullRange ? 'false' : 'true';
    }
    if (typeof window._applyGraphFilters === 'function') window._applyGraphFilters();
  }

  // Keep the min thumb < max thumb; nudge the other one if they cross.
  function _onMinInput() {
    if (_tlfDegenerate) return;
    if (Number(minInp.value) > Number(maxInp.value) - 5) {
      minInp.value = Math.max(0, Number(maxInp.value) - 5);
    }
    _applyFilter();
  }
  function _onMaxInput() {
    if (_tlfDegenerate) return;
    if (Number(maxInp.value) < Number(minInp.value) + 5) {
      maxInp.value = Math.min(RES, Number(minInp.value) + 5);
    }
    _applyFilter();
  }

  minInp.addEventListener('input', _onMinInput);
  maxInp.addEventListener('input', _onMaxInput);
  wrap.addEventListener('dblclick', () => {
    minInp.value = 0;
    maxInp.value = RES;
    _applyFilter();
  });

  // Refresh when the graph data changes. Preserve active windows as
  // absolute time ranges; if a handle was pinned to either endpoint,
  // keep it pinned so new newest nodes are not accidentally clipped.
  window._tlfRefresh = () => {
    const state = window._graphFilterState || {};
    const prior = {
      active: state.timeMin != null || state.timeMax != null,
      min: state.timeMin,
      max: state.timeMax,
      leftPinned: Number(minInp.value) === 0,
      rightPinned: Number(maxInp.value) === RES,
    };
    _refreshBounds();
    if (_tlfMs.oldest != null && !_tlfDegenerate) {
      if (prior.active) {
        let nextMin = prior.leftPinned || prior.min == null ? _tlfMs.oldest : _clampMs(prior.min);
        let nextMax = prior.rightPinned || prior.max == null ? _tlfMs.newest : _clampMs(prior.max);
        if (nextMax <= nextMin) {
          const minGap = (_tlfMs.newest - _tlfMs.oldest) * (5 / RES);
          if (prior.rightPinned) nextMin = Math.max(_tlfMs.oldest, nextMax - minGap);
          else nextMax = Math.min(_tlfMs.newest, nextMin + minGap);
        }
        minInp.value = _msToSlot(nextMin);
        maxInp.value = _msToSlot(nextMax);
        if (Number(minInp.value) > Number(maxInp.value) - 5) {
          minInp.value = Math.max(0, Number(maxInp.value) - 5);
        }
      } else {
        minInp.value = 0;
        maxInp.value = RES;
      }
    } else {
      minInp.value = 0;
      maxInp.value = RES;
    }
    _applyFilter();
  };

  // Initial bounds (in case render fired before this script loaded).
  _refreshBounds();
  _applyFilter();
})();
