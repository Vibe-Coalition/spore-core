/**
 * overview.js — Graph Overview computation.
 *
 * Three analytics over the runtime graph, ported from graphify/analyze.py:
 *   • god_nodes — top-N most-connected real entities (the agent's core
 *     abstractions). Excludes synthetic-hub patterns (file-like labels,
 *     tool nodes, concept-only labels with no source_file equivalent).
 *   • bridges — cross-community / peripheral-to-hub / inferred edges,
 *     ranked by a composite surprise score. Skips structural edge types
 *     that mechanically dominate (contains, mentioned, has_capability).
 *   • questions — orientation questions the graph is uniquely positioned
 *     to answer, derived from AMBIGUOUS edges, bridge nodes (high
 *     betweenness), INFERRED-heavy god nodes, and isolated nodes.
 *
 * Run by the maintainer after community detection (B1). Persists the
 * latest run as a single non-superseded row in `graph_overviews`.
 *
 * Surfacing:
 *   • _buildOverviewSection (B3) reads the latest payload into the system
 *     prompt as a 300–400-token "Graph Overview" section.
 *   • GET /api/graph-overview (B4) returns the payload as JSON for the
 *     graph viewer / debug UI.
 */

'use strict';

const crypto = require('crypto');

const STRUCTURAL_RELATIONS = new Set([
  'contains', 'has_capability', 'has_tool', 'mentioned', 'discovered_in',
  'parent_of', 'imports', 'method',
]);

// Type families: edges crossing families and tagged INFERRED are likely
// false positives (a tool↔person 'knows' link, a session↔concept
// 'depends_on' link). Mirrors graphify's _LANG_FAMILY rule.
const NODE_TYPE_FAMILY = {
  person: 'social', organization: 'social', channel: 'social',
  tool: 'system', system: 'system', capability: 'system', skill: 'system',
  project: 'work', session: 'work', script: 'work', task: 'work',
  concept: 'idea', lore: 'idea', rule: 'idea', anti: 'idea', voice: 'idea',
  event: 'temporal', episode: 'temporal',
};

function _runId() {
  return 'ovw-' + crypto.randomBytes(6).toString('hex');
}

function _family(t) {
  return NODE_TYPE_FAMILY[t] || 'other';
}

/**
 * Compute the graph overview and persist it. Idempotent — the previous
 * non-superseded row is marked superseded as part of the same transaction.
 *
 * @param {object} db — node:sqlite database
 * @param {object} log — logger
 * @param {object} [opts]
 * @param {number} [opts.topGodNodes=8] — keep this many god nodes
 * @param {number} [opts.topBridges=8] — keep this many surprising bridges
 * @param {number} [opts.topQuestions=5] — keep this many questions
 * @returns {{ runId: string, payload: object, elapsedMs: number }|null}
 */
