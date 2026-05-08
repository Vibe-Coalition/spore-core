'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { matchProxyRoute, createApiProxyHandler } = require('../../src/gateways/web/api-proxy');

function responseRecorder() {
  const chunks = [];
  return {
    chunks,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

function headers(entries) {
  const lower = new Map(entries.map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    get(name) { return lower.get(String(name).toLowerCase()) || null; },
    *[Symbol.iterator]() {
      for (const entry of entries) yield entry;
    },
  };
}

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
        headers: headers([['content-type', 'application/json']]),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ ok: true })),
      };
    },
  });
  const req = { method: 'POST', url: '/.api-proxy/api/users?x=1', headers: { 'content-type': 'application/json' }, body: '{"a":1}' };
  const res = responseRecorder();
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
  assert.doesNotMatch(res.text(), /secret-for-API_TOKEN/);
});

test('proxy preserves embedded vault/env headers, selected incoming headers, timeout, and CORS', async () => {
  const oldEnv = process.env.SPORE_PROXY_TEST_KEY;
  process.env.SPORE_PROXY_TEST_KEY = 'env-secret';
  try {
    const calls = [];
    const handler = createApiProxyHandler({
      fetchVaultKey: async (key) => `secret-for-${key}`,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return {
          status: 202,
          headers: headers([
            ['content-type', 'application/json'],
            ['x-upstream', 'kept'],
            ['access-control-allow-origin', 'https://upstream.example'],
          ]),
          arrayBuffer: async () => Buffer.from('{"ok":true}'),
        };
      },
    });
    const req = {
      method: 'POST',
      url: '/api/proxy/openai/chat?model=x',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'br',
        'content-type': 'application/json',
        authorization: 'do-not-forward',
      },
      body: '{}',
    };
    const res = responseRecorder();
    await handler(req, res, {
      name: 'openai',
      route: {
        target: 'https://api.example.test/v1/',
        timeout: 1234,
        headers: {
          Authorization: 'Bearer $VAULT:OPENAI_API_KEY',
          'X-Env': '$SPORE_PROXY_TEST_KEY',
        },
      },
      remainder: '/chat',
    }, 'openai/chat');

    assert.equal(calls[0].url, 'https://api.example.test/chat?model=x');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-for-OPENAI_API_KEY');
    assert.equal(calls[0].options.headers['X-Env'], 'env-secret');
    assert.equal(calls[0].options.headers.accept, 'application/json');
    assert.equal(calls[0].options.headers['accept-encoding'], 'br');
    assert.equal(calls[0].options.headers.authorization, undefined);
    assert.equal(calls[0].options.signal?.constructor?.name, 'AbortSignal');
    assert.equal(res.status, 202);
    assert.equal(res.headers['x-upstream'], 'kept');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.text(), '{"ok":true}');
  } finally {
    if (oldEnv == null) delete process.env.SPORE_PROXY_TEST_KEY;
    else process.env.SPORE_PROXY_TEST_KEY = oldEnv;
  }
});

test('proxy rejects missing vault/env credentials before fetch', async () => {
  let fetched = false;
  const handler = createApiProxyHandler({
    fetchVaultKey: async () => null,
    log: { warn() {} },
    fetchImpl: async () => {
      fetched = true;
      throw new Error('should not fetch');
    },
  });
  const res = responseRecorder();
  await handler({ method: 'GET', url: '/api/proxy/openai/chat', headers: {} }, res, {
    name: 'openai',
    route: { target: 'https://api.example.test/v1/', headers: { Authorization: 'Bearer $VAULT:MISSING_KEY' } },
    remainder: '/chat',
  }, 'openai/chat');

  assert.equal(fetched, false);
  assert.equal(res.status, 500);
  assert.match(res.text(), /Required vault key not found/);
});

test('proxy streams upstream response bodies', async () => {
  const handler = createApiProxyHandler({
    fetchImpl: async () => ({
      status: 200,
      headers: headers([['content-type', 'text/plain']]),
      body: Readable.toWeb(Readable.from(['one', 'two'])),
    }),
  });
  const res = responseRecorder();
  await handler({ method: 'GET', url: '/api/proxy/api/stream', headers: {} }, res, {
    name: 'api',
    route: { target: 'https://example.test/' },
    remainder: '/stream',
  }, 'api/stream');

  assert.equal(res.status, 200);
  assert.equal(res.text(), 'onetwo');
});

test('proxy enforces request body limit', async () => {
  let fetched = false;
  const handler = createApiProxyHandler({
    log: { warn() {} },
    fetchImpl: async () => {
      fetched = true;
      return { status: 200, headers: headers([]), arrayBuffer: async () => Buffer.from('') };
    },
  });
  const res = responseRecorder();
  await handler({ method: 'POST', url: '/api/proxy/api/upload', headers: {}, body: '12345' }, res, {
    name: 'api',
    route: { target: 'https://example.test/', maxBodyBytes: 4 },
    remainder: '/upload',
  }, 'api/upload');

  assert.equal(fetched, false);
  assert.equal(res.status, 502);
  assert.match(res.text(), /Body too large/);
});

test('missing proxy target returns JSON error', async () => {
  const handler = createApiProxyHandler();
  const res = responseRecorder();
  await handler({ method: 'GET', url: '/.api-proxy/api' }, res, { name: 'api', route: {}, remainder: '' });
  assert.equal(res.status, 500);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.match(res.text(), /no target URL/);
});
