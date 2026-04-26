// scripts.js — generic project-scoped script primitives.
//
// Stores agent-written reusable helpers as DEDICATED graph nodes
// (script:<projectId>:<name>) with three aspects: body, meta, stats.
// A lightweight `scripts_index` aspect on the project node holds one
// JSON-encoded summary entry per script — never the body — so the
// agent can `list_project_scripts` cheaply without dragging hundreds
// of KB of source through every graph_query.
//
// Why dedicated nodes (not slices on an aspect array): mirrors the
// existing note_discovery → discovery- node pattern. Workers
// (learner, maintainer, janitor) operate on generic nodes, no
// special-casing. Embeddings can index the meta.description aspect
// for semantic "find me a script that does X". Janitor pruning
// removes whole stale nodes cleanly instead of slicing array
// attributes.
//
// This module is the canonical project-scripts API. It's required
// by session-graph/index.js to register the agent-callable tools and
// can be reused by any future CLI plugin that depends on session-graph.

const crypto = require('crypto');

// ── Node id derivation ─────────────────────────────────────────────

// Mirrors projects.js:projectNodeId(userId, cwd) — kept inline to avoid
// a circular require between scripts and projects.
function projectNodeId(userId, cwd) {
  const u = (userId || 'anon').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  const h = crypto.createHash('sha256').update(cwd || '').digest('hex').slice(0, 8);
  return `project-${u}-${h}`;
}

function scriptNodeId(projectId, name) {
  // Project-scoped slug: `script:<projectId>:<safe-name>`. Safe-name is
  // the lower-case input with non-alphanumerics collapsed to dashes.
  const safe = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!safe) return null;
  return `script:${projectId}:${safe}`;
}

// ── Secret pattern guard ───────────────────────────────────────────

// Patterns that strongly suggest a credential leaked into a script
// body. The default save path REJECTS bodies matching any of these
// unless `force: true` is supplied. The patterns are intentionally
// broad — false positives are cheap (the agent can re-save with
// force) but missed secrets are expensive.
const SECRET_PATTERNS = [
  { name: 'OpenAI / Anthropic key', re: /\b(?:sk-(?:proj-)?[A-Za-z0-9]{20,})\b/ },
  { name: 'GitHub token',           re: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token',            re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key',         re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret',             re: /\b(?:AWS|aws)_?SECRET_?ACCESS_?KEY\s*[=:]\s*['"]?[A-Za-z0-9/+=]{30,}['"]?/ },
  { name: 'Bearer token',           re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { name: 'Generic password=',      re: /\bpassword\s*[=:]\s*['"][^'"\n]{6,}['"]/i },
  { name: 'Generic api_key=',       re: /\bapi[_-]?key\s*[=:]\s*['"][^'"\n]{16,}['"]/i },
  { name: 'Generic secret=',        re: /\bsecret\s*[=:]\s*['"][^'"\n]{16,}['"]/i },
  { name: 'Private key block',      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

function detectSecret(body) {
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(body);
    if (m) {
      const before = body.slice(0, m.index);
      const line = before.split('\n').length;
      return { name: p.name, line };
    }
  }
  return null;
}

// ── Index aspect helpers ───────────────────────────────────────────

// scripts_index lives on the project node. Each entry is one
// attribute row whose content is a JSON-encoded summary:
//   {name, description, language, tags, last_used, success_count, fail_count}
// list_project_scripts reads this aspect only — bodies stay on
// dedicated script: nodes.

const INDEX_ASPECT = 'scripts_index';
const INDEX_WEIGHT = 7;
const MAX_INDEX_ENTRIES = 200; // hard cap; oldest-by-last_used evicted

function ensureScriptsIndexAspect(db, projectId) {
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
      // Skip rows that aren't JSON — preserves backward compat with any
      // existing scratch_helpers prose-style entries.
    }
  }
  return out;
}

