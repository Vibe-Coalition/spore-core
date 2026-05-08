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
const { ChannelDistiller } = require('../../src/workers/channel-distiller');
const heuristics = require('../../plugins/session-graph/lib/heuristics');
const projects = require('../../plugins/session-graph/lib/projects');
const sessions = require('../../plugins/session-graph/lib/sessions');
const registerSessionGraph = require('../../plugins/session-graph');
const graphEvents = require('../../src/graph/events');

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

function quietLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function insertDefaultGraphPersonalLeak(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, label, type, description, importance)
    VALUES ('alice-private-note', 'Alice Private Note', 'person', 'ALICE_PRIVATE_TOKEN should never appear in project recall', 9)
  `).run();
  const asp = db.prepare(`
    INSERT INTO aspects (node_id, name, weight)
    VALUES ('alice-private-note', 'private_context', 9)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source)
    VALUES (?, 'ALICE_PRIVATE_TOKEN: personal default graph context, not project knowledge', 9, 'test')
  `).run(asp);
  db.close();
}

function fakeDistillClient(parsed) {
  const text = JSON.stringify(parsed);
  return {
    messages: {
      stream() {
        return {
          async finalMessage() {
            return { content: [{ type: 'text', text }] };
          },
        };
      },
      async create() {
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

function fakeSequentialDistillClient(responses) {
  let i = 0;
  return {
    messages: {
      stream() {
        const text = JSON.stringify(responses[Math.min(i, responses.length - 1)]);
        i++;
        return {
          async finalMessage() {
            return { content: [{ type: 'text', text }] };
          },
        };
      },
      async create() {
        const text = JSON.stringify(responses[Math.min(i, responses.length - 1)]);
        i++;
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

test('project identity prefers normalized git remote over local cwd', () => {
  const ssh = projectIdentityFromContext('test-user', {
    cwd: '/home/test-user/a',
    gitRemote: 'git@github.com:test-user/spore-core.git',
  });
  const https = projectIdentityFromContext('test-user', {
    cwd: '/tmp/clone',
    gitRemote: 'https://github.com/test-user/spore-core',
  });

  assert.equal(normalizeGitRemote('git@github.com:test-user/spore-core.git'), 'https://github.com/test-user/spore-core');
  assert.equal(ssh.key, https.key);
  assert.equal(ssh.basis, 'git-remote');
});

test('distilled project memory is shared across users on the same git remote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-project-collab-'));
  const log = quietLog();
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, log);
  registry.init();
  insertDefaultGraphPersonalLeak(registry.getDbPath(registry.getMainSlug()));

  const aliceProject = {
    cwd: '/Users/alice/dev/acorn-companion',
    project: 'acorn-companion',
    gitRemote: 'git@github.com:test-user/acorn-companion.git',
    source: 'spore-code',
  };
  const bobProject = {
    cwd: '/home/bob/src/acorn-companion',
    project: 'acorn-companion',
    gitRemote: 'https://github.com/test-user/acorn-companion',
    source: 'spore-code',
  };

  const aliceEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'alice',
      userName: 'alice',
      projectContext: aliceProject,
    },
  });
  const bobEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'bob',
      userName: 'bob',
      projectContext: bobProject,
    },
  });

  assert.equal(aliceEnv.mode, 'codebase-session');
  assert.equal(bobEnv.mode, 'codebase-session');
  assert.equal(aliceEnv.projectKey, bobEnv.projectKey);
  assert.equal(aliceEnv.primarySlug, bobEnv.primarySlug);

  const projectDb = new DatabaseSync(registry.getDbPath(aliceEnv.primarySlug));
  const projectId = projects.projectNodeIdFromContext('alice', {
    ...aliceProject,
    projectIdentityKey: aliceEnv.projectKey,
  });
  const learner = {
    db: projectDb,
    _graphSlug: aliceEnv.primarySlug,
  };

  try {
    const sessionId = 'alice-shared-project-session';
    const sessionNode = sessions.sessionNodeId(sessionId);
    const upsert = sessions.upsertSessionNode(learner, {
      sessionId,
      userId: 'alice',
      userName: 'alice',
      cwd: aliceProject.cwd,
      project: aliceProject.project,
      projectIdentityKey: aliceEnv.projectKey,
      startedAt: '2026-05-07T10:00:00.000Z',
      model: 'test-model',
    });
    assert.equal(upsert.projectId, projectId);

    const roundsAspect = projectDb.prepare(`
      INSERT INTO aspects (node_id, name, weight, extracted_with)
      VALUES (?, 'rounds', 8, 'test')
    `).run(sessionNode).lastInsertRowid;
    projectDb.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      VALUES (?, ?, 8, 'test', 'test')
    `).run(
      roundsAspect,
      'turn 1 | user prompt: fix frontend API endpoint config | tools used: read_file, edit_file, run_tests | files touched: src/config.ts | reply preview: verified CLIENT_PUBLIC_API_BASE_URL controls browser API endpoint fallback',
    );

    const distill = await sessions.distillSession(learner, fakeDistillClient({
      promote: [],
      createNodes: [{
        nodeId: 'frontend-api-endpoint-config',
        label: 'Frontend API endpoint config',
        type: 'concept',
        description: 'Project convention for browser API endpoint configuration.',
        aspects: [{
          name: 'project_conventions',
          attributes: [
            'In this repo, browser code reads CLIENT_PUBLIC_API_BASE_URL for API endpoint configuration before falling back to /api; Alice verified this during the session.',
          ],
        }],
      }],
      appendNotes: [{
        targetNodeId: projectId,
        aspect: 'recent_activity',
        content: 'Learned in session: frontend API endpoint config uses CLIENT_PUBLIC_API_BASE_URL before /api fallback.',
      }],
    }), { casualModel: 'test-model' }, sessionId, log);

    assert.equal(distill.error, undefined);
    assert.equal(distill.created, 1);
    assert.ok(projectDb.prepare("SELECT id FROM nodes WHERE id = 'frontend-api-endpoint-config'").get());

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
    try {
      const prompt = await graph.buildSystemPromptAsync({
        promptMode: 'full',
        platform: 'cli',
        userRole: 'cli',
        userId: 'bob',
        userName: 'bob',
        messageContent: 'CLIENT_PUBLIC_API_BASE_URL',
        projectContext: bobProject,
        memoryEnvelope: bobEnv,
      });

      assert.match(prompt, /Project Memory/);
      assert.match(prompt, /Frontend API endpoint config/);
      assert.match(prompt, /CLIENT_PUBLIC_API_BASE_URL/);
      assert.match(prompt, /Alice verified this during the session/);
      assert.doesNotMatch(prompt, /ALICE_PRIVATE_TOKEN/);
    } finally {
      graph.close();
    }
  } finally {
    projectDb.close();
  }
});

