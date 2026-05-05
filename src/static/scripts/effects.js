// effects.js — Spore activity tracker, F01 six-petal mark animation engine,
// graph node-selection state, type/color/shape helpers (getColor/getNodeShape/etc.),
// toast helper. Loaded BEFORE graph.js so its helpers are in scope at graph.js's top level.
// Wait — graph.js loads before this currently; that is OK because graph.js's function
// bodies only resolve identifiers at call time, well after all defer scripts have run.
// Extracted from src/static/scripts/app.js (was lines 2123-3869 of the post-Phase-2 monolith).

// ── Spore activity tracker ──────────────────────────────────────────────
// Tracks whatever subsystems are currently doing work (chat, learner,
// session summarize/distill, tools…) and reflects it visually as a pulse
// on the agent's `self` node in the graph. Multiple activities can be
// active at once; the visual stays on until all have ended.
//
// Stale-source watchdog: each source carries the timestamp it was last
// touched (start OR end). Every SPORE_WATCHDOG_TICK ms we evict any
// source whose timestamp is older than SPORE_SOURCE_TTL — this recovers
// quickly when a `*:done` frame is lost (network drop, server crash,
// upstream throwing without our catch path emitting done) instead of
// waiting on the global 5-minute safety timer.
const _sporeActiveSources = new Map();          // source → lastTouchedMs
let _sporeActivitySafetyTimer = null;
let _sporeLastEventAt = 0;
let _sporeLastEventOp = '';                     // last source that fired
let _chatLastDoneAt = 0;                        // for stragglers guard
const SPORE_SOURCE_TTL = 90 * 1000;
const SPORE_WATCHDOG_TICK = 15 * 1000;

// Activity transitions are debounced: if the source set briefly empties
// (e.g. chat:done arrives just before learner:start) we don't want to
// fire idle → active back-to-back. We commit the idle state only if
// we've actually been idle for SPORE_IDLE_DEBOUNCE ms.
let _sporeActiveLast = false;
let _sporeIdleTimer = null;
const SPORE_IDLE_DEBOUNCE = 700;
function _sporeActivityCommit(active) {
  if (active === _sporeActiveLast) return;
  _sporeActiveLast = active;
  document.body.classList.toggle('spore-active', active);
  _selfAnimSetActive(active);
  // Diagnostic — surfaces whether we transitioned because of a clean
  // *:done frame, the watchdog, or the safety timer. Look in devtools
  // console after a stuck-active episode to see what cleared it.
  try {
    console.log(`[spore-activity] ${active ? 'active' : 'idle'} | last-event=${_sporeLastEventOp || '(none)'} (${_sporeLastEventAt ? Math.round((Date.now() - _sporeLastEventAt)/1000) + 's ago' : 'never'}) | sources=[${[..._sporeActiveSources.keys()].join(', ')}]`);
  } catch {}
}
function _sporeActivitySync() {
  const rawActive = _sporeActiveSources.size > 0;
  if (rawActive) {
    if (_sporeIdleTimer) { clearTimeout(_sporeIdleTimer); _sporeIdleTimer = null; }
    _sporeActivityCommit(true);
  } else if (_sporeActiveLast && !_sporeIdleTimer) {
    _sporeIdleTimer = setTimeout(() => {
      _sporeIdleTimer = null;
      if (_sporeActiveSources.size === 0) _sporeActivityCommit(false);
    }, SPORE_IDLE_DEBOUNCE);
  }
}
// Sweep stale sources. Runs once every SPORE_WATCHDOG_TICK regardless
// of activity — cheap. If anything was evicted, sync so the visual
// catches up.
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [k, ts] of _sporeActiveSources) {
    if (now - ts > SPORE_SOURCE_TTL) {
      _sporeActiveSources.delete(k);
      evicted++;
      try { console.warn(`[spore-activity] watchdog evicted ${k} (last touch ${Math.round((now - ts)/1000)}s ago)`); } catch {}
    }
  }
  if (evicted) {
    _sporeLastEventOp = 'watchdog';
    _sporeLastEventAt = now;
    _sporeActivitySync();
  }
}, SPORE_WATCHDOG_TICK);

// ── F01 Six-petal mark — animation engine ───────────────────────────
// Spec lives in the spore logo + node design spec.
// One rAF loop drives the self-node geometry through one of 11 named
// behaviors from the design system (A01-A12 minus the one-shot Spawn).
// Each anim is a pure function of (R, t) → geometry. The engine lerps
// between the previous and current animations' geometries over a
// FLOWER_FADE_MS window so transitions ease in/out smoothly instead
// of snapping when the animation switches. Random pick on each
// idle⇄active transition (and re-roll on subsequent transitions) so
// it never feels canned.
const _SELF_ANGLES = [];
for (let i = 0; i < 6; i++) _SELF_ANGLES.push(-Math.PI / 2 + (i / 6) * Math.PI * 2);
const _easeInOut = t => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
const FLOWER_FADE_MS = 700;

function _emptyGeom() {
  const spokes = [], petals = [], halos = [];
  for (let i = 0; i < 6; i++) {
    spokes.push({ x2: 0, y2: 0, sw: 0, opacity: 0 });
    petals.push({ cx: 0, cy: 0, r: 0, opacity: 0 });
    halos.push({ cx: 0, cy: 0, r: 0, opacity: 0, mode: 'stroke', sw: 0 });
  }
  return { spokes, petals, halos, center: { r: 0, opacity: 1 } };
}

// Lerp two geom snapshots. Categorical fields (halo mode) can't blend
// linearly — fade prev's halos out by p=0.5, fade new's halos in over
// the second half so the mode swap happens while the halo is invisible.
function _lerpGeom(a, b, p) {
  const lerp = (x, y) => x + (y - x) * p;
  const out = _emptyGeom();
  for (let i = 0; i < 6; i++) {
    out.spokes[i] = {
      x2: lerp(a.spokes[i].x2, b.spokes[i].x2),
      y2: lerp(a.spokes[i].y2, b.spokes[i].y2),
      sw: lerp(a.spokes[i].sw, b.spokes[i].sw),
      opacity: lerp(a.spokes[i].opacity, b.spokes[i].opacity),
    };
    out.petals[i] = {
      cx: lerp(a.petals[i].cx, b.petals[i].cx),
      cy: lerp(a.petals[i].cy, b.petals[i].cy),
      r:  lerp(a.petals[i].r,  b.petals[i].r),
      opacity: lerp(a.petals[i].opacity, b.petals[i].opacity),
    };
    if (p < 0.5) {
      out.halos[i] = { ...a.halos[i], opacity: a.halos[i].opacity * (1 - p * 2) };
    } else {
      out.halos[i] = { ...b.halos[i], opacity: b.halos[i].opacity * (p * 2 - 1) };
    }
  }
  out.center = {
    r: lerp(a.center.r, b.center.r),
    opacity: lerp(a.center.opacity, b.center.opacity),
  };
  return out;
}

function _writeGeom(sel, g) {
  for (let i = 0; i < 6; i++) {
    const sp = g.spokes[i], pt = g.petals[i], ha = g.halos[i];
    sel.select(`.self-spoke[data-i="${i}"]`)
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', sp.x2).attr('y2', sp.y2)
      .attr('stroke-width', sp.sw)
      .attr('opacity', sp.opacity);
    sel.select(`.self-petal[data-i="${i}"]`)
      .attr('cx', pt.cx).attr('cy', pt.cy).attr('r', pt.r)
      .attr('opacity', pt.opacity);
    const halo = sel.select(`.self-halo[data-i="${i}"]`);
    if (ha.mode === 'fill') {
      halo.attr('fill', 'var(--spore-amber)').attr('stroke', 'none');
    } else {
      halo.attr('fill', 'none').attr('stroke', 'var(--spore-amber)')
          .attr('stroke-width', ha.sw);
    }
    halo.attr('cx', ha.cx).attr('cy', ha.cy).attr('r', ha.r)
        .attr('opacity', ha.opacity);
  }
  sel.select('.self-center').attr('r', g.center.r).attr('opacity', g.center.opacity);
}

