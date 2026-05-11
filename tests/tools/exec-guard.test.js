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
