#!/usr/bin/env node
/**
 * test.js — SPORE Test Suite
 * 
 * Tests the graph context engine, session manager, and prompt building
 * without requiring Discord or Claude API connections.
 * 
 * Usage: node test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { loadConfig, loadConfigFresh, resetConfigCache, createLogger } = require('./config');
const { GraphContext } = require('./graph');
const { SessionManager } = require('./agent');
const { ToolSystem } = require('./tools');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ ${testName}`);
    failed++;
  }
}

function assertContains(text, needle, testName) {
  assert(text.includes(needle), testName);
}

async function runTests() {
  console.log('\nSpore Core Test Suite\n');
  
  resetConfigCache();
  const pre = loadConfigFresh();
  const graphDir = path.dirname(pre.graphDbPath);
  if (!fs.existsSync(graphDir)) fs.mkdirSync(graphDir, { recursive: true });
  if (!fs.existsSync(pre.graphDbPath)) {
    const seedSql = fs.readFileSync(path.join(__dirname, 'seed-graph.sql'), 'utf8')
      .replace(/AGENT_ID/g, 'spore')
      .replace(/AGENT_NAME/g, 'Spore Core');
    const tmpSeed = path.join(os.tmpdir(), 'spore-test-seed.sql');
    fs.writeFileSync(tmpSeed, seedSql);
    try {
      execSync(`sqlite3 "${pre.graphDbPath}" < "${tmpSeed}"`, { stdio: 'pipe' });
    } catch (e) {
      console.error('\nTests need sqlite3 and a seedable graph path. Install sqlite3, or run:\n');
      console.error(`  sed -e 's/AGENT_ID/spore/g' -e "s/AGENT_NAME/Spore Core/g" seed-graph.sql | sqlite3 "${pre.graphDbPath}"\n`);
      process.exit(1);
    }
  }

  resetConfigCache();
  const config = loadConfig();
  const log = createLogger('error'); // Quiet during tests
  
  // Override session DB path for testing
  config.sessionDbPath = '/tmp/spore-test-sessions.db';
  
  // ── Test 1: Config Loading ──────────────────────────────────────────────
  
  console.log('Config:');
  assert(config.model, 'Model is configured');
  assert(config.graphDbPath, 'Graph DB path is configured');
  assert(config.maxSessionMessages > 0, 'Max session messages is positive');
  assert(config.healthPort > 0, 'Health port is configured');
  
  // ── Test 2: Graph Context Engine ────────────────────────────────────────
  
  console.log('\nGraph Context Engine:');
  const graph = new GraphContext(config, log);
  const initOk = graph.init();
  assert(initOk, 'Graph context engine initializes');
  
  // Test node retrieval (agent identity node)
  const agentId = config.agentId || 'spore';
  const agentNode = graph.getNode(agentId);
  assert(agentNode !== null, 'Can retrieve agent node');
  assert(agentNode.label !== undefined, 'Agent node has a label');
  assert(agentNode.aspects.length > 0, 'Agent node has aspects');
  
  // Test identity aspect
  const identity = agentNode.aspects.find(a => a.name === 'identity');
  assert(identity !== null, 'Agent has identity aspect');
  assert(identity.attributes.length > 0, 'Identity aspect has attributes');
  
  // Test voice aspect
  const voice = agentNode.aspects.find(a => a.name === 'voice');
  assert(voice !== null, 'Agent has voice aspect');
  
  // Test hard rules aspect
  const rules = agentNode.aspects.find(a => a.name === 'hard_rules');
  assert(rules !== null, 'Agent has hard_rules aspect');
  assert(rules.attributes.length >= 5, 'Has multiple hard rules');
  
  // Test channel awareness
  const channels = agentNode.aspects.find(a => a.name === 'channel_awareness');
  assert(channels !== null, 'Agent has channel_awareness aspect');
  
  // Test node search
  const searchResults = graph.searchNodes(agentNode.label);
  assert(searchResults.length > 0, 'Can search for agent by name');
  
  // Test getNodesByType
  const personNodes = graph.getNodesByType('person');
  assert(personNodes.length > 5, 'Found multiple person nodes');
  
  const channelNodes = graph.getNodesByType('channel');
  assert(channelNodes.length > 0, 'Found channel nodes');
  
  const ruleNodes = graph.getNodesByType('rule');
  assert(ruleNodes.length > 0, 'Found rule nodes');
  
  // ── Test 3: System Prompt Building ──────────────────────────────────────
  
  console.log('\nSystem Prompt Building:');
  
  // Test basic prompt
  const basicPrompt = graph.buildSystemPrompt({});
  assert(basicPrompt.length > 500, 'System prompt has substantial content');
  assertContains(basicPrompt, 'Identity', 'Prompt contains Identity section');
  assertContains(basicPrompt, 'Identity', 'Prompt has identity content');
  assertContains(basicPrompt, 'Voice', 'Prompt contains Voice section');
  assertContains(basicPrompt, 'Rules', 'Prompt contains Rules section');
  assertContains(basicPrompt, 'Channel Awareness', 'Prompt contains Channel Awareness');
  assertContains(basicPrompt, 'Anti-Patterns', 'Prompt contains Anti-Patterns');
  assertContains(basicPrompt, 'Available Tools', 'Prompt contains tool descriptions');
  assertContains(basicPrompt, 'Spore Core', 'Prompt identifies as Spore Core');
  
  // Test prompt with channel context
  const channelPrompt = graph.buildSystemPrompt({
    channelId: 'test-channel-123',
    channelName: 'general',
    userName: 'TestUser',
    userId: 'test-user-456',
    guildName: 'Test Guild',
  });
  assert(channelPrompt.length >= basicPrompt.length, 'Channel-specific prompt includes context');
  
  // Test prompt with media-only channel
  const mediaPrompt = graph.buildSystemPrompt({
    channelId: 'test-media-channel-789',
    channelName: 'media-only',
  });
  assert(mediaPrompt.length > 0, 'Media-only prompt generates content');
  
  // ── Test 4: Session Manager ─────────────────────────────────────────────
  
  console.log('\nSession Manager:');
  const sessions = new SessionManager(config, log);
  const sessInit = sessions.init();
  assert(sessInit, 'Session manager initializes');
  
  // Test session creation
  const testKey = 'channel:test-123';
  sessions.addMessage(testKey, 'user', 'Hello there');
  sessions.addMessage(testKey, 'assistant', 'Hello! How can I help?');
  sessions.addMessage(testKey, 'user', 'What is the graph?');
  
  const history = sessions.getHistory(testKey);
  assert(history.length === 3, 'Session has 3 messages');
  assert(history[0].role === 'user', 'First message is from user');
  assert(history[1].role === 'assistant', 'Second message is from assistant');
  
  // Test session key building
  const channelKey = SessionManager.buildKey('12345', false, null);
  assert(channelKey === 'channel:12345', 'Channel session key format correct');
  
  const dmKey = SessionManager.buildKey('12345', true, '67890');
  assert(dmKey === 'dm:67890', 'DM session key format correct');
  
  // Test message count
  const count = sessions.getMessageCount(testKey);
  assert(count === 3, 'Message count is correct');
  
  // Test session metadata
  const meta = sessions.getSessionMeta(testKey);
  assert(meta !== null, 'Session metadata exists');
  assert(meta.messageCount === 3, 'Metadata message count matches');
  
  // Test session listing
  const allSessions = sessions.listSessions();
  assert(allSessions.length >= 1, 'Session listing works');
  
  // Test session clear
  sessions.clearSession(testKey);
  const clearedCount = sessions.getMessageCount(testKey);
  assert(clearedCount === 0, 'Session cleared successfully');
  
  // ── Test 5: Tool System ─────────────────────────────────────────────────
  
  console.log('\nTool System:');
  const tools = new ToolSystem(config, log, null, graph);
  
  const toolDefs = tools.getToolDefinitions();
  assert(toolDefs.length >= 5, 'Has at least 5 tool definitions');
  
  const toolNames = toolDefs.map(t => t.name);
  assert(toolNames.includes('exec'), 'Has exec tool');
  assert(toolNames.includes('message_send'), 'Has message_send tool');
  assert(toolNames.includes('message_read'), 'Has message_read tool');
  assert(toolNames.includes('graph_query'), 'Has graph_query tool');
  assert(toolNames.includes('graph_update'), 'Has graph_update tool');
  
  // Test exec tool
  const execResult = await tools.executeTool('exec', { command: 'echo hello' });
  assert(execResult.output?.trim() === 'hello', 'Exec tool runs commands');
  
  // Test dangerous command blocking
  const dangerResult = await tools.executeTool('exec', { command: 'sudo rm -rf /' });
  assert(dangerResult.error, 'Dangerous commands are blocked');
  
  // Test graph query tool
  const queryResult = await tools.executeTool('graph_query', { query: agentId });
  assert(queryResult.nodes?.length > 0, 'Graph query returns results');
  
  // Test graph query by node ID
  const nodeResult = await tools.executeTool('graph_query', { nodeId: agentId });
  assert(nodeResult.node !== undefined, 'Graph query by ID works');
  
  // Test graph query by type
  const typeResult = await tools.executeTool('graph_query', { type: 'rule' });
  assert(typeResult.nodes?.length > 0, 'Graph query by type works');
  
  // Test message chunking
  const longText = 'a'.repeat(5000);
  const chunks = tools._chunkMessage(longText);
  assert(chunks.length >= 3, 'Long messages are chunked');
  assert(chunks.every(c => c.length <= 2000), 'All chunks fit Discord limit');
  
  // ── Cleanup ─────────────────────────────────────────────────────────────
  
  sessions.close();
  graph.close();
  
  // Remove test DB
  try {
    require('fs').unlinkSync('/tmp/spore-test-sessions.db');
    require('fs').unlinkSync('/tmp/spore-test-sessions.db-wal');
    require('fs').unlinkSync('/tmp/spore-test-sessions.db-shm');
  } catch (e) { console.warn('[test] require failed: ' + e.message); }
  
  // ── Results ─────────────────────────────────────────────────────────────
  
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    console.log('\nSpore Core is ready. Run `node gateway.js` to start.');
  }
}

runTests().catch(e => {
  console.error('Test suite error:', e);
  process.exit(1);
});