const _FLOWER_ANIMS = {
  // ── Idle pool ──────────────────────────────────────────────────────
  wobble: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const off = Math.sin(t * 1.8 + i * 1.1) * 0.04 * R;
      const x = ringR * Math.cos(a) + Math.cos(a + Math.PI/2) * off;
      const y = ringR * Math.sin(a) + Math.sin(a + Math.PI/2) * off;
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  breathe: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, sw = R * 0.04;
    const cycle = 2.4;
    const p = (t % cycle) / cycle;
    const breath = 0.5 + 0.5 * Math.sin(p * Math.PI * 2);
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: R * (0.13 + breath * 0.05), opacity: 1 };
    return g;
  }},
  flicker: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      const flick = 0.55 + 0.45 * Math.sin(t * 4 + i * 13.7);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: flick };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  inhale: { kind: 'idle', fn: (R, t) => {
    const g = _emptyGeom();
    const petalR = R * 0.16, centerR = R * 0.18, sw = R * 0.04;
    const cycle = 3.0;
    const p = (t % cycle) / cycle;
    let r;
    if (p < 0.4)      r = 0.62 - _easeInOut(p / 0.4) * 0.30;
    else if (p < 0.5) r = 0.32;
    else if (p < 0.9) r = 0.32 + _easeInOut((p - 0.5) / 0.4) * 0.30;
    else              r = 0.62;
    const ringR = R * r;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  // ── Active pool ────────────────────────────────────────────────────
  bloom: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const centerR = R * 0.18, sw = R * 0.04;
    const cycle = 4.0;
    const p = (t % cycle) / cycle;
    let amp;
    if (p < 0.4)      amp = _easeInOut(p / 0.4);
    else if (p < 0.7) amp = 1;
    else              amp = _easeInOut(1 - (p - 0.7) / 0.3);
    const ringR = R * (0.18 + amp * 0.46);
    const petalR = R * (0.06 + amp * 0.10);
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: amp };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  seqbloom: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 3.0;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const slot = i / 6;
      const local = (p - slot + 1) % 1;
      const lit = local < 0.6;
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: lit ? 1 : 0.18 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: lit ? 1 : 0.18 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  pulseOut: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 1.4;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 0.6 + p * 0.4 };
      const bulletR = R * (0.05 + (1 - p) * 0.03);
      g.halos[i] = { cx: x * p, cy: y * p, r: bulletR, opacity: 1 - p * 0.4, mode: 'fill', sw: 0 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  pulseIn: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, sw = R * 0.03;
    const cycle = 1.4;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const bulletR = R * (0.05 + p * 0.04);
      g.halos[i] = { cx: x * (1 - p), cy: y * (1 - p), r: bulletR, opacity: 1 - (1 - p) * 0.4, mode: 'fill', sw: 0 };
    }
    g.center = { r: R * (0.16 + (1 - p) * 0.04), opacity: 1 };
    return g;
  }},
  rotation: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const angOff = (t * 18 * Math.PI) / 180;  // 18°/s
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i] + angOff;
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  listen: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 2.0;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const slot = i / 6;
      const local = (p - slot + 1) % 1;
      const halo = local < 0.4 ? 1 - local / 0.4 : 0;
      const haloR = R * (0.13 + halo * 0.18);
      g.halos[i] = { cx: x, cy: y, r: haloR, opacity: halo, mode: 'stroke', sw: R * 0.025 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
  rings: { kind: 'active', fn: (R, t) => {
    const g = _emptyGeom();
    const ringR = R * 0.62, petalR = R * 0.13, centerR = R * 0.18, sw = R * 0.03;
    const cycle = 2.5;
    const p = (t % cycle) / cycle;
    for (let i = 0; i < 6; i++) {
      const a = _SELF_ANGLES[i];
      const x = ringR * Math.cos(a), y = ringR * Math.sin(a);
      g.spokes[i] = { x2: x, y2: y, sw, opacity: 1 };
      g.petals[i] = { cx: x, cy: y, r: petalR, opacity: 1 };
      const slot = (i % 3) / 3;
      const local = (p - slot + 1) % 1;
      const haloR = R * (0.13 + local * 0.30);
      const op = local < 0.7 ? (1 - local / 0.7) * 0.6 : 0;
      g.halos[i] = { cx: x, cy: y, r: haloR, opacity: op, mode: 'stroke', sw: R * 0.018 };
    }
    g.center = { r: centerR, opacity: 1 };
    return g;
  }},
};
const _IDLE_KEYS = Object.keys(_FLOWER_ANIMS).filter(k => _FLOWER_ANIMS[k].kind === 'idle');
const _ACTIVE_KEYS = Object.keys(_FLOWER_ANIMS).filter(k => _FLOWER_ANIMS[k].kind === 'active');

const _selfAnim = {
  current: null, startMs: 0,
  prev: null, prevStartMs: 0, fadeStartMs: 0,
  raf: null,
};
function _flowerEachSelf(fn) {
  const groups = document.querySelectorAll('.graph-node[data-node-type="self"]');
  groups.forEach(g => {
    const sel = d3.select(g);
    const datum = sel.datum();
    const R = (datum && datum.radius) || 14;
    fn(sel, R);
  });
}
function _pickAnim(kind) {
  // Idle is fixed to wobble — keeps the resting state visually consistent
  // across refreshes and across the idle⇄active⇄idle cycle. Active stays
  // randomized so each work session reads as its own moment.
  if (kind === 'idle') return 'wobble';
  const pool = _ACTIVE_KEYS;
  if (!pool.length) return null;
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && pick === _selfAnim.current) {
    pick = pool[(pool.indexOf(pick) + 1) % pool.length];
  }
  return pick;
}
function _selfAnimTick(now) {
  if (!_selfAnim.startMs) _selfAnim.startMs = now;
  const t = (now - _selfAnim.startMs) / 1000;
  const def = _FLOWER_ANIMS[_selfAnim.current];
  if (def) {
    let fading = false;
    let fadeP = 0;
    if (_selfAnim.prev && _selfAnim.fadeStartMs) {
      fadeP = (now - _selfAnim.fadeStartMs) / FLOWER_FADE_MS;
      if (fadeP >= 1) {
        _selfAnim.prev = null;
        _selfAnim.prevStartMs = 0;
        _selfAnim.fadeStartMs = 0;
      } else {
        fading = true;
      }
    }
    _flowerEachSelf((sel, R) => {
      const newG = def.fn(R, t);
      let g = newG;
      if (fading) {
        const prevDef = _FLOWER_ANIMS[_selfAnim.prev];
        if (prevDef) {
          const prevT = (now - _selfAnim.prevStartMs) / 1000;
          const prevG = prevDef.fn(R, prevT);
          g = _lerpGeom(prevG, newG, _easeInOut(fadeP));
        }
      }
      _writeGeom(sel, g);
    });
  }
  _selfAnim.raf = requestAnimationFrame(_selfAnimTick);
}
function _selfAnimSetActive(active) {
  const next = _pickAnim(active ? 'active' : 'idle');
  if (!next) return;
  if (next === _selfAnim.current) return;  // no-op pick-same (shouldn't usually happen)
  // Capture the current anim as "prev" for the cross-fade.
  if (_selfAnim.current) {
    _selfAnim.prev = _selfAnim.current;
    _selfAnim.prevStartMs = _selfAnim.startMs;  // keep its time origin so it
                                                // continues evolving during fade
    _selfAnim.fadeStartMs = performance.now();
  }
  _selfAnim.current = next;
  _selfAnim.startMs = 0;
  if (!_selfAnim.raf) _selfAnim.raf = requestAnimationFrame(_selfAnimTick);
}
// Kick off the idle loop early. _flowerEachSelf is a no-op until the
// first self-node lands in the DOM, so this is safe pre-initGraph.
_selfAnimSetActive(false);
function _sporeActivityStart(source) {
  if (!source) return;
  const now = Date.now();
  _sporeActiveSources.set(source, now);
  _sporeLastEventOp = source + ':start';
  _sporeLastEventAt = now;
  _sporeActivitySync();
  if (_sporeActivitySafetyTimer) clearTimeout(_sporeActivitySafetyTimer);
  _sporeActivitySafetyTimer = setTimeout(() => {
    if (_sporeActiveSources.size > 0) {
      try { console.warn(`[spore-activity] safety timer cleared ${_sporeActiveSources.size} stuck source(s): ${[..._sporeActiveSources.keys()].join(', ')}`); } catch {}
    }
    _sporeActiveSources.clear();
    _sporeLastEventOp = 'safety-timer';
    _sporeLastEventAt = Date.now();
    _sporeActivitySync();
  }, 5 * 60 * 1000);
}
function _sporeActivityEnd(source) {
  if (!source) return;
  const had = _sporeActiveSources.delete(source);
  if (had) {
    _sporeLastEventOp = source + ':done';
    _sporeLastEventAt = Date.now();
  }
  _sporeActivitySync();
  if (_sporeActiveSources.size === 0 && _sporeActivitySafetyTimer) {
    clearTimeout(_sporeActivitySafetyTimer);
    _sporeActivitySafetyTimer = null;
  }
}
function _sporeActivityPulse(source, ms = 1200) {
  _sporeActivityStart(source);
  setTimeout(() => _sporeActivityEnd(source), ms);
}
window._sporeActivity = {
  start: _sporeActivityStart,
  end: _sporeActivityEnd,
  pulse: _sporeActivityPulse,
  sources: () => [..._sporeActiveSources.entries()],  // for live debugging
};
let selectedNode = null;
let selectedNodeIds = new Set();
let hoveredNodeId = null;
let _selectionRect = null;
let _graphMarquee = { active: false, moved: false, startX: 0, startY: 0 };
let _suppressNextGraphClick = false;
let _currentZoomScale = 1;
let _graphFocusedId = null;
let _graphPreFocusTransform = null;
let _tickScheduled = false;
let _needsTick = false;
let _labelLayoutTimer = null;