test('session distillation runs focused skill pass when main distill emits no skills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-focused-skill-pass-'));
  const log = quietLog();
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, log);
  registry.init();

  const projectContext = {
    cwd: '/tmp/express-request-id',
    project: 'express-request-id',
    gitRemote: 'https://example.test/acme/express-request-id',
    source: 'spore-code',
  };
  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'mara',
      userName: 'Mara',
      projectContext,
    },
  });
  const projectDb = new DatabaseSync(registry.getDbPath(env.primarySlug));
  const kb = new DatabaseSync(registry.getDbPath(registry.getGeneralKnowledgeSlug()));
  const learner = {
    db: projectDb,
    _graphSlug: env.primarySlug,
    _graphRegistry: registry,
    getGraphDb(slug) {
      if (slug === registry.getGeneralKnowledgeSlug()) return kb;
      if (slug === env.primarySlug) return projectDb;
      return null;
    },
  };

  try {
    const sessionId = 'focused-skill-pass';
    const sessionNode = sessions.sessionNodeId(sessionId);
    sessions.upsertSessionNode(learner, {
      sessionId,
      userId: 'mara',
      userName: 'Mara',
      cwd: projectContext.cwd,
      project: projectContext.project,
      projectIdentityKey: env.projectKey,
      startedAt: '2026-05-07T10:00:00.000Z',
      model: 'test-model',
    });
    const summaryAspect = projectDb.prepare(`
      INSERT INTO aspects (node_id, name, weight, extracted_with)
      VALUES (?, 'summary', 8, 'test')
    `).run(sessionNode).lastInsertRowid;
    projectDb.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      VALUES (?, ?, 8, 'test', 'test')
    `).run(
      summaryAspect,
      'Implemented Express request ID middleware using node:crypto.randomUUID(), strict option validation, and Node http.validateHeaderName. Ran npm test after edits.',
    );
    const roundsAspect = projectDb.prepare(`
      INSERT INTO aspects (node_id, name, weight, extracted_with)
      VALUES (?, 'rounds', 8, 'test')
    `).run(sessionNode).lastInsertRowid;
    projectDb.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      VALUES (?, ?, 8, 'test', 'test')
    `).run(
      roundsAspect,
      'turn 1 | tools: read_file, edit_file, run_tests | files: lib/middleware/request-id.js, test/middleware.request-id.js | exec: npm test | reply: all tests pass',
    );

    const distill = await sessions.distillSession(learner, fakeSequentialDistillClient([
      { promote: [], createNodes: [], appendNotes: [] },
      {
        skills: [{
          slug: 'implement-express-request-id-middleware',
          title: 'Implement Express Request ID Middleware',
          tags: ['express', 'middleware', 'request-id'],
          summary: 'Add and verify Express middleware that propagates or generates request correlation IDs.',
          applicability: 'Use when an Express app needs request correlation IDs on req.id and response headers.',
          commands: ['npm test'],
          steps: [
            'Inspect the Express export facade and middleware test patterns.',
            'Implement middleware that reads X-Request-Id, trims it, generates a fallback ID, assigns req.id, and sets the response header.',
            'Validate configurable header and generator options at middleware creation time.',
          ],
          replay: ['const crypto = require("node:crypto");\nfunction requestId(options = {}) { /* read header, fallback to crypto.randomUUID(), set req.id */ }'],
          validation: ['npm test'],
          gotchas: ['Use http.validateHeaderName for header option strings.', 'Do not install uuid when node:crypto.randomUUID is available.'],
        }],
      },
    ]), { casualModel: 'test-model' }, sessionId, log);

    assert.equal(distill.error, undefined);
    assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'skill-implement-express-request-id-middleware'").get().type, 'skill');
    assert.ok(kb.prepare(`
      SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
      WHERE asp.node_id = 'skill-implement-express-request-id-middleware'
        AND asp.name = 'commands'
        AND a.content = 'npm test'
    `).get());
    assert.ok(kb.prepare(`
      SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
      WHERE asp.node_id = 'skill-implement-express-request-id-middleware'
        AND asp.name = 'replay'
        AND a.content LIKE 'const crypto%'
    `).get());
  } finally {
    projectDb.close();
    kb.close();
  }
});

test('project collaboration does not cross unrelated project identities', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-project-collab-isolation-'));
  const log = quietLog();
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, log);
  registry.init();

  const sharedEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'alice',
      userName: 'alice',
      projectContext: {
        cwd: '/Users/alice/dev/acorn-companion',
        project: 'acorn-companion',
        gitRemote: 'https://github.com/test-user/acorn-companion',
        source: 'spore-code',
      },
    },
  });
  const projectDb = new DatabaseSync(registry.getDbPath(sharedEnv.primarySlug));
  try {
    projectDb.prepare(`
      INSERT OR REPLACE INTO nodes (id, label, type, description, importance, provenance, extracted_with, extracted_at)
      VALUES ('frontend-api-endpoint-config', 'Frontend API endpoint config', 'concept', 'Project convention for API endpoint config.', 8, 'graphcorn-distill', 'test', ?)
    `).run(new Date().toISOString());
    const asp = projectDb.prepare(`
      INSERT INTO aspects (node_id, name, weight, extracted_with)
      VALUES ('frontend-api-endpoint-config', 'project_conventions', 8, 'test')
    `).run().lastInsertRowid;
    projectDb.prepare(`
      INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
      VALUES (?, 'CLIENT_PUBLIC_API_BASE_URL belongs only to the acorn-companion project graph.', 8, 'test', 'test')
    `).run(asp);
  } finally {
    projectDb.close();
  }

  const otherProject = {
    cwd: '/home/carol/src/other-app',
    project: 'other-app',
    gitRemote: 'https://github.com/test-user/other-app',
    source: 'spore-code',
  };
  const otherEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'carol',
      userName: 'carol',
      projectContext: otherProject,
    },
  });

  assert.notEqual(otherEnv.primarySlug, sharedEnv.primarySlug);
  assert.notEqual(otherEnv.projectKey, sharedEnv.projectKey);

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
  try {
    const prompt = await graph.buildSystemPromptAsync({
      promptMode: 'full',
      platform: 'cli',
      userRole: 'cli',
      userId: 'carol',
      userName: 'carol',
      messageContent: 'CLIENT_PUBLIC_API_BASE_URL',
      projectContext: otherProject,
      memoryEnvelope: otherEnv,
    });

    assert.match(prompt, /Project Memory/);
    assert.doesNotMatch(prompt, /frontend-api-endpoint-config/);
    assert.doesNotMatch(prompt, /CLIENT_PUBLIC_API_BASE_URL/);
  } finally {
    graph.close();
  }
});

