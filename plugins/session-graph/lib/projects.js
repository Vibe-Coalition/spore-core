// Project node persistence — caches per-(user, cwd) project metadata
// in the SPORE graph so subsequent Spore Code sessions for the same project
// can skip re-injecting the full file tree / ACORN.md / etc. and
// instead reference the cached node by id.
//
// Schema (uses existing nodes/aspects/attributes/edges tables):
//   nodes
//     id          = `project-{userId}-{hash(cwd)}`
//     label       = projectContext.project (basename of git root or cwd)
//     type        = 'project'
//     description = `${projectType} project at ${cwd}`
//   aspects
//     name='sandbox'        attributes: ["cwd: <path>", "os: linux/amd64"]
//     name='manifest'       attributes: ["type: <Go|Node.js|...>",
//                                        "git: <branch>@<hash>",
//                                        "tools: node, go, git, ..."]
//     name='conventions'    attributes: [<ACORN.md contents, capped 4 KB>]
//     name='tree'           attributes: [<one path per attribute>] (capped)
//     name='last_seen'      attributes: ["<ISO timestamp>"]
//     name='recent_activity' attributes: ["<ISO ts> — <one-line summary>", ...]
//
// The agent can `graph_query({ query: "project memory" })` against this
// node from inside a session to retrieve cross-session context.

const crypto = require('crypto');

function projectNodeId(userId, cwd) {
  const u = (userId || 'anon').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  // 8-char hash of the absolute cwd — collision-resistant enough for the
  // 'how many distinct projects does one user open' scale we're at.
  const h = crypto.createHash('sha256').update(cwd || '').digest('hex').slice(0, 8);
  return `project-${u}-${h}`;
}

// upsertProject is idempotent — call it on every chat:submit. The first
// call for a given (userId, cwd) creates the node; subsequent calls
// refresh aspects whose values changed (gitHash, last_seen) and leave
// stable aspects (sandbox, conventions) alone unless the underlying
// projectContext field actually changed.
//
// learner is the same object as graph/context.js (owns `db`).
// Returns { id, isNew, gitHashChanged }.
function upsertProject(learner, userId, pc) {
  if (!learner?.db || !pc?.cwd) return null;
  const db = learner.db;
  const id = projectNodeId(userId, pc.cwd);

  let isNew = false;
  let gitHashChanged = false;
  const existing = db.prepare('SELECT id, description FROM nodes WHERE id = ?').get(id);

  if (!existing) {
    isNew = true;
    const desc = pc.projectType
      ? `${pc.projectType} project at ${pc.cwd}`
      : `Project at ${pc.cwd}`;
    // graphcorn: when a project node is freshly created INSIDE a Spore Code
    // session, mark it temp + tag with sessionId so distillation can
    // promote it. Returning users hit the !existing=false branch and
    // their already-permanent project node stays untouched.
    const extraJson = pc.sessionId
      ? JSON.stringify({ ttl: 'temp', sessionId: pc.sessionId, tempCreated: new Date().toISOString() })
      : '{}';
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, extracted_with, extracted_at, provenance, extra) VALUES (?, ?, ?, ?, 6, 1, ?, ?, ?, ?)'
    ).run(
      id,
      pc.project || pc.cwd.split(/[\\/]/).pop() || 'project',
      'project',
      desc,
      'acorn-session',
      new Date().toISOString(),
      'acorn',
      extraJson,
    );
  } else {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  // Aspect helpers — mirror the pattern in tools.js:_graphUpdateTool
  // (insert aspect if missing, then INSERT OR IGNORE attributes by content).
  const ensureAspect = (name, importance = 5) => {
    let row = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(id, name);
    if (!row) {
      db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)')
        .run(id, name, importance, 'acorn-session');
      row = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
    }
    return row.id;
  };
  const addAttr = (aspectId, content, importance = 5) => {
    if (!content) return;
    const exists = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(aspectId, content);
    if (!exists) {
      db.prepare('INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, ?)')
        .run(aspectId, content, importance);
    }
  };
  const replaceAttrs = (aspectName, attrs, importance = 5) => {
    const aspId = ensureAspect(aspectName, importance);
    db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(aspId);
    for (const a of attrs) addAttr(aspId, a, importance);
  };

  // sandbox: stable per (cwd, os) — addAttr is fine, no need to rewrite.
  const sandboxId = ensureAspect('sandbox', 8);
  addAttr(sandboxId, `cwd: ${pc.cwd}`, 8);
  if (pc.os) addAttr(sandboxId, `os: ${pc.os}/${pc.arch || '?'}`);

  // manifest: gitBranch + gitHash + projectType + tools — refresh in
  // place because gitHash changes often.
  const manifestAttrs = [];
  if (pc.projectType) manifestAttrs.push(`type: ${pc.projectType}`);
  if (pc.gitBranch) manifestAttrs.push(`branch: ${pc.gitBranch}`);
  if (pc.gitHash) manifestAttrs.push(`git: ${pc.gitHash}`);
  if (pc.tools && pc.tools.length) manifestAttrs.push(`tools: ${pc.tools.join(', ')}`);

  // gitHash compare to detect "tree may have changed" — drives the
  // decision in context.js to either skip or re-inject the file tree.
  if (pc.gitHash && existing) {
    const prevGitRow = db.prepare(`
      SELECT a.content FROM attributes a
        JOIN aspects asp ON asp.id = a.aspect_id
       WHERE asp.node_id = ? AND asp.name = 'manifest' AND a.content LIKE 'git: %'
       LIMIT 1
    `).get(id);
    if (prevGitRow && prevGitRow.content !== `git: ${pc.gitHash}`) {
      gitHashChanged = true;
    }
  }
  if (manifestAttrs.length) replaceAttrs('manifest', manifestAttrs, 6);

  // conventions: SPORE.md (or legacy ACORN.md). Stable unless user
  // edits the file. Replace wholesale — cheaper than diffing.
  // Dual-read sporeMd ?? acornMd for one release: post-rebrand binaries
  // send sporeMd, pre-rebrand send acornMd.
  const projectMarkdown = pc.sporeMd || pc.acornMd;
  if (projectMarkdown) {
    replaceAttrs('conventions', [projectMarkdown], 7);
  }

  // tree: one attribute per path. Skip on cached hits to keep writes
  // cheap; re-write only when isNew or gitHashChanged.
  if (pc.tree && pc.tree.length && (isNew || gitHashChanged)) {
    const limited = pc.tree.slice(0, 200);
    replaceAttrs('tree', limited, 4);
  }

  // last_seen: refresh every call. Used by the future cleanup pass to
  // garbage-collect stale project nodes.
  replaceAttrs('last_seen', [new Date().toISOString()], 3);

  return { id, isNew, gitHashChanged };
}

