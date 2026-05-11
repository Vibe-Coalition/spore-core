'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionManager } = require('../../src/agent/sessions');
const { WorkflowManager } = require('../../src/agent/workflows');
const {
  createChatFlowHarness,
  makeLogger,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');

function createSessionManager(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-workflow-guards-'));
  const logger = makeLogger();
  const sessions = new SessionManager({ sessionDbPath: path.join(dir, 'sessions.db'), maxSessionMessages: 200 }, logger, null);
  assert.equal(sessions.init(), true);
  t.after(() => {
    sessions.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return sessions;
}

test('cli workflow final repairs are private and fall back to evidence after repeat failure', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['edit_file', 'exec', 'git_status'],
    toolResults: {
      edit_file: { ok: true, path: 'lib/request-id.js' },
      exec: { output: '7 passing', exitCode: 0 },
      git_status: { output: '## main\n M lib/express.js\n?? lib/request-id.js\n', exitCode: 0 },
    },
    script: [
      toolResponse('edit_file', {
        path: 'lib/request-id.js',
        old_text: 'module.exports = {};\n',
        new_text: 'module.exports = { requestId: true };\n',
      }, { id: 'toolu_edit_1' }),
      toolResponse('exec', { command: 'npm test -- --grep requestId' }, { id: 'toolu_exec_1' }),
      toolResponse('git_status', {}, { id: 'toolu_status_1' }),
      textResponse('Done. All tests passed.'),
      textResponse('Done. All tests passed.'),
    ],
  });

  const turn = await harness.send('implement the request id plan', {
    sessionKey: 'shared:channel:cli:tester@workflow-guards',
    channelId: 'cli:tester@workflow-guards',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-guards',
      project: 'workflow-guards',
      mode: 'execute',
      source: 'spore-code',
      tools: ['edit_file', 'exec', 'git_status'],
      localTools: ['edit_file', 'exec', 'git_status'],
    },
  });

  assert.match(turn.text, /workflow guard/i);
  assert.match(turn.text, /unsupported full-suite claim/i);
  assert.match(turn.text, /lib\/request-id\.js/);
  assert.match(turn.text, /npm test -- --grep requestId/);
  assert.doesNotMatch(turn.text, /Done\. All tests passed\./);
  assert.deepEqual(turn.events.textDeltas, [turn.text]);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 1);

  const assistantHistory = turn.history.filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.doesNotMatch(assistantHistory, /Done\. All tests passed\./);
  assert.match(assistantHistory, /workflow guard/i);
  assert.deepEqual(turn.modelRequests.at(-1).tools, []);
});

test('agent loop normalizes edit_file blob aliases before local CLI dispatch', async () => {
  let seenInput = null;
  const harness = createChatFlowHarness({
    tools: ['edit_file'],
    toolResults: {
      edit_file: input => {
        seenInput = input;
        return { ok: true, path: input.path };
      },
    },
    script: [
      toolResponse('edit_file', {
        path: 'src/app.ts',
        old_blob: 'const value = 1;',
        new_blob: 'const value = 2;',
      }, { id: 'toolu_edit_aliases' }),
      textResponse('Done.'),
    ],
  });

  const turn = await harness.send('make the edit', {
    sessionKey: 'shared:channel:cli:tester@edit-aliases',
    channelId: 'cli:tester@edit-aliases',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/edit-aliases',
      project: 'edit-aliases',
      mode: 'execute',
      source: 'spore-code',
      tools: ['edit_file'],
      localTools: ['edit_file'],
    },
  });

  assert.equal(seenInput.old_text, 'const value = 1;');
  assert.equal(seenInput.new_text, 'const value = 2;');
  assert.equal(turn.toolCalls[0].input.old_text, 'const value = 1;');
  assert.equal(turn.toolCalls[0].input.new_text, 'const value = 2;');
  assert.equal(turn.text, 'Done.');
});

test('agent loop normalizes common file aliases before local CLI dispatch', async () => {
  const seen = {};
  const harness = createChatFlowHarness({
    tools: ['write_file', 'read_file', 'edit_file', 'exec'],
    toolResults: {
      write_file: input => {
        seen.write = input;
        return { ok: true, path: input.path };
      },
      read_file: input => {
        seen.read = input;
        return { ok: true, content: 'selected lines' };
      },
      edit_file: input => {
        seen.edit = input;
        return { ok: true, path: input.path };
      },
      exec: input => {
        seen.exec = input;
        return { ok: true, output: 'ok' };
      },
    },
    script: [
      toolResponse('write_file', { file_path: 'src/new.ts', text: 'hello\n' }, { id: 'toolu_write_aliases' }),
      toolResponse('read_file', { file: 'src/new.ts', line_start: 10, line_end: 12 }, { id: 'toolu_read_aliases' }),
      toolResponse('edit_file', { filename: 'src/new.ts', old_str: 'hello\n', new_str: 'hi\n' }, { id: 'toolu_edit_str_aliases' }),
      toolResponse('exec', { cmd: 'echo ok' }, { id: 'toolu_exec_aliases' }),
      textResponse('Done.'),
    ],
  });

  const turn = await harness.send('exercise aliases', {
    sessionKey: 'shared:channel:cli:tester@tool-aliases',
    channelId: 'cli:tester@tool-aliases',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/tool-aliases',
      project: 'tool-aliases',
      mode: 'execute',
      source: 'spore-code',
      tools: ['write_file', 'read_file', 'edit_file', 'exec'],
      localTools: ['write_file', 'read_file', 'edit_file', 'exec'],
    },
  });

  assert.equal(seen.write.path, 'src/new.ts');
  assert.equal(seen.write.content, 'hello\n');
  assert.equal(seen.read.path, 'src/new.ts');
  assert.equal(seen.read.offset, 9);
  assert.equal(seen.read.limit, 3);
  assert.equal(seen.edit.path, 'src/new.ts');
  assert.equal(seen.edit.old_text, 'hello\n');
  assert.equal(seen.edit.new_text, 'hi\n');
  assert.equal(seen.exec.command, 'echo ok');
  assert.equal(turn.text, 'Done.');
});

