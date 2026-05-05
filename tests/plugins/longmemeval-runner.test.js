'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../../plugins/longmemeval/lib/runner');

function q(id, type, sessions) {
  return {
    question_id: id,
    question: `Question ${id}?`,
    question_type: type,
    haystack_session_ids: sessions,
    haystack_sessions: sessions.map(s => [{ role: 'user', content: `session ${s}` }]),
  };
}

test('focused LongMemEval selector caps questions and shared sessions', () => {
  const types = [
    'temporal-reasoning',
    'multi-session',
    'knowledge-update',
    'single-session-user',
    'single-session-assistant',
    'single-session-preference',
  ];
  const dataset = [];
  for (let s = 1; s <= 12; s++) {
    for (let i = 0; i < 8; i++) {
      dataset.push(q(`s${s}-q${i}`, types[i % types.length], [`s${s}`]));
    }
  }

  const selected = _test.selectFocusedQuestions(dataset, { maxQuestions: 50, maxSessions: 10 });

  assert.equal(selected.length, 50);
  assert.ok(_test.countUniqueQuestionSessions(selected) <= 10);
});

test('focused LongMemEval selector rejects questions that cannot fit session cap', () => {
  const dataset = [
    q('too-wide', 'multi-session', ['a', 'b', 'c']),
    q('ok-a', 'single-session-user', ['a']),
    q('ok-b', 'single-session-assistant', ['b']),
  ];

  const selected = _test.selectFocusedQuestions(dataset, { maxQuestions: 10, maxSessions: 2 });

  assert.deepEqual(selected.map(x => x.question_id), ['ok-a', 'ok-b']);
  assert.equal(_test.countUniqueQuestionSessions(selected), 2);
});