// getProject hydrates the cached node for a (userId, cwd) lookup or
// returns null when none exists. Returns { id, label, gitHash, aspects }
// where aspects is { name: [attr, ...] } for compactness.
function getProject(learner, userId, cwd) {
  if (!learner?.db || !cwd) return null;
  const db = learner.db;
  const id = projectNodeId(userId, cwd);
  const row = db.prepare('SELECT id, label, description FROM nodes WHERE id = ?').get(id);
  if (!row) return null;

  const aspectRows = db.prepare(`
    SELECT asp.name, a.content
      FROM aspects asp
      JOIN attributes a ON a.aspect_id = asp.id
     WHERE asp.node_id = ?
     ORDER BY asp.name
  `).all(id);

  const aspects = {};
  for (const r of aspectRows) {
    if (!aspects[r.name]) aspects[r.name] = [];
    aspects[r.name].push(r.content);
  }

  // Pull gitHash out of the manifest aspect for the caller's
  // "is this still the same code state?" check.
  let gitHash = null;
  for (const m of aspects.manifest || []) {
    if (m.startsWith('git: ')) { gitHash = m.slice(5).trim(); break; }
  }

  return { id, label: row.label, description: row.description, gitHash, aspects };
}

// noteProjectInteraction appends a one-line summary onto the project
// node's recent_activity aspect. Capped at 50 entries (older are
// trimmed) so a chatty session doesn't unbounded-grow the node.
function noteProjectInteraction(learner, userId, cwd, summary) {
  if (!learner?.db || !cwd || !summary) return;
  const db = learner.db;
  const id = projectNodeId(userId, cwd);
  const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  if (!node) return;

  let aspRow = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(id, 'recent_activity');
  if (!aspRow) {
    db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)')
      .run(id, 'recent_activity', 4, 'acorn-session');
    aspRow = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
  }
  const ts = new Date().toISOString();
  const line = `${ts} — ${summary.slice(0, 200)}`;
  db.prepare('INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, ?)')
    .run(aspRow.id, line, 4);

  // Trim to the last 50 entries.
  const all = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? ORDER BY id DESC').all(aspRow.id);
  if (all.length > 50) {
    const toDrop = all.slice(50).map(r => r.id);
    const placeholders = toDrop.map(() => '?').join(',');
    db.prepare(`DELETE FROM attributes WHERE id IN (${placeholders})`).run(...toDrop);
  }
}