test('agent loop blocks tools still missing required fields after normalization', async () => {
  const harness = createChatFlowHarness({
    toolDefs: [{
      name: 'web_fetch',
      description: 'fetch a url',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    }],
    toolResults: {
      web_fetch: () => {
        throw new Error('web_fetch should not execute when url is missing');
      },
    },
    script: [
      toolResponse('web_fetch', {}, { id: 'toolu_fetch_missing' }),
      textResponse('Blocked because url was missing.'),
    ],
  });

  const turn = await harness.send('fetch it', {
    sessionKey: 'shared:channel:cli:tester@tool-schema-block',
    channelId: 'cli:tester@tool-schema-block',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/tool-schema-block',
      project: 'tool-schema-block',
      mode: 'execute',
      source: 'spore-code',
      tools: ['web_fetch'],
      localTools: ['web_fetch'],
    },
  });

  assert.equal(turn.toolCalls.length, 0);
  const historyText = turn.history
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.match(historyText, /tool_input_missing_required_fields/);
  assert.match(historyText, /`url`/);
  assert.equal(turn.text, 'Blocked because url was missing.');
});

test('cli workflow incomplete checklist continues with tools instead of no-tool final repair', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      workflowIncompleteContinuationLimit: 3,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['workflow_status', 'task_progress', 'edit_file'],
    toolResults: {
      workflow_status: { ok: true, phase: 'execute', tasks: { total: 2, pending: 1, in_progress: 1 } },
    },
    script: [
      textResponse([
        '## Plan',
        '',
        '## Steps',
        '1. Extract agent frame handlers',
        '2. Add focused frame tests',
        '',
        '## Verification',
        '- go test ./internal/app -run TestHandleFrame',
        '',
        'PLAN_READY',
      ].join('\n')),
      textResponse('Done. The whole plan is complete.'),
      toolResponse('workflow_status', {}, { id: 'toolu_workflow_status_1' }),
      textResponse('I am still working through the approved checklist. Next step is extracting the frame handlers.'),
    ],
  });

  const base = {
    sessionKey: 'shared:channel:cli:tester@workflow-incomplete-continue',
    channelId: 'cli:tester@workflow-incomplete-continue',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-incomplete-continue',
      project: 'workflow-incomplete-continue',
      mode: 'plan',
      source: 'spore-code',
      tools: ['workflow_status', 'task_progress', 'edit_file'],
      localTools: ['workflow_status', 'task_progress', 'edit_file'],
    },
  };

  await harness.send('[BUILD_PLAN] Build the approved plan artifact.', base);
  const turn = await harness.send('execute the plan', {
    ...base,
    projectContext: { ...base.projectContext, mode: 'execute' },
  });

  assert.match(turn.text, /still working/i);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 1);
  assert.equal(turn.toolCalls.filter(c => c.name === 'workflow_status').length, 1);
  const continuationRequest = turn.modelRequests[2];
  assert.ok(Array.isArray(continuationRequest.tools));
  assert.notEqual(continuationRequest.tools.length, 0);
  assert.ok(continuationRequest.tools.some(t => t.name === 'workflow_status'));
});

test('cli workflow missing git status repair can run git_status', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['edit_file', 'git_status'],
    toolResults: {
      edit_file: { ok: true, path: 'lib/request-id.js' },
      git_status: { output: '## main\n M lib/request-id.js\n', exitCode: 0 },
    },
    script: [
      toolResponse('edit_file', {
        path: 'lib/request-id.js',
        old_text: 'module.exports = {};\n',
        new_text: 'module.exports = { requestId: true };\n',
      }, { id: 'toolu_edit_1' }),
      textResponse('Done. 1 file changed.'),
      toolResponse('git_status', {}, { id: 'toolu_status_1' }),
      textResponse('Done. `git_status` shows one tracked change: lib/request-id.js. Verification was not run.'),
    ],
  });

  const turn = await harness.send('make the small edit', {
    sessionKey: 'shared:channel:cli:tester@workflow-git-status-repair',
    channelId: 'cli:tester@workflow-git-status-repair',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-git-status-repair',
      project: 'workflow-git-status-repair',
      mode: 'execute',
      source: 'spore-code',
      tools: ['edit_file', 'git_status'],
      localTools: ['edit_file', 'git_status'],
    },
  });

  assert.match(turn.text, /git_status/);
  assert.equal(turn.toolCalls.filter(c => c.name === 'git_status').length, 1);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 1);
  const narrowRepairRequest = turn.modelRequests.find(req => {
    const names = (req.tools || []).map(tool => tool.name);
    return names.length === 1 && names[0] === 'git_status';
  });
  assert.ok(narrowRepairRequest, 'expected a narrow git_status repair request');
});