function getColor(type) {
  // Family-based palette (design_handoff_node_graph). Returns the family's
  // stroke colour — used for outlines and glyphs. Self-node still resolves
  // through the legacy CSS var path so its theme-aware override (ink in
  // light, cream in dark) keeps working.
  if (type === 'self') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--node-' + type).trim();
    return v || TYPE_COLORS[type] || DEFAULT_COLOR;
  }
  return getFamily(type).stroke;
}
// Edge weight classification (design_handoff_node_graph).
//   strong  — direct, primary edges. width 2.0, opacity 0.85, no dash.
//   normal  — ordinary edges.        width 1.4, opacity 0.6,  no dash.
//   soft    — inferred / weak.       width 1.0, opacity 0.45, dash 4 4.
// Heuristic: any edge directly connecting the self-node is "strong"; an
// edge whose source.weight (an aggregate from extraction) is >= 3 is
// "normal"; otherwise "soft". Falls back to "normal" when nothing is
// known about the edge.
function getEdgeKind(d) {
  const sId = (d?.source?.id || d?.source);
  const tId = (d?.target?.id || d?.target);
  // Touching the self-node always reads as a primary relation.
  const selfNode = (graphData?.nodes || []).find(n => n.type === 'self');
  if (selfNode && (sId === selfNode.id || tId === selfNode.id)) return 'strong';
  const w = Number(d?.weight);
  if (Number.isFinite(w)) {
    if (w >= 3) return 'normal';
    return 'soft';
  }
  return 'normal';
}
const EDGE_KIND = {
  strong: { width: 2.0, opacity: 0.55, dash: null },
  normal: { width: 1.4, opacity: 0.38, dash: null },
  soft:   { width: 1.0, opacity: 0.25, dash: '4 4' },
};
function getFillColor(type) {
  // The soft, harmonised fill paired with the family stroke. Used as the
  // node-circle fill (no fill-opacity needed — the colour is already soft).
  if (type === 'self') return 'transparent';
  return getFamily(type).fill;
}
function getNodeVisual(type) {
  return TYPE_VISUALS[type] || { shape: 'circle', glyph: String(type || '?').slice(0, 1).toUpperCase() };
}

function _polygonPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + ' Z';
}

function _circlePath(radius) {
  return `M0 ${(-radius).toFixed(2)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 1 0 ${radius.toFixed(2)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 1 0 ${(-radius).toFixed(2)} Z`;
}

function _roundedRectPath(width, height, cornerRadius) {
  const hw = width / 2;
  const hh = height / 2;
  const rr = Math.min(cornerRadius, hw, hh);
  return [
    `M${(-hw + rr).toFixed(2)} ${(-hh).toFixed(2)}`,
    `H${(hw - rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${hw.toFixed(2)} ${(-hh + rr).toFixed(2)}`,
    `V${(hh - rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(hw - rr).toFixed(2)} ${hh.toFixed(2)}`,
    `H${(-hw + rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(-hw).toFixed(2)} ${(hh - rr).toFixed(2)}`,
    `V${(-hh + rr).toFixed(2)}`,
    `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(-hw + rr).toFixed(2)} ${(-hh).toFixed(2)}`,
    'Z',
  ].join(' ');
}

function getNodeShapePath(type, radius) {
  const { shape } = getNodeVisual(type);
  switch (shape) {
    case 'diamond':
      return _polygonPath([[0, -radius * 1.05], [radius * 0.92, 0], [0, radius * 1.05], [-radius * 0.92, 0]]);
    case 'square': {
      const side = radius * 0.88;
      return _polygonPath([[-side, -side], [side, -side], [side, side], [-side, side]]);
    }
    case 'rounded-square': {
      // Petri: tool-like nodes — rotated rounded square
      const s = radius * 1.0;
      return _roundedRectPath(s * 2, s * 2, s * 0.32);
    }
    case 'triangle':
      return _polygonPath([[0, -radius * 1.08], [radius * 0.94, radius * 0.82], [-radius * 0.94, radius * 0.82]]);
    case 'hexagon': {
      const rx = radius * 0.98;
      const ry = radius * 0.84;
      return _polygonPath([[-rx, 0], [-rx * 0.5, -ry], [rx * 0.5, -ry], [rx, 0], [rx * 0.5, ry], [-rx * 0.5, ry]]);
    }
    case 'pentagon': {
      // Petri: project nodes — five-sided, point up
      const pts = Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return [Math.cos(a) * radius * 1.10, Math.sin(a) * radius * 1.10];
      });
      return _polygonPath(pts);
    }
    case 'shield': {
      // Petri: rule nodes — pointed-bottom shield
      const w = radius * 1.05;
      const h = radius * 1.20;
      return [
        `M${(-w).toFixed(2)} ${(-h * 0.6).toFixed(2)}`,
        `L0 ${(-h).toFixed(2)}`,
        `L${w.toFixed(2)} ${(-h * 0.6).toFixed(2)}`,
        `L${(w * 0.7).toFixed(2)} ${(h * 0.8).toFixed(2)}`,
        `L0 ${h.toFixed(2)}`,
        `L${(-w * 0.7).toFixed(2)} ${(h * 0.8).toFixed(2)}`,
        'Z',
      ].join(' ');
    }
    case 'rosette': {
      // Petri's signature: six-petal flower — used for the agent's self node.
      // Returns a single composite path: six overlapping circles + a small
      // center disc punched out, all unioned via even-odd fill.
      const petalR = radius * 0.55;
      const ringR = radius * 0.70;
      const parts = Array.from({ length: 6 }).map((_, i) => {
        const a = (i / 6) * Math.PI * 2;
        const cx = Math.cos(a) * ringR;
        const cy = Math.sin(a) * ringR;
        return `M${cx.toFixed(2)} ${(cy - petalR).toFixed(2)} `
             + `A${petalR.toFixed(2)} ${petalR.toFixed(2)} 0 1 1 ${cx.toFixed(2)} ${(cy + petalR).toFixed(2)} `
             + `A${petalR.toFixed(2)} ${petalR.toFixed(2)} 0 1 1 ${cx.toFixed(2)} ${(cy - petalR).toFixed(2)} Z`;
      });
      const coreR = radius * 0.42;
      parts.push(
        `M0 ${(-coreR).toFixed(2)} `
        + `A${coreR.toFixed(2)} ${coreR.toFixed(2)} 0 1 0 0 ${coreR.toFixed(2)} `
        + `A${coreR.toFixed(2)} ${coreR.toFixed(2)} 0 1 0 0 ${(-coreR).toFixed(2)} Z`
      );
      return parts.join(' ');
    }
    case 'octagon': {
      const edge = radius * 0.44;
      const outer = radius * 0.96;
      return _polygonPath([[-edge, -outer], [edge, -outer], [outer, -edge], [outer, edge], [edge, outer], [-edge, outer], [-outer, edge], [-outer, -edge]]);
    }
    case 'pill':
      return _roundedRectPath(radius * 2.18, radius * 1.42, radius * 0.52);
    case 'circle':
    default:
      return _circlePath(radius);
  }
}

