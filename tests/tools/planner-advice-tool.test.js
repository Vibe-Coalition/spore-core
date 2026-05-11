'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ToolSystem } = require('../../src/tools/tools');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function modelClient(requests) {
  return {
    messages: {
      create: async (request) => {
        requests.push(request);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              reason: 'agent is stuck',
              risk: 'medium',
              goal: 'Change strategy using the evidence already collected.',
              constraints: ['Do not repeat the same failing command.'],
              next_actions: ['Read the exact output artifact before claiming it cannot be displayed.'],
              avoid: ['Do not hand the task back without trying the available local tools.'],
              verification: ['Report the exact command or file content used as proof.'],
              escalate_to_planner: false,
            }),
          }],
          usage: { input_tokens: 20, output_tokens: 30 },
        };
      },
    },
  };
}

test('request_planner_advice runs planner model in Spore Code sessions', async () => {
  const requests = [];
  const events = [];
  const tools = new ToolSystem({
    plannerAdvisor: {
      enabled: true,
      mode: 'adaptive',
      maxInputTokens: 4000,
      maxOutputTokens: 700,
      cooldownIterations: 2,
      allowEscalation: true,
    },
    plugins: { 'spore-code': { plannerAdvisorExtendedUsage: true } },
  }, logger(), null, null, modelClient(requests));
  tools._wsBroadcast = (key, msg) => {
    events.push({ key, msg });
    return 1;
  };
  tools._sessions = {
    getHistory: () => [
      { role: 'user', content: 'start expo and print the qr code' },
      { role: 'assistant', content: 'The QR output is getting stripped.' },
    ],
  };

  const result = await tools.executeTool('request_planner_advice', {
    goal: 'Print the Expo QR code in chat',
    current_blocker: 'QR-shaped output is being compacted before the model can paste it.',
    what_i_tried: 'Generated QR with qrcode and read it back from a scratch file.',
    evidence: 'Tool result says Visual/QR-like terminal output omitted from model context.',
  }, {
    sessionKey: 'channel:cli:test',
    channelId: 'cli:test',
    platform: 'cli',
    userId: 'yam',
    userMessage: 'nuh i want you to do it',
    projectContext: { mode: 'execute', cwd: '/repo', project: 'repo' },
    modelRoutingOverride: { models: { normal: 'cheap-model', planner: 'planner-model' } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'planner-model');
  assert.match(result.guidance, /Planner Advisor Guidance/);
  assert.match(result.guidance, /Read the exact output artifact/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'planner-model');
  assert.match(JSON.stringify(requests[0]), /QR-shaped output is being compacted/);
  assert.ok(events.some(e => e.msg.type === 'chat:status' && e.msg.status === 'planner:advice' && e.msg.requestedBy === 'agent'));
});

test('request_planner_advice is gated out of non-cli sessions', async () => {
  const tools = new ToolSystem({}, logger(), null, null, modelClient([]));

  const result = await tools.executeTool('request_planner_advice', {
    goal: 'Need help',
    current_blocker: 'Stuck',
  }, {
    sessionKey: 'dm:yam',
    platform: 'web',
  });

  assert.equal(result.blocked, true);
  assert.match(result.error, /only available inside Spore Code/);
});