// upsertProjectCodeGraph writes a summary of the structural code index
// (clusters, tech stack, entry points, hot paths, stats) onto the
// project node's `code_graph` aspect. Authoritative symbol/CALLS data
// stays in the client-side .spore-code/index.db; this is the cheap,
// agent-facing summary that survives across sessions and shows up in
// the SPORE graph viewer.
//
// summary shape (matches what the codeindex `architecture` tool returns):
//   {
//     index_head: string,
//     stats: { files, symbols, functions, methods, classes, calls },
//     tech_stack: [{language, files, symbols}, ...],
//     entry_points: [{qname, name, file, line, kind, language}, ...] (≤10),
//     clusters: [{name, files, symbols, dominant_lang}, ...] (≤30),
//     hot_paths: [{qname, name, file, line, callers, language}, ...] (≤20),
//     notes: [string, ...]
//   }
function upsertProjectCodeGraph(learner, userId, cwd, summary) {
  if (!learner?.db || !cwd || !summary) return null;
  const db = learner.db;
  const id = projectNodeId(userId, cwd);
  const projRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  if (!projRow) return { error: `project node ${id} not found; session:start must run first` };

  // Wipe + rewrite the code_graph aspect from scratch — easier than
  // diffing per-attribute, and the aspect is small (≤100 attrs).
  let asp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'code_graph'").get(id);
  if (!asp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'code_graph', 7, 'acorn-codeindex')").run(id);
    asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(asp.id);

  const ins = db.prepare(
    "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, ?, 'acorn-codeindex', 'acorn-codeindex')"
  );

  if (summary.index_head) ins.run(asp.id, `index_head: ${summary.index_head}`, 5);

  if (summary.stats) {
    const s = summary.stats;
    ins.run(asp.id, `stats: ${s.files || 0} files, ${s.symbols || 0} symbols, ${s.functions || 0} functions, ${s.methods || 0} methods, ${s.classes || 0} classes, ${s.calls || 0} call edges`, 7);
  }

  if (Array.isArray(summary.tech_stack)) {
    const parts = summary.tech_stack.slice(0, 10).map(t => `${t.language}=${t.files}f/${t.symbols}s`);
    if (parts.length) ins.run(asp.id, `tech_stack: ${parts.join(', ')}`, 6);
  }

  if (Array.isArray(summary.entry_points)) {
    for (const ep of summary.entry_points.slice(0, 10)) {
      ins.run(asp.id, `entry: ${ep.kind || 'main'} ${ep.qname || (ep.file + ':' + ep.line)}`, 5);
    }
  }

  if (Array.isArray(summary.clusters)) {
    for (const c of summary.clusters.slice(0, 30)) {
      ins.run(asp.id, `cluster: ${c.name || c.path} — ${c.files} files, ${c.symbols} symbols (${c.dominant_lang})`, 6);
    }
  }

  if (Array.isArray(summary.hot_paths)) {
    for (const hp of summary.hot_paths.slice(0, 20)) {
      ins.run(asp.id, `hot: ${hp.qname || hp.name} ← ${hp.callers} callers (${hp.file}:${hp.line})`, 6);
    }
  }

  if (Array.isArray(summary.notes)) {
    for (const n of summary.notes.slice(0, 10)) {
      ins.run(asp.id, `note: ${n}`, 4);
    }
  }

  // Bump mentions on the project node so it lights up in the graph
  // viewer's recently-active list.
  db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);

  return { ok: true, projectNodeId: id };
}

module.exports = {
  projectNodeId,
  upsertProject,
  getProject,
  noteProjectInteraction,
  upsertProjectCodeGraph,
};
