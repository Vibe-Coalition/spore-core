'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { RuntimeJobQueue } = require('../../src/runtime');

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(fn, { timeout = 1000, step = 10 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(step);
  }
  assert.fail('timed out waiting for condition');
}

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-runtime-queue-'));
  const dbPath = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS wakeups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fired INTEGER NOT NULL DEFAULT 0,
      fired_at INTEGER,
      failed INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);
  return {
    dir,
    db,
    sessions: {
      db,
      constructor: {
        buildKey(channelId, isDm, userId) {
          return isDm && userId ? `dm:${userId}` : `channel:${channelId}`;
        },
      },
    },
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeQueue(sessions, deps = {}, config = {}) {
  const queue = new RuntimeJobQueue({
    runtimeQueueLaneLimits: {
      interactive: 2,
      channel: 1,
      deferred: 1,
      learner: 1,
      maintenance: 1,
      background: 1,
    },
    ...config,
  }, log, sessions, deps);
  queue.init();
  return queue;
}

test('serializes jobs that target the same session', async () => {
  const fixture = makeDb();
  const queue = makeQueue(fixture.sessions);
  const releaseFirst = deferred();
  const starts = [];

  queue.registerHandler('test.same-session', async (payload) => {
    starts.push(payload.name);
    if (payload.name === 'first') await releaseFirst.promise;
    return { ok: true, name: payload.name };
  }, { lane: 'interactive', priority: 100 });

  try {
    const first = queue.submitWorkerJob('test.same-session', { name: 'first' }, {
      lane: 'interactive',
      sessionKey: 'session:a',
    });
    await waitFor(() => starts.length === 1);

    const second = queue.submitWorkerJob('test.same-session', { name: 'second' }, {
      lane: 'interactive',
      sessionKey: 'session:a',
    });
    await delay(50);
    assert.deepEqual(starts, ['first']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(starts, ['first', 'second']);
  } finally {
    queue.stop();
    fixture.cleanup();
  }
});

test('runs different interactive sessions up to the lane limit', async () => {
  const fixture = makeDb();
  const queue = makeQueue(fixture.sessions);
  const release = deferred();
  const started = [];
  let running = 0;
  let maxRunning = 0;

  queue.registerHandler('test.concurrent', async (payload) => {
    started.push(payload.name);
    running++;
    maxRunning = Math.max(maxRunning, running);
    await release.promise;
    running--;
    return { ok: true };
  }, { lane: 'interactive', priority: 100 });

  try {
    const a = queue.submitWorkerJob('test.concurrent', { name: 'a' }, {
      lane: 'interactive',
      sessionKey: 'session:a',
    });
    const b = queue.submitWorkerJob('test.concurrent', { name: 'b' }, {
      lane: 'interactive',
      sessionKey: 'session:b',
    });

    await waitFor(() => started.length === 2);
    assert.equal(maxRunning, 2);

    release.resolve();
    await Promise.all([a, b]);
  } finally {
    queue.stop();
    fixture.cleanup();
  }
});

test('recovers queued persistent jobs after restart', async () => {
  const fixture = makeDb();
  const firstQueue = makeQueue(fixture.sessions);

  firstQueue.submitWorkerJob('test.persist', { value: 42 }, {
    id: 'persist-1',
    persistent: true,
    lane: 'background',
    priority: 10,
    runAt: Date.now() + 60_000,
  });
  firstQueue.stop();

  fixture.db.prepare('UPDATE runtime_jobs SET run_at=? WHERE id=?').run(Date.now(), 'persist-1');

  const secondQueue = makeQueue(fixture.sessions);
  let observed = null;
  secondQueue.registerHandler('test.persist', (payload) => {
    observed = payload.value;
    return { ok: true, value: payload.value };
  }, { lane: 'background', priority: 10 });

  try {
    await waitFor(() => observed === 42);
    const row = fixture.db.prepare('SELECT status, result FROM runtime_jobs WHERE id=?').get('persist-1');
    assert.equal(row.status, 'done');
    assert.match(row.result, /"ok":true/);
  } finally {
    secondQueue.stop();
    fixture.cleanup();
  }
});

test('recovers general KB research jobs through the coordinator handler', async () => {
  const fixture = makeDb();
  const firstQueue = makeQueue(fixture.sessions);

  firstQueue.submitWorkerJob('generalKbResearch.run', {
    slug: 'spore-knowledge-base',
    nodeIds: ['node-a'],
    agentOpts: { content: 'research node-a' },
  }, {
    id: 'kb-research-1',
    persistent: true,
    lane: 'background',
    priority: 10,
    runAt: Date.now() + 60_000,
  });
  firstQueue.stop();
  fixture.db.prepare('UPDATE runtime_jobs SET run_at=? WHERE id=?').run(Date.now(), 'kb-research-1');

  let observed = null;
  const secondQueue = makeQueue(fixture.sessions, {
    graphMaintenance: {
      runGeneralKbResearchJob(payload) {
        observed = payload;
        return { ok: true, nodes: payload.nodeIds };
      },
    },
  });

  try {
    await waitFor(() => observed?.slug === 'spore-knowledge-base');
    assert.deepEqual(observed.nodeIds, ['node-a']);
    const row = fixture.db.prepare('SELECT status, result FROM runtime_jobs WHERE id=?').get('kb-research-1');
    assert.equal(row.status, 'done');
    assert.match(row.result, /"ok":true/);
  } finally {
    secondQueue.stop();
    fixture.cleanup();
  }
});

test('background jobs can detect queued interactive work and yield cooperatively', async () => {
  const fixture = makeDb();
  const queue = makeQueue(fixture.sessions);
  const backgroundStarted = deferred();
  const interactiveSubmitted = deferred();
  let sawYieldSignal = false;

  queue.registerHandler('test.background', async (_payload, job) => {
    backgroundStarted.resolve();
    await interactiveSubmitted.promise;
    sawYieldSignal = queue.shouldYield(job);
    return { ok: true };
  }, { lane: 'background', priority: 10 });
  queue.registerHandler('test.interactive', () => ({ ok: true }), { lane: 'interactive', priority: 100 });

  try {
    const background = queue.submitWorkerJob('test.background', {}, {
      lane: 'background',
      sessionKey: 'session:shared',
    });
    await backgroundStarted.promise;

    const interactive = queue.submitWorkerJob('test.interactive', {}, {
      lane: 'interactive',
      sessionKey: 'session:shared',
    });
    interactiveSubmitted.resolve();

    await background;
    await interactive;
    assert.equal(sawYieldSignal, true);
  } finally {
    queue.stop();
    fixture.cleanup();
  }
});

test('persistent wakeup jobs mark wakeups fired and run the agent once', async () => {
  const fixture = makeDb();
  let calls = 0;
  const agent = {
    activeRuns: new Set(),
    async processMessage(opts) {
      calls++;
      return { text: `wakeup:${opts.content}`, iterations: 1 };
    },
  };
  const queue = makeQueue(fixture.sessions, { agent });
  const inserted = fixture.db.prepare('INSERT INTO wakeups (fired, failed) VALUES (0, 0)').run();
  const wakeupId = inserted.lastInsertRowid;

  try {
    const result = await queue.submitWorkerJob('wakeup.fire', {
      wakeupId,
      opts: {
        content: 'ping',
        channelId: 'wakeups',
        userId: 'tester',
        isDm: true,
        sessionKey: 'dm:tester',
      },
    }, {
      id: `wakeup-${wakeupId}`,
      persistent: true,
      awaitResult: true,
      lane: 'deferred',
      sessionKey: 'dm:tester',
    });

    assert.equal(result.text, 'wakeup:ping');
    assert.equal(calls, 1);
    const row = fixture.db.prepare('SELECT fired, failed, error FROM wakeups WHERE id=?').get(wakeupId);
    assert.equal(row.fired, 1);
    assert.equal(row.failed, 0);
    assert.equal(row.error, null);
  } finally {
    queue.stop();
    fixture.cleanup();
  }
});

test('wakeup jobs preserve cli route and project memory context', async () => {
  const fixture = makeDb();
  const events = [];
  let observedOpts = null;
  const tools = {
    _getSessionBroadcaster() {
      return (sessionKey, payload) => {
        events.push({ sessionKey, payload });
        return sessionKey === 'channel:cli:yam@project' ? 1 : 0;
      };
    },
    _sessionRouteKeys(opts) {
      return [opts.sessionKey];
    },
  };
  const agent = {
    activeRuns: new Set(),
    async processMessage(opts) {
      observedOpts = opts;
      opts.onTextDelta?.('wake ');
      opts.onToolUse?.('read_file');
      return { text: 'wake done', iterations: 1, usage: { input_tokens: 1, output_tokens: 2 } };
    },
  };
  const queue = makeQueue(fixture.sessions, { agent, tools });
  const inserted = fixture.db.prepare('INSERT INTO wakeups (fired, failed) VALUES (0, 0)').run();
  const wakeupId = inserted.lastInsertRowid;

  try {
    const result = await queue.submitWorkerJob('wakeup.fire', {
      wakeupId,
      opts: {
        content: 'ping project',
        channelId: 'cli:yam@project',
        userId: 'yam',
        platform: 'cli',
        isDm: false,
        sessionKey: 'channel:cli:yam@project',
        projectContext: { cwd: '/work/project', mode: 'execute' },
        memoryEnvelope: { primarySlug: 'project-yam', writeScopes: { defaultSlug: 'project-yam' } },
      },
    }, {
      id: `wakeup-${wakeupId}`,
      persistent: true,
      awaitResult: true,
      lane: 'deferred',
      sessionKey: 'channel:cli:yam@project',
      graph: 'project-yam',
    });

    assert.equal(result.text, 'wake done');
    assert.equal(observedOpts.projectContext.cwd, '/work/project');
    assert.equal(observedOpts.memoryEnvelope.primarySlug, 'project-yam');
    assert.deepEqual(events.map(e => e.payload.type), ['chat:start', 'chat:delta', 'chat:tool', 'chat:done']);
    assert.equal(events.every(e => e.sessionKey === 'channel:cli:yam@project'), true);
    assert.equal(events[0].payload.sessionId, 'cli:yam@project');
  } finally {
    queue.stop();
    fixture.cleanup();
  }
});
