/**
 * community.js — pure-JS single-level Louvain community detection.
 *
 * Reads edges from the runtime graph DB, partitions nodes into communities
 * by topology (no embeddings, no LLM), and persists results into
 * `node_groups` / `node_group_members` (tables created in graph/context.js).
 *
 * Why Louvain (single-level): on Spore's scale (<10k nodes typically) one
 * pass of modularity-maximizing local moves gives reasonable communities
 * without recursion or external dependencies. The maintainer re-runs it
 * periodically as the graph mutates, so any loss vs. multilevel Leiden
 * is transient.
 *
 * Communities are written under a fresh `run_id`; prior runs are marked
 * `superseded_at = CURRENT_TIMESTAMP` so historical partitions remain
 * inspectable but only one is "current" at any time.
 */

'use strict';

const crypto = require('crypto');

const MAX_ITERATIONS = 30;
const MIN_GAIN = 1e-6;

function _newRunId() {
  return 'comm-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Run single-level Louvain over the graph DB.
 *
 * @param {object} db — node:sqlite database (from GraphContext.db)
 * @param {object} log — logger with .info / .warn / .error
 * @param {object} [opts]
 * @param {number} [opts.minCommunitySize=2] — drop communities below this size (singletons emitted as own group only when explicitly kept)
 * @param {number} [opts.maxFraction=0.25] — cap a single community at this fraction of total nodes; split via second pass if exceeded
 * @returns {{ runId: string, communityCount: number, sizes: number[], elapsedMs: number }}
 */
function runCommunityDetection(db, log, opts = {}) {
  const startedAt = Date.now();
  const minSize = opts.minCommunitySize ?? 2;
  const maxFraction = opts.maxFraction ?? 0.25;

  if (!db) {
    log?.warn?.('[community] no db — skipping');
    return { runId: null, communityCount: 0, sizes: [], elapsedMs: 0 };
  }

  // ── 1. Build adjacency. Symmetric weights — Louvain needs an undirected
  // view. Multiple edges between the same pair sum.
  const adj = new Map();        // nodeId -> Map<neighborId, weight>
  const ki = new Map();         // nodeId -> sum of incident weights
  let m2 = 0;                   // 2 * total edge weight

  const allNodes = db.prepare('SELECT id FROM nodes').all().map(r => r.id);
  if (allNodes.length === 0) {
    return { runId: null, communityCount: 0, sizes: [], elapsedMs: 0 };
  }
  for (const id of allNodes) {
    adj.set(id, new Map());
    ki.set(id, 0);
  }

  const edges = db.prepare('SELECT source, target, weight FROM edges').all();
  for (const e of edges) {
    if (!e.source || !e.target || e.source === e.target) continue;
    if (!adj.has(e.source) || !adj.has(e.target)) continue; // dangling
    const w = (typeof e.weight === 'number' && Number.isFinite(e.weight)) ? Math.max(0, e.weight) : 1;
    if (w === 0) continue;
    const a = adj.get(e.source);
    const b = adj.get(e.target);
    a.set(e.target, (a.get(e.target) || 0) + w);
    b.set(e.source, (b.get(e.source) || 0) + w);
    ki.set(e.source, ki.get(e.source) + w);
    ki.set(e.target, ki.get(e.target) + w);
    m2 += 2 * w;
  }

  if (m2 === 0) {
    // No edges — every node is its own community. We persist nothing
    // (singletons-only partitions aren't useful navigation aids).
    log?.info?.('[community] graph has no edges — no communities to detect');
    return { runId: null, communityCount: 0, sizes: [], elapsedMs: Date.now() - startedAt };
  }

  // ── 2. Local-moves Louvain.
  const community = new Map();              // nodeId -> communityId (uses nodeId itself as the initial community label)
  const commTotal = new Map();              // communityId -> sum of ki of members
  for (const n of allNodes) {
    community.set(n, n);
    commTotal.set(n, ki.get(n));
  }

  const order = allNodes.slice();
  // Deterministic shuffle (xor-fold the id chars) so consecutive runs
  // produce identical results when the graph hasn't changed.
  order.sort((a, b) => {
    const ha = _hashStr(a), hb = _hashStr(b);
    return ha === hb ? (a < b ? -1 : 1) : ha - hb;
  });

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = 0;
    for (const n of order) {
      const cur = community.get(n);
      const kn = ki.get(n);

      // Sum of weights from n into each neighboring community.
      const linkToComm = new Map();
      let selfWeightInCur = 0;
      for (const [nb, w] of adj.get(n)) {
        const c = community.get(nb);
        linkToComm.set(c, (linkToComm.get(c) || 0) + w);
        if (c === cur) selfWeightInCur += w;
      }

      // Best alternative.
      let bestComm = cur;
      let bestGain = 0;
      for (const [c, kin] of linkToComm) {
        if (c === cur) continue;
        // ΔQ for moving n into community c:
        //   = (kin / m) - (Σtot_c * kn) / (2 * m^2)
        // (the "leave cur" term cancels symmetrically when we threshold > 0)
        const sigmaTot = commTotal.get(c) || 0;
        const gain = (kin / (m2 / 2)) - (sigmaTot * kn) / ((m2 * m2) / 2);
        // Subtract the cost of staying:
        const sigmaTotCur = (commTotal.get(cur) || 0) - kn; // Σtot of cur excluding n
        const stayCost = (selfWeightInCur / (m2 / 2)) - (sigmaTotCur * kn) / ((m2 * m2) / 2);
        const delta = gain - stayCost;
        if (delta > bestGain + MIN_GAIN) {
          bestGain = delta;
          bestComm = c;
        }
      }

      if (bestComm !== cur) {
        commTotal.set(cur, (commTotal.get(cur) || 0) - kn);
        commTotal.set(bestComm, (commTotal.get(bestComm) || 0) + kn);
        community.set(n, bestComm);
        moved++;
      }
    }

    if (moved === 0) break;
  }

  // ── 3. Group nodes by community label.
  const groups = new Map();           // communityId -> Set<nodeId>
  for (const [n, c] of community) {
    if (!groups.has(c)) groups.set(c, new Set());
    groups.get(c).add(n);
  }

  // Drop trivial communities (< minSize). Singletons aren't useful navigation.
  const meaningful = [...groups.values()].filter(s => s.size >= minSize);

  // Cap oversized communities (> maxFraction of nodes) — split via a
  // second pass on the subgraph. graphify does the same; the goal is
  // to prevent one giant community from absorbing most nodes (common
  // failure mode on dense graphs).
  const cap = Math.max(10, Math.floor(allNodes.length * maxFraction));
  const final = [];
  for (const set of meaningful) {
    if (set.size <= cap) {
      final.push(set);
    } else {
      const sub = _splitCommunity(set, adj, ki, m2);
      for (const s of sub) final.push(s);
    }
  }

  if (final.length === 0) {
    log?.info?.('[community] no meaningful communities found (graph too sparse or trivial)');
    return { runId: null, communityCount: 0, sizes: [], elapsedMs: Date.now() - startedAt };
  }

  // Sort by size descending so community 0 is the largest — matches
  // graphify's convention and gives stable ordering for prompt rendering.
  final.sort((a, b) => b.size - a.size);

  // ── 4. Persist. New run_id; supersede prior runs. node:sqlite has no
  // db.transaction() wrapper, so use explicit BEGIN/COMMIT — same pattern
  // as src/graph/export-import.js and workers/backup.js.
  const runId = _newRunId();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE node_groups SET superseded_at = CURRENT_TIMESTAMP WHERE superseded_at IS NULL").run();
    const insGroup = db.prepare("INSERT INTO node_groups (run_id, name, description, member_count, model) VALUES (?, ?, ?, ?, 'louvain')");
    const insMember = db.prepare("INSERT OR IGNORE INTO node_group_members (group_id, node_id, confidence) VALUES (?, ?, 1.0)");
    let idx = 0;
    for (const set of final) {
      const name = `community-${idx}`;
      const description = `${set.size} nodes (Louvain pass, run ${runId.slice(-6)})`;
      const r = insGroup.run(runId, name, description, set.size);
      const groupId = Number(r.lastInsertRowid);
      for (const nid of set) insMember.run(groupId, nid);
      idx++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* swallow — we're already in an error path */ }
    log?.error?.('[community] persist failed: ' + e.message);
    return { runId: null, communityCount: 0, sizes: [], elapsedMs: Date.now() - startedAt };
  }

  const sizes = final.map(s => s.size);
  const elapsed = Date.now() - startedAt;
  log?.info?.(`[community] ${final.length} communities (sizes: ${sizes.slice(0, 6).join(', ')}${sizes.length > 6 ? `, …` : ''}; ${elapsed}ms; run=${runId})`);

  return { runId, communityCount: final.length, sizes, elapsedMs: elapsed };
}

