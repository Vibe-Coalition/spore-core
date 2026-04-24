// graphcorn — session node persistence.
//
// Each acorn launch creates one `session-<sessionId>` node here at WS
// connect time (BEFORE the first chat:submit). Companion concept to
// `projects.js`'s per-(user, cwd) project node:
//   project node = "this codebase, across all sessions"
//   session node = "this single conversation, this launch"
//
// The session node is the anchor for everything graphcorn captures
// during the conversation: learner-extracted entities (linked via
// `discovered_in` edges from learner.js), agent-driven discoveries via
// the `note_discovery` tool, per-turn checkpoints, and the
// session-end summary.
//
// Schema (uses existing nodes/aspects/attributes/edges tables):
//   nodes
//     id          = `session-${sessionId}`
//     label       = `Session ${tail}` where tail is the timestamp suffix
//     type        = 'session'
//     description = `acorn session by ${userName} in ${cwd} (started ${startedAt})`
//     importance  = 6 — high enough to survive janitor pruning, lower
//                       than the project node so recall ranks the
//                       project ahead of any single session.
//   aspects
//     name='lifecycle'  attributes: started_at, ended_at (added on end),
//                                   turn_count (incremented per round)
//     name='model'      attribute: model name from projectContext
//     name='rounds'     attributes: per-turn breadcrumbs (Phase 5)
//     name='summary'    attribute: session-end summary (Phase 7)
//   edges
//     session-<id>  →  project-<userId-cwdHash>   type='part_of'
//     project-<id>  →  session-<sessionId>        type='has_session'
//                       (mirror so traversal works either way)

const projects = require('./projects');

function sessionNodeId(sessionId) {
  return 'session-' + String(sessionId || '').replace(/[^a-zA-Z0-9_:@.-]/g, '_').slice(0, 200);
}

// upsertSessionNode is idempotent. First call for a given sessionId
// creates the node + edges; subsequent calls bump `last_seen` only
// (you'd hit the second-call path if a client reconnects on a flaky
// network and re-sends session:start with the same id).
//
// `learner` is the GraphContext-attached object (same shape projects.js
// uses) — has `db` for the writable connection.
//
// Returns { id, isNew, projectId } or null if learner.db missing.
function upsertSessionNode(learner, opts = {}) {
  if (!learner?.db) return null;
  const { sessionId, userId, userName, cwd, model, startedAt } = opts;
  if (!sessionId) return null;
  const db = learner.db;
  const id = sessionNodeId(sessionId);

  // Always make sure the project node exists too — gives us the edge
  // target (and matches the user-cwd convention for the edge below).
  let projectId = null;
  if (cwd) {
    const projRes = projects.upsertProject(learner, userId || 'anon', {
      cwd, project: opts.project, gitBranch: opts.gitBranch, gitHash: opts.gitHash,
      projectType: opts.projectType, acornMd: opts.acornMd, tree: opts.tree,
      tools: opts.tools, os: opts.os, arch: opts.arch,
    });
    projectId = projRes?.id || null;
  }

  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  let isNew = false;
  if (!existing) {
    isNew = true;
    const tail = String(sessionId).split('-').pop() || sessionId;
    const label = 'Session ' + tail;
    const description =
      'acorn session' +
      (userName ? ' by ' + userName : '') +
      (cwd ? ' in ' + cwd : '') +
      (startedAt ? ' (started ' + startedAt + ')' : '');
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)'
    ).run(id, label, 'session', description, 6, 'graphcorn', 'session-start', new Date().toISOString());
  } else {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  // lifecycle aspect — started_at on first call, ended_at filled later
  // by finalizeSessionNode. turn_count starts at 0 and bumps per round.
  let asp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'lifecycle'").get(id);
  if (!asp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'lifecycle', 8, 'graphcorn')").run(id);
    asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    if (startedAt) {
      db.prepare(
        "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'session-start', 'graphcorn')"
      ).run(asp.id, 'started_at: ' + startedAt);
    }
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, 'turn_count: 0', 8, 'session-start', 'graphcorn')"
    ).run(asp.id);
  }

  if (model) {
    let mAsp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'model'").get(id);
    if (!mAsp) {
      db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'model', 6, 'graphcorn')").run(id);
      mAsp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      db.prepare(
        "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'session-start', 'graphcorn')"
      ).run(mAsp.id, model);
    }
  }

  // Edges to project node — both directions, idempotent.
  if (projectId) {
    const checkE = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?');
    const insE = db.prepare(
      "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1, 'graphcorn')"
    );
    if (!checkE.get(id, projectId, 'part_of')) insE.run(id, projectId, 'part_of');
    if (!checkE.get(projectId, id, 'has_session')) insE.run(projectId, id, 'has_session');
  }

  return { id, isNew, projectId };
}

