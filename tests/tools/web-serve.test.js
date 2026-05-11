const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { ToolSystem } = require('../../src/tools');
const { WebGateway } = require('../../src/gateways/web');

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

test('web_serve returns and serves a named mounted app endpoint instead of bare root', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-web-serve-'));
  const webDir = path.join(dir, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><h1>Mounted hello</h1>');

  const port = await freePort();
  const tools = new ToolSystem({
    dataDir: dir,
    workspacePath: dir,
    sharedSkillsDir: path.join(dir, 'skills'),
    sessionDbPath: path.join(dir, 'sessions.db'),
    webPort: port,
  }, logger(), null, null, null);
  tools.gateway = new WebGateway(tools);
  tools.gateway._setupWebSocket = () => {};

  t.after(() => {
    try { tools.gateway?._stop(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const started = tools._webServeTool({ action: 'start', dir: webDir });
  assert.equal(started.started, true);
  assert.equal(started.mount, 'website_1');
  assert.equal(started.url, '/serve/website_1/');
  assert.equal(started.serveUrl, '/serve/website_1/');
  assert.equal(started.rootUrl, '/');
  assert.equal(started.localUrl, undefined);
  assert.match(started.note, /\/serve\/website_1\//);

  const served = await getText(`http://127.0.0.1:${port}/serve/website_1/`);
  assert.equal(served.status, 200);
  assert.match(served.body, /Mounted hello/);

  const status = tools._webServeTool({ action: 'status' });
  assert.equal(status.running, true);
  assert.equal(status.mount, 'website_1');
  assert.equal(status.url, '/serve/website_1/');
  assert.equal(status.serveUrl, '/serve/website_1/');
  assert.equal(status.localUrl, undefined);

  const otherDir = path.join(dir, 'web', 'hello-card');
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'index.html'), '<!doctype html><h1>Hello card</h1>');
  const named = tools._webServeTool({ action: 'start', dir: otherDir, name: 'hello-card' });
  assert.equal(named.mount, 'hello-card');
  assert.equal(named.url, '/serve/hello-card/');
  const namedServed = await getText(`http://127.0.0.1:${port}/serve/hello-card/`);
  assert.equal(namedServed.status, 200);
  assert.match(namedServed.body, /Hello card/);
});
