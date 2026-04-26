// note_discovery — write a durable discovery node to the graph and
// link it to the active session + project. Generic enough to be used
// by any plugin that has a session anchor (channelId) + a project
// anchor (cwd from projectContext). Acorn-cli is the current consumer;
// future CLI / web / Discord plugins can register the same tool as a
// passthrough or wrap it.
//
// Sync — all DB ops are synchronous (better-sqlite3 / node:sqlite
// prepared statements).

const crypto = require('crypto');

function noteDiscovery(api, input, ctx) {
  const learner = api._appContext?.learner;
  if (!learner?.db) return { error: 'Graph writer not available' };
  const text = String(input?.text || '').trim();
  if (!text) return { error: 'text is required' };
  const kind = ['fact', 'gotcha', 'workflow', 'config', 'failure_fix']
    .includes(input?.kind) ? input.kind : 'fact';
  const explicitLabel = input?.label && String(input.label).trim();
  const label = explicitLabel || (text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text);
  const relatedTo = Array.isArray(input?.relatedTo) ? input.relatedTo : [];

  // Read session/project context from the wide ctx that core's tool
  // dispatcher passes to plugin tools.
  const platform = ctx?.platform || null;
  const sessionId = platform === 'cli' ? (ctx?.channelId || null) : null;
  const userId = ctx?.userId || ctx?.userName || 'anon';
  const cwd = ctx?.projectContext?.cwd || ctx?.projectContext?.clientCwd || null;

  const db = learner.db;

  // Slugify the label to a node id, suffix with a short hash of the
  // text so two distinct discoveries with the same label don't collapse.
  // If a node with the exact id already exists, append the new text as
  // a fresh attribute on its `details` aspect rather than creating a
  // new node.
  const slug = label.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'discovery';
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
  const id = `discovery-${slug}-${hash}`;

  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  let isNew = false;
  if (!existing) {
    isNew = true;
    // In a session, every new node is born temp + tagged with the
    // sessionId. Session-end distillation reads these back, picks
    // winners (promotes by clearing ttl), and recycles the rest.
    // Without a session ctx the discovery is permanent.
    let sessionAlreadyDistilled = false;
    if (sessionId) {
      try {
        const sessRow = db.prepare(
          "SELECT json_extract(extra, '$.distilled_at') AS distilled FROM nodes WHERE id = ?"
        ).get('session-' + String(sessionId));
        sessionAlreadyDistilled = !!sessRow?.distilled;
      } catch (e) { api.getLogger().warn('distill-check failed: ' + e.message); }
    }
    const extraJson = (sessionId && !sessionAlreadyDistilled)
      ? JSON.stringify({ ttl: 'temp', sessionId, tempCreated: new Date().toISOString() })
      : '{}';
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
    ).run(id, label, 'discovery', text, 7, 'session-graph', 'note_discovery', new Date().toISOString(), extraJson);
  } else {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  // details aspect — text goes here
  let detAsp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'details'").get(id);
  if (!detAsp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'details', 8, 'session-graph')").run(id);
    detAsp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  const dup = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(detAsp.id, text);
  if (!dup) {
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'note_discovery', 'session-graph')"
    ).run(detAsp.id, text);
  }

  // kind aspect — single attribute
  let kAsp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'kind'").get(id);
  if (!kAsp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'kind', 6, 'session-graph')").run(id);
    kAsp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'note_discovery', 'session-graph')"
    ).run(kAsp.id, kind);
  }

  // Edges: discovery → session + discovery → project + relatedTo
  const checkE = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?');
  const insE = db.prepare(
    "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1, 'session-graph')"
  );

  let linkedSession = null;
  if (sessionId) {
    const sessId = 'session-' + String(sessionId);
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(sessId)) {
      if (!checkE.get(id, sessId, 'recorded_in')) insE.run(id, sessId, 'recorded_in');
      linkedSession = sessId;
    }
  }

  let linkedProject = null;
  if (sessionId && userId && cwd) {
    // Compute the project node id using projects.js's convention
    // (kept inline to avoid a circular require; both are stable).
    const u = String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
    const h = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    const projId = `project-${u}-${h}`;
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(projId)) {
      if (!checkE.get(id, projId, 'learned_about')) insE.run(id, projId, 'learned_about');
      linkedProject = projId;
    }
  }

  let linkedRelated = 0;
  for (const r of relatedTo) {
    const rid = String(r || '').toLowerCase().trim();
    if (!rid) continue;
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(rid)) {
      if (!checkE.get(id, rid, 'relates_to')) {
        insE.run(id, rid, 'relates_to');
        linkedRelated++;
      }
    }
  }

  return { ok: true, nodeId: id, isNew, kind, linkedSession, linkedProject, linkedRelated };
}

module.exports = { noteDiscovery };
