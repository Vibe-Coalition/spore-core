'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createChatFlowHarness,
  requestText,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');
const { PlannerAdvisor } = require('../../src/agent/planner-advisor');

function advisorJson(patch = {}) {
  return textResponse(JSON.stringify({
    reason: 'complex coding turn',
    risk: 'medium',
    goal: 'Keep the lower-tier model focused on evidence before edits.',
    constraints: ['Check the repository state before making claims.'],
    next_actions: ['Inspect relevant files first.', 'Use exact verification commands in the final response.'],
    avoid: ['Do not claim full-suite verification unless it actually ran.'],
    verification: ['Report only commands that were observed passing.'],
    escalate_to_planner: false,
    ...patch,
  }));
}

function cliOpts(patch = {}) {
  return {
    platform: 'cli',
    trigger: 'dm',
    userRole: 'cli',
    projectContext: {
      cwd: '/repo',
      project: 'test-repo',
      mode: 'execute',
      hasCodeIndex: true,
      ...patch.projectContext,
    },
    ...patch,
  };
}

function config(patch = {}) {
  return {
    model: 'cheap-model',
    casualModel: 'cheap-model',
    normalModel: 'cheap-model',
    plannerModel: 'planner-model',
    plannerAdvisor: {
      enabled: true,
      mode: 'adaptive',
      maxInputTokens: 4000,
      maxOutputTokens: 700,
      cooldownIterations: 2,
      allowEscalation: true,
    },
    plugins: {
      'spore-code': {},
    },
    ...patch,
  };
}

test('planner advisor injects hidden guidance for a non-trivial Spore Code task by default', async () => {
  const harness = createChatFlowHarness({
    config: config(),
    script: [
      advisorJson(),
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.match(requestText(request), /Planner Advisor Guidance/);
        assert.match(requestText(request), /Inspect relevant files first/);
        return textResponse('I will inspect the relevant files first.');
      },
    ],
  });

  const turn = await harness.send('fix the failing tests and verify them', cliOpts());

  assert.equal(harness.model.requests.length, 2);
  assert.equal(harness.model.requests[0].model, 'planner-model');
  assert.deepEqual(harness.model.requests[0].tools, []);
  assert.equal(harness.model.requests[1].model, 'cheap-model');
  assert.ok(turn.events.status.some(e => e.type === 'planner:advice'));
});

test('legacy Spore Code planner toggle disables automatic planner guidance', async () => {
  const harness = createChatFlowHarness({
    config: config({
      plugins: {
        'spore-code': { plannerAdvisorExtendedUsage: false },
      },
    }),
    script: [
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.doesNotMatch(requestText(request), /Planner Advisor Guidance/);
        return textResponse('No advisor used.');
      },
    ],
  });

  const turn = await harness.send('fix the failing tests and verify them', cliOpts());

  assert.equal(harness.model.requests.length, 1);
  assert.ok(!turn.events.status.some(e => e.type === 'planner:advice'));
  assert.ok(turn.events.status.some(e => e.type === 'planner:skipped' && e.reason === 'spore_code_policy_off'));
});

test('Spore Code manual planner policy skips automatic guidance', async () => {
  const harness = createChatFlowHarness({
    config: config({
      plugins: {
        'spore-code': { plannerAdvisorPolicy: 'manual' },
      },
    }),
    script: [
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.doesNotMatch(requestText(request), /Planner Advisor Guidance/);
        return textResponse('Manual policy did not inject hidden advice.');
      },
    ],
  });

  const turn = await harness.send('fix the failing tests and verify them', cliOpts());

  assert.equal(harness.model.requests.length, 1);
  assert.ok(!turn.events.status.some(e => e.type === 'planner:advice'));
  assert.ok(turn.events.status.some(e => e.type === 'planner:skipped' && e.reason === 'spore_code_policy_manual'));
});

test('planner advisor skips when planner resolves to the same lower-tier model', async () => {
  const harness = createChatFlowHarness({
    config: config({
      plannerModel: 'cheap-model',
    }),
    script: [
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.doesNotMatch(requestText(request), /Planner Advisor Guidance/);
        return textResponse('Same model, no advisor call.');
      },
    ],
  });

  const turn = await harness.send('fix the failing tests and verify them', cliOpts());

  assert.equal(harness.model.requests.length, 1);
  assert.ok(turn.events.status.some(e => e.type === 'planner:skipped' && e.reason === 'same_model'));
});

