// graphcorn — session node persistence.
//
// Each Spore Code launch creates one `session-<sessionId>` node here at WS
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
//     description = `Spore Code session by ${userName} in ${cwd} (started ${startedAt})`
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
const { coreRequire, modelForTier } = require('../../core-require');
// Event bus — lets the graph viewer (and any other subscribers) see
// distillation work live. Without this, summarize/distill runs silently
// from the viewer's POV; a fresh node appears only after manual refresh.
const graphEvents = coreRequire('graph/events');

function emitChange(learner, payload) {
  try {
    graphEvents.emit('change', learner?._graphSlug && !payload.graph ? { ...payload, graph: learner._graphSlug } : payload);
  } catch {}
}

// Shared helper — uses the same streaming pattern as maintainer.js
// to avoid nginx 60s idle timeouts on slow reasoning models (GLM 5.1,
// Kimi K2.6). Non-streaming .create() was returning empty text in
// every session that took >60s to think, which is most of them.
// Returns the response text (possibly empty) or rethrows on error.
async function _callLlmStreaming(llmClient, params, log, label) {
  let text = '';
  try {
    const stream = llmClient.messages.stream(params);
    if (stream && typeof stream.finalMessage === 'function') {
      const result = await stream.finalMessage();
      text = (result?.content || []).find(b => b.type === 'text')?.text || '';
    } else if (stream && typeof stream.on === 'function') {
      await new Promise((resolve, reject) => {
        stream.on('text', chunk => { text += chunk; });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    } else {
      const response = await llmClient.messages.create(params);
      text = (response?.content || []).find(b => b.type === 'text')?.text || '';
    }
  } catch (e) {
    if (log) log.debug?.(`[${label}] stream failed (${e?.message}), falling back to non-streaming`);
    const response = await llmClient.messages.create(params);
    text = (response?.content || []).find(b => b.type === 'text')?.text || '';
  }
  return text;
}

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
  // Pass sessionId so the project node records where it was created.
  // Project nodes are durable anchors; temp/distillation applies to
  // session nodes and discoveries, not the project anchor itself.
  let projectId = null;
  if (cwd) {
    const projRes = projects.upsertProject(learner, userId || 'anon', {
      cwd, project: opts.project, gitBranch: opts.gitBranch, gitHash: opts.gitHash,
      projectType: opts.projectType, sporeMd: opts.sporeMd, tree: opts.tree,
      tools: opts.tools, os: opts.os, arch: opts.arch, projectIdentityKey: opts.projectIdentityKey,
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
      'Spore Code session' +
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
    emitChange(learner, { op: 'node:create', node: { id, label, type: 'session', description }, source: 'graphcorn' });
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
  try { extraObj = node.extra ? JSON.parse(node.extra) : {}; } catch (e) { console.warn('[sessions] JSON.parse failed: ' + e.message); }
  if (extraObj.summarized_at) {
    if (log) log.info(`[graphcorn] summary already written for ${id} at ${extraObj.summarized_at}, skipping`);
    return;
  }

  emitChange(learner, { op: 'session:summarize-start', nodeId: id, source: 'graphcorn' });

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

  // Pull the actual user/assistant exchanges from the episodes table
  // for this session's time window. The rounds aspect gives the LLM
  // a tool-use breadcrumb but nothing about WHAT was said; episodes
  // have the full conversation. Filter by started_at..ended_at
  // (fallback to wide window if lifecycle attrs are missing). Cap
  // per-episode content so the prompt stays reasonable.
  let episodesBlock = '';
  try {
    const startedRow = db.prepare("SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='lifecycle' AND a.content LIKE 'started_at:%' LIMIT 1").get(id);
    const endedRow = db.prepare("SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='lifecycle' AND a.content LIKE 'ended_at:%' LIMIT 1").get(id);
    const startedAt = startedRow?.content?.replace(/^started_at:\s*/, '').trim() || null;
    const endedAt = endedRow?.content?.replace(/^ended_at:\s*/, '').trim() || new Date().toISOString();

    // Episode session_id for Spore Code sessions is the shared channel name
    // like `cli:<user>`, not the per-launch sessionId. We pick the
    // user name from the session description ("Spore Code session by <user>
    // in <cwd>"), fall back to matching any episode row whose
    // observed_at falls in the session window.
    const userName = (node.label && node.description) ? null : null;
    let rows2 = [];
    if (startedAt) {
      rows2 = db.prepare(
        "SELECT content, observed_at FROM episodes WHERE observed_at >= ? AND observed_at <= ? ORDER BY id ASC"
      ).all(startedAt, endedAt);
    }
    if (rows2.length) {
      // Bumped 2400 → 6000 per-episode, 24k → 60k total. Summary
      // quality correlates directly with how much real conversation
      // the LLM gets to read. 60k input characters is ~15k tokens —
      // well inside any reasoning model's context window, and worth
      // it because the summary is written-once per session.
      const EPISODE_CAP = 6000;
      const pieces = rows2.map((r, i) => {
        const body = String(r.content || '').trim();
        const capped = body.length > EPISODE_CAP ? body.slice(0, EPISODE_CAP) + '\n  …[truncated]' : body;
        return `--- episode ${i + 1} (${r.observed_at}) ---\n${capped}`;
      });
      // Overall cap on the episodes block to prevent runaway prompts.
      let joined = pieces.join('\n\n');
      if (joined.length > 60000) joined = joined.slice(0, 60000) + '\n…[trimmed for budget]';
      episodesBlock = joined;
    }
  } catch (e) {
    if (log) log.debug?.(`[graphcorn] episode fetch for summary failed: ${e.message}`);
  }

  const prompt = [
    'You are summarizing a Spore Code coding session for graph-side persistence.',
    'The summary will be stored on the session node as a `summary` aspect — future agents on this project will retrieve it via graph_query and use it to remember what happened.',
    '',
    `Session: ${node.label} (${id})`,
    ctxLines,
    '',
    'Rounds (chronological, "turn N | user prompt | tools used | files touched | exec[N, failed] | reply preview"):',
    roundLines,
    '',
    episodesBlock ? 'Full conversation turns (from the episodes table — actual user/assistant text; use this for specifics the breadcrumbs glossed over):' : '',
    episodesBlock,
    '',
    'Write a concise recap (≤200 words) covering: (1) what the user asked for, (2) specific tools/libraries/frameworks used + key commands + key files, (3) what worked, what failed + why, (4) any durable lessons or configurations worth remembering, (5) unfinished work or open threads.',
    'Plain prose, no markdown headers. Speak as if writing notes to your future self. Concrete over abstract — prefer "used `qrcode-terminal` to render exp:// QR on LAN 192.168.1.191:8081" over "generated a QR code".',
  ].filter(s => s !== '').join('\n');

  try {
    const model = modelForTier('casual', config);
    // 8k — reasoning models (GLM-5.1, Kimi K2.6) routinely use
    // thousands of thinking tokens before producing the text block.
    // 500 was aggressively small; 1500 was better but still risked
    // truncation on long sessions. 8k gives comfortable headroom
    // while staying well inside model context.
    const text = (await _callLlmStreaming(llmClient, {
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }, log, 'graphcorn-summary')).trim();
    if (!text) {
      // Mark as "summarized" (empty) so repeat calls from the
      // ws.on('close') chain don't re-call the LLM. Without this we
      // double-charge on every ungraceful disconnect.
      extraObj.summarized_at = new Date().toISOString();
      extraObj.summarized_empty = true;
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extraObj), id);
      if (log) log.warn(`[graphcorn] summary for ${id} returned empty text — marked to avoid retries`);
      emitChange(learner, { op: 'session:summarize-done', nodeId: id, empty: true, source: 'graphcorn' });
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
    emitChange(learner, { op: 'aspect:create', nodeId: id, aspect: 'summary', source: 'graphcorn' });
    emitChange(learner, { op: 'attribute:create', nodeId: id, aspect: 'summary', content: text, source: 'graphcorn' });
    emitChange(learner, { op: 'session:summarize-done', nodeId: id, empty: false, chars: text.length, source: 'graphcorn' });
    if (log) log.info(`[graphcorn] session ${id} summary written (${text.length} chars, ${rows.length} rounds, model=${model})`);
  } catch (e) {
    if (log) log.warn(`[graphcorn] summary for ${id} failed: ${e.message}`);
    emitChange(learner, { op: 'session:summarize-done', nodeId: id, error: e.message, source: 'graphcorn' });
  }
}

function _sanitizeReusableLesson(text) {
  const raw = String(text || '').replace(/^Learned in session:\s*/i, '').trim();
  if (!raw || raw.length < 20) return null;
  if (/(sk-[a-z0-9]|ghp_[a-z0-9]|password\s*=|api[_-]?key\s*=|secret\s*=)/i.test(raw)) return null;
  return raw
    .replace(/\s*\(source:\s*[^)]+\)\s*$/i, '')
    .replace(/\/(?:home|Users|mnt|app|workspace|data)\/[^\s`'")]+/g, '<project-path>')
    .replace(/[A-Za-z]:\\[^\s`'")]+/g, '<project-path>')
    .slice(0, 600);
}

function _looksProjectSpecificReusableLesson({ nodeId, label, type, aspect, lesson }) {
  const id = String(nodeId || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  const a = String(aspect || '').toLowerCase();
  const text = `${label || ''}\n${lesson || ''}`.toLowerCase();
  if (!id) return true;
  if (t === 'project' || t === 'session' || id.startsWith('project-') || id.startsWith('project:') || id.startsWith('session-')) return true;
  if (a === 'scratch_helpers' || a === 'recent_activity' || a === 'manifest' || a === 'code_graph') return true;
  if (/(^|[\\/])\.spore-code[\\/]|scratch helper|scratch_helpers|local workspace|repository path|source code located|untracked files|dev server runs on|requires testing device/i.test(text)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) return true;
  return false;
}

function _genericKbDescription(desc) {
  const d = String(desc || '').trim();
  return !d || /^reusable (project )?lesson/i.test(d) || /^reusable knowledge distilled/i.test(d);
}

function _descriptionFromLesson(desc, cleanLesson) {
  if (!_genericKbDescription(desc)) return String(desc).slice(0, 500);
  const sentence = String(cleanLesson || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim();
  return (sentence || cleanLesson || 'Reusable engineering lesson').slice(0, 500);
}

function _aspectWithAttr(db, nodeId, aspectName, content, { weight = 7, importance = 7, source = 'session-distill' } = {}) {
  if (!content) return false;
  let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, aspectName);
  if (!asp) {
    db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)').run(nodeId, aspectName, weight, source);
    asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
  if (dup) return false;
  db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, ?, ?)')
    .run(asp.id, content, importance, source, source);
  return true;
}

function promoteReusableKnowledge(learner, sessionId, parsed, opts = {}) {
  const registry = learner?._graphRegistry;
  if (!learner?.getGraphDb || !registry?.getGeneralKnowledgeSlug) return { promoted: 0 };
  const slug = registry.getGeneralKnowledgeSlug();
  const kb = learner.getGraphDb(slug);
  if (!kb) return { promoted: 0 };
  const sessionNodeId_ = sessionNodeId(sessionId);
  const projectId = opts.projectId || null;
  const source = `source: ${projectId || 'project'} / ${sessionNodeId_}`;
  const upsert = (nodeId, label, type, description, lesson, aspectName = null) => {
    if (_looksProjectSpecificReusableLesson({ nodeId, label, type, aspect: aspectName, lesson })) return false;
    const clean = _sanitizeReusableLesson(lesson);
    if (!clean) return false;
    const id = String(nodeId || label || 'lesson')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (!id) return false;
    const existing = kb.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
    const nextDescription = _descriptionFromLesson(description, clean);
    if (!existing) {
      kb.prepare(
        'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, 6, 1, ?, ?, ?, ?)'
      ).run(id, label || id, type || 'concept', nextDescription, 'general-kb', 'session-distill', new Date().toISOString(), JSON.stringify({ sourceSession: sessionId, sourceProject: projectId, confidence: 'conservative-auto' }));
    } else {
      kb.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      const row = kb.prepare('SELECT description FROM nodes WHERE id = ?').get(id);
      if (_genericKbDescription(row?.description)) {
        kb.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?').run(nextDescription, id);
      }
    }
    let asp = kb.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'reusable_lessons'").get(id);
    if (!asp) {
      kb.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'reusable_lessons', 8, 'session-distill')").run(id);
      asp = { id: kb.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    const content = `${clean} (${source})`;
    const dup = kb.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
    if (!dup) {
      kb.prepare(
        "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'session-distill', 'session-distill')"
      ).run(asp.id, content);
      _aspectWithAttr(kb, id, 'summary', clean, { weight: 9, importance: 8, source: 'session-distill' });
      _aspectWithAttr(kb, id, 'applicability', 'Reusable across projects when the same tool, framework, protocol, or UI constraint appears.', { weight: 6, importance: 6, source: 'session-distill' });
      graphEvents.emit('change', { op: 'attribute:create', nodeId: id, aspect: 'reusable_lessons', content, source: 'general-kb', graph: slug });
      return true;
    }
    return false;
  };

  let promoted = 0;
  for (const c of parsed?.createNodes || []) {
    const type = String(c?.type || 'concept').toLowerCase();
    if (!['tool', 'library', 'framework', 'service', 'concept'].includes(type)) continue;
    for (const asp of c.aspects || []) {
      for (const attr of asp.attributes || []) {
        if (upsert(c.nodeId, c.label, type, c.description, attr, asp.name)) promoted++;
      }
    }
  }
  for (const a of parsed?.appendNotes || []) {
    if (upsert(a.targetNodeId, a.targetNodeId, 'concept', 'Reusable project lesson', a.content, a.aspect)) promoted++;
  }
  return { promoted, slug };
}

function repairGeneralKnowledgeBase(learner, log) {
  const registry = learner?._graphRegistry;
  if (!learner?.getGraphDb || !registry?.getGeneralKnowledgeSlug) return { repaired: 0, removed: 0 };
  const slug = registry.getGeneralKnowledgeSlug();
  const kb = learner.getGraphDb(slug);
  if (!kb) return { repaired: 0, removed: 0 };
  let repaired = 0;
  let removed = 0;
  const nodes = kb.prepare(`
    SELECT n.id, n.label, n.type, n.description,
           (SELECT a.content FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
             WHERE asp.node_id = n.id AND asp.name = 'reusable_lessons'
             ORDER BY a.id LIMIT 1) AS lesson
      FROM nodes n
     WHERE n.extracted_with IN ('session-distill', 'general-kb') OR n.provenance = 'general-kb'
  `).all();
  for (const n of nodes) {
    const clean = _sanitizeReusableLesson(n.lesson);
    if (_looksProjectSpecificReusableLesson({ nodeId: n.id, label: n.label, type: n.type, aspect: 'reusable_lessons', lesson: n.lesson })) {
      try {
        const payload = JSON.stringify({
          node: n,
          aspects: kb.prepare('SELECT * FROM aspects WHERE node_id = ?').all(n.id),
          edges: kb.prepare('SELECT * FROM edges WHERE source = ? OR target = ?').all(n.id, n.id),
        });
        kb.prepare(`
          INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at)
          VALUES ('node', ?, ?, ?, 'general-kb-repair', 'project-specific reusable lesson stayed in project graph', 1.0, datetime('now', '+7 days'))
        `).run(n.id, n.label, payload);
        kb.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(n.id, n.id);
        kb.prepare('DELETE FROM nodes WHERE id = ?').run(n.id);
        removed++;
      } catch (e) {
        log?.warn?.(`[general-kb] repair remove ${n.id} failed: ${e.message}`);
      }
      continue;
    }
    if (clean && _genericKbDescription(n.description)) {
      kb.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?').run(_descriptionFromLesson(n.description, clean), n.id);
      _aspectWithAttr(kb, n.id, 'summary', clean, { weight: 9, importance: 8, source: 'general-kb-repair' });
      repaired++;
    }
  }
  if ((repaired || removed) && log) log.info(`[general-kb] repair complete: repaired=${repaired} removed=${removed}`);
  try { registry.refreshStats(slug); } catch {}
  return { repaired, removed };
}

// distillSession — Phase 8 (extends Phase 7).
//
// Background: every node born inside a Spore Code session is now stamped
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
  try { extraObj = node.extra ? JSON.parse(node.extra) : {}; } catch (e) { console.warn('[sessions] JSON.parse failed: ' + e.message); }
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
  emitChange(learner, { op: 'session:distill-start', nodeId: id, source: 'graphcorn' });

  try {
    // Exclude the session node itself from the candidate list — it
    // holds extra.distilled_at for idempotency, so the LLM can't promote
    // or drop it. The existing 48h janitor still reaps it from
    // tempCreated, just like any other unloved temp node, so the
    // "session leaves no permanent trace" semantic is preserved.
    const tempRows = db.prepare(
      "SELECT id, label, type, description, extra FROM nodes WHERE json_extract(extra, '$.sessionId') = ? AND json_extract(extra, '$.ttl') = 'temp' AND id != ?"
    ).all(sessionId, id);

    // Check if we have ANY rounds recorded. Distillation can still
    // produce value even with zero session-temps as long as the rounds
    // aspect gives the LLM something to reason about — e.g. agent
    // solved the task by using specific tools/frameworks that deserve
    // permanent nodes even though nothing was temped mid-session.
    // User hit this: T190612 succeeded at an Expo QR workflow but
    // nothing got captured because the agent never called graph_update
    // and the learner only added attributes to the existing project
    // node. Result: permanent loss of "how we made the QR code work".
    const hasRounds = db.prepare(
      "SELECT 1 FROM aspects WHERE node_id = ? AND name = 'rounds' LIMIT 1"
    ).get(id) != null;

    if (tempRows.length === 0 && !hasRounds) {
      extraObj.distilled_at = new Date().toISOString();
      extraObj.distilled_promoted = 0;
      extraObj.distilled_dropped = 0;
      delete extraObj.distilling;
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extraObj), id);
      emitChange(learner, { op: 'session:distill-done', nodeId: id, promoted: 0, created: 0, dropped: 0, notesAppended: 0, empty: true, source: 'graphcorn' });
      if (log) log.info(`[distill] ${id} no temps and no rounds — marked complete`);
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
      'You are distilling a Spore Code coding session into permanent graph knowledge. Your job is to keep the SIGNAL and drop the NOISE.',
      '',
      `Session: ${id}`,
      'Session summary:',
      sessionSummary,
      '',
      `Recent rounds (last 10):\n${recentRounds || '  (no rounds recorded)'}`,
      '',
      `${tempRows.length === 0 ? 'NO temporary nodes were created during this session — but the rounds above show real tool activity. Your job here is entirely `createNodes` / `appendNotes`: look at the tools used and files touched, and mint permanent nodes for the frameworks/libraries/services the agent successfully used. This is ESPECIALLY important when nothing else will capture the success — without createNodes, next session starts from zero on whatever worked here.' : `${tempRows.length} temporary nodes were created during this session.`} You have THREE operations — use all of them:`,
      '  • PROMOTE — keep an existing temp node as permanent (the user/future sessions will benefit)',
      '  • CREATE_NODES — mint FRESH permanent nodes for tools/frameworks/libraries/services the agent USED this session that are not already in the graph. Look at the rounds (tools: ..., files: ...) and the summary. Every non-trivial tool, framework, library, package, CLI, service the agent touched deserves its own node, even if it was "just used" without being deeply discussed. node types: "tool" (CLI binaries, commands), "library" (npm packages, imports), "framework" (expo, next, react-native), "service" (apis, databases), "concept" (design patterns, approaches).',
      '  • APPEND_NOTES — attach session-specific lessons onto existing permanent nodes (e.g. add "Learned in session: expo router 4.x changed the typed-routes default to true" onto the existing `expo-router` node\'s gotchas aspect). Works on both pre-existing nodes and nodes you just created via `createNodes`.',
      '  • DROP (implicit) — anything not in `promote` will be soft-deleted',
      '',
      'Heuristics:',
      '  PROMOTE: durable discoveries, failure→fix pairs, workflows that worked, configuration values that worked, discoveries linked to project identity.',
      '  CREATE_NODES: external tools/libraries/frameworks/services the project uses. Think `npm`, `expo`, `qrcode-terminal`, `react-native`, `docker`, `postgres`, `vite`, `tailwind`, `pnpm`, `pytest`. Keep descriptions factual and small; put session-specific quirks on a `gotchas` aspect.',
      '  DO NOT create nodes for the agent\'s own built-in tools — those are always available, so nodes for them are graph noise. Skip: exec, sleep, read_file, write_file, edit_file, glob, grep, graph_query, graph_update, graph_delete, note_discovery, web_search, web_fetch, ask_user, message_send, delegate_task, schedule_wakeup, save_tool, browser_*, terminal_*, ssh_*, email_*, voice_*, notify_user. These are Spore Core tools the agent already has, not things learned during the session.',
      '  APPEND_NOTES: version-specific gotchas, "X is deprecated, use Y", configuration tips discovered by trial-and-error.',
      '  SCRATCH HELPERS: If the agent wrote any files under `.spore-code/scratch/` during the session (check the `files` field on each round), emit an `appendNotes` onto the PROJECT node\'s `scratch_helpers` aspect with one entry per file: `<path> — <one-line purpose>`. Example: `.spore-code/scratch/get-lan-ip.js — prints LAN IP, skipping VPN adapters`. This is how future sessions find existing helpers without `glob`-ing the directory every turn.',
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

    const model = modelForTier('casual', config);
    // Streaming to keep the HTTP connection alive on slow reasoning
    // models (GLM/Kimi spend 30-60s thinking on distill-size inputs).
    // Non-streaming was hitting nginx's 60s idle timeout and returning
    // empty text, which caused distill to treat the LLM as having "no
    // opinion" and soft-delete every temp.
    const respText = (await _callLlmStreaming(llmClient, {
      model,
      // 8k — reasoning models burn heavy thinking tokens before the
      // JSON body, plus createNodes can spawn 5-10 rich tool nodes
      // (200-400 tokens each). 4000 was still getting truncated
      // mid-JSON for the distill LLM on dense sessions.
      max_tokens: 8000,
      messages: [{ role: 'user', content: promptText }],
    }, log, 'graphcorn-distill')).trim();

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
    // SPORE built-in tools the agent always has — hard-reject
    // createNode attempts for these so the graph doesn't fill up with
    // "tool: exec", "tool: sleep", "tool: read_file" nodes that tell
    // future sessions nothing new.
    const BUILTIN_TOOLS = new Set([
      'exec', 'sleep', 'read_file', 'write_file', 'edit_file',
      'glob', 'grep', 'graph_query', 'graph_update', 'graph_delete',
      'note_discovery', 'web_search', 'web_fetch', 'ask_user',
      'message_send', 'delegate_task', 'schedule_wakeup', 'save_tool',
      'browser_control', 'terminal_open', 'ssh_connect', 'email_read',
      'voice_chat', 'notify_user', 'log_watch', 'task_create',
      'task_update', 'web_serve', 'env_manage', 'data_poller',
      'analyze_media',
    ]);
    for (const c of createList) {
      const newId = String(c?.nodeId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      if (!newId) continue;
      if (BUILTIN_TOOLS.has(newId)) {
        if (log) log.info(`[distill] skipped createNode ${newId} — Spore Core built-in tool, not distillation material`);
        continue;
      }
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
            emitChange(learner, { op: 'edge:create', edge: { source: newId, target: projectIdForEdges, type: 'uses' }, source: 'graphcorn-distill' });
          } catch (e) { console.warn('[sessions] insE.run failed: ' + e.message); }
        }
        try {
          insE.run(newId, id, 'first_seen_in');
          emitChange(learner, { op: 'edge:create', edge: { source: newId, target: id, type: 'first_seen_in' }, source: 'graphcorn-distill' });
        } catch (e) { console.warn('[sessions] insE.run failed: ' + e.message); }
        emitChange(learner, { op: 'node:create', node: { id: newId, label, type: nodeType, description }, source: 'graphcorn-distill' });
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
          // Temporarily disable FK to rewrite the id. defer_foreign_keys
          // proved insufficient in testing (node-sqlite + concurrent
          // learner writes were still tripping the FK check at commit
          // time). We KNOW this rename is safe — we update every
          // FK-holding row before re-enabling. PRAGMA foreign_keys
          // toggles are connection-wide but our DB singleton is used
          // by one process, and the remaining updates inside the txn
          // leave all FKs valid.
          try {
            db.exec('PRAGMA foreign_keys = OFF');
            db.prepare('UPDATE nodes SET id = ? WHERE id = ?').run(targetId, tempId);
            db.prepare('UPDATE aspects SET node_id = ? WHERE node_id = ?').run(targetId, tempId);
            db.prepare('UPDATE edges SET source = ? WHERE source = ?').run(targetId, tempId);
            db.prepare('UPDATE edges SET target = ? WHERE target = ?').run(targetId, tempId);
            db.exec('PRAGMA foreign_keys = ON');
            if (log) log.info(`[distill] renamed ${tempId} → ${targetId}`);
          } catch (e) {
            // Re-enable FKs on failure so we don't leave the connection
            // in an unsafe state.
            try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
            if (log) log.warn(`[distill] rename ${tempId} → ${targetId} failed: ${e.message} (keeping original id)`);
          }
        }
        // else: target already exists; keep both (merge would risk dupe attributes — leave as-is for safety)
      }
      // Clear temp flag on the (possibly renamed) node — this is the "promote" step.
      const nodeRow = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(targetId === tempId ? tempId : targetId);
      if (nodeRow) {
        let ext = {};
        try { ext = nodeRow.extra ? JSON.parse(nodeRow.extra) : {}; } catch (e) { console.warn('[sessions] JSON.parse failed: ' + e.message); }
        delete ext.ttl;
        delete ext.tempCreated;
        delete ext.sessionId;
        ext.distilled_from = sessionId;
        ext.distilled_at = new Date().toISOString();
        db.prepare('UPDATE nodes SET extra = ?, importance = MAX(importance, 6), updated = CURRENT_TIMESTAMP WHERE id = ?')
          .run(JSON.stringify(ext), targetId);
        emitChange(learner, { op: 'node:update', nodeId: targetId, renamedFrom: targetId !== tempId ? tempId : undefined, source: 'graphcorn-distill' });
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
        emitChange(learner, { op: 'attribute:create', nodeId: tgt, aspect: aspectName, content, source: 'graphcorn-distill' });
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
      // Identity-node safety: never recycle person OR project nodes.
      // These are structural anchors for the agent's long-term memory —
      // person = who, project = where. User hit this: session T123420's
      // LLM returned promote(rename) for the project node, the rename
      // FK-failed (defer_foreign_keys doesn't always catch it), the
      // promote fell through without clearing ttl, and the project node
      // ended up soft-deleted here. Next session had to recreate the
      // project from scratch and lost all prior activity notes.
      if (t.type === 'person' || t.type === 'project') {
        try {
          const row = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(t.id);
          if (row) {
            let ext = {}; try { ext = row.extra ? JSON.parse(row.extra) : {}; } catch (e) { console.warn('[sessions] JSON.parse failed: ' + e.message); }
            delete ext.ttl;
            delete ext.tempCreated;
            delete ext.sessionId;
            db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(ext), t.id);
          }
        } catch (e) { console.warn('[sessions] db.prepare failed: ' + e.message); }
        if (log) log.info(`[distill] skipped soft-delete of ${t.type} node ${t.id} (identity guard, cleared temp flag)`);
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
        emitChange(learner, { op: 'node:delete', nodeId: t.id, source: 'graphcorn-distill' });
        dropped++;
      } catch (e) {
        if (log) log.warn(`[distill] failed to recycle ${t.id}: ${e.message}`);
      }
    }

    const kbPromotion = promoteReusableKnowledge(learner, sessionId, parsed, { projectId: projectIdForEdges });
    if (kbPromotion.promoted > 0 && log) {
      log.info(`[distill] promoted ${kbPromotion.promoted} reusable lesson(s) to ${kbPromotion.slug}`);
    }

    extraObj.distilled_at = new Date().toISOString();
    extraObj.distilled_promoted = promotedIds.size;
    extraObj.distilled_created = createdCount.value;
    extraObj.distilled_dropped = dropped;
    extraObj.distilled_notes_appended = notesAppended;
    extraObj.general_kb_promoted = kbPromotion.promoted || 0;
    delete extraObj.distilling;
    db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(extraObj), id);

    emitChange(learner, {
      op: 'session:distill-done',
      nodeId: id,
      promoted: promotedIds.size,
      created: createdCount.value,
      dropped,
      notesAppended,
      source: 'graphcorn',
    });

    // Archive the session node itself. Distillation has already
    // mined the useful signal (promotions to permanent nodes,
    // notes appended onto existing nodes, dropped temps recycled).
    // The session node's only remaining content — `summary`,
    // `rounds`, lifecycle metadata — is bookkeeping. Leaving it in
    // the live graph just clutters the viewer; the prior strategy
    // of "let the 48h janitor reap it via tempCreated" left a 48h
    // window of stale session nodes accumulating between runs.
    //
    // Now: move the full session payload to recycle_bin (7-day
    // restore window, same as unpromoted temp nodes), delete the
    // session's edges (no FK CASCADE on edges.source/target),
    // delete the node. The graph viewer immediately stops showing
    // it; future distillations don't see it; cross-session
    // discovery / context retrieval continues to work because the
    // discoveries / promoted nodes from this session were already
    // re-anchored to project nodes during distill (or carry their
    // own descriptive content).
    //
    // Opt out via `config.keepSessionNodes = true` for operators
    // who want sessions to persist (e.g. for forensics or for
    // experiments that walk session nodes directly).
    let archiveResult = { archived: false };
    if (!config?.keepSessionNodes) {
      try {
        const sessNode = db.prepare('SELECT id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, created, updated, extra FROM nodes WHERE id = ?').get(id);
        if (sessNode) {
          const sessAspects = db.prepare(`
            SELECT a.id AS aspect_id, a.name AS aspect_name, a.weight, a.extracted_with AS aspect_extracted_with,
                   att.id AS attr_id, att.content, att.importance, att.source, att.event_date, att.document_date, att.source_excerpt
            FROM aspects a
            LEFT JOIN attributes att ON att.aspect_id = a.id
            WHERE a.node_id = ?
          `).all(id);
          const sessEdges = db.prepare(
            'SELECT id, source, target, type, weight, extracted_with FROM edges WHERE source = ? OR target = ?'
          ).all(id, id);

          const archiveExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          const payload = JSON.stringify({
            node: sessNode,
            aspects: sessAspects,
            edges: sessEdges,
            archived_reason: 'session distillation complete',
            archived_at: new Date().toISOString(),
          });
          db.prepare(
            "INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at) VALUES ('node', ?, ?, ?, 'graphcorn-distill', ?, 1.0, ?)"
          ).run(id, sessNode.label, payload, `session ${sessionId} archived after distill`, archiveExpiresAt);

          // Delete edges first (no FK CASCADE on source/target).
          db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(id, id);
          // Aspects + attributes cascade via the schema's ON DELETE CASCADE.
          db.prepare('DELETE FROM nodes WHERE id = ?').run(id);

          emitChange(learner, { op: 'node:delete', nodeId: id, source: 'graphcorn-archive' });
          archiveResult = { archived: true, edgesRemoved: sessEdges.length, aspectsRemoved: new Set(sessAspects.map(r => r.aspect_id)).size };
          if (log) log.info(`[distill] ${id} archived to recycle_bin (${archiveResult.edgesRemoved} edges, ${archiveResult.aspectsRemoved} aspects, restorable until ${archiveExpiresAt})`);
        }
      } catch (e) {
        // Archive failure is non-fatal — distillation already
        // succeeded. The session node will be cleaned by the 48h
        // janitor as before.
        if (log) log.warn(`[distill] ${id} archive failed (distill itself ok): ${e.message}`);
        archiveResult = { archived: false, error: e.message };
      }
    }

    if (log) log.info(`[distill] ${id} done: promoted=${promotedIds.size} created=${createdCount.value} dropped=${dropped} notes=${notesAppended} model=${model}`);
    return { promoted: promotedIds.size, created: createdCount.value, dropped, notesAppended, archived: archiveResult.archived };
  } catch (e) {
    extraObj.distilling = false;
    extraObj.distill_error = e.message;
    extraObj.distill_error_at = new Date().toISOString();
    try {
      db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(extraObj), id);
    } catch {}
    emitChange(learner, { op: 'session:distill-done', nodeId: id, error: e.message, source: 'graphcorn' });
    if (log) log.warn(`[distill] ${id} failed: ${e.message} (temps left in place; janitor will clean in 48h)`);
    return { error: e.message };
  }
}

module.exports = {
  sessionNodeId,
  upsertSessionNode,
  finalizeSessionNode,
  bumpTurnCount,
  summarizeSessionNode,
  distillSession,
  promoteReusableKnowledge,
  repairGeneralKnowledgeBase,
};
