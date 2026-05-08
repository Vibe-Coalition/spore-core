'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ToolSystem } = require('../../src/tools/tools');
const { GraphContext } = require('../../src/graph/context');
const { applyPromptSectionsMixin } = require('../../src/graph/prompt-sections');

function makeTools() {
  return new ToolSystem(
    { workspacePath: process.cwd(), webPort: 18803 },
    { info() {}, warn() {}, error() {}, debug() {} },
    null,
    null,
    null,
  );
}

class PromptHarness {
  constructor() {
    this.config = {
      model: 'test-model',
      workspacePath: process.cwd(),
      graphDbPath: ':memory:',
      webPort: 18803,
    };
    this._sharedGraphs = [];
    this.log = { warn() {}, debug() {} };
  }

  getNodesByTypeSelf() { return []; }
  getNode() { return null; }
}
applyPromptSectionsMixin(PromptHarness);

test('cli plan mode hides local execution and write tools from the catalog', () => {
  const tools = makeTools();
  tools._pluginManager = {
    getToolDefinitions() {
      return [
        { name: 'browser', description: 'browser', input_schema: { type: 'object' } },
        { name: 'plugin_allowed', description: 'allowed', input_schema: { type: 'object' } },
      ];
    },
  };
  const names = tools.getToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'plan' },
  }).map(t => t.name);

  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('glob'));
  assert.ok(!names.includes('exec'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('web_serve'));
  assert.ok(!names.includes('browser'));
  assert.ok(!names.includes('env_manage'));
  assert.ok(!names.includes('settings_read'));
  assert.ok(!names.includes('save_tool'));
  assert.ok(!names.includes('analyze_media'));
  assert.ok(!names.includes('session_status'));
  assert.ok(!names.includes('schedule_wakeup'));
  assert.ok(!names.includes('log_watch'));
  assert.ok(names.includes('plugin_allowed'));

  const serialized = JSON.stringify(tools.getToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'execute' },
  }));
  assert.doesNotMatch(serialized, /\/workspace|\/data\/graphs|\/app\//);
});

test('cli execute mode still hides the web browser tool from the catalog', () => {
  const tools = makeTools();
  tools._pluginManager = {
    getToolDefinitions() {
      return [{ name: 'browser', description: 'browser', input_schema: { type: 'object' } }];
    },
  };
  const names = tools.getToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'execute' },
  }).map(t => t.name);

  assert.ok(!names.includes('browser'));
});

test('cli sessions hide and block webapp_request', async () => {
  const tools = makeTools();
  tools.gateway = { _server: {} };

  const webNames = tools.getToolDefinitions({ platform: 'web' }).map(t => t.name);
  const cliNames = tools.getToolDefinitions({
    platform: 'cli',
    projectContext: { mode: 'execute' },
  }).map(t => t.name);

  assert.ok(webNames.includes('webapp_request'));
  assert.ok(!cliNames.includes('webapp_request'));

  const result = await tools.executeTool(
    'webapp_request',
    { method: 'GET', path: '/' },
    { platform: 'cli', projectContext: { mode: 'execute' } },
  );
  assert.equal(result.blocked, true);
  assert.match(result.error, /unavailable in Spore Code CLI sessions/);
});

test('cli runtime prompt does not advertise hosted webapp_request', () => {
  const graph = new PromptHarness();
  const prompt = graph._buildRuntimeSection({
    platform: 'cli',
    webappStatus: {
      active: true,
      port: 3000,
      hasBackend: true,
      users: [{ user: 'test-user' }],
    },
  });

  assert.doesNotMatch(prompt, /Hosted Webapp/);
  assert.doesNotMatch(prompt, /webapp_request/);
  assert.doesNotMatch(prompt, /Workspace:/);
  assert.doesNotMatch(prompt, /\/workspace/);
  assert.doesNotMatch(prompt, /Active process graph DB/);
});

test('cli prompt omits global tooling section', () => {
  const graph = new PromptHarness();
  assert.equal(graph._buildToolingSection({ platform: 'cli', projectContext: { cwd: 'C:\\repo' } }), null);
});

test('scoped reusable skill brief redacts shared memory runtime paths', () => {
  const graph = new GraphContext(
    { graphDbPath: ':memory:' },
    { info() {}, warn() {}, error() {}, debug() {} },
  );
  const brief = graph._buildScopedSkillBrief([
    {
      id: 'ref-api-keys',
      label: 'API Keys',
      type: 'reference',
      description: 'Internal /workspace details',
      aspects: [{ name: 'how_to', attributes: [{ content: 'Use /workspace' }] }],
    },
    {
      id: 'qrcode-npm',
      label: 'qrcode',
      type: 'library',
      description: 'Generate terminal QR codes.',
      aspects: [
        { name: 'recommended_usage', attributes: [{ content: 'Serve SVG via /workspace/web/ or use base64 data URI inline.' }] },
        { name: 'reusable_lessons', attributes: [{ content: 'npm package qrcode from project-123 (source: project-123 / session-cli:x)' }] },
      ],
    },
  ], 'print a QR code');

  assert.match(brief, /qrcode/);
  assert.doesNotMatch(brief, /ref-api-keys|\/workspace|session-cli/);
  assert.match(brief, /project-accessible static directory/);
});

