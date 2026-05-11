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
  const pluginConfig = host.plugins?.['spore-code'] || {};
  return {
    webSessions,
    api: {
      _appContext: {
        config: { dataDir },
        tools: { gateway: { _webSessions: webSessions } },
      },
      getHostConfig: () => ({ dataDir, ...host }),
      getConfig: () => ({ ...pluginConfig }),
      getLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    },
  };
}

function makeReq(body, headers = {}, socket = null) {
  const req = Readable.from([JSON.stringify(body || {})]);
  req.headers = headers;
  if (socket) req.socket = socket;
  return req;
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
    writeUser(dataDir, 'test-user', 'secret-password');
    const { api, webSessions } = makeApi(dataDir, { inviteKey: '' });
    const res = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'test-user',
      authMethod: 'password',
      password: 'secret-password',
    }), res);

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(webSessions.get(payload.token).user, 'test-user');
    assert.equal(webSessions.get(payload.token).auth, 'password');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth does not rate-limit repeated successful password logins', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const username = 'repeat-password-user';
    writeUser(dataDir, username, 'secret-password');
    const { api, webSessions } = makeApi(dataDir, { inviteKey: '' });

    for (let i = 0; i < 6; i += 1) {
      const res = makeRes();
      await sporeCode._test.handleAuth(api, makeReq({
        username,
        authMethod: 'password',
        password: 'secret-password',
      }), res);

      assert.equal(res.statusCode, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.ok, true);
      assert.equal(webSessions.get(payload.token).user, username);
      assert.equal(webSessions.get(payload.token).auth, 'password');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth still rate-limits repeated failed password logins', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const username = 'failed-password-user';
    writeUser(dataDir, username, 'secret-password');
    const { api } = makeApi(dataDir, { inviteKey: '' });

    for (let i = 0; i < 5; i += 1) {
      const res = makeRes();
      await sporeCode._test.handleAuth(api, makeReq({
        username,
        authMethod: 'password',
        password: 'wrong-password',
      }), res);

      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).error, 'Invalid credentials');
    }

    const res = makeRes();
    await sporeCode._test.handleAuth(api, makeReq({
      username,
      authMethod: 'password',
      password: 'wrong-password',
    }), res);

    assert.equal(res.statusCode, 429);
    assert.equal(JSON.parse(res.body).error, 'Too many authentication attempts. Try again later.');
    assert.ok(Number(res.headers['Retry-After']) >= 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth does not rate-limit repeated successful invite logins', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const { api, webSessions } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const username = 'repeat-invite-user';

    for (let i = 0; i < 6; i += 1) {
      const res = makeRes();
      await sporeCode._test.handleAuth(api, makeReq({
        username,
        key: 'invite-key',
      }), res);

      assert.equal(res.statusCode, 200);
      const payload = JSON.parse(res.body);
      assert.equal(payload.ok, true);
      assert.equal(webSessions.get(payload.token).user, username);
      assert.equal(webSessions.get(payload.token).auth, 'invite');
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code recall skip keeps scoped project and shared KB recall enabled', () => {
  const scopedOpts = {
    platform: 'cli',
    messageContent: 'start the expo server and print me the qr code here',
    projectContext: { cwd: 'C:\\Users\\esfle\\sample_project', source: 'spore-code' },
    memoryEnvelope: {
      mode: 'codebase-session',
      readScopes: [
        { slug: 'project-abc', role: 'project' },
        { slug: 'spore-knowledge-base', role: 'general_kb' },
      ],
    },
  };

  assert.equal(sporeCode._test.shouldSkipRecallForSporeCode({
    opts: scopedOpts,
    queryType: 'specific',
  }), false);

  assert.equal(sporeCode._test.shouldSkipRecallForSporeCode({
    opts: { ...scopedOpts, messageContent: 'fix src/App.tsx and run tests', memoryEnvelope: null },
    queryType: 'specific',
  }), true);

  assert.equal(sporeCode._test.shouldSkipRecallForSporeCode({
    opts: { ...scopedOpts, messageContent: 'what tools can you use?' },
    queryType: 'specific',
  }), true);
});

test('spore-code project context tells cli agents to execute recalled skills as playbooks', () => {
  const api = {
    _appContext: {},
    getLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
  };

  const section = sporeCode._test.buildProjectContextSection(api, {
    platform: 'cli',
    projectContext: {
      project: 'acorn-companion',
      cwd: 'C:\\Users\\esfle\\sample_project',
      scope: 'strict',
      os: 'windows',
      arch: 'x64',
    },
  });

  assert.match(section, /Reusable Skill Execution Contract/);
  assert.match(section, /default playbook/);
  assert.match(section, /avoid rediscovering or rewriting helpers/);
  assert.match(section, /prefer inline commands/);
  assert.match(section, /Executor shell: cmd\.exe \/C/);
  assert.match(section, /exec` input is parsed by cmd\.exe by default/);
  assert.match(section, /PowerShell invocation/);
  assert.match(section, /powershell_exec/);
  assert.match(section, /exec` is stable for cmd\.exe syntax, including quoted arguments/);
  assert.match(section, /only when the command itself is PowerShell code/);
  assert.match(section, /powershell -NoProfile -ExecutionPolicy Bypass -Command/);
  assert.match(section, /\.spore-code\\scratch\\task\.ps1/);
  assert.match(section, /File tools are shell-free on Windows/);
  assert.match(section, /Scratch helpers written through `write_file`\/`edit_file` are auto-saved/);
  assert.match(section, /do not call `save_project_script` again/);
  assert.doesNotMatch(section, /PowerShell\/cmd snippets/);
});

