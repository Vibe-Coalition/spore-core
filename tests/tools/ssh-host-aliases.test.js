'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SSHManager } = require('../../src/tools/ssh-manager');
const { ToolSystem } = require('../../src/tools/tools');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-ssh-alias-'));
  const mgr = new SSHManager({
    dataDir,
    sshSidecarEnabled: false,
    webAuthPass: 'test-passphrase',
  }, logger());
  mgr.hosts = [{
    id: 'cluster-login',
    name: 'Cluster Login',
    hostname: 'gpu-login-1.tailnet.example.ts.net',
    username: 'test-user',
    port: 22,
  }];
  return mgr;
}

test('ssh manager resolves saved hosts by id, hostname, short name, and user host alias', () => {
  const mgr = makeManager();
  try {
    assert.equal(mgr._resolveHostRefSync('cluster-login'), 'cluster-login');
    assert.equal(mgr._resolveHostRefSync('gpu-login-1.tailnet.example.ts.net'), 'cluster-login');
    assert.equal(mgr._resolveHostRefSync('gpu-login-1'), 'cluster-login');
    assert.equal(mgr._resolveHostRefSync('test-user@gpu-login-1'), 'cluster-login');
    assert.equal(mgr._resolveHostRefSync('ssh://test-user@gpu-login-1.tailnet.example.ts.net'), 'cluster-login');
    assert.equal(mgr._resolveHostRefSync('missing-host'), null);
    assert.match(mgr._unknownHostMessage('missing-host'), /Available SSH host IDs\/aliases: cluster-login/);
    assert.match(mgr._unknownHostMessage('missing-host'), /do not shell out to ssh or tailscale ssh/);
  } finally {
    mgr.closeAll();
  }
});

test('remote tool catalog advertises saved host aliases', () => {
  const mgr = makeManager();
  const tools = new ToolSystem(
    { workspacePath: process.cwd(), clusterTmuxPrefix: 'spore' },
    logger(),
    null,
    null,
    null,
  );
  tools._ensureSSHManager = () => mgr;

  try {
    const defs = tools._getRemoteToolDefinitions();
    const remoteExec = defs.find(d => d.name === 'remote_exec');
    assert.ok(remoteExec);
    assert.match(remoteExec.description, /cluster-login/);
    assert.match(remoteExec.description, /gpu-login-1/);
    assert.match(remoteExec.input_schema.properties.host.description, /test-user@gpu-login-1/);
  } finally {
    mgr.closeAll();
  }
});
