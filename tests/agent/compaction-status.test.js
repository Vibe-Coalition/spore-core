'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentLoop } = require('../../src/agent/loop');

function logger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function makeMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i} ${'context '.repeat(30)}`,
  }));
}

test('compaction status includes context budget percentages', async () => {
  const events = [];
  const agent = new AgentLoop({}, logger(), null, null, null, {
    summarizeForCompaction: async () => 'compressed working state',
  });

  const compacted = await agent._compactHistory(
    'session:test',
    makeMessages(18),
    160,
    evt => events.push(evt),
    {
      systemTokens: 25,
      beforeMessageTokens: 475,
      limitTokens: 500,
      reason: 'complex',
    },
  );

  assert.ok(compacted.length < 18);

  const started = events.find(evt => evt.type === 'compaction-start');
  assert.ok(started, 'expected compaction-start status');
  assert.equal(started.reason, 'complex');
  assert.equal(started.beforeTokens, 500);
  assert.equal(started.limitTokens, 500);
  assert.equal(started.targetTokens, 185);
  assert.equal(started.usedPercent, 100);
  assert.equal(started.remainingPercent, 0);

  const done = events.find(evt => evt.type === 'compaction-done');
  assert.ok(done, 'expected compaction-done status');
  assert.equal(done.beforeTokens, 500);
  assert.equal(done.limitTokens, 500);
  assert.equal(done.targetTokens, 185);
  assert.equal(typeof done.afterTokens, 'number');
  assert.equal(typeof done.usedPercent, 'number');
  assert.equal(done.remainingPercent, 100 - done.usedPercent);
  assert.ok(done.remainingPercent >= 0 && done.remainingPercent <= 100);
});