/**
 * Split an oversized community by running the same local-moves pass on
 * its induced subgraph. Returns an array of Sets. Mirrors the recursive
 * "subgraph re-run" pattern in graphify/cluster.py:_split_community.
 */
function _splitCommunity(memberSet, adj, ki, m2_total) {
  const members = [...memberSet];
  const community = new Map();
  for (const n of members) community.set(n, n);

  // Sub-adjacency restricted to in-community edges.
  const subAdj = new Map();
  const subKi = new Map();
  let subM2 = 0;
  for (const n of members) {
    subAdj.set(n, new Map());
    subKi.set(n, 0);
  }
  for (const n of members) {
    for (const [nb, w] of adj.get(n)) {
      if (!memberSet.has(nb)) continue;
      const cur = subAdj.get(n);
      cur.set(nb, (cur.get(nb) || 0) + w);
      subKi.set(n, subKi.get(n) + w);
      subM2 += w; // we double-count below by also iterating from nb
    }
  }
  // We overcounted by 2× via the symmetric walk above; the actual 2m is
  // simply the sum of subKi values which already counts each edge twice.
  subM2 = 0;
  for (const v of subKi.values()) subM2 += v;

  if (subM2 === 0) return [memberSet]; // no internal edges, can't split

  const commTotal = new Map();
  for (const n of members) commTotal.set(n, subKi.get(n));

  for (let iter = 0; iter < 10; iter++) {
    let moved = 0;
    for (const n of members) {
      const cur = community.get(n);
      const kn = subKi.get(n);
      const linkToComm = new Map();
      let selfWeightInCur = 0;
      for (const [nb, w] of subAdj.get(n)) {
        const c = community.get(nb);
        linkToComm.set(c, (linkToComm.get(c) || 0) + w);
        if (c === cur) selfWeightInCur += w;
      }
      let bestComm = cur, bestGain = 0;
      for (const [c, kin] of linkToComm) {
        if (c === cur) continue;
        const sigmaTot = commTotal.get(c) || 0;
        const sigmaTotCur = (commTotal.get(cur) || 0) - kn;
        const delta = (kin / (subM2 / 2)) - (sigmaTot * kn) / ((subM2 * subM2) / 2)
                    - (selfWeightInCur / (subM2 / 2)) + (sigmaTotCur * kn) / ((subM2 * subM2) / 2);
        if (delta > bestGain + MIN_GAIN) { bestGain = delta; bestComm = c; }
      }
      if (bestComm !== cur) {
        commTotal.set(cur, (commTotal.get(cur) || 0) - kn);
        commTotal.set(bestComm, (commTotal.get(bestComm) || 0) + kn);
        community.set(n, bestComm);
        moved++;
      }
    }
    if (moved === 0) break;
  }

  const groups = new Map();
  for (const [n, c] of community) {
    if (!groups.has(c)) groups.set(c, new Set());
    groups.get(c).add(n);
  }
  const subSets = [...groups.values()].filter(s => s.size >= 2);
  // If splitting didn't actually produce >1 community, return the original
  // (avoid pretending we made progress when we didn't).
  return subSets.length > 1 ? subSets : [memberSet];
}

function _hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

module.exports = { runCommunityDetection };
