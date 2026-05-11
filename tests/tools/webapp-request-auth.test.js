const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ToolSystem } = require('../../src/tools');

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('webapp_request uses the active webapp session cookie name from tool context', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.headers.cookie === 'spore_webapp=sess-webapp') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad cookie', cookie: req.headers.cookie || '' }));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const tools = new ToolSystem({ webPort: port }, logger(), null, null, null);
  tools.gateway = {
    _server: server,
    _webSessions: new Map([['sess-webapp', { user: 'danke', type: 'webapp', created: Date.now() }]]),
    getSessionForUser() {
      return null;
    },
  };

  const result = await tools.executeTool(
    'webapp_request',
    { method: 'GET', path: '/serve/hello-world/' },
    {
      platform: 'web',
      userName: 'danke',
      userRole: 'webapp',
      sessionToken: 'sess-webapp',
      sessionCookieName: 'spore_webapp',
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.authenticatedAs, 'danke');
});

test('webapp_request falls back to a stored user session instead of sending an invalid websocket ticket', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.headers.cookie === 'spore_webapp=real-session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad cookie', cookie: req.headers.cookie || '' }));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const tools = new ToolSystem({ webPort: port }, logger(), null, null, null);
  tools.gateway = {
    _server: server,
    _webSessions: new Map([['real-session', { user: 'danke', type: 'webapp', created: Date.now() }]]),
    getSessionForUser(username) {
      assert.equal(username, 'danke');
      return { sessionId: 'real-session', user: 'danke', type: 'webapp', cookieName: 'spore_webapp' };
    },
  };

  const result = await tools.executeTool(
    'webapp_request',
    { method: 'GET', path: '/serve/hello-world/' },
    {
      platform: 'web',
      userName: 'danke',
      userRole: 'webapp',
      sessionToken: 'single-use-ticket-already-deleted',
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.authenticatedAs, 'danke');
});
