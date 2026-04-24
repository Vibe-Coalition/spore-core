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
// Event bus — lets the graph viewer (and any other subscribers) see
// distillation work live. Without this, summarize/distill runs silently
// from the viewer's POV; a fresh node appears only after manual refresh.
const graphEvents = require('./events');

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
  // Pass sessionId so the project node is born temp + session-tagged
  // ONLY if it's freshly created in this session. Returning users hit
  // an already-permanent project node; upsertProject leaves its extra
  // alone in that case.
  let projectId = null;
  if (cwd) {
    const projRes = projects.upsertProject(learner, userId || 'anon', {
      cwd, project: opts.project, gitBranch: opts.gitBranch, gitHash: opts.gitHash,
      projectType: opts.projectType, acornMd: opts.acornMd, tree: opts.tree,
      tools: opts.tools, os: opts.os, arch: opts.arch,
      sessionId,
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
    // Born temp + tagged with self sessionId so the existing 48h
    // janitor reaps the session node 48h after creation if nothing
    // promotes it. Distillation sets extra.distilled_at on this node
    // for idempotency; that flag survives the temp tagging.
    const extraJson = JSON.stringify({ ttl: 'temp', sessionId, tempCreated: new Date().toISOString() });
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
    ).run(id, label, 'session', description, 6, 'graphcorn', 'session-start', new Date().toISOString(), extraJson);
    graphEvents.emit('change', { op: 'node:create', node: { id, label, type: 'session', description }, source: 'graphcorn' });
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
  const node = db.prepare('SELECT id, label, extra FROM nodes WHERE id = ?').get(id);
  if (!node) return; // session never started

  // Idempotency: graceful close calls this from session:end, then
  // ws.on('close') chains it again. Mark on first success so the
  // second call short-circuits instead of repeating the LLM call.
  let extraObj = {};
  try { extraObj = node.extra ? JSON.parse(node.extra) : {}; } catch {}
  if (extraObj.summarized_at) {
    if (log) log.info(`[graphcorn] summary already written for ${id} at ${extraObj.summarized_at}, skipping`);
    return;
  }

  graphEvents.emit('change', { op: 'session:summarize-start', nodeId: id, source: 'graphcorn' });

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
      // Mark as "summarized" (empty) so repeat calls from the
      // ws.on('close') chain don't re-call the LLM. Without this we
      // double-charge on every ungraceful disconnect.
      extraObj.summarized_at = new Date().toISOString();
      extraObj.summarized_empty = true;
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extraObj), id);
      if (log) log.warn(`[graphcorn] summary for ${id} returned empty text — marked to avoid retries`);
      graphEvents.emit('change', { op: 'session:summarize-done', nodeId: id, empty: true, source: 'graphcorn' });
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
    extraObj.summarized_at = new Date().toISOString();
    db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(extraObj), id);
    graphEvents.emit('change', { op: 'aspect:create', nodeId: id, aspect: 'summary', source: 'graphcorn' });
    graphEvents.emit('change', { op: 'attribute:create', nodeId: id, aspect: 'summary', content: text, source: 'graphcorn' });
    graphEvents.emit('change', { op: 'session:summarize-done', nodeId: id, empty: false, chars: text.length, source: 'graphcorn' });
    if (log) log.info(`[graphcorn] session ${id} summary written (${text.length} chars, ${rows.length} rounds, model=${model})`);
  } catch (e) {
    if (log) log.warn(`[graphcorn] summary for ${id} failed: ${e.message}`);
    graphEvents.emit('change', { op: 'session:summarize-done', nodeId: id, error: e.message, source: 'graphcorn' });
  }
}

