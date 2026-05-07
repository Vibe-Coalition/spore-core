'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GraphContext } = require('../../src/graph/context');
const { GraphRegistry } = require('../../src/graph/multi');
const { ToolSystem } = require('../../src/tools/tools');

function quietLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-graph-query-'));
  const log = quietLog();
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, log);
  registry.init();

  const graph = new GraphContext({
    graphDbPath: registry.getActiveDbPath(),
    sharedGraphsDir: path.join(dir, 'graphs'),
    agentId: 'spore',
    displayName: 'Spore',
    enhancedRecall: false,
    model: 'test-model',
  }, log);
  assert.equal(graph.init(), true);
  graph._graphRegistry = registry;

  const tools = new ToolSystem({
    agentId: 'spore',
    displayName: 'Spore',
    graphDbPath: registry.getActiveDbPath(),
    sharedGraphsDir: path.join(dir, 'graphs'),
    sharedSkillsDir: path.join(dir, 'skills'),
  }, log, null, graph, null);
  tools._graphRegistry = registry;

  return {
    dir,
    graph,
    registry,
    tools,
    close() {
      try { graph.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedGeneralKnowledgeNode(registry) {
  const db = new DatabaseSync(registry.getDbPath('spore-knowledge-base'));
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, label, type, description, importance)
    VALUES ('gkb-loop-tools', 'Graph Loop Tools', 'concept', 'Reusable guidance for graph-query loops', 10)
  `).run();
  db.close();
}

test('graph_query mode graphs lists registry without db paths', async () => {
  const h = makeHarness();
  try {
    const result = await h.tools._graphQueryTool({ mode: 'graphs' });
    assert.equal(result.mode, 'graphs');
    assert.equal(result.generalKnowledgeGraph, 'spore-knowledge-base');
    const gkb = result.graphs.find(g => g.slug === 'spore-knowledge-base');
    assert.ok(gkb);
    assert.equal(gkb.name, 'General Knowledge Base');
    assert.equal(gkb.protected, true);
    assert.equal(gkb.inspectOnly, true);
    assert.equal(Object.hasOwn(gkb, 'dbPath'), false);
  } finally {
    h.close();
  }
});

test('graph_query graph selector can inspect the General Knowledge Base', async () => {
  const h = makeHarness();
  try {
    seedGeneralKnowledgeNode(h.registry);

    const overview = await h.tools._graphQueryTool({
      graph: 'spore-knowledge-base',
      mode: 'overview',
      limit: 5,
      offset: 0,
    });
    assert.equal(overview.mode, 'overview');
    assert.equal(overview.graph, 'spore-knowledge-base');
    assert.equal(overview.graphName, 'General Knowledge Base');
    assert.ok(overview.total >= 1);
    assert.ok(overview.nodeTypes.some(t => t.type === 'concept'));
    assert.equal(typeof overview.done, 'boolean');

    const byLegacyProjectAlias = await h.tools._graphQueryTool({
      project: 'spore-knowledge-base',
      nodeId: 'gkb-loop-tools',
    });
    assert.equal(byLegacyProjectAlias.graph, 'spore-knowledge-base');
    assert.equal(byLegacyProjectAlias.node.label, 'Graph Loop Tools');
  } finally {
    h.close();
  }
});

test('graph_query empty input and star query return overview pages', async () => {
  const h = makeHarness();
  try {
    const empty = await h.tools._graphQueryTool({});
    assert.equal(empty.mode, 'overview');
    assert.equal(empty.offset, 0);
    assert.ok(Array.isArray(empty.nodes));

    const star = await h.tools._graphQueryTool({ query: '*', limit: 2 });
    assert.equal(star.mode, 'overview');
    assert.equal(star.limit, 2);
    assert.ok(star.shown <= 2);
  } finally {
    h.close();
  }
});

test('graph_query rejects conflicting graph selectors', async () => {
  const h = makeHarness();
  try {
    const result = await h.tools._graphQueryTool({
      graph: 'spore-knowledge-base',
      project: 'default',
      mode: 'overview',
    });
    assert.match(result.error, /Conflicting graph selectors/);
  } finally {
    h.close();
  }
});