function writeIndexEntry(db, projectId, entry) {
  const aspId = ensureScriptsIndexAspect(db, projectId);
  const existing = loadIndexEntries(db, projectId).find(e => e.name === entry.name);
  const json = JSON.stringify(entry);
  if (existing) {
    db.prepare('UPDATE attributes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(json, existing.__attrId);
  } else {
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'session-graph', 'session-graph')"
    ).run(aspId, json);
    // Cap the index — drop the oldest-by-last_used over the limit.
    const all = loadIndexEntries(db, projectId);
    if (all.length > MAX_INDEX_ENTRIES) {
      all.sort((a, b) => (a.last_used || '').localeCompare(b.last_used || ''));
      const toDrop = all.slice(0, all.length - MAX_INDEX_ENTRIES);
      const ids = toDrop.map(e => e.__attrId);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM attributes WHERE id IN (${placeholders})`).run(...ids);
    }
  }
}

function deleteIndexEntry(db, projectId, name) {
  const aspId = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(projectId, INDEX_ASPECT)?.id;
  if (!aspId) return;
  const entry = loadIndexEntries(db, projectId).find(e => e.name === name);
  if (entry) {
    db.prepare('DELETE FROM attributes WHERE id = ?').run(entry.__attrId);
  }
}

// ── Dedicated node helpers ─────────────────────────────────────────

function ensureScriptNode(db, scriptId, label, sessionId) {
  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(scriptId);
  if (existing) {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(scriptId);
    return false;
  }
  // New script node — born `temp` if inside an acorn session so
  // distillation can promote winners. Outside a session, permanent.
  const extraJson = sessionId
    ? JSON.stringify({ ttl: 'temp', sessionId, tempCreated: new Date().toISOString() })
    : '{}';
  db.prepare(
    'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
  ).run(
    scriptId, label, 'script', label, 6,
    'session-graph', 'save_project_script', new Date().toISOString(), extraJson,
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

// upsertScriptNode validates, creates the dedicated script: node, and
// updates the project's scripts_index summary. Returns:
//   { ok, scriptNodeId, materializePath } on success
//   { ok: false, reason: 'suspected_secret', pattern, line } on a guard hit
//   { ok: false, error: '...' } on other failure
//
// Inputs:
//   projectId        canonical project node id (from projectNodeId(userId, cwd))
//   sessionId        optional acorn session id; when set the new node is
//                    born `temp` and tagged with the sessionId
//   name             unique script name within the project
//   description      one-line agent-facing summary
//   language         js | py | sh | ts | go | ...
//   body             full source
//   tags             optional []string
//   requires         optional []string of CLI deps (e.g. ['gh','jq'])
//   force            bypass the secret-pattern guard
function upsertScriptNode(learner, opts) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const { projectId, sessionId, name, description, language, body, tags, requires, force } = opts;
  if (!projectId) return { ok: false, error: 'projectId required' };
  if (!name) return { ok: false, error: 'name required' };
  if (typeof body !== 'string' || !body.trim()) return { ok: false, error: 'body required' };
  const scriptId = scriptNodeId(projectId, name);
  if (!scriptId) return { ok: false, error: 'name produced an empty slug' };

  if (!force) {
    const hit = detectSecret(body);
    if (hit) {
      return {
        ok: false,
        reason: 'suspected_secret',
        pattern: hit.name,
        line: hit.line,
        hint: 'Re-call with force:true to save anyway, OR remove the secret from the body. Default .cbmignore-style guards reject bodies matching common credential patterns.',
      };
    }
  }

  const db = learner.db;
  // Verify the project node exists — fail loudly otherwise. The acorn
  // session:start handler must have run first; we do not auto-create.
  const projRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(projectId);
  if (!projRow) {
    return { ok: false, error: `project node ${projectId} not found; session:start must run first` };
  }

  const isNew = ensureScriptNode(db, scriptId, name, sessionId);

  // body aspect — single attribute holds the source. Stored plaintext
  // for v1; the SECRET_PATTERNS guard is the user-facing safety. v1.5
  // can layer AES-256-GCM at rest using the sidecar keying util.
  replaceAttrs(db, ensureAspect(db, scriptId, 'body', 9), [body], 9);

  // meta aspect — agent-readable description + tags.
  const meta = [];
  if (description) meta.push(`description: ${description}`);
  if (language)    meta.push(`language: ${language}`);
  if (Array.isArray(tags) && tags.length)         meta.push(`tags: ${tags.join(', ')}`);
  if (Array.isArray(requires) && requires.length) meta.push(`requires: ${requires.join(', ')}`);
  if (meta.length) replaceAttrs(db, ensureAspect(db, scriptId, 'meta', 7), meta, 6);

  // stats aspect — append-only-ish (success_count / fail_count are
  // incremented via record_script_outcome). Initialize on first save.
  if (isNew) {
    const stats = [
      `created_at: ${new Date().toISOString()}`,
      `last_used: ${new Date().toISOString()}`,
      `success_count: 0`,
      `fail_count: 0`,
    ];
    replaceAttrs(db, ensureAspect(db, scriptId, 'stats', 4), stats, 4);
  }

  // Edge: project has_script script.
  ensureEdge(db, projectId, scriptId, 'has_script');

  // Update the project-side index summary. Uses last_used timestamp
  // for retrieval ordering and eviction.
  const entry = {
    name,
    description: description || '',
    language: language || '',
    tags: Array.isArray(tags) ? tags : [],
    requires: Array.isArray(requires) ? requires : [],
    last_used: new Date().toISOString(),
    success_count: 0,
    fail_count: 0,
  };
  // Preserve counters if entry already existed.
  const prior = loadIndexEntries(db, projectId).find(e => e.name === name);
  if (prior) {
    entry.success_count = prior.success_count || 0;
    entry.fail_count    = prior.fail_count    || 0;
  }
  writeIndexEntry(db, projectId, entry);

  return {
    ok: true,
    scriptNodeId: scriptId,
    isNew,
    // The CLI uses materializePath as the on-disk cache location; the
    // server isn't authoritative here, just suggesting the convention.
    materializePath: `.acorn/scratch/${entry.name}${extensionForLanguage(language)}`,
  };
}

// listScriptsIndex returns the lightweight summary list — no bodies.
// Cheap to call early in a session.
function listScriptsIndex(learner, projectId, filter = {}) {
  if (!learner?.db || !projectId) return [];
  const entries = loadIndexEntries(learner.db, projectId);
  return entries
    .filter(e => {
      if (filter.tag && !(Array.isArray(e.tags) && e.tags.includes(filter.tag))) return false;
      if (filter.language && e.language !== filter.language) return false;
      return true;
    })
    .map(e => {
      // Strip the internal __attrId before returning to the agent.
      const out = { ...e };
      delete out.__attrId;
      return out;
    });
}

// getScriptNode fetches the full body + meta + stats for one script.
function getScriptNode(learner, projectId, name) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const db = learner.db;
  const scriptId = scriptNodeId(projectId, name);
  if (!scriptId) return { ok: false, error: 'name produced an empty slug' };
  const node = db.prepare('SELECT id, label FROM nodes WHERE id = ?').get(scriptId);
  if (!node) return { ok: false, error: `no script named ${name} in this project` };

  const aspects = {};
  const rows = db.prepare(`
    SELECT asp.name AS aspect, a.content
      FROM aspects asp
      JOIN attributes a ON a.aspect_id = asp.id
     WHERE asp.node_id = ?
     ORDER BY asp.name
  `).all(scriptId);
  for (const r of rows) {
    if (!aspects[r.aspect]) aspects[r.aspect] = [];
    aspects[r.aspect].push(r.content);
  }

  const body = (aspects.body || []).join('\n');
  // Parse meta aspect ("key: value" attributes) into a flat object
  // for the agent.
  const meta = {};
  for (const line of aspects.meta || []) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  // Bump last_used + mentions on read so listScriptsIndex's ordering
  // reflects recent use.
  const now = new Date().toISOString();
  const entry = loadIndexEntries(db, projectId).find(e => e.name === name);
  if (entry) {
    entry.last_used = now;
    delete entry.__attrId;
    writeIndexEntry(db, projectId, entry);
  }
  db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(scriptId);

  return {
    ok: true,
    scriptNodeId: scriptId,
    name,
    body,
    meta,
    stats: aspects.stats || [],
    materializePath: `.acorn/scratch/${name}${extensionForLanguage(meta.language || '')}`,
  };
}

// recordScriptOutcome increments success_count or fail_count on the
// script node + index summary. Cheap; the agent should call it after
// each exec of the script so the maintainer/janitor can prune
// reliable-but-stale or always-failing helpers.
function recordScriptOutcome(learner, projectId, name, ok) {
  if (!learner?.db) return { ok: false, error: 'graph writer not available' };
  const db = learner.db;
  const scriptId = scriptNodeId(projectId, name);
  if (!scriptId) return { ok: false, error: 'name produced an empty slug' };
  const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(scriptId);
  if (!exists) return { ok: false, error: `no script named ${name} in this project` };

  // Stats aspect lives on the script node — pluck the counter
  // attribute, increment, write back. Counter format: "success_count: N".
  const aspId = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'stats'").get(scriptId)?.id;
  if (!aspId) return { ok: false, error: 'stats aspect missing' };
  const attrs = db.prepare('SELECT id, content FROM attributes WHERE aspect_id = ?').all(aspId);
  const key = ok ? 'success_count' : 'fail_count';
  let newCount = 1;
  for (const a of attrs) {
    if (a.content.startsWith(`${key}:`)) {
      const m = /:\s*(\d+)/.exec(a.content);
      newCount = (m ? parseInt(m[1], 10) : 0) + 1;
      db.prepare('UPDATE attributes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(`${key}: ${newCount}`, a.id);
      break;
    }
  }
  // Touch last_used on the index summary.
  const entry = loadIndexEntries(db, projectId).find(e => e.name === name);
  if (entry) {
    entry[key] = newCount;
    entry.last_used = new Date().toISOString();
    delete entry.__attrId;
    writeIndexEntry(db, projectId, entry);
  }
  return { ok: true, [key]: newCount };
}

// migrateScratchHelpers is a one-shot best-effort upgrade from the
// legacy `scratch_helpers` prose aspect (one path-and-purpose line per
// attribute) to the new scripts_index + script: node pair. It does
// NOT read disk — it can't reach the user's machine — so it creates
// metadata-only stub entries whose body is a placeholder. The agent
// is expected to call save_project_script properly with the actual
// body the next time it touches a helper.
//
// Returns {ok, migrated, skipped}. Idempotent: running twice is a
// no-op because the stubs already exist in scripts_index.
function migrateScratchHelpers(learner, projectId) {
  if (!learner?.db || !projectId) return { ok: false, error: 'invalid input' };
  const db = learner.db;
  const aspId = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'scratch_helpers'").get(projectId)?.id;
  if (!aspId) return { ok: true, migrated: 0, skipped: 0 };
  const rows = db.prepare('SELECT content FROM attributes WHERE aspect_id = ?').all(aspId);
  let migrated = 0;
  let skipped = 0;
  const existing = new Set(listScriptsIndex(learner, projectId).map(e => e.name));
  for (const r of rows) {
    // Format: "<path> — <purpose>"  e.g. ".acorn/scratch/foo.js — does X"
    const m = /^\s*(\S+)\s+[—-]\s+(.+)$/.exec(r.content);
    if (!m) {
      skipped++;
      continue;
    }
    const path = m[1].replace(/^\.acorn\/scratch\//, '');
    const name = path.replace(/\.[^.]+$/, '');
    const language = (path.match(/\.([^.]+)$/) || [, ''])[1];
    if (existing.has(name)) {
      skipped++;
      continue;
    }
    const description = m[2].trim();
    const entry = {
      name,
      description,
      language,
      tags: ['migrated'],
      requires: [],
      last_used: new Date().toISOString(),
      success_count: 0,
      fail_count: 0,
    };
    writeIndexEntry(db, projectId, entry);
    migrated++;
  }
  // Mark migration done so we never reprocess (idempotency).
  const projRow = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(projectId);
  let extra = {};
  try { extra = projRow?.extra ? JSON.parse(projRow.extra) : {}; } catch { /* ignore */ }
  extra.scripts_migrated_v1 = true;
  db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(extra), projectId);
  return { ok: true, migrated, skipped };
}

// ── helpers ────────────────────────────────────────────────────────

function extensionForLanguage(lang) {
  switch ((lang || '').toLowerCase()) {
    case 'js':         return '.js';
    case 'ts':         return '.ts';
    case 'py':
    case 'python':     return '.py';
    case 'sh':
    case 'bash':       return '.sh';
    case 'go':         return '.go';
    case 'rs':         return '.rs';
    case 'rb':         return '.rb';
    default:           return '';
  }
}

module.exports = {
  projectNodeId,
  scriptNodeId,
  detectSecret,
  upsertScriptNode,
  listScriptsIndex,
  getScriptNode,
  recordScriptOutcome,
  migrateScratchHelpers,
  extensionForLanguage,
  // Exported for tests.
  _internal: {
    SECRET_PATTERNS,
    INDEX_ASPECT,
    MAX_INDEX_ENTRIES,
    loadIndexEntries,
  },
};
