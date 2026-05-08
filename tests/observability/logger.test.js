'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLogger, redactLogValue } = require('../../src/observability/logger');

test('logger redacts secrets in strings and objects while retaining ring entries', () => {
  const oldLog = console.log;
  console.log = () => {};
  let log;
  try {
    log = createLogger('debug');
    log.info('token=super-secret-value', { apiKey: 'abc123', nested: { password: 'p' } });
  } finally {
    console.log = oldLog;
  }

  assert.equal(log._ring.length, 1);
  assert.equal(log.recent().length, 1);
  assert.match(log._ring[0], /token=\[redacted\]/);
  assert.match(log._ring[0], /"apiKey":"\[redacted\]"/);
  assert.match(log._ring[0], /"password":"\[redacted\]"/);
});

test('logger keeps console severity routing', () => {
  const calls = [];
  const oldLog = console.log;
  const oldWarn = console.warn;
  const oldError = console.error;
  console.log = (...args) => calls.push(['log', args.join(' ')]);
  console.warn = (...args) => calls.push(['warn', args.join(' ')]);
  console.error = (...args) => calls.push(['error', args.join(' ')]);
  try {
    const log = createLogger('debug');
    log.debug('debug message');
    log.info('info message');
    log.warn('warn message');
    log.error('error message');
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
    console.error = oldError;
  }

  assert.deepEqual(calls.map(([level]) => level), ['log', 'log', 'warn', 'error']);
});

test('redactLogValue handles errors and OpenAI style secret values', () => {
  const err = new Error('apiKey=secret sk-12345678abcdefghijklmnopqrstuvwxyz');
  const redacted = redactLogValue(err);
  assert.equal(redacted.name, 'Error');
  assert.match(redacted.message, /apiKey=\[redacted\]/);
  assert.doesNotMatch(redacted.message, /abcdefghijklmnopqrstuvwxyz/);
});
