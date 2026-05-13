'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolSystem } = require('../../src/tools/tools');

function makeTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-exec-guard-'));
  const tools = new ToolSystem(
    { workspacePath: dir, dataDir: dir, webPort: 18803 },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
  return { tools, dir };
}

test('exec blocks broad node process kills', async (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const command of [
    'taskkill /F /IM node.exe',
    'taskkill //F //IM node.exe',
    'Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force',
    'pkill node',
    'killall node',
  ]) {
    const result = tools._broadProcessKillBlock(command);
    assert.equal(result.reason, 'broad_node_process_kill', command);
    assert.match(result.error, /broad Node process kill/i, command);
  }
});

test('exec blocks scripted SSH password automation by default', async (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const command of [
    'sshpass -p secret ssh user@example.com',
    'python3 -c "import pexpect; c=pexpect.spawn(\'ssh user@example.com\'); c.expect(\'password:\'); c.sendline(\'secret\')"',
    'expect -c "spawn ssh user@example.com; expect password:; send secret"',
  ]) {
    const result = tools._credentialAutomationCommandBlock(command);
    assert.equal(result.reason, 'scripted_password_auth', command);
    assert.match(result.error, /scripted SSH password automation/i, command);
  }
});

test('write_file blocks expect-style SSH password scripts by default', async (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = tools._writeFileTool({
    path: 'login.py',
    content: [
      'import pexpect',
      'child = pexpect.spawn("ssh user@example.com")',
      'child.expect("password:")',
      'child.sendline("secret")',
    ].join('\n'),
  });
  assert.match(result.error, /password automation/i);

  tools.config.credentialGuard = 'warn';
  const allowed = tools._writeFileTool({
    path: 'login-warn.py',
    content: [
      'import pexpect',
      'child = pexpect.spawn("ssh user@example.com")',
      'child.expect("password:")',
      'child.sendline("secret")',
    ].join('\n'),
  });
  assert.equal(allowed.success, true);
});

test('package install security setting supports strict warn and off modes', async (t) => {
  const { tools: strictTools, dir: dir1 } = makeTools();
  t.after(() => fs.rmSync(dir1, { recursive: true, force: true }));
  assert.equal(strictTools._packageInstallSecurity, 'strict');

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-exec-guard-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const warnTools = new ToolSystem(
    { workspacePath: dir2, dataDir: dir2, webPort: 18803, packageInstallSecurity: 'warn' },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
  assert.equal(warnTools._packageInstallSecurity, 'warn');

  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-exec-guard-'));
  t.after(() => fs.rmSync(dir3, { recursive: true, force: true }));
  const offTools = new ToolSystem(
    { workspacePath: dir3, dataDir: dir3, webPort: 18803, packageInstallSecurity: 'off' },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
  assert.equal(offTools._packageInstallSecurity, 'off');

  offTools.config.packageInstallSecurity = 'strict';
  assert.equal(offTools._packageInstallSecurityMode(), 'strict');
  offTools.config.packageInstallSecurity = 'warn';
  assert.equal(offTools._packageInstallSecurityMode(), 'warn');
});