function getNodeGlyph(type) {
  return getNodeVisual(type).glyph;
}

function _nodeLabelText(node) {
  const label = String(node?.label || node?.id || 'untitled');
  return label.length > 20 ? label.slice(0, 18) + '…' : label;
}

function _hashStringNumber(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _phyllotaxisSeed(index, width, height) {
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const radius = 30 * Math.sqrt(index + 1);
  return {
    x: (width / 2) + (Math.cos(angle) * radius),
    y: (height / 2) + (Math.sin(angle) * radius),
  };
}

function _clampSeedToViewport(point, width, height, pad = 36) {
  return {
    x: Math.max(pad, Math.min(width - pad, point.x)),
    y: Math.max(pad, Math.min(height - pad, point.y)),
  };
}

function _stableSeedOffset(nodeId, radius = 26) {
  const hash = _hashStringNumber(nodeId);
  const angle = ((hash % 3600) / 3600) * Math.PI * 2;
  const magnitude = radius * (0.72 + (((hash >>> 11) % 1000) / 1000) * 0.55);
  return {
    x: Math.cos(angle) * magnitude,
    y: Math.sin(angle) * magnitude,
  };
}

function _graphNodeId(ref) {
  return ref?.id || ref;
}

function _hasFiniteNodePosition(node) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.y);
}

// Pre-cluster: place each unpositioned node inside its type's treemap rect
// using phyllotaxis (golden-angle spiral) sized to fit the rect. Big types get
// nodes spread across a big rect; singletons get placed dead-center in their
// tiny rect.
function _seedNodesByType(nodes, width, height) {
  if (!nodes?.length) return;
  const anchors = _typeClusterAnchors(nodes, width, height);
  if (!anchors.size) return;
  const byType = new Map();
  for (const n of nodes) {
    if (_hasFiniteNodePosition(n)) continue;
    const t = String(n?.type || 'unknown');
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(n);
  }
  for (const [t, list] of byType.entries()) {
    const anchor = anchors.get(t);
    if (!anchor) continue;
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const maxR = Math.max(8, Math.min(anchor.w, anchor.h) / 2 - 8);
    if (list.length === 1) {
      list[0].x = anchor.x;
      list[0].y = anchor.y;
      continue;
    }
    // Phyllotaxis radius scales so the outermost node lands near the edge.
    const baseR = Math.max(6, maxR / Math.sqrt(list.length));
    const step = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < list.length; i++) {
      const r = Math.min(maxR, baseR * Math.sqrt(i + 0.5));
      const angle = i * step;
      list[i].x = anchor.x + Math.cos(angle) * r;
      list[i].y = anchor.y + Math.sin(angle) * r;
    }
  }
}

function _neighborSeedPosition(nodeId, edgeData, nodeById, width, height, fallbackIndex = 0) {
  const neighbors = [];
  for (const edge of edgeData || []) {
    const sourceId = _graphNodeId(edge.source);
    const targetId = _graphNodeId(edge.target);
    let neighborId = null;
    if (sourceId === nodeId) neighborId = targetId;
    else if (targetId === nodeId) neighborId = sourceId;
    if (!neighborId) continue;
    const neighbor = nodeById[neighborId];
    if (_hasFiniteNodePosition(neighbor)) neighbors.push(neighbor);
  }

  if (!neighbors.length) {
    return _clampSeedToViewport(_phyllotaxisSeed(fallbackIndex, width, height), width, height);
  }

  const centroid = neighbors.reduce((acc, node) => {
    acc.x += node.x;
    acc.y += node.y;
    return acc;
  }, { x: 0, y: 0 });
  centroid.x /= neighbors.length;
  centroid.y /= neighbors.length;

  const offset = _stableSeedOffset(nodeId, Math.min(42, 18 + (neighbors.length * 4)));
  return _clampSeedToViewport({
    x: centroid.x + offset.x,
    y: centroid.y + offset.y,
  }, width, height);
}

function _graphForceProfile(nodeCount) {
  const isLarge = nodeCount > 150;
  const isHuge = nodeCount > 280;
  return {
    // Very gentle, very local charge. Collision handles "don't overlap";
    // charge just adds a touch of springiness within the cluster. distanceMax
    // is small enough that a node can't influence another type's region.
    chargeStrength: isHuge ? -18 : (isLarge ? -25 : -50),
    chargeTheta: isLarge ? 0.9 : 0.8,
    chargeMaxDist: isHuge ? 70 : 110,
    linkDistance: isLarge ? 60 : 80,
    linkStrength: isHuge ? 0.05 : (isLarge ? 0.08 : 0.15),
    collisionPad: isLarge ? 3 : 4,
    collisionIterations: isLarge ? 1 : 2,
    // Heavy damping kills oscillation fast.
    velocityDecay: isHuge ? 0.78 : (isLarge ? 0.7 : 0.6),
    axisStrength: 0,
    // Gentler anchor pull — collision needs room to spread nodes within
    // their treemap rect. Too-strong pull packs them on top of each other.
    clusterStrength: isHuge ? 0.18 : (isLarge ? 0.15 : 0.12),
    refreshAlpha: isLarge ? 0.02 : 0.035,
    dragAlpha: isLarge ? 0.08 : 0.12,
    restartAlpha: isLarge ? 0.05 : 0.08,
    warmTicks: nodeCount > 60 ? Math.min(120, Math.round(28 + Math.sqrt(nodeCount) * 4)) : 0,
  };
}

// Box-based collision that includes the bottom-placed label as part of the
// node's footprint. Circular collide can't separate horizontally-adjacent
// labels — only this can. Quadtree-pruned for O(n log n) per tick.
function _createLabelBoxCollide() {
  let nodes = [];
  let strength = 1.0;
  let padding = 4;
  let iterations = 2;

  function runOnce() {
    const boxes = new Array(nodes.length);
    let maxHalfW = 0, maxHalfH = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const r = n.radius || 12;
      const labelChars = Math.min((n.label || n.id || '').toString().length, 20);
      const labelW = Math.min(Math.max(labelChars * 6.9, 20), 145);
      const labelH = 16;
      const gap = 3;
      const halfW = Math.max(r, labelW / 2) + padding;
      const top = -r - padding;
      const bottom = r + gap + labelH + padding;
      const halfH = (bottom - top) / 2;
      const cyOffset = (top + bottom) / 2;
      const x = (n.x || 0) + (n.vx || 0);
      const y = (n.y || 0) + (n.vy || 0);
      const cx = x;
      const cy = y + cyOffset;
      if (halfW > maxHalfW) maxHalfW = halfW;
      if (halfH > maxHalfH) maxHalfH = halfH;
      boxes[i] = {
        node: n, idx: i, cx, cy, halfW, halfH, cyOffset,
        left: cx - halfW, right: cx + halfW,
        top: cy - halfH, bottom: cy + halfH,
      };
    }

    const tree = d3.quadtree().x(b => b.cx).y(b => b.cy).addAll(boxes);

    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      const sLeft = a.left - maxHalfW;
      const sRight = a.right + maxHalfW;
      const sTop = a.top - maxHalfH;
      const sBottom = a.bottom + maxHalfH;
      tree.visit((quad, x0, y0, x1, y1) => {
        if (x0 > sRight || x1 < sLeft || y0 > sBottom || y1 < sTop) return true;
        if (!quad.length) {
          let leaf = quad;
          do {
            const b = leaf.data;
            if (b && b.idx > a.idx) {
              const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              if (overlapX > 0) {
                const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (overlapY > 0) {
                  if (overlapX < overlapY) {
                    let dir = Math.sign(a.cx - b.cx) || 1;
                    const push = overlapX * 0.5 * strength;
                    a.node.x = (a.node.x || 0) + dir * push;
                    b.node.x = (b.node.x || 0) - dir * push;
                  } else {
                    let dir = Math.sign(a.cy - b.cy) || 1;
                    const push = overlapY * 0.5 * strength;
                    a.node.y = (a.node.y || 0) + dir * push;
                    b.node.y = (b.node.y || 0) - dir * push;
                  }
                }
              }
            }
            leaf = leaf.next;
          } while (leaf);
        }
        return false;
      });
    }
  }

  function force() {
    if (!nodes.length) return;
    for (let it = 0; it < iterations; it++) runOnce();
  }

  force.initialize = function(_nodes) { nodes = _nodes || []; };
  force.strength = function(s) { if (!arguments.length) return strength; strength = +s || 0; return force; };
  force.iterations = function(v) { if (!arguments.length) return iterations; iterations = Math.max(1, +v || 1); return force; };
  force.padding = function(p) { if (!arguments.length) return padding; padding = +p || 0; return force; };
  return force;
}

