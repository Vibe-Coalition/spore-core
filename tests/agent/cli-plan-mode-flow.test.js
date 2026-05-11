'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionManager } = require('../../src/agent/sessions');
const {
  createChatFlowHarness,
  makeLogger,
  requestText,
  textResponse,
  toolResponse,
} = require('../support/chat-flow');

function createSessionManager(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-plan-flow-'));
  const logger = makeLogger();
  const sessions = new SessionManager({ sessionDbPath: path.join(dir, 'sessions.db'), maxSessionMessages: 200 }, logger, null);
  assert.equal(sessions.init(), true);
  t.after(() => {
    sessions.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return sessions;
}

test('cli plan research turns repair markerless stale greetings after tool work', async () => {
  const harness = createChatFlowHarness({
    prompt: [
      'You are a Spore Code agent.',
      '## Plan Mode',
      'Research turns must end with RESEARCH_DONE.',
      'QUESTIONS:',
      'PLAN_READY',
    ].join('\n'),
    tools: ['read_file'],
    toolResults: {
      read_file: { content: 'export function debounce() {}', path: 'src/utils.ts' },
    },
    script: [
      toolResponse('read_file', { path: 'src/utils.ts' }, {
        id: 'toolu_read_1',
        text: 'reading the relevant source',
      }),
      textResponse("hey test-user. what's up?"),
      textResponse('RESEARCH_DONE:\nsummary: inspected source and found the improvement targets.'),
    ],
  });

  const turn = await harness.send('[RESEARCH] Interview answers - proceed to research+code phase.', {
    sessionKey: 'channel:cli:test-user@test-project',
    channelId: 'cli:test-user@test-project',
    platform: 'cli',
    trigger: 'mention',
    isDm: false,
    projectContext: {
      cwd: '/work/test-project',
      project: 'test-project',
      mode: 'plan',
      source: 'spore-code',
      tools: ['read_file'],
      localTools: ['read_file'],
    },
  });

  assert.match(turn.text, /^RESEARCH_DONE:/);
  assert.equal(harness.model.requests.length, 3);
  assert.match(requestText(harness.model.requests[1]), /PLAN MODE CONTINUATION ANCHOR/);
  assert.match(requestText(harness.model.requests[1]), /Do not answer an earlier greeting/);
  assert.match(requestText(harness.model.requests[2]), /Plan Mode output repair/);
  assert.match(requestText(harness.model.requests[2]), /This is the RESEARCH turn/);
  assert.deepEqual(turn.toolCalls.map(c => c.name), ['read_file']);
  const persistedAssistantText = turn.history
    .filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.doesNotMatch(persistedAssistantText, /hey test-user/i);
  assert.match(persistedAssistantText, /RESEARCH_DONE:/);
});

test('cli plan research artifacts are workflow state, not visible chat history', async (t) => {
  const sessions = createSessionManager(t);
  const learner = {
    calls: [],
    setLLMBusy() {},
    async extractAndLearn(...args) {
      this.calls.push(args);
    },
  };
  const harness = createChatFlowHarness({
    sessions,
    learner,
    config: { learningMode: 'always' },
    prompt: (opts = {}) => [
      'You are a Spore Code agent.',
      '## Plan Mode',
      'Use Runtime Workflow State when it contains captured research.',
      opts.workflowStatus?.artifacts?.researchDonePreview
        ? `Captured RESEARCH_DONE artifact:\n${opts.workflowStatus.artifacts.researchDonePreview}`
        : '',
    ].filter(Boolean).join('\n'),
    script: [
      textResponse('RESEARCH_DONE:\nsummary: inspected source and found the request-id middleware targets.'),
      textResponse('## Approach\nUse the captured target list.\n\n## Steps\n1. Add middleware\n\n## Verification\n- run focused tests\n\nPLAN_READY'),
    ],
  });

  const baseOpts = {
    sessionKey: 'channel:cli:test-user@plan-artifacts',
    channelId: 'cli:test-user@plan-artifacts',
    platform: 'cli',
    trigger: 'mention',
    isDm: false,
    suppressLearning: false,
    projectContext: {
      cwd: '/work/plan-artifacts',
      project: 'plan-artifacts',
      mode: 'plan',
      source: 'spore-code',
      tools: [],
      localTools: [],
    },
  };

  const researchTurn = await harness.send('[RESEARCH] Interview answers - proceed to research+code phase.', baseOpts);
  assert.match(researchTurn.text, /^RESEARCH_DONE:/);
  assert.equal(researchTurn.result.hiddenWorkflowControl, 'research_done');
  assert.equal(researchTurn.events.completions[0]?.meta?.hiddenWorkflowControl, 'research_done');
  assert.deepEqual(researchTurn.events.textDeltas, []);
  assert.equal(learner.calls.length, 0);

  const visibleAfterResearch = researchTurn.history
    .filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.doesNotMatch(visibleAfterResearch, /RESEARCH_DONE:/);

  const buildTurn = await harness.send('[BUILD_PLAN] Use the captured research to build the plan.', baseOpts);
  assert.match(buildTurn.text, /PLAN_READY/);
  assert.deepEqual(buildTurn.events.textDeltas, [buildTurn.text]);
  assert.equal(learner.calls.length, 1);
  assert.match(requestText(harness.model.requests[1]), /Captured RESEARCH_DONE artifact:/);
  assert.match(requestText(harness.model.requests[1]), /request-id middleware targets/);

  const visibleAfterBuild = buildTurn.history
    .filter(m => m.role === 'assistant')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
    .join('\n');
  assert.doesNotMatch(visibleAfterBuild, /RESEARCH_DONE:/);
  assert.match(visibleAfterBuild, /PLAN_READY/);
});

test('cli plan router controls are workflow state, not visible chat history', async (t) => {
  const cases = [
    {
      name: 'no interview',
      response: 'NO_INTERVIEW_NEEDED: scope is concrete and repo stack is known',
      kind: 'no_interview_needed',
      user: 'make a plan for the bug fix',
    },
    {
      name: 'no followup',
      response: 'NO_FOLLOWUP_QUESTIONS: research found one clear implementation path',
      kind: 'no_followup_questions',
      user: '[REVIEW] Review captured research.',
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (st) => {
      const sessions = createSessionManager(st);
      const learner = {
        calls: [],
        setLLMBusy() {},
        async extractAndLearn(...args) {
          this.calls.push(args);
        },
      };
      const harness = createChatFlowHarness({
        sessions,
        learner,
        config: { learningMode: 'always' },
        prompt: 'You are a Spore Code agent.\n## Plan Mode',
        script: [textResponse(tc.response)],
      });

      const turn = await harness.send(tc.user, {
        sessionKey: `channel:cli:test-user@${tc.name.replace(/\s+/g, '-')}`,
        channelId: `cli:test-user@${tc.name.replace(/\s+/g, '-')}`,
        platform: 'cli',
        trigger: 'mention',
        isDm: false,
        suppressLearning: false,
        projectContext: {
          cwd: `/work/${tc.name.replace(/\s+/g, '-')}`,
          project: tc.name,
          mode: 'plan',
          source: 'spore-code',
          tools: [],
          localTools: [],
        },
      });

      assert.equal(turn.result.hiddenWorkflowControl, tc.kind);
      assert.equal(turn.events.completions[0]?.meta?.hiddenWorkflowControl, tc.kind);
      assert.deepEqual(turn.events.textDeltas, []);
      assert.equal(learner.calls.length, 0);

      const visibleHistory = turn.history
        .filter(m => m.role === 'assistant')
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n');
      assert.doesNotMatch(visibleHistory, /NO_INTERVIEW_NEEDED:/);
      assert.doesNotMatch(visibleHistory, /NO_FOLLOWUP_QUESTIONS:/);
    });
  }
});