test('cli workflow blocks verification task done after unresolved failed verification', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-failed-verification';
  const opts = {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-failed-verification',
      project: 'workflow-failed-verification',
      mode: 'plan',
    },
  };

  workflows.ensureForTurn(sessionKey, opts);
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Make the update flow safer',
    '',
    '## Verification',
    '- go test ./...',
    '',
    'PLAN_READY',
  ].join('\n'));
  const created = workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-failed-verification' });
  const verificationTask = created.created.find(task => task.kind === 'verification');
  assert.ok(verificationTask);

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go test ./...' }, { exitCode: 1, output: 'FAIL ./internal/app' });
  const block = workflows.toolBlockForTool(sessionKey, 'task_progress', { id: verificationTask.id, status: 'done' });
  assert.ok(block?.blocked);
  assert.match(block.error, /latest verification evidence is failed/i);

  const issue = workflows.finalRepairIssue(sessionKey, 'Done. All implementation and verification complete.');
  assert.equal(issue.reason, 'failed verification evidence is unresolved');
  assert.equal(issue.allowTools, true);
  assert.ok(issue.toolNames.includes('git_status'));
});

test('cli workflow accepts evidence field when marking unrelated failed verification done', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-unrelated-evidence-field';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-unrelated-evidence-field',
      project: 'workflow-unrelated-evidence-field',
      mode: 'plan',
    },
  });
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Scaffold the app',
    '',
    '## Verification',
    '- npm run build',
    '',
    'PLAN_READY',
  ].join('\n'));
  const created = workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-unrelated-evidence-field' });
  const verificationTask = created.created.find(task => task.kind === 'verification');
  assert.ok(verificationTask);

  workflows.recordToolResult(sessionKey, 'exec', {
    command: 'npx create-next-app@latest . --typescript --tailwind --app',
  }, {
    exitCode: 1,
    output: 'Cannot create a project in a non-empty directory',
  });
  workflows.recordToolResult(sessionKey, 'exec', { command: 'npm run build' }, { exitCode: 0, output: 'Compiled successfully' });

  const block = workflows.toolBlockForTool(sessionKey, 'task_progress', {
    id: verificationTask.id,
    status: 'done',
    reason: 'pre_existing_failure',
    evidence: 'The failed npx create-next-app command was an unrelated setup path. Current npm run build exited 0 with output: Compiled successfully.',
  });
  assert.equal(block, null);
});

test('cli workflow does not treat create-next-app setup failure as unresolved verification', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-create-next-app-setup';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-create-next-app-setup',
      project: 'workflow-create-next-app-setup',
      mode: 'plan',
    },
  });
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Scaffold the app',
    '2. Rewrite the page',
    '',
    '## Verification',
    '- npm run build',
    '',
    'PLAN_READY',
  ].join('\n'));
  workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-create-next-app-setup' });

  workflows.recordToolResult(sessionKey, 'exec', {
    command: 'npx create-next-app@latest . --typescript --tailwind --app --eslint',
  }, {
    exitCode: 1,
    output: 'The directory contains files that could conflict: .spore-code/',
  });
  workflows.recordToolResult(sessionKey, 'exec', {
    command: 'npx create-next-app@latest scaffold-tmp --typescript --tailwind --app --eslint --yes',
  }, {
    exitCode: 0,
    output: 'Creating a new Next.js app in scaffold-tmp.',
  });
  workflows.recordToolResult(sessionKey, 'write_file', { path: 'app/page.tsx', content: 'one' }, { ok: true, path: 'app/page.tsx' });
  workflows.recordToolResult(sessionKey, 'write_file', { path: 'app/page.tsx', content: 'two' }, { ok: true, path: 'app/page.tsx' });
  const status = workflows.recordToolResult(sessionKey, 'write_file', { path: 'app/page.tsx', content: 'three' }, { ok: true, path: 'app/page.tsx' });

  assert.notEqual(status.status, 'recovery');
  assert.notEqual(status.artifacts.recovery?.active, true);
  const block = workflows.toolBlockForTool(sessionKey, 'write_file', { path: 'components/Footer.tsx', content: 'dark footer'.repeat(500) });
  assert.equal(block, null);
});