function computeOverview(db, log, opts = {}) {
  const startedAt = Date.now();
  const topGodNodes = opts.topGodNodes ?? 8;
  const topBridges = opts.topBridges ?? 8;
  const topQuestions = opts.topQuestions ?? 5;

  if (!db) return null;

  // ── Load nodes + edges into memory. Spore graphs are <10k nodes
  // typically; one shot is fine and avoids per-question SQL chatter.
  const nodes = db.prepare(
    'SELECT id, label, type, importance, mentions FROM nodes'
  ).all();
  if (nodes.length === 0) return null;

  const edges = db.prepare(
    'SELECT source, target, type, weight, confidence FROM edges'
  ).all();
  if (edges.length === 0) {
    log?.info?.('[overview] graph has no edges — nothing to summarize');
    return null;
  }

  // Quick lookups.
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Adjacency (undirected for centrality + community membership lookups).
  const degree = new Map();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    if (e.source === e.target) continue;
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Community membership (current/non-superseded run from B1).
  const memberOf = new Map();
  try {
    const rows = db.prepare(`
      SELECT m.node_id, m.group_id
      FROM node_group_members m
      JOIN node_groups g ON g.id = m.group_id
      WHERE g.superseded_at IS NULL
    `).all();
    for (const r of rows) memberOf.set(r.node_id, r.group_id);
  } catch (e) {
    log?.debug?.('[overview] community lookup failed: ' + e.message);
  }

  // ── 1. God nodes. Composite score:
  //   degree + log(1 + mentions) + importance/2
  // Excludes nodes that look like synthetic hubs and (when the graph
  // has any edges at all) excludes degree-0 orphans — those belong in
  // the "isolated nodes" question section, not the core-abstractions list.
  const godNodes = nodes
    .filter(n => !_isSyntheticHub(n))
    .filter(n => (degree.get(n.id) || 0) >= 1)
    .map(n => ({
      id: n.id,
      label: n.label || n.id,
      type: n.type || '',
      degree: degree.get(n.id) || 0,
      mentions: n.mentions || 0,
      importance: n.importance || 5,
      score: (degree.get(n.id) || 0)
        + Math.log(1 + (n.mentions || 0))
        + (n.importance || 5) / 2,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topGodNodes);

  // Quick lookup for bridge scoring.
  const godIds = new Set(godNodes.map(g => g.id));

  // ── 2. Surprising bridges. Score per edge.
  const bridgeCandidates = [];
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (STRUCTURAL_RELATIONS.has(e.type)) continue;
    const u = nodeById.get(e.source);
    const v = nodeById.get(e.target);
    if (!u || !v) continue;

    let score = 0;
    const reasons = [];

    // Confidence bonus.
    if (e.confidence === 'ambiguous') { score += 3; reasons.push('ambiguous edge'); }
    else if (e.confidence === 'inferred') { score += 2; reasons.push('inferred edge'); }
    else { score += 1; }

    // Cross-family penalty for inferred edges connecting unrelated types.
    const sameFamily = _family(u.type) === _family(v.type);
    if (e.confidence === 'inferred' && !sameFamily) {
      // Likely false positive — downweight rather than upweight.
      score -= 1;
      reasons.push('cross-family (suspected false positive)');
    } else if (!sameFamily) {
      score += 1;
      reasons.push(`crosses ${_family(u.type)} ↔ ${_family(v.type)}`);
    }

    // Cross-community bonus.
    const cu = memberOf.get(u.id);
    const cv = memberOf.get(v.id);
    if (cu !== undefined && cv !== undefined && cu !== cv) {
      score += 2;
      reasons.push('bridges separate communities');
    }

    // Peripheral → god-node bonus.
    const du = degree.get(u.id) || 0;
    const dv = degree.get(v.id) || 0;
    const peripheralHitsGod =
      (du <= 2 && godIds.has(v.id) && dv >= 5) ||
      (dv <= 2 && godIds.has(u.id) && du >= 5);
    if (peripheralHitsGod) {
      score += 1;
      const peripheral = du <= 2 ? u : v;
      const hub = du <= 2 ? v : u;
      reasons.push(`peripheral '${peripheral.label || peripheral.id}' reaches god node '${hub.label || hub.id}'`);
    }

    if (score >= 2) {
      bridgeCandidates.push({
        source: u.id,
        source_label: u.label || u.id,
        target: v.id,
        target_label: v.label || v.id,
        relation: e.type,
        confidence: e.confidence || null,
        why: reasons.join('; ') || 'cross-graph signal',
        _score: score,
      });
    }
  }
  bridgeCandidates.sort((a, b) => b._score - a._score);
  const bridges = bridgeCandidates.slice(0, topBridges).map(b => {
    const { _score, ...rest } = b;
    return rest;
  });

  // ── 3. Suggested questions.
  const questions = [];

  // 3a. AMBIGUOUS edges → unresolved-relationship questions.
  for (const e of edges) {
    if (e.confidence !== 'ambiguous') continue;
    const u = nodeById.get(e.source);
    const v = nodeById.get(e.target);
    if (!u || !v) continue;
    questions.push({
      type: 'ambiguous_edge',
      question: `What is the actual relationship between '${u.label || u.id}' and '${v.label || v.id}'?`,
      why: `Edge tagged AMBIGUOUS (relation: ${e.type}) — confidence is low and the link should be confirmed or removed.`,
    });
    if (questions.length >= topQuestions) break;
  }

  // 3b. INFERRED-heavy god nodes → verification questions.
  if (questions.length < topQuestions) {
    for (const g of godNodes) {
      const inferredEdges = edges.filter(e =>
        (e.source === g.id || e.target === g.id) && e.confidence === 'inferred'
      );
      if (inferredEdges.length >= 3) {
        const others = inferredEdges.slice(0, 2).map(e => {
          const otherId = e.source === g.id ? e.target : e.source;
          const o = nodeById.get(otherId);
          return o ? (o.label || o.id) : otherId;
        });
        questions.push({
          type: 'verify_inferred',
          question: `Are the ${inferredEdges.length} inferred relationships involving '${g.label}' (e.g. with '${others[0]}'${others[1] ? `, '${others[1]}'` : ''}) actually correct?`,
          why: `'${g.label}' is a high-degree node with ${inferredEdges.length} INFERRED edges — these are model deductions that warrant human confirmation.`,
        });
        if (questions.length >= topQuestions) break;
      }
    }
  }

  // 3c. Isolated nodes → connection questions.
  if (questions.length < topQuestions) {
    const isolated = nodes
      .filter(n => (degree.get(n.id) || 0) <= 1 && !_isSyntheticHub(n))
      .slice(0, 3);
    if (isolated.length >= 2) {
      const labels = isolated.map(n => `'${n.label || n.id}'`).join(', ');
      questions.push({
        type: 'isolated_nodes',
        question: `What connects ${labels} to the rest of the graph?`,
        why: `${isolated.length} weakly-connected node(s) found — possible documentation gaps or missing edges.`,
      });
    }
  }

  // 3d. Cross-community bridges with no question yet → "why does X bridge Y to Z?"
  if (questions.length < topQuestions && bridges.length > 0) {
    for (const b of bridges) {
      if (questions.length >= topQuestions) break;
      if (!b.why.includes('bridges separate communities')) continue;
      questions.push({
        type: 'bridge_node',
        question: `Why does the relation '${b.relation}' connect '${b.source_label}' to '${b.target_label}' across distinct communities?`,
        why: `Cross-community bridge edge (${b.confidence || 'extracted'}) — these are structural couplings that often hide important context.`,
      });
    }
  }

  // ── 4. Persist.
  const payload = {
    god_nodes: godNodes.map(g => ({
      id: g.id, label: g.label, type: g.type,
      degree: g.degree, mentions: g.mentions, importance: g.importance,
    })),
    bridges,
    questions,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      community_count: new Set([...memberOf.values()]).size,
      ambiguous_edges: edges.filter(e => e.confidence === 'ambiguous').length,
      inferred_edges: edges.filter(e => e.confidence === 'inferred').length,
    },
  };

  const runId = _runId();
  const json = JSON.stringify(payload);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE graph_overviews SET superseded_at = CURRENT_TIMESTAMP WHERE superseded_at IS NULL').run();
    db.prepare('INSERT INTO graph_overviews (run_id, payload) VALUES (?, ?)').run(runId, json);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* swallow — we're already in an error path */ }
    log?.error?.('[overview] persist failed: ' + e.message);
    return null;
  }

  const elapsed = Date.now() - startedAt;
  log?.info?.(`[overview] god=${payload.god_nodes.length} bridges=${payload.bridges.length} questions=${payload.questions.length} (${elapsed}ms; run=${runId})`);

  return { runId, payload, elapsedMs: elapsed };
}

/**
 * Best-effort heuristic for synthetic-hub nodes that shouldn't show up as
 * god nodes (file-like labels, tool stubs, capability nodes). Mirrors
 * graphify's _is_file_node + _is_concept_node combined check.
 */
function _isSyntheticHub(node) {
  const label = String(node.label || node.id || '');
  const type = String(node.type || '');
  // Tool / capability stubs and process / system nodes are deliberately
  // skipped — they're scaffolding, not knowledge centroids.
  if (type === 'tool' || type === 'capability') return true;
  // File-like labels (rare but happens with imported docs).
  if (/\.(md|json|js|ts|py|go|sql|sh|html|css)$/i.test(label)) return true;
  // Method-stub labels (.foo() / .__init__()).
  if (/^\.[a-z_][a-z0-9_]*\(\)$/i.test(label)) return true;
  return false;
}

module.exports = { computeOverview };
