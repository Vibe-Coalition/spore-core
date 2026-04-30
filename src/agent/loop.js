/**
 * agent.js — Agent Loop
 * 
 * The core agentic loop:
 *   message in → build context from graph → call Claude → handle tool calls → respond
 * 
 * Supports streaming responses back to Discord.
 * Handles multi-turn tool use conversations within a single request.
 */

const { MultiProvider, detectBackend } = require('../providers');
const graphEvents = require('../graph/events');
const { effortDefaults } = require('./effort');

// ── Budget-scaling constants ─────────────────────────────────────────
// All message-budget fractions are expressed against the active model's
// contextWindow. Documented here so changes are explicit and reviewable
// instead of buried in expressions inside the loop body.
//
// Compaction-trigger thresholds:
const CTX_HARD_CEILING_FRACTION   = 0.85;  // compact when systemTokens+msgTokens crosses this
const CTX_HARD_CEILING_FALLBACK   = 0.75;  // when neither modelLimits.compactAt nor 0.85 ceiling is set
const CTX_SOFT_BUDGET_CASUAL      = 0.05;  // casual chat in-loop trigger — 5% of window
const CTX_SOFT_BUDGET_COMPLEX     = 0.20;  // complex/coding in-loop trigger — 20% of window
// Pressure warnings (caution / urgent) along the way to compaction:
const CTX_PRESSURE_CAUTION        = 0.70;  // warn at 70% of compactionThreshold
const CTX_PRESSURE_URGENT         = 0.90;  // urgent warn at 90% of compactionThreshold
// Compaction internals:
const COMPACT_HEAD_GUARD_FRACTION = 0.5;   // if head messages alone > N% of target, drop to single-msg head
// Floors below the dynamic scaling (sized for 200k Sonnet/Haiku
// historic behavior). Operators can override via config; setting any
// to 0 effectively disables the floor for that tier.
const SOFT_BUDGET_FLOOR_CASUAL    = 30000;
const SOFT_BUDGET_FLOOR_COMPLEX   = 80000;
// Default contextWindow when the active model has no modelLimits entry
// AND no global config.contextWindow override.
const DEFAULT_CONTEXT_WINDOW      = 200000;
// Headroom reserved below hardCeiling for the next model response when
// computing a compaction target. Without this, compaction would size
// messages exactly to the ceiling and leave no room for output.
const RESPONSE_HEADROOM_TOKENS    = 2000;
// Extra buffer subtracted from targetTokens when picking how many tail
// messages survive Phase 2 of compaction — guards against borderline
// arithmetic where the next-message tokens push us just over.
const COMPACT_TAIL_HEADROOM_TOKENS = 500;
// Model output-token sizing:
//   FALLBACK = used when modelLimits[model].maxTokens is missing/zero
//              AND when matching against config.maxTokens to detect "operator
//              hasn't customized this" (config.maxTokens === FALLBACK ⇒ use
//              the model-family heuristic).
//   CEILING  = absolute hard cap on output tokens regardless of vendor
//              claims; no current model exceeds 128K output in practice.
const MODEL_OUTPUT_TOKEN_FALLBACK = 8192;
const MODEL_OUTPUT_TOKEN_CEILING  = 128000;
// Tool result truncation caps (chars, NOT tokens — applied before
// JSON-encoding into the tool_result block). Per-tool overrides live
// in TOOL_RESULT_CAPS; everything else falls back to TOOL_RESULT_DEFAULT_CAP.
const TOOL_RESULT_DEFAULT_CAP = 30000;
const TOOL_RESULT_CAPS = {
  read_file:    120000,
  web_fetch:     30000,
  exec:          30000,
  message_read:  15000,
  graph_query:   15000,
};
// Compaction message-window shape:
//   PROTECT_HEAD_COUNT — head messages always kept verbatim (system intro,
//                        first user/assistant exchange).
//   PROTECT_TAIL_MAX   — upper bound on tail messages preserved verbatim;
//                        actual count is min(this, messages.length - 2).
//   HEAD_EXTEND_MAX    — max additional head pairs to absorb when an
//                        unfinished tool_use/tool_result chain straddles
//                        the head/middle boundary.
const PROTECT_HEAD_COUNT = 2;
const PROTECT_TAIL_MAX   = 4;
const HEAD_EXTEND_MAX    = 6;

class AgentLoop {
  constructor(config, logger, graphContext, sessionManager, toolSystem, learner) {
    this.config = config;
    this.log = logger;
    this.graph = graphContext;
    this.sessions = sessionManager;
    this.tools = toolSystem;
    this.learner = learner || null;
    this.client = null;

    this.activeRuns = new Set();
    this._pendingInterjections = new Map(); // sessionKey → [content, ...]
    this._sessionWaiters = new Map();       // sessionKey → [resolve, ...]
  }

  /**
   * Initialize the Anthropic client
   */
  init() {
    if (!this.config.model) {
      this.log.warn('No model configured — agent AI is disabled. Set up a provider in the Manager, create a new agent, and restart.');
      return false;
    }
    const backend = detectBackend(this.config.model);
    // Plugin-driven configuration check. Each provider plugin exposes
    // isConfigured(config) → bool through its registerProvider opts;
    // manager.getProviders surfaces the result. If the model's owning
    // plugin reports not-configured, log the actionable warning and
    // bail. No vendor strings here.
    const mgr = this.tools?._pluginManager;
    if (mgr?.getProviders) {
      const entry = mgr.getProviders().find(p => p.name === backend);
      if (entry && entry.configured === false) {
        this.log.warn(`No API key configured for provider '${entry.name}' — agent AI is disabled. Configure the ${entry.pluginId} plugin (Settings → Plugins) and restart.`);
        return false;
      }
    }
    if (!this.client) this.client = new MultiProvider(this.config);
    const multimodal = [
      this.config.imageVlmModel ? `imageVLM=${this.config.imageVlmModel}` : null,
      this.config.videoVlmModel ? `videoVLM=${this.config.videoVlmModel}` : null,
      this.config.audioVlmModel ? `audioVLM=${this.config.audioVlmModel}` : null,
    ].filter(Boolean).join(' ');
    this.log.info(`Agent loop initialized — tiers: casual=${this.config.casualModel} normal=${this.config.normalModel} planner=${this.config.plannerModel}${multimodal ? ` ${multimodal}` : ''} (${backend})`);
    return true;
  }

  /**
   * Process an incoming message through the agent loop.
   * 
   * @param {Object} opts
   * @param {string} opts.content - Message content
   * @param {string} opts.channelId - Source chat ID
   * @param {string} opts.channelName - Source chat name
   * @param {string} opts.userId - Source user ID
   * @param {string} opts.userName - Discord display name
   * @param {string} opts.guildName - Guild name
   * @param {boolean} opts.isDm - Whether this is a DM
   * @param {Function} opts.onText - Callback for text chunks (streaming)
   * @param {Function} opts.onComplete - Callback when complete
   * @param {Function} opts.onError - Callback on error
   * @returns {Promise<Object>} Result with response text and usage
   */
  async processMessage(opts) {
    if (!this.client) {
      const msg = 'No LLM provider configured — set up a provider in the Manager and restart this agent.';
      this.log.error(msg);
      if (opts.onError) opts.onError(new Error(msg));
      return { text: msg, error: true };
    }

    const sessionKey = this.sessions.constructor.buildKey(
      opts.channelId, opts.isDm, opts.userId
    );

    // Prevent concurrent runs on same session
    if (this.activeRuns.has(sessionKey)) {
      this.log.warn(`Skipping concurrent run for session: ${sessionKey}`);
      return { text: null, skipped: true };
    }

    this.activeRuns.add(sessionKey);

    const ac = new AbortController();
    opts._abortController = ac;
    opts._abortSignal = ac.signal;
    if (!this._activeAbortControllers) this._activeAbortControllers = new Map();
    this._activeAbortControllers.set(sessionKey, ac);

    // Safety: if an aborted run hangs for >10s, force-release the session lock
    // so new messages aren't permanently blocked.
    let forceReleaseTimer = null;
    const onAbort = () => {
      forceReleaseTimer = setTimeout(() => {
        if (this.activeRuns.has(sessionKey)) {
          this.log.warn(`[abort] Force-releasing session ${sessionKey} after 10s timeout`);
          this.activeRuns.delete(sessionKey);
          this._activeAbortControllers.delete(sessionKey);
          this.tools._abortSignal = null;
          // Notify any waiters (e.g. gateway retrying after abort)
          const fw = this._sessionWaiters.get(sessionKey);
          if (fw) { this._sessionWaiters.delete(sessionKey); for (const r of fw) r(); }
        }
      }, 10_000);
    };
    ac.signal.addEventListener('abort', onAbort, { once: true });

    // Per-session context so tool handlers (schedule_wakeup, task_create,
    // log_watch, ask_user, plan-mode gate) know who called them. This map is
    // keyed by sessionKey so it's safe under concurrent sessions. The tool
    // layer itself uses AsyncLocalStorage for the "which session is calling
    // RIGHT NOW" question — see tools.js:_execContext.
    if (!this.tools._sessionContexts) this.tools._sessionContexts = new Map();
    this.tools._sessionContexts.set(sessionKey, {
      channelId: opts.channelId,
      channelName: opts.channelName,
      userId: opts.userId,
      userName: opts.userName,
      platform: opts.platform,
      isDm: opts.isDm !== false,
      sessionKey,
    });

    try {
      return await this._runLoop(sessionKey, opts);
    } finally {
      if (forceReleaseTimer) clearTimeout(forceReleaseTimer);
      this.activeRuns.delete(sessionKey);
      this._activeAbortControllers.delete(sessionKey);
      this._pendingInterjections.delete(sessionKey); // discard stale interjections
      this.tools._abortSignal = null;
      // Clean up per-session tool context
      if (this.tools._sessionContexts) this.tools._sessionContexts.delete(sessionKey);
      // Kill any per-session log watches so subprocesses don't outlive sessions.
      if (typeof this.tools.killSessionLogWatches === 'function') {
        try { this.tools.killSessionLogWatches(sessionKey); } catch (e) { this.log.warn('[loop] this.tools.killSessionLogWatches failed: ' + e.message); }
      }
      // Reject any pending ask_user prompts for this session so the tool
      // handler doesn't hang forever.
      if (typeof this.tools.cancelSessionAskUser === 'function') {
        try { this.tools.cancelSessionAskUser(sessionKey); } catch (e) { this.log.warn('[loop] this.tools.cancelSessionAskUser failed: ' + e.message); }
      }
      // Notify any waiters (e.g. gateway retrying after abort)
      const waiters = this._sessionWaiters.get(sessionKey);
      if (waiters) { this._sessionWaiters.delete(sessionKey); for (const r of waiters) r(); }
    }
  }

  abortSession(channelId, isDm, userId) {
    const sessionKey = this.sessions.constructor.buildKey(channelId, isDm, userId);
    const ac = this._activeAbortControllers?.get(sessionKey);
    if (ac) {
      ac._userAbort = true;
      ac.abort();
      return true;
    }
    return false;
  }

  /**
   * Inject a user message into an active session's loop.
   * The message will be picked up before the next _callLLM() iteration.
   * Returns false if the session isn't running or is already aborting.
   */
  interject(sessionKey, content, newOpts) {
    if (!this.activeRuns.has(sessionKey)) return false;
    const ac = this._activeAbortControllers?.get(sessionKey);
    if (!ac || ac.signal.aborted) return false; // Can't inject into a dying loop
    const arr = this._pendingInterjections.get(sessionKey) || [];
    // Items used to be raw strings. Now stored as {content, opts} so a
    // mode toggle (plan↔execute) carried by the new message can drive a
    // system-prompt rebuild on the next iteration. Old call sites that
    // pass just a string still work via the typeof-string fallback in
    // _injectPendingInterjections.
    arr.push({ content, opts: newOpts || null });
    this._pendingInterjections.set(sessionKey, arr);
    const modeNote = newOpts?.projectContext?.mode ? `, mode=${newOpts.projectContext.mode}` : '';
    this.log.info(`[interject] Queued interjection for session ${sessionKey} (${content.length} chars, ${arr.length} pending${modeNote})`);
    return true;
  }

