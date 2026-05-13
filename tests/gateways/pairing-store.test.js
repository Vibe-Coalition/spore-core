'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PairingStore } = require('../../src/gateways/pairing');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spore-pairing-'));
}

function log() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

test('pairing approval can bind a Telegram id to a web user graph', () => {
  const dir = tmpDir();
  const store = new PairingStore(dir, log());
  store.init();

  const req = store.upsertRequest('telegram', '12345', { name: 'Pirate King', username: 'pirate' });
  const approved = store.approveCodeForChannel('telegram', req.code, {
    ownerUser: 'yam',
    ownerRole: 'webapp',
    userGraphSlug: 'user-yam',
    approvedBy: 'yam',
  });

  assert.equal(approved.id, '12345');
  assert.deepEqual(store.listApproved('telegram'), ['12345']);
  assert.equal(store.isApproved('telegram', '12345'), true);

  const binding = store.getBinding('telegram', '12345');
  assert.equal(binding.ownerUser, 'yam');
  assert.equal(binding.ownerRole, 'webapp');
  assert.equal(binding.userGraphSlug, 'user-yam');
  assert.equal(binding.meta.username, 'pirate');

  const mine = store.listApprovedRecords('telegram', { ownerUser: 'yam' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, '12345');
  assert.equal(store.listApprovedRecords('telegram', { ownerUser: 'someone-else' }).length, 0);
});

test('legacy approved Telegram ids remain approved without owner binding', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'pairing.json'), JSON.stringify({
    version: 1,
    pending: {},
    approved: { telegram: ['777'] },
  }));
  const store = new PairingStore(dir, log());
  store.init();

  assert.equal(store.isApproved('telegram', '777'), true);
  const binding = store.getBinding('telegram', '777');
  assert.equal(binding.legacy, true);
  assert.equal(binding.ownerUser, null);
});

test('revoking approved Telegram id also removes binding metadata', () => {
  const dir = tmpDir();
  const store = new PairingStore(dir, log());
  store.init();

  const req = store.upsertRequest('telegram', '12345');
  store.approveCodeForChannel('telegram', req.code, { ownerUser: 'yam' });
  assert.equal(store.getBinding('telegram', '12345').ownerUser, 'yam');

  assert.equal(store.revokeApproved('telegram', '12345'), true);
  assert.equal(store.isApproved('telegram', '12345'), false);
  assert.equal(store.getBinding('telegram', '12345'), null);
});
