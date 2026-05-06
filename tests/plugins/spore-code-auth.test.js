'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const sporeCode = require('../../plugins/spore-code');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function writeUser(dataDir, username, password, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'webapp-users.json'), JSON.stringify([{
    username,
    salt,
    hash: hashPassword(password, salt),
    role: 'webapp',
    created: Date.now(),
    ...extra,
  }]));
}

function makeApi(dataDir, host = {}) {
  const webSessions = new Map();
  return {
    webSessions,
    api: {
      _appContext: {
        config: { dataDir },
        tools: { gateway: { _webSessions: webSessions } },
      },
      getHostConfig: () => ({ dataDir, ...host }),
      getLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    },
  };
}

function makeReq(body) {
  return Readable.from([JSON.stringify(body)]);
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += String(chunk);
    },
  };
}

test('spore-code auth accepts local account password without invite key', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    writeUser(dataDir, 'yam', 'secret-password');
    const { api, webSessions } = makeApi(dataDir, { inviteKey: '' });
    const res = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'yam',
      authMethod: 'password',
      password: 'secret-password',
    }), res);

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(webSessions.get(payload.token).user, 'yam');
    assert.equal(webSessions.get(payload.token).auth, 'password');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth keeps invite key login working', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const { api, webSessions } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const res = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      key: 'invite-key',
    }), res);

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(webSessions.get(payload.token).user, 'cli-user');
    assert.equal(webSessions.get(payload.token).auth, 'invite');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code password auth reports credentials errors, not invite key errors', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    writeUser(dataDir, 'yam', 'secret-password');
    const { api } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const res = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'yam',
      authMethod: 'password',
      password: 'wrong-password',
    }), res);

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'Invalid credentials');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