test('cwd-only project identity reuses the same graph for the same machine and root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-project-cwd-scope-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, quietLog());
  registry.init();

  const aliceEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'alice',
      userName: 'alice',
      projectContext: { cwd: '/work/app', project: 'app', hostname: 'devbox', source: 'spore-code' },
    },
  });
  const bobEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'bob',
      userName: 'bob',
      projectContext: { cwd: '/work/app', project: 'app', hostname: 'devbox', source: 'spore-code' },
    },
  });

  assert.equal(aliceEnv.projectKey, bobEnv.projectKey);
  assert.equal(aliceEnv.primarySlug, bobEnv.primarySlug);
  assert.match(aliceEnv.projectKey, /^cwd:devbox:/);
  const graph = registry.get(aliceEnv.primarySlug);
  assert.deepEqual(graph.collaborators.sort(), ['alice', 'bob']);
});

test('project graph lookup reuses legacy user-scoped cwd graph by project root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-project-cwd-legacy-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, quietLog());
  registry.init();
  const legacySlug = registry.ensureProjectGraph('cwd:alice:devbox:/work/app', {
    name: 'app',
    userId: 'alice',
    projectKey: 'cwd:alice:devbox:/work/app',
    projectRoot: '/work/app',
  });

  const bobEnv = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'bob',
      userName: 'bob',
      projectContext: { cwd: '/work/app', project: 'app', hostname: 'devbox', source: 'spore-code' },
    },
  });

  assert.equal(bobEnv.primarySlug, legacySlug);
  assert.equal(registry.list().filter(g => g.role === 'project').length, 1);
  assert.equal(registry.get(legacySlug).identityKey, bobEnv.projectKey);
  assert.deepEqual(registry.get(legacySlug).collaborators.sort(), ['alice', 'bob']);
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
      userId: 'test-user',
      messageContent: 'read this codebase',
      projectContext: { cwd: '/repo/app', project: 'app' },
    },
  });

  assert.equal(env.mode, 'codebase-session');
  assert.deepEqual(env.readScopes.map(s => s.slug), ['project-test', 'spore-knowledge-base']);
  assert.equal(env.readScopes.some(s => s.slug === 'default'), false);
});

test('graph event scope carries originating session metadata', async () => {
  const events = [];
  const handler = evt => events.push(evt);
  graphEvents.on('change', handler);
  try {
    await graphEvents.withGraph({
      sessionKey: 'channel:cli:test-user@project',
      channelId: 'cli:test-user@project',
      platform: 'cli',
      userId: 'test-user',
      graphs: ['project-test', 'spore-knowledge-base'],
    }, async () => {
      graphEvents.emit('change', { op: 'recall:start', source: 'test', detail: 'project recall' });
    });
  } finally {
    graphEvents.off('change', handler);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].sessionKey, 'channel:cli:test-user@project');
  assert.equal(events[0].channelId, 'cli:test-user@project');
  assert.equal(events[0].platform, 'cli');
  assert.deepEqual(events[0].graphs, ['project-test', 'spore-knowledge-base']);
});