test('planner advisor re-enters after repeated tool failures and guides recovery', async () => {
  const harness = createChatFlowHarness({
    config: config(),
    tools: ['exec'],
    toolResults: {
      exec: () => ({ error: 'command failed: missing script', exitCode: 1 }),
    },
    script: [
      advisorJson({ reason: 'task start' }),
      toolResponse('exec', { command: 'npm test -- missing' }, { id: 'toolu_exec_1' }),
      toolResponse('exec', { command: 'npm test -- missing' }, { id: 'toolu_exec_2' }),
      advisorJson({
        reason: 'same exec failure twice',
        risk: 'high',
        next_actions: ['Stop retrying the same command.', 'Inspect package.json scripts and choose a valid verification command.'],
        avoid: ['Do not run the same failing command a third time.'],
      }),
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.match(requestText(request), /Stop retrying the same command/);
        return textResponse('The same command failed twice; I will inspect package.json before trying again.');
      },
    ],
  });

  const turn = await harness.send('run the tests and fix what fails', cliOpts());

  assert.equal(harness.model.requests.length, 5);
  assert.equal(harness.model.requests[0].model, 'planner-model');
  assert.equal(harness.model.requests[3].model, 'planner-model');
  assert.equal(turn.events.status.filter(e => e.type === 'planner:advice').length, 2);
});

test('planner advisor can escalate the executing turn to the planner model', async () => {
  const harness = createChatFlowHarness({
    config: config(),
    script: [
      advisorJson({
        reason: 'high-risk synthesis required',
        risk: 'high',
        next_actions: ['Synthesize the migration carefully before touching files.'],
        escalate_to_planner: true,
      }),
      request => {
        assert.equal(request.model, 'planner-model');
        assert.match(requestText(request), /Escalation: run this turn on the planner model/);
        return textResponse('I will handle this with the planner model.');
      },
    ],
  });

  const turn = await harness.send('plan and implement a risky migration', cliOpts());

  assert.equal(harness.model.requests.length, 2);
  assert.equal(harness.model.requests[0].model, 'planner-model');
  assert.equal(harness.model.requests[1].model, 'planner-model');
  assert.ok(turn.events.status.some(e => e.type === 'planner:escalated'));
});

test('planner advisor injects deterministic fallback guidance for malformed planner output', async () => {
  const harness = createChatFlowHarness({
    config: config(),
    script: [
      textResponse('not json at all'),
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.match(requestText(request), /Planner Advisor Guidance/);
        assert.match(requestText(request), /deterministic fallback guidance/i);
        assert.match(requestText(request), /workflow evidence/i);
        return textResponse('I will ground the next step in current workflow evidence.');
      },
    ],
  });

  const turn = await harness.send('fix the failing tests and verify them', cliOpts());

  assert.equal(harness.model.requests.length, 2);
  const event = turn.events.status.find(e => e.type === 'planner:advice');
  assert.ok(event);
  assert.equal(event.fallback, true);
  assert.equal(event.malformed, true);
});

test('planner advisor fallback preserves useful raw diagnostics', async () => {
  const harness = createChatFlowHarness({
    config: config(),
    script: [
      textResponse('The edit failures are wrong parameter names: use old_text/new_text, not old_blob/new_blob.'),
      request => {
        const body = requestText(request);
        assert.equal(request.model, 'cheap-model');
        assert.match(body, /Planner raw diagnostic/i);
        assert.match(body, /wrong parameter names/i);
        assert.match(body, /old_text\/new_text/i);
        return textResponse('I will retry the edit with old_text and new_text.');
      },
    ],
  });

  const turn = await harness.send('continue fixing the edit failures', cliOpts());

  assert.equal(harness.model.requests.length, 2);
  assert.ok(turn.events.status.some(e => e.type === 'planner:advice' && e.fallback === true));
});

test('planner advisor repeated-failure trigger ignores failures resolved by a later broad check', async () => {
  const base = config();
  const harness = createChatFlowHarness({
    config: config({ plannerAdvisor: { ...base.plannerAdvisor, cooldownIterations: 0 } }),
    tools: ['exec'],
    toolResults: {
      exec: ({ command }) => {
        if (command === 'go build ./internal/app') return { error: 'undefined: foo', exitCode: 1 };
        return { output: 'ok', exitCode: 0 };
      },
    },
    script: [
      advisorJson({ reason: 'task start' }),
      toolResponse('exec', { command: 'go build ./internal/app' }, { id: 'toolu_exec_1' }),
      toolResponse('exec', { command: 'go build ./internal/app' }, { id: 'toolu_exec_2' }),
      advisorJson({
        reason: 'same build failure twice',
        next_actions: ['Stop retrying the same command and run the broader build after a relevant fix.'],
      }),
      toolResponse('exec', { command: 'go build ./...' }, { id: 'toolu_exec_3' }),
      request => {
        assert.equal(request.model, 'cheap-model');
        return textResponse('`go build ./...` now passes.');
      },
    ],
  });

  const turn = await harness.send('run the build and fix what fails', cliOpts());

  assert.equal(harness.model.requests.filter(r => r.model === 'planner-model').length, 2);
  assert.equal(turn.events.status.filter(e => e.type === 'planner:advice').length, 2);
});