  /**
   * Returns a promise that resolves when the given session is no longer in activeRuns.
   * Resolves immediately if the session is not currently active.
   */
  waitForSession(sessionKey) {
    if (!this.activeRuns.has(sessionKey)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this._sessionWaiters.get(sessionKey) || [];
      waiters.push(resolve);
      this._sessionWaiters.set(sessionKey, waiters);
    });
  }

  /**
   * The main agent loop — handles multi-turn tool use
   */
  async _runLoop(sessionKey, opts) {
    // Store per-session tool context so concurrent sessions (e.g. Spore Code + main chat)
    // don't corrupt each other. Tools read from _sessionContexts[sessionKey] when available.
    if (!this.tools._sessionContexts) this.tools._sessionContexts = new Map();
    this.tools._sessionContexts.set(sessionKey, {
      trigger: opts.trigger || null,
      channelId: opts.channelId || null,
      platform: opts.platform || 'discord',
      userMessage: opts.content || null,
      userName: opts.userName || null,
      userId: opts.userId || null,
      userRole: opts.userRole || null,
      abortSignal: opts._abortSignal || null,
    });

    // Also set the legacy globals (for tools that haven't been updated to use _sessionContexts).
    // These are best-effort when multiple sessions run concurrently.
    this.tools._currentTrigger = opts.trigger || null;
    this.tools._currentChannelId = opts.channelId || null;
    this.tools._currentPlatform = opts.platform || 'discord';
    this.tools._currentUserMessage = opts.content || null;
    this.tools._currentUserName = opts.userName || null;
    this.tools._currentUserId = opts.userId || null;
    this.tools._currentUserRole = opts.userRole || null;
    this.tools._currentSessionToken = opts.sessionToken || null;
    // Capture so delegate_task can stash it onto the _delegatedTasks
    // entry; when the subagent finishes, _deliverTaskResult re-feeds
    // it into processMessage so the wake-up turn has the same Spore Code
    // project context (cwd, tools, tree) the agent saw at delegation.
    this.tools._currentProjectContext = opts.projectContext || null;
    this.tools._abortSignal = opts._abortSignal || null;

    // Plugin middleware: beforeIngest — observers see the incoming message
    // and session metadata before the agent starts processing.
    if (this._pluginManager) {
      for (const handler of this._pluginManager.getMiddleware('beforeIngest')) {
        try { await handler({ sessionKey, content: opts.content, trigger: opts.trigger, platform: opts.platform, userId: opts.userId, userName: opts.userName, channelId: opts.channelId }); } catch (e) { this.log.warn('[loop] beforeIngest handler failed: ' + e.message); }
      }
    }

    const dynamicOpts = {
      channelId: opts.channelId,
      channelName: opts.channelName,
      userId: opts.userId,
      userName: opts.userName,
      userRole: opts.userRole,
      guildName: opts.guildName,
      messageContent: opts.content || opts.messageContent,
      trigger: opts.trigger,
      platform: opts.platform,
      guildName: opts.guildName,
      isThread: opts.isThread,
      parentChannelName: opts.parentChannelName,
      messageId: opts.messageId,
      webappStatus: this.tools?.gateway?.getWebappStatus?.() || null,
      clientCwd: opts.clientCwd || null,
      // Structured project metadata from Spore Code (cwd, git, tree, SPORE.md,
      // tools, mode). Routed into the system prompt by prompt-sections.js,
      // never into messages[]. Replaces the old "glue GatherContext onto
      // message content" path. See plan/spore-context.
      projectContext: opts.projectContext || null,
    };

    // Detect casual chat for lighter prompt mode
    const msgText = typeof opts.content === 'string' ? opts.content : '';
    const directTriggers = ['mention', 'reply', 'dm', 'task_complete'];
    // Casual = short conversational messages (greetings, reactions, simple questions).
    // Anything that sounds like a task/instruction is NOT casual.
    // Status/progress questions are NOT casual — they need recent context to answer.
    const hasTaskWords = /\b(file|code|write|read|edit|exec|run|build|deploy|install|script|create|generate|save|delete|fix|update|refactor|search|find|look\s?up|query|research|analyze|summarize|compare|explain|describe|list|show|add|remove|change|make|brand|ensure|set\s?up|configure|modify|replace|move|copy|send|fetch|download|upload|check|test|debug|implement|design|render|compile|parse|convert|merge|split|connect|disconnect|publish|schedule|cancel|approve|reject|assign|review|tone|adjust|tweak|polish|clean|improve|optimize|finish|complete|continue|proceed|resume|redo|undo|revert|restart|stop|pause|wrap\s?up|serve|host|share|put|post|drop|deliver|attach|play|record|stream|open|close|start|enable|disable|turn\s?on|turn\s?off)\b/i.test(msgText);
    const hasStatusWords = /\b(status|progress|going|doing|happening|working\s+on|how.*going|how.*coming|update\s+on|where.*at|eta|done\s+yet|finished|ready)\b/i.test(msgText);
    const hasActiveTasks = this.tools?._delegatedTasks && [...this.tools._delegatedTasks.values()].some(t => t.status === 'running');
    // Stickiness: once a session has accumulated substantive coding work
    // (any prior tool_use in the conversation, or projectContext present),
    // a short follow-up like "do both" or "ok try that" is a CONTINUATION
    // — not a casual greeting. Without this, a 7-char direct-trigger
    // message with no task-words flipped isCasualChat=true and dropped
    // softBudget from 80k → 30k mid-session, triggering compaction on a
    // session the user thought was deep in a coding flow.
    let sessionHasToolUse = false;
    try {
      const recent = this.sessions?.getHistory?.(sessionKey, 30) || [];
      sessionHasToolUse = recent.some(m => {
        if (m.role !== 'assistant') return false;
        let c = m.content;
        if (typeof c === 'string') {
          try { c = JSON.parse(c); } catch { return false; }
        }
        return Array.isArray(c) && c.some(b => b?.type === 'tool_use');
      });
    } catch { /* best-effort; if we can't tell, fall through */ }
    const sessionIsSubstantive = sessionHasToolUse || !!opts.projectContext;
    const isCasualChat = directTriggers.includes(opts.trigger) && msgText.length < 200
      && !hasTaskWords && !(hasStatusWords && hasActiveTasks)
      && !sessionIsSubstantive;
    const promptMode = isCasualChat ? 'chat' : 'full';

    // beforeMessage lifecycle hook — plugins can inject per-turn data
    // into dynamicOpts before the prompt builds. Spore Code uses this to
    // upsert the per-(user, cwd) project node and surface
    // cachedProject* flags so its own Project Context prompt section
    // can reference the cached node id. Returns null if no plugin
    // handles it; merged into dynamicOpts below.
    let cachedProjectNodeId = null;
    let cachedProjectStale = false;
    let cachedProjectIsNew = false;
    const beforePatch = this._firePluginBeforeMessage(opts);
    if (beforePatch) {
      cachedProjectNodeId = beforePatch.cachedProjectNodeId || null;
      cachedProjectStale  = !!beforePatch.cachedProjectStale;
      cachedProjectIsNew  = !!beforePatch.cachedProjectIsNew;
    }

    // Build system prompt using async path (hybrid search + Enhanced Recall).
    // `let` (not `const`) so a mid-loop mode toggle via interjection can
    // rebuild it — see _injectPendingInterjections.
    const llmClient = this.tools?.llmClient || null;
    let systemPrompt = await this.graph.buildSystemPromptAsync({
      ...dynamicOpts,
      promptMode,
      _llmClient: llmClient,
      cachedProjectNodeId,
      cachedProjectStale,
      cachedProjectIsNew,
    });
    // DEBUG: dump the assembled system prompt + tool list to disk so we can
    // inspect exactly what hit the model. Toggle with SPORE_DEBUG_DUMP_PROMPT=1.
    if (process.env.SPORE_DEBUG_DUMP_PROMPT === '1') {
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = process.env.SPORE_DEBUG_DUMP_DIR || '/data';
        const outFile = path.join(dir, 'last-prompt.txt');
        const toolList = (this.tools?.getToolDefinitions?.() || []).map(t => t.name);
        const dump = [
          `# trigger=${opts.trigger} platform=${opts.platform} promptMode=${promptMode}`,
          `# user=${opts.userId || ''} session=${sessionKey}`,
          `# tools (${toolList.length}): ${toolList.join(', ')}`,
          `# systemPrompt length: ${systemPrompt.length} chars`,
          `# tooling section present: ${systemPrompt.includes('### Tool Selection Rules')}`,
          `# web_search mentioned: ${systemPrompt.includes('web_search')}`,
          '',
          '── SYSTEM PROMPT ──',
          systemPrompt,
        ].join('\n');
        fs.writeFileSync(outFile, dump);
        this.log.info(`[debug] wrote system prompt to ${outFile} (${systemPrompt.length} chars, mode=${promptMode}, tooling=${systemPrompt.includes('### Tool Selection Rules')})`);
      } catch (e) {
        this.log.warn(`[debug] dump failed: ${e.message}`);
      }
    }
    // Plan-mode verification logging — confirms the QUESTIONS:/PLAN_READY
    // instructions actually reach the model. Counts marker occurrences
    // in the final assembled system prompt and warns if they're missing
    // when projectContext.mode === 'plan'.
    if (opts.platform === 'cli' && opts.projectContext?.mode === 'plan') {
      const has = {
        planHeader: systemPrompt.includes('## Plan Mode'),
        questionsMarker: systemPrompt.includes('QUESTIONS:'),
        planReadyMarker: systemPrompt.includes('PLAN_READY'),
        rulesHeader: systemPrompt.includes('RULES'),
      };
      const missing = Object.entries(has).filter(([_, v]) => !v).map(([k]) => k);
      if (missing.length > 0) {
        this.log.warn(`[plan-mode] system prompt MISSING markers: ${missing.join(', ')} | total prompt size: ${systemPrompt.length} bytes`);
      } else {
        this.log.info(`[plan-mode] system prompt OK — all 4 markers present, ${systemPrompt.length} bytes total`);
      }
    }
    // Split for prompt caching: static part can be cached by the API between calls.
    // opts forwarded so plugin-contributed prompt sections can branch on
    // platform / projectContext / sessionId without breaking the static cache
    // (plugin sections are computed fresh, not cached).
    const staticPrompt = this.graph.buildStaticPrompt(promptMode, opts);
    const dynamicContext = systemPrompt.length > staticPrompt.length ? systemPrompt.slice(staticPrompt.length) : null;

    // 2. Add the user message to session history (text only — images are ephemeral)
    // Task completion messages are internal system prompts — don't pollute chat history
    // If this message follows an interruption, the new instruction takes priority
    const wasInterrupted = this._recentAborts?.delete(sessionKey) || false;

    if (opts.trigger !== 'task_complete') {
      this.sessions.addMessage(sessionKey, 'user', opts.content);
    }

    // 3. Get conversation history
    let messages = this.sessions.getHistory(sessionKey);

    // For task_complete triggers, inject the completion content as an ephemeral user message
    // so the agent sees it but it doesn't persist in chat history
    if (opts.trigger === 'task_complete') {
      messages.push({ role: 'user', content: opts.content });
    }

    // 3.5. Attach multimodal inputs to the last user message.
    //      Images/audio/video are ephemeral in the prompt, but also saved to disk
    //      so tools (exec, delegate_task, browser, etc.) can access them.
    const mediaBlocks = this._buildMediaBlocks(opts);
    if (mediaBlocks.length > 0 && messages.length > 0) {
      const savedPaths = this._saveMediaToDisk(mediaBlocks);
      const attachInline = !this._hasDedicatedVlmTiers();
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        const pathNote = savedPaths.length
          ? `\n[Attached files saved to disk: ${savedPaths.join(', ')}]`
          : '';
        if (attachInline && typeof lastMsg.content === 'string') {
          lastMsg.content = [
            ...mediaBlocks,
            { type: 'text', text: lastMsg.content + pathNote },
          ];
        } else if (attachInline && Array.isArray(lastMsg.content)) {
          lastMsg.content = [
            ...mediaBlocks,
            ...lastMsg.content,
            ...(pathNote ? [{ type: 'text', text: pathNote.trim() }] : []),
          ];
        } else if (typeof lastMsg.content === 'string' && pathNote) {
          lastMsg.content = `${lastMsg.content}${pathNote}`;
        } else if (Array.isArray(lastMsg.content) && pathNote) {
          lastMsg.content = [...lastMsg.content, { type: 'text', text: pathNote.trim() }];
        }
      }
    }

    // 3.9. If this follows an interruption, prefix the user's new message with a priority signal.
    // This goes into the messages array (not session storage) so it's ephemeral.
    if (wasInterrupted && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === 'user' && typeof last.content === 'string') {
        last.content = `[PRIORITY — The user interrupted your previous task. That task is CANCELLED. Focus ONLY on this new message:]\n\n${last.content}`;
      }
      this.log.info(`[interrupt] Priority framing injected for ${sessionKey}`);
    }

    // 4. Ensure messages alternate user/assistant properly
    messages = this._sanitizeMessages(messages);

    // 4.5. Token-aware compaction: summarize old messages instead of dropping them.
    // We pick the active model FIRST so the budget tracks the model that will
    // actually run inference. Without this, a BUILDING turn (which routes to
    // plannerModel) would compact against normalModel's contextWindow and
    // throw away history the planner could happily hold. Mirrors the routing
    // logic at the start of the inference loop below.
    const isBuildingTurn = opts.projectContext?.mode === 'plan'
      && /^\s*\[BUILD_PLAN\]/.test(typeof opts.content === 'string' ? opts.content : '');
    // `let` because _maybeEscalateModel below reassigns it when a tool call
    // forces a tier bump (e.g. casual → planner mid-loop).
    let activeModel = isBuildingTurn
      ? (this.config.plannerModel || this.config.normalModel)
      : isCasualChat
        ? (this.config.casualModel || this.config.normalModel || this.config.plannerModel)
        : (this.config.normalModel || this.config.plannerModel);
    const _modelLimit = this._lookupModelLimit(activeModel);
    const contextWindow = (_modelLimit?.contextWindow && Number(_modelLimit.contextWindow) > 0)
      ? Number(_modelLimit.contextWindow)
      : DEFAULT_CONTEXT_WINDOW;
    const configuredCeiling = (_modelLimit?.compactAt && Number(_modelLimit.compactAt) > 0)
      ? Number(_modelLimit.compactAt)
      : Math.floor(contextWindow * CTX_HARD_CEILING_FRACTION);
    let hardCeiling = Math.min(
      contextWindow,
      configuredCeiling && configuredCeiling > 0
        ? configuredCeiling
        : Math.floor(contextWindow * CTX_HARD_CEILING_FALLBACK)
    );
    // Operator-pinned absolute hardCeiling override (Settings → Agent →
    // Context budgets). Caps below the model-derived ceiling so
    // operators can force tighter compaction on a session-by-session
    // basis without touching per-model contextWindow entries.
    const _absoluteCeiling = Number(this.config.compactTokenThreshold);
    if (Number.isFinite(_absoluteCeiling) && _absoluteCeiling > 0) {
      hardCeiling = Math.min(hardCeiling, _absoluteCeiling);
    }
    if (!_modelLimit?.contextWindow) {
      this.log.debug(`[budget] No modelLimits entry for ${activeModel || '(no model)'}; falling back to ${contextWindow.toLocaleString()}-token default. Set per-model context in Settings → Providers to scale budgets correctly.`);
    }
    const systemTokens = this._estimateTokens(systemPrompt);
    let msgTokens = messages.reduce((sum, m) => sum + this._estimateTokens(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ), 0);

    // Complexity-aware message budget: casual chat gets a tight budget so
    // simple greetings don't drag 30K of history. Complex requests get more
    // room. The hard ceiling stays as a safety cap for multi-iteration loops.
    //
    // Both soft budgets scale with the model's actual context window. The
    // 30k/80k defaults were sized for 200k Sonnet/Haiku — fixed values
    // would compact a 1M-context Opus 4.7 session at ~3-8% of capacity,
    // dropping mid-session state the model could easily hold in working
    // memory. We take the MAX of the configured floor and a percentage
    // of contextWindow so:
    //   - small-context models (Sonnet 200k) keep their historic 30k/80k
    //     behavior (200k * 5%/20% = 10k/40k, both below the floor),
    //   - large-context models (Opus 4.7 1M) get 50k/200k respectively,
    //     letting deep coding sessions accumulate state appropriate to
    //     the model's reach.
    // Operators can still pin explicit budgets via casualMessageBudget /
    // complexMessageBudget; setting either to 0 disables the floor.
    // Resolution: pinned config field → effort preset → in-source floor.
    const eff = effortDefaults(this.config);
    const casualFloor  = this.config.casualMessageBudget  ?? eff.casualMessageBudget  ?? SOFT_BUDGET_FLOOR_CASUAL;
    const complexFloor = this.config.complexMessageBudget ?? eff.complexMessageBudget ?? SOFT_BUDGET_FLOOR_COMPLEX;
    const ctxScaledCasual  = Math.floor(contextWindow * CTX_SOFT_BUDGET_CASUAL);
    const ctxScaledComplex = Math.floor(contextWindow * CTX_SOFT_BUDGET_COMPLEX);
    const casualBudget  = Math.max(casualFloor,  ctxScaledCasual);
    const complexBudget = Math.max(complexFloor, ctxScaledComplex);
    const softBudget = isCasualChat ? casualBudget : complexBudget;

    if (msgTokens > softBudget) {
      const targetMsgTokens = Math.min(softBudget, hardCeiling - systemTokens - RESPONSE_HEADROOM_TOKENS);
      messages = await this._compactHistory(sessionKey, messages, targetMsgTokens, opts.onStatus);
      messages = this._sanitizeMessages(messages);
      this.log.info(`[compaction] ${isCasualChat ? 'casual' : 'complex'} ${msgTokens} → ~${targetMsgTokens} msg tokens`);
    } else if (systemTokens + msgTokens > hardCeiling) {
      const targetMsgTokens = hardCeiling - systemTokens - RESPONSE_HEADROOM_TOKENS;
      messages = await this._compactHistory(sessionKey, messages, targetMsgTokens, opts.onStatus);
      messages = this._sanitizeMessages(messages);
      this.log.info(`[compaction] hard-ceiling ${msgTokens} → ~${targetMsgTokens} msg tokens`);
    }

    // 5. Run inference loop (may include tool calls)
    let totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let finalText = '';
    let lastSentIntermediate = '';
    let iterations = 0;
    let apiRetries = 0;
    let sessionRecoveredThisCall = false;
    let loopBroken = false;
    let delegatedThisTurn = false;

    // Collect tool call summaries for the learner (procedural knowledge)
    const toolLog = [];

    const isLull = opts.trigger === 'lull';
    const isDirect = directTriggers.includes(opts.trigger);
    const lullMaxIter = this.config.lullMaxIterations || eff.lullMaxIterations;
    const safetyCeiling = this.config.loopDetection?.ceiling || 50;
    const budgetPressureAt = this.config.loopDetection?.budgetPressure || eff.loopDetectionBudgetPressure;
    // Tiered iteration caps: chat/DM gets a tighter leash than proactive/continuation
    const dmMaxIter = this.config.dmMaxIterations || eff.dmMaxIterations;
    const chatMaxIter = isDirect ? dmMaxIter : safetyCeiling;
    let budgetHintSent = false;
    let tokenBudgetWarned = false;
    let contextPressureLevel = 0; // 0=ok, 1=caution(70%), 2=urgent(90%)

    // Loop detection state (local to this invocation)
    const loopTracker = { history: [], maxHistory: 20 };

    // 3-tier model escalation: casual → normal → planner
    // Full toolset is always provided (stripping tools causes denial of capabilities).
    // Escalation happens on tool_use: casual→normal on first tools, normal→planner on next.
    //
    // Special case: the BUILDING turn of the Spore Code multi-turn plan flow
    // synthesizes a structured plan from a prior RESEARCH_DONE block.
    // It typically does no tool calls (which means the delegate_task
    // escalation never fires) but it's THE highest-leverage turn —
    // its output gets reviewed and approved by the user, then drives
    // every execute-mode turn that follows. Bias it toward plannerModel
    // up-front rather than relying on the tool-call escalation path.
    // No-op when all tiers point to the same model (single-provider
    // deployments); kicks in automatically the moment plannerModel
    // diverges from normalModel.
    // activeModel + isBuildingTurn are computed earlier alongside the
    // budget calc so the same model drives both. Just log routing here.
    if (isBuildingTurn) {
      this.log.info(`[routing] BUILDING turn → planner (${activeModel})`);
    }
    let chatTools = null;

    const abortSignal = opts._abortSignal;

    if (this.learner) this.learner.setLLMBusy(true);

    while (iterations < safetyCeiling) {
      iterations++;

      if (abortSignal?.aborted) {
        this.log.info(`[abort] Session ${sessionKey} aborted by user after ${iterations - 1} iterations`);
        loopBroken = true;
        break;
      }

      // Lull triggers get a simple hard cap
      if (isLull && iterations > lullMaxIter) {
        this.log.warn(`Lull hit max iterations (${lullMaxIter}) for session ${sessionKey}`);
        break;
      }

      // DM/mention/reply: hard cap to prevent runaway tool usage
      if (isDirect && iterations > chatMaxIter) {
        this.log.warn(`Chat hit max iterations (${chatMaxIter}) for session ${sessionKey} — forcing response`);
        break;
      }

      // Progressive context pressure warnings tied to the actual
      // compaction trigger — whichever fires first, softBudget or
      // hardCeiling. Without this, warnings fire at 70/90% of
      // hardCeiling but pre-turn compaction can fire earlier on
      // softBudget, so "compaction imminent" would lie.
      const compactionThreshold = Math.min(softBudget, hardCeiling);
      const cautionAt = Math.floor(compactionThreshold * CTX_PRESSURE_CAUTION);
      const urgentAt  = Math.floor(compactionThreshold * CTX_PRESSURE_URGENT);
      const currentTokens = systemTokens + msgTokens;
      if (contextPressureLevel < 2 && currentTokens > urgentAt) {
        contextPressureLevel = 2;
        tokenBudgetWarned = true;
        this.log.warn(`[budget] URGENT: ${currentTokens.toLocaleString()}/${compactionThreshold.toLocaleString()} tokens (${Math.round(currentTokens/compactionThreshold*100)}%) — compaction imminent`);
      } else if (contextPressureLevel < 1 && currentTokens > cautionAt) {
        contextPressureLevel = 1;
        this.log.info(`[budget] Caution: ${currentTokens.toLocaleString()}/${compactionThreshold.toLocaleString()} tokens (${Math.round(currentTokens/compactionThreshold*100)}%) — approaching compaction`);
      }

      const iterModel = activeModel || this.config.plannerModel;
      const resolvedIterModel = this.client?.resolveModel?.({
        model: iterModel,
        messages,
        tools: chatTools,
      }) || iterModel;
      this.log.debug(`Agent iteration ${iterations}, messages: ${messages.length}, sysPromptLen: ${systemPrompt.length}`);

      try {
        // Plugin middleware: beforeInference
        if (this._pluginManager) {
          for (const handler of this._pluginManager.getMiddleware('beforeInference')) {
            try { await handler({ systemPrompt, messages, iteration: iterations }); } catch (e) { this.log.warn('[loop] handler failed: ' + e.message); }
          }
        }

        // Pending interjections (extracted to keep _runLoop slim).
        // Returns updated iterations + a possibly-rebuilt systemPrompt
        // when the interjection arrived with a different mode (e.g.
        // user toggled /plan during a streaming execute turn).
        const ijResult = await this._injectPendingInterjections(sessionKey, messages, opts, iterations, {
          systemPrompt,
          dynamicOpts,
          promptMode,
          llmClient,
          cachedProjectNodeId,
          cachedProjectStale,
          cachedProjectIsNew,
        });
        iterations = ijResult.iterations;
        if (ijResult.systemPrompt && ijResult.systemPrompt !== systemPrompt) {
          systemPrompt = ijResult.systemPrompt;
        }

        const iterStart = Date.now();
        this.log.info(`[agent] Iter ${iterations} starting — model=${resolvedIterModel}, msgs=${messages.length}, tools=${chatTools ? 'chat' : 'full'}`);

        const response = await this._callLLM(systemPrompt, messages, { staticPrompt, dynamicContext, onTextDelta: opts.onTextDelta, onThinkingDelta: opts.onThinkingDelta, onToolUse: opts.onToolUse, onStatus: opts.onStatus, tools: chatTools, model: activeModel, abortSignal });

        const iterMs = Date.now() - iterStart;

        if (abortSignal?.aborted) {
          this.log.info(`[abort] Session ${sessionKey} aborted after LLM call (before tool execution)`);
          loopBroken = true;
          break;
        }

        // Plugin middleware: afterInference
        if (this._pluginManager) {
          for (const handler of this._pluginManager.getMiddleware('afterInference')) {
            try { await handler({ response, iteration: iterations }); } catch (e) { this.log.warn('[loop] handler failed: ' + e.message); }
          }
        }

        // Track usage — include cached tokens for accurate reporting
        if (response.usage) {
          totalUsage.input_tokens += (response.usage.input_tokens || 0)
            + (response.usage.cache_read_input_tokens || 0)
            + (response.usage.cache_creation_input_tokens || 0);
          totalUsage.output_tokens += response.usage.output_tokens || 0;
          totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
          totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
        }

        // Extract text and tool use blocks
        const textBlocks = response.content.filter(b => b.type === 'text');
        const toolBlocks = response.content.filter(b => b.type === 'tool_use');

        const iterUsage = response.usage || {};
        const cacheRead = iterUsage.cache_read_input_tokens || 0;
        const cacheCreate = iterUsage.cache_creation_input_tokens || 0;
        const cacheInfo = (cacheRead || cacheCreate) ? `, cache:${cacheRead}r/${cacheCreate}w` : '';
        this.log.info(`[agent] Iter ${iterations} done — ${iterMs}ms, ${toolBlocks.length} tools, ${textBlocks.map(b => b.text).join('').length} chars, stop=${response.stop_reason}, ${iterUsage.input_tokens || 0}in/${iterUsage.output_tokens || 0}out${cacheInfo}`);

        // Collect text — only keep text from the final turn.
        const responseText = textBlocks.map(b => b.text).join('');

        // If no tool calls, we're done — this text IS the final response
        if (toolBlocks.length === 0 || response.stop_reason === 'end_turn') {
          const r = this._handleEndTurn({ response, responseText, finalText, lastSentIntermediate, sessionKey, opts, messages });
          finalText = r.finalText;
          lastSentIntermediate = r.lastSentIntermediate;
          if (r.action === 'continue') continue;
          break;
        }

        // Intermediate turn with tool calls — send text immediately if present,
        // then continue with tool execution. This ensures chat replies aren't lost
        // when tools are called in the same turn.
        // Skip sending if we just delegated a task — the user already got the ack.
        if (responseText) {
          finalText = responseText;
          if (opts.onIntermediateText && !delegatedThisTurn) {
            opts.onIntermediateText(responseText);
          }
          // Always mark as sent — onTextDelta already streamed it to the panel
          lastSentIntermediate = responseText;
          delegatedThisTurn = false;
        }

        // Handle max_tokens truncation — model tried to generate tool calls but
        // hit the output limit. The tool JSON is truncated and unusable.
        // Notify user, add continuation message, and let the model retry with smaller output.
        if (response.stop_reason === 'max_tokens') {
          this._handleMaxTokens({ iterations, iterUsage, responseText, sessionKey, opts, messages });
          continue;
        }

        // 2-tier escalation (extracted)
        activeModel = this._maybeEscalateModel(toolBlocks, activeModel);
        if (toolBlocks.length > 0 && response.stop_reason === 'tool_use') {
          // Store compact version in session — trim large tool inputs for history
          const compactContent = response.content.map(block => {
            if (block.type === 'tool_use' && block.input) {
              const inputStr = JSON.stringify(block.input);
              if (inputStr.length > 2000) {
                return { ...block, input: { _summary: `[${inputStr.length} chars — see current turn for full input]` } };
              }
            }
            return block;
          });
          this.sessions.addMessage(sessionKey, 'assistant', compactContent);
          messages.push({ role: 'assistant', content: response.content });

          const dispatch = await this._executeToolBatch(toolBlocks, { abortSignal, sessionKey, loopTracker, toolLog, opts });
          const toolResults = dispatch.toolResults;
          const criticalBlock = dispatch.criticalBlock;
          if (dispatch.delegated) delegatedThisTurn = true;

          if (abortSignal?.aborted) {
            this.log.info(`[abort] Session ${sessionKey} aborted during tool execution`);
            loopBroken = true;
            break;
          }

          // Budget pressure: escalating warnings injected into tool results
          if (!isLull && toolResults.length > 0) {
            const last = toolResults[toolResults.length - 1];
            if (!budgetHintSent && iterations >= budgetPressureAt) {
              budgetHintSent = true;
              last.content += `\n\n--- BUDGET: ${iterations} iterations used, ${totalUsage.input_tokens.toLocaleString()} input tokens consumed. Respond to the user now unless you absolutely need one more tool call. ---`;
            }
            if (contextPressureLevel === 1) {
              last.content += `\n\n--- ⚠ CONTEXT PRESSURE: ${Math.round((systemTokens + msgTokens) / hardCeiling * 100)}% of context used. Be concise in tool calls — old context will be compacted soon. ---`;
            } else if (contextPressureLevel >= 2) {
              last.content += `\n\n--- 🚨 CONTEXT CRITICAL: ${Math.round((systemTokens + msgTokens) / hardCeiling * 100)}% of context used. STOP using tools and respond immediately with what you know. Compaction is imminent. ---`;
            }
          }

          this._persistToolResults(sessionKey, messages, toolResults, iterations);

          // Mid-loop token check: use API-reported input tokens (accurate) when available,
          // otherwise estimate from the last two messages we just pushed (assistant + tool results).
          // Avoids re-serializing the entire message array every iteration.
          const apiInputTokens = iterUsage.input_tokens || 0;
          if (apiInputTokens > 0) {
            msgTokens = apiInputTokens - systemTokens;
          } else {
            const lastAssistant = messages[messages.length - 2];
            const lastToolResults = messages[messages.length - 1];
            if (lastAssistant) msgTokens += this._estimateTokens(typeof lastAssistant.content === 'string' ? lastAssistant.content : JSON.stringify(lastAssistant.content));
            if (lastToolResults) msgTokens += this._estimateTokens(typeof lastToolResults.content === 'string' ? lastToolResults.content : JSON.stringify(lastToolResults.content));
          }
          if (systemTokens + msgTokens > hardCeiling) {
            const target = hardCeiling - systemTokens - RESPONSE_HEADROOM_TOKENS;
            messages = this._trimMessagesToTokenBudget(messages, target);
            messages = this._sanitizeMessages(messages);
            msgTokens = target;
            this.log.warn(`Mid-loop token trim at iter ${iterations}: ${msgTokens} → ~${target} tokens`);
          }

          if (criticalBlock) {
            loopBroken = true;
            break;
          }

          continue;
        }

        // Default: done
        if (finalText) {
          this.sessions.addMessage(sessionKey, 'assistant', finalText);
        }
        break;

      } catch (e) {
        const errState = { sessionRecoveredThisCall, apiRetries };
        const result = await this._handleIterationError(e, {
          abortSignal, sessionKey, iterations, opts, messages, state: errState,
        });
        sessionRecoveredThisCall = errState.sessionRecoveredThisCall;
        apiRetries = errState.apiRetries;
        if (result.messages) messages = result.messages;
        if (result.action === 'break') { loopBroken = true; break; }
        if (result.action === 'continue') continue;
        if (result.action === 'rethrow') throw e;
      }
    }

    if (iterations >= safetyCeiling) {
      this.log.warn(`Agent loop hit safety ceiling (${safetyCeiling}) for session ${sessionKey}`);
    }

    const wasUserAbort = abortSignal?.aborted && opts._abortController?._userAbort;

    if (wasUserAbort) {
      this.log.info(`[abort] User-initiated stop for ${sessionKey} — cleaning session`);
      this._cleanSessionAfterAbort(sessionKey);
      finalText = null;
    } else if (loopBroken && (!finalText || !finalText.trim())) {
      try {
        this.log.info(`[loop-detect] Forcing final response for ${sessionKey}`);
        messages.push({
          role: 'user',
          content: '[SYSTEM: Your tool calls were blocked because you appeared to be stuck in a loop. Summarize what you have accomplished so far and respond to the user. Do not call any more tools.]',
        });
        const finalResponse = await this._callLLM(systemPrompt, messages, { staticPrompt, dynamicContext, onTextDelta: opts.onTextDelta, onThinkingDelta: opts.onThinkingDelta });
        if (finalResponse.usage) {
          totalUsage.input_tokens += finalResponse.usage.input_tokens;
          totalUsage.output_tokens += finalResponse.usage.output_tokens;
        }
        const text = finalResponse.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) {
          finalText = text;
          this.sessions.addMessage(sessionKey, 'assistant', finalText);
        }
      } catch (e) {
        this.log.error(`[loop-detect] Forced response failed: ${e.message}`);
      }
    }

    if (!finalText || finalText.trim() === 'NO_REPLY' || finalText.includes('NO_REPLY') || finalText.trim() === '') {
      if (isDirect) {
        const behaviorSnippet = dynamicContext?.substring(dynamicContext.indexOf('## Conversation'), dynamicContext.indexOf('## Conversation') + 200) || 'NO_BEHAVIOR_SECTION';
        this.log.warn(`NO_REPLY on direct trigger '${opts.trigger}' in ${sessionKey} — suppressed | finalText=${JSON.stringify((finalText || '').substring(0, 100))} | msgCount=${messages.length} | behavior=${behaviorSnippet}`);
      }
      finalText = null;
    }

    // Signal LLM is idle so learner can process its queue
    if (this.learner) this.learner.setLLMBusy(false);

    // Post-loop fire-and-forget hooks (extracted to keep _runLoop slim)
    this._kickOffLearnerExtraction(opts, finalText, toolLog);
    // _captureFailureFix + _recordRoundCheckpoint + _noteProjectActivity
    // moved to plugins/spore-code/ — they now run via the afterTurn
    // lifecycle hook fired inside _firePluginAfterTurn below.
    this._firePluginAfterTurn(opts, finalText, toolLog);

    // Plugin middleware: afterIngest — fires once the full turn is complete.
    // Observers see the incoming message, the assistant's final reply, and
    // every tool call made along the way.
    if (this._pluginManager) {
      for (const handler of this._pluginManager.getMiddleware('afterIngest')) {
        try { await handler({ sessionKey, content: opts.content, finalText, toolLog, trigger: opts.trigger, platform: opts.platform }); } catch (e) { this.log.warn('[loop] afterIngest handler failed: ' + e.message); }
      }
    }

    if (opts.onComplete) opts.onComplete(finalText, totalUsage);

    // Summarise tool usage: { toolName: callCount }
    const toolUsage = toolLog.reduce((acc, t) => {
      acc[t.tool] = (acc[t.tool] || 0) + 1;
      return acc;
    }, {});

    return {
      text: finalText,
      usage: totalUsage,
      toolUsage: Object.keys(toolUsage).length > 0 ? toolUsage : undefined,
      iterations,
      sessionKey,
    };
  }

  // ── Post-loop graphcorn helpers ────────────────────────────────────
  // _captureFailureFix + _recordRoundCheckpoint moved to plugins/spore-code/
  // (phase 2.3e). The plugin registers an afterTurn lifecycle hook that
  // re-implements both behaviors using the wide opts/toolLog passed by
  // _firePluginAfterTurn — see plugins/spore-code/index.js.


  /**
   * Fire-and-forget: kick off the learner's async extractAndLearn for the
   * just-completed turn. No-op if no finalText, no learner, or learning is
   * disabled by config.
   */
  _kickOffLearnerExtraction(opts, finalText, toolLog) {
    const learningMode = this.config.learningMode || 'always';
    if (!(finalText && this.learner && learningMode === 'always')) return;
    this.learner.extractAndLearn(opts.content, finalText, {
      userName: opts.userName,
      channelName: opts.channelName,
      toolCalls: toolLog.length > 0 ? toolLog : undefined,
      // graphcorn: pass the sessionId (= opts.channelId for Spore Code —
      // see web.js:4719 where agentOpts.channelId is set to the WS
      // sessionId). The learner uses this to link every newly-
      // created entity to the session-<id> node via a
      // `discovered_in` edge. Only fires for cli-platform turns
      // where the session node was actually created at session:start.
      sessionId: opts.platform === 'cli' ? opts.channelId : null,
    }).catch(e => this.log.error('[learner] Background extraction error:', e.message));
  }

  /**
   * Fire each plugin context engine's afterTurn hook with the just-
   * completed turn's data. All calls are fire-and-forget; plugin errors
   * are caught at the engine boundary so one bad plugin can't break the
   * loop.
   */
  _firePluginAfterTurn(opts, finalText, toolLog) {
    if (!this._pluginManager) return;
    const turnData = { userMessage: opts.content, assistantResponse: finalText, toolCalls: toolLog };
    for (const engine of this._pluginManager.getContextEngines()) {
      if (engine.engine?.afterTurn) {
        engine.engine.afterTurn(turnData).catch(() => { /* silent: plugin best-effort */ });
      } else if (engine.afterTurn) {
        engine.afterTurn(turnData).catch(() => { /* silent: plugin best-effort */ });
      }
    }
    // Plugin lifecycle hooks (registerLifecycleHook('afterTurn', ...)). Distinct
    // from context-engine afterTurn above — these are plain handlers that get
    // the full opts so plugins can stand in for `_captureFailureFix` /
    // `_recordRoundCheckpoint` etc. without core knowing they exist.
    for (const handler of this._pluginManager.getLifecycleHooks?.('afterTurn') || []) {
      try { handler({ opts, finalText, toolLog, learner: this.learner, log: this.log }); } catch (e) { this.log.warn('[loop] afterTurn lifecycle hook failed: ' + e.message); }
    }
  }

  /**
   * Fire `beforeMessage` plugin lifecycle hooks at the top of _runLoop,
   * BEFORE the system prompt is built. Each handler receives `{ opts }`
   * and may return an object with fields to merge into dynamicOpts
   * (e.g. spore-code returns `{ cachedProjectNodeId, cachedProjectStale,
   * cachedProjectIsNew }` after upserting the project node). Synchronous
   * — handlers that need IO must keep work cheap. Returns the merged
   * patch (or null if no handler ran).
   */
  _firePluginBeforeMessage(opts) {
    if (!this._pluginManager) return null;
    const handlers = this._pluginManager.getLifecycleHooks?.('beforeMessage') || [];
    if (!handlers.length) return null;
    const merged = {};
    let any = false;
    for (const handler of handlers) {
      try {
        const out = handler({ opts, learner: this.learner, log: this.log });
        if (out && typeof out === 'object') { Object.assign(merged, out); any = true; }
      } catch (e) {
        this.log.warn('[loop] beforeMessage lifecycle hook failed: ' + e.message);
      }
    }
    return any ? merged : null;
  }

  /**
   * Build the wide ctx passed to plugin tool/middleware handlers. Pulls from
   * the per-session tool context map first (set in _runLoop), falls back to
   * `opts` so the ctx is populated even before _sessionContexts is attached.
   */
  _buildPluginToolCtx(sessionKey, toolCtx, opts) {
    const sessionCtx = this.tools?._sessionContexts?.get(sessionKey) || toolCtx || {};
    return {
      sessionKey,
      trigger:        sessionCtx.trigger        ?? opts?.trigger        ?? null,
      channelId:      sessionCtx.channelId      ?? opts?.channelId      ?? null,
      platform:       sessionCtx.platform       ?? opts?.platform       ?? null,
      userId:         sessionCtx.userId         ?? opts?.userId         ?? null,
      userName:       sessionCtx.userName       ?? opts?.userName       ?? null,
      userRole:       sessionCtx.userRole       ?? opts?.userRole       ?? null,
      userMessage:    sessionCtx.userMessage    ?? opts?.content        ?? null,
      sessionToken:   sessionCtx.sessionToken   ?? opts?.sessionToken   ?? null,
      projectContext: sessionCtx.projectContext ?? opts?.projectContext ?? null,
      abortSignal:    sessionCtx.abortSignal    ?? opts?._abortSignal   ?? null,
    };
  }

  /**
   * Categorize errors thrown inside the inference-loop iteration and
   * decide what to do next. Returns one of:
   *   { action: 'break' }    — abort signal fired; caller breaks loop
   *   { action: 'continue', messages? } — retry next iteration; caller
   *     re-binds messages if the helper returned a sanitized array
   *   { action: 'rethrow' }  — caller re-throws e
   *
   * Also mutates `ctx.state` (sessionRecoveredThisCall, apiRetries) so the
   * caller can copy the values back into its own let-bindings. Tracks
   * retries across iterations via that shared state.
   */
  async _handleIterationError(e, ctx) {
    const { abortSignal, sessionKey, iterations, opts, messages, state } = ctx;

    if (abortSignal?.aborted || e.name === 'AbortError' || e.message?.includes('aborted')) {
      this.log.info(`[abort] Session ${sessionKey} aborted mid-call`);
      return { action: 'break' };
    }

    this.log.error(`Agent loop error (iteration ${iterations}):`, e.message);
    if (e.stack) this.log.error('  stack:', e.stack);
    if (e.error) this.log.error('API error detail:', JSON.stringify(e.error));

    // 400 with mismatched tool_use/tool_result pairs — try to recover by
    // re-sanitizing, then fall back to clearing the session entirely.
    if (e.status === 400 && e.message?.includes('tool_use') && e.message?.includes('tool_result') && !state.sessionRecoveredThisCall) {
      state.sessionRecoveredThisCall = true;
      this.log.warn(`Corrupted session in ${sessionKey} — attempting re-sanitization`);
      const sanitized = this._sanitizeMessages(messages);
      if (sanitized.length > 1) {
        this.log.info(`Re-sanitized to ${sanitized.length} messages — retrying`);
        return { action: 'continue', messages: sanitized };
      }
      this.log.warn(`Re-sanitization insufficient for ${sessionKey} — clearing session`);
      this.sessions.clearSession(sessionKey);
      return { action: 'continue', messages: [{ role: 'user', content: opts.content }] };
    }

    if (e.status === 400) {
      this.log.error('Request params — model:', this.config.model, 'msgs:', messages.length, 'tools:', this.tools.getToolDefinitions().length);
    }

    if (e.status === 429) {
      this.log.warn('Rate limited, waiting 5s...');
      await this._sleep(5000);
      return { action: 'continue' };
    }

    if (e.status === 529) {
      this.log.warn('API overloaded, waiting 10s...');
      await this._sleep(10000);
      return { action: 'continue' };
    }

    if (e.status === 500 || e.status === 502 || e.status === 503) {
      state.apiRetries = (state.apiRetries || 0) + 1;
      if (state.apiRetries <= 5) {
        const delay = state.apiRetries * 5000;
        this.log.warn(`API server error (${e.status}), retry ${state.apiRetries}/5 in ${delay / 1000}s...`);
        if (opts.onStatus) { try { opts.onStatus({ type: 'api_retry', status: e.status, attempt: state.apiRetries, maxAttempts: 5, delaySec: delay / 1000 }); } catch { /* silent: best-effort UI callback */ } }
        await this._sleep(delay);
        return { action: 'continue' };
      }
      this.log.error(`API server error (${e.status}) — all 5 retries exhausted for session ${sessionKey}`);
    }

    // Network-level failures (no HTTP status). Undici throws a TypeError
    // with message 'fetch failed' when the TCP connection drops mid-
    // stream, the TLS handshake times out, DNS fails, or the peer sends
    // a reset. Also covers ECONNRESET / ETIMEDOUT / ENOTFOUND / socket
    // hang up / premature close. This hits a LOT on custom OAI-compatible
    // providers whose streaming endpoints are less forgiving than
    // Anthropic's — without a retry branch the turn silently dies.
    const msg = (e?.message || '') + ' ' + (e?.cause?.message || '') + ' ' + (e?.cause?.code || '');
    const isNetworkFail = !e.status && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Premature close|network|aborted|terminated/i.test(msg);
    if (isNetworkFail) {
      state.apiRetries = (state.apiRetries || 0) + 1;
      if (state.apiRetries <= 5) {
        const delay = Math.min(state.apiRetries * 3000, 15000);
        this.log.warn(`Network error (${(e.message || '').substring(0, 80)}), retry ${state.apiRetries}/5 in ${delay / 1000}s...`);
        if (opts.onStatus) {
          try { opts.onStatus({ type: 'api_retry', status: 'network', attempt: state.apiRetries, maxAttempts: 5, delaySec: delay / 1000 }); } catch { /* silent: best-effort UI callback */ }
        }
        await this._sleep(delay);
        return { action: 'continue' };
      }
      this.log.error(`Network error — all 5 retries exhausted for session ${sessionKey}`);
    }

    if (opts.onError) opts.onError(e);
    return { action: 'rethrow' };
  }

  /**
   * After tool dispatch: stitch the tool_results into messages, persist a
   * compressed copy to session history, then trim historical tool results
   * from previous iterations (in both the in-memory messages array and
   * the session DB) so the context window doesn't bloat.
   *
   * Mutates `messages` in place. Idempotent across iterations.
   */
  _persistToolResults(sessionKey, messages, toolResults, iterations) {
    messages.push({ role: 'user', content: toolResults });
    // Store compressed tool results in session — full results only needed for current turn
    const compressedResults = toolResults.map(tr => ({
      ...tr,
      content: typeof tr.content === 'string' && tr.content.length > 1500
        ? tr.content.substring(0, 1500) + `\n[...truncated from ${tr.content.length} chars for session storage]`
        : tr.content,
    }));
    this.sessions.addMessage(sessionKey, 'user', compressedResults);
    // Compress old tool results: model already saw them, no need to resend full text.
    // Only compress results from PREVIOUS iterations (not the one we just added).
    if (iterations > 1) {
      this._compressOldToolResults(messages, toolResults);
      // Truncate consumed tool results in the DB so future getHistory calls are lighter
      this.sessions.truncateConsumedToolResults(sessionKey);
    }
  }

  /**
   * Run all tool_use blocks in this turn, returning the collected
   * tool_result blocks plus aggregated flags. Handles:
   *
   *   - parallel-safe tools (read-only, no cross-tool side effects) run
   *     concurrently with Promise.all
   *   - other tools run sequentially
   *   - mixed batches: parallel-safe prefixes are batched, then a
   *     sequential tool runs, then the next parallel-safe prefix, etc.
   *   - abort: each tool is raced against the abort signal so a stuck
   *     tool doesn't block the loop. The race resolves to a synthetic
   *     "Aborted by user." tool_result.
   *
   * Returns:
   *   { toolResults, criticalBlock, delegated }
   * where criticalBlock is OR'd from any per-tool loop-detector trip,
   * and delegated is true if any tool was delegate_task.
   */
  async _executeToolBatch(toolBlocks, ctx) {
    const { abortSignal, sessionKey, loopTracker, toolLog, opts } = ctx;
    const toolResults = [];
    let criticalBlock = false;
    let delegated = false;

    // Safe-to-parallelize tools: read-only, no side effects on each other
    const PARALLEL_SAFE = new Set(['web_search', 'web_fetch', 'read_file', 'graph_query', 'message_read', 'task_status']);

    const runOne = async (toolBlock) => {
      const r = await this._executeOneTool(toolBlock, { abortSignal, sessionKey, loopTracker, toolLog, opts });
      if (r.criticalBlock) criticalBlock = true;
      if (r.delegated) delegated = true;
      return r.result;
    };

    // Race each tool against the abort signal so a stuck tool doesn't block the loop
    const abortRace = abortSignal ? (tb) => Promise.race([
      runOne(tb),
      new Promise(resolve => {
        const onAbort = () => resolve({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify({ error: 'Aborted by user.' }) });
        if (abortSignal.aborted) { onAbort(); return; }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }),
    ]) : runOne;

    const allParallel = toolBlocks.length > 1 && toolBlocks.every(t => PARALLEL_SAFE.has(t.name));
    if (allParallel) {
      this.log.info(`[agent] Executing ${toolBlocks.length} tools in parallel: ${toolBlocks.map(t => t.name).join(', ')}`);
      if (opts.onStatus) { try { opts.onStatus({ type: 'parallel_exec', count: toolBlocks.length, tools: toolBlocks.map(t => t.name) }); } catch { /* silent: best-effort UI callback */ } }
      const results = await Promise.all(toolBlocks.map(tb => abortRace(tb)));
      toolResults.push(...results);
    } else {
      // Mixed batch: run parallel-safe prefix concurrently, then sequential remainder
      let i = 0;
      while (i < toolBlocks.length && !abortSignal?.aborted) {
        // Collect contiguous parallel-safe run
        const batch = [];
        while (i < toolBlocks.length && PARALLEL_SAFE.has(toolBlocks[i].name)) {
          batch.push(toolBlocks[i]);
          i++;
        }
        if (batch.length > 1) {
          this.log.info(`[agent] Parallel batch: ${batch.length} tools (${batch.map(t => t.name).join(', ')})`);
          if (opts.onStatus) { try { opts.onStatus({ type: 'parallel_exec', count: batch.length, tools: batch.map(t => t.name) }); } catch { /* silent: best-effort UI callback */ } }
          const results = await Promise.all(batch.map(tb => abortRace(tb)));
          toolResults.push(...results);
        } else if (batch.length === 1) {
          toolResults.push(await abortRace(batch[0]));
        }
        if (abortSignal?.aborted) break;
        // Execute next sequential tool
        if (i < toolBlocks.length) {
          toolResults.push(await abortRace(toolBlocks[i]));
          i++;
        }
      }
    }

    return { toolResults, criticalBlock, delegated };
  }

  /**
   * Handle the max_tokens stop reason — the model started a tool call
   * but ran out of output budget mid-JSON, so the tool block is unusable.
   * Persists the partial assistant text (or a placeholder), pushes a
   * system reminder telling the model to break its operation up, and
   * lets the loop continue.
   */
  _handleMaxTokens(ctx) {
    const { iterations, iterUsage, responseText, sessionKey, opts, messages } = ctx;
    this.log.warn(`[agent] Iter ${iterations}: hit max_tokens (${iterUsage.output_tokens || '?'} out) — tool call truncated`);
    if (opts.onStatus) { try { opts.onStatus({ type: 'truncated', iteration: iterations, outputTokens: iterUsage.output_tokens }); } catch { /* silent: best-effort UI callback */ } }
    // Store what we have (text only, skip truncated tool blocks)
    if (responseText) {
      this.sessions.addMessage(sessionKey, 'assistant', responseText);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: responseText }] });
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: '[Response truncated at output token limit]' }] });
      this.sessions.addMessage(sessionKey, 'assistant', '[Response truncated at output token limit]');
    }
    messages.push({ role: 'user', content: '[SYSTEM: Your last response was truncated at the output token limit. Your tool call was NOT executed because the JSON was incomplete. Break large operations into smaller steps — write files in sections using edit_file to append, or split into multiple files. Do NOT attempt to write an entire large file in one tool call.]' });
    this.sessions.addMessage(sessionKey, 'user', '[System: output truncated, retry with smaller operations]');
  }

  /**
   * Finalize the iteration when the model produced no tool_use blocks
   * (or signalled end_turn). Persists the assistant text to session
   * history, suppresses re-emission if the text was already streamed as
   * intermediate, and detects mid-stream interjections that should keep
   * the loop running for one more iteration.
   *
   * Returns { action: 'continue' | 'break', finalText, lastSentIntermediate }
   * — the caller mutates messages in place when a continuation is needed
   * (the response.content is pushed onto messages here).
   */
  _handleEndTurn(ctx) {
    const { response, responseText, sessionKey, opts, messages } = ctx;
    let { finalText, lastSentIntermediate } = ctx;
    if (responseText) finalText = responseText;
    // Store in session regardless (for context continuity)
    if (finalText) this.sessions.addMessage(sessionKey, 'assistant', finalText);
    // If the final text was already sent as intermediate, don't re-send it
    if (finalText && finalText === lastSentIntermediate) finalText = null;
    // Before breaking: if a user interjection arrived while we were streaming,
    // don't exit — send the current text as intermediate and continue the loop
    // so the interjection gets processed on the next iteration.
    const pendingIj = this._pendingInterjections.get(sessionKey);
    if (pendingIj && pendingIj.length > 0) {
      this.log.info(`[interject] Interjection pending at end_turn — continuing loop`);
      if (finalText && opts.onTextDelta) {
        // The text was already streamed via deltas, just record it
        lastSentIntermediate = finalText;
      }
      messages.push({ role: 'assistant', content: response.content });
      finalText = null;
      return { action: 'continue', finalText, lastSentIntermediate };
    }
    return { action: 'break', finalText, lastSentIntermediate };
  }

  /**
   * Splice any user interjections that arrived during streaming into the
   * messages array. Interjections are presented as plain user messages —
   * sometimes they're added context, sometimes a pivot, sometimes a
   * cancellation. The model reads the language and decides; we don't
   * prescribe a behavior.
   *
   * Mutates `messages` in place and returns the adjusted iteration count
   * (with headroom restored so the agent has room to respond).
   */
  async _injectPendingInterjections(sessionKey, messages, opts, iterations, ctx) {
    const queued = this._pendingInterjections.get(sessionKey);
    if (!(queued && queued.length > 0)) return { iterations, systemPrompt: ctx?.systemPrompt };
    this._pendingInterjections.delete(sessionKey);

    // Normalize legacy (string) and new ({content, opts}) shapes.
    const items = queued.map(ij => typeof ij === 'string' ? { content: ij, opts: null } : ij);
    const contents = items.map(ij => ij.content);

    this.log.info(`[interject] Injecting ${items.length} user message(s) into session ${sessionKey}`);

    // The Anthropic API requires alternating user/assistant turns. If the
    // last message is already a user turn (e.g. tool_results still pending),
    // insert a minimal assistant ack so the new user message is well-formed.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'user') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: '[Acknowledged.]' }] });
    }
    const raw = contents.length === 1
      ? contents[0]
      : contents.map((c, i) => `(${i + 1}) ${c}`).join('\n\n');
    messages.push({ role: 'user', content: raw });
    for (const c of contents) this.sessions.addMessage(sessionKey, 'user', c);
    if (opts.onStatus) {
      try { opts.onStatus({ type: 'interjection', count: items.length }); } catch { /* silent */ }
    }

    // Mode toggle detection — if any queued interjection brings a
    // different projectContext.mode (plan↔execute), the loop's original
    // system prompt is wrong for the rest of this run. Rebuild before
    // the next iteration so the agent sees Plan Mode / Execute Mode
    // sections matching the user's actual current intent. Without this,
    // a user typing during a streaming response and toggling /plan
    // would have their plan request processed under the execute-mode
    // prompt — agent never sees the PLAN_READY rule and the modal
    // never triggers.
    let systemPrompt = ctx?.systemPrompt;
    if (ctx && ctx.dynamicOpts) {
      const currentMode = opts.projectContext?.mode;
      const newMode = items.map(ij => ij.opts?.projectContext?.mode).filter(Boolean).pop();
      if (newMode && newMode !== currentMode) {
        // Adopt the new projectContext for the rest of the loop.
        opts.projectContext = items.map(ij => ij.opts?.projectContext).filter(Boolean).pop() || opts.projectContext;
        try {
          systemPrompt = await this.graph.buildSystemPromptAsync({
            ...ctx.dynamicOpts,
            promptMode: ctx.promptMode,
            projectContext: opts.projectContext,
            _llmClient: ctx.llmClient,
            cachedProjectNodeId: ctx.cachedProjectNodeId,
            cachedProjectStale: ctx.cachedProjectStale,
            cachedProjectIsNew: ctx.cachedProjectIsNew,
          });
          this.log.info(`[interject] Mode change ${currentMode || '(unset)'} → ${newMode} — system prompt rebuilt (${systemPrompt.length} bytes)`);
          // Run the same marker validator the initial build does, so we
          // can confirm that the rebuilt plan-mode prompt actually carries
          // the planHeader / rulesHeader / QUESTIONS: / PLAN_READY anchors
          // (without this we'd be flying blind on the rebuild path).
          if (newMode === 'plan') {
            const has = {
              planHeader: systemPrompt.includes('## Plan Mode'),
              questionsMarker: systemPrompt.includes('QUESTIONS:'),
              planReadyMarker: systemPrompt.includes('PLAN_READY'),
              rulesHeader: systemPrompt.includes('RULES'),
            };
            const missing = Object.entries(has).filter(([_, v]) => !v).map(([k]) => k);
            if (missing.length > 0) {
              this.log.warn(`[plan-mode] (rebuild) system prompt MISSING markers: ${missing.join(', ')}`);
            } else {
              this.log.info(`[plan-mode] (rebuild) system prompt OK — all 4 markers present`);
            }
          }
          // Dump the rebuilt prompt to disk under a distinct filename so
          // we can inspect what actually went to the model on the
          // post-mode-toggle iteration (the regular SPORE_DEBUG_DUMP_PROMPT
          // dump fires only on the initial build at _runLoop start, which
          // captures the OLD mode's prompt — useless for diagnosing
          // "the rebuild fired but the modal didn't trigger" cases).
          if (process.env.SPORE_DEBUG_DUMP_PROMPT === '1') {
            try {
              const fs = require('fs');
              const path = require('path');
              const dir = process.env.SPORE_DEBUG_DUMP_DIR || '/data';
              const outFile = path.join(dir, `last-prompt-rebuild-${newMode}.txt`);
              const dump = [
                `# REBUILT — mode change ${currentMode || '(unset)'} → ${newMode}`,
                `# session=${sessionKey}`,
                `# systemPrompt length: ${systemPrompt.length} chars`,
                `# planHeader=${systemPrompt.includes('## Plan Mode')} rulesHeader=${systemPrompt.includes('RULES')} planReady=${systemPrompt.includes('PLAN_READY')} questions=${systemPrompt.includes('QUESTIONS:')}`,
                '',
                '── SYSTEM PROMPT ──',
                systemPrompt,
              ].join('\n');
              fs.writeFileSync(outFile, dump);
              this.log.info(`[debug] wrote rebuilt system prompt to ${outFile}`);
            } catch (e) {
              this.log.warn(`[debug] rebuild dump failed: ${e.message}`);
            }
          }
        } catch (e) {
          this.log.warn(`[interject] system prompt rebuild failed: ${e.message} — continuing with old prompt`);
          systemPrompt = ctx.systemPrompt;
        }
      }
    }

    return { iterations: Math.max(0, iterations - 4), systemPrompt };
  }

  /**
   * 2-tier escalation: casual → normal on any tool use. Planner (Opus) is
   * reserved for explicit delegation only — triggered when the agent calls
   * delegate_task, not on routine tool use. Returns the (possibly updated)
   * activeModel; caller assigns the result back.
   */
  _maybeEscalateModel(toolBlocks, activeModel) {
    if (!(toolBlocks.length > 0 && activeModel)) return activeModel;
    const casualM = this.config.casualModel || this.config.normalModel;
    const normalM = this.config.normalModel || this.config.plannerModel;
    if (activeModel === casualM && casualM !== normalM) {
      activeModel = normalM;
      this.log.info(`[escalation] casual → normal (${activeModel})`);
    }
    const plannerM = this.config.plannerModel;
    if (activeModel === normalM && normalM !== plannerM) {
      const hasDelegation = toolBlocks.some(b => b.name === 'delegate_task');
      if (hasDelegation) {
        activeModel = plannerM;
        this.log.info(`[escalation] normal → planner (${activeModel}) — delegation requested`);
      }
    }
    return activeModel;
  }

  /**
   * Execute one tool_use block and return the tool_result plus side-effect
   * flags. Handles abort, malformed input, loop detection, status callbacks,
   * result truncation, and the loop-tracker bookkeeping. Pure on its inputs
   * apart from emitting graphEvents and pushing to ctx.toolLog.
   *
   * Returns: {
   *   result: { type, tool_use_id, content }   // tool_result block to send back
   *   criticalBlock: bool                      // loop detector tripped
   *   delegated: bool                          // delegate_task was the tool
   * }
   */
  async _executeOneTool(toolBlock, ctx) {
    const { abortSignal, sessionKey, loopTracker, toolLog, opts } = ctx;
    let criticalBlock = false;
    let delegated = false;

    if (abortSignal?.aborted) {
      return {
        result: {
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify({ error: 'Aborted by user.' }),
        },
        criticalBlock, delegated,
      };
    }

    this.log.info(`Tool call: ${toolBlock.name}(${JSON.stringify(toolBlock.input).substring(0, 100)})`);

    if (toolBlock.input?._parse_error) {
      this.log.warn(`[agent] Tool ${toolBlock.name}: argument JSON was malformed`);
      return {
        result: {
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify({ error: toolBlock.input._parse_error }),
        },
        criticalBlock, delegated,
      };
    }

    const callHash = this._hashToolCall(toolBlock.name, toolBlock.input);
    const loopCheck = this._checkToolLoop(loopTracker, callHash, toolBlock.name);

    if (loopCheck.blocked) {
      this.log.warn(`[loop-detect] CRITICAL: ${loopCheck.message}`);
      criticalBlock = true;
      return {
        result: {
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: JSON.stringify({ error: loopCheck.message }),
        },
        criticalBlock, delegated,
      };
    }

    if (toolBlock.name === 'delegate_task') delegated = true;

    const toolDetail = this._toolInputSummary(toolBlock.name, toolBlock.input);
    graphEvents.emit('change', { op: 'tool:call', tool: toolBlock.name, input: JSON.stringify(toolBlock.input).substring(0, 200), source: 'agent' });
    if (opts.onStatus) { try { opts.onStatus({ type: 'tool_exec_start', tool: toolBlock.name, detail: toolDetail }); } catch { /* silent: best-effort UI callback */ } }
    const toolExecStart = Date.now();
    // Pass the session's context explicitly so concurrent sessions
    // don't race on a shared "current session" field in tools.js.
    const toolCtx = this.tools._sessionContexts?.get(sessionKey) || { sessionKey };

    // Plugin middleware: beforeToolExec — handlers get the same wide ctx the
    // plugin tool dispatcher gets, so a plugin observing graph_update can read
    // sessionToken / projectContext / platform without touching `this.tools`.
    if (this._pluginManager) {
      const pluginCtx = this._buildPluginToolCtx(sessionKey, toolCtx, opts);
      for (const handler of this._pluginManager.getMiddleware('beforeToolExec')) {
        try { await handler({ name: toolBlock.name, input: toolBlock.input, toolUseId: toolBlock.id, sessionKey, ctx: pluginCtx }); } catch (e) { this.log.warn('[loop] beforeToolExec handler failed: ' + e.message); }
      }
    }

    let result;
    if (opts.onToolExecute) {
      result = await opts.onToolExecute(toolBlock.name, toolBlock.input, toolBlock.id);
      if (result === null || result === undefined) {
        result = await this.tools.executeTool(toolBlock.name, toolBlock.input, toolCtx);
      }
    } else {
      result = await this.tools.executeTool(toolBlock.name, toolBlock.input, toolCtx);
    }
    let resultContent = JSON.stringify(result);

    const toolExecMs = Date.now() - toolExecStart;

    // Plugin middleware: afterToolExec — handlers can mutate the graph as a
    // side-effect (e.g. spore-code plugin tags new nodes after graph_update). The
    // wide ctx mirrors what executePluginTool passes so middleware doesn't
    // need to reach into the tools host for session metadata.
    if (this._pluginManager) {
      const pluginCtx = this._buildPluginToolCtx(sessionKey, toolCtx, opts);
      for (const handler of this._pluginManager.getMiddleware('afterToolExec')) {
        try { await handler({ name: toolBlock.name, input: toolBlock.input, toolUseId: toolBlock.id, result, durationMs: toolExecMs, sessionKey, ctx: pluginCtx }); } catch (e) { this.log.warn('[loop] afterToolExec handler failed: ' + e.message); }
      }
    }
    this.log.info(`[agent] Tool ${toolBlock.name} done — ${toolExecMs}ms, ${resultContent.length} chars`);
    if (opts.onStatus) { try { opts.onStatus({ type: 'tool_exec_done', tool: toolBlock.name, detail: toolDetail, durationMs: toolExecMs, resultChars: resultContent.length }); } catch { /* silent: best-effort UI callback */ } }

    if (opts.onStatus && !result.error) {
      try { this._emitCodeEvent(toolBlock.name, toolBlock.input, result, opts.onStatus); } catch (e) { this.log.warn('[loop] this._emitCodeEvent failed: ' + e.message); }
    }

    // Normalize the failure signal across tool result shapes:
    //   • Local-tool error path returns { error: '...' } → succeeded=false.
    //   • Spore Code shell.go returns { output, exitCode: N } with no error key
    //     even for non-zero exits — succeeded would be true. Surface exitCode
    //     so plugin middleware (e.g. spore-code failure_fix) can detect those.
    const exitCode = (result && typeof result === 'object')
      ? (result.exitCode ?? result.exit_code ?? null)
      : null;
    toolLog.push({
      tool: toolBlock.name,
      input: JSON.stringify(toolBlock.input).substring(0, 300),
      resultPreview: resultContent.substring(0, 300),
      succeeded: !result.error,
      exitCode,
    });

    const defaultCap = this.config.maxToolResultChars || effortDefaults(this.config).maxToolResultChars || TOOL_RESULT_DEFAULT_CAP;
    const maxResultChars = TOOL_RESULT_CAPS[toolBlock.name] ?? defaultCap;
    if (resultContent.length > maxResultChars) {
      const truncated = resultContent.length;
      resultContent = resultContent.substring(0, maxResultChars)
        + `\n\n[OUTPUT TRUNCATED: ${truncated} chars → ${maxResultChars}. Use offset/limit params for large files.]`;
      this.log.warn(`Tool result truncated: ${toolBlock.name} returned ${truncated} chars`);
    }

    const resultHash = this._hashResult(resultContent);
    this._recordToolResult(loopTracker, callHash, resultHash);

    if (loopCheck.warning) {
      this.log.warn(`[loop-detect] WARNING: ${loopCheck.message}`);
      resultContent += `\n\n--- WARNING: ${loopCheck.message} ---`;
    }

    return {
      result: {
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: resultContent,
      },
      criticalBlock, delegated,
    };
  }

  // ── Multimodal attachment handling ──────────────────────────────────

  _buildMediaBlocks(opts = {}) {
    const blocks = [];
    if (Array.isArray(opts.images)) {
      for (const img of opts.images) {
        if (img?.type === 'image' && img.source?.type === 'base64') blocks.push(img);
      }
    }
    if (Array.isArray(opts.media)) {
      for (const media of opts.media) {
        if (!media?.type || media.source?.type !== 'base64') continue;
        if (['image', 'audio', 'input_audio', 'video', 'file'].includes(media.type)) {
          blocks.push(media);
        }
      }
    }
    return blocks;
  }

  _hasDedicatedVlmTiers() {
    return Boolean(
      this.config.imageVlmModel
      || this.config.videoVlmModel
      || this.config.audioVlmModel
    );
  }

  _saveMediaToDisk(mediaBlocks) {
    const fs = require('fs');
    const path = require('path');
    const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { this.log.warn('[loop] fs.mkdirSync failed: ' + e.message); }
    const saved = [];
    const extByMime = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
      'audio/webm': 'webm',
      'audio/flac': 'flac',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-matroska': 'mkv',
      'video/x-msvideo': 'avi',
    };
    for (const media of mediaBlocks) {
      try {
        if (!media?.type || media.source?.type !== 'base64') continue;
        const mediaType = String(media.source.media_type || '').toLowerCase();
        const ext = extByMime[mediaType] || mediaType.split('/')[1] || 'bin';
        const safeExt = ext.replace(/[^a-z0-9]/gi, '') || 'bin';
        const prefix = media.type === 'input_audio' ? 'audio' : media.type;
        const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${safeExt}`;
        const filePath = path.join(uploadDir, name);
        fs.writeFileSync(filePath, Buffer.from(media.source.data, 'base64'));
        saved.push(filePath);
        this.log.info(`[upload] Saved ${prefix} to ${filePath} (${media.source.media_type})`);
      } catch (e) {
        this.log.warn(`[upload] Failed to save attachment: ${e.message}`);
      }
    }
    return saved;
  }

  _saveImagesToDisk(images) {
    return this._saveMediaToDisk(images);
  }

  // ── Model-aware output token limits ─────────────────────────────────

  _modelMaxOutputTokens(model) {
    if (!model) return MODEL_OUTPUT_TOKEN_FALLBACK;
    // Plugin-populated source of truth: each provider plugin's listModels
    // returns maxOutput per-model and the wizard / settings save persists
    // it into config.modelLimits[model].maxTokens (see _enrichModelLimits
    // in the web gateway). Look up the resolved entry directly so the
    // agent gets the actual vendor-published cap (claude-opus-4-7 → 32K,
    // sonnet-4-x → 64K, haiku-4-5 → 8K, gpt-4.1 → 32K, etc.) without
    // hardcoded vendor patterns here.
    const lim = this._lookupModelLimit(model);
    if (lim?.maxTokens > 0) return Math.min(lim.maxTokens, MODEL_OUTPUT_TOKEN_CEILING);
    return MODEL_OUTPUT_TOKEN_FALLBACK; // generic fallback for models not yet probed
  }

  // Resolve a model ref against config.modelLimits with a few key forms so
  // lookups are consistent everywhere. Returns the limit entry or null.
  //   1. Direct match (handles e.g. "kimi//blob/raw/…/Kimi-K2.6")
  //   2. Any stored key that ENDS with "/<model>" (handles bare-name model
  //      lookup against provider/model keys)
  //   3. Any stored key that, when provider-prefixed-stripped, equals model
  _lookupModelLimit(model) {
    const limits = this.config.modelLimits;
    if (!limits || !model) return null;
    if (limits[model]) return limits[model];
    for (const k of Object.keys(limits)) {
      if (k.endsWith('/' + model)) return limits[k];
      const slash = k.indexOf('/');
      if (slash > 0 && k.slice(slash + 1) === model) return limits[k];
    }
    return null;
  }

  // Translator: turns a categorical reasoning effort
  // (off/minimal/low/medium/high/max) into whatever field each provider
  // family actually accepts. Now plugin-first — each provider plugin
  // owns its own vendor switch (see e.g. plugins/anthropic-provider's
  // applyAnthropicReasoningEffort, plugins/openai-provider's
  // applyOpenAIReasoningEffort). Core only carries the no-plugin
  // fallback (generic OAI-compat reasoning_effort passthrough) for
  // models that route through a backend without a plugin attached.
  // Static so the probe endpoint can reuse it without constructing a loop.
  static applyReasoningEffort(req, model, effort) {
    return AgentLoop._applyReasoningEffortImpl(req, model, effort);
  }
  _applyReasoningEffort(req, model, effort) {
    return AgentLoop._applyReasoningEffortImpl(req, model, effort);
  }
  static _applyReasoningEffortImpl(req, model, effort) {
    // Plugin-first: any registered provider plugin whose name matches
    // detectBackend(model) and that exposes applyReasoningEffort wins.
    try {
      const { applyReasoningEffortViaPlugin } = require('../providers');
      const viaPlugin = applyReasoningEffortViaPlugin(req, model, effort);
      if (viaPlugin) return viaPlugin;
    } catch (e) {
      // Module load errors fall through to the generic fallback below.
    }

    // No-plugin fallback — generic OAI-compat reasoning_effort passthrough.
    // Only fires when the model's backend has no provider plugin attached
    // (early boot or operator-disabled). Keeps the agent loop alive on
    // unfamiliar endpoints.
    const out = { ...req };
    if (effort === 'off') { delete out.reasoning_effort; return out; }
    if (effort) {
      const v = effort === 'minimal' ? 'low' : (effort === 'max' ? 'high' : effort);
      out.reasoning_effort = v;
    }
    return out;
  }

  // ── Tool Input Summary (for panel streaming) ────────────────────────

  _toolInputSummary(name, input) {
    if (!input) return '';
    switch (name) {
      case 'web_fetch': return input.url ? input.url.substring(0, 120) : '';
      case 'web_search': return input.query ? input.query.substring(0, 100) : '';
      case 'read_file': return input.path ? input.path.split('/').slice(-2).join('/') : '';
      case 'write_file': return input.path ? input.path.split('/').slice(-2).join('/') : '';
      case 'edit_file': return input.path ? input.path.split('/').slice(-2).join('/') : '';
      case 'exec': return (input.command || '').substring(0, 80);
      case 'graph_query': return input.query ? input.query.substring(0, 80) : '';
      case 'graph_update': return input.label ? input.label.substring(0, 60) : '';
      case 'graph_delete': return input.label || input.nodeId || '';
      case 'message_send': return input.target ? input.target.substring(0, 40) : '';
      case 'delegate_task': return (input.task || '').substring(0, 80);
      case 'web_serve': return input.action || '';
      case 'save_tool': return input.name || '';
      default: return '';
    }
  }

  // ── Code Viewer Events (floating panel) ─────────────────────────────

  _emitCodeEvent(toolName, input, result, onStatus) {
    const CODE_CAP = 51200;
    const EXT_LANG = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
      html: 'html', htm: 'html', css: 'css', scss: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash', xml: 'xml', svg: 'xml', toml: 'toml',
      lua: 'lua', php: 'php', swift: 'swift', kt: 'kotlin', r: 'r', pl: 'perl',
    };
    const langFromPath = (p) => {
      if (!p) return 'text';
      const ext = p.split('.').pop().toLowerCase();
      return EXT_LANG[ext] || 'text';
    };

    if (toolName === 'read_file' && result.content != null) {
      const content = String(result.content);
      if (content.length > CODE_CAP || /[\x00-\x08\x0E-\x1F]/.test(content.substring(0, 512))) return;
      onStatus({
        type: 'code:view',
        path: input.path,
        content,
        language: langFromPath(input.path),
        lineCount: content.split('\n').length,
      });
    } else if (toolName === 'write_file' && input.content != null) {
      const content = String(input.content);
      if (content.length > CODE_CAP) return;
      onStatus({
        type: 'code:view',
        path: input.path,
        content,
        language: langFromPath(input.path),
        lineCount: content.split('\n').length,
        isNew: true,
      });
    } else if (toolName === 'edit_file' && input.old_text != null && input.new_text != null) {
      onStatus({
        type: 'code:diff',
        path: input.path,
        language: langFromPath(input.path),
        oldText: String(input.old_text).substring(0, CODE_CAP),
        newText: String(input.new_text).substring(0, CODE_CAP),
      });
    }
  }

  // ── Loop Detection ──────────────────────────────────────────────────

  _hashToolCall(toolName, input) {
    return toolName + ':' + JSON.stringify(input);
  }

  _hashResult(resultStr) {
    return String(resultStr).substring(0, 500);
  }

  _recordToolResult(tracker, callHash, resultHash) {
    const entry = tracker.history.find(h => h.callHash === callHash);
    if (entry) {
      const progressed = entry.lastResultHash !== resultHash;
      entry.lastResultHash = resultHash;
      if (progressed) {
        entry.noProgressCount = 0;
      } else {
        entry.noProgressCount++;
      }
    }
  }

  _checkToolLoop(tracker, callHash, toolName) {
    const warnThreshold = this.config.loopDetection?.warn || 5;
    const criticalThreshold = this.config.loopDetection?.critical || 10;
    const pingPongThreshold = this.config.loopDetection?.pingPong || 8;

    // Find or create entry for this call pattern
    let entry = tracker.history.find(h => h.callHash === callHash);
    if (!entry) {
      entry = { callHash, toolName, count: 0, noProgressCount: 0, lastResultHash: null };
      tracker.history.push(entry);
      if (tracker.history.length > tracker.maxHistory) tracker.history.shift();
    }
    entry.count++;

    // Track call sequence for ping-pong detection
    if (!tracker.sequence) tracker.sequence = [];
    tracker.sequence.push(callHash);

    // Check for ping-pong: last N calls alternate between exactly 2 patterns
    if (tracker.sequence.length >= pingPongThreshold) {
      const recent = tracker.sequence.slice(-pingPongThreshold);
      const unique = new Set(recent);
      if (unique.size === 2) {
        const [a, b] = [...unique];
        const isAlternating = recent.every((h, i) => h === (i % 2 === 0 ? recent[0] : recent[1]));
        if (isAlternating) {
          const entryA = tracker.history.find(h => h.callHash === a);
          const entryB = tracker.history.find(h => h.callHash === b);
          const nameA = entryA?.toolName || 'unknown';
          const nameB = entryB?.toolName || 'unknown';
          return {
            blocked: true,
            warning: false,
            message: `BLOCKED: Ping-pong loop detected — alternating between ${nameA} and ${nameB} for ${pingPongThreshold} calls with no progress. Produce your final response now.`,
          };
        }
      }
    }

    // Check no-progress repeats (only meaningful after we have result hashes)
    const noProgress = entry.noProgressCount;

    if (noProgress >= criticalThreshold) {
      return {
        blocked: true,
        warning: false,
        message: `BLOCKED: Loop detected — ${toolName} called ${entry.count} times with identical args and no progress (${noProgress} identical results). Produce your final response now.`,
      };
    }

    if (noProgress >= warnThreshold) {
      return {
        blocked: false,
        warning: true,
        message: `You have called ${toolName} with identical arguments ${entry.count} times with no new results (${noProgress} identical). You may be stuck in a loop. Try a different approach.`,
      };
    }

    return { blocked: false, warning: false };
  }

  /**
   * Decide whether a tool-enabled turn should skip streaming.
   *
   * History: tool turns used to always go non-stream because some providers
   * had flaky tool_call delta reassembly. That's been solid in
   * providers/index.js for a while now — every OAI chunk's
   * `delta.tool_calls[].function.{name,arguments}` is accumulated across
   * chunks and emitted cleanly at stream end.
   *
   * The non-stream fallback is actively harmful on slow upstreams: a big
   * reasoning model (Kimi, GLM, long context) can generate for longer than
   * the fronting nginx's `proxy_read_timeout`, and we get a 504 while the
   * model is still producing tokens. Streaming keeps bytes flowing, so
   * nginx stays happy.
   *
   * Default is now streaming. Set `config.nonStreamToolTurns: true` to
   * revert if a provider regresses.
   */
  _shouldUseNonStreamToolTurn(requestOpts) {
    if (!Array.isArray(requestOpts?.tools) || requestOpts.tools.length === 0) return false;
    return this.config.nonStreamToolTurns === true;
  }

  _createAbortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  }

  async _callNonStream(requestOpts, opts = {}) {
    const signal = opts.abortSignal;
    if (signal?.aborted) throw this._createAbortError();

    const callPromise = Promise.resolve(
      this.client.messages.create(requestOpts, signal ? { signal } : undefined)
    );

    const response = signal
      ? await new Promise((resolve, reject) => {
        const onAbort = () => reject(this._createAbortError());
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        callPromise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      })
      : await callPromise;

    const textBlocks = Array.isArray(response?.content)
      ? response.content.filter(b => b.type === 'text')
      : [];
    const toolBlocks = Array.isArray(response?.content)
      ? response.content.filter(b => b.type === 'tool_use')
      : [];
    const responseText = textBlocks.map(b => b.text || '').join('');

    if (responseText && opts.onTextDelta) {
      try { opts.onTextDelta(responseText); } catch { /* silent: best-effort UI callback */ }
    }
    if (toolBlocks.length > 0 && opts.onToolUse) {
      for (const toolBlock of toolBlocks) {
        if (!toolBlock?.name) continue;
        try { opts.onToolUse(toolBlock.name, toolBlock.input); } catch { /* silent: best-effort UI callback */ }
      }
    }

    return response;
  }

  /**
   * Call the Claude API
   */
  async _callLLM(systemPrompt, messages, opts = {}) {
    const staticPart = opts.staticPrompt || null;
    const dynamicPart = opts.dynamicContext || null;
    let system;
    if (staticPart && dynamicPart) {
      system = [
        { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicPart },
      ];
    } else if (staticPart) {
      system = [
        { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
      ];
    } else {
      system = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ];
    }
    // Plugin hook — anthropic-provider prepends its Claude Code
    // identity prefix when an OAuth token is active. Other providers
    // pass through unchanged.
    const { wrapSystemPromptForModel } = require('../providers');
    system = wrapSystemPromptForModel(system, this.config.model, this.config);

    // Tag last tool with cache_control so the full tool array is cached on repeat calls.
    // Pass the per-call platform explicitly so the cli-tool-catalog filter doesn't
    // race with the legacy `_currentPlatform` global in concurrent multi-session runs.
    const tools = opts.tools || this.tools.getToolDefinitions({ platform: opts.platform });
    if (tools.length > 0) {
      const last = tools[tools.length - 1];
      if (!last.cache_control) {
        tools[tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      }
    }

    // Tag the last user message for caching — ensures the full conversation
    // prefix (system + tools + all prior turns) is cached across iterations.
    // First, strip any prior cache_control from earlier iterations to stay under
    // the 4-breakpoint API limit (system + tools + 1 message = 3).
    if (messages.length >= 2) {
      for (const m of messages) {
        if (m.role === 'user' && Array.isArray(m.content)) {
          for (let j = 0; j < m.content.length; j++) {
            if (m.content[j].cache_control) {
              const { cache_control, ...rest } = m.content[j];
              m.content[j] = rest;
            }
          }
        }
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const msg = messages[i];
          if (Array.isArray(msg.content) && msg.content.length > 0) {
            const lastBlock = msg.content[msg.content.length - 1];
            msg.content[msg.content.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
          } else if (typeof msg.content === 'string') {
            msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
          }
          break;
        }
      }
    }

    const requestedModel = opts.model || this.config.model;
    const baseRequest = {
      model: requestedModel,
      system,
      messages,
      tools,
    };
    const resolvedRequest = this.client?.resolveRequest?.(baseRequest)
      || { ...baseRequest, model: this.client?.resolveModel?.(baseRequest) || requestedModel };
    const model = resolvedRequest.model || requestedModel;
    // Precedence: per-model override (modelLimits[<ref>].maxTokens) → global
    // config.maxTokens (if operator changed it from the MODEL_OUTPUT_TOKEN_FALLBACK
    // default) → model family heuristic.
    const _modelLim = this._lookupModelLimit(model);
    const _perModelMax = Number(_modelLim?.maxTokens) || 0;
    const maxTokens = _perModelMax > 0
      ? _perModelMax
      : (this.config.maxTokens !== MODEL_OUTPUT_TOKEN_FALLBACK ? this.config.maxTokens : this._modelMaxOutputTokens(model));
    let requestOpts = {
      max_tokens: maxTokens,
      ...resolvedRequest,
      model,
    };
    // Default reasoning effort — each provider plugin declares
    // getDefaultReasoningEffort(model, hostConfig) and knows which
    // host-config field is its knob (anthropic.thinkingBudget vs
    // openai.openaiReasoningEffort vs ...). The translator then maps
    // the categorical effort to the vendor's wire shape. Vendor logic
    // lives in the plugin, not duplicated here.
    let _defaultEffort = null;
    try {
      const { getDefaultReasoningEffort } = require('../providers');
      _defaultEffort = getDefaultReasoningEffort(model, this.config);
    } catch { /* module load — fall through, no default effort applied */ }
    if (_defaultEffort) {
      requestOpts = this._applyReasoningEffort(requestOpts, model, _defaultEffort);
    }
    // Per-model reasoning effort override (categorical: off/minimal/low/medium/high/max).
    // Translated to whatever knob each provider family actually accepts.
    const _effort = _modelLim?.reasoningEffort || null;
    if (_effort && _effort !== 'auto') {
      requestOpts = this._applyReasoningEffort(requestOpts, model, _effort);
    }

    const signal = opts.abortSignal;
    const useToolTurnNonStream = this._shouldUseNonStreamToolTurn(requestOpts);

    if (useToolTurnNonStream) {
      const fallbackStart = Date.now();
      this.log.info(`[stream] ${model} — tool turn using non-stream request`);
      if (opts.onStatus) {
        try { opts.onStatus({ type: 'mode', mode: 'non_stream_tool_turn', model, reason: 'tool_turn' }); } catch { /* silent: best-effort UI callback */ }
      }

      const response = await this._callNonStream(requestOpts, opts);
      const elapsedMs = Date.now() - fallbackStart;
      const content = Array.isArray(response?.content) ? response.content : [];
      const responseText = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
      const toolCount = content.filter(b => b.type === 'tool_use').length;

      this.log.info(`[stream] ${model} — non-stream fallback complete, ${elapsedMs}ms, ${responseText.length} chars, ${toolCount} tool(s)`);
      if (opts.onStatus) {
        try {
          opts.onStatus({
            type: 'non_stream_done',
            elapsed: Math.round(elapsedMs / 1000),
            phase: toolCount > 0 ? 'tool_call' : 'generating',
            chars: responseText.length,
            tools: toolCount,
            thinkingTokens: 0,
          });
        } catch { /* silent: best-effort UI callback */ }
      }
      return response;
    }

    // Always stream — Anthropic API requires it for long-running requests.
    // Callbacks are optional; when absent we still stream but discard events.
    const stream = this.client.messages.stream(requestOpts);
    if (signal) {
      const onAbort = () => { try { stream.abort(); } catch { /* silent: best-effort terminate */ } };
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('end', () => signal.removeEventListener('abort', onAbort));
    }

    let _streamChars = 0;
    let _streamToolCount = 0;
    let _thinkingTokens = 0;
    let _thinkingText = '';
    let _phase = 'thinking';
    let _currentToolName = '';
    let _toolArgBytes = 0;
    const _streamStart = Date.now();
    const heartbeatMs = 5000;
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - _streamStart) / 1000);
      this.log.info(`[stream] ${model} — ${elapsed}s, phase=${_phase}, ${_streamChars} chars, ${_streamToolCount} tool(s), ${_thinkingTokens} thinking`);
      if (opts.onStatus) {
        try { opts.onStatus({ type: 'heartbeat', elapsed, phase: _phase, chars: _streamChars, tools: _streamToolCount, thinkingTokens: _thinkingTokens, toolName: _currentToolName }); } catch { /* silent: best-effort UI callback */ }
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    stream.on('event', (event) => {
      try {
        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          _phase = 'thinking';
          _thinkingText = '';
          if (opts.onStatus) opts.onStatus({ type: 'thinking_start' });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
          _thinkingTokens++;
          const chunk = event.delta.thinking || '';
          _thinkingText += chunk;
          if (chunk && opts.onThinkingDelta) {
            try { opts.onThinkingDelta(chunk); } catch { /* silent: best-effort UI callback */ }
          }
          if (_thinkingTokens % 5 === 0 && opts.onStatus) {
            const snippet = _thinkingText.length > 200
              ? _thinkingText.slice(-200).replace(/^\S*\s/, '')
              : _thinkingText;
            opts.onStatus({ type: 'thinking', tokens: _thinkingTokens, snippet });
          }
        }
        if (event.type === 'content_block_stop' && _phase === 'thinking') {
          _phase = 'generating';
          if (opts.onStatus) opts.onStatus({ type: 'thinking_done', tokens: _thinkingTokens });
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          _phase = 'tool_call';
          _currentToolName = event.content_block.name || '';
          _streamToolCount++;
          _toolArgBytes = 0;
          if (opts.onToolUse) opts.onToolUse(event.content_block.name);
        }
        if (event.type === 'tool_use_delta' && opts.onStatus) {
          opts.onStatus({ type: 'tool_progress', tool: event.name || _currentToolName, bytes: event.argsLength });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          _toolArgBytes += (event.delta.partial_json || '').length;
          if (_toolArgBytes % 200 < 50 && opts.onStatus) {
            opts.onStatus({ type: 'tool_progress', tool: _currentToolName, bytes: _toolArgBytes });
          }
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
          _phase = 'generating';
        }
      } catch { /* silent: best-effort UI callback */ }
    });

    if (opts.onTextDelta) {
      stream.on('text', (text) => {
        _streamChars += text.length;
        try { opts.onTextDelta(text); } catch { /* silent: best-effort UI callback */ }
      });
    }

    try {
      return await stream.finalMessage();
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * After a user-initiated abort, aggressively trim the session so the
   * new instruction has maximum weight over old context.
   *
   * Strategy: keep only the last few real conversational exchanges
   * (user text + assistant text, no tool blocks). This prevents hundreds
   * of old messages from drowning out the user's new direction.
   */
  _cleanSessionAfterAbort(sessionKey) {
    const history = this.sessions.getHistory(sessionKey, 200);
    if (!history || history.length === 0) return;

    // ── Pass 1: extract real conversational turns and tool activity ──
    const realTurns = [];
    const filesRead = new Set();
    const filesWritten = new Set();
    const commandsRun = [];
    const toolCounts = {};
    const userTopics = [];

    for (const msg of history) {
      if (msg.role === 'user') {
        const isToolResult = Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result');
        if (isToolResult) continue;
        const text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
        if (text.startsWith('[SYSTEM:') || text.startsWith('[PRIORITY')) continue;
        if (text.trim()) {
          realTurns.push({ role: 'user', content: text.length > 2000 ? text.slice(0, 2000) + '...' : text });
          if (text.length > 20 && text.length < 500) userTopics.push(text.slice(0, 150));
        }
      } else if (msg.role === 'assistant') {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        // Extract tool usage from assistant messages
        for (const b of blocks) {
          if (b.type === 'tool_use') {
            toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
            const inp = b.input || {};
            if (b.name === 'read_file' && inp.path) filesRead.add(inp.path);
            if (b.name === 'write_file' && inp.path) filesWritten.add(inp.path);
            if (b.name === 'edit_file' && inp.path) filesWritten.add(inp.path);
            if (b.name === 'exec' && inp.command) commandsRun.push(inp.command.slice(0, 80));
          }
        }
        const text = typeof msg.content === 'string' ? msg.content
          : blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text.trim()) realTurns.push({ role: 'assistant', content: text.length > 2000 ? text.slice(0, 2000) + '...' : text });
      }
    }

    // ── Pass 2: build the activity summary ──
    const summaryParts = ['[SESSION SUMMARY — your previous work before the user interrupted:]'];
    if (userTopics.length > 0) {
      summaryParts.push(`User requests: ${userTopics.slice(0, 5).join(' | ')}`);
    }
    if (filesWritten.size > 0) {
      summaryParts.push(`Files modified: ${[...filesWritten].slice(0, 10).join(', ')}`);
    }
    if (filesRead.size > 0) {
      const readOnly = [...filesRead].filter(f => !filesWritten.has(f));
      if (readOnly.length > 0) summaryParts.push(`Files read: ${readOnly.slice(0, 8).join(', ')}`);
    }
    if (commandsRun.length > 0) {
      summaryParts.push(`Commands run (${commandsRun.length}): ${commandsRun.slice(-5).join(' ; ')}`);
    }
    const toolList = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}×${c}`).join(', ');
    if (toolList) summaryParts.push(`Tool usage: ${toolList}`);
    summaryParts.push('Use read_file to check the current state of any files if needed.');

    // ── Pass 3: keep early + recent turns with summary in the gap ──
    const KEEP_EARLY = 4;
    const KEEP_RECENT = 4;
    const early = realTurns.slice(0, KEEP_EARLY);
    const recent = realTurns.length > KEEP_EARLY + KEEP_RECENT
      ? realTurns.slice(-KEEP_RECENT)
      : realTurns.slice(KEEP_EARLY);

    const kept = [...early];
    // Insert the activity summary in the gap between early and recent
    const summary = summaryParts.join('\n');
    if (kept.length > 0 && kept[kept.length - 1].role === 'user') {
      kept.push({ role: 'assistant', content: summary });
    } else if (kept.length > 0) {
      kept.push({ role: 'user', content: summary });
    }
    if (recent.length > 0) kept.push(...recent);

    // Ensure starts with user and alternates
    while (kept.length > 0 && kept[0].role !== 'user') kept.shift();
    const cleaned = [];
    for (const msg of kept) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === msg.role) continue;
      cleaned.push(msg);
    }

    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === 'user') {
      cleaned.push({ role: 'assistant', content: 'OK.' });
    }

    // Cancellation note + ack
    cleaned.push({
      role: 'user',
      content: '[You were working on a task but the user STOPPED you. That task is CANCELLED. Await their next message — it is a completely new instruction. Follow ONLY the new instruction. You can reference the session summary above if context is needed, and use read_file to check file state.]',
    });
    cleaned.push({ role: 'assistant', content: 'Understood — previous task cancelled. I have the summary of what was done. What would you like me to do?' });

    // Mark as recently interrupted
    if (!this._recentAborts) this._recentAborts = new Set();
    this._recentAborts.add(sessionKey);
    setTimeout(() => this._recentAborts?.delete(sessionKey), 30_000);

    this.sessions.setMessages(sessionKey, cleaned);
    this.log.info(`[abort-clean] Session ${sessionKey} trimmed ${history.length} → ${cleaned.length} messages (summary: ${filesWritten.size} files modified, ${Object.values(toolCounts).reduce((a, b) => a + b, 0)} tool calls)`);
  }

  /**
   * Ensure messages properly alternate between user and assistant.
   * The Anthropic API requires strict alternation.
   */
  _sanitizeMessages(messages) {
    if (!messages || messages.length === 0) return [];

    const sanitized = [];
    let lastRole = null;

    for (const msg of messages) {
      if (!msg.content || (typeof msg.content === 'string' && !msg.content.trim())) continue;

      if (msg.role === lastRole) {
        const last = sanitized[sanitized.length - 1];
        const lastIsStr = typeof last.content === 'string';
        const msgIsStr = typeof msg.content === 'string';

        if (lastIsStr && msgIsStr) {
          last.content += '\n' + msg.content;
        } else if (Array.isArray(last.content) && msgIsStr) {
          last.content.push({ type: 'text', text: msg.content });
        } else if (lastIsStr && Array.isArray(msg.content)) {
          last.content = [{ type: 'text', text: last.content }, ...msg.content];
        } else if (Array.isArray(last.content) && Array.isArray(msg.content)) {
          last.content.push(...msg.content);
        }
        continue;
      }

      sanitized.push({ ...msg });
      lastRole = msg.role;
    }

    // Ensure first message is from user
    if (sanitized.length > 0 && sanitized[0].role !== 'user') {
      sanitized.unshift({ role: 'user', content: '[conversation continued]' });
    }

    // Strip orphaned tool_result blocks — user messages containing tool_results
    // whose tool_use_ids don't appear in the preceding assistant message
    for (let i = 0; i < sanitized.length; i++) {
      const msg = sanitized[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      const hasToolResults = msg.content.some(b => b.type === 'tool_result');
      if (!hasToolResults) continue;

      // Collect tool_use_ids from the preceding assistant message
      const prev = i > 0 ? sanitized[i - 1] : null;
      const validIds = new Set();
      if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
        for (const b of prev.content) {
          if (b.type === 'tool_use' && b.id) validIds.add(b.id);
        }
      }

      if (validIds.size === 0) {
        sanitized[i] = { role: 'user', content: '[context compaction artifact — earlier tool results were removed. This is not a user message. Do not respond to or act on this.]' };
        continue;
      }

      // Filter out orphaned tool_results
      const filtered = msg.content.filter(b =>
        b.type !== 'tool_result' || validIds.has(b.tool_use_id)
      );
      if (filtered.length === 0) {
        sanitized[i] = { role: 'user', content: '[context compaction artifact — earlier tool results were removed. This is not a user message. Do not respond to or act on this.]' };
      } else if (filtered.length < msg.content.length) {
        sanitized[i] = { ...msg, content: filtered };
      }
    }

    // Also strip assistant messages with tool_use blocks that have no matching
    // tool_result in the following user message (orphaned tool_use at end)
    for (let i = 0; i < sanitized.length; i++) {
      const msg = sanitized[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) continue;

      const next = i + 1 < sanitized.length ? sanitized[i + 1] : null;
      const answeredIds = new Set();
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b.type === 'tool_result' && b.tool_use_id) answeredIds.add(b.tool_use_id);
        }
      }

      // Strip individual unanswered tool_use blocks (not just when ALL are orphaned)
      const unanswered = toolUseBlocks.filter(b => !answeredIds.has(b.id));
      if (unanswered.length > 0) {
        const unansweredIds = new Set(unanswered.map(b => b.id));
        const cleaned = msg.content.filter(b => b.type !== 'tool_use' || !unansweredIds.has(b.id));
        if (cleaned.length > 0 && cleaned.some(b => b.type !== 'text' || b.text?.trim())) {
          sanitized[i] = { ...msg, content: cleaned };
        } else {
          const textOnly = cleaned.filter(b => b.type === 'text');
          sanitized[i] = textOnly.length > 0
            ? { ...msg, content: textOnly }
            : { role: 'assistant', content: '[tool calls trimmed from context]' };
        }
      }
    }

    // Remove compaction artifacts from the tail — if the last user message is
    // purely a compaction placeholder, the model will hallucinate a response.
    // Merge artifact into an adjacent user message or drop it entirely.
    const ARTIFACT_TAG = 'context compaction artifact';
    const isArtifact = (m) => typeof m.content === 'string' && m.content.includes(ARTIFACT_TAG);
    while (sanitized.length > 0 && isArtifact(sanitized[sanitized.length - 1])) {
      sanitized.pop();
    }
    // Also strip mid-conversation artifacts that ended up as standalone messages
    // by merging them into the preceding user message (preserves alternation)
    for (let i = sanitized.length - 1; i >= 1; i--) {
      if (isArtifact(sanitized[i]) && sanitized[i - 1]?.role === 'user') {
        sanitized.splice(i, 1);
      }
    }

    return sanitized;
  }

  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Smart compaction: summarize messages being dropped instead of just losing them.
   * 1. Pre-compaction flush: extract knowledge from messages about to be dropped
   * 2. Summarize the dropped messages using the cheap learner model
   * 3. Inject the summary as a compact context message
   * Falls back to plain trimming if summarization fails.
   */
  // Detect messages that contribute nothing to a session summary. Used
  // to filter the compaction drop-set so the summarizer doesn't burn
  // tokens narrating "the assistant said [Acknowledged.]" or "user
  // returned [Old tool output cleared to save context space]". The
  // fundamental check: would removing this message lose any meaningful
  // signal about what happened in the session? If no, drop it silently.
  //
  // What counts as useless:
  //   - empty content (string or array)
  //   - bland alternation acks ("[Acknowledged.]")
  //   - assistant text turns that are too short to carry intent (<5 chars)
  //   - user tool_result arrays where every block has been pre-pruned to
  //     "[Old tool output cleared ...]" — the actual content already
  //     vanished in Phase 1, only the placeholder remains
  //   - text-only messages whose payload is just a system-style stub
  //     ("[Old tool output cleared to save context space]" can also
  //     appear as a top-level string when serialized weirdly)
  //
  // What is NEVER useless:
  //   - any message with a tool_use block (the call itself is signal —
  //     "the agent called search_symbols for X" matters even if its
  //     result was later cleared)
  //   - any text containing a workflow marker (RESEARCH_DONE:, PLAN_READY,
  //     NO_INTERVIEW_NEEDED:, NO_FOLLOWUP_QUESTIONS:, QUESTIONS:) — those
  //     anchor the multi-turn flow
  _isMessageUseless(msg) {
    if (!msg) return true;
    const c = msg.content;
    if (c == null) return true;
    if (typeof c === 'string') {
      const t = c.trim();
      if (t === '') return true;
      // Workflow markers are never useless even when the message is short
      if (this._hasWorkflowMarker(t)) return false;
      if (t === '[Acknowledged.]') return true;
      if (t.length < 5) return true;
      if (t.startsWith('[Old tool output cleared')) return true;
      return false;
    }
    if (!Array.isArray(c) || c.length === 0) return true;
    // Tool_use blocks always carry signal — keep the message.
    if (c.some(b => b.type === 'tool_use')) return false;
    // All blocks must be useless for the message to be useless.
    return c.every(b => {
      if (b.type === 'tool_result') {
        const tc = typeof b.content === 'string' ? b.content : '';
        if (!tc || tc.startsWith('[Old tool output cleared') || tc.length < 5) return true;
        if (this._hasWorkflowMarker(tc)) return false;
        return false;
      }
      if (b.type === 'text') {
        const tx = (b.text || '').trim();
        if (!tx) return true;
        if (this._hasWorkflowMarker(tx)) return false;
        if (tx === '[Acknowledged.]') return true;
        if (tx.length < 5) return true;
        return false;
      }
      // Unknown block type — preserve to be safe.
      return false;
    });
  }

  _hasWorkflowMarker(text) {
    if (!text || typeof text !== 'string') return false;
    return /\b(RESEARCH_DONE:|PLAN_READY|NO_INTERVIEW_NEEDED:|NO_FOLLOWUP_QUESTIONS:|QUESTIONS:|\[BUILD_PLAN\]|\[REVIEW\]|\[RESEARCH\])/.test(text);
  }

  async _compactHistory(sessionKey, messages, targetTokens, onStatus) {
    if (messages.length <= 6) return this._trimMessagesToTokenBudget(messages, targetTokens);

    const _msgHasToolUse = (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use');
    const _msgHasToolResult = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result');
    const _tokOf = (m) => this._estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

    // ── Phase 1: Cheap tool output pruning (no LLM call) ──
    // Replace verbose tool results outside the protected tail with placeholders.
    // This saves tokens for both the summarizer AND the final context.
    const PRUNE_THRESHOLD = 200;
    const tailProtectCount = Math.max(4, Math.min(20, messages.length - 2));
    const pruneBeforeIdx = messages.length - tailProtectCount;
    let prunedTokens = 0;

    for (let i = 0; i < pruneBeforeIdx; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
        if (block.content.length <= PRUNE_THRESHOLD) continue;
        if (block.content.startsWith('[Old tool output cleared')) continue;
        const savedChars = block.content.length - 45;
        prunedTokens += Math.ceil(savedChars / 3.5);
        msg.content[j] = { ...block, content: '[Old tool output cleared to save context space]' };
      }
    }
    if (prunedTokens > 0) {
      this.log.info(`[compaction] Phase 1: pruned ~${prunedTokens} tokens of old tool output`);
    }

    // ── Phase 2: Determine boundaries ──
    let tailProtect = Math.min(PROTECT_TAIL_MAX, messages.length - 2);
    if (tailProtect < 1) tailProtect = 1;
    const tail = messages.slice(messages.length - tailProtect);
    const tailTokens = tail.reduce((s, m) => s + _tokOf(m), 0);

    let protect = PROTECT_HEAD_COUNT;
    let head = messages.slice(0, protect);
    let middle = messages.slice(protect, messages.length - tailProtect);

    let extended = 0;
    while (extended < HEAD_EXTEND_MAX && head.length > 0 && middle.length > 0 && _msgHasToolUse(head[head.length - 1]) && _msgHasToolResult(middle[0])) {
      head.push(middle.shift());
      extended++;
      if (middle.length > 0 && _msgHasToolUse(middle[0])) {
        head.push(middle.shift());
        extended++;
      }
    }

    let headTokens = head.reduce((s, m) => s + _tokOf(m), 0);
    if (headTokens > targetTokens * COMPACT_HEAD_GUARD_FRACTION) {
      head = messages.slice(0, 1);
      middle = messages.slice(1, messages.length - tailProtect);
      headTokens = head.reduce((s, m) => s + _tokOf(m), 0);
    }

    let total = headTokens + tailTokens;

    let keepFromIdx = middle.length;
    for (let i = middle.length - 1; i >= 0; i--) {
      const tok = _tokOf(middle[i]);
      if (total + tok > targetTokens - COMPACT_TAIL_HEADROOM_TOKENS) break;
      total += tok;
      keepFromIdx = i;
    }

    while (keepFromIdx > 0 && keepFromIdx < middle.length) {
      const msg = middle[keepFromIdx];
      if (_msgHasToolResult(msg)) {
        keepFromIdx--;
      } else {
        break;
      }
    }

    let toDrop = middle.slice(0, keepFromIdx);
    const toKeep = [...middle.slice(keepFromIdx), ...tail];

    // Filter out USELESS messages from the drop set. These contribute
    // nothing to a summary and would just waste summarizer tokens:
    //   - already-cleared tool result placeholders (Phase 1 above
    //     replaced their bodies with a stub)
    //   - bland alternation acks ("[Acknowledged.]")
    //   - empty / single-character content
    //   - assistant messages whose entire payload was a tool_use that's
    //     paired with an already-cleared result (no narrative left)
    // They're dropped silently — no summary line, no entry in the
    // pre-compaction knowledge flush. The result: a tighter summary
    // focused on actual content.
    const droppedUseless = [];
    toDrop = toDrop.filter(m => {
      if (this._isMessageUseless(m)) {
        droppedUseless.push(m);
        return false;
      }
      return true;
    });
    if (droppedUseless.length > 0) {
      this.log.info(`[compaction] Phase 2.5: skipped ${droppedUseless.length} useless messages from summarization (acks, cleared tool stubs, blanks)`);
    }

    if (toDrop.length === 0) {
      // All to-be-dropped messages were useless — nothing to summarize.
      // Still need to remove them from the messages array so context
      // shrinks. Splice them out, return without inserting a summary.
      if (droppedUseless.length > 0) {
        return [...head, ...toKeep];
      }
      return messages;
    }

    // Surface compaction in the CLI status bar so the user sees that
    // the visible "stuck for ~5s" is actual work, not a hang. The CLI
    // displays this on the input bar and in the transcript.
    if (typeof onStatus === 'function') {
      try {
        onStatus({
          type: 'compaction-start',
          count: toDrop.length,
          dropped_useless: droppedUseless.length,
        });
      } catch { /* silent: best-effort UI signal */ }
    }

    // Pre-compaction knowledge flush (fire-and-forget)
    const compactLearningMode = this.config.learningMode || 'always';
    if (this.learner && compactLearningMode !== 'disabled') {
      try {
        const flushTranscript = toDrop
          .filter(m => typeof m.content === 'string')
          .map(m => `${m.role}: ${m.content.substring(0, 300)}`)
          .join('\n');
        if (flushTranscript.length > 50) {
          this.learner.extractAndLearn(
            flushTranscript,
            '[pre-compaction flush — extracting from messages about to be compacted]',
            { channelName: 'compaction' }
          ).catch(() => { });
        }
      } catch (e) { this.log.warn('[loop] filter failed: ' + e.message); }
    }

    // ── Phase 3: Generate structured summary (iterative if previous exists) ──
    if (!this._compactionSummaries) this._compactionSummaries = new Map();
    const previousSummary = this._compactionSummaries.get(sessionKey) || null;

    let summary = null;
    if (this.learner && toDrop.length > 2) {
      try {
        summary = await this.learner.summarizeForCompaction(toDrop, previousSummary);
      } catch (e) {
        this.log.warn('[compaction] Summarization failed, falling back to trim:', e.message);
      }
    }

    // Store for iterative re-compression on subsequent compactions.
    // Capped at 200 sessions (insertion-order eviction).
    if (summary) {
      if (!this._compactionSummaries.has(sessionKey) && this._compactionSummaries.size >= 200) {
        this._compactionSummaries.delete(this._compactionSummaries.keys().next().value);
      }
      this._compactionSummaries.set(sessionKey, summary);
    }

    // ── Phase 4: Assemble compressed messages ──
    // Fallback summary when the LLM call failed: extract role+snippet
    // pairs from the dropped messages so the agent at least knows what
    // topics were touched. Better than a bare "N earlier messages were
    // compacted" line — that one made the agent treat the compaction
    // as a hard reset and "continue like it was the first message in
    // the chat" (real bug observed in long execute-mode sessions).
    let resolvedSummary = summary;
    if (!resolvedSummary && toDrop.length > 0) {
      const topics = new Set();
      for (const m of toDrop) {
        let c = '';
        if (typeof m.content === 'string') c = m.content;
        else if (Array.isArray(m.content)) {
          c = m.content.map(b => b.type === 'text' ? b.text : (b.type === 'tool_use' ? `[tool: ${b.name}]` : '')).filter(Boolean).join(' ');
        }
        const snip = c.trim().slice(0, 140);
        if (snip) topics.add(snip);
      }
      const lines = [...topics].slice(0, 12).map(t => `- ${t}`);
      resolvedSummary = `## Critical Context\nLLM summarizer unavailable — best-effort topic extraction:\n${lines.join('\n')}`;
    }

    // Wrap with framing that primes the agent to TREAT THE SUMMARY AS
    // WORKING MEMORY, not as background. The previous wording said
    // "historical context only; base responses on the LIVE messages
    // below" — Claude reads that as "deprioritize" and grounds in
    // whatever short tail follows. Long execute-mode sessions then
    // looked like fresh starts because the actual state lived in the
    // compacted summary that the agent was told to ignore.
    const summaryText = resolvedSummary
      ? `[ACTIVE SESSION STATE — ${toDrop.length} earlier turns compressed below. THIS IS YOUR WORKING MEMORY for the rest of this session: the user's goal, decisions already made, files touched, what's done, what's in progress, and what's next. The messages after this block are the most recent exchanges — combine them with the state here to know where you are. DO NOT restart the conversation or treat this as background; continue the work in progress.]\n${resolvedSummary}\n[END SESSION STATE]`
      : `[${toDrop.length} earlier turns dropped. No summary available — ask the user to clarify where you left off before continuing.]`;

    this.log.info(`[compaction] Compacted ${toDrop.length} messages → ${summaryText.length} char summary (${previousSummary ? 'iterative update' : 'fresh'}${summary ? '' : ', LLM-FAILED-fallback'}), keeping ${toKeep.length} recent`);

    if (typeof onStatus === 'function') {
      try {
        onStatus({
          type: 'compaction-done',
          count: toDrop.length,
          summary_chars: summaryText.length,
          fallback: summary ? false : true,
        });
      } catch { /* silent */ }
    }

    return [...head, { role: 'user', content: summaryText }, ...toKeep];
  }

  /**
   * Trim messages to fit within a token budget (fast, no LLM calls).
   * Used for mid-loop trimming where async summarization isn't viable.
   * Protects first 2 messages (identity context) and last N messages.
   * Keeps tool_use/tool_result pairs together to avoid API errors.
   */
  _trimMessagesToTokenBudget(messages, targetTokens) {
    if (messages.length <= 4) return messages;

    const protect = PROTECT_HEAD_COUNT;
    const head = messages.slice(0, protect);
    const tail = messages.slice(protect);

    // Group messages into atomic chunks that can't be split.
    // An assistant msg with tool_use + the following user msg with tool_result = one chunk.
    const chunks = [];
    let i = 0;
    while (i < tail.length) {
      const msg = tail[i];
      const hasToolUse = msg.role === 'assistant' && Array.isArray(msg.content)
        && msg.content.some(b => b.type === 'tool_use');

      if (hasToolUse && i + 1 < tail.length) {
        const next = tail[i + 1];
        const hasToolResult = next.role === 'user' && Array.isArray(next.content)
          && next.content.some(b => b.type === 'tool_result');
        if (hasToolResult) {
          chunks.push([msg, next]);
          i += 2;
          continue;
        }
      }
      chunks.push([msg]);
      i++;
    }

    let total = head.reduce((s, m) => s + this._estimateTokens(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ), 0);

    const keptChunks = [];
    for (let ci = chunks.length - 1; ci >= 0; ci--) {
      const chunkTokens = chunks[ci].reduce((s, m) => s + this._estimateTokens(
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      ), 0);
      if (total + chunkTokens > targetTokens) break;
      total += chunkTokens;
      keptChunks.unshift(chunks[ci]);
    }

    const kept = keptChunks.flat();
    const trimmedCount = tail.length - kept.length;

    if (trimmedCount > 0) {
      head.push({ role: 'user', content: `[${trimmedCount} earlier messages trimmed for context]` });
    }

    return [...head, ...kept];
  }

  /**
   * Compress tool results from earlier iterations to save tokens.
   * The model already saw the full results — subsequent iterations only
   * need a summary. Skips the most recent user message (current iteration).
   */
  _compressOldToolResults(messages, currentToolResults) {
    const currentIds = new Set(currentToolResults.map(tr => tr.tool_use_id));
    const COMPRESS_THRESHOLD = 800;
    const KEEP_CHARS = 600;

    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i];
        if (block.type !== 'tool_result') continue;
        if (currentIds.has(block.tool_use_id)) continue;
        if (typeof block.content !== 'string') continue;
        if (block.content.length <= COMPRESS_THRESHOLD) continue;
        if (block.content.includes('[COMPRESSED]')) continue;

        const original = block.content.length;
        msg.content[i] = {
          ...block,
          content: block.content.substring(0, KEEP_CHARS)
            + `\n\n[COMPRESSED: ${original} chars → ${KEEP_CHARS}. Full result was seen in a prior iteration.]`,
        };
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { AgentLoop };