test('codebase-session prompt excludes default person graph context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-person-gate-'));
  const dbPath = path.join(dir, 'default.db');
  const db = newDb(dbPath);
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance)
    VALUES ('spore', 'Spore', 'self', 'Agent identity', 8)
  `).run();
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance)
    VALUES ('test-user', 'test-user', 'person', 'User requesting du scan monitoring', 5)
  `).run();
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance)
    VALUES ('du_scan_process', 'DU Scan Process', 'system_task', 'Disk usage scan being monitored on host_1778103972392', 5)
  `).run();
  db.prepare(`
    INSERT INTO edges (source, target, type, weight)
    VALUES ('test-user', 'du_scan_process', 'requested', 1.0)
  `).run();
  const asp = db.prepare(`
    INSERT INTO aspects (node_id, name, weight)
    VALUES ('du_scan_process', 'scan_config', 5)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance)
    VALUES (?, 'Output file: /tmp/home-du-results.txt', 5)
  `).run(asp);
  db.close();

  const graph = new GraphContext({
    graphDbPath: dbPath,
    sharedGraphsDir: dir,
    agentId: 'spore',
    enhancedRecall: false,
  }, { info() {}, warn() {}, error() {}, debug() {} });
  assert.equal(graph.init(), true);
  try {
    const prompt = graph.buildSystemPrompt({
      promptMode: 'full',
      platform: 'cli',
      userId: 'test-user',
      userName: 'test-user',
      messageContent: 'hello',
      projectContext: { cwd: '/repo/app', project: 'app' },
      memoryEnvelope: {
        mode: 'codebase-session',
        readScopes: [{ slug: 'project-test' }, { slug: 'spore-knowledge-base' }],
      },
      _skipDefaultRecallSections: true,
    });

    assert.match(prompt, /Fresh Spore Code project session/);
    assert.doesNotMatch(prompt, /DU Scan/i);
    assert.doesNotMatch(prompt, /host_1778103972392/);
    assert.doesNotMatch(prompt, /home-du-results/);
  } finally {
    graph.close();
  }
});

test('cli project sessions never route to web user graphs', () => {
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
      this._graphs['project-flaggy'] = { slug: 'project-flaggy', role: 'project', name: meta.name, identityKey };
      return 'project-flaggy';
    },
    ensureUserGraph() {
      throw new Error('CLI project sessions must not create or select web user graphs');
    },
  };

  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'flaggy',
      userName: 'flaggy',
      messageContent: 'read this codebase',
      projectContext: { cwd: '/repo/app', project: 'app' },
    },
  });

  assert.equal(env.mode, 'codebase-session');
  assert.equal(env.primarySlug, 'project-flaggy');
  assert.equal(env.writeScopes.defaultSlug, 'project-flaggy');
  assert.equal(env.writeScopes.projectSlug, 'project-flaggy');
  assert.equal(env.writeScopes.userSlug, null);
  assert.deepEqual(env.readScopes.map(s => s.slug), ['project-flaggy', 'spore-knowledge-base']);
});

test('codebase-session scoped recall includes general kb provenance nodes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-kb-recall-'));
  const dbPath = path.join(dir, 'spore-knowledge-base.db');
  const db = newDb(dbPath);
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'skill-terminal-qr-rendering',
    'Terminal QR rendering',
    'skill',
    'Reusable QR code rendering workflow for chat and terminal interfaces.',
    8,
    'general-kb',
    'session-distill',
  );
  const aspect = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('skill-terminal-qr-rendering', 'gotchas', 8, 'session-distill').lastInsertRowid;
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
  const commands = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('skill-terminal-qr-rendering', 'commands', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    commands,
    'node qr-gen.js exp://<LAN_IP>:8081',
    9,
    'session-distill',
    'session-distill',
  );
  const steps = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('skill-terminal-qr-rendering', 'steps', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    steps,
    'Render the exact exp:// LAN URL as a dense terminal QR before trying image-only output.',
    9,
    'session-distill',
    'session-distill',
  );
  const validation = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('skill-terminal-qr-rendering', 'validation', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    validation,
    'The final response includes the exact exp:// LAN URL and a scannable QR block.',
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
  const events = [];
  const handler = evt => events.push(evt);
  graphEvents.on('change', handler);
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

    assert.ok(events.some(e => e.op === 'recall:start' && e.source === 'scoped-recall'));
    assert.match(bundle, /Reusable Skill Execution Contract/);
    assert.match(bundle, /playbook, not background trivia/);
    assert.match(bundle, /Before the first mutating command/);
    assert.match(bundle, /avoid task bookkeeping/);
    assert.match(bundle, /High-Signal Reusable Knowledge/);
    assert.match(bundle, /Reusable Engineering Memory/);
    assert.match(bundle, /Terminal QR rendering/);
    assert.match(bundle, /Default workflow/);
    assert.match(bundle, /Commands to reuse/);
    assert.match(bundle, /Validation/);
    assert.match(bundle, /shared reusable item you used/);
    assert.match(bundle, /node qr-gen\.js/);
    assert.match(bundle, /dense full-block output/);
  } finally {
    graphEvents.off('change', handler);
    graph.db?.close();
  }
});

test('codebase-session scoped recall promotes reusable library nodes as playbooks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-kb-library-recall-'));
  const dbPath = path.join(dir, 'spore-knowledge-base.db');
  const db = newDb(dbPath);
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'qrcode-npm',
    'qrcode',
    'library',
    'Node.js library for generating QR codes in terminal, SVG, and other formats.',
    8,
    'general-kb',
    'session-distill',
  );
  const summary = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('qrcode-npm', 'summary', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    summary,
    "npm package 'qrcode'; supports QRCode.toString(url, {type:'terminal', small:true}, callback) for terminal output.",
    9,
    'session-distill',
    'session-distill',
  );
  const applicability = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('qrcode-npm', 'applicability', 7, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    applicability,
    'Reusable when a project needs terminal-visible QR output and ANSI rendering may not display correctly.',
    8,
    'session-distill',
    'session-distill',
  );
  const lessons = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES (?, ?, ?, ?)
  `).run('qrcode-npm', 'reusable_lessons', 8, 'session-distill').lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    lessons,
    'If terminal ANSI output is not rendering, use QRCode.create() and print a plain block-character QR instead of rediscovering a custom renderer from scratch.',
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
  }, quietLog());
  assert.equal(graph.init(), true);
  try {
    const bundle = await graph._buildScopedRecallBundle({
      messageContent: 'start expo and print a qrcode in the terminal without ansi',
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

    assert.match(bundle, /Reusable Skill Execution Contract/);
    assert.match(bundle, /top applicable item/);
    assert.match(bundle, /High-Signal Reusable Knowledge/);
    assert.match(bundle, /qrcode-npm library/);
    assert.match(bundle, /Usage notes/);
    assert.match(bundle, /Reusable lessons/);
    assert.match(bundle, /QRCode\.toString/);
    assert.match(bundle, /QRCode\.create\(\)/);
    assert.match(bundle, /instead of rediscovering/);
  } finally {
    graph.db?.close();
  }
});