// Treemap-based type anchors: each type gets a rectangle whose AREA scales
// with node count. A type with 70 nodes gets ~70× the canvas area of a
// singleton type. Anchor = rect center; rect dimensions are exposed so the
// pre-seeder knows how much space to spread across.
function _typeClusterAnchors(nodes, width, height) {
  const counts = new Map();
  for (const node of nodes || []) {
    const type = String(node?.type || 'unknown');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const anchors = new Map();
  if (!counts.size) return anchors;

  // Strong super-linear weighting so big types get the room their nodes need
  // for label-bbox collision. n^1.4 means: singleton=1, n=10 → 25, n=70 → 410.
  // This is necessary because 70 label-aware footprints need MUCH more area
  // than 70× a single footprint due to packing inefficiency.
  const childData = [...counts.entries()].map(([type, n]) => ({
    type,
    value: Math.pow(n + 0.5, 1.4),
  }));
  const root = d3.hierarchy({ children: childData })
    .sum(d => d.value)
    .sort((a, b) => b.value - a.value);
  d3.treemap()
    .tile(d3.treemapSquarify.ratio(1.3))
    .size([width, height])
    .paddingInner(14)
    .paddingOuter(10)
    .round(true)(root);

  for (const leaf of root.leaves()) {
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    anchors.set(leaf.data.type, {
      x: (leaf.x0 + leaf.x1) / 2,
      y: (leaf.y0 + leaf.y1) / 2,
      w, h,
    });
  }
  return anchors;
}

function _createTypeClusterForce(width, height) {
  let nodes = [];
  let strength = 0.06;
  let size = { width: width || 0, height: height || 0 };
  let anchors = new Map();

  function rebuildAnchors() {
    anchors = _typeClusterAnchors(nodes, size.width || window.innerWidth, size.height || window.innerHeight);
  }

  function force(alpha) {
    if (!nodes.length) return;
    const pull = Math.max(0.25, alpha) * strength;
    for (const node of nodes) {
      const anchor = anchors.get(String(node?.type || 'unknown'));
      if (!anchor) continue;
      node.vx = (node.vx || 0) + ((anchor.x - (node.x || 0)) * pull);
      node.vy = (node.vy || 0) + ((anchor.y - (node.y || 0)) * pull);
    }
  }

  force.initialize = function(_nodes) {
    nodes = _nodes || [];
    rebuildAnchors();
  };
  force.strength = function(value) {
    if (!arguments.length) return strength;
    strength = Math.max(0, +value || 0);
    return force;
  };
  force.size = function(nextWidth, nextHeight) {
    if (!arguments.length) return { ...size };
    size = {
      width: nextWidth || size.width,
      height: nextHeight || size.height,
    };
    rebuildAnchors();
    return force;
  };

  return force;
}

function _boxesOverlap(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

function _boxIntersectsCircle(box, cx, cy, r) {
  const closestX = Math.max(box.left, Math.min(cx, box.right));
  const closestY = Math.max(box.top, Math.min(cy, box.bottom));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx) + (dy * dy) <= (r * r);
}

function _estimateNodeLabelBox(node, transform) {
  const text = _nodeLabelText(node);
  const scale = transform?.k || 1;
  const width = Math.min(Math.max(text.length * 6.1, 18), 150) * scale;
  const height = 12 * scale;
  const screenX = transform.applyX(node.x || 0);
  const screenY = transform.applyY(node.y || 0);
  const screenRadius = ((node.radius || 12) + 4) * scale;
  const top = screenY + screenRadius + (6 * scale);
  return {
    left: screenX - (width / 2),
    right: screenX + (width / 2),
    top,
    bottom: top + height,
  };
}

function _labelMetrics(node, scale) {
  const localWidth = Math.min(Math.max(_nodeLabelText(node).length * 6.1, 18), 150);
  const localHeight = 12;
  return {
    localWidth,
    localHeight,
    width: localWidth * scale,
    height: localHeight * scale,
  };
}

function _labelLocalPlacementCandidates(node, centerX, centerY, metrics = _labelMetrics(node, 1)) {
  const localGap = (node.radius || 12) + 2;
  const horizontalTop = -(metrics.localHeight / 2);
  const verticalLeft = -(metrics.localWidth / 2);
  const verticalRight = metrics.localWidth / 2;
  const positions = {
    top: {
      attrs: { x: 0, y: -(localGap + (metrics.localHeight / 2)), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: -localGap - metrics.localHeight,
        bottom: -localGap,
      },
    },
    bottom: {
      attrs: { x: 0, y: localGap + (metrics.localHeight / 2), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: localGap,
        bottom: localGap + metrics.localHeight,
      },
    },
    right: {
      attrs: { x: localGap, y: 0, anchor: 'start', baseline: 'middle' },
      box: {
        left: localGap,
        right: localGap + metrics.localWidth,
        top: horizontalTop,
        bottom: horizontalTop + metrics.localHeight,
      },
    },
    left: {
      attrs: { x: -localGap, y: 0, anchor: 'end', baseline: 'middle' },
      box: {
        left: -localGap - metrics.localWidth,
        right: -localGap,
        top: horizontalTop,
        bottom: horizontalTop + metrics.localHeight,
      },
    },
  };

  return _labelCandidateOrder(node.x || 0, node.y || 0, centerX, centerY).map((name) => ({
    name,
    attrs: positions[name].attrs,
    box: positions[name].box,
  }));
}

function _preferredLabelPlacement(node, centerX, centerY, metrics = _labelMetrics(node, 1)) {
  return _labelLocalPlacementCandidates(node, centerX, centerY, metrics).find((candidate) => candidate.name === 'bottom')
    || _labelLocalPlacementCandidates(node, centerX, centerY, metrics)[0];
}

function _nodeFootprint(node, centerX, centerY) {
  const metrics = _labelMetrics(node, 1);
  const placement = _preferredLabelPlacement(node, centerX, centerY, metrics);
  const radius = (node.radius || 12) + 4;
  const pad = 3;
  return {
    metrics,
    placement,
    box: {
      left: Math.min(-radius, placement.box.left) - pad,
      right: Math.max(radius, placement.box.right) + pad,
      top: Math.min(-radius, placement.box.top) - pad,
      bottom: Math.max(radius, placement.box.bottom) + pad,
    },
  };
}

function _labelCandidateOrder(screenX, screenY, centerX, centerY) {
  const outwardHorizontal = screenX < centerX ? 'left' : 'right';
  const outwardVertical = screenY < centerY ? 'top' : 'bottom';
  return [
    outwardHorizontal,
    outwardVertical,
    outwardHorizontal === 'left' ? 'right' : 'left',
    outwardVertical === 'top' ? 'bottom' : 'top',
  ];
}

function _labelPlacementCandidates(node, transform, metrics) {
  const scale = transform?.k || 1;
  const screenX = transform.applyX(node.x || 0);
  const screenY = transform.applyY(node.y || 0);
  const centerX = (svg?.node()?.clientWidth || window.innerWidth) / 2;
  const centerY = (svg?.node()?.clientHeight || window.innerHeight) / 2;
  const localGap = (node.radius || 12) + 8;
  const horizontalTop = screenY - (metrics.height / 2);
  const verticalLeft = screenX - (metrics.width / 2);
  const verticalRight = screenX + (metrics.width / 2);
  const positions = {
    top: {
      attrs: { x: 0, y: -(localGap + (metrics.localHeight / 2)), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: screenY - (localGap * scale) - metrics.height,
        bottom: screenY - (localGap * scale),
      },
    },
    bottom: {
      attrs: { x: 0, y: localGap + (metrics.localHeight / 2), anchor: 'middle', baseline: 'middle' },
      box: {
        left: verticalLeft,
        right: verticalRight,
        top: screenY + (localGap * scale),
        bottom: screenY + (localGap * scale) + metrics.height,
      },
    },
    right: {
      attrs: { x: localGap, y: 0, anchor: 'start', baseline: 'middle' },
      box: {
        left: screenX + (localGap * scale),
        right: screenX + (localGap * scale) + metrics.width,
        top: horizontalTop,
        bottom: horizontalTop + metrics.height,
      },
    },
    left: {
      attrs: { x: -localGap, y: 0, anchor: 'end', baseline: 'middle' },
      box: {
        left: screenX - (localGap * scale) - metrics.width,
        right: screenX - (localGap * scale),
        top: horizontalTop,
        bottom: horizontalTop + metrics.height,
      },
    },
  };

  return _labelCandidateOrder(screenX, screenY, centerX, centerY).map((name) => ({
    name,
    attrs: positions[name].attrs,
    box: positions[name].box,
  }));
}

function _overlapArea(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function _smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - (2 * t));
}