test('cli workflow repair keeps the answer when the repair turn goes meta', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['exec'],
    toolResults: {
      exec: { output: '7 passing', exitCode: 0 },
    },
    script: [
      toolResponse('exec', { command: 'npm test -- --grep requestId' }, { id: 'toolu_exec_1' }),
      textResponse('Main problems I found:\n- The CLI workflow repair path can hide useful answers.\n- Verification summaries need stricter evidence wording.\n\nAll tests passed.'),
      textResponse("My bad, that was a false trigger on my end. I didn't actually run all tests, so there's nothing to repair."),
    ],
  });

  const turn = await harness.send('what are the main problems with this app', {
    sessionKey: 'shared:channel:cli:tester@workflow-meta-repair',
    channelId: 'cli:tester@workflow-meta-repair',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-meta-repair',
      project: 'workflow-meta-repair',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec'],
      localTools: ['exec'],
    },
  });

  assert.match(turn.text, /Main problems I found/);
  assert.match(turn.text, /workflow repair path can hide useful answers/);
  assert.match(turn.text, /npm test -- --grep requestId/);
  assert.doesNotMatch(turn.text, /false trigger|nothing to repair|my bad/i);
  assert.doesNotMatch(turn.text, /All tests passed/i);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 1);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair_fallback').length, 1);
  assert.deepEqual(turn.modelRequests.at(-1).tools, []);
});

test('cli workflow does not demand git status for no-edit operational exec turns', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 6, warn: 5, critical: 10, budgetPressure: 5 },
    },
    tools: ['exec', 'git_status'],
    toolResults: {
      exec: { output: 'Metro waiting on exp://192.168.1.10:8081\n', exitCode: 0 },
      git_status: { output: '## main\n', exitCode: 0 },
    },
    script: [
      toolResponse('exec', { command: 'npx expo start --lan', background: true }, { id: 'toolu_exec_1' }),
      textResponse('Done. Metro is running and no files were changed.'),
    ],
  });

  const turn = await harness.send('start the server', {
    sessionKey: 'shared:channel:cli:tester@workflow-no-edit',
    channelId: 'cli:tester@workflow-no-edit',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-no-edit',
      project: 'workflow-no-edit',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec', 'git_status'],
      localTools: ['exec', 'git_status'],
    },
  });

  assert.equal(turn.text, 'Done. Metro is running and no files were changed.');
  assert.equal(turn.toolCalls.filter(c => c.name === 'git_status').length, 0);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 0);
});

test('cli workflow does not repair generic already-read context statements', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 4, warn: 5, critical: 10, budgetPressure: 5 },
    },
    tools: ['read_file', 'grep'],
    script: [
      textResponse('I already went through this codebase in this session. The main issues are in the service boundaries and tests.'),
    ],
  });

  const turn = await harness.send('summarize what you learned', {
    sessionKey: 'shared:channel:cli:tester@workflow-already-read',
    channelId: 'cli:tester@workflow-already-read',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-already-read',
      project: 'workflow-already-read',
      mode: 'execute',
      source: 'spore-code',
      tools: ['read_file', 'grep'],
      localTools: ['read_file', 'grep'],
    },
  });

  assert.match(turn.text, /already went through this codebase/);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow_final_repair').length, 0);
  assert.equal(turn.modelRequests.length, 1);
});

test('empty direct tool reply repair is streamed back to cli', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 5, warn: 5, critical: 10, budgetPressure: 5 },
    },
    tools: ['exec'],
    toolResults: {
      exec: { output: 'started background server', exitCode: 0 },
    },
    script: [
      toolResponse('exec', { command: 'npm start', background: true }, { id: 'toolu_exec_1' }),
      textResponse(''),
      textResponse('Server started in the background. I did not capture the QR yet.'),
    ],
  });

  const turn = await harness.send('start the server and print the qr', {
    sessionKey: 'shared:channel:cli:tester@workflow-empty-repair',
    channelId: 'cli:tester@workflow-empty-repair',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-empty-repair',
      project: 'workflow-empty-repair',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec'],
      localTools: ['exec'],
    },
  });

  assert.equal(turn.text, 'Server started in the background. I did not capture the QR yet.');
  assert.deepEqual(turn.events.textDeltas, [turn.text]);
  assert.equal(turn.events.status.filter(s => s.type === 'response_repair' && s.reason === 'empty_tool_reply').length, 1);
  assert.deepEqual(turn.modelRequests.at(-1).tools, []);
});

test('cli workflow recovery keeps turn alive while blocking unsafe edits before status', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['exec', 'write_file', 'git_status'],
    toolResults: {
      exec: { output: '# github.com/example/app\ninternal/app/update_messages.go:22: undefined: termSize', exitCode: 1 },
      write_file: { ok: true, path: 'internal/app/update_messages.go' },
    },
    script: [
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_1' }),
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_2' }),
      toolResponse('write_file', { path: 'internal/app/update_messages.go', content: 'package app\n' }, { id: 'toolu_write_1' }),
      textResponse('The build is in recovery mode. I need git status/diff before editing further.'),
    ],
  });

  const turn = await harness.send('continue the refactor', {
    sessionKey: 'shared:channel:cli:tester@workflow-circuit-breaker',
    channelId: 'cli:tester@workflow-circuit-breaker',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-circuit-breaker',
      project: 'workflow-circuit-breaker',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec', 'write_file', 'git_status'],
      localTools: ['exec', 'write_file', 'git_status'],
    },
  });

  assert.match(turn.text, /recovery mode/i);
  assert.equal(turn.toolCalls.filter(c => c.name === 'exec').length, 2);
  assert.equal(turn.toolCalls.filter(c => c.name === 'write_file').length, 0);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow:recovery_check_failed').length, 1);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow:circuit_breaker').length, 0);
});

