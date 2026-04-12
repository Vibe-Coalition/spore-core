/**
 * plugins/openclaw-adapter.js — OpenClaw ContextEngine Compatibility Layer
 *
 * Wraps OpenClaw ContextEngine plugins so they work within Anima's
 * GraphContext prompt pipeline. Maps the 7 OpenClaw lifecycle hooks
 * to Anima's internal architecture.
 *
 * OpenClaw ContextEngine hooks:
 *   1. bootstrap()              — Engine init, connect to vector DB, load state
 *   2. ingest(message)          — New message arrives, store and index
 *   3. assemble(budget)         — Build context within token budget
 *   4. compact()                — Token limit exceeded, slim down context
 *   5. afterTurn(turn)          — Post-turn processing
 *   6. prepareSubagentSpawn()   — Prepare isolated context for subagent
 *   7. onSubagentEnded()        — Collect and merge subagent output
 */

const graphEvents = require('../graph/events');

const PLUGIN_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;

class OpenClawAdapter {
  /**
   * @param {object} engine — The OpenClaw ContextEngine instance (has lifecycle methods)
   * @param {object} appContext — { config, graph, sessions, log }
   */
  constructor(engine, appContext) {
    this.engine = engine;
    this.config = appContext.config;
    this.graph = appContext.graph;
    this.sessions = appContext.sessions;
    this.log = appContext.log;
    this._initialized = false;
  }

  /**
   * Call bootstrap() on the OpenClaw engine. Called during plugin init.
   */
  async bootstrap() {
    if (typeof this.engine.bootstrap === 'function') {
      await this.engine.bootstrap();
      this._initialized = true;
    }
  }

  /**
   * Wire ingest() to session message events via graphEvents.
   * Call this after bootstrap to start listening.
   */
  startListening() {
    if (typeof this.engine.ingest !== 'function') return;

    graphEvents.on('message:added', (data) => {
      try {
        this.engine.ingest({
          role: data.role,
          content: data.content,
          sessionKey: data.sessionKey,
          timestamp: data.timestamp || new Date().toISOString(),
        });
      } catch (e) {
        this.log.warn(`[openclaw-adapter] ingest error: ${e.message}`);
      }
    });
  }

  /**
   * Call assemble() with an Anima-compatible token budget.
   * Returns a string to be appended as an extra context section.
   */
  async assemble() {
    if (typeof this.engine.assemble !== 'function') return null;

    const budget = {
      total: PLUGIN_TOKEN_BUDGET,
      used: 0,
      remaining: PLUGIN_TOKEN_BUDGET,
    };

    try {
      const result = await this.engine.assemble(budget);
      if (!result) return null;

      if (typeof result === 'string') return result;
      if (result.text) return result.text;
      if (result.messages && Array.isArray(result.messages)) {
        return result.messages
          .map(m => `[${m.role}] ${m.content}`)
          .join('\n')
          .slice(0, PLUGIN_TOKEN_BUDGET * CHARS_PER_TOKEN);
      }

      return null;
    } catch (e) {
      this.log.warn(`[openclaw-adapter] assemble error: ${e.message}`);
      return null;
    }
  }

  /**
   * Call compact() — invoked when context exceeds token budget.
   */
  async compact() {
    if (typeof this.engine.compact === 'function') {
      try {
        await this.engine.compact();
      } catch (e) {
        this.log.warn(`[openclaw-adapter] compact error: ${e.message}`);
      }
    }
  }

  /**
   * Call afterTurn() with turn data from the agent loop.
   */
  async afterTurn(turnData) {
    if (typeof this.engine.afterTurn === 'function') {
      try {
        await this.engine.afterTurn({
          userMessage: turnData.userMessage || '',
          assistantResponse: turnData.assistantResponse || '',
          toolCalls: turnData.toolCalls || [],
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        this.log.warn(`[openclaw-adapter] afterTurn error: ${e.message}`);
      }
    }
  }

  /**
   * Stub: prepareSubagentSpawn() — returns a context snapshot.
   * Full implementation when Anima adds sub-agent support.
   */
  async prepareSubagentSpawn() {
    if (typeof this.engine.prepareSubagentSpawn === 'function') {
      try {
        return await this.engine.prepareSubagentSpawn();
      } catch (e) {
        this.log.warn(`[openclaw-adapter] prepareSubagentSpawn error: ${e.message}`);
      }
    }
    return null;
  }

  /**
   * Stub: onSubagentEnded() — merge subagent results.
   */
  async onSubagentEnded(subagentResult) {
    if (typeof this.engine.onSubagentEnded === 'function') {
      try {
        await this.engine.onSubagentEnded(subagentResult);
      } catch (e) {
        this.log.warn(`[openclaw-adapter] onSubagentEnded error: ${e.message}`);
      }
    }
  }
}

/**
 * Wraps an OpenClaw plugin's register function into an Anima-compatible
 * PluginAPI registerContextEngine call.
 *
 * Usage in PluginManager: when manifest.openclawCompat is true, the
 * register function is wrapped through this adapter before being called.
 *
 * @param {Function} openclawRegisterFn — The plugin's definePluginEntry register function
 * @param {object} appContext — Anima app context
 * @param {object} log — Logger
 * @returns {OpenClawAdapter} — Adapted engine instance
 */
async function adaptOpenClawPlugin(openclawRegisterFn, appContext, log) {
  let capturedEngine = null;

  const fakeApi = {
    registerContextEngine(name, factory) {
      capturedEngine = factory({
        config: appContext.config,
        graph: appContext.graph,
        sessions: appContext.sessions,
      });
    },
    registerTool() {},
    registerGateway() {},
    registerWorkerHook() {},
    registerMiddleware() {},
    getConfig: () => ({}),
    getLogger: () => log,
  };

  await openclawRegisterFn(fakeApi);

  if (!capturedEngine) {
    throw new Error('OpenClaw plugin did not register a context engine');
  }

  const adapter = new OpenClawAdapter(capturedEngine, { ...appContext, log });
  await adapter.bootstrap();
  adapter.startListening();

  return adapter;
}

module.exports = { OpenClawAdapter, adaptOpenClawPlugin };
