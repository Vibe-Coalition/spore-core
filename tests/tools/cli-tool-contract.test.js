'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ToolSystem } = require('../../src/tools/tools');

function makeTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-cli-contract-'));
  const tools = new ToolSystem(
    { workspacePath: dir, dataDir: dir, webPort: 18803 },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
  return { tools, dir };
}

test('cli tool definitions expose Windows cmd contract and project-relative read_file paths', (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  tools._getRemoteToolDefinitions = () => [];

  const defs = tools.getToolDefinitions({
    platform: 'cli',
    projectContext: {
      cwd: 'C:\\Users\\yam\\project',
      os: 'windows',
      arch: 'amd64',
      localTools: ['exec', 'read_file', 'read_many_files'],
      defaultShell: 'cmd.exe',
      shellFlag: '/C',
    },
  });

  const execDef = defs.find(t => t.name === 'exec');
  const readDef = defs.find(t => t.name === 'read_file');
  const readManyDef = defs.find(t => t.name === 'read_many_files');

  assert.ok(execDef);
  assert.ok(readDef);
  assert.ok(readManyDef);
  assert.match(execDef.description, /cmd\.exe \/C/);
  assert.match(execDef.description, /powershell_exec/);
  assert.match(execDef.description, /quoted arguments are supported/);
  assert.match(execDef.description, /only when the command itself is PowerShell code/);
  assert.match(execDef.description, /powershell -NoProfile -ExecutionPolicy Bypass -Command/);
  assert.match(execDef.input_schema.properties.command.description, /cmd\.exe \/C/);
  assert.match(execDef.input_schema.properties.command.description, /quoted arguments are supported/);
  assert.match(execDef.input_schema.properties.command.description, /use powershell_exec when available/i);
  assert.match(readDef.description, /current Spore Code project on the user machine/);
  assert.match(readDef.input_schema.properties.path.description, /Project-relative path/);
  assert.doesNotMatch(readDef.input_schema.properties.path.description, /Absolute path to the file/);
  assert.match(readManyDef.description, /current Spore Code project on the user machine/);
  assert.match(readManyDef.input_schema.properties.paths.description, /Project-relative paths/);
  assert.match(readManyDef.input_schema.properties.paths.description, /not shell arguments/);
});

test('git_diff accepts a file path as path and treats it as a pathspec', async (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const appDir = path.join(dir, 'internal', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const filePath = path.join(appDir, 'update.go');
  fs.writeFileSync(filePath, 'package app\n\nfunc before() {}\n', 'utf8');
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(filePath, 'package app\n\nfunc after() {}\n', 'utf8');

  const result = await tools._gitDiffTool({ path: filePath, stat: true });
  assert.equal(result.ok, true);
  assert.equal(result.path, appDir);
  assert.equal(result.file, 'update.go');
  assert.match(result.output, /update\.go/);
});

test('server fallback file tools accept common alias fields', (t) => {
  const { tools, dir } = makeTools();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = tools._writeFileTool({ file_path: 'src/app.ts', text: 'one\ntwo\nthree\n' });
  assert.equal(write.success, true);

  const read = tools._readFileTool({ file: 'src/app.ts', line_start: 2, line_end: 3 });
  assert.equal(read.content, 'two\nthree');

  const edit = tools._editFileTool({ filename: 'src/app.ts', old_str: 'two\n', new_str: 'TWO\n' });
  assert.equal(edit.success, true);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8'), 'one\nTWO\nthree\n');

  const missing = tools._writeFileTool({ path: 'src/empty.ts' });
  assert.match(missing.error, /content is required/);
});