test('cli workflow recovery treats git_status outside a git repo as collected status evidence', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['exec', 'git_status'],
    toolResults: {
      exec: { output: '# github.com/example/app\ninternal/app/update_messages.go:22: undefined: termSize', exitCode: 1 },
      git_status: { error: 'exit status 128', output: 'fatal: not a git repository (or any of the parent directories): .git', exitCode: 128 },
    },
    script: [
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_1' }),
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_2' }),
      toolResponse('git_status', {}, { id: 'toolu_status_1' }),
      textResponse('The build still fails, and git_status says this directory is not a git repository.'),
    ],
  });

  const turn = await harness.send('continue the refactor', {
    sessionKey: 'shared:channel:cli:tester@workflow-not-git-repo',
    channelId: 'cli:tester@workflow-not-git-repo',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-not-git-repo',
      project: 'workflow-not-git-repo',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec', 'git_status'],
      localTools: ['exec', 'git_status'],
    },
  });

  assert.match(turn.text, /not a git repository/i);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow:recovery_check_failed').length, 1);
});

test('cli workflow recovery does not turn failed-tool preambles into the final answer', async (t) => {
  const sessions = createSessionManager(t);
  const harness = createChatFlowHarness({
    sessions,
    config: {
      workflowFinalRepairLimit: 1,
      loopDetection: { ceiling: 8, warn: 5, critical: 10, budgetPressure: 6 },
    },
    tools: ['exec'],
    toolResults: {
      exec: { output: '# github.com/example/app\ninternal/app/update_messages.go:22: undefined: termSize', exitCode: 1 },
    },
    script: [
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_1', text: 'Let me check the build.' }),
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_2', text: 'Let me try the build again.' }),
      textResponse('The build still fails. I need to inspect the exact undefined symbol before making a narrow fix.'),
    ],
  });

  const turn = await harness.send('continue the refactor', {
    sessionKey: 'shared:channel:cli:tester@workflow-circuit-breaker-preamble',
    channelId: 'cli:tester@workflow-circuit-breaker-preamble',
    platform: 'cli',
    trigger: 'dm',
    isDm: false,
    projectContext: {
      cwd: '/work/workflow-circuit-breaker-preamble',
      project: 'workflow-circuit-breaker-preamble',
      mode: 'execute',
      source: 'spore-code',
      tools: ['exec'],
      localTools: ['exec'],
    },
  });

  assert.match(turn.text, /build still fails/i);
  assert.doesNotMatch(turn.text, /Let me try the build again/i);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow:recovery_check_failed').length, 1);
  assert.equal(turn.events.status.filter(s => s.type === 'workflow:circuit_breaker').length, 0);
});

test('cli workflow recovery blocks broad writes until status evidence is collected', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-recovery-block';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: 'C:\\Users\\yam\\repo',
      project: 'workflow-recovery-block',
      mode: 'execute',
      os: 'windows',
      defaultShell: 'cmd.exe',
    },
  });

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./...' }, { exitCode: 1, output: 'first failure' });
  workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./...' }, { exitCode: 1, output: 'second failure' });

  const blockedBeforeStatus = workflows.toolBlockForTool(sessionKey, 'edit_file', {
    path: 'internal/app/update.go',
    old_text: 'a',
    new_text: 'b',
  });
  assert.ok(blockedBeforeStatus?.blocked);
  assert.equal(blockedBeforeStatus.reason, 'workflow_recovery_requires_status');

  const blockedReadBeforeStatus = workflows.toolBlockForTool(sessionKey, 'read_file', {
    path: 'internal/app/update.go',
    offset: 1,
    limit: 400,
  });
  assert.ok(blockedReadBeforeStatus?.blocked);
  assert.equal(blockedReadBeforeStatus.reason, 'workflow_recovery_requires_status');

  const statusAllowed = workflows.toolBlockForTool(sessionKey, 'git_status', {});
  assert.equal(statusAllowed, null);

  workflows.recordToolResult(sessionKey, 'git_status', {}, { exitCode: 0, output: '## main\n M internal/app/update.go\n' });

  const blockedDuplicateVerification = workflows.toolBlockForTool(sessionKey, 'exec', {
    command: 'go build ./...',
  });
  assert.ok(blockedDuplicateVerification?.blocked);
  assert.equal(blockedDuplicateVerification.reason, 'workflow_recovery_duplicate_verification');

  const blockedLargeWrite = workflows.toolBlockForTool(sessionKey, 'write_file', {
    path: 'internal/app/update_messages.go',
    content: 'x'.repeat(3000),
  });
  assert.ok(blockedLargeWrite?.blocked);
  assert.equal(blockedLargeWrite.reason, 'workflow_recovery_large_write');

  const narrowEdit = workflows.toolBlockForTool(sessionKey, 'edit_file', {
    path: 'internal/app/update.go',
    old_text: 'a',
    new_text: 'b',
  });
  assert.equal(narrowEdit, null);

  workflows.recordToolResult(sessionKey, 'edit_file', {
    path: 'internal/app/update.go',
    old_text: 'a',
    new_text: 'b',
  }, { ok: true, path: 'internal/app/update.go' });

  const verificationAfterEdit = workflows.toolBlockForTool(sessionKey, 'exec', {
    command: 'go build ./...',
  });
  assert.equal(verificationAfterEdit, null);
});

