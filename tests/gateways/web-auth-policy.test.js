'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebAuthPolicy } = require('../../src/gateways/web/auth-policy');

function req(headers = {}) {
  return { headers };
}

test('service key returns admin context and creator auth', () => {
  const sessions = new Map();
  const policy = createWebAuthPolicy({ managerKey: 'service-secret', sessions });
  const request = req({ 'x-service-key': 'service-secret' });
  assert.equal(policy.checkCreatorAuth(request), true);
  assert.deepEqual(policy.authContextFromReq(request), {
    type: 'admin',
    role: 'admin',
    user: 'service',
    username: 'service',
    creator: true,
    viaServiceKey: true,
  });
});

test('creator/admin sessions pass within ttl', () => {
  const sessions = new Map([['sid1', { user: 'test-user', type: 'creator', created: 1000 }]]);
  const policy = createWebAuthPolicy({ sessions, sessionTtl: 5000, deps: { now: () => 2000, loadWebappUsers: () => [] } });
  assert.equal(policy.checkCreatorAuth(req({ cookie: 'spore_session=sid1' })), true);
  assert.equal(policy.checkAuth(req({ cookie: 'spore_session=sid1' })), true);
  const ctx = policy.authContextFromReq(req({ cookie: 'spore_session=sid1' }));
  assert.equal(ctx.role, 'creator');
  assert.equal(ctx.sessionId, 'sid1');
});

test('SSO sessions without manager_session are rejected and removed', () => {
  const sessions = new Map([['sid1', { user: 'test-user', type: 'admin', viaSSO: true, created: 1000 }]]);
  const policy = createWebAuthPolicy({ sessions, sessionTtl: 5000, deps: { now: () => 2000 } });
  assert.equal(policy.checkCreatorAuth(req({ cookie: 'spore_session=sid1' })), false);
  assert.equal(sessions.has('sid1'), false);
});

test('basic auth accepts exact configured credentials', () => {
  const token = Buffer.from('admin:p:a:s:s').toString('base64');
  const policy = createWebAuthPolicy({ authUser: 'admin', authPass: 'p:a:s:s', sessions: new Map() });
  const request = req({ authorization: `Basic ${token}` });
  assert.equal(policy.checkCreatorAuth(request), true);
  assert.equal(policy.checkAuth(request), true);
  assert.equal(policy.authContextFromReq(request).viaBasic, true);
});

test('expired and webapp-role sessions fail creator gate', () => {
  const sessions = new Map([
    ['expired', { user: 'old', type: 'creator', created: 1000 }],
    ['webapp', { user: 'viewer', type: 'webapp', created: 4500 }],
  ]);
  const policy = createWebAuthPolicy({ sessions, sessionTtl: 1000, deps: { now: () => 5000, loadWebappUsers: () => [] } });
  assert.equal(policy.checkCreatorAuth(req({ cookie: 'spore_session=expired' })), false);
  assert.equal(policy.checkCreatorAuth(req({ cookie: 'spore_session=webapp' })), false);
  assert.equal(policy.checkAuth(req({ cookie: 'spore_session=webapp' })), true);
});
