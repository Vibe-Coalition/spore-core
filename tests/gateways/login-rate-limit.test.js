'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoginRateLimiter } = require('../../src/gateways/web/login-rate-limit');

test('login limiter counts failed attempts only until the window expires', () => {
  let now = 1000;
  const limiter = createLoginRateLimiter({
    maxAttempts: 2,
    windowMs: 100,
    now: () => now,
  });

  assert.equal(limiter.isLimited('10.0.0.1'), false);
  assert.deepEqual(limiter.recordFailure('10.0.0.1'), {
    attempts: 1,
    limited: false,
    remaining: 1,
  });
  assert.equal(limiter.isLimited('10.0.0.1'), false);
  assert.deepEqual(limiter.recordFailure('10.0.0.1'), {
    attempts: 2,
    limited: true,
    remaining: 0,
  });
  assert.equal(limiter.isLimited('10.0.0.1'), true);

  now += 101;
  assert.equal(limiter.isLimited('10.0.0.1'), false);
});

test('successful auth can clear a locked login bucket immediately', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 2, windowMs: 60_000 });

  limiter.recordFailure('10.0.0.2');
  limiter.recordFailure('10.0.0.2');
  assert.equal(limiter.isLimited('10.0.0.2'), true);

  limiter.clear('10.0.0.2');
  assert.equal(limiter.isLimited('10.0.0.2'), false);
  assert.equal(limiter.retryAfterMs('10.0.0.2'), 0);
});

test('login limiter scopes attempts per normalized client key', () => {
  const limiter = createLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000 });

  limiter.recordFailure(' 10.0.0.3 ');
  assert.equal(limiter.isLimited('10.0.0.3'), true);
  assert.equal(limiter.isLimited('10.0.0.4'), false);
});