function _labelPlacementPenalty(candidate, nodeId, circles, placedBoxes) {
  let penalty = 0;
  for (const circle of circles) {
    if (circle.id === nodeId) continue;
    if (_boxIntersectsCircle(candidate.box, circle.x, circle.y, circle.r)) {
      penalty += 1000 + (circle.r * circle.r);
    }
  }
  for (const box of placedBoxes) {
    const overlap = _overlapArea(candidate.box, box);
    if (overlap > 0) penalty += 2000 + overlap;
  }
  return penalty;
}

function _boxFromCenter(cx, cy, width, height) {
  return {
    left: cx - (width / 2),
    right: cx + (width / 2),
    top: cy - (height / 2),
    bottom: cy + (height / 2),
  };
}

function _labelStateBox(state) {
  return _boxFromCenter(state.cx, state.cy, state.width, state.height);
}

function _candidateCenter(candidate) {
  return {
    x: (candidate.box.left + candidate.box.right) / 2,
    y: (candidate.box.top + candidate.box.bottom) / 2,
  };
}

function _resolveZeroVector(dx, dy, fallbackAngle = 0) {
  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) return { dx, dy };
  return { dx: Math.cos(fallbackAngle), dy: Math.sin(fallbackAngle) };
}

function _clampLabelState(state, viewport) {
  const pad = 6;
  state.cx = Math.max((state.width / 2) + pad, Math.min(viewport.width - (state.width / 2) - pad, state.cx));
  state.cy = Math.max((state.height / 2) + pad, Math.min(viewport.height - (state.height / 2) - pad, state.cy));

  let dx = state.cx - state.nodeX;
  let dy = state.cy - state.nodeY;
  ({ dx, dy } = _resolveZeroVector(dx, dy, state.preferredAngle));
  let dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
  if (dist < state.minRadius) {
    const scale = state.minRadius / dist;
    state.cx = state.nodeX + (dx * scale);
    state.cy = state.nodeY + (dy * scale);
  } else if (dist > state.maxRadius) {
    const scale = state.maxRadius / dist;
    state.cx = state.nodeX + (dx * scale);
    state.cy = state.nodeY + (dy * scale);
  }
}

function _relaxLabelStates(states, circles, viewport) {
  if (!states.length) return;
  const iterations = Math.min(12, 5 + Math.ceil(states.length / 40));
  const labelPadding = 4;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < states.length; i++) {
      const a = states[i];
      for (let j = i + 1; j < states.length; j++) {
        const b = states[j];
        const overlapX = ((a.width + b.width) / 2 + labelPadding) - Math.abs(a.cx - b.cx);
        const overlapY = ((a.height + b.height) / 2 + labelPadding) - Math.abs(a.cy - b.cy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        if (overlapX < overlapY) {
          let dx = a.cx - b.cx;
          ({ dx } = _resolveZeroVector(dx, 0, a.preferredAngle));
          const dir = Math.sign(dx) || 1;
          const shift = overlapX / 2;
          a.cx += dir * shift;
          b.cx -= dir * shift;
        } else {
          let dy = a.cy - b.cy;
          ({ dy } = _resolveZeroVector(0, dy, a.preferredAngle + (Math.PI / 2)));
          const dir = Math.sign(dy) || 1;
          const shift = overlapY / 2;
          a.cy += dir * shift;
          b.cy -= dir * shift;
        }
      }
    }

    for (const state of states) {
      for (const circle of circles) {
        const stateBox = _labelStateBox(state);
        if (!_boxIntersectsCircle(stateBox, circle.x, circle.y, circle.r + 2)) continue;
        let dx = state.cx - circle.x;
        let dy = state.cy - circle.y;
        ({ dx, dy } = _resolveZeroVector(dx, dy, state.preferredAngle));
        const dist = Math.sqrt((dx * dx) + (dy * dy)) || 1;
        const push = Math.max(2, Math.min(14, (circle.r / 5) + 2));
        state.cx += (dx / dist) * push;
        state.cy += (dy / dist) * push;
      }

      state.cx += (state.preferredX - state.cx) * 0.08;
      state.cy += (state.preferredY - state.cy) * 0.08;
      _clampLabelState(state, viewport);
    }
  }
}

function _autoLabelBudget(scale, nodeCount) {
  if (scale <= 0.18) return 0;
  // Estimate how many labels fit visibly at the current zoom. A typical label
  // bbox is ~85x18 px at scale 1.0; at scale s it's ~85s x 18s. The visible
  // area is the canvas area, which we approximate as 900x700 = 630k px² of
  // usable graph space (sidebars eat the rest). With ~50% packing efficiency
  // we can show area / (labelArea * 2) labels.
  const labelArea = 85 * 18; // logical px²
  const visibleArea = 630000 * Math.min(4, scale * scale);
  let budget = Math.floor(visibleArea / (labelArea * 4.5));
  // Hard floor so even at low zoom you see the most-important handful.
  budget = Math.max(scale > 0.28 ? 12 : 0, Math.min(nodeCount, budget));
  return budget;
}

function _autoLabelOpacity(scale) {
  return 0.35 + (_smoothstep(0.24, 1.05, scale) * 0.65);
}

function _setLabelPlacement(labelEl, placement) {
  labelEl.setAttribute('x', placement.attrs.x);
  labelEl.setAttribute('y', placement.attrs.y);
  labelEl.setAttribute('text-anchor', placement.attrs.anchor);
  labelEl.setAttribute('dominant-baseline', placement.attrs.baseline);
}

function _setLabelHidden(labelEl) {
  labelEl.style.opacity = '0';
}

function _setLabelVisible(labelEl, opacity = 1) {
  labelEl.style.opacity = String(Math.max(0, Math.min(1, opacity)));
}

function _scheduleLabelLayout(immediate = false) {
  if (!gNodes || !svg) return;
  if (immediate) {
    if (_labelLayoutTimer) {
      clearTimeout(_labelLayoutTimer);
      _labelLayoutTimer = null;
    }
    _updateNodeLabelVisibility(_currentZoomScale);
    return;
  }
  if (_labelLayoutTimer) return;
  const alpha = typeof simulation?.alpha === 'function' ? simulation.alpha() : 0;
  const delay = alpha > 0.18 ? 120 : (alpha > 0.08 ? 64 : 18);
  _labelLayoutTimer = setTimeout(() => {
    _labelLayoutTimer = null;
    _updateNodeLabelVisibility(_currentZoomScale);
  }, delay);
}

function _setHoveredNode(nodeId = null) {
  if (hoveredNodeId === nodeId) return;
  hoveredNodeId = nodeId;
  _scheduleLabelLayout(true);
}

