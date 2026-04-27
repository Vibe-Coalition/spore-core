#!/usr/bin/env node
// Focused unit test for plugins/session-graph/lib/decisions.js. Same
// shape as scripts.test.js — uses node:sqlite with an in-memory db
// and the minimal graph schema.
//
// Run with:  node plugins/session-graph/lib/decisions.test.js

const { DatabaseSync } = require('node:sqlite');
const decisions = require('./decisions');

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

console.log('\nplugins/session-graph/lib/decisions.test.js\n');

// ── slug + node id derivation ────────────────────────────────────
{
  ok('decisionNodeId slugifies title-style ids',
     /^decision:project-foo-bar:auth-rewrite$/.test(decisions.decisionNodeId('project-foo-bar', 'Auth Rewrite')));
  ok('decisionNodeId returns null on empty id',
     decisions.decisionNodeId('project-foo-bar', '') === null);
  ok('decisionNodeId honors numeric ids',
     decisions.decisionNodeId('project-foo-bar', '0042') === 'decision:project-foo-bar:0042');
}

// ── Create + list + get + update ────────────────────────────────
{
  const db = newDb();
  const learner = { db };
  const projectId = decisions.projectNodeId('alice', '/repos/foo');
  makeProject(db, projectId);

  const r1 = decisions.newDecision(learner, {
    projectId,
    title: 'Switch to bun for workspace scripts',
    body:  '## Context\nNode is slow for our test loop.\n## Options\n- bun\n- deno\n## Decision\nbun.',
  });
  ok('newDecision returns ok',                r1.ok === true, JSON.stringify(r1));
  ok('newDecision assigns slug id',           r1.id === 'switch-to-bun-for-workspace-scripts');
  ok('newDecision defaults status=proposed',  r1.status === 'proposed');
  ok('newDecision creates the node',          !!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(r1.decisionNodeId));
  ok('newDecision creates has_decision edge', !!db.prepare("SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = 'has_decision'").get(projectId, r1.decisionNodeId));

  // Listed in the project's index aspect — without body.
  const list = decisions.listDecisions(learner, projectId);
  ok('list returns 1 entry',                   list.length === 1);
  ok('list strips internal __attrId',          list.every(e => !('__attrId' in e)));
  ok('list never carries body',                list.every(e => !('body' in e)));
  ok('list entry has expected shape',          list[0].title === 'Switch to bun for workspace scripts' && list[0].status === 'proposed');

  // Re-create with same id rejected.
  const r1b = decisions.newDecision(learner, {
    projectId,
    title: 'Switch to bun for workspace scripts',
    body:  'duplicate',
  });
  ok('newDecision rejects duplicate id',       r1b.ok === false);

  // Status filter on list.
  const accepted = decisions.listDecisions(learner, projectId, { status: 'accepted' });
  ok('list filter status=accepted returns []', accepted.length === 0);

  // Get full body.
  const r2 = decisions.getDecision(learner, projectId, r1.id);
  ok('get returns ok',                          r2.ok === true);
  ok('get returns body',                        r2.body && r2.body.includes('Node is slow'));
  ok('get returns parsed meta',                 r2.meta && r2.meta.status === 'proposed');

  // Update to accepted.
  const r3 = decisions.updateDecision(learner, { projectId, id: r1.id, status: 'accepted' });
  ok('update returns ok',                       r3.ok === true);
  ok('update reflects new status on get',       decisions.getDecision(learner, projectId, r1.id).meta.status === 'accepted');
  ok('update reflects new status on list',      decisions.listDecisions(learner, projectId)[0].status === 'accepted');

  // Invalid status rejected.
  const r4 = decisions.updateDecision(learner, { projectId, id: r1.id, status: 'whatever' });
  ok('update rejects invalid status',           r4.ok === false);

  // Unknown id rejected.
  const r5 = decisions.getDecision(learner, projectId, 'nope');
  ok('get rejects unknown id',                  r5.ok === false);

  // Updating body keeps created_at, refreshes updated_at.
  const r6 = decisions.updateDecision(learner, { projectId, id: r1.id, body: 'new body' });
  const after = decisions.getDecision(learner, projectId, r1.id);
  ok('update can rewrite body',                 after.body === 'new body');
  ok('created_at preserved across update',      after.meta.created_at && after.meta.created_at !== '');
  ok('updated_at refreshed after update',       r6.ok === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