test('cli local tools cannot fall back to server execution', async () => {
  const tools = makeTools();
  const result = await tools.executeTool(
    'exec',
    { command: 'echo should-not-run' },
    { platform: 'cli', projectContext: { mode: 'execute', cwd: 'C:\\repo' } },
  );

  assert.equal(result.blocked, true);
  assert.equal(result.cliLocalOnly, true);
  assert.match(result.error, /connected Spore Code CLI executor/);
});

test('cli graph discovery is scoped to project and reusable memory graphs', async () => {
  const tools = makeTools();
  tools.graph = {};
  tools._graphRegistry = {
    getActiveSlug: () => 'project-demo',
    getGeneralKnowledgeSlug: () => 'spore-knowledge-base',
    list: () => [
      { slug: 'default', name: 'Default', role: 'main', active: false },
      { slug: 'project-demo', name: 'Demo Project', role: 'project', active: true },
      { slug: 'user-test-user', name: 'test-user', role: 'user', active: false },
      { slug: 'channel-telegram', name: 'Telegram', role: 'channel', active: false },
      { slug: 'spore-knowledge-base', name: 'General Knowledge', role: 'general_kb', active: false },
    ],
  };

  const result = await tools.executeTool(
    'graph_query',
    { mode: 'graphs' },
    {
      platform: 'cli',
      memoryEnvelope: {
        primarySlug: 'project-demo',
        readScopes: [
          { slug: 'project-demo', role: 'project' },
          { slug: 'spore-knowledge-base', role: 'general_kb' },
        ],
        writeScopes: { defaultSlug: 'project-demo' },
      },
    },
  );

  assert.deepEqual(result.graphs.map(g => g.slug).sort(), ['project-demo', 'spore-knowledge-base']);
  assert.ok(!result.graphs.some(g => g.slug === 'default'));
  assert.ok(!result.graphs.some(g => g.role === 'user' || g.role === 'channel'));
});

test('cli general knowledge query hides internal refs and redacts runtime paths', async () => {
  const tools = makeTools();
  const nodes = {
    'ref-api-keys': { id: 'ref-api-keys', label: 'API Keys', type: 'reference', description: 'Internal paths: /workspace and /app/' },
    'qrcode-npm': {
      id: 'qrcode-npm',
      label: 'qrcode',
      type: 'library',
      description: 'Generate terminal QR codes.',
      aspects: [{
        name: 'pitfalls',
        attributes: [{ content: 'For web chat display, generate SVG and serve via /workspace/web/ or use base64 data URI inline.' }],
      }],
    },
  };
  tools.graph = {
    getNode: id => nodes[id] || null,
    getEdges: () => [{ source: 'qrcode-npm', target: 'ref-api-keys', type: 'mentions' }],
    getNodesByType: type => Object.values(nodes).filter(n => n.type === type),
  };

  const hidden = await tools._graphQueryDefault({ nodeId: 'ref-api-keys' }, 'spore-knowledge-base', { cliGeneralKb: true });
  assert.match(hidden.error, /not found/);

  const refs = await tools._graphQueryDefault({ type: 'reference' }, 'spore-knowledge-base', { cliGeneralKb: true });
  assert.equal(refs.total, 0);

  const shown = await tools._graphQueryDefault({ nodeId: 'qrcode-npm' }, 'spore-knowledge-base', { cliGeneralKb: true });
  const serialized = JSON.stringify(shown);
  assert.equal(shown.node.id, 'qrcode-npm');
  assert.doesNotMatch(serialized, /\/workspace|\/app|ref-api-keys/);
  assert.match(serialized, /project-accessible static directory/);
});

test('cli plan mode blocks execution/write tools before dispatch', () => {
  const tools = makeTools();
  const ctx = { platform: 'cli', projectContext: { mode: 'plan' } };

  assert.equal(tools.planModeBlockForTool('read_file', { path: 'package.json' }, ctx), null);

  const execBlock = tools.planModeBlockForTool('exec', { command: 'npm start' }, ctx);
  assert.equal(execBlock.blocked, true);
  assert.equal(execBlock.planMode, true);
  assert.match(execBlock.error, /read-only/);

  const writeBlock = tools.planModeBlockForTool('write_file', { path: 'x', content: 'y' }, ctx);
  assert.equal(writeBlock.blocked, true);
});

test('cli execute mode does not block execution tools', () => {
  const tools = makeTools();
  const ctx = { platform: 'cli', projectContext: { mode: 'execute' } };

  assert.equal(tools.planModeBlockForTool('exec', { command: 'npm start' }, ctx), null);
  assert.equal(tools.planModeBlockForTool('write_file', { path: 'x', content: 'y' }, ctx), null);
});
