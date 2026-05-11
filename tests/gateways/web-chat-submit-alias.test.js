'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../../src/gateways/web');

test('websocket chat submit accepts Spore Go code-session alias', () => {
  assert.equal(_test._isChatSubmitType('chat'), true);
  assert.equal(_test._isChatSubmitType('chat:message'), true);
  assert.equal(_test._isChatSubmitType('chat:history-request'), false);
  assert.equal(_test._isChatSubmitType('chat:stop'), false);
});

test('cli forwarded tool timer can pause for approval and restart after approval', () => {
  const ws = { _pendingTools: new Map() };
  const entry = {
    name: 'exec',
    timeoutMs: 60_000,
    reject() {},
    timeout: null,
    ackTimeout: setTimeout(() => {}, 10_000),
    executionStartDelay: setTimeout(() => {}, 10_000),
  };
  ws._pendingTools.set('tool-1', entry);

  assert.equal(_test._startCliPendingToolTimer(ws, 'tool-1', entry, 'ack'), true);
  assert.ok(entry.timeout);
  assert.ok(entry.startedAt);

  entry.awaitingApproval = true;
  _test._clearCliPendingToolTimers(entry);
  assert.equal(entry.timeout, null);
  assert.equal(entry.ackTimeout, null);
  assert.equal(entry.executionStartDelay, null);

  entry.awaitingApproval = false;
  assert.equal(_test._startCliPendingToolTimer(ws, 'tool-1', entry, 'approval'), true);
  assert.equal(entry.timeoutStartedReason, 'approval');
  assert.ok(entry.timeout);
  _test._clearCliPendingToolTimers(entry);
});
