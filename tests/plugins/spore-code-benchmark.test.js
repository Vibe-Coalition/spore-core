'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_LOCAL_TOOLS,
  GO_TEST_COMMAND,
  SCENARIOS,
  buildBenchmarkContext,
  buildUserPrompt,
  selectScenarios,
  tasksForScenario,
} = require('../../plugins/spore-code-benchmark/lib/catalog');
const { LocalToolExecutor, _test: localToolTest } = require('../../plugins/spore-code-benchmark/lib/local-tools');
const {
  agentAskedForGuidance,
  buildActorPrompt,
  generateActorFollowup,
  generateActorTurn,
  messageText,
  parseJsonObject,
} = require('../../plugins/spore-code-benchmark/lib/actor');
const { scanLeakage, scoreScenario, summarizeExperienceWithLlm } = require('../../plugins/spore-code-benchmark/lib/judge');
const { LiveSporeCodeSession } = require('../../plugins/spore-code-benchmark/lib/live-session');
const { changedPathsFromStatus, evaluateCommandResult } = require('../../plugins/spore-code-benchmark/lib/verification');
const {
  buildHandoffFacts,
  changedFileSummary,
  classifyVerificationClaim,
  commandScope,
  deriveSetupStatus,
} = require('../../plugins/spore-code-benchmark/lib/reporting');
const { SporeCodeBenchmarkRunner, _test } = require('../../plugins/spore-code-benchmark/lib/runner');
const benchmarkPlugin = require('../../plugins/spore-code-benchmark');
const graphEvents = require('../../src/graph/events');

test('Spore Code benchmark catalog contains diverse scenarios including AI development', () => {
  assert.ok(SCENARIOS.length >= 13);
  assert.equal(new Set(SCENARIOS.map(s => s.id)).size, SCENARIOS.length);
  assert.ok(new Set(SCENARIOS.map(s => s.domain)).size >= 8);
  assert.ok(SCENARIOS.some(s => s.domain === 'ai-paper-implementation'));
  assert.ok(SCENARIOS.some(s => (s.tags || []).includes('setup') && (s.tags || []).includes('ai')));
  assert.ok(SCENARIOS.some(s => (s.tags || []).includes('paper-implementation')));
  assert.ok(DEFAULT_LOCAL_TOOLS.includes('read_file'));
  assert.ok(DEFAULT_LOCAL_TOOLS.includes('exec'));

  for (const scenario of SCENARIOS) {
    assert.match(scenario.repo.url, /^https:\/\/github\.com\/.+\.git$/);
    assert.ok(scenario.userPrompt.length > 80);
    assert.ok(Array.isArray(scenario.verification.commands));
    assert.ok(tasksForScenario(scenario).length >= 3);
    assert.ok(new Set(tasksForScenario(scenario).map(t => t.userName)).size >= 3);
  }
});

test('scenario selection validates ids and caps count', () => {
  assert.deepEqual(selectScenarios({ scenarioIds: [SCENARIOS[2].id], maxScenarios: 10 }).map(s => s.id), [SCENARIOS[2].id]);
  assert.equal(selectScenarios({ maxScenarios: 3 }).length, 3);
  assert.throws(() => selectScenarios({ scenarioIds: ['missing'] }), /Unknown scenario id/);
});

test('benchmark user prompts read like normal repo requests while harness context carries isolation rules', () => {
  const task = tasksForScenario(SCENARIOS[0])[0];
  const prompt = buildUserPrompt(SCENARIOS[0], { task });
  assert.doesNotMatch(prompt, /benchmark|scenario|canary|Isolation rule/i);
  assert.match(prompt, /Express|request/i);

  const hidden = buildBenchmarkContext(SCENARIOS[0], task, {
    runId: 'run-a',
    sessionId: 'session-a',
    canary: 'SCB_CANARY_A',
  });
  assert.match(hidden, /Isolation rule/);
  assert.match(hidden, /Setup rule/);
  assert.match(hidden, /Resource rule/);
  assert.match(hidden, /\$SPORE_BENCHMARK_CACHE/);
  assert.match(hidden, /SCB_CANARY_A/);
  assert.match(hidden, /express-request-id/);
});