function _upsertNodeVisuals(nodeSelection) {
  // Annotate each node group with its type so CSS selectors (e.g. the
  // self-node activity pulse) can target by attribute.
  nodeSelection.attr('data-node-type', d => d?.type || '');
  nodeSelection.each(function(d) {
    const sel = d3.select(this);
    if (sel.select('.glow-ring').empty()) sel.append('path').attr('class', 'node-shape glow-ring').attr('stroke', 'none');
    if (sel.select('.node-circle').empty()) sel.append('path').attr('class', 'node-shape node-circle');
    if (sel.select('.node-glyph').empty()) {
      sel.append('text')
        .attr('class', 'node-glyph')
        .attr('text-anchor', 'middle')
        .attr('y', 1);
    }
    if (sel.select('.node-label').empty()) {
      // Fill is set in CSS (.node-label) so labels retint on theme change.
      sel.append('text')
        .attr('class', 'node-label')
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px');
    }
    // Sub-label below the node name (mono, uppercase, family-stroke
    // color when focused else muted) — design_handoff_node_graph spec.
    if (sel.select('.node-sub-label').empty()) {
      sel.append('text')
        .attr('class', 'node-sub-label')
        .attr('text-anchor', 'middle')
        .attr('font-size', '8.5px')
        .attr('letter-spacing', '0.6');
    }
    // Selection halo — design's dashed ring that appears around the
    // focused node. Drawn first (under everything else) so it sits
    // behind the shape; opacity is toggled by _applyGraphSelectionStyles.
    if (sel.select('.node-focus-halo').empty()) {
      sel.insert('circle', ':first-child')
        .attr('class', 'node-focus-halo')
        .attr('fill', 'none')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3 4')
        .attr('opacity', 0)
        .attr('pointer-events', 'none');
    }
    // F01 mark elements for self-type nodes only (spec:
    //   the spore logo + node design spec).
    // Stack order: spokes → halos → petals → center.
    // Halos sit between spokes and petals so listen/rings animations
    // ripple from behind each petal outward without occluding it.
    if (d?.type === 'self') {
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-spoke[data-i="${i}"]`).empty()) {
          sel.append('line').attr('class', 'self-spoke').attr('data-i', i);
        }
      }
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-halo[data-i="${i}"]`).empty()) {
          sel.append('circle').attr('class', 'self-halo').attr('data-i', i);
        }
      }
      for (let i = 0; i < 6; i++) {
        if (sel.select(`.self-petal[data-i="${i}"]`).empty()) {
          sel.append('circle').attr('class', 'self-petal').attr('data-i', i);
        }
      }
      if (sel.select('.self-center').empty()) {
        sel.append('circle').attr('class', 'self-center');
      }
    }
  });

  nodeSelection.select('.glow-ring')
    .attr('d', d => getNodeShapePath(d.type, d.radius + 8))
    .attr('fill', d => getColor(d.type))
    .attr('stroke', 'none');

  nodeSelection.select('.node-circle')
    .attr('d', d => getNodeShapePath(d.type, d.radius))
    .attr('fill', d => getFillColor(d.type))
    // Solid family fill on permanent nodes; thin / hollow on temp nodes
    // so they read as transient even at a glance.
    .attr('fill-opacity', d => d.extra?.ttl === 'temp' ? 0.25 : 1)
    .attr('stroke', d => getColor(d.type))
    .attr('stroke-width', d => d.extra?.ttl === 'temp' ? 1.2 : 1.6)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round')
    .attr('stroke-dasharray', d => d.extra?.ttl === 'temp' ? '4 3' : null);

  // ── F01 mark — base geometry for self-type nodes. The animation rAF
  // loop (_selfAnim) overrides cx/cy/r every frame; this just sets sane
  // defaults in case the loop hasn't ticked yet (e.g. first paint).
  nodeSelection.filter(d => d?.type === 'self').each(function(d) {
    const sel = d3.select(this);
    const R = d.radius || 14;            // bounding half-extent in px
    const ringR = R * 0.62;              // petal ring radius (spec)
    const petalR = R * 0.16;             // each petal radius (spec)
    const centerR = R * 0.18;            // center disc radius (spec)
    const strokeW = R * 0.04;            // spoke stroke (spec)
    const ANGLES = [];
    for (let i = 0; i < 6; i++) ANGLES.push(-Math.PI / 2 + (i / 6) * Math.PI * 2);
    sel.selectAll('.self-spoke').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', ringR * Math.cos(a))
        .attr('y2', ringR * Math.sin(a))
        .attr('stroke-width', strokeW);
    });
    sel.selectAll('.self-petal').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('cx', ringR * Math.cos(a))
        .attr('cy', ringR * Math.sin(a))
        .attr('r', petalR);
    });
    sel.selectAll('.self-halo').each(function(_, i) {
      const a = ANGLES[i];
      d3.select(this)
        .attr('cx', ringR * Math.cos(a))
        .attr('cy', ringR * Math.sin(a))
        .attr('r', petalR)
        .attr('stroke-width', strokeW * 0.6);
    });
    sel.select('.self-center').attr('cx', 0).attr('cy', 0).attr('r', centerR);
  });
  nodeSelection.classed('node-temp', d => d?.extra?.ttl === 'temp');

  nodeSelection.select('.node-glyph')
    .text(d => getNodeGlyph(d.type))
    .attr('fill', d => getColor(d.type))
    .attr('font-size', d => `${Math.max(6, Math.min(d.radius * 0.92, 9.5))}px`);

  nodeSelection.select('.node-label')
    .text(d => _nodeLabelText(d))
    .attr('dy', 0);

  // Sub-label content (uppercased type) and color (family-stroke when
  // focused, muted otherwise — _applyGraphSelectionStyles refreshes it).
  nodeSelection.select('.node-sub-label')
    .text(d => String(d?.type || '').toUpperCase())
    .attr('fill', 'var(--text-muted)')
    .attr('opacity', 0);  // shown by the auto-label budget alongside the name

  // Focus halo radius tracks the node's bounding extent.
  nodeSelection.select('.node-focus-halo')
    .attr('r', d => (d.radius || 12) + 12)
    .attr('stroke', d => getColor(d.type));
}

function _legendNodeChip(type, color) {
  const glyph = esc(getNodeGlyph(type));
  const d = getNodeShapePath(type, 6.6);
  return `<svg viewBox="-10 -10 20 20" width="14" height="14" aria-hidden="true" style="display:inline-block;vertical-align:middle;overflow:visible">`
    + `<path d="${d}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.2"></path>`
    + `<text x="0" y="1.2" text-anchor="middle" font-family="var(--font-body)" font-size="5.2" font-weight="700" fill="${color}">${glyph}</text>`
    + `</svg>`;
}

function _hideNodePanel() {
  document.getElementById('node-empty').style.display = '';
  document.getElementById('panel-header').style.display = 'none';
  document.getElementById('panel-body').style.display = 'none';
  if (_usesFloatingWindows()) return;
  if (activeRpTabs.has('node-pane')) {
    openRightPanel(lastNonNodeTab, false);
    syncRpButtons();
  }
}

function _showNodePanel(node) {
  document.getElementById('node-empty').style.display = 'none';
  document.getElementById('panel-header').style.display = '';
  document.getElementById('panel-body').style.display = '';
  if (!activeRpTabs.has('node-pane') || _usesFloatingWindows()) openRightPanel('node-pane', false);
  renderPanel(node);
}

function _normalizeSelectionIds(ids) {
  const validIds = new Set(graphData.nodes.map(n => n.id));
  return [...new Set(ids || [])].filter(id => validIds.has(id));
}

function _applyGraphSelectionStyles() {
  const activeIds = selectedNodeIds;
  const primaryId = selectedNode?.id || (activeIds.size === 1 ? [...activeIds][0] : null);

  // Petri-style focus: when something's selected, compute the neighbor set
  // (selection ∪ everything one edge away) and dim everything else. Empty
  // selection returns to the unfocused all-bright state.
  const neighborIds = new Set();
  if (activeIds.size && graphData?.edges) {
    activeIds.forEach(id => neighborIds.add(id));
    for (const e of graphData.edges) {
      const sId = e.source?.id || e.source;
      const tId = e.target?.id || e.target;
      if (activeIds.has(sId)) neighborIds.add(tId);
      if (activeIds.has(tId)) neighborIds.add(sId);
    }
  }

  if (gNodes) {
    gNodes.selectAll('g')
      .classed('graph-node', true)
      .classed('node-selected-multi', d => activeIds.has(d.id) && d.id !== primaryId)
      .classed('node-faded', d => activeIds.size > 0 && !neighborIds.has(d.id));

    gNodes.selectAll('.node-circle')
      .attr('stroke-width', d => {
        const tmp = d?.extra?.ttl === 'temp';
        if (tmp) return 1.2;
        return d.id === primaryId ? 2.4 : (activeIds.has(d.id) ? 2 : 1.6);
      })
      .attr('fill-opacity', d => d?.extra?.ttl === 'temp' ? 0.25 : 1);

    // Focus halo: design's dashed ring around the focused (non-self)
    // node. Self-node has its own activity animation system, so we skip it.
    gNodes.selectAll('.node-focus-halo')
      .attr('opacity', d => (d.id === primaryId && d.type !== 'self') ? 0.55 : 0);

    // Sub-label tint: family-stroke when this is the primary focus,
    // muted otherwise.
    gNodes.selectAll('.node-sub-label')
      .attr('fill', d => d.id === primaryId ? getColor(d.type) : 'var(--text-muted)');
  }

  if (gLinks) {
    gLinks.selectAll('line')
      .classed('edge-highlighted', d => {
        if (!activeIds.size) return false;
        const sourceId = d.source?.id || d.source;
        const targetId = d.target?.id || d.target;
        return activeIds.has(sourceId) || activeIds.has(targetId);
      })
      .classed('edge-faded', d => {
        if (!activeIds.size) return false;
        const sourceId = d.source?.id || d.source;
        const targetId = d.target?.id || d.target;
        return !activeIds.has(sourceId) && !activeIds.has(targetId);
      });
  }

  _scheduleLabelLayout(true);
}

