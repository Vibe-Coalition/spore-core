'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

test('knowledge graph seed advertises the General Knowledge Base query path', () => {
  const seedSql = fs.readFileSync(path.join(root, 'src', 'seed-graph.sql'), 'utf8');
  assert.match(seedSql, /spore-knowledge-base/);
  assert.match(seedSql, /graph_query\(\{ graph: "spore-knowledge-base", mode: "overview"/);
  assert.match(seedSql, /graph_query\(\{ mode: "graphs" \}\)/);
  assert.match(seedSql, /graph_query\(\{ graph: "spore-knowledge-base", type: "skill" \}\)/);
  assert.match(seedSql, /Do not describe the General Knowledge Base as empty/);
});

test('reference migration backfills General Knowledge Base guidance on knowledge-graph node', () => {
  const seedSql = fs.readFileSync(path.join(root, 'src', 'seed-graph.sql'), 'utf8')
    .replace(/AGENT_ID/g, 'spore')
    .replace(/AGENT_NAME/g, 'Spore');
  const migrateSql = fs.readFileSync(path.join(root, 'src', 'migrate-ref-tool-workflows.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(seedSql);
    db.prepare(`
      DELETE FROM attributes
       WHERE aspect_id IN (
         SELECT id FROM aspects
          WHERE node_id = 'knowledge-graph'
            AND name = 'how_it_works'
       )
         AND content LIKE '%spore-knowledge-base%'
    `).run();

    db.exec(migrateSql);

    const count = db.prepare(`
      SELECT COUNT(*) AS c
        FROM attributes a
        JOIN aspects asp ON asp.id = a.aspect_id
       WHERE asp.node_id = 'knowledge-graph'
         AND asp.name = 'how_it_works'
         AND a.content LIKE '%graph_query({ graph: "spore-knowledge-base", mode: "overview"%'
    `).get()?.c || 0;
    assert.equal(count, 1);
    const skillsGuidance = db.prepare(`
      SELECT COUNT(*) AS c
        FROM attributes a
        JOIN aspects asp ON asp.id = a.aspect_id
       WHERE asp.node_id = 'knowledge-graph'
         AND asp.name = 'how_it_works'
         AND a.content LIKE '%graph_query({ graph: "spore-knowledge-base", type: "skill" })%'
    `).get()?.c || 0;
    assert.equal(skillsGuidance, 1);
  } finally {
    db.close();
  }
});