test('scoped reusable contract ranks query-matched QR knowledge above generic fallback skills', () => {
  const graph = new GraphContext({
    graphDbPath: ':memory:',
    agentId: 'spore',
    enhancedRecall: false,
  }, quietLog());

  const bundle = graph._buildScopedSkillBrief([
    {
      id: 'skill-start-expo-dev-server-with-tunnel-fallback',
      label: 'Start Expo Dev Server with Tunnel Fallback',
      type: 'skill',
      description: 'Start an Expo dev server, falling back to --tunnel if standard start fails.',
      importance: 7,
      _hybridScore: 0.9,
      aspects: [
        { name: 'commands', attributes: [{ content: 'npx expo start --tunnel' }] },
        { name: 'steps', attributes: [
          { content: 'Try `npx expo start` first.' },
          { content: 'If it fails with network binding errors, re-run with `npx expo start --tunnel`.' },
        ] },
        { name: 'validation', attributes: [{ content: 'curl -s http://localhost:8081/status' }] },
      ],
    },
    {
      id: 'qrcode-npm',
      label: 'qrcode',
      type: 'library',
      description: 'Node.js library for generating QR codes in terminal, SVG, and other formats.',
      importance: 6,
      _hybridScore: 0.8,
      aspects: [
        { name: 'summary', attributes: [{ content: "QRCode.toString(url, {type:'terminal', small:true}, callback) for terminal output." }] },
        { name: 'reusable_lessons', attributes: [{ content: 'Use QRCode.create() and plain block characters when ANSI terminal output does not render.' }] },
      ],
    },
  ], 'start the expo server and print me the qr code');

  assert.match(bundle, /If the user asks for multiple deliverables/);
  assert.match(bundle, /fallback commands only after their stated precondition/);
  assert.match(bundle, /prefer the project's ordinary local development endpoint/);
  assert.ok(bundle.indexOf('qrcode-npm library') < bundle.indexOf('skill-start-expo-dev-server-with-tunnel-fallback skill'));
  assert.match(bundle, /QRCode\.create\(\)/);
});

test('cli codebase prompts hide saved SSH and cluster access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-cli-remote-gate-'));
  const store = path.join(dir, 'ssh-hosts.json');
  const dbPath = path.join(dir, 'graph.db');
  const db = newDb(dbPath);
  db.exec(`
    CREATE TABLE gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance)
    VALUES ('remote-gpu-cluster', 'Remote GPU Cluster', 'system', 'Remote compute cluster accessible via SSH', 5)
  `).run();
  db.prepare(`
    INSERT INTO gaps (node_id, content, status)
    VALUES ('remote-gpu-cluster', 'Are SSH keys configured for gpu-login-1?', 'open')
  `).run();
  db.close();
  fs.writeFileSync(store, JSON.stringify({
    hosts: [{
      id: 'host_remote-gpu',
      name: 'gpu-login-1',
      hostname: 'gpu-login-1',
      username: 'test-user',
    }],
  }));
  const graph = new GraphContext({
    graphDbPath: dbPath,
    dataDir: dir,
    sshSidecarStore: store,
    agentId: 'spore',
    sharedGraphsDir: path.join(dir, 'shared-graphs'),
    model: 'test',
  }, { info() {}, warn() {}, error() {}, debug() {} });
  assert.equal(graph.init(), true);

  const webSection = graph._buildClusterAccessSection({ platform: 'web' });
  assert.match(webSection, /gpu-login-1/);

  const cliSection = graph._buildClusterAccessSection({
    platform: 'cli',
    projectContext: { cwd: '/repo/app' },
    memoryEnvelope: { mode: 'codebase-session', source: 'spore-code' },
  });
  assert.equal(cliSection, null);

  const dynamic = graph.buildDynamicContext({
    promptMode: 'minimal',
    platform: 'cli',
    projectContext: { cwd: '/repo/app' },
    memoryEnvelope: { mode: 'codebase-session', source: 'spore-code' },
  });
  assert.doesNotMatch(dynamic, /Cluster access/);
  assert.doesNotMatch(dynamic, /gpu-login-1/);

  const prompt = graph.buildSystemPrompt({
    promptMode: 'full',
    platform: 'cli',
    userId: 'test-user',
    messageContent: 'what can you do?',
    projectContext: { cwd: '/repo/app' },
    memoryEnvelope: { mode: 'codebase-session', source: 'spore-code', readScopes: [{ slug: 'project-test' }] },
    _skipDefaultRecallSections: true,
  });
  assert.doesNotMatch(prompt, /remote-gpu/i);

  graph._pluginManager = {
    getLifecycleHooks(name) {
      return name === 'shouldSkipRecall' ? [() => true] : [];
    },
    getContextEngines() { return []; },
    getPromptSections() { return []; },
  };
  const skippedPrompt = await graph.buildSystemPromptAsync({
    promptMode: 'full',
    platform: 'cli',
    userId: 'test-user',
    messageContent: 'what can you do?',
    projectContext: { cwd: '/repo/app' },
    memoryEnvelope: { mode: 'codebase-session', source: 'spore-code', readScopes: [{ slug: 'project-test' }] },
  });
  assert.doesNotMatch(skippedPrompt, /remote-gpu/i);
  graph.close();
});