test('aggressive Spore Code planner policy performs a final review after substantial tool work', async () => {
  const harness = createChatFlowHarness({
    config: config({
      plugins: {
        'spore-code': { plannerAdvisorPolicy: 'aggressive' },
      },
    }),
    tools: ['exec'],
    toolResults: {
      exec: { output: 'ok  ./...\n', exitCode: 0 },
    },
    script: [
      advisorJson({ reason: 'task start' }),
      toolResponse('exec', { command: 'go test ./...' }, { id: 'toolu_exec_1' }),
      textResponse('Done. Everything is good.'),
      advisorJson({
        reason: 'final review',
        next_actions: ['Revise the final answer to name the exact verification command.'],
        avoid: ['Do not say "everything is good" without evidence.'],
        verification: ['Mention `go test ./...` passed.'],
      }),
      request => {
        assert.equal(request.model, 'cheap-model');
        assert.match(requestText(request), /Planner final review/);
        assert.match(requestText(request), /go test \.\/\.\.\./);
        return textResponse('Done. `go test ./...` passed.');
      },
    ],
  });

  const turn = await harness.send('fix this and verify it', cliOpts());

  assert.equal(harness.model.requests.length, 5);
  assert.equal(harness.model.requests[0].model, 'planner-model');
  assert.equal(harness.model.requests[3].model, 'planner-model');
  assert.equal(turn.text, 'Done. `go test ./...` passed.');
  assert.ok(turn.events.status.some(e => e.type === 'planner:advice' && e.phase === 'final_review'));
});

test('planner advisor triggers on long noisy Spore Code sessions before hard context pressure', () => {
  const advisor = new PlannerAdvisor(config(), console);
  const opts = cliOpts({ content: 'continue the implementation' });
  const toolLog = Array.from({ length: 52 }, (_, i) => ({
    tool: 'exec',
    input: JSON.stringify({ command: `echo ${i}` }),
    resultPreview: 'ok',
    resultChars: 80,
    succeeded: true,
    exitCode: 0,
  }));
  toolLog.push({
    tool: 'verify_implementation',
    input: JSON.stringify({ paths: ['internal/app/foo.go'] }),
    resultPreview: '{"count":500}',
    resultChars: 47000,
    succeeded: true,
    exitCode: null,
  });

  const decision = advisor.shouldAdvise({
    sessionKey: 'shared:channel:cli:tester@long-noisy',
    opts,
    activeModel: 'cheap-model',
    plannerModel: 'planner-model',
    iteration: 44,
    toolLog,
    tokenState: { usedPercent: 48 },
  });

  assert.equal(decision.run, true);
  assert.ok(decision.reasons.some(r => r.startsWith('long_session')));
  assert.ok(decision.reasons.some(r => r.startsWith('many_tools')));
  assert.ok(decision.reasons.some(r => r.startsWith('early_context_pressure')));
  assert.ok(decision.reasons.some(r => r.startsWith('large_tool_result:verify_implementation')));
});

test('planner advisor detects repeated file reads and ignores pending background handoffs as failures', () => {
  const advisor = new PlannerAdvisor(config({ plannerAdvisor: { ...config().plannerAdvisor, cooldownIterations: 0 } }), console);
  const opts = cliOpts({ content: 'continue the implementation' });
  const toolLog = [
    { tool: 'read_file', input: JSON.stringify({ path: 'src/app.ts' }), resultPreview: 'a', resultChars: 100, succeeded: true },
    { tool: 'read_file', input: JSON.stringify({ path: 'src/app.ts' }), resultPreview: 'b', resultChars: 100, succeeded: true },
    { tool: 'exec', input: JSON.stringify({ command: 'go test ./...' }), resultPreview: 'pending', resultChars: 100, succeeded: true, exitCode: -1, pending: true },
    { tool: 'read_file', input: JSON.stringify({ path: 'src/app.ts' }), resultPreview: 'c', resultChars: 100, succeeded: true },
  ];

  const decision = advisor.shouldAdvise({
    sessionKey: 'shared:channel:cli:tester@repeated-read',
    opts,
    activeModel: 'cheap-model',
    plannerModel: 'planner-model',
    iteration: 10,
    toolLog,
    tokenState: { usedPercent: 20 },
  });

  assert.equal(decision.run, true);
  assert.ok(decision.reasons.some(r => r.startsWith('repeated_read:src/app.ts')));
  assert.ok(!decision.reasons.some(r => r.startsWith('repeated_failure')));
});
