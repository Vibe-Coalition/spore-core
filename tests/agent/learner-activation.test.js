'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop } = require('../../src/agent/loop');

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeLoop(config = {}) {
  const jobs = [];
  const loop = Object.create(AgentLoop.prototype);
  loop.config = {
    learningMode: 'always',
    learnerActivationMode: 'every_turn',
    learnerIdleDelaySeconds: 60,
    learnerBatchMinTurns: 1,
    learnerBatchMaxTurns: 6,
    learnerMinExchangeChars: 20,
    learnerEnabledPlatforms: ['web', 'cli', 'telegram', 'slack', 'discord', 'chatroom', 'api', 'unknown'],
    ...config,
  };
  loop.log = log;
  loop.learner = {
    extractAndLearn: async () => ({ ok: true }),
    extractBatchAndLearn: async () => ({ ok: true }),
  };
  loop.tools = {
    _jobQueue: {
      submitWorkerJob(kind, payload, meta) {
        jobs.push({ kind, payload, meta });
        return Promise.resolve({ ok: true });
      },
    },
  };
  loop._learnerBatches = new Map();
  return { loop, jobs };
}

function opts(overrides = {}) {
  return {
    content: 'please remember this useful conversation turn',
    platform: 'web',
    sessionKey: 'web:yam',
    channelId: 'web:yam',
    userId: 'user-yam',
    userName: 'yam',
    channelName: 'web',
    memoryEnvelope: { primarySlug: 'user-yam' },
    ...overrides,
  };
}

test('default learner activation submits one after-turn learner job', () => {
  const { loop, jobs } = makeLoop();
  loop._kickOffLearnerExtraction(opts(), 'done, I will remember the useful part', []);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'learner.extract');
  assert.equal(jobs[0].payload.userMessage, 'please remember this useful conversation turn');
  assert.equal(jobs[0].payload.assistantResponse, 'done, I will remember the useful part');
  assert.equal(jobs[0].payload.opts.platform, 'web');
  assert.equal(jobs[0].meta.sessionKey, 'web:yam');
  assert.equal(jobs[0].meta.graph, 'user-yam');
});

test('learning mode and platform allowlist gate after-turn extraction', () => {
  for (const learningMode of ['flush_only', 'disabled']) {
    const { loop, jobs } = makeLoop({ learningMode });
    loop._kickOffLearnerExtraction(opts(), 'this is long enough to learn from', []);
    assert.equal(jobs.length, 0, `${learningMode} should skip after-turn learner jobs`);
  }

  const { loop, jobs } = makeLoop({ learnerEnabledPlatforms: ['cli'] });
  loop._kickOffLearnerExtraction(opts({ platform: 'web' }), 'this is long enough to learn from', []);
  assert.equal(jobs.length, 0);

  loop._kickOffLearnerExtraction(opts({ platform: 'cli' }), 'this is long enough to learn from', []);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.opts.platform, 'cli');
});

test('minimum exchange size gates noisy learner jobs', () => {
  const { loop, jobs } = makeLoop({ learnerMinExchangeChars: 50 });
  loop._kickOffLearnerExtraction(opts({ content: 'hi' }), 'ok', []);
  assert.equal(jobs.length, 0);
});

test('idle batch mode flushes a scoped batch when it reaches max turns', () => {
  const { loop, jobs } = makeLoop({
    learnerActivationMode: 'idle_batch',
    learnerBatchMaxTurns: 2,
    learnerIdleDelaySeconds: 60,
  });

  loop._kickOffLearnerExtraction(opts({ content: 'first useful turn for the learner batch' }), 'first useful answer', []);
  assert.equal(jobs.length, 0);
  loop._kickOffLearnerExtraction(opts({ content: 'second useful turn for the learner batch' }), 'second useful answer', []);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.entries.length, 2);
  assert.equal(jobs[0].payload.entries[0].opts.platform, 'web');
  assert.equal(loop._learnerBatches.size, 0);
});

test('idle batch mode keeps graph/session scopes separate', () => {
  const { loop, jobs } = makeLoop({
    learnerActivationMode: 'idle_batch',
    learnerBatchMaxTurns: 10,
    learnerIdleDelaySeconds: 60,
  });

  loop._kickOffLearnerExtraction(opts({
    sessionKey: 'web:alice',
    channelId: 'web:alice',
    userId: 'alice',
    memoryEnvelope: { primarySlug: 'user-alice' },
  }), 'alice answer with enough detail', []);
  loop._kickOffLearnerExtraction(opts({
    sessionKey: 'cli:bob',
    channelId: 'cli:bob',
    userId: 'bob',
    platform: 'cli',
    memoryEnvelope: { primarySlug: 'project-bob' },
  }), 'bob answer with enough detail', []);

  assert.equal(jobs.length, 0);
  assert.equal(loop._learnerBatches.size, 2);

  for (const key of [...loop._learnerBatches.keys()]) loop._flushLearnerBatch(key, 'test');

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => job.meta.graph).sort(), ['project-bob', 'user-alice']);
  assert.deepEqual(jobs.map(job => job.payload.entries[0].opts.platform).sort(), ['cli', 'web']);
});