test('generic cli capability questions are recall-skip candidates', () => {
  assert.equal(heuristics.looksLikeCapabilityQuestion('what can you do?'), true);
  assert.equal(heuristics.looksLikeCapabilityQuestion('tell me what tools you have'), true);
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
  const projectIdentityKey = 'git:https://github.com/test-user/spore-core';

  const first = projects.upsertProject(learner, 'test-user', {
    cwd: '/home/test-user/spore-core',
    project: 'spore-core',
    projectIdentityKey,
  });
  const second = projects.upsertProject(learner, 'test-user', {
    cwd: '/tmp/other-clone',
    project: 'spore-core',
    projectIdentityKey,
  });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^project-[0-9a-f]{12}$/);
  const projectExtra = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(first.id)?.extra || '{}';
  assert.equal(JSON.parse(projectExtra).ttl, undefined);

  const r = projects.upsertProjectCodeGraph(learner, 'test-user', '/tmp/other-clone', {
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
  const projectIdentityKey = 'git:https://github.com/test-user/scoped-project';
  const projectId = projects.projectNodeIdFromContext('test-user', {
    cwd: '/repo/a',
    projectIdentityKey,
  });
  projects.upsertProject({ db: scopedDb }, 'test-user', {
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
    userId: 'test-user',
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

  const slug = registry.ensureProjectGraph('git:https://github.com/test-user/acorn-companion', {
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

  const slug = registry.ensureProjectGraph('git:https://github.com/test-user/acorn-companion', {
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
  const key = 'git:https://github.com/test-user/recreated-project';
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

test('learner routes explicit local writes to the scoped project graph', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-learner-scoped-local-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, quietLog());
  registry.init();

  const projectContext = {
    cwd: '/work/express-request-id',
    project: 'express-request-id',
    gitRemote: 'https://github.com/example/express-request-id',
    source: 'spore-code',
  };
  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'mara',
      userName: 'Mara',
      projectContext,
    },
  });

  const learner = new Learner({ agentId: 'spore' }, quietLog(), null);
  learner.db = new DatabaseSync(registry.getDbPath(registry.getMainSlug()));
  learner._graphRegistry = registry;

  try {
    const wrote = learner._writeToGraph({
      entities: [
        { id: 'mara', label: 'Mara', type: 'person', description: 'Developer working on the project', target: 'local' },
        { id: 'request-id-middleware', label: 'Request ID middleware', type: 'concept', description: 'Project middleware feature', target: 'local' },
      ],
      aspects: [{
        nodeId: 'request-id-middleware',
        name: 'implementation',
        attributes: ['The project middleware preserves incoming X-Request-Id values and generates one when absent.'],
        importance: 8,
        target: 'local',
      }],
      updates: [],
      edges: [{ source: 'mara', target: 'request-id-middleware', type: 'requested', confidence: 'extracted' }],
      gaps: [],
      hyperedges: [],
    }, {
      platform: 'cli',
      userRole: 'cli',
      userId: 'mara',
      userName: 'Mara',
      projectContext,
      memoryEnvelope: env,
    });

    const projectDb = learner.getGraphDb(env.primarySlug);
    assert.ok(wrote.writeTargets.some(t => t.slug === env.primarySlug && t.total > 0));
    assert.equal(learner.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id IN ('mara', 'request-id-middleware')").get().c, 0);
    assert.equal(projectDb.prepare("SELECT type FROM nodes WHERE id = 'mara'").get().type, 'person');
    assert.equal(projectDb.prepare("SELECT type FROM nodes WHERE id = 'request-id-middleware'").get().type, 'concept');
    assert.ok(projectDb.prepare(`
      SELECT 1 FROM attributes a
      JOIN aspects asp ON asp.id = a.aspect_id
      WHERE asp.node_id = 'request-id-middleware'
        AND asp.name = 'implementation'
        AND a.content LIKE '%X-Request-Id%'
    `).get());
    assert.ok(projectDb.prepare(`
      SELECT 1 FROM edges
      WHERE source = 'mara' AND target = 'request-id-middleware' AND type = 'requested'
    `).get());
  } finally {
    learner.close();
  }
});

test('learner drops stale scoped writes when the project graph was deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-learner-stale-project-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, quietLog());
  registry.init();

  const projectContext = {
    cwd: '/work/acorn-companion',
    project: 'acorn-companion',
    gitRemote: 'https://github.com/example/acorn-companion',
    source: 'spore-code',
  };
  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'test-user',
      userName: 'test-user',
      projectContext,
    },
  });

  const learner = new Learner({ agentId: 'spore' }, quietLog(), null);
  learner.db = new DatabaseSync(registry.getDbPath(registry.getMainSlug()));
  learner._graphRegistry = registry;

  try {
    registry.delete(env.primarySlug);

    const wrote = learner._writeToGraph({
      entities: [
        { id: 'test-user', label: 'test-user', type: 'person', description: 'Project user', target: 'local' },
        { id: 'expo-dev-server', label: 'Expo Dev Server', type: 'system', description: 'Project-only server state', target: 'local' },
      ],
      aspects: [{
        nodeId: 'expo-dev-server',
        name: 'server_status',
        attributes: ['Expo Metro was running on localhost:8081 for this deleted project graph.'],
        importance: 6,
        target: 'local',
      }],
      updates: [],
      edges: [{ source: 'test-user', target: 'expo-dev-server', type: 'used', confidence: 'extracted' }],
      gaps: [],
      hyperedges: [],
    }, {
      platform: 'cli',
      userRole: 'cli',
      userId: 'test-user',
      userName: 'test-user',
      projectContext,
      memoryEnvelope: env,
    });

    assert.equal(wrote.total, 0);
    assert.ok(wrote.writeTargets.some(t => t.slug === env.primarySlug && t.skipped && t.reason === 'missing_graph'));
    assert.equal(learner.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id IN ('test-user', 'expo-dev-server')").get().c, 0);
    assert.equal(learner.db.prepare("SELECT COUNT(*) AS c FROM attributes WHERE content LIKE '%Expo Metro was running%'").get().c, 0);
    assert.equal(learner.getGraphDb(env.primarySlug), null);
  } finally {
    learner.close();
  }
});

test('learner suppresses synthetic benchmark speaker person nodes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-learner-benchmark-speaker-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, quietLog());
  registry.init();

  const projectContext = {
    cwd: '/data/spore-code-benchmark/runs/scb-test/express-request-id',
    project: 'express-request-id',
    source: 'spore-code',
    benchmark: { runId: 'scb-test', scenarioId: 'express-request-id', taskId: 'initial-change' },
  };
  const env = resolveDefaultMemoryEnvelope({
    registry,
    opts: {
      platform: 'cli',
      userRole: 'cli',
      userId: 'Mara',
      userName: 'Mara',
      projectContext,
    },
  });

  const learner = new Learner({ agentId: 'spore' }, quietLog(), null);
  learner.db = new DatabaseSync(registry.getDbPath(registry.getMainSlug()));
  learner._graphRegistry = registry;

  try {
    learner._writeToGraph({
      entities: [
        { id: 'mara', label: 'Mara', type: 'person', description: 'Synthetic benchmark actor', target: 'local' },
        { id: 'request-id-middleware', label: 'Request ID middleware', type: 'concept', description: 'Project middleware feature', target: 'local' },
      ],
      aspects: [
        { nodeId: 'mara', name: 'work', attributes: ['Mara requested the benchmark task.'], importance: 6, target: 'local' },
        { nodeId: 'request-id-middleware', name: 'implementation', attributes: ['Request ID middleware was added for the repo.'], importance: 8, target: 'local' },
      ],
      updates: [],
      edges: [{ source: 'mara', target: 'request-id-middleware', type: 'requested', confidence: 'extracted' }],
      gaps: [],
      hyperedges: [],
    }, {
      platform: 'cli',
      userRole: 'cli',
      userId: 'Mara',
      userName: 'Mara',
      projectContext,
      memoryEnvelope: env,
    });

    const projectDb = learner.getGraphDb(env.primarySlug);
    assert.equal(learner.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'mara'").get().c, 0);
    assert.equal(projectDb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'mara'").get().c, 0);
    assert.equal(projectDb.prepare("SELECT type FROM nodes WHERE id = 'request-id-middleware'").get().type, 'concept');
    assert.equal(projectDb.prepare("SELECT COUNT(*) AS c FROM edges WHERE source = 'mara' OR target = 'mara'").get().c, 0);
  } finally {
    learner.close();
  }
});

test('graph registry protected delete requires explicit override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-graph-protected-delete-'));
  const registry = new GraphRegistry(dir, { agentId: 'spore', displayName: 'Spore' }, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  registry.init();
  const slug = registry.ensureSystemGraph({
    slug: 'temporary-system-graph',
    name: 'Temporary System Graph',
    role: 'system',
  });

  assert.throws(() => registry.delete(slug), /protected graph/);
  registry.delete(slug, { allowProtected: true });
  assert.equal(registry.get(slug), null);
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

  const result = sessions.promoteReusableKnowledge(learner, 'cli:test-user@project', {
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
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'inline-qr-chat-rendering'
      AND target = 'general-kb-distillation'
      AND type = 'distilled_into'
  `).get());
});

test('general kb promotion updates people and avoids orphan nodes', () => {
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

  kb.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES ('test-user', 'Test User', 'person', 'Person represented by sanitized shared knowledge.', 6, 'general-kb', 'test')
  `).run();

  const result = sessions.promoteReusableKnowledge(learner, 'cli:test-user@project', {
    people: [{
      nodeId: 'test-user',
      label: 'Test User',
      description: 'Maintainer of Spore Core',
      aspects: [{
        name: 'public_context',
        attributes: ['Test User maintains Spore Core integration work.'],
      }],
    }],
    createNodes: [{
      nodeId: 'person-ada-lovelace',
      label: 'Ada Lovelace',
      type: 'person',
      description: 'Mathematician and computing pioneer',
      aspects: [{
        name: 'public_context',
        attributes: ['Ada Lovelace is known for early computing work.'],
      }],
    }],
    appendNotes: [{
      targetNodeId: 'person-private',
      targetType: 'person',
      label: '@privatehandle',
      aspect: 'private_context',
      content: 'private@example.com should not be promoted.',
    }],
  }, { projectId: 'project-spore-core' });

  assert.equal(result.promoted, 2);
  assert.equal(kb.prepare("SELECT description FROM nodes WHERE id = 'test-user'").get().description, 'Maintainer of Spore Core');
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'person-ada-lovelace'").get().type, 'person');
  assert.equal(kb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'person-private'").get().c, 0);
  for (const id of ['test-user', 'person-ada-lovelace']) {
    assert.ok(kb.prepare(`
      SELECT 1 FROM edges
      WHERE source = ? AND target = 'general-kb-distillation' AND type = 'distilled_into'
    `).get(id));
    assert.ok(kb.prepare(`
      SELECT 1 FROM edges
      WHERE source = ? AND target = 'general-kb-people' AND type = 'member_of'
    `).get(id));
  }
});

test('general kb repair links legacy promoted nodes from session and channel distill', () => {
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

  kb.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES ('legacy-session-lesson', 'Legacy Session Lesson', 'concept', 'Reusable knowledge distilled from a session.', 6, 'general-kb', 'session-distill')
  `).run();
  kb.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES ('person-test-user', 'Test User', 'person', 'Maintainer of Spore Core', 6, 'general-kb', 'channel-distill')
  `).run();

  const result = sessions.repairGeneralKnowledgeBase(learner, quietLog());

  assert.equal(result.removed, 0);
  assert.ok(result.repaired >= 2);
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'legacy-session-lesson'
      AND target = 'general-kb-distillation'
      AND type = 'distilled_into'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'person-test-user'
      AND target = 'general-kb-people'
      AND type = 'member_of'
  `).get());
});

test('project distillation yields reusable skills into linked general kb skill nodes', () => {
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

  const result = sessions.promoteReusableKnowledge(learner, 'cli:test-user@project', {
    skills: [{
      slug: 'start-expo-dev-server',
      title: 'Start Expo Dev Server',
      tags: ['expo', 'networking'],
      summary: 'Start and verify an Expo dev server across local and device paths.',
      applicability: 'Use when an Expo project needs a local dev server.',
      prerequisites: ['Run from the Expo project root after installing dependencies.'],
      commands: ['npx expo start --port 8081'],
      steps: [
        'Check the Expo package scripts and config.',
        'Start the dev server on an explicit port.',
        'Verify the local server responds before reporting readiness.',
      ],
      replay: ['spawn("npx", ["expo", "start", "--port", "8081"], { stdio: "inherit" })'],
      validation: ['curl -I http://localhost:8081'],
      gotchas: ['Do not preserve private LAN IPs or project paths in reusable skill text.'],
    }],
  }, { projectId: 'project-spore-core' });

  assert.equal(result.promoted, 1);
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'skill-start-expo-dev-server'").get().type, 'skill');
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'skill-start-expo-dev-server'
      AND target = 'general-kb-skills'
      AND type = 'member_of'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'skill-start-expo-dev-server'
      AND target = 'general-kb-distillation'
      AND type = 'distilled_into'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'skill-start-expo-dev-server'
      AND asp.name = 'steps'
      AND a.content LIKE 'Start the dev server%'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'skill-start-expo-dev-server'
      AND asp.name = 'commands'
      AND a.content LIKE 'npx expo start%'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'skill-start-expo-dev-server'
      AND asp.name = 'replay'
      AND a.content LIKE 'spawn%'
  `).get());
  assert.equal(kb.prepare(`
    SELECT COUNT(*) AS c FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'skill-start-expo-dev-server'
      AND asp.name = 'skill_lookup'
  `).get().c, 0);
});

