'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../../src/agent/sessions');
const {
  createChatFlowHarness,
  requestText,
  textResponse,
} = require('../support/chat-flow');

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function makeSessionManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spore-reconnect-'));
  const sessions = new SessionManager({
    dataDir,
    sessionDbPath: path.join(dataDir, 'sessions.db'),
    maxSessionMessages: 200,
  }, logger(), null);
  assert.equal(sessions.init(), true);
  return { sessions, dataDir };
}

test('new cli turn after reconnect trims dangling tool tail before prompting model', async () => {
  const { sessions } = makeSessionManager();
  const sessionKey = 'channel:cli:yam@spore-test';

  sessions.addMessage(sessionKey, 'user', 'debug the Go build until it passes');
  sessions.addMessage(sessionKey, 'assistant', [
    {
      type: 'tool_use',
      id: 'toolu_stale_fix',
      name: 'exec',
      input: {
        command: 'C:\\Users\\yam\\repo\\.spore-code\\scratch\\fix-toolchain.cmd',
        timeout: 300000,
      },
    },
  ]);
  assert.equal(sessions.hasDanglingAssistantToolUse(sessionKey), true);

  const harness = createChatFlowHarness({
    sessions,
    prompt: 'You are a Spore Code agent.',
    tools: [],
    script: [
      (req) => {
        const seen = requestText(req);
        assert.match(seen, /PRIORITY/);
        assert.match(seen, /just git push your changes/);
        assert.doesNotMatch(seen, /fix-toolchain/i);
        return textResponse('I will commit and push the current changes.');
      },
    ],
  });

  try {
    const turn = await harness.send("just git push your changes and I'll compile it on another machine", {
      sessionKey,
      channelId: 'cli:yam@spore-test',
      channelName: 'spore-test',
      platform: 'cli',
      trigger: 'dm',
      isDm: false,
      userId: 'yam',
      userName: 'yam',
      userRole: 'cli',
      projectContext: {
        cwd: 'C:\\Users\\yam\\repo',
        project: 'spore-test',
        mode: 'execute',
        source: 'spore-code',
      },
    });

    assert.equal(turn.text, 'I will commit and push the current changes.');
    assert.equal(sessions.hasDanglingAssistantToolUse(sessionKey), false);
    assert.ok(sessions.getMessageCount(sessionKey) < 12);
  } finally {
    sessions.close();
  }
});

