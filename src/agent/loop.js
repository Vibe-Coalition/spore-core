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
    if (backend === 'anthropic' && !this.config.anthropicApiKey) {
      this.log.warn('No Anthropic API key configured — agent AI is disabled. Set up a provider in the Manager and restart.');
      return false;
    }
    if (!this.client) this.client = new MultiProvider(this.config);
    this.log.info(`Agent loop initialized — tiers: casual=${this.config.casualModel} normal=${this.config.normalModel} planner=${this.config.plannerModel} (${backend})`);
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
        }
      }, 10_000);
    };
    ac.signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await this._runLoop(sessionKey, opts);
    } finally {
      if (forceReleaseTimer) clearTimeout(forceReleaseTimer);
      this.activeRuns.delete(sessionKey);
      this._activeAbortControllers.delete(sessionKey);
      this.tools._abortSignal = null;
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
   * The main agent loop — handles multi-turn tool use
   */
  async _runLoop(sessionKey, opts) {
    // Pass context to tool system so tools know the calling channel
    this.tools._currentTrigger = opts.trigger || null;
    this.tools._currentChannelId = opts.channelId || null;
    this.tools._currentPlatform = opts.platform || 'discord';
    this.tools._currentUserMessage = opts.content || null;
    this.tools._currentUserName = opts.userName || null;
    this.tools._currentUserId = opts.userId || null;
    this.tools._abortSignal = opts._abortSignal || null;

    const dynamicOpts = {
      channelId: opts.channelId,
      channelName: opts.channelName,
      userId: opts.userId,
      userName: opts.userName,
      guildName: opts.guildName,
      messageContent: opts.content || opts.messageContent,
      trigger: opts.trigger,
      platform: opts.platform,
      guildName: opts.guildName,
      isThread: opts.isThread,
      parentChannelName: opts.parentChannelName,
      messageId: opts.messageId,
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
    const isCasualChat = directTriggers.includes(opts.trigger) && msgText.length < 200
      && !hasTaskWords && !(hasStatusWords && hasActiveTasks);
    const promptMode = isCasualChat ? 'chat' : 'full';

    // Build system prompt using async path (hybrid search + Enhanced Recall)
    const llmClient = this.tools?.anthropicClient || null;
    const systemPrompt = await this.graph.buildSystemPromptAsync({
      ...dynamicOpts,
      promptMode,
      _llmClient: llmClient,
    });
    // Split for prompt caching: static part can be cached by the API between calls
    const staticPrompt = this.graph.buildStaticPrompt(promptMode);
    const dynamicContext = systemPrompt.length > staticPrompt.length ? systemPrompt.slice(staticPrompt.length) : null;

    // 2. Add the user message to session history (text only — images are ephemeral)
    // Task completion messages are internal system prompts — don't pollute chat history
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

    // 3.5. Attach images to the last user message if present (multimodal vision)
    //      Also persist images to disk so agent tools (exec, delegate_task) can access them.
    if (opts.images && opts.images.length > 0 && messages.length > 0) {
      const savedPaths = this._saveImagesToDisk(opts.images);
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
        const pathNote = savedPaths.length
          ? `\n[Attached files saved to disk: ${savedPaths.join(', ')}]`
          : '';
        lastMsg.content = [
          ...opts.images,
          { type: 'text', text: lastMsg.content + pathNote },
        ];
      }
    }

    // 4. Ensure messages alternate user/assistant properly
    messages = this._sanitizeMessages(messages);

    // 4.5. Token-aware compaction: summarize old messages instead of dropping them
    const contextWindow = this.config.contextWindow || 200000;
    const hardCeiling = Math.floor(contextWindow * 0.75);
    const systemTokens = this._estimateTokens(systemPrompt);
    let msgTokens = messages.reduce((sum, m) => sum + this._estimateTokens(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ), 0);

    // Complexity-aware message budget: casual chat gets a tight budget so
    // simple greetings don't drag 30K of history. Complex requests get more
    // room. The hard ceiling stays as a safety cap for multi-iteration loops.
    const casualBudget = this.config.casualMessageBudget || 8000;
    const complexBudget = this.config.complexMessageBudget || 16000;
    const softBudget = isCasualChat ? casualBudget : complexBudget;

    if (msgTokens > softBudget) {
      const targetMsgTokens = Math.min(softBudget, hardCeiling - systemTokens - 2000);
      messages = await this._compactHistory(sessionKey, messages, targetMsgTokens);
      messages = this._sanitizeMessages(messages);
      this.log.info(`[compaction] ${isCasualChat ? 'casual' : 'complex'} ${msgTokens} → ~${targetMsgTokens} msg tokens`);
    } else if (systemTokens + msgTokens > hardCeiling) {
      const targetMsgTokens = hardCeiling - systemTokens - 2000;
      messages = await this._compactHistory(sessionKey, messages, targetMsgTokens);
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
    const lullMaxIter = this.config.lullMaxIterations || 4;
    const safetyCeiling = this.config.loopDetection?.ceiling || 50;
    const budgetPressureAt = this.config.loopDetection?.budgetPressure || 6;
    // Tiered iteration caps: chat/DM gets a tighter leash than proactive/continuation
    const dmMaxIter = this.config.dmMaxIterations || 12;
    const chatMaxIter = isDirect ? dmMaxIter : safetyCeiling;
    let budgetHintSent = false;
    let tokenBudgetWarned = false;
    let contextPressureLevel = 0; // 0=ok, 1=caution(70%), 2=urgent(90%)

    // Loop detection state (local to this invocation)
    const loopTracker = { history: [], maxHistory: 20 };

    // 3-tier model escalation: casual → normal → planner
    // Full toolset is always provided (stripping tools causes denial of capabilities).
    // Escalation happens on tool_use: casual→normal on first tools, normal→planner on next.
    let chatTools = null;
    let activeModel = isCasualChat
      ? (this.config.casualModel || this.config.normalModel)
      : (this.config.normalModel || this.config.plannerModel);

    const abortSignal = opts._abortSignal;

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

      // Progressive context pressure warnings tied to compaction threshold
      const compactionThreshold = hardCeiling;
      const cautionAt = Math.floor(compactionThreshold * 0.70);
      const urgentAt = Math.floor(compactionThreshold * 0.90);
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
      this.log.debug(`Agent iteration ${iterations}, messages: ${messages.length}, sysPromptLen: ${systemPrompt.length}`);

      try {
        // Plugin middleware: beforeInference
        if (this._pluginManager) {
          for (const handler of this._pluginManager.getMiddleware('beforeInference')) {
            try { await handler({ systemPrompt, messages, iteration: iterations }); } catch { }
          }
        }

        const iterStart = Date.now();
        this.log.info(`[agent] Iter ${iterations} starting — model=${iterModel}, msgs=${messages.length}, tools=${chatTools ? 'chat' : 'full'}`);

        const response = await this._callClaude(systemPrompt, messages, { staticPrompt, dynamicContext, onTextDelta: opts.onTextDelta, onToolUse: opts.onToolUse, onStatus: opts.onStatus, tools: chatTools, model: activeModel, abortSignal });

        const iterMs = Date.now() - iterStart;

        // Plugin middleware: afterInference
        if (this._pluginManager) {
          for (const handler of this._pluginManager.getMiddleware('afterInference')) {
            try { await handler({ response, iteration: iterations }); } catch { }
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
          if (responseText) {
            finalText = responseText;
          }
          // Store in session regardless (for context continuity)
          if (finalText) {
            this.sessions.addMessage(sessionKey, 'assistant', finalText);
          }
          // If the final text was already sent as intermediate, don't re-send it
          if (finalText && finalText === lastSentIntermediate) {
            finalText = null;
          }
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
          this.log.warn(`[agent] Iter ${iterations}: hit max_tokens (${iterUsage.output_tokens || '?'} out) — tool call truncated`);
          if (opts.onStatus) { try { opts.onStatus({ type: 'truncated', iteration: iterations, outputTokens: iterUsage.output_tokens }); } catch { } }

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
          continue;
        }

        // 2-tier escalation: casual → normal on any tool use.
        // Planner (Opus) is reserved for explicit delegation only — triggered
        // when the agent calls delegate_task, not on routine tool use.
        if (toolBlocks.length > 0 && activeModel) {
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
        }
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

          const toolResults = [];
          let criticalBlock = false;

          // Safe-to-parallelize tools: read-only, no side effects on each other
          const PARALLEL_SAFE = new Set(['web_search', 'web_fetch', 'read_file', 'graph_query', 'message_read', 'task_status']);

          const executeOneTool = async (toolBlock) => {
            if (abortSignal?.aborted) {
              return {
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: JSON.stringify({ error: 'Aborted by user.' }),
              };
            }

            this.log.info(`Tool call: ${toolBlock.name}(${JSON.stringify(toolBlock.input).substring(0, 100)})`);

            if (toolBlock.input?._parse_error) {
              this.log.warn(`[agent] Tool ${toolBlock.name}: argument JSON was malformed`);
              return {
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: JSON.stringify({ error: toolBlock.input._parse_error }),
              };
            }

            const callHash = this._hashToolCall(toolBlock.name, toolBlock.input);
            const loopCheck = this._checkToolLoop(loopTracker, callHash, toolBlock.name);

            if (loopCheck.blocked) {
              this.log.warn(`[loop-detect] CRITICAL: ${loopCheck.message}`);
              criticalBlock = true;
              return {
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: JSON.stringify({ error: loopCheck.message }),
              };
            }

            if (toolBlock.name === 'delegate_task') delegatedThisTurn = true;

            const toolDetail = this._toolInputSummary(toolBlock.name, toolBlock.input);
            graphEvents.emit('change', { op: 'tool:call', tool: toolBlock.name, input: JSON.stringify(toolBlock.input).substring(0, 200), source: 'agent' });
            if (opts.onStatus) { try { opts.onStatus({ type: 'tool_exec_start', tool: toolBlock.name, detail: toolDetail }); } catch { } }
            const toolExecStart = Date.now();
            let result;
            if (opts.onToolExecute) {
              result = await opts.onToolExecute(toolBlock.name, toolBlock.input, toolBlock.id);
              if (result === null || result === undefined) {
                result = await this.tools.executeTool(toolBlock.name, toolBlock.input);
              }
            } else {
              result = await this.tools.executeTool(toolBlock.name, toolBlock.input);
            }
            let resultContent = JSON.stringify(result);

            const toolExecMs = Date.now() - toolExecStart;
            this.log.info(`[agent] Tool ${toolBlock.name} done — ${toolExecMs}ms, ${resultContent.length} chars`);
            if (opts.onStatus) { try { opts.onStatus({ type: 'tool_exec_done', tool: toolBlock.name, detail: toolDetail, durationMs: toolExecMs, resultChars: resultContent.length }); } catch { } }

            if (opts.onStatus && !result.error) {
              try { this._emitCodeEvent(toolBlock.name, toolBlock.input, result, opts.onStatus); } catch { }
            }

            toolLog.push({
              tool: toolBlock.name,
              input: JSON.stringify(toolBlock.input).substring(0, 300),
              resultPreview: resultContent.substring(0, 300),
              succeeded: !result.error,
            });

            const defaultCap = this.config.maxToolResultChars || 15000;
            const toolCaps = { read_file: 80000, web_fetch: 15000, exec: 8000, message_read: 10000, graph_query: 10000 };
            const maxResultChars = toolCaps[toolBlock.name] ?? defaultCap;
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
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: resultContent,
            };
          };

          // Partition tools into parallel-safe batches and sequential ones.
          // A contiguous run of parallel-safe tools executes concurrently;
          // anything else runs sequentially between batches.
          const allParallel = toolBlocks.length > 1 && toolBlocks.every(t => PARALLEL_SAFE.has(t.name));
          if (allParallel) {
            this.log.info(`[agent] Executing ${toolBlocks.length} tools in parallel: ${toolBlocks.map(t => t.name).join(', ')}`);
            if (opts.onStatus) { try { opts.onStatus({ type: 'parallel_exec', count: toolBlocks.length, tools: toolBlocks.map(t => t.name) }); } catch { } }
            const results = await Promise.all(toolBlocks.map(tb => executeOneTool(tb)));
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
                if (opts.onStatus) { try { opts.onStatus({ type: 'parallel_exec', count: batch.length, tools: batch.map(t => t.name) }); } catch { } }
                const results = await Promise.all(batch.map(tb => executeOneTool(tb)));
                toolResults.push(...results);
              } else if (batch.length === 1) {
                toolResults.push(await executeOneTool(batch[0]));
              }
              if (abortSignal?.aborted) break;
              // Execute next sequential tool
              if (i < toolBlocks.length) {
                toolResults.push(await executeOneTool(toolBlocks[i]));
                i++;
              }
            }
          }

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
          }

          // Truncate consumed tool results in the DB so future getHistory calls are lighter
          if (iterations > 1) {
            this.sessions.truncateConsumedToolResults(sessionKey);
          }

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
            const target = hardCeiling - systemTokens - 2000;
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
        if (abortSignal?.aborted || e.name === 'AbortError' || e.message?.includes('aborted')) {
          this.log.info(`[abort] Session ${sessionKey} aborted mid-call`);
          loopBroken = true;
          break;
        }
        this.log.error(`Agent loop error (iteration ${iterations}):`, e.message);
        if (e.error) this.log.error('API error detail:', JSON.stringify(e.error));
        if (e.status === 400 && e.message?.includes('tool_use') && e.message?.includes('tool_result') && !sessionRecoveredThisCall) {
          sessionRecoveredThisCall = true;
          // First attempt: re-sanitize messages to strip orphaned tool pairs
          this.log.warn(`Corrupted session in ${sessionKey} — attempting re-sanitization`);
          messages = this._sanitizeMessages(messages);
          if (messages.length > 1) {
            this.log.info(`Re-sanitized to ${messages.length} messages — retrying`);
            continue;
          }
          // Fallback: nuke session and retry with bare message
          this.log.warn(`Re-sanitization insufficient for ${sessionKey} — clearing session`);
          this.sessions.clearSession(sessionKey);
          messages = [{ role: 'user', content: opts.content }];
          continue;
        }

        if (e.status === 400) {
          this.log.error('Request params — model:', this.config.model, 'msgs:', messages.length, 'tools:', this.tools.getToolDefinitions().length);
        }

        if (e.status === 429) {
          this.log.warn('Rate limited, waiting 5s...');
          await this._sleep(5000);
          continue;
        }

        if (e.status === 529) {
          this.log.warn('API overloaded, waiting 10s...');
          await this._sleep(10000);
          continue;
        }

        if (e.status === 500 || e.status === 502 || e.status === 503) {
          if (!apiRetries) apiRetries = 0;
          apiRetries++;
          if (apiRetries <= 5) {
            const delay = apiRetries * 5000;
            this.log.warn(`API server error (${e.status}), retry ${apiRetries}/5 in ${delay / 1000}s...`);
            if (opts.onStatus) { try { opts.onStatus({ type: 'api_retry', status: e.status, attempt: apiRetries, maxAttempts: 5, delaySec: delay / 1000 }); } catch { } }
            await this._sleep(delay);
            continue;
          }
          this.log.error(`API server error (${e.status}) — all 5 retries exhausted for session ${sessionKey}`);
        }

        if (opts.onError) opts.onError(e);
        throw e;
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
        const finalResponse = await this._callClaude(systemPrompt, messages, { staticPrompt, dynamicContext, onTextDelta: opts.onTextDelta });
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

    // Async learning — fire and forget, never delays response
    const learningMode = this.config.learningMode || 'always';
    if (finalText && this.learner && learningMode === 'always') {
      this.learner.extractAndLearn(opts.content, finalText, {
        userName: opts.userName,
        channelName: opts.channelName,
        toolCalls: toolLog.length > 0 ? toolLog : undefined,
      }).catch(e => this.log.error('[learner] Background extraction error:', e.message));
    }

    // Plugin context engines: afterTurn
    if (this._pluginManager) {
      const turnData = { userMessage: opts.content, assistantResponse: finalText, toolCalls: toolLog };
      for (const engine of this._pluginManager.getContextEngines()) {
        if (engine.engine?.afterTurn) {
          engine.engine.afterTurn(turnData).catch(() => { });
        } else if (engine.afterTurn) {
          engine.afterTurn(turnData).catch(() => { });
        }
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

  // ── Image persistence ───────────────────────────────────────────────

  _saveImagesToDisk(images) {
    const fs = require('fs');
    const path = require('path');
    const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
    const saved = [];
    for (const img of images) {
      try {
        if (img.type !== 'image' || img.source?.type !== 'base64') continue;
        const ext = (img.source.media_type || 'image/png').split('/')[1] || 'png';
        const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const filePath = path.join(uploadDir, name);
        fs.writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
        saved.push(filePath);
        this.log.info(`[upload] Saved image to ${filePath} (${img.source.media_type})`);
      } catch (e) {
        this.log.warn(`[upload] Failed to save image: ${e.message}`);
      }
    }
    return saved;
  }

  // ── Model-aware output token limits ─────────────────────────────────

  _modelMaxOutputTokens(model) {
    if (!model) return 8192;
    const m = model.toLowerCase();
    if (m.includes('opus')) return 64000;
    if (m.includes('sonnet')) return 32000;
    if (m.includes('haiku')) return 16000;
    return 8192;
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
   * Call the Claude API
   */
  async _callClaude(systemPrompt, messages, opts = {}) {
    const staticPart = opts.staticPrompt || null;
    const dynamicPart = opts.dynamicContext || null;
    const claudeCodeId = "You are Claude Code, Anthropic's official CLI for Claude.";

    let system;
    if (this.config._isOAuth) {
      if (staticPart && dynamicPart) {
        system = [
          { type: 'text', text: claudeCodeId },
          { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicPart },
        ];
      } else {
        system = [
          { type: 'text', text: claudeCodeId },
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ];
      }
    } else if (staticPart && dynamicPart) {
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

    // Tag last tool with cache_control so the full tool array is cached on repeat calls
    const tools = opts.tools || this.tools.getToolDefinitions();
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

    const model = opts.model || this.config.model;
    const maxTokens = this.config.maxTokens !== 8192
      ? this.config.maxTokens
      : this._modelMaxOutputTokens(model);
    const supportsThinking = /sonnet|opus/i.test(model) && !/3-5|3\.5/i.test(model);
    const thinkingBudget = supportsThinking ? (this.config.thinkingBudget || 10000) : 0;
    const requestOpts = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
      ...(thinkingBudget > 0 ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
    };

    const signal = opts.abortSignal;

    // Always stream — Anthropic API requires it for long-running requests.
    // Callbacks are optional; when absent we still stream but discard events.
    const stream = this.client.messages.stream(requestOpts);
    if (signal) {
      const onAbort = () => { try { stream.abort(); } catch { } };
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('end', () => signal.removeEventListener('abort', onAbort));
    }

    let _streamChars = 0;
    let _streamToolCount = 0;
    let _thinkingTokens = 0;
    let _thinkingText = '';
    let _phase = 'thinking';
    let _currentToolName = '';
    const _streamStart = Date.now();
    const heartbeatMs = 15000;
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - _streamStart) / 1000);
      this.log.info(`[stream] ${model} — ${elapsed}s, phase=${_phase}, ${_streamChars} chars, ${_streamToolCount} tool(s), ${_thinkingTokens} thinking`);
      if (opts.onStatus) {
        try { opts.onStatus({ type: 'heartbeat', elapsed, phase: _phase, chars: _streamChars, tools: _streamToolCount, thinkingTokens: _thinkingTokens, toolName: _currentToolName }); } catch { }
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
          _thinkingText += event.delta.thinking || '';
          if (_thinkingTokens % 20 === 0 && opts.onStatus) {
            const snippet = _thinkingText.length > 120
              ? _thinkingText.slice(-120).replace(/^\S*\s/, '')
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
          if (opts.onToolUse) opts.onToolUse(event.content_block.name);
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
          _phase = 'generating';
        }
      } catch { }
    });

    if (opts.onTextDelta) {
      stream.on('text', (text) => {
        _streamChars += text.length;
        try { opts.onTextDelta(text); } catch { }
      });
    }

    try {
      return await stream.finalMessage();
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * After a user-initiated abort, trim the session so the next message
   * doesn't carry stale partial tool results from the interrupted run.
   * Strategy: keep everything up to the last complete assistant text reply,
   * then append a short system note so the model knows the previous task
   * was cancelled.
   */
  _cleanSessionAfterAbort(sessionKey) {
    const history = this.sessions.getHistory(sessionKey, 200);
    if (!history || history.length === 0) return;

    // Walk backwards to find the last "clean" boundary — either a real user
    // message or an assistant message that contains actual text (not just
    // tool_use blocks from the interrupted run).
    let lastCleanIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === 'assistant') {
        const hasText = typeof msg.content === 'string'
          ? msg.content.trim().length > 0
          : (Array.isArray(msg.content) && msg.content.some(b => b.type === 'text' && b.text?.trim()));
        const hasToolUse = Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_use');
        // Accept as clean boundary only if it has real text AND no dangling tool_use
        if (hasText && !hasToolUse) { lastCleanIdx = i; break; }
        continue;
      }
      if (msg.role === 'user') {
        const isToolResult = Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result');
        if (!isToolResult) { lastCleanIdx = i; break; }
      }
    }

    if (lastCleanIdx < 0) {
      this.sessions.clearSession(sessionKey);
      this.log.info(`[abort-clean] Session ${sessionKey} cleared entirely (no clean boundary found)`);
      return;
    }

    const trimmed = history.slice(0, lastCleanIdx + 1);
    // If last message is assistant text, append a note so the model knows
    // the previous task was cancelled.
    if (trimmed.length > 0 && trimmed[trimmed.length - 1].role === 'assistant') {
      trimmed.push({
        role: 'user',
        content: '[The user stopped the previous task. Disregard it and await their next instruction.]',
      });
    }

    this.sessions.setMessages(sessionKey, trimmed);
    this.log.info(`[abort-clean] Session ${sessionKey} trimmed from ${history.length} to ${trimmed.length} messages`);
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
  async _compactHistory(sessionKey, messages, targetTokens) {
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
    let tailProtect = Math.min(4, messages.length - 2);
    if (tailProtect < 1) tailProtect = 1;
    const tail = messages.slice(messages.length - tailProtect);
    const tailTokens = tail.reduce((s, m) => s + _tokOf(m), 0);

    let protect = 2;
    let head = messages.slice(0, protect);
    let middle = messages.slice(protect, messages.length - tailProtect);

    const maxHeadExtend = 6;
    let extended = 0;
    while (extended < maxHeadExtend && head.length > 0 && middle.length > 0 && _msgHasToolUse(head[head.length - 1]) && _msgHasToolResult(middle[0])) {
      head.push(middle.shift());
      extended++;
      if (middle.length > 0 && _msgHasToolUse(middle[0])) {
        head.push(middle.shift());
        extended++;
      }
    }

    let headTokens = head.reduce((s, m) => s + _tokOf(m), 0);
    if (headTokens > targetTokens * 0.5) {
      head = messages.slice(0, 1);
      middle = messages.slice(1, messages.length - tailProtect);
      headTokens = head.reduce((s, m) => s + _tokOf(m), 0);
    }

    let total = headTokens + tailTokens;

    let keepFromIdx = middle.length;
    for (let i = middle.length - 1; i >= 0; i--) {
      const tok = _tokOf(middle[i]);
      if (total + tok > targetTokens - 500) break;
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

    const toDrop = middle.slice(0, keepFromIdx);
    const toKeep = [...middle.slice(keepFromIdx), ...tail];

    if (toDrop.length === 0) return messages;

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
      } catch { }
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

    // Store for iterative re-compression on subsequent compactions
    if (summary) {
      this._compactionSummaries.set(sessionKey, summary);
    }

    // ── Phase 4: Assemble compressed messages ──
    const summaryText = summary
      ? `[CONTEXT COMPACTION — ${toDrop.length} earlier turns compacted. This is historical context only; base responses on the LIVE messages below.]\n${summary}\n[END CONTEXT COMPACTION]`
      : `[${toDrop.length} earlier messages were compacted. The conversation continues below with the live messages.]`;

    this.log.info(`[compaction] Compacted ${toDrop.length} messages → ${summaryText.length} char summary (${previousSummary ? 'iterative update' : 'fresh'}), keeping ${toKeep.length} recent`);

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

    const protect = 2;
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
