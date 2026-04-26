#!/usr/bin/env node
// Focused unit test for plugins/session-graph/lib/scripts.js.
// Uses node:sqlite (built-in on Node 22+) so it runs without
// installing any deps. No network, no graph context — just a fresh
// in-memory db with the minimal schema.
//
// Run with:  node plugins/session-graph/lib/scripts.test.js

const { DatabaseSync } = require('node:sqlite');
const scripts = require('./scripts');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; return; }
  console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  failed++;
}

function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL,
      description TEXT, importance INTEGER DEFAULT 5, mentions INTEGER DEFAULT 1,
      session_count INTEGER DEFAULT 0, provenance TEXT, extracted_with TEXT,
      extracted_at DATETIME, created DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated DATETIME DEFAULT CURRENT_TIMESTAMP, extra TEXT DEFAULT '{}'
    );
    CREATE TABLE aspects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL, weight INTEGER DEFAULT 5, extracted_with TEXT
    );
    CREATE TABLE attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aspect_id INTEGER REFERENCES aspects(id) ON DELETE CASCADE,
      content TEXT NOT NULL, importance INTEGER DEFAULT 5, source TEXT,
      created DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      extracted_with TEXT, event_date TEXT, document_date TEXT,
      source_excerpt TEXT, source_episode_id INTEGER
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT REFERENCES nodes(id), target TEXT REFERENCES nodes(id),
      type TEXT NOT NULL, weight REAL DEFAULT 1.0,
      created DATETIME DEFAULT CURRENT_TIMESTAMP, extracted_with TEXT
    );
  `);
  return db;
}

function makeProject(db, projectId) {
  db.prepare(
    "INSERT INTO nodes (id, label, type, description, importance, extracted_with) VALUES (?, ?, 'project', 'test', 6, 'test')"
  ).run(projectId, 'test-project');
}

console.log('\nplugins/session-graph/lib/scripts.test.js\n');

// ── projectNodeId / scriptNodeId shapes ──────────────────────────
{
  const pid = scripts.projectNodeId('yam', '/home/yam/proj');
  ok('projectNodeId is project-<user>-<8hex>', /^project-yam-[0-9a-f]{8}$/.test(pid), pid);
  const sid = scripts.scriptNodeId(pid, 'My Helper Script!');
  ok('scriptNodeId slug strips punctuation + lowercases', sid && sid.endsWith(':my-helper-script'), sid);
  ok('scriptNodeId returns null for empty name', scripts.scriptNodeId(pid, '') === null);
}

// ── Secret pattern guard ─────────────────────────────────────────
{
  ok('detectSecret catches sk- key',  scripts.detectSecret('foo\nconst k = "sk-proj-abcdef1234567890ABCDEF12345"\n').name.includes('OpenAI'));
  ok('detectSecret catches ghp_',     scripts.detectSecret('TOKEN=ghp_abcd1234efgh5678ijkl90').name.includes('GitHub'));
  ok('detectSecret catches AWS AKIA', scripts.detectSecret('AKIAIOSFODNN7EXAMPLE').name.includes('AWS'));
  ok('detectSecret catches Bearer',   scripts.detectSecret('Authorization: Bearer abcdefghij1234567890').name.includes('Bearer'));
  ok('detectSecret returns null on clean text', scripts.detectSecret('echo hello world\nls -la') === null);
}

// ── upsertScriptNode / listScriptsIndex / getScriptNode ──────────
{
  const db = newDb();
  const learner = { db };
  const projectId = scripts.projectNodeId('alice', '/repos/foo');
  makeProject(db, projectId);

  // Save a clean script.
  const r1 = scripts.upsertScriptNode(learner, {
    projectId,
    name: 'list-pids',
    description: 'list running pids matching a regex',
    language: 'sh',
    body: 'ps -ef | grep "$1" | grep -v grep',
    tags: ['proc'],
    requires: ['ps', 'grep'],
  });
  ok('save returns ok=true',           r1.ok === true, JSON.stringify(r1));
  ok('save returns scriptNodeId',      typeof r1.scriptNodeId === 'string' && r1.scriptNodeId.startsWith('script:'));
  ok('save returns materializePath',   r1.materializePath === '.acorn/scratch/list-pids.sh');

  // Save with a secret in the body — must reject.
  const r2 = scripts.upsertScriptNode(learner, {
    projectId, name: 'leaky', language: 'sh', body: 'export GH=ghp_abcd1234efgh5678ijkl90\nfoo',
  });
  ok('save rejects suspected secret without force', r2.ok === false && r2.reason === 'suspected_secret', JSON.stringify(r2));
  ok('save returns the matched pattern name',       r2.pattern && r2.pattern.includes('GitHub'));

  // Force-save the secret-containing script.
  const r3 = scripts.upsertScriptNode(learner, {
    projectId, name: 'leaky', language: 'sh', body: 'export GH=ghp_abcd1234efgh5678ijkl90\nfoo', force: true,
  });
  ok('save accepts secret with force=true', r3.ok === true);

  // List scripts — should return both, no body, no __attrId leaked.
  const list = scripts.listScriptsIndex(learner, projectId);
  ok('list returns 2 entries',           list.length === 2);
  ok('list never carries body field',    list.every(e => !('body' in e)));
  ok('list strips internal __attrId',    list.every(e => !('__attrId' in e)));
  ok('list entry has description',       list.find(e => e.name === 'list-pids')?.description === 'list running pids matching a regex');

  // Tag filter.
  const procOnly = scripts.listScriptsIndex(learner, projectId, { tag: 'proc' });
  ok('tag filter returns matching only', procOnly.length === 1 && procOnly[0].name === 'list-pids');

  // Get full script — body comes back.
  const r4 = scripts.getScriptNode(learner, projectId, 'list-pids');
  ok('get returns ok',                       r4.ok === true);
  ok('get returns body',                     r4.body && r4.body.includes('ps -ef'));
  ok('get returns parsed meta',              r4.meta && r4.meta.description === 'list running pids matching a regex');
  ok('get returns materializePath',          r4.materializePath === '.acorn/scratch/list-pids.sh');

  // Get for unknown name — error.
  const r5 = scripts.getScriptNode(learner, projectId, 'unknown-script');
  ok('get rejects unknown name',             r5.ok === false);

  // Edge created project ─[has_script]→ script-node.
  const edge = db.prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND type = 'has_script'").get(projectId, r1.scriptNodeId);
  ok('has_script edge exists',               !!edge);
}

// ── recordScriptOutcome ───────────────────────────────────────────
{
  const db = newDb();
  const learner = { db };
  const projectId = scripts.projectNodeId('bob', '/proj/bar');
  makeProject(db, projectId);
  scripts.upsertScriptNode(learner, { projectId, name: 'gen-qr', language: 'js', body: 'console.log(1)' });

  let r = scripts.recordScriptOutcome(learner, projectId, 'gen-qr', true);
  ok('record outcome ok=true bumps success_count to 1', r.ok && r.success_count === 1, JSON.stringify(r));

  r = scripts.recordScriptOutcome(learner, projectId, 'gen-qr', true);
  ok('record outcome bumps to 2', r.success_count === 2);

  r = scripts.recordScriptOutcome(learner, projectId, 'gen-qr', false);
  ok('record outcome ok=false bumps fail_count to 1', r.ok && r.fail_count === 1);

  // Counters mirrored on the index summary so list_project_scripts shows them.
  const list = scripts.listScriptsIndex(learner, projectId);
  ok('index summary reflects success_count', list[0].success_count === 2);
  ok('index summary reflects fail_count',    list[0].fail_count === 1);

  // Unknown script — error.
  const ru = scripts.recordScriptOutcome(learner, projectId, 'unknown', true);
  ok('record outcome rejects unknown',       ru.ok === false);
}

// ── migrateScratchHelpers ─────────────────────────────────────────
{
  const db = newDb();
  const learner = { db };
  const projectId = scripts.projectNodeId('migrate', '/proj/legacy');
  makeProject(db, projectId);

  // Seed legacy scratch_helpers aspect on the project node.
  db.prepare("INSERT INTO aspects (node_id, name, weight) VALUES (?, 'scratch_helpers', 5)").run(projectId);
  const aspId = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'scratch_helpers'").get(projectId).id;
  db.prepare("INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, 5)").run(aspId, '.acorn/scratch/get-lan-ip.js — print LAN IP');
  db.prepare("INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, 5)").run(aspId, '.acorn/scratch/gen-qr.sh — produce QR for given URL');
  db.prepare("INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, 5)").run(aspId, 'unparseable garbage line without separator');

  const m = scripts.migrateScratchHelpers(learner, projectId);
  ok('migrate ok',                m.ok && m.migrated === 2 && m.skipped === 1, JSON.stringify(m));

  const list = scripts.listScriptsIndex(learner, projectId);
  ok('migrated entries appear in scripts_index', list.length === 2);
  ok('migrated language inferred from extension', list.find(e => e.name === 'get-lan-ip')?.language === 'js');
  ok('migrated tag includes "migrated"',          list.every(e => Array.isArray(e.tags) && e.tags.includes('migrated')));

  // Idempotent — second run is a no-op (re-skips the unparseable line +
  // both already-migrated entries; nothing new to migrate).
  const m2 = scripts.migrateScratchHelpers(learner, projectId);
  ok('migrate is idempotent',     m2.ok && m2.migrated === 0 && m2.skipped === 3, JSON.stringify(m2));

  // Marker stamped on the project's extra.
  const projRow = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(projectId);
  const extra = JSON.parse(projRow.extra);
  ok('migration marker stamped on project.extra', extra.scripts_migrated_v1 === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