test('project distillation rejects thin task-shaped skills without replay artifacts', () => {
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

  const result = sessions.promoteReusableKnowledge(learner, 'cli:test-user@project', {
    skills: [{
      slug: 'add-cli-typo-suggestions',
      title: 'Add CLI Typo Suggestions',
      summary: "Implement 'Did you mean' hints for mistyped CLI options using fuzzy string matching.",
      steps: ['Add fuzzy matching to the CLI option parser.'],
      gotchas: ['Keep suggestions concise.'],
    }],
  }, { projectId: 'project-spore-core' });

  assert.equal(result.promoted, 0);
  assert.equal(kb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'skill-add-cli-typo-suggestions'").get().c, 0);
});

test('general kb repair removes existing non-replayable distilled skill nodes', () => {
  const kb = newDb();
  kb.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with, extra)
    VALUES ('skill-add-cli-typo-suggestions', 'Add CLI Typo Suggestions', 'skill', 'Implement Did you mean hints for mistyped CLI options using fuzzy string matching.', 7, 'general-kb', 'session-distill', '{"sharedSkill":true}')
  `).run();
  const asp = kb.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES ('skill-add-cli-typo-suggestions', 'steps', 7, 'session-distill')
  `).run().lastInsertRowid;
  kb.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, 'Add fuzzy matching to the CLI option parser.', 7, 'test', 'session-distill')
  `).run(asp);

  const learner = {
    _graphRegistry: {
      getGeneralKnowledgeSlug: () => 'spore-knowledge-base',
      refreshStats() {},
    },
    getGraphDb(slug) {
      return slug === 'spore-knowledge-base' ? kb : null;
    },
  };

  const result = sessions.repairGeneralKnowledgeBase(learner, quietLog());

  assert.equal(result.removed, 1);
  assert.equal(kb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'skill-add-cli-typo-suggestions'").get().c, 0);
});

test('general kb repair yields existing scoped project people into linked general kb people nodes', () => {
  const kb = newDb();
  const project = newDb();
  project.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES ('mara', 'Mara', 'person', 'Team member requesting Gin middleware implementation', 7, 'project', 'learner')
  `).run();
  const asp = project.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES ('mara', 'team_context', 7, 'learner')
  `).run().lastInsertRowid;
  project.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, 'Mara collaborates on Go middleware implementation work.', 7, 'test', 'learner')
  `).run(asp);

  const learner = {
    _graphRegistry: {
      getGeneralKnowledgeSlug: () => 'spore-knowledge-base',
      list() {
        return [{ slug: 'project-gin', role: 'project' }];
      },
      refreshStats() {},
    },
    getGraphDb(slug) {
      if (slug === 'spore-knowledge-base') return kb;
      if (slug === 'project-gin') return project;
      return null;
    },
  };

  const result = sessions.repairGeneralKnowledgeBase(learner, quietLog());

  assert.ok(result.repaired >= 1);
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'mara'").get().type, 'person');
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'mara' AND target = 'general-kb-people' AND type = 'member_of'
  `).get());
});

test('channel distiller promotes safe people into general kb and links yielded nodes', () => {
  const kb = newDb();
  const registry = {
    getGeneralKnowledgeSlug: () => 'spore-knowledge-base',
    get(slug) {
      return slug === 'user-test-user' ? { slug, role: 'user' } : null;
    },
    refreshStats() {},
  };
  const learner = {
    getGraphDb(slug) {
      return slug === 'spore-knowledge-base' ? kb : null;
    },
  };
  const distiller = new ChannelDistiller({}, quietLog(), null, learner, registry);

  const promoted = distiller._promoteReusable({
    createNodes: [{
      nodeId: 'spore-code',
      label: 'Spore Code',
      type: 'tool',
      description: 'CLI coding agent interface',
      aspects: [{
        name: 'gotchas',
        attributes: ['Spore Code should batch pasted text before submitting chat messages.'],
      }],
    }],
    people: [{
      nodeId: 'person-test-user',
      label: 'Test User',
      description: 'Maintainer of Spore Core',
      aspects: [{
        name: 'public_context',
        attributes: ['Test User maintains Spore Core integration work.'],
      }],
    }],
    skills: [{
      slug: 'debug-webhook-delivery',
      title: 'Debug Webhook Delivery',
      tags: ['webhooks'],
      summary: 'Diagnose webhook delivery failures without preserving private endpoint details.',
      applicability: 'Use when webhook callbacks are missing or failing.',
      commands: ['curl -i <callback-url-health-endpoint>'],
      steps: [
        'Verify the provider accepted the callback URL.',
        'Check recent delivery attempts and HTTP status codes.',
      ],
      replay: ['Resend one sanitized failed event from the provider delivery log.'],
      validation: ['Confirm a 2xx delivery and a matching server request log.'],
      gotchas: ['Do not save private callback URLs, chat IDs, user IDs, or tokens.'],
    }],
    appendNotes: [{
      targetNodeId: 'person-secret',
      targetType: 'person',
      label: '@privatehandle',
      aspect: 'private_context',
      content: 'private@example.com should not be promoted.',
    }],
  }, 'user-test-user');

  assert.equal(promoted, 3);
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'spore-code'").get().type, 'tool');
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'person-test-user'").get().type, 'person');
  assert.equal(kb.prepare("SELECT type FROM nodes WHERE id = 'skill-debug-webhook-delivery'").get().type, 'skill');
  assert.equal(kb.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id = 'person-secret'").get().c, 0);
  for (const id of ['spore-code', 'person-test-user', 'skill-debug-webhook-delivery']) {
    assert.ok(kb.prepare(`
      SELECT 1 FROM edges
      WHERE source = ? AND target = 'general-kb-distillation' AND type = 'distilled_into'
    `).get(id));
  }
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'person-test-user' AND target = 'general-kb-people' AND type = 'member_of'
  `).get());
  assert.ok(kb.prepare(`
    SELECT 1 FROM edges
    WHERE source = 'skill-debug-webhook-delivery' AND target = 'general-kb-skills' AND type = 'member_of'
  `).get());
});

test('channel distiller digest includes safe people facts for general kb promotion', () => {
  const db = newDb();
  db.prepare(`
    INSERT INTO nodes (id, label, type, description, importance, provenance, extracted_with)
    VALUES ('person-test-user', 'Test User', 'person', 'Maintainer of Spore Core', 7, 'test', 'test')
  `).run();
  const asp = db.prepare(`
    INSERT INTO aspects (node_id, name, weight, extracted_with)
    VALUES ('person-test-user', 'public_context', 7, 'test')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, 'Test User maintains Spore Core integration work.', 7, 'test', 'test')
  `).run(asp);
  db.prepare(`
    INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
    VALUES (?, 'Contact Test User at private@example.com for private DM policy.', 7, 'test', 'test')
  `).run(asp);

  const distiller = new ChannelDistiller({}, quietLog(), null, {}, {});
  const digest = distiller._collectDigest(db, {});
  const person = digest.find(n => n.id === 'person-test-user');

  assert.ok(person);
  assert.equal(person.type, 'person');
  assert.deepEqual(person.aspects.public_context, ['Test User maintains Spore Core integration work.']);
  assert.doesNotMatch(JSON.stringify(person), /private@example/);
});
