'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchProxyRoute, createApiProxyHandler } = require('../../src/gateways/web/api-proxy');

test('matchProxyRoute handles exact, nested, and method restricted routes', () => {
  const config = {
    routes: {
      api: { target: 'https://example.test/base/', methods: ['GET'] },
      other: { target: 'https://other.test/' },
    },
  };
  assert.deepEqual(matchProxyRoute('api', config, { method: 'GET' }), { name: 'api', route: config.routes.api, remainder: '' });
  assert.deepEqual(matchProxyRoute('api/users', config, { method: 'GET' }), { name: 'api', route: config.routes.api, remainder: '/users' });
  assert.equal(matchProxyRoute('api/users', config, { method: 'POST' }), null);
  assert.equal(matchProxyRoute('unknown', config, { method: 'GET' }), null);
});

test('proxy forwards query params and vault headers without leaking secret', async () => {
  const calls = [];
  const handler = createApiProxyHandler({
    fetchVaultKey: async (key) => `secret-for-${key}`,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        status: 201,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
        arrayBuffer: async () => Buffer.from(JSON.stringify({ ok: true })),
      };
    },
  });
  const req = { method: 'POST', url: '/.api-proxy/api/users?x=1', headers: { 'content-type': 'application/json' }, body: '{"a":1}' };
  const chunks = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { chunks.push(chunk); },
  };
  await handler(req, res, {
    name: 'api',
    route: { target: 'https://example.test/base/', headers: { Authorization: '$VAULT:API_TOKEN' } },
    remainder: '/users',
  });
  assert.equal(res.status, 201);
  assert.equal(calls[0].url, 'https://example.test/users?x=1');
  assert.equal(calls[0].options.body, '{"a":1}');
  assert.equal(calls[0].options.headers.Authorization, 'secret-for-API_TOKEN');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.doesNotMatch(chunks.join(''), /secret-for-API_TOKEN/);
});

test('missing proxy target returns JSON error', async () => {
  const handler = createApiProxyHandler();
  const chunks = [];
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { chunks.push(chunk); },
  };
  await handler({ method: 'GET', url: '/.api-proxy/api' }, res, { name: 'api', route: {}, remainder: '' });
  assert.equal(res.status, 500);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.match(chunks.join(''), /no target URL/);
});