test('spore-code workflow state exposes captured background task results', () => {
  const section = sporeCode._test.buildWorkflowStateSection({}, {
    platform: 'cli',
    projectContext: { mode: 'plan', cwd: '/repo' },
    workflowStatus: {
      id: 'wf-test',
      phase: 'research',
      status: 'artifact_ready',
      activeRules: ['read_only_research'],
      artifacts: {
        researchDone: true,
        researchDonePreview: 'RESEARCH_DONE:\nExisting research summary.',
        backgroundTaskResults: [{
          taskId: 'task-1',
          status: 'completed',
          originalRequest: 'Research cat theme colors.',
          resultPreview: 'Use warm cream, peach, lavender, and paw iconography.',
        }],
      },
      evidenceCount: 0,
    },
  });

  assert.match(section, /Captured background task results/);
  assert.match(section, /Research cat theme colors/);
  assert.match(section, /warm cream, peach, lavender/);
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
    writeUser(dataDir, 'test-user', 'secret-password');
    const { api } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const res = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'test-user',
      authMethod: 'password',
      password: 'wrong-password',
    }), res);

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'Invalid credentials');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth allows private LAN HTTP but rejects public HTTP', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const { api } = makeApi(dataDir, { inviteKey: 'invite-key' });

    const lanRes = makeRes();
    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      key: 'invite-key',
    }, {}, { remoteAddress: '192.168.1.45' }), lanRes);
    assert.equal(lanRes.statusCode, 200);

    const publicRes = makeRes();
    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      key: 'invite-key',
    }, {}, { remoteAddress: '203.0.113.10' }), publicRes);
    assert.equal(publicRes.statusCode, 403);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth setting can allow public HTTP explicitly', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const { api } = makeApi(dataDir, {
      inviteKey: 'invite-key',
      plugins: { 'spore-code': { allowInsecureAuth: true } },
    });

    const res = makeRes();
    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      key: 'invite-key',
    }, {}, { remoteAddress: '203.0.113.10' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code auth can mint a device token and exchange it for a ws ticket', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    writeUser(dataDir, 'test-user', 'secret-password');
    const { api, webSessions } = makeApi(dataDir, { inviteKey: '' });
    const authRes = makeRes();

    await sporeCode._test.handleAuth(api, makeReq({
      username: 'test-user',
      authMethod: 'password',
      password: 'secret-password',
      issueDevice: true,
    }), authRes);

    assert.equal(authRes.statusCode, 200);
    const authPayload = JSON.parse(authRes.body);
    assert.match(authPayload.deviceToken, /^spc_/);
    assert.ok(authPayload.deviceId);

    const sessionRes = makeRes();
    await sporeCode._test.handleDeviceSession(api, makeReq({}, {
      authorization: `Bearer ${authPayload.deviceToken}`,
    }), sessionRes);

    assert.equal(sessionRes.statusCode, 200);
    const sessionPayload = JSON.parse(sessionRes.body);
    assert.equal(sessionPayload.ok, true);
    assert.equal(webSessions.get(sessionPayload.token).user, 'test-user');
    assert.equal(webSessions.get(sessionPayload.token).auth, 'device');
    assert.equal(webSessions.get(sessionPayload.token).singleUse, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code stores routing preset overrides on one device only', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-routing-'));
  try {
    const { api } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const first = sporeCode._test.mintDeviceToken(api, 'test-user', 'invite');
    const second = sporeCode._test.mintDeviceToken(api, 'zelda', 'invite');

    const out = sporeCode._test.setDeviceRoutingPreset(api, first.deviceToken, 'fast', {
      models: {
        casual: { provider: 'openai', model: 'gpt-4.1-mini' },
        normal: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      },
      modelLimits: {
        'openai/gpt-4.1-mini': { contextWindow: 128000, maxTokens: 8192 },
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.routing.scope, 'device');
    assert.equal(out.routing.preset, 'fast');
    assert.equal(out.routing.config.models.casual, 'openai/gpt-4.1-mini');
    assert.equal(out.routing.config.models.normal, 'claude-sonnet-4-6');

    const routed = sporeCode._test.getDeviceRoutingOverride(api, first.deviceId);
    const unrouted = sporeCode._test.getDeviceRoutingOverride(api, second.deviceId);
    assert.equal(routed.preset, 'fast');
    assert.equal(unrouted, null);

    const cleared = sporeCode._test.clearDeviceRoutingPreset(api, first.deviceToken);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.routing.scope, 'server');
    assert.equal(sporeCode._test.getDeviceRoutingOverride(api, first.deviceId), null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('spore-code logout revokes device tokens', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-code-auth-'));
  try {
    const { api } = makeApi(dataDir, { inviteKey: 'invite-key' });
    const authRes = makeRes();
    await sporeCode._test.handleAuth(api, makeReq({
      username: 'cli-user',
      key: 'invite-key',
      issueDevice: true,
    }), authRes);
    const authPayload = JSON.parse(authRes.body);

    const logoutRes = makeRes();
    await sporeCode._test.handleLogout(api, makeReq({}, {
      authorization: `Bearer ${authPayload.deviceToken}`,
    }), logoutRes);
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(JSON.parse(logoutRes.body).revoked, true);

    const sessionRes = makeRes();
    await sporeCode._test.handleDeviceSession(api, makeReq({}, {
      authorization: `Bearer ${authPayload.deviceToken}`,
    }), sessionRes);
    assert.equal(sessionRes.statusCode, 401);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
