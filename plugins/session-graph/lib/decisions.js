// decisions.js — generic project-scoped ADR primitives.
//
// Same dedicated-node pattern as scripts.js: full ADR text lives on
// dedicated `decision:<projectId>:<id>` nodes (one per record) with
// body + meta aspects, and a lightweight `decisions_index` aspect on
// the project node carries one one-line summary entry per decision so
// `decisions_list` is cheap.
//
// Why dedicated nodes (not slices on an aspect array):
//   - mirrors the existing note_discovery → discovery-* pattern and
//     scripts.js → script:* pattern
//   - workers (learner, maintainer, janitor) handle these as generic
//     nodes — no special-casing
//   - embeddings can index meta.title for "find me decisions about X"
//   - cross-project queries become possible: "every project where I've
//     deprecated jest in favor of vitest"

const crypto = require('crypto');

// projectNodeId mirrors projects.js's identity convention. Inlined
// here so this lib doesn't pull projects.js (no circular require risk
// with future structure).
function projectNodeId(userId, cwd) {
  const u = (userId || 'anon').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  const h = crypto.createHash('sha256').update(cwd || '').digest('hex').slice(0, 8);
  return `project-${u}-${h}`;
}

// decisionNodeId — `decision:<projectId>:<safe-id>`. id is either
// supplied by the caller (e.g. "0042" or "auth-rewrite") or derived
// from the title.
function decisionNodeId(projectId, id) {
  const safe = String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!safe) return null;
  return `decision:${projectId}:${safe}`;
}

const VALID_STATUSES = new Set(['proposed', 'accepted', 'rejected', 'superseded', 'deprecated']);
const INDEX_ASPECT = 'decisions_index';
const INDEX_WEIGHT = 7;
const MAX_INDEX_ENTRIES = 100;