test('cli workflow context pressure activates recovery after failed verification', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-context-pressure-recovery';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-context-pressure-recovery',
      project: 'workflow-context-pressure-recovery',
      mode: 'execute',
    },
  });

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./...' }, { exitCode: 1, output: 'build failed' });
  const status = workflows.recordContextPressure(sessionKey, {
    level: 1,
    usedPercent: 71,
    totalTokens: 85000,
    limitTokens: 120000,
  });

  assert.equal(status.artifacts.recovery.active, true);
  assert.equal(status.artifacts.recovery.reason, 'context_pressure_after_failed_verification');
  assert.equal(status.phase, 'debug');
  assert.equal(status.status, 'recovery');

  const blocked = workflows.toolBlockForTool(sessionKey, 'read_file', {
    path: 'internal/app/update.go',
    limit: 400,
  });
  assert.ok(blocked?.blocked);
  assert.equal(blocked.reason, 'workflow_recovery_requires_status');
});

test('cli workflow blocks POSIX shell fragments in Windows exec', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-windows-shell';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: 'C:\\Users\\yam\\repo',
      project: 'workflow-windows-shell',
      mode: 'execute',
      os: 'windows',
      defaultShell: 'cmd.exe',
    },
  });

  const block = workflows.toolBlockForTool(sessionKey, 'exec', {
    command: 'go build ./... 2>&1 | head -20',
  });
  assert.ok(block?.blocked);
  assert.equal(block.reason, 'windows_posix_command');
  assert.match(block.error, /head/);
});

test('cli workflow broad successful Go build resolves narrower failed build recovery', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-recovery-resolve-broad';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-recovery-resolve-broad',
      project: 'workflow-recovery-resolve-broad',
      mode: 'execute',
    },
  });

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./internal/app' }, { exitCode: 1, output: 'undefined: foo' });
  let status = workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./internal/app' }, { exitCode: 1, output: 'undefined: foo' });
  assert.equal(status.artifacts.recovery.active, true);

  workflows.recordToolResult(sessionKey, 'git_status', {}, { exitCode: 0, output: '## main\n M internal/app/foo.go\n' });
  status = workflows.recordToolResult(sessionKey, 'exec', { command: 'go build ./...' }, { exitCode: 0, output: '' });
  assert.equal(status.artifacts.recovery.active, false);
  assert.equal(status.phase, 'execute');
  assert.equal(status.status, 'active');
  workflows.recordToolResult(sessionKey, 'exec', { command: 'gofmt -w internal/app/foo.go' }, { exitCode: 0, output: '' });

  status = workflows.recordToolResult(sessionKey, 'task_progress', { id: 'wf-test', status: 'done' }, { ok: true });
  assert.equal(status.artifacts.recovery.active, false);
  assert.equal(workflows.finalRepairIssue(sessionKey, 'Done. The build is passing.'), null);
});

test('cli workflow blocks duplicate task_create rows for approved plan tasks', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-duplicate-tasks';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-duplicate-tasks',
      project: 'workflow-duplicate-tasks',
      mode: 'plan',
    },
  });
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Wire reconnect behavior into websocket client',
    '',
    '## Verification',
    '- go test ./internal/app',
    '',
    'PLAN_READY',
  ].join('\n'));
  workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-duplicate-tasks' });

  const block = workflows.toolBlockForTool(sessionKey, 'task_create', {
    title: 'Wire reconnect into ws client',
    description: 'Track reconnect behavior in the websocket client.',
  });
  assert.ok(block?.blocked);
  assert.equal(block.reason, 'duplicate_workflow_task');
  assert.match(block.error, /task_progress/);

  const status = workflows.getStatus(sessionKey);
  assert.ok(status.currentTask?.id);
  assert.equal(status.workflowTaskIds.length, 2);
});