// finalizeSessionNode is called when SPORE receives session:end. Adds
// ended_at to the lifecycle aspect; the summary + turn_count get
// updated by their respective phases (5 and 7) directly. Idempotent —
// multiple session:end frames (rare but possible on flaky reconnects)
// just overwrite the same attribute via INSERT OR REPLACE-style flow.
function finalizeSessionNode(learner, sessionId, opts = {}) {
  if (!learner?.db || !sessionId) return;
  const db = learner.db;
  const id = sessionNodeId(sessionId);
  const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  if (!node) return; // session never started — nothing to finalize

  const asp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'lifecycle'").get(id);
  if (!asp) return;

  if (opts.endedAt) {
    // Replace any existing ended_at attribute so reruns don't dupe.
    db.prepare("DELETE FROM attributes WHERE aspect_id = ? AND content LIKE 'ended_at:%'").run(asp.id);
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'session-end', 'graphcorn')"
    ).run(asp.id, 'ended_at: ' + opts.endedAt);
  }
}

// bumpTurnCount — called from loop.js at end of each round. Maintains
// a single 'turn_count: N' attribute on the lifecycle aspect.
function bumpTurnCount(learner, sessionId) {
  if (!learner?.db || !sessionId) return 0;
  const db = learner.db;
  const id = sessionNodeId(sessionId);
  const asp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'lifecycle'").get(id);
  if (!asp) return 0;
  const cur = db.prepare("SELECT id, content FROM attributes WHERE aspect_id = ? AND content LIKE 'turn_count:%'").get(asp.id);
  let next = 1;
  if (cur) {
    const m = String(cur.content).match(/turn_count:\s*(\d+)/);
    next = (m ? parseInt(m[1], 10) : 0) + 1;
    db.prepare('UPDATE attributes SET content = ? WHERE id = ?').run('turn_count: ' + next, cur.id);
  } else {
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'graphcorn', 'graphcorn')"
    ).run(asp.id, 'turn_count: 1');
  }
  return next;
}

// summarizeSessionNode — Phase 7. Reads the round-checkpoint
// breadcrumbs from the session node's `rounds` aspect, asks a small
// LLM to synthesize them into a human-scannable recap, and writes
// the result to a new `summary` aspect. Result is NOT echoed back to
// chat — it's pure graph persistence for future cross-session recall.
//
// Prefer this over a full agent loop for end-of-session work: cheaper
// (one short input prompt), faster (no tool round-trips), and avoids
// the agent dispatching tools during a session that's literally
// closing. Fail-soft — any error logs and returns without writing.
async function summarizeSessionNode(learner, llmClient, config, sessionId, log) {
  if (!learner?.db || !llmClient || !sessionId) return;
  const id = sessionNodeId(sessionId);
  const db = learner.db;
  const node = db.prepare('SELECT id, label FROM nodes WHERE id = ?').get(id);
  if (!node) return; // session never started

  // Pull the round breadcrumbs — chronological from oldest to newest.
  const rows = db.prepare(
    "SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='rounds' ORDER BY a.id ASC"
  ).all(id);
  if (rows.length === 0) {
    if (log) log.info(`[graphcorn] summary skipped for ${id} (no rounds recorded)`);
    return;
  }

  // Pull turn count + model + lifecycle for context
  const ctxRows = db.prepare(
    "SELECT asp.name as aspect, a.content as attr FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name IN ('lifecycle','model')"
  ).all(id);
  const ctxLines = ctxRows.map(r => `${r.aspect}: ${r.attr}`).join('\n');

  const roundLines = rows.slice(-50).map(r => '  ' + r.content).join('\n');
  const prompt = [
    'You are summarizing an acorn coding session for graph-side persistence.',
    'The summary will be stored on the session node as a `summary` aspect — future agents on this project will retrieve it via graph_query and use it to remember what happened.',
    '',
    `Session: ${node.label} (${id})`,
    ctxLines,
    '',
    'Rounds (chronological, "turn N | tools used | files touched | first sentence of agent reply"):',
    roundLines,
    '',
    'Write a concise recap (≤200 words) covering: (1) what the user worked on, (2) key decisions/discoveries, (3) blockers or open issues, (4) which graph nodes (if any) future sessions should reference.',
    'Plain prose, no markdown headers. Speak as if writing notes to your future self.',
  ].join('\n');

  try {
    const model = config?.casualModel || config?.normalModel || config?.model;
    const resp = await llmClient.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = ((resp?.content || []).find(b => b.type === 'text')?.text || '').trim();
    if (!text) {
      if (log) log.warn(`[graphcorn] summary for ${id} returned empty text`);
      return;
    }
    // Replace any prior summary aspect (if session ended twice on a
    // flaky reconnect) so we don't dupe.
    let asp = db.prepare("SELECT id FROM aspects WHERE node_id=? AND name='summary'").get(id);
    if (asp) {
      db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(asp.id);
    } else {
      db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'summary', 8, 'graphcorn')").run(id);
      asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'session-end', 'graphcorn')"
    ).run(asp.id, text);
    if (log) log.info(`[graphcorn] session ${id} summary written (${text.length} chars, ${rows.length} rounds, model=${model})`);
  } catch (e) {
    if (log) log.warn(`[graphcorn] summary for ${id} failed: ${e.message}`);
  }
}

module.exports = { sessionNodeId, upsertSessionNode, finalizeSessionNode, bumpTurnCount, summarizeSessionNode };