function _setGraphSelection(ids, { panelNode = null } = {}) {
  const nextIds = _normalizeSelectionIds(ids);
  const panelId = panelNode ? (typeof panelNode === 'string' ? panelNode : panelNode.id) : null;

  selectedNodeIds = new Set(nextIds);
  selectedNode = panelId && nextIds.length === 1 && nextIds[0] === panelId
    ? (graphData.nodes.find(n => n.id === panelId) || null)
    : null;

  if (selectedNode) _showNodePanel(selectedNode);
  else _hideNodePanel();

  _applyGraphSelectionStyles();
}

function _restoreGraphSelection() {
  const keepIds = [...selectedNodeIds];
  if (selectedNode?.id) keepIds.push(selectedNode.id);
  _setGraphSelection(keepIds, { panelNode: selectedNode });
}

function hideGraphContextMenu() {
  const menu = document.getElementById('graph-context-menu');
  if (!menu) return;
  menu.style.display = 'none';
}

function showGraphContextMenu(clientX, clientY) {
  if (!selectedNodeIds.size) return;
  const menu = document.getElementById('graph-context-menu');
  if (!menu) return;

  const deleteBtn = menu.querySelector('[data-action="delete-selected-nodes"]');
  const researchBtn = menu.querySelector('[data-action="research-selected-nodes"]');
  const count = selectedNodeIds.size;
  if (deleteBtn) {
    deleteBtn.textContent = count === 1 ? 'delete selected node' : `delete ${count} selected nodes`;
  }
  if (researchBtn) {
    researchBtn.textContent = count === 1 ? 'research selected node' : `research ${count} selected nodes`;
  }

  menu.style.visibility = 'hidden';
  menu.style.display = 'block';

  const pad = 10;
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 80;
  const left = Math.min(clientX, window.innerWidth - width - pad);
  const top = Math.min(clientY, window.innerHeight - height - pad);

  menu.style.left = Math.max(pad, left) + 'px';
  menu.style.top = Math.max(pad, top) + 'px';
  menu.style.visibility = '';
}

function clearGraphSelection() {
  hideGraphContextMenu();
  _setGraphSelection([]);
}

function _clientToSvgPoint(clientX, clientY) {
  if (!svg?.node()) return { x: 0, y: 0 };
  const rect = svg.node().getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function _isMarqueeGesture(e) {
  return e.button === 0 && e.shiftKey && (e.ctrlKey || e.metaKey);
}

function _showSelectionRect(x, y, width, height) {
  if (!_selectionRect) return;
  _selectionRect
    .attr('x', x)
    .attr('y', y)
    .attr('width', width)
    .attr('height', height)
    .style('display', '');
}

function _hideSelectionRect() {
  if (_selectionRect) _selectionRect.style('display', 'none');
  svg?.classed('is-marquee-selecting', false);
}

function _beginGraphMarquee(e) {
  if (!_isMarqueeGesture(e)) return;
  hideGraphContextMenu();
  e.preventDefault();
  e.stopPropagation();

  const pt = _clientToSvgPoint(e.clientX, e.clientY);
  // Snapshot the current selection at marquee start so subsequent
  // drags ADD to it instead of replacing — lets you grab nodes from
  // multiple regions of the graph in successive marquees. To start
  // fresh, click empty background first (clears selection), then
  // marquee. Holding Alt during the marquee TOGGLES instead of adds:
  // nodes already in startingIds get removed if they fall in the rect,
  // new ones get added — useful for fine-tuning a noisy selection.
  const startingIds = new Set(selectedNodeIds || []);
  const toggle = !!e.altKey;
  _graphMarquee = {
    active: true, moved: false, startX: pt.x, startY: pt.y,
    startingIds, toggle,
  };
  // One-line dev signal so the user can confirm this build is loaded
  // and that the snapshot picked up the prior selection. Remove or
  // gate behind a debug flag once the additive flow is verified.
  console.log(`[marquee] start  starting=${startingIds.size}  toggle=${toggle}`);
  svg?.classed('is-marquee-selecting', true);
  _showSelectionRect(pt.x, pt.y, 0, 0);
}

function _updateGraphMarquee(clientX, clientY) {
  if (!_graphMarquee.active || !svg?.node()) return;

  const pt = _clientToSvgPoint(clientX, clientY);
  const dx = pt.x - _graphMarquee.startX;
  const dy = pt.y - _graphMarquee.startY;
  const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
  if (moved && !_graphMarquee.moved) {
    _graphMarquee.moved = true;
    selectedNode = null;
    _hideNodePanel();
  }

  const x = Math.min(_graphMarquee.startX, pt.x);
  const y = Math.min(_graphMarquee.startY, pt.y);
  const width = Math.abs(dx);
  const height = Math.abs(dy);
  _showSelectionRect(x, y, width, height);

  if (!_graphMarquee.moved) return;

  const t = d3.zoomTransform(svg.node());
  // Skip nodes that are currently filtered out (type-filter / timeline
  // / search) — selecting dimmed nodes is a usability footgun.
  const visible = (typeof window._isNodeVisible === 'function')
    ? window._isNodeVisible
    : () => true;
  const inRect = new Set();
  for (const n of graphData.nodes) {
    if (!visible(n)) continue;
    const sx = t.applyX(n.x);
    const sy = t.applyY(n.y);
    if (sx >= x && sx <= x + width && sy >= y && sy <= y + height) {
      inRect.add(n.id);
    }
  }
  // Combine with the snapshot taken at marquee start: ADD by default,
  // TOGGLE when Alt was held. We rebuild from `startingIds` every
  // tick (rather than mutating selectedNodeIds in place) so dragging
  // the rect smaller correctly drops nodes that are no longer in it.
  const next = new Set(_graphMarquee.startingIds);
  if (_graphMarquee.toggle) {
    for (const id of inRect) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
  } else {
    for (const id of inRect) next.add(id);
  }
  selectedNodeIds = next;
  _applyGraphSelectionStyles();
}

function _finishGraphMarquee(cancel = false) {
  if (!_graphMarquee.active) return;
  const { moved } = _graphMarquee;
  _graphMarquee.active = false;
  _hideSelectionRect();

  if (cancel) return;
  if (moved) {
    _suppressNextGraphClick = true;
    if (selectedNodeIds.size === 0) _hideNodePanel();
  }
}

document.addEventListener('mousemove', (e) => _updateGraphMarquee(e.clientX, e.clientY));
document.addEventListener('mouseup', () => _finishGraphMarquee(false));
window.addEventListener('blur', () => _finishGraphMarquee(true));
document.addEventListener('click', (e) => {
  if (!e.target.closest('#graph-context-menu')) hideGraphContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideGraphContextMenu();
    _finishGraphMarquee(true);
  }
});
document.getElementById('graph-context-menu')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const action = btn.dataset.action;
  if (action === 'delete-selected-nodes') await doDeleteSelectedNodes();
  else if (action === 'clear-selection') clearGraphSelection();
  else if (action === 'research-selected-nodes') await doResearchSelectedNodes();
});

async function doResearchSelectedNodes() {
  const ids = Array.from(selectedNodeIds || []);
  if (!ids.length) { toast('No nodes selected', true); return; }
  if (ids.length > 12) { toast('Pick 12 or fewer nodes to research', true); return; }
  hideGraphContextMenu();
  toast(`Researching ${ids.length} node${ids.length === 1 ? '' : 's'}…`);
  try {
    const r = await fetch(graphApiUrl('/api/graph/research'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ nodeIds: ids }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
    toast(`Agent is researching — graph will update as new info comes in`);
  } catch (e) {
    toast('Research failed: ' + (e.message || e), true);
  }
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2500);
}