test('cli workflow protects WIP from destructive git commands', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-protected-wip';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-protected-wip',
      project: 'workflow-protected-wip',
      mode: 'execute',
    },
  });
  const status = workflows.recordToolResult(sessionKey, 'git_status', {}, {
    exitCode: 0,
    output: '## main\n M README.md\n?? scratch.txt\n',
  });
  assert.deepEqual(status.artifacts.protectedWipPaths.paths, ['README.md', 'scratch.txt']);

  const block = workflows.toolBlockForTool(sessionKey, 'exec', { command: 'git restore README.md' });
  assert.ok(block?.blocked);
  assert.equal(block.reason, 'git_restore');
  assert.match(block.error, /Destructive git command/);
});

test('cli workflow blocks repeated stale edit_file payloads until a fresh read', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-stale-edit';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-stale-edit',
      project: 'workflow-stale-edit',
      mode: 'execute',
    },
  });

  workflows.recordToolResult(sessionKey, 'edit_file', {
    path: 'internal/app/model.go',
    old_text: 'old stale text',
    new_text: 'new text',
  }, { error: 'old_text not found in file. Use read_file to check the exact content.' });

  const block = workflows.toolBlockForTool(sessionKey, 'edit_file', {
    path: 'internal/app/model.go',
    old_text: 'old stale text',
    new_text: 'new text',
  });
  assert.ok(block?.blocked);
  assert.equal(block.reason, 'stale_edit_retry');

  workflows.recordToolResult(sessionKey, 'read_file', { path: 'internal/app/model.go' }, { ok: true, content: 'current text' });
  const retry = workflows.toolBlockForTool(sessionKey, 'edit_file', {
    path: 'internal/app/model.go',
    old_text: 'old stale text',
    new_text: 'new text',
  });
  assert.equal(retry, null);
});

test('cli workflow blocks invented patch_file structured edit schema', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-patch-schema';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-patch-schema',
      project: 'workflow-patch-schema',
      mode: 'execute',
    },
  });

  const block = workflows.toolBlockForTool(sessionKey, 'patch_file', {
    path: 'src/app.ts',
    edit_type: 'replace',
    line_start: 10,
    line_end: 12,
    edits: [{ old_text: 'before', new_text: 'after' }],
  });

  assert.ok(block?.blocked);
  assert.equal(block.reason, 'patch_file_requires_unified_diff');
  assert.match(block.error, /unified diff/);
  assert.match(block.error, /edit_file/);
});

test('cli workflow treats foreground exec background handoff as pending, not failed', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-bg-pending';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-bg-pending',
      project: 'workflow-bg-pending',
      mode: 'execute',
    },
  });

  const status = workflows.recordToolResult(sessionKey, 'exec', { command: 'go test ./...' }, {
    output: 'running tests...',
    exitCode: -1,
    timedOut: true,
    backgrounded: true,
    pending: true,
    running: true,
    processId: 3,
    note: 'Foreground exec moved to background. Use bg_tail with id 3.',
  });

  assert.equal(status.phase, 'execute');
  assert.equal(status.status, 'active');
  assert.equal(status.artifacts.recovery?.active, undefined);
  const evidence = workflows.get(sessionKey).evidence.at(-1);
  assert.equal(evidence.pending, true);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.testCommand, false);
});

test('cli workflow records bg_tail final exit as the actual verification failure', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-bg-tail-final';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-bg-tail-final',
      project: 'workflow-bg-tail-final',
      mode: 'execute',
    },
  });

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go test ./...' }, {
    output: 'running tests...',
    exitCode: -1,
    backgrounded: true,
    pending: true,
    running: true,
    processId: 4,
  });
  const status = workflows.recordToolResult(sessionKey, 'bg_tail', { id: 4 }, {
    ok: true,
    running: false,
    exitCode: 1,
    command: 'go test ./...',
    output: 'FAIL ./internal/app',
  });

  assert.equal(status.phase, 'debug');
  const evidence = workflows.get(sessionKey).evidence.at(-1);
  assert.equal(evidence.tool, 'bg_tail');
  assert.equal(evidence.command, 'go test ./...');
  assert.equal(evidence.ok, false);
  assert.equal(evidence.testCommand, true);
  const issue = workflows.finalRepairIssue(sessionKey, 'Done. All verification complete.');
  assert.equal(issue.reason, 'failed verification evidence is unresolved');
});

test('cli workflow infers old-client bg_tail command from pending exec id', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-bg-tail-infer-command';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-bg-tail-infer-command',
      project: 'workflow-bg-tail-infer-command',
      mode: 'execute',
    },
  });

  workflows.recordToolResult(sessionKey, 'exec', { command: 'go test ./...' }, {
    output: 'running tests...',
    exitCode: -1,
    backgrounded: true,
    processId: 7,
  });
  workflows.recordToolResult(sessionKey, 'bg_tail', { id: 7 }, {
    ok: true,
    id: 7,
    running: false,
    exitCode: 1,
    output: 'FAIL ./internal/app',
  });

  const evidence = workflows.get(sessionKey).evidence.at(-1);
  assert.equal(evidence.command, 'go test ./...');
  assert.equal(evidence.testCommand, true);
  const issue = workflows.finalRepairIssue(sessionKey, 'Done. All verification complete.');
  assert.equal(issue.reason, 'failed verification evidence is unresolved');
});

