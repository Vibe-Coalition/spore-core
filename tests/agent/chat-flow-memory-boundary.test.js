'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GraphContext } = require('../../src/graph/context');
const { GraphRegistry } = require('../../src/graph/multi');
const {
  createChatFlowHarness,
  requestText,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function seedDefaultGraphLeak(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, label, type, description, importance)
    VALUES ('test-user', 'test-user', 'person', 'User requesting du scan monitoring', 8)
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, label, type, description, importance)
    VALUES ('du_scan_process', 'DU Scan Process', 'system_task', 'Disk usage scan monitored from a web chat', 8)
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, label, type, description, importance)
    VALUES ('host_1778103972392', 'remote GPU login host', 'system', 'Remote host used by an unrelated web task', 7)
  `).run();
  db.prepare(`
    INSERT INTO edges (source, target, type, weight)
    VALUES ('test-user', 'du_scan_process', 'requested', 1.0)
  `).run();
  db.prepare(`
    INSERT INTO edges (source, target, type, weight)
    VALUES ('du_scan_process', 'host_1778103972392', 'runs_on', 1.0)
  `).run();
  const aspectId = db.prepare(`
    INSERT INTO aspects (node_id, name, weight)
    VALUES ('du_scan_process', 'scan_config', 8)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source)
    VALUES (?, 'Output file: /tmp/home-du-results.txt; prior web request asked to monitor this.', 8, 'web-chat')
  `).run(aspectId);
  db.close();
}

test('chat-flow harness catches default-graph leakage into fresh cli project sessions', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-chat-flow-'));
  const log = logger();
  const registry = new GraphRegistry(dataDir, { agentId: 'spore', displayName: 'Spore' }, log);
  registry.init();
  seedDefaultGraphLeak(registry.getDbPath(registry.getMainSlug()));

  const graph = new GraphContext({
    graphDbPath: registry.getActiveDbPath(),
    sharedGraphsDir: path.join(dataDir, 'graphs'),
    agentId: 'spore',
    displayName: 'Spore',
    enhancedRecall: false,
    model: 'test-model',
  }, log);
  assert.equal(graph.init(), true);
  graph._graphRegistry = registry;

  try {
    const harness = createChatFlowHarness({
      graph,
      graphRegistry: registry,
      tools: ['graph_query'],
      toolResults: {
        graph_query: { ok: true, results: [{ label: 'DU Scan Process' }] },
      },
      script: [
        (req) => {
          const seen = requestText(req);
          if (/DU Scan|du_scan|home-du-results|host_1778103972392|remote GPU/i.test(seen)) {
            return toolResponse('graph_query', { query: 'test-user du scan monitoring' }, {
              id: 'toolu_leak_1',
              text: 'I see prior du scan context, checking it.',
            });
          }
          return textResponse('hey test-user. fresh code session ready.');
        },
        textResponse('I used leaked default-graph context.'),
      ],
    });

    const turn = await harness.send('hello', {
      sessionKey: 'channel:cli:test-user@sample_project-5a1d31f0-20260507T002138',
      channelId: 'cli:test-user@sample_project-5a1d31f0-20260507T002138',
      channelName: 'sample_project',
      platform: 'cli',
      trigger: 'mention',
      userId: 'test-user',
      userName: 'test-user',
      userRole: 'cli',
      isDm: false,
      projectContext: {
        cwd: '/home/test-user/sample_project',
        project: 'sample_project',
        source: 'spore-code',
      },
    });

    assert.equal(turn.text, 'hey test-user. fresh code session ready.');
    assert.deepEqual(turn.toolCalls.map(c => c.name), []);
    assert.equal(harness.model.requests.length, 1);

    const promptSeenByModel = requestText(harness.model.requests[0]);
    assert.match(promptSeenByModel, /Fresh Spore Code project session/);
    assert.match(promptSeenByModel, /Project Operating References/);
    assert.doesNotMatch(promptSeenByModel, /DU Scan/i);
    assert.doesNotMatch(promptSeenByModel, /du_scan/i);
    assert.doesNotMatch(promptSeenByModel, /home-du-results/i);
    assert.doesNotMatch(promptSeenByModel, /host_1778103972392/i);
    assert.doesNotMatch(promptSeenByModel, /remote GPU/i);
  } finally {
    graph.close();
  }
});

test('chat-flow harness records assistant behavior, tool calls, and persisted turns', async () => {
  const harness = createChatFlowHarness({
    prompt: 'You are a test agent with graph access.',
    tools: ['graph_query'],
    toolResults: {
      graph_query: input => ({ ok: true, answer: `found:${input.query}` }),
    },
    script: [
      toolResponse('graph_query', { query: 'current graph scope' }, {
        id: 'toolu_scope',
        text: 'checking the graph scope',
      }),
      textResponse('graph scope checked.'),
    ],
  });

  const turn = await harness.send('what graph are we in?', {
    sessionKey: 'dm:test-user',
    platform: 'web',
    trigger: 'dm',
  });

  assert.equal(turn.text, 'graph scope checked.');
  assert.deepEqual(turn.toolCalls.map(c => c.name), ['graph_query']);
  assert.equal(turn.events.intermediateTexts.join(''), 'checking the graph scope');
  assert.deepEqual(turn.history.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(requestText(harness.model.requests[1]), /found:current graph scope/);
});
