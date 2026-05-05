'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeGitRemote,
  projectIdentityFromContext,
  resolveDefaultMemoryEnvelope,
} = require('../../src/graph/scopes');
const { GraphContext } = require('../../src/graph/context');
const { GraphRegistry } = require('../../src/graph/multi');
const { applyPromptSectionsMixin } = require('../../src/graph/prompt-sections');
const { Learner } = require('../../src/workers/learner');
const projects = require('../../plugins/session-graph/lib/projects');
const sessions = require('../../plugins/session-graph/lib/sessions');
const registerSessionGraph = require('../../plugins/session-graph');

function newDb(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
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
    CREATE TABLE aliases (
      node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      alias TEXT NOT NULL
    );
  `);
  return db;
}

test('project identity prefers normalized git remote over local cwd', () => {
  const ssh = projectIdentityFromContext('yam', {
    cwd: '/home/yam/a',
    gitRemote: 'git@github.com:Yam/spore-core.git',
  });
  const https = projectIdentityFromContext('yam', {
    cwd: '/tmp/clone',
    gitRemote: 'https://github.com/yam/spore-core',
  });

  assert.equal(normalizeGitRemote('git@github.com:Yam/spore-core.git'), 'https://github.com/yam/spore-core');
  assert.equal(ssh.key, https.key);
  assert.equal(ssh.basis, 'git-remote');
});

test('codebase-session scoped recall excludes main graph free-text memory', () => {
  const registry = {
    _active: 'default',
    _graphs: {
      default: { slug: 'default', name: 'Default', role: 'main' },
      'spore-knowledge-base': { slug: 'spore-knowledge-base', name: 'General Knowledge Base', role: 'general_kb' },
    },
    getActiveSlug() { return this._active; },
    getMainSlug() { return 'default'; },
    getGeneralKnowledgeSlug() { return 'spore-knowledge-base'; },
    get(slug) { return this._graphs[slug] || null; },
    getDbPath(slug) { return `/tmp/${slug}.db`; },
    ensureProjectGraph(identityKey, meta) {
      this._graphs['project-test'] = { slug: 'project-test', role: 'project', name: meta.name, identityKey };
      return 'project-test';
    },
  };

  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userId: 'yam',
      messageContent: 'read this codebase',
      projectContext: { cwd: '/repo/app', project: 'app' },
    },
  });

  assert.equal(env.mode, 'codebase-session');
  assert.deepEqual(env.readScopes.map(s => s.slug), ['project-test', 'spore-knowledge-base']);
  assert.equal(env.readScopes.some(s => s.slug === 'default'), false);
});

test('codebase-session scoped recall includes general kb provenance nodes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-kb-recall-'));
  const dbPath = path.join(dir, 'spore-knowledge-base.db');
  const db = newDb(dbPath);
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'terminal-qr-rendering',
    'Terminal QR rendering',
    'concept',
    'Reusable QR code rendering lesson for chat and terminal interfaces.',
    8,
    'general-kb',
    'session-distill',
  );
  const aspect = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('terminal-qr-rendering', 'reusable_lessons', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    aspect,
    'When printing Expo QR codes in chat, avoid half-block small mode; use dense full-block output so the code remains scannable.',
    9,
    'session-distill',
    'session-distill',
  );
  db.close();

  const graph = new GraphContext({
    graphDbPath: dbPath,
    sharedGraphsDir: dir,
    agentId: 'spore',
    enhancedRecall: false,
  }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  assert.equal(graph.init(), true);
  try {
    const bundle = await graph._buildScopedRecallBundle({
      messageContent: 'start this expo server and print me the qr code',
      memoryEnvelope: {
        mode: 'codebase-session',
        readScopes: [{
          slug: 'spore-knowledge-base',
          role: 'general_kb',
          label: 'Reusable Engineering Memory',
          dbPath,
          budget: 8,
        }],
      },
    });

    assert.match(bundle, /Reusable Engineering Memory/);
    assert.match(bundle, /Terminal QR rendering/);
    assert.match(bundle, /dense full-block output/);
  } finally {
    graph.db?.close();
  }
});

test('codebase sessions do not receive global recent activity feed', () => {
  class FakeGraph {}
  applyPromptSectionsMixin(FakeGraph);
  const graph = new FakeGraph();
  graph.log = { warn() {} };

  assert.equal(graph._buildCrossSessionSection({
    platform: 'cli',
    projectContext: { cwd: '/repo/app' },
  }), null);
});

test('project helpers use project identity key for stable graph node id', () => {
  const db = newDb();
  const learner = { db };
  const projectIdentityKey = 'git:https://github.com/yam/spore-core';

  const first = projects.upsertProject(learner, 'yam', {
    cwd: '/home/yam/spore-core',
    project: 'spore-core',
    projectIdentityKey,
  });
  const second = projects.upsertProject(learner, 'yam', {
    cwd: '/tmp/other-clone',
    project: 'spore-core',
    projectIdentityKey,
  });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^project-[0-9a-f]{12}$/);
  const projectExtra = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(first.id)?.extra || '{}';
  assert.equal(JSON.parse(projectExtra).ttl, undefined);

  const r = projects.upsertProjectCodeGraph(learner, 'yam', '/tmp/other-clone', {
    stats: { files: 3, symbols: 12, functions: 4, methods: 2, classes: 1, calls: 8 },
    tech_stack: [{ language: 'JavaScript', files: 3, symbols: 12 }],
  }, { projectIdentityKey });

  assert.equal(r.ok, true);
  assert.equal(r.projectNodeId, first.id);
  const row = db.prepare(`
    SELECT a.content
      FROM attributes a
      JOIN aspects asp ON asp.id = a.aspect_id
     WHERE asp.node_id = ? AND asp.name = 'code_graph' AND a.content LIKE 'tech_stack:%'
  `).get(first.id);
  assert.ok(row?.content.includes('JavaScript=3f/12s'));
});

test('session-graph code summary tool arrays declare items schemas', () => {
  const tools = {};
  const api = {
    registerTool(name, def) { tools[name] = def; },
    getLogger() { return { info() {}, warn() {}, error() {}, debug() {} }; },
  };

  registerSessionGraph(api);
  const props = tools.update_code_graph_summary.inputSchema.properties;
  for (const key of ['tech_stack', 'entry_points', 'clusters', 'hot_paths', 'notes']) {
    assert.equal(props[key].type, 'array');
    assert.ok(props[key].items, `${key} is missing items schema`);
  }
});

test('session-graph project tools write through scoped project graph', () => {
  const tools = {};
  const mainDb = newDb();
  const scopedDb = newDb();
  const projectIdentityKey = 'git:https://github.com/yam/scoped-project';
  const projectId = projects.projectNodeIdFromContext('yam', {
    cwd: '/repo/a',
    projectIdentityKey,
  });
  projects.upsertProject({ db: scopedDb }, 'yam', {
    cwd: '/repo/a',
    project: 'scoped-project',
    projectIdentityKey,
  });

  const api = {
    _appContext: {
      learner: {
        db: mainDb,
        getGraphDb(slug) {
          return slug === 'project-scope' ? scopedDb : null;
        },
      },
    },
    registerTool(name, def) { tools[name] = def; },
    getLogger() { return { info() {}, warn() {}, error() {}, debug() {} }; },
  };
  registerSessionGraph(api);

  const result = tools.save_project_script.execute({
    name: 'hello',
    body: 'console.log("hello")',
    language: 'js',
  }, {
    platform: 'cli',
    channelId: 'session-1',
    userId: 'yam',
    projectContext: { cwd: '/repo/a' },
    memoryEnvelope: {
      projectKey: projectIdentityKey,
      writeScopes: { projectSlug: 'project-scope' },
    },
  });

  assert.equal(result.ok, true);
  assert.ok(scopedDb.prepare("SELECT id FROM nodes WHERE id LIKE 'script:%'").get());
  assert.equal(mainDb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'script:%'").get().c, 0);
  assert.equal(
    scopedDb.prepare("SELECT id FROM nodes WHERE id = ?").get(projectId)?.id,
    projectId,
  );
});

test('project graphs are managed inspect-only and use project refs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-graphs-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  registry.init();

  const slug = registry.ensureProjectGraph('git:https://github.com/yam/acorn-companion', {
    name: 'acorn-companion',
    description: 'project graph',
  });
  const graph = registry.get(slug);
  assert.equal(graph.role, 'project');
  assert.equal(graph.managed, true);
  assert.equal(graph.activationLocked, true);
  assert.throws(() => registry.setActive(slug), /inspect-only/);

  const db = new DatabaseSync(registry.getDbPath(slug), { readOnly: true });
  assert.ok(db.prepare("SELECT id FROM nodes WHERE id = 'ref-project-scope'").get());
  assert.ok(db.prepare("SELECT id FROM nodes WHERE id = 'ref-project-runtime'").get());
  assert.ok(db.prepare("SELECT id FROM nodes WHERE id = 'ref-project-shell'").get());
  assert.ok(db.prepare("SELECT id FROM nodes WHERE id = 'ref-project-verification'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'ref-tool-workflows'").get().c, 0);
  db.close();
});

test('codebase-session scoped recall always includes project operating refs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-project-refs-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  registry.init();

  const slug = registry.ensureProjectGraph('git:https://github.com/yam/acorn-companion', {
    name: 'acorn-companion',
    description: 'project graph',
  });
  const dbPath = registry.getDbPath(slug);
  const graph = new GraphContext({
    graphDbPath: dbPath,
    sharedGraphsDir: dir,
    agentId: 'spore',
    enhancedRecall: false,
  }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  assert.equal(graph.init(), true);
  try {
    const bundle = await graph._buildScopedRecallBundle({
      messageContent: 'close any node servers',
      memoryEnvelope: {
        mode: 'codebase-session',
        readScopes: [{ slug, role: 'project', label: 'Project Memory', dbPath, budget: 8 }],
      },
    });

    assert.match(bundle, /Project Operating References/);
    assert.match(bundle, /Shell And Quoting/);
    assert.match(bundle, /Processes And Dev Servers/);
    assert.match(bundle, /Verification Discipline/);
  } finally {
    graph.db?.close();
  }
});

test('learner refreshes cached graph db handle after delete and recreate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-graph-handle-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  registry.init();
  const key = 'git:https://github.com/yam/recreated-project';
  const slug = registry.ensureProjectGraph(key, { name: 'recreated-project' });

  const learner = new Learner({}, { info() {}, warn() {}, error() {}, debug() {} }, null);
  learner._graphRegistry = registry;
  const first = learner.getGraphDb(slug);
  assert.ok(first);

  registry.delete(slug);
  const recreated = registry.ensureProjectGraph(key, { name: 'recreated-project' });
  assert.equal(recreated, slug);
  const second = learner.getGraphDb(slug);

  assert.ok(second);
  assert.notEqual(second, first);
  assert.ok(second.prepare("SELECT id FROM nodes WHERE id = 'ref-project-runtime'").get());
  learner.close();
});

test('general kb promotion keeps reusable lessons and filters project artifacts', () => {
  const kb = newDb();
  const learner = {
    _graphRegistry: {
      getGeneralKnowledgeSlug: () => 'spore-knowledge-base',
      refreshStats() {},
    },
    getGraphDb(slug) {
      return slug === 'spore-knowledge-base' ? kb : null;
    },
  };

  const result = sessions.promoteReusableKnowledge(learner, 'cli:yam@project', {
    appendNotes: [
      {
        targetNodeId: 'inline-qr-chat-rendering',
        aspect: 'gotchas',
        content: 'For scannable inline QRs in markdown/chat, wrap output in code blocks and use doubled Unicode blocks for each module.',
      },
      {
        targetNodeId: 'project-acorn-companion',
        aspect: 'scratch_helpers',
        content: '.spore-code/scratch/qr.js — local helper created for this one project.',
      },
    ],
  }, { projectId: 'project-b8ba60d9a634' });

  assert.equal(result.promoted, 1);
  const kept = kb.prepare("SELECT description FROM nodes WHERE id = 'inline-qr-chat-rendering'").get();
  assert.ok(kept?.description.includes('scannable inline QRs'));
  assert.equal(kb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'project-acorn-companion'").get().c, 0);
  assert.ok(kb.prepare(`
    SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'inline-qr-chat-rendering' AND asp.name = 'summary'
  `).get());
});