function ensureDecisionsIndexAspect(db, projectId) {
  let row = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(projectId, INDEX_ASPECT);
  if (!row) {
    db.prepare(
      "INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, 'session-graph')"
    ).run(projectId, INDEX_ASPECT, INDEX_WEIGHT);
    row = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  return row.id;
}

function loadIndexEntries(db, projectId) {
  const aspId = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(projectId, INDEX_ASPECT)?.id;
  if (!aspId) return [];
  const rows = db.prepare('SELECT id, content FROM attributes WHERE aspect_id = ?').all(aspId);
  const out = [];
  for (const r of rows) {
    try {
      const e = JSON.parse(r.content);
      e.__attrId = r.id;
      out.push(e);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function writeIndexEntry(db, projectId, entry) {
  const aspId = ensureDecisionsIndexAspect(db, projectId);
  const existing = loadIndexEntries(db, projectId).find(e => e.id === entry.id);
  const json = JSON.stringify(entry);
  if (existing) {
    db.prepare('UPDATE attributes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(json, existing.__attrId);
  } else {
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'session-graph', 'session-graph')"
    ).run(aspId, json);
    // Cap — drop oldest by created_at over the limit. ADR records
    // are typically fewer than scripts; the cap is mostly a runaway
    // guard.
    const all = loadIndexEntries(db, projectId);
    if (all.length > MAX_INDEX_ENTRIES) {
      all.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      const toDrop = all.slice(0, all.length - MAX_INDEX_ENTRIES);
      const ids = toDrop.map(e => e.__attrId);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM attributes WHERE id IN (${placeholders})`).run(...ids);
    }
  }
}

function ensureDecisionNode(db, decisionId, title, sessionId) {
  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(decisionId);
  if (existing) {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(decisionId);
    return false;
  }
  // Decisions are intentionally NOT born temp — an ADR is an explicit
  // act of recording a non-trivial choice and should survive
  // session-end distillation. The agent calls decisions_new only when
  // the operator confirms.
  const extraJson = '{}';
  db.prepare(
    'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
  ).run(
    decisionId, title, 'decision', title, 7,
    'session-graph', 'decisions_new', new Date().toISOString(), extraJson,
  );
  return true;
}

function ensureAspect(db, nodeId, name, weight) {
  let row = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, name);
  if (!row) {
    db.prepare(
      "INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, 'session-graph')"
    ).run(nodeId, name, weight);
    row = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  return row.id;
}

function replaceAttrs(db, aspectId, contents, importance) {
  db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(aspectId);
  for (const c of contents) {
    if (!c) continue;
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, 'session-graph', 'session-graph')"
    ).run(aspectId, String(c), importance);
  }
}

function ensureEdge(db, source, target, type) {
  const existing = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?').get(source, target, type);
  if (existing) return;
  db.prepare(
    "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1, 'session-graph')"
  ).run(source, target, type);
}

// ── Public API ─────────────────────────────────────────────────────

function newDecision(learner, opts) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const { projectId, sessionId, id: rawId, title, body, status, author } = opts;
  if (!projectId) return { ok: false, error: 'projectId required' };
  if (!title || !String(title).trim()) return { ok: false, error: 'title required' };
  if (!body || !String(body).trim()) return { ok: false, error: 'body required' };

  // Default status: proposed. The operator marks accepted later.
  const finalStatus = VALID_STATUSES.has(status) ? status : 'proposed';

  // Synthesize an id from the title when not supplied.
  const id = rawId || title;
  const decisionId = decisionNodeId(projectId, id);
  if (!decisionId) return { ok: false, error: 'id produced an empty slug' };

  const db = learner.db;
  const projRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(projectId);
  if (!projRow) return { ok: false, error: `project node ${projectId} not found` };

  // Reject re-creating an existing decision; force update via decisions_update.
  if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(decisionId)) {
    return { ok: false, error: `decision ${decisionId} already exists; use decisions_update to change it` };
  }

  ensureDecisionNode(db, decisionId, String(title).trim(), sessionId);
  replaceAttrs(db, ensureAspect(db, decisionId, 'body', 9), [String(body).trim()], 9);
  const meta = [
    `status: ${finalStatus}`,
    `created_at: ${new Date().toISOString()}`,
    `updated_at: ${new Date().toISOString()}`,
  ];
  if (author) meta.push(`author: ${author}`);
  replaceAttrs(db, ensureAspect(db, decisionId, 'meta', 7), meta, 6);

  ensureEdge(db, projectId, decisionId, 'has_decision');

  // Strip the decision id back out of the namespaced node id for the
  // user-facing summary.
  const shortId = decisionId.split(':').slice(2).join(':') || decisionId;

  writeIndexEntry(db, projectId, {
    id: shortId,
    title: String(title).trim(),
    status: finalStatus,
    created_at: new Date().toISOString(),
  });

  return { ok: true, decisionNodeId: decisionId, id: shortId, status: finalStatus };
}

function listDecisions(learner, projectId, filter = {}) {
  if (!learner?.db || !projectId) return [];
  const entries = loadIndexEntries(learner.db, projectId);
  return entries
    .filter(e => !filter.status || e.status === filter.status)
    .map(e => {
      const out = { ...e };
      delete out.__attrId;
      return out;
    });
}

function getDecision(learner, projectId, id) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const db = learner.db;
  const decisionId = decisionNodeId(projectId, id);
  if (!decisionId) return { ok: false, error: 'id produced an empty slug' };
  const node = db.prepare('SELECT id, label FROM nodes WHERE id = ?').get(decisionId);
  if (!node) return { ok: false, error: `no decision ${id} in this project` };

  const rows = db.prepare(`
    SELECT asp.name AS aspect, a.content
      FROM aspects asp
      JOIN attributes a ON a.aspect_id = asp.id
     WHERE asp.node_id = ?
     ORDER BY asp.name
  `).all(decisionId);

  const aspects = {};
  for (const r of rows) {
    if (!aspects[r.aspect]) aspects[r.aspect] = [];
    aspects[r.aspect].push(r.content);
  }
  const body = (aspects.body || []).join('\n');
  const meta = {};
  for (const line of aspects.meta || []) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(decisionId);
  return { ok: true, decisionNodeId: decisionId, id, title: node.label, body, meta };
}

function updateDecision(learner, opts) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const { projectId, id, status, body, title } = opts;
  const db = learner.db;
  const decisionId = decisionNodeId(projectId, id);
  if (!decisionId) return { ok: false, error: 'id produced an empty slug' };
  const node = db.prepare('SELECT id, label FROM nodes WHERE id = ?').get(decisionId);
  if (!node) return { ok: false, error: `no decision ${id} in this project` };

  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return { ok: false, error: `invalid status; one of: ${[...VALID_STATUSES].join(', ')}` };
  }

  if (body) {
    replaceAttrs(db, ensureAspect(db, decisionId, 'body', 9), [String(body).trim()], 9);
  }
  if (title) {
    db.prepare('UPDATE nodes SET label = ?, description = ? WHERE id = ?').run(String(title).trim(), String(title).trim(), decisionId);
  }

  // Always touch updated_at; rewrite the meta aspect from the index entry.
  const entry = loadIndexEntries(db, projectId).find(e => e.id === id);
  const created = entry?.created_at || new Date().toISOString();
  const finalStatus = status !== undefined ? status : (entry?.status || 'proposed');
  const meta = [
    `status: ${finalStatus}`,
    `created_at: ${created}`,
    `updated_at: ${new Date().toISOString()}`,
  ];
  replaceAttrs(db, ensureAspect(db, decisionId, 'meta', 7), meta, 6);

  // Refresh the summary entry.
  writeIndexEntry(db, projectId, {
    id,
    title: title ? String(title).trim() : (entry?.title || node.label),
    status: finalStatus,
    created_at: created,
  });

  return { ok: true, decisionNodeId: decisionId, status: finalStatus };
}

module.exports = {
  projectNodeId,
  decisionNodeId,
  newDecision,
  listDecisions,
  getDecision,
  updateDecision,
  VALID_STATUSES: [...VALID_STATUSES],
};