test('cli workflow treats running bg_tail output as pending even when command is a test', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-bg-tail-running';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-bg-tail-running',
      project: 'workflow-bg-tail-running',
      mode: 'execute',
    },
  });

  const status = workflows.recordToolResult(sessionKey, 'bg_tail', { id: 5 }, {
    ok: true,
    id: 5,
    running: true,
    exitCode: 0,
    command: 'go test ./...',
    output: 'still running',
  });

  assert.equal(status.phase, 'execute');
  const evidence = workflows.get(sessionKey).evidence.at(-1);
  assert.equal(evidence.pending, true);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.testCommand, false);
  assert.equal(workflows.finalRepairIssue(sessionKey, 'Still running; I will keep tailing it.'), null);
});

test('cli workflow blocks duplicate in_progress and unrelated concurrent workflow tasks', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-task-progression';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-task-progression',
      project: 'workflow-task-progression',
      mode: 'plan',
    },
  });
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Update API client',
    '2. Update UI state',
    '',
    '## Verification',
    '- npm test',
    '',
    'PLAN_READY',
  ].join('\n'));
  const created = workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-task-progression' });
  const steps = created.created.filter(task => task.kind === 'step');
  assert.equal(steps.length, 2);

  sessions.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(steps[0].id);

  const duplicate = workflows.toolBlockForTool(sessionKey, 'task_progress', { id: steps[0].id, status: 'in_progress' });
  assert.ok(duplicate?.blocked);
  assert.equal(duplicate.reason, 'task_already_in_progress');

  const concurrent = workflows.toolBlockForTool(sessionKey, 'task_progress', { id: steps[1].id, status: 'in_progress' });
  assert.ok(concurrent?.blocked);
  assert.equal(concurrent.reason, 'another_task_in_progress');
});

test('cli workflow accepts evidence-backed pre-existing blocked verification tasks', (t) => {
  const sessions = createSessionManager(t);
  const workflows = new WorkflowManager(sessions, makeLogger());
  const sessionKey = 'shared:channel:cli:tester@workflow-preexisting-blocked';
  workflows.ensureForTurn(sessionKey, {
    platform: 'cli',
    projectContext: {
      cwd: '/work/workflow-preexisting-blocked',
      project: 'workflow-preexisting-blocked',
      mode: 'plan',
    },
  });
  workflows.recordFinalText(sessionKey, {}, [
    '## Steps',
    '1. Make the requested edit',
    '',
    '## Verification',
    '- go test ./...',
    '',
    'PLAN_READY',
  ].join('\n'));
  const created = workflows.ensureExecutionTasks(sessionKey, { channelId: 'cli:tester@workflow-preexisting-blocked' });
  const [step] = created.created.filter(task => task.kind === 'step');
  const verification = created.created.find(task => task.kind === 'verification');
  sessions.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(step.id);
  sessions.db.prepare("UPDATE tasks SET status='blocked', result=? WHERE id=?")
    .run('reason=pre_existing_failure evidence=go test ./... failed in internal/app/input_test.go before this change; git_diff shows no edits there', verification.id);

  workflows.recordToolResult(sessionKey, 'bg_tail', { id: 9 }, {
    ok: true,
    running: false,
    exitCode: 1,
    command: 'go test ./...',
    output: 'FAIL internal/app/input_test.go',
  });
  const issue = workflows.finalRepairIssue(sessionKey, 'Done. Implementation is complete. `go test ./...` still fails due to a pre-existing failure in internal/app/input_test.go; git_diff shows no edits there.');
  assert.equal(issue, null);

  const status = workflows.recordFinalText(sessionKey, {}, 'Done. Implementation is complete. `go test ./...` still fails due to a pre-existing failure in internal/app/input_test.go; git_diff shows no edits there.');
  assert.equal(status.phase, 'complete');
  assert.equal(status.status, 'complete');
});

test('verify_implementation tool results compact to top failures for model context', () => {
  const harness = createChatFlowHarness();
  const results = Array.from({ length: 700 }, (_, i) => ({
    qname: `pkg.Symbol${i}`,
    file: `src/file${i}.ts`,
    line: i + 1,
    kind: 'function',
    exists: true,
    substantive: true,
    wired: i % 10 !== 0,
    export_level: i % 10 !== 0,
    callers_count: i % 10 === 0 ? 0 : 1,
    notes: i % 10 === 0 ? ['no callers', 'unwired symbol'] : [],
  }));
  const result = { ok: true, count: results.length, passed: 630, failed: 70, results };
  const raw = JSON.stringify(result);

  const compacted = harness.agent._compactVisualToolResultForModel('verify_implementation', {}, result, raw);
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.reason, 'verify_implementation_summary');
  assert.ok(compacted.content.length < raw.length / 4);
  const parsed = JSON.parse(compacted.content);
  assert.equal(parsed.failed, 70);
  assert.equal(parsed.topFailures.length, 20);
  assert.equal(parsed.samplePasses.length, 8);
  assert.equal(parsed.compactedForModelContext, true);
});