// distillSession — Phase 8 (extends Phase 7).
//
// Background: every node born inside an acorn session is now stamped
// extra.ttl='temp' + extra.sessionId. That covers note_discovery, the
// learner, and graph_update calls made by the agent. Without this
// distillation step they'd auto-clean in 48h via the existing janitor —
// which loses signal. Distillation runs on session close (graceful or
// not) and:
//
//   1. Pulls every session-temp node + its aspects/attributes/edges.
//   2. Asks a small LLM: which of these belong in the permanent graph,
//      and what should we add to existing permanent nodes (e.g. append
//      "learned in session X: ..." to the framework's gotchas).
//   3. PROMOTES the winners by clearing their temp flag.
//   4. APPENDS the agent's "what we learned" notes onto target nodes
//      (which may be permanent nodes that already existed before this
//      session — that's the merge case).
//   5. SOFT-DELETES everything else into recycle_bin with a 7-day
//      expiry. The existing janitor housekeeping pass cleans the bin.
//
// Idempotent via extra.distilled_at on the session node — a second call
// (e.g. session:end frame followed by ws.on('close')) is a no-op.
//
// Failure mode: distillation never throws to the caller; the session
// node gets extra.distill_error set so we can spot trouble. Temps stay
// temp and the existing 48h janitor is the safety net.
async function distillSession(learner, llmClient, config, sessionId, log) {
  if (!learner?.db || !llmClient || !sessionId) return { skipped: 'missing-deps' };
  const db = learner.db;
  const id = sessionNodeId(sessionId);
  const node = db.prepare('SELECT id, extra FROM nodes WHERE id = ?').get(id);
  if (!node) {
    if (log) log.info(`[distill] ${id} session node missing — nothing to distill`);
    return { skipped: 'no-session-node' };
  }
  let extraObj = {};
  try { extraObj = node.extra ? JSON.parse(node.extra) : {}; } catch {}
  if (extraObj.distilled_at) {
    if (log) log.info(`[distill] ${id} already distilled at ${extraObj.distilled_at}, skipping`);
    return { skipped: 'already-distilled' };
  }
  if (extraObj.distilling) {
    if (log) log.info(`[distill] ${id} distillation in progress (concurrent call), skipping`);
    return { skipped: 'in-progress' };
  }

  // Race lock — both session:end frame and ws.on('close') can fire.
  // Setting `distilling` makes the second caller bail at the check above.
  extraObj.distilling = true;
  db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(extraObj), id);
  graphEvents.emit('change', { op: 'session:distill-start', nodeId: id, source: 'graphcorn' });

  try {
    // Exclude the session node itself from the candidate list — it
    // holds extra.distilled_at for idempotency, so the LLM can't promote
    // or drop it. The existing 48h janitor still reaps it from
    // tempCreated, just like any other unloved temp node, so the
    // "session leaves no permanent trace" semantic is preserved.
    const tempRows = db.prepare(
      "SELECT id, label, type, description, extra FROM nodes WHERE json_extract(extra, '$.sessionId') = ? AND json_extract(extra, '$.ttl') = 'temp' AND id != ?"
    ).all(sessionId, id);

    if (tempRows.length === 0) {
      extraObj.distilled_at = new Date().toISOString();
      extraObj.distilled_promoted = 0;
      extraObj.distilled_dropped = 0;
      delete extraObj.distilling;
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extraObj), id);
      graphEvents.emit('change', { op: 'session:distill-done', nodeId: id, promoted: 0, created: 0, dropped: 0, notesAppended: 0, empty: true, source: 'graphcorn' });
      if (log) log.info(`[distill] ${id} no session-temp nodes — marked complete`);
      return { promoted: 0, dropped: 0 };
    }

    // Build a per-node digest the LLM can read. Cap aspects/attrs to
    // keep the prompt bounded.
    const aspStmt = db.prepare(
      "SELECT asp.name AS aspect_name, a.content AS attr FROM aspects asp LEFT JOIN attributes a ON a.aspect_id = asp.id WHERE asp.node_id = ? ORDER BY asp.id, a.id LIMIT 60"
    );
    const edgeStmt = db.prepare(
      "SELECT target, type FROM edges WHERE source = ? LIMIT 10"
    );
    const digests = tempRows.map(n => {
      const aspects = aspStmt.all(n.id);
      const grouped = {};
      for (const r of aspects) {
        if (!grouped[r.aspect_name]) grouped[r.aspect_name] = [];
        if (r.attr) grouped[r.aspect_name].push(r.attr);
      }
      return {
        id: n.id,
        label: n.label,
        type: n.type,
        description: (n.description || '').slice(0, 300),
        aspects: grouped,
        edges: edgeStmt.all(n.id),
      };
    });

    // Pull session summary + a few rounds for context (so the LLM sees
    // what the user was actually working on).
    const summaryRow = db.prepare(
      "SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='summary' ORDER BY a.id DESC LIMIT 1"
    ).get(id);
    const sessionSummary = summaryRow?.content || '(no summary; distillation running before session summarizer or agent declined to summarize)';
    const roundRows = db.prepare(
      "SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='rounds' ORDER BY a.id DESC LIMIT 10"
    ).all(id);
    const recentRounds = roundRows.reverse().map(r => '  ' + r.content).join('\n');

    const promptText = [
      'You are distilling an acorn coding session into permanent graph knowledge. Your job is to keep the SIGNAL and drop the NOISE.',
      '',
      `Session: ${id}`,
      'Session summary:',
      sessionSummary,
      '',
      `Recent rounds (last 10):\n${recentRounds || '  (no rounds recorded)'}`,
      '',
      `${tempRows.length} temporary nodes were created during this session. You have THREE operations — use all of them:`,
      '  • PROMOTE — keep an existing temp node as permanent (the user/future sessions will benefit)',
      '  • CREATE_NODES — mint FRESH permanent nodes for tools/frameworks/libraries/services the agent USED this session that are not already in the graph. Look at the rounds (tools: ..., files: ...) and the summary. Every non-trivial tool, framework, library, package, CLI, service the agent touched deserves its own node, even if it was "just used" without being deeply discussed. node types: "tool" (CLI binaries, commands), "library" (npm packages, imports), "framework" (expo, next, react-native), "service" (apis, databases), "concept" (design patterns, approaches).',
      '  • APPEND_NOTES — attach session-specific lessons onto existing permanent nodes (e.g. add "Learned in session: expo router 4.x changed the typed-routes default to true" onto the existing `expo-router` node\'s gotchas aspect). Works on both pre-existing nodes and nodes you just created via `createNodes`.',
      '  • DROP (implicit) — anything not in `promote` will be soft-deleted',
      '',
      'Heuristics:',
      '  PROMOTE: durable discoveries, failure→fix pairs, workflows that worked, configuration values that worked, discoveries linked to project identity.',
      '  CREATE_NODES: every tool/library/framework/service USED. If the session touched `npm`, `expo`, `qrcode`, `powershell`, `node`, `git` — create a node for each that doesn\'t already exist. Keep descriptions factual and small; put session-specific quirks in a `gotchas` aspect on the created node.',
      '  APPEND_NOTES: version-specific gotchas, "X is deprecated, use Y", configuration tips discovered by trial-and-error.',
      '  DROP: error log dumps, intermediate debug captures, half-formed thoughts, generic concepts already well-covered in the graph.',
      '',
      'Temporary nodes from this session:',
      JSON.stringify(digests, null, 2),
      '',
      'Output VALID JSON only — no prose, no markdown fences. Schema:',
      '{',
      '  "promote": [',
      '    { "nodeId": "<existing temp id from the list>", "renameTo": "<optional better permanent id, e.g. \\"expo-router\\" instead of \\"discovery-...\\"; omit to keep current id>" }',
      '  ],',
      '  "createNodes": [',
      '    { "nodeId": "expo", "label": "Expo", "type": "framework", "description": "React Native toolchain for mobile apps", "aspects": [{ "name": "overview", "attributes": ["Used for dev server + QR code bundling"] }, { "name": "gotchas", "attributes": ["Dev server defaults to port 8081; use --port to override"] }] }',
      '  ],',
      '  "appendNotes": [',
      '    { "targetNodeId": "<existing permanent or just-created node id>", "aspect": "gotchas", "content": "Learned in session: <specific lesson>" }',
      '  ]',
      '}',
      'Anything not in `promote` will be soft-deleted (recycle_bin, 7-day retention). Keep `promote` tight — quality over quantity. Be generous with `createNodes` — every tool/framework/library the agent USED should get a node.',
    ].join('\n');

    const model = config?.casualModel || config?.normalModel || config?.model;
    const resp = await llmClient.messages.create({
      model,
      // Bumped 2000 → 4000 because createNodes adds 100-300 tokens
      // per node and a busy session can spawn 5-10 tool/framework
      // nodes; 2000 cap was truncating JSON mid-structure.
      max_tokens: 4000,
      messages: [{ role: 'user', content: promptText }],
    });
    const respText = ((resp?.content || []).find(b => b.type === 'text')?.text || '').trim();

    // Strip optional markdown fences in case the LLM ignored the rule
    const jsonText = respText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed;
    if (!jsonText) {
      // Empty LLM response — don't abort the whole distillation. The
      // right semantic here is "LLM had no opinion" → no promotions, no
      // creations, no appendNotes, and the regular soft-delete sweep
      // runs on every untouched temp. Beats leaving temps stranded
      // because the LLM blinked.
      if (log) log.warn(`[distill] ${id} LLM returned empty — proceeding with no promotions, soft-deleting all temps`);
      parsed = { promote: [], createNodes: [], appendNotes: [] };
    } else {
      try { parsed = JSON.parse(jsonText); } catch (e) {
        // Malformed JSON same treatment — don't strand temps. Log what
        // we got so we can tune the prompt if this becomes a pattern.
        if (log) log.warn(`[distill] ${id} non-JSON response — proceeding with no promotions. raw: ${respText.slice(0, 200)}`);
        parsed = { promote: [], createNodes: [], appendNotes: [] };
      }
    }

    const promoteList = Array.isArray(parsed.promote) ? parsed.promote : [];
    const appendList = Array.isArray(parsed.appendNotes) ? parsed.appendNotes : [];
    const createList = Array.isArray(parsed.createNodes) ? parsed.createNodes : [];
    const tempIdSet = new Set(tempRows.map(n => n.id));
    const promotedIds = new Set();
    const createdCount = { value: 0 };

    // Project node for edges — every created node should link to the
    // project where this session ran. Pulled from the session's own
    // part_of edge so distillation is self-contained.
    const projectRow = db.prepare(
      "SELECT target FROM edges WHERE source = ? AND type = 'part_of' LIMIT 1"
    ).get(id);
    const projectIdForEdges = projectRow?.target || null;

    // createNodes — the LLM can mint new permanent nodes for
    // tools/frameworks/libraries USED this session but not already in
    // the graph. These don't need to have been temp candidates; the
    // LLM identifies them from the round breadcrumbs + summary.
    for (const c of createList) {
      const newId = String(c?.nodeId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      if (!newId) continue;
      const label = String(c?.label || newId).slice(0, 120);
      const nodeType = String(c?.type || 'tool').toLowerCase().replace(/[^a-z_]/g, '_').slice(0, 20) || 'tool';
      const description = String(c?.description || '').slice(0, 500);
      // Skip if already exists — append notes to it instead via the
      // appendNotes mechanism the LLM also sees.
      if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(newId)) continue;
      const extraNew = JSON.stringify({ distilled_from: sessionId, distilled_at: new Date().toISOString() });
      try {
        db.prepare(
          'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, 6, 1, ?, ?, ?, ?)'
        ).run(newId, label, nodeType, description, 'graphcorn-distill', 'graphcorn-distill', new Date().toISOString(), extraNew);

        // Optional aspects: overview + gotchas. Input shape:
        // { nodeId, label, type, description, aspects: [{name, attributes: ["..."]}] }
        if (Array.isArray(c?.aspects)) {
          for (const asp of c.aspects) {
            const aspectName = String(asp?.name || '').replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
            if (!aspectName) continue;
            const attrs = Array.isArray(asp?.attributes) ? asp.attributes : [];
            if (attrs.length === 0) continue;
            db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 7, 'graphcorn-distill')").run(newId, aspectName);
            const aspId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
            const insAttr = db.prepare(
              "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, 'graphcorn-distill', 'graphcorn-distill')"
            );
            for (const a of attrs) {
              const t = String(a || '').trim();
              if (t) insAttr.run(aspId, t);
            }
          }
        }
        // Edge: created → project (uses) + created → session (first_seen_in)
        const insE = db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1, 'graphcorn-distill')");
        if (projectIdForEdges) {
          try {
            insE.run(newId, projectIdForEdges, 'uses');
            graphEvents.emit('change', { op: 'edge:create', edge: { source: newId, target: projectIdForEdges, type: 'uses' }, source: 'graphcorn-distill' });
          } catch {}
        }
        try {
          insE.run(newId, id, 'first_seen_in');
          graphEvents.emit('change', { op: 'edge:create', edge: { source: newId, target: id, type: 'first_seen_in' }, source: 'graphcorn-distill' });
        } catch {}
        graphEvents.emit('change', { op: 'node:create', node: { id: newId, label, type: nodeType, description }, source: 'graphcorn-distill' });
        createdCount.value++;
      } catch (e) {
        if (log) log.warn(`[distill] createNode ${newId} failed: ${e.message}`);
      }
    }

    for (const p of promoteList) {
      const tempId = String(p?.nodeId || '');
      if (!tempIdSet.has(tempId)) continue;
      const targetId = (p?.renameTo && String(p.renameTo).trim()) || tempId;
      if (targetId !== tempId) {
        // Rename: copy aspects/attributes/edges from temp → new permanent id (if not already there), drop temp.
        // For simplicity: if target exists, leave it; just delete the temp's ttl after the merge step below.
        const exists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(targetId);
        if (!exists) {
          // PRAGMA defer_foreign_keys lets us reorder the updates
          // inside a transaction without the interim state
          // (aspects/edges pointing to a renamed-but-not-yet-renamed id)
          // tripping the FK check. Previously the nodes UPDATE would
          // FK-fail immediately when any edge pointed at the temp,
          // and we'd fall back to the original id with no rename.
          try {
            db.exec('BEGIN IMMEDIATE');
            db.exec('PRAGMA defer_foreign_keys = 1');
            db.prepare('UPDATE nodes SET id = ? WHERE id = ?').run(targetId, tempId);
            db.prepare('UPDATE aspects SET node_id = ? WHERE node_id = ?').run(targetId, tempId);
            db.prepare('UPDATE edges SET source = ? WHERE source = ?').run(targetId, tempId);
            db.prepare('UPDATE edges SET target = ? WHERE target = ?').run(targetId, tempId);
            db.exec('COMMIT');
          } catch (e) {
            try { db.exec('ROLLBACK'); } catch {}
            if (log) log.warn(`[distill] rename ${tempId} → ${targetId} failed: ${e.message} (keeping original id)`);
          }
        }
        // else: target already exists; keep both (merge would risk dupe attributes — leave as-is for safety)
      }
      // Clear temp flag on the (possibly renamed) node — this is the "promote" step.
      const nodeRow = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(targetId === tempId ? tempId : targetId);
      if (nodeRow) {
        let ext = {};
        try { ext = nodeRow.extra ? JSON.parse(nodeRow.extra) : {}; } catch {}
        delete ext.ttl;
        delete ext.tempCreated;
        delete ext.sessionId;
        ext.distilled_from = sessionId;
        ext.distilled_at = new Date().toISOString();
        db.prepare('UPDATE nodes SET extra = ?, importance = MAX(importance, 6), updated = CURRENT_TIMESTAMP WHERE id = ?')
          .run(JSON.stringify(ext), targetId);
        graphEvents.emit('change', { op: 'node:update', nodeId: targetId, renamedFrom: targetId !== tempId ? tempId : undefined, source: 'graphcorn-distill' });
        promotedIds.add(tempId);
      }
    }

    // Append notes — adds attributes to a `gotchas` (or specified) aspect.
    let notesAppended = 0;
    for (const a of appendList) {
      const tgt = String(a?.targetNodeId || '');
      const aspectName = String(a?.aspect || 'gotchas').replace(/[^a-z0-9_]/gi, '_').slice(0, 40) || 'gotchas';
      const content = String(a?.content || '').trim();
      if (!tgt || !content) continue;
      if (!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(tgt)) continue;
      let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(tgt, aspectName);
      if (!asp) {
        db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 7, 'graphcorn-distill')").run(tgt, aspectName);
        asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
      if (!dup) {
        db.prepare(
          "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, 'graphcorn-distill', 'graphcorn-distill')"
        ).run(asp.id, content);
        graphEvents.emit('change', { op: 'attribute:create', nodeId: tgt, aspect: aspectName, content, source: 'graphcorn-distill' });
        notesAppended++;
      }
    }

    // Soft-delete every session-temp NOT promoted → recycle_bin, 7-day expiry.
    // FK constraint: edges.source / edges.target reference nodes.id with no
    // CASCADE, so we must clear the node's edges BEFORE DELETE FROM nodes
    // (aspects/attributes DO cascade). Skip identity nodes defensively —
    // if the learner-side guard was bypassed somehow, the distiller is the
    // last line of defense before we FK-fail on an important node.
    let dropped = 0;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const insBin = db.prepare(
      "INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at) VALUES ('node', ?, ?, ?, 'graphcorn-distill', ?, 1.0, ?)"
    );
    for (const t of tempRows) {
      if (promotedIds.has(t.id)) continue;
      // Identity-node safety check — never recycle a person node
      // (especially the user's own), even if the learner mis-tagged it.
      if (t.type === 'person') {
        try {
          const row = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(t.id);
          if (row) {
            let ext = {}; try { ext = row.extra ? JSON.parse(row.extra) : {}; } catch {}
            delete ext.ttl;
            delete ext.tempCreated;
            delete ext.sessionId;
            db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(ext), t.id);
          }
        } catch {}
        if (log) log.info(`[distill] skipped soft-delete of person node ${t.id} (identity guard)`);
        continue;
      }
      // Double-check the node still exists at this id (rename case)
      const stillThere = db.prepare('SELECT id, label, type, description, extra FROM nodes WHERE id = ?').get(t.id);
      if (!stillThere) continue;
      const aspects = aspStmt.all(t.id);
      const edges = edgeStmt.all(t.id);
      const payload = JSON.stringify({ node: stillThere, aspects, edges });
      try {
        insBin.run(t.id, t.label, payload, `session ${sessionId} not promoted`, expiresAt);
        db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(t.id, t.id);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(t.id);
        graphEvents.emit('change', { op: 'node:delete', nodeId: t.id, source: 'graphcorn-distill' });
        dropped++;
      } catch (e) {
        if (log) log.warn(`[distill] failed to recycle ${t.id}: ${e.message}`);
      }
    }

    extraObj.distilled_at = new Date().toISOString();
    extraObj.distilled_promoted = promotedIds.size;
    extraObj.distilled_created = createdCount.value;
    extraObj.distilled_dropped = dropped;
    extraObj.distilled_notes_appended = notesAppended;
    delete extraObj.distilling;
    db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(extraObj), id);

    graphEvents.emit('change', {
      op: 'session:distill-done',
      nodeId: id,
      promoted: promotedIds.size,
      created: createdCount.value,
      dropped,
      notesAppended,
      source: 'graphcorn',
    });
    if (log) log.info(`[distill] ${id} done: promoted=${promotedIds.size} created=${createdCount.value} dropped=${dropped} notes=${notesAppended} model=${model}`);
    return { promoted: promotedIds.size, created: createdCount.value, dropped, notesAppended };
  } catch (e) {
    extraObj.distilling = false;
    extraObj.distill_error = e.message;
    extraObj.distill_error_at = new Date().toISOString();
    try {
      db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(extraObj), id);
    } catch {}
    graphEvents.emit('change', { op: 'session:distill-done', nodeId: id, error: e.message, source: 'graphcorn' });
    if (log) log.warn(`[distill] ${id} failed: ${e.message} (temps left in place; janitor will clean in 48h)`);
    return { error: e.message };
  }
}

module.exports = { sessionNodeId, upsertSessionNode, finalizeSessionNode, bumpTurnCount, summarizeSessionNode, distillSession };
