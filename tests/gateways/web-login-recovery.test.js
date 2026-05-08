'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { WebGateway } = require('../../src/gateways/web');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function writeUser(dataDir, username, password, role = 'webapp') {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'webapp-users.json'), JSON.stringify([{
    username,
    salt,
    hash: hashPassword(password, salt),
    role,
    created: Date.now(),
  }]));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function makeGateway(dataDir, port, extraConfig = {}) {
  return new WebGateway({
    config: {
      dataDir,
      workspacePath: dataDir,
      webPort: port,
      agentId: 'test-spore',
      displayName: 'Test Spore',
      ...extraConfig,
    },
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    graph: null,
    skills: null,
  });
}

async function startGateway(dataDir, extraConfig = {}) {
  const port = await getFreePort();
  const gateway = makeGateway(dataDir, port, extraConfig);
  Object.assign(gateway.config, extraConfig);
  gateway._currentWebPort = () => port;
  gateway._setupWebSocket = () => {};
  const result = gateway._start(path.join(dataDir, 'web'));
  assert.equal(result?.error, undefined);
  if (!gateway.server.listening) await once(gateway.server, 'listening');
  return { gateway, port };
}

async function stopGateway(gateway) {
  const server = gateway.server;
  if (!server) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
    server.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    gateway._stop();
  });
}

async function postJson(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, payload, text };
}

test('webapp login accepts correct credentials even after the client IP is locked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-web-login-'));
  let gateway = null;
  let port = null;
  try {
    writeUser(dataDir, 'mobile-user', 'secret-password', 'webapp');
    ({ gateway, port: port } = await startGateway(dataDir));

    for (let i = 0; i < 5; i += 1) {
      const bad = await postJson(port, '/api/webapp/login', {
        username: 'mobile-user',
        password: 'wrong-password',
      });
      assert.equal(bad.status, 401);
    }

    const limited = await postJson(port, '/api/webapp/login', {
      username: 'mobile-user',
      password: 'wrong-password',
    });
    assert.equal(limited.status, 429);

    const good = await postJson(port, '/api/webapp/login', {
      username: 'mobile-user',
      password: 'secret-password',
    });
    assert.equal(good.status, 200);
    assert.equal(good.payload.ok, true);
    assert.equal(good.payload.user, 'mobile-user');

    const badAfterSuccess = await postJson(port, '/api/webapp/login', {
      username: 'mobile-user',
      password: 'wrong-password',
    });
    assert.equal(badAfterSuccess.status, 401);
  } finally {
    if (gateway) await stopGateway(gateway);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('creator login accepts correct credentials even after the client IP is locked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-web-login-'));
  let gateway = null;
  let port = null;
  try {
    writeUser(dataDir, 'creator-user', 'secret-password', 'creator');
    ({ gateway, port: port } = await startGateway(dataDir));

    for (let i = 0; i < 5; i += 1) {
      const bad = await postJson(port, '/api/auth/login', {
        username: 'creator-user',
        password: 'wrong-password',
      });
      assert.equal(bad.status, 401);
    }

    const limited = await postJson(port, '/api/auth/login', {
      username: 'creator-user',
      password: 'wrong-password',
    });
    assert.equal(limited.status, 429);

    const good = await postJson(port, '/api/auth/login', {
      username: 'creator-user',
      password: 'secret-password',
    });
    assert.equal(good.status, 200);
    assert.equal(good.payload.ok, true);
    assert.equal(good.payload.user, 'creator-user');

    const badAfterSuccess = await postJson(port, '/api/auth/login', {
      username: 'creator-user',
      password: 'wrong-password',
    });
    assert.equal(badAfterSuccess.status, 401);
  } finally {
    if (gateway) await stopGateway(gateway);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('self-register accepts a valid invite even after the client IP is locked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-web-login-'));
  let gateway = null;
  let port = null;
  try {
    ({ gateway, port: port } = await startGateway(dataDir, { inviteKey: 'invite-key' }));

    for (let i = 0; i < 5; i += 1) {
      const bad = await postJson(port, '/api/webapp/users/self-register', {
        username: 'new-mobile-user',
        password: 'secret-password',
        inviteKey: 'wrong-invite',
      });
      assert.equal(bad.status, 401);
    }

    const limited = await postJson(port, '/api/webapp/users/self-register', {
      username: 'new-mobile-user',
      password: 'secret-password',
      inviteKey: 'wrong-invite',
    });
    assert.equal(limited.status, 429);

    const good = await postJson(port, '/api/webapp/users/self-register', {
      username: 'new-mobile-user',
      password: 'secret-password',
      inviteKey: 'invite-key',
    });
    assert.equal(good.status, 200);
    assert.equal(good.payload.ok, true);
    assert.equal(good.payload.user, 'new-mobile-user');

    const badAfterSuccess = await postJson(port, '/api/webapp/users/self-register', {
      username: 'another-mobile-user',
      password: 'secret-password',
      inviteKey: 'wrong-invite',
    });
    assert.equal(badAfterSuccess.status, 401);
  } finally {
    if (gateway) await stopGateway(gateway);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