test('LocalToolExecutor keeps file operations inside repo root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-tools-'));
  fs.writeFileSync(path.join(root, 'alpha.txt'), 'one\ntwo\nthree\n');
  const outside = path.join(os.tmpdir(), `scb-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'secret');
  const tools = new LocalToolExecutor({ root });

  assert.equal((await tools.execute('read_file', { path: path.join(root, 'alpha.txt') })).lines, 4);
  assert.match((await tools.execute('grep', { pattern: 'two' })).matches[0].text, /two/);
  assert.equal((await tools.execute('edit_file', { path: 'alpha.txt', old_text: 'two', new_text: 'TWO' })).ok, true);
  assert.match(fs.readFileSync(path.join(root, 'alpha.txt'), 'utf8'), /TWO/);

  const escaped = await tools.execute('read_file', { path: outside });
  assert.match(escaped.error, /escapes benchmark workspace/);
  const dangerous = await tools.execute('exec', { command: 'sudo rm -rf /', workdir: root });
  assert.match(dangerous.error, /blocked/);
});

test('LocalToolExecutor promotes hung exec commands to tail-able background processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-bg-'));
  const tools = new LocalToolExecutor({ root, defaultTimeoutMs: 250 });

  const result = await tools.execute('exec', {
    command: 'node -e "console.log(\'ready\'); setInterval(() => {}, 1000)"',
    workdir: root,
    timeout: 250,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.backgrounded, true);
  const id = result.backgroundId || result.processId;
  assert.ok(id > 0);

  const tail = await tools.execute('bg_tail', { id, lines: 20 });
  assert.equal(tail.ok, true);
  assert.match(tail.output, /ready/);

  const killed = await tools.execute('bg_kill', { id });
  assert.equal(killed.ok, true);
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = await tools.execute('bg_tail', { id, lines: 20 });
  assert.equal(after.running, false);
  tools.killAllBackground();
});

test('LocalToolExecutor does not hide test failures behind shell pipelines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-pipefail-'));
  const tools = new LocalToolExecutor({ root });
  const result = await tools.execute('exec', {
    command: 'node -e "console.log(\'1 failed\'); process.exit(1)" 2>&1 | head -20',
    timeout: 5000,
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout || result.output || '', /1 failed/);
  tools.killAllBackground();
});

test('LocalToolExecutor summarizes untracked files for benchmark review metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-untracked-'));
  const tools = new LocalToolExecutor({ root });
  await tools.exec({ command: 'git init', workdir: root });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'feature.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'one\ntwo\n');

  const summary = await tools.gitUntrackedSummary({ path: root });

  assert.equal(summary.ok, true);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.files.map(f => f.path).sort(), ['lib/feature.js', 'notes.md']);
  assert.equal(summary.totalLines, 5);
  assert.match(summary.statText, /2 untracked files/);
});

test('LocalToolExecutor checks whitespace in untracked source files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-untracked-ws-'));
  const tools = new LocalToolExecutor({ root });
  await tools.exec({ command: 'git init', workdir: root });
  fs.writeFileSync(path.join(root, 'clean.js'), 'const ok = true;\n');
  fs.writeFileSync(path.join(root, 'dirty.js'), 'const bad = true;  \n');

  const check = await tools.untrackedWhitespaceCheck({ path: root });

  assert.equal(check.ok, false);
  assert.equal(check.failureReason, 'trailing_whitespace');
  assert.ok(check.checkedFiles.includes('clean.js'));
  assert.ok(check.checkedFiles.includes('dirty.js'));
  assert.ok(check.problems.some(p => p.kind === 'trailing_whitespace' && p.path === 'dirty.js'));
});

test('benchmark sandbox allows local setup but blocks global package mutation', () => {
  assert.equal(localToolTest.commandLooksDangerous('apt-get install -y golang'), true);
  assert.equal(localToolTest.commandLooksDangerous('npm install -g pnpm'), true);
  assert.equal(localToolTest.commandLooksDangerous('python3 -m pip install --break-system-packages pytest'), true);
  assert.equal(localToolTest.commandLooksDangerous('python3 -m pip install pytest'), true);
  assert.equal(localToolTest.commandLooksDangerous('npm install'), false);
  assert.equal(localToolTest.commandLooksDangerous('python3 -m venv "$SPORE_BENCHMARK_CACHE/venv" && . "$SPORE_BENCHMARK_CACHE/venv/bin/activate" && python -m pip install pytest'), false);
  assert.equal(localToolTest.commandLooksDangerous('$SPORE_BENCHMARK_CACHE/venv/bin/python -m pip install -e . pytest'), false);
  assert.equal(localToolTest.commandLooksDangerous('python3 -m pip install --user pytest'), false);
  assert.match(localToolTest.commandResourceViolation('python3 -m venv "$SPORE_BENCHMARK_CACHE/venv" && . "$SPORE_BENCHMARK_CACHE/venv/bin/activate" && python -m pip install torch pytest'), /heavyweight Python package "torch"/);
  assert.match(localToolTest.commandResourceViolation('pip install --target .venv-deps nvidia-cudnn-cu13'), /NVIDIA\/CUDA/);
  assert.equal(localToolTest.commandResourceViolation('python -m pip install --target .venv-deps pytest numpy'), null);
  assert.equal(localToolTest.commandResourceViolation('SPORE_BENCHMARK_ALLOW_HEAVY_DEPS=1 python -m pip install --target .venv-deps torch'), null);
  assert.equal(localToolTest.commandIsolationViolation('find / -name go', '/data/spore-code-benchmark/runs/scb-current'), 'Command searches the host root filesystem; benchmark exec is limited to the repo and current run cache');
  assert.match(
    localToolTest.commandIsolationViolation('/data/spore-code-benchmark/runs/scb-old/.tool-env/gin/cache/go/bin/go test ./...', '/data/spore-code-benchmark/runs/scb-current'),
    /another benchmark run/
  );
  assert.match(
    localToolTest.commandIsolationViolation(
      'ls /data/spore-code-benchmark/runs/scb-current/.tool-env/',
      '/data/spore-code-benchmark/runs/scb-current',
      '/data/spore-code-benchmark/runs/scb-current/.tool-env/click-option-suggestions'
    ),
    /another benchmark scenario tool environment/
  );
  assert.equal(
    localToolTest.commandIsolationViolation(
      'ls /data/spore-code-benchmark/runs/scb-current/.tool-env/click-option-suggestions/cache',
      '/data/spore-code-benchmark/runs/scb-current',
      '/data/spore-code-benchmark/runs/scb-current/.tool-env/click-option-suggestions'
    ),
    null
  );
  assert.equal(localToolTest.commandIsolationViolation('$SPORE_BENCHMARK_CACHE/toolchains/go/bin/go test ./...', '/data/spore-code-benchmark/runs/scb-current'), null);
  assert.equal(localToolTest.commandLooksDangerous(GO_TEST_COMMAND), false);
});

test('leak scanner detects foreign canaries and session ids', () => {
  const results = [
    {
      scenarioId: 'a',
      sessionId: 'session-a',
      canary: 'SCB_CANARY_A',
      scenario: { taskTitle: 'Task A' },
      transcript: [{ type: 'assistant', text: 'all good' }],
      toolCalls: [],
    },
    {
      scenarioId: 'b',
      sessionId: 'session-b',
      canary: 'SCB_CANARY_B',
      scenario: { taskTitle: 'Task B' },
      transcript: [{ type: 'thinking', text: 'I saw SCB_CANARY_A from session-a' }],
      toolCalls: [],
    },
  ];
  const leakage = scanLeakage(results);
  assert.equal(leakage.ok, false);
  assert.ok(leakage.hits.some(h => h.foreignScenarioId === 'a' && h.kind === 'canary'));
  assert.ok(leakage.hits.some(h => h.foreignScenarioId === 'a' && h.kind === 'sessionId'));
});

test('leak scanner detects cross-run filesystem references in tool results', () => {
  const results = [
    {
      scenarioId: 'a',
      canary: 'SCB_CANARY_scb-2026-05-07T0829-aaaaaaaa_a_abc',
      workDir: '/data/spore-code-benchmark/runs/scb-2026-05-07T0829-aaaaaaaa/a',
      transcript: [],
      toolCalls: [{
        name: 'exec',
        inputText: '{"command":"find /data/spore-code-benchmark -name go"}',
        resultSummary: '/data/spore-code-benchmark/runs/scb-2026-05-07T0623-bbbbbbbb/.tool-env/a/cache/go/bin/go',
      }],
    },
  ];
  const leakage = scanLeakage(results);
  assert.equal(leakage.ok, false);
  assert.ok(leakage.hits.some(h => h.kind === 'foreignRunId' && h.foreignRunId === 'scb-2026-05-07T0623-bbbbbbbb'));
});

test('leak scanner ignores truncated prefixes of the current run id', () => {
  const results = [
    {
      scenarioId: 'a',
      canary: 'SCB_CANARY_scb-2026-05-07T0902-938a0713_a_abc',
      workDir: '/data/spore-code-benchmark/runs/scb-2026-05-07T0902-938a0713/a',
      transcript: [],
      toolCalls: [{
        name: 'read_file',
        resultSummary: '/data/spore-code-benchmark/runs/scb-2026-05-07T0902-93...[truncated]',
      }],
    },
  ];
  assert.equal(scanLeakage(results).ok, true);
});

test('scenario scoring requires completion, changes, and passing verifiers', () => {
  const score = scoreScenario({
    finalText: 'done',
    git: { status: { stdout: '## main\n M src/file.js\n?? tests/file.test.js\n' } },
    verification: { commands: [{ ok: true }, { exitCode: 0 }] },
    toolCalls: [{ name: 'read_file' }],
  });
  assert.equal(score.completed, true);
  assert.equal(score.filesChanged, 2);
  assert.equal(score.likelySuccess, true);
});

test('scenario scoring ignores tool cache artifacts in git status', () => {
  const paths = changedPathsFromStatus('## main\n M src/file.js\n?? .npm/\n?? .cache/\n?? .local/\n?? tests/file.test.js\n');
  assert.deepEqual(paths, ['src/file.js', 'tests/file.test.js']);
  const score = scoreScenario({
    finalText: 'done',
    git: { status: { stdout: '## main\n?? .npm/\n?? .cache/\n' } },
    verification: { commands: [{ ok: true }] },
    toolCalls: [{ name: 'exec' }],
  });
  assert.equal(score.filesChanged, 0);
  assert.equal(score.likelySuccess, false);
});

test('changed file summary includes untracked files and filters artifacts', () => {
  const summary = changedFileSummary({
    stdout: [
      '## main',
      ' M lib/request-id.js',
      'A  test/request-id.test.js',
      'R  old.js -> src/new.js',
      '?? docs/request-id.md',
      '?? .npm/cache/file',
      '?? node_modules/pkg/index.js',
    ].join('\n'),
  });

  assert.equal(summary.count, 4);
  assert.deepEqual(summary.paths, [
    'lib/request-id.js',
    'test/request-id.test.js',
    'src/new.js',
    'docs/request-id.md',
  ]);
  assert.deepEqual(summary.tracked, ['lib/request-id.js', 'test/request-id.test.js', 'src/new.js']);
  assert.deepEqual(summary.untracked, ['docs/request-id.md']);
});

test('verification claim classifier downgrades full-suite claims without full-suite evidence', () => {
  assert.equal(commandScope('npm test -- --grep "[Rr]equest.?[Ii]d"'), 'focused-test');
  assert.equal(commandScope('python -m pytest tests/test_options.py -q'), 'focused-test');
  assert.equal(commandScope('python3 -m pytest tests/ -x'), 'full-test');
  assert.equal(commandScope('python -m pytest tests/ -x'), 'full-test');
  assert.equal(commandScope('pip install --user pytest'), 'command');
  assert.equal(commandScope('go test ./...'), 'full-test');

  const focused = classifyVerificationClaim('All 1256 tests passing.', [
    { command: 'npx mocha test/express.js --grep requestId', ok: true, stdout: '15 passing (31ms)' },
    { command: 'git diff --check', ok: true },
  ]);
  assert.equal(focused.classification, 'overclaimed');
  assert.equal(focused.overclaimed, true);
  assert.match(focused.note, /focused tests/);
  assert.deepEqual(focused.evidence.scopes, ['focused-test', 'lint']);

  const full = classifyVerificationClaim('All tests pass.', [
    { command: 'npm test', ok: true, stdout: '1256 passing (3s)' },
  ]);
  assert.equal(full.classification, 'full');
  assert.equal(full.overclaimed, false);

  const focusedCount = classifyVerificationClaim('All 7 focused request-id tests pass.', [
    { command: 'npx mocha test/req.id.js', ok: true, stdout: '7 passing (28ms)' },
  ]);
  assert.equal(focusedCount.classification, 'focused');
  assert.equal(focusedCount.overclaimed, false);

  const unqualifiedCount = classifyVerificationClaim('All 7 tests pass.', [
    { command: 'npx mocha test/req.id.js', ok: true, stdout: '7 passing (28ms)' },
  ]);
  assert.equal(unqualifiedCount.classification, 'overclaimed');
  assert.equal(unqualifiedCount.overclaimed, true);

  const sessionFullSuite = classifyVerificationClaim('All tests pass.', [
    { command: 'npx mocha test/req.id.js', ok: true, stdout: '7 passing (28ms)' },
  ], {
    toolCalls: [{
      name: 'exec',
      inputText: '{"command":"npm test"}',
      resultSummary: '{"ok":true,"exitCode":0,"stdout":"1256 passing (3s)"}',
    }],
  });
  assert.equal(sessionFullSuite.classification, 'full');
  assert.equal(sessionFullSuite.overclaimed, false);
  assert.equal(sessionFullSuite.sourceBreakdown.toolCommands, 1);

  const honest = classifyVerificationClaim('Focused request-id tests passed.', [
    { command: 'npm test -- --grep request-id', ok: true },
  ]);
  assert.equal(honest.classification, 'focused');
  assert.equal(honest.overclaimed, false);

  const matching = classifyVerificationClaim('All matching suggestion tests passed.', [
    { command: 'python3 -m pytest tests/test_options.py -k "suggest" -v', ok: true, stdout: '8 passed' },
  ]);
  assert.equal(matching.classification, 'focused');
  assert.equal(matching.overclaimed, false);

  const fullPytestDir = classifyVerificationClaim('The full suite passed with no failures.', [
    { command: 'python3 -m pytest tests/ -x', ok: true, stdout: '1495 passed, 4 skipped' },
  ]);
  assert.equal(fullPytestDir.classification, 'full');
  assert.equal(fullPytestDir.overclaimed, false);

  const score = scoreScenario({
    finalText: 'All 1256 tests passing.',
    git: { status: { stdout: ' M lib/request-id.js\n' } },
    verification: { commands: [{ command: 'npx mocha test/express.js --grep requestId', ok: true }] },
    toolCalls: [{ name: 'exec' }],
  });
  assert.equal(score.verificationClaim, 'overclaimed');
  assert.equal(score.verificationOverclaimed, true);
  assert.equal(score.likelySuccess, true);
});

test('setup status separates local setup, already-available repos, and blocked toolchains', () => {
  assert.deepEqual(
    deriveSetupStatus({ dryRun: true }),
    { status: 'not_required', setupCompleted: true, reason: 'dry_run' },
  );
  assert.deepEqual(
    deriveSetupStatus({ verification: { commands: [{ command: 'npm test', ok: true }] }, toolCalls: [] }),
    { status: 'already_available', setupCompleted: true, reason: 'verification_passed_without_setup' },
  );
  assert.deepEqual(
    deriveSetupStatus({
      verification: { commands: [{ command: 'npm test', ok: true }] },
      toolCalls: [{ inputText: 'npm install', resultSummary: 'added 12 packages' }],
    }),
    { status: 'completed', setupCompleted: true, reason: 'local_setup_command_seen' },
  );
  assert.deepEqual(
    deriveSetupStatus({
      verification: { commands: [{ command: 'go test ./...', ok: true, stderr: 'go: command not found\nthen recovered' }] },
      toolCalls: [{ inputText: 'install go into $SPORE_BENCHMARK_CACHE/toolchains/go', resultSummary: 'go test ./... ok' }],
    }),
    { status: 'recovered', setupCompleted: true, reason: 'verification_passed_after_setup_friction' },
  );
  assert.deepEqual(
    deriveSetupStatus({
      verification: { commands: [{ command: 'go test ./...', ok: false, stderr: 'go: command not found' }] },
      toolCalls: [],
    }),
    { status: 'blocked', setupCompleted: false, reason: 'toolchain_or_policy_block' },
  );
});

test('handoff facts preserve changed files, exact verification, and open issues', () => {
  const task = {
    taskId: 'polish',
    userName: 'Devon',
    finalText: 'All tests pass.',
    git: { status: { stdout: ' M lib/request-id.js\n?? test/request-id.test.js\n' } },
    verification: {
      commands: [{
        command: 'npx mocha test/express.js --grep requestId',
        ok: true,
        stdout: '15 passing (31ms)',
      }],
    },
  };
  task.changedFiles = changedFileSummary(task.git.status);
  task.verificationClaim = classifyVerificationClaim(task.finalText, task.verification.commands);
  task.setupStatus = deriveSetupStatus(task);
  const facts = buildHandoffFacts(task);

  assert.deepEqual(facts.changedFiles, ['lib/request-id.js', 'test/request-id.test.js']);
  assert.deepEqual(facts.verification.commands, ['npx mocha test/express.js --grep requestId']);
  assert.deepEqual(facts.verification.observedTestCounts, [15]);
  assert.equal(facts.verificationClaim.overclaimed, true);
  assert.ok(facts.openIssues.includes('verification_claim_overstated'));
});

test('benchmark infers direct verification for changed test files', () => {
  const js = _test.inferChangedTestVerificationCommands(
    '/repo',
    { paths: ['lib/request-id.js', 'test/request-id.test.js'] },
    []
  );
  assert.deepEqual(js, []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-infer-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { mocha: '^10.0.0' } }));
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/request-id.test.js'), '');
  const mocha = _test.inferChangedTestVerificationCommands(
    root,
    { paths: ['lib/request-id.js', 'test/request-id.test.js'] },
    []
  );
  assert.equal(mocha.length, 1);
  assert.match(mocha[0].command, /^npx mocha /);
  assert.match(mocha[0].command, /test\/request-id\.test\.js/);

  const go = _test.inferChangedTestVerificationCommands(root, { paths: ['requestid_test.go'] }, []);
  assert.deepEqual(go.map(c => c.command), ['go test ./...']);

  const coveredPython = _test.inferChangedTestVerificationCommands(
    root,
    { paths: ['tests/test_options.py'] },
    [{ command: 'python3 -m venv "$SPORE_BENCHMARK_CACHE/venv" && python -m pytest tests/test_options.py -q' }]
  );
  assert.deepEqual(coveredPython, []);

  const untrackedDir = _test.inferChangedTestVerificationCommands(
    root,
    { paths: ['test/middleware'] },
    [],
    { untrackedSummary: { files: [{ path: 'test/middleware/request-id.js' }] } }
  );
  assert.equal(untrackedDir.length, 1);
  assert.match(untrackedDir[0].command, /test\/middleware\/request-id\.js/);
});

test('benchmark changed-file summary includes committed task changes', () => {
  const dirty = changedFileSummary('## main\n M lib/express.js\n');
  const committed = _test.changedFileSummaryFromNameStatus('A\ttest/express.request-id.js\nM\tHistory.md\n');
  const merged = _test.mergeChangedFileSummaries(dirty, committed);

  assert.deepEqual(merged.paths, ['History.md', 'lib/express.js', 'test/express.request-id.js']);
  assert.deepEqual(merged.tracked, ['History.md', 'lib/express.js', 'test/express.request-id.js']);
});

test('benchmark infers gofmt checks for changed Go files', () => {
  const specs = _test.inferGoFormatCheckCommands(
    { paths: ['requestid.go', 'requestid_test.go'] },
    []
  );
  assert.equal(specs.length, 1);
  assert.match(specs[0].command, /gofmt -l/);
  assert.match(specs[0].command, /requestid\.go/);

  const alreadyCovered = _test.inferGoFormatCheckCommands(
    { paths: ['requestid.go'] },
    [{ command: 'gofmt -w requestid.go' }]
  );
  assert.deepEqual(alreadyCovered, []);
});

test('verification classifier rejects zero-test and missing-toolchain success', () => {
  const zero = evaluateCommandResult('npm test -- --grep request-id', {
    ok: true,
    exitCode: 0,
    stdout: '0 passing (2ms)',
    stderr: '',
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.failureReason, 'zero_tests');
  assert.equal(zero.semanticOk, false);

  const missing = evaluateCommandResult('go test ./...', {
    ok: false,
    exitCode: 127,
    stdout: '',
    stderr: '/bin/bash: go: command not found',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureReason, 'missing_toolchain');
  assert.equal(missing.infraOk, false);

  const maskedFailure = evaluateCommandResult('python3 -m pytest tests/test_options.py -q', {
    ok: true,
    exitCode: 0,
    stdout: '1 failed, 15 passed in 0.42s',
    stderr: '',
  });
  assert.equal(maskedFailure.ok, false);
  assert.equal(maskedFailure.failureReason, 'test_failure_output');
  assert.equal(maskedFailure.semanticOk, false);
});

test('benchmark runner supports dry-run without websocket or git checkout', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-runner-'));
  const runner = new SporeCodeBenchmarkRunner({
    config: { dataDir: workspaceRoot },
    log: { info() {}, warn() {}, error() {} },
    broadcast() {},
  });
  const report = await runner.run({
    dryRun: true,
    prepareRepos: false,
    runVerification: false,
    maxScenarios: 1,
    workspaceRoot,
  });
  assert.equal(report.results.length, 1);
  assert.equal(report.summary.scenarios, 1);
  assert.equal(report.summary.tasks, 3);
  assert.equal(report.summary.dryRun, true);
  assert.equal(report.summary.completed, 0);
  assert.deepEqual(report.summary.setupStatuses, { not_required: 3 });
  assert.equal(report.summary.verificationOverclaims, 0);
  assert.equal(report.summary.responseRepairs, 0);
  assert.equal(report.results[0].tasks.length, 3);
  assert.equal(report.results[0].setupStatus.status, 'not_required');
  assert.deepEqual(report.results[0].changedFiles.paths, []);
  assert.ok(new Set(report.results[0].tasks.map(t => t.userName)).size >= 3);
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'spore-code-benchmark-results.json')));
});

test('benchmark runner exposes a post-session memory settle hook', async () => {
  const calls = [];
  const runner = new SporeCodeBenchmarkRunner({
    waitForSessionSettle: async args => {
      calls.push(args);
      return { status: 'settled', sessionId: args.sessionId, sessionKey: args.sessionKey };
    },
  });

  const settled = await runner._beginSessionSettle('scb:run:repo:task', {
    scenarioId: 'repo',
    taskId: 'task',
    userName: 'Mara',
    sessionSettleMs: 1234,
    sessionSettleQuietMs: 456,
  });

  assert.equal(settled.status, 'settled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, 'channel:scb:run:repo:task');
  assert.equal(calls[0].timeoutMs, 1234);
  assert.equal(calls[0].quietMs, 456);
});

test('benchmark memory settle reports degraded readiness after distill with pending learner jobs', async () => {
  const jobs = [{ kind: 'learner.extract', sessionKey: 'channel:scb:settle:test', status: 'queued' }];
  const waiter = benchmarkPlugin._test.createSessionSettleWaiter({
    tools: { _jobQueue: { listJobs: () => jobs } },
  }, { warn() {} });
  const promise = waiter({
    sessionId: 'scb:settle:test',
    sessionKey: 'channel:scb:settle:test',
    timeoutMs: 1000,
    quietMs: 30,
  });
  setTimeout(() => {
    graphEvents.emit('change', {
      nodeId: 'session-scb:settle:test',
      op: 'session:summarize-done',
      graph: 'project-test',
    });
    graphEvents.emit('change', {
      nodeId: 'session-scb:settle:test',
      op: 'session:distill-done',
      graph: 'project-test',
    });
  }, 10);

  const settled = await promise;
  assert.equal(settled.status, 'project_ready_shared_done_queue_pending');
  assert.equal(settled.pendingLearnerJobs, 1);
  assert.equal(settled.sawDistillDone, true);
  assert.equal(settled.readiness.projectHandoff, 'ready');
  assert.equal(settled.readiness.sharedDistill, 'done');
  assert.equal(settled.readiness.learnerQueue, 'pending');
});

test('LLM actor can generate initial user prompts from strict JSON', async () => {
  const fakeClient = {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: '{"message":"Can you wire this up in the smallest maintainable way and add focused tests?","intent":"initial implementation"}' }] };
      },
    },
  };
  const task = tasksForScenario(SCENARIOS[0])[0];
  const actorTurn = await generateActorTurn({
    llmClient: fakeClient,
    model: 'planner-test-model',
    scenario: SCENARIOS[0],
    task,
    fallbackPrompt: buildUserPrompt(SCENARIOS[0], { task }),
  });
  assert.equal(actorTurn.source, 'llm');
  assert.match(actorTurn.text, /focused tests/);
});

test('actor prompt carries compact handoff facts into later repo tasks', () => {
  const prompt = buildActorPrompt({
    scenario: SCENARIOS[0],
    task: tasksForScenario(SCENARIOS[0])[1],
    previousTasks: [{
      taskId: 'initial-change',
      userName: 'Mara',
      score: { completed: true, likelySuccess: true, changedPaths: ['lib/request-id.js'], verificationPassed: 1, verificationTotal: 1 },
      handoffFacts: {
        changedFiles: ['lib/request-id.js', 'test/request-id.test.js'],
        verification: { commands: ['npx mocha test/express.js --grep requestId'], observedTestCounts: [15] },
        openIssues: ['verification_claim_overstated'],
      },
      finalText: 'Implemented request ID middleware.',
    }],
    fallbackPrompt: 'Tighten the request ID middleware behavior.',
  });

  assert.match(prompt, /handoffFacts/);
  assert.match(prompt, /lib\/request-id\.js/);
  assert.match(prompt, /verification_claim_overstated/);
});

test('planner experience summary receives all task turns for a repo', async () => {
  let prompt = '';
  const fakeClient = {
    messages: {
      async create(req) {
        prompt = req.messages[0].content;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              overall: 'The agent completed the repo with some handoff friction.',
              outcome: 'mixed',
              what_went_well: ['Used tests'],
              agent_failure_modes: ['Second task did not use prior context enough'],
              memory_and_handoff: 'Handoff was partial.',
              tooling_and_execution: 'Verification was attempted.',
              improvement_points: [{ area: 'memory', problem: 'handoff weak', recommendation: 'wait for distill', severity: 'high' }],
              notable_quotes_or_moments: ['Asked for local smoke command'],
              confidence: 'high',
            }),
          }],
        };
      },
    },
  };

  const out = await summarizeExperienceWithLlm({
    llmClient: fakeClient,
    model: 'planner-test-model',
    scenario: SCENARIOS[0],
    result: {
      tasks: [
        {
          taskId: 'initial-change',
          userName: 'Mara',
          turns: [{ turnIndex: 0, userText: 'add it', assistantText: 'implemented middleware and tests', toolUsage: { read_file: 2 } }],
          finalText: 'done',
          verification: { commands: [{ command: 'npm test', ok: true }] },
          git: { status: { stdout: ' M index.js\n' } },
        },
        {
          taskId: 'handoff-followup',
          userName: 'Devon',
          turns: [{ turnIndex: 0, userText: 'tighten it', assistantText: 'added an edge-case test', toolUsage: { exec: 1 } }],
          memorySettle: { status: 'settled' },
          finalText: 'done',
          verification: { commands: [{ command: 'npm test', ok: true }] },
          git: { status: { stdout: ' M test.js\n' } },
        },
      ],
      finalText: 'done',
      verification: { commands: [{ command: 'npm test', ok: true }] },
      git: { status: { stdout: ' M index.js\n M test.js\n' }, diffStat: { stdout: '2 files changed' } },
      toolCalls: [{ name: 'read_file' }],
    },
  });

  assert.equal(out.outcome, 'mixed');
  assert.match(prompt, /implemented middleware and tests/);
  assert.match(prompt, /added an edge-case test/);
  assert.match(prompt, /improvement_points/);
});

test('planner experience summary repairs malformed JSON once', async () => {
  const replies = [
    '{"overall":"Good but truncated","outcome":"strong","what_went_well":["tests"],',
    JSON.stringify({
      overall: 'Good after repair.',
      outcome: 'strong',
      what_went_well: ['tests'],
      agent_failure_modes: ['none major'],
      memory_and_handoff: 'fine',
      tooling_and_execution: 'fine',
      improvement_points: [],
      notable_quotes_or_moments: [],
      confidence: 'high',
    }),
  ];
  const fakeClient = {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: replies.shift() }] };
      },
    },
  };

  const out = await summarizeExperienceWithLlm({
    llmClient: fakeClient,
    model: 'planner-test-model',
    scenario: SCENARIOS[0],
    result: {
      tasks: [],
      finalText: 'done',
      verification: { commands: [{ command: 'npm test', ok: true }] },
      git: { status: { stdout: ' M index.js\n' }, diffStat: { stdout: '1 file changed' } },
      toolCalls: [{ name: 'exec' }],
    },
  });

  assert.equal(out.outcome, 'strong');
  assert.equal(out.repairedFromParseError, true);
  assert.match(out.originalParseError, /JSON/);
});

test('LLM actor follow-up decides whether task continues or ends', async () => {
  const replies = [
    '{"done":false,"message":"Use the header-preserving approach and add the narrow middleware tests.","intent":"answer clarification","reason":"agent asked for a choice"}',
    '{"done":true,"message":"","intent":"accept result","reason":"implementation and tests are complete"}',
  ];
  const fakeClient = {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: replies.shift() }] };
      },
    },
  };
  const task = tasksForScenario(SCENARIOS[0])[0];
  const continueDecision = await generateActorFollowup({
    llmClient: fakeClient,
    model: 'planner-test-model',
    scenario: SCENARIOS[0],
    task,
    assistantText: 'Should I preserve incoming headers or always generate a new id?',
  });
  assert.equal(continueDecision.done, false);
  assert.match(continueDecision.text, /header-preserving/);

  const doneDecision = await generateActorFollowup({
    llmClient: fakeClient,
    model: 'planner-test-model',
    scenario: SCENARIOS[0],
    task,
    assistantText: 'Implemented, documented, and all focused tests pass.',
  });
  assert.equal(doneDecision.done, true);
  assert.equal(doneDecision.text, '');
});

test('actor JSON/text helpers handle provider response shapes and fallback guidance', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.deepEqual(parseJsonObject('```json\n{"done":true}\n```'), { done: true });
  assert.equal(agentAskedForGuidance('Which API shape do you want?'), true);
  assert.equal(agentAskedForGuidance('Done. Tests passed.'), false);
});

test('live benchmark sessions can use actor answers for ask_user prompts', async () => {
  const sent = [];
  const session = new LiveSporeCodeSession({
    askUserResponder: async msg => `Use option A for ${msg.qid}.`,
  });
  session.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  session._maybeAnswerAskUser({ qid: 'q-1', question: 'Which option?' });
  session._maybeAnswerAskUser({ qid: 'q-1', question: 'Duplicate event' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'ask_user_answer', qid: 'q-1', answer: 'Use option A for q-1.' });
});

test('live benchmark transcript coalesces streamed thinking and assistant deltas', () => {
  const session = new LiveSporeCodeSession();
  session.record('thinking', { delta: true, text: 'Let' });
  session.record('thinking', { delta: true, text: ' me explore' });
  session.record('assistant', { delta: true, text: 'Done' });
  session.record('assistant', { delta: true, text: '.' });
  session.record('assistant', { final: true, text: 'Done.' });

  assert.equal(session.events.length, 5);
  assert.equal(session.transcript.length, 3);
  assert.deepEqual(session.transcript.map(e => e.text), ['Let me explore', 'Done.', 'Done.']);
});

test('stored benchmark report omits raw event and transcript arrays by default', () => {
  const compact = _test.compactReportForStorage({
    runId: 'scb-test',
    options: {},
    results: [{
      scenarioId: 'repo-a',
      transcript: [{ type: 'thinking', text: 'Let me inspect' }, { type: 'assistant', text: 'Done.' }],
      events: [{ rawType: 'chat:thinking' }, { type: 'assistant' }, { type: 'status' }],
      tasks: [{
        taskId: 'task-a',
        turns: [{ userText: 'fix it', assistantText: 'done' }],
        transcript: [{ type: 'thinking', text: 'Let' }, { type: 'thinking', text: ' me inspect' }],
        events: [{ rawType: 'chat:thinking' }, { rawType: 'chat:thinking' }],
      }],
    }],
  });

  assert.equal(compact.reportFormat.mode, 'compact');
  assert.equal('events' in compact.results[0], false);
  assert.equal('transcript' in compact.results[0], false);
  assert.equal('events' in compact.results[0].tasks[0], false);
  assert.equal('transcript' in compact.results[0].tasks[0], false);
  assert.deepEqual(compact.results[0].tasks[0].turns, [{ userText: 'fix it', assistantText: 'done' }]);
  assert.equal(compact.results[0].eventSummary.total, 3);
  assert.equal(compact.results[0].transcriptSummary.byType.thinking, 1);
  assert.equal(compact.results[0].tasks[0].eventSummary.byType['chat:thinking'], 2);

  const compactAgain = _test.compactReportForStorage(compact);
  assert.equal(compactAgain.results[0].eventSummary.total, 3);
  assert.equal(compactAgain.results[0].tasks[0].eventSummary.byType['chat:thinking'], 2);
});

test('mapWithConcurrency enforces the requested limit', async () => {
  let active = 0;
  let maxActive = 0;
  const out = await _test.mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(maxActive <= 2);
});
