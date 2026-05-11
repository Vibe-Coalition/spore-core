'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Learner } = require('../../src/workers/learner');

test('learner skips embedding fallback when graph schema has no embedding column', () => {
  const warnings = [];
  const learner = new Learner({}, {
    info() {},
    debug() {},
    error() {},
    warn(msg) { warnings.push(String(msg)); },
  }, null);
  learner.db = {
    prepare(sql) {
      if (/PRAGMA\s+table_info\(nodes\)/i.test(sql)) {
        return { all: () => [{ name: 'id' }, { name: 'label' }] };
      }
      throw new Error('no such column: embedding');
    },
  };

  assert.equal(learner._resolveByEmbeddingSimilarity('sample-node', 'Sample Node'), null);
  assert.deepEqual(warnings, []);
});
