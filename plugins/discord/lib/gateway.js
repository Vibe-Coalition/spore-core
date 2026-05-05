/**
 * discord.js — Discord Client Wrapper
 * 
 * Connects to Discord, listens for messages, routes them to the agent loop,
 * and sends responses back. Handles rate limiting, reconnection, and chunking.
 */

const path = require('path');
function requireHostPackage(name) {
  try { return require(name); } catch (e) {
    if (e?.code !== 'MODULE_NOT_FOUND') throw e;
    return require(path.join(__dirname, '../../../src/node_modules', name));
  }
}

let DiscordJs = null;
function loadDiscordJs() {
  if (!DiscordJs) DiscordJs = requireHostPackage('discord.js');
  return DiscordJs;
}
const { coreRequire } = require('../../core-require');
const { feed } = coreRequire('graph');
const { resolveSourcePolicy } = coreRequire('gateways/privacy');
const { MessageQueue } = coreRequire('gateways/message-queue');

const { DiscordVoice } = require('./voice');

class DiscordGateway {
  constructor(config, logger, agentLoop) {
    this.config = config;
    this.log = logger;
    this.agent = agentLoop;
    this.client = null;
    this._activityType = null;
    
    this._queue = new MessageQueue({
      config,
      log: logger,
      processOnce: (channelId, ch) => this._processQueueOnce(channelId, ch),
    });

    this._seenMessages = new Set();
    this._seenMessagesMax = 200;
    
    this.lastMessageTime = new Map();
    this.minMessageInterval = 1000;

    this._voice = new DiscordVoice(this);

    // Watch spore.json for channel gating changes — reload on file change, not per-message
    this._gateConfig = null;
    this._loadGateConfig();
    try {
      const configPath = require('path').join(this.config.dataDir || process.cwd(), 'spore.json');
      require('fs').watch(configPath, () => {
        this._loadGateConfig();
        this.log.info('[gate] spore.json changed — reloaded listenChannels');
      });
    } catch (e) {
      this.log.warn('[gate] Could not watch spore.json:', e.message);
    }
  }

  _loadGateConfig() {
    try {
      const raw = require('fs').readFileSync(require('path').join(this.config.dataDir || process.cwd(), 'spore.json'), 'utf8');
      const parsed = JSON.parse(raw);
      this._gateConfig = parsed.listenChannels || null;
      this._guildGateConfig = parsed.guilds || null;
    } catch {
      this._gateConfig = null;
      this._guildGateConfig = null;
    }
  }

  _getChannel(channelId) {
    return this._queue.getChannel(channelId);
  }

  _sessionKey(channelId, isDm, userId, policy = null) {
    const mode = this.config.channels?.discord?.sessionMode || 'channel';
    const scopedChannelId = (!isDm && mode === 'user' && userId)
      ? `${channelId}:user:${userId}`
      : channelId;
    return this.agent.sessions.constructor.buildKey({
      platform: 'discord',
      channelId: scopedChannelId,
      isDm,
      userId,
      private: !!policy?.private,
    });
  }
  
  /**
   * Initialize and connect the Discord client
   */
  async connect() {
    const channelCfg = this.config.channels?.discord || {};
    const token = channelCfg.token || this.config.discordToken;
    if (!channelCfg.enabled || !token) {
      this.log.info('[discord] Gateway disabled — no token configured');
      return null;
    }

    const { Client, GatewayIntentBits, Partials, Events, ActivityType } = loadDiscordJs();
    this._activityType = ActivityType;
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [
        Partials.Channel,  // Required for DM support
        Partials.Message,
      ],
    });
    
    // Event handlers
    this.client.once(Events.ClientReady, () => this._onReady());
    this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg));
    this.client.on(Events.Error, (err) => this._onError(err));
    this.client.on(Events.Warn, (warn) => this.log.warn('Discord warning:', warn));
    
    // Login
    this.log.info('Connecting to Discord...');
    await this.client.login(token);
    
    return this.client;
  }
  
  /**
   * Handle client ready event
   */
  _onReady() {
    const { user } = this.client;
    this.log.info(`Discord connected as ${user.tag} (${user.id})`);
    
    // Set presence — quiet, no announcement
    this.client.user.setPresence({
      activities: [{ name: 'the graph', type: this._activityType.Watching }],
      status: 'online',
    });
  }

  getStatus() {
    const channelCfg = this.config.channels?.discord || {};
    const token = channelCfg.token || this.config.discordToken;
    if (!channelCfg.enabled || !token) return 'disabled';
    return this.client ? 'connected' : 'disconnected';
  }
  
  /**
   * Handle incoming messages.
   *
   * Multi-turn strategy:
   *   - ALL messages are logged to session history so the agent sees the full conversation.
   *   - The agent is only INVOKED (costs tokens) when a trigger fires:
   *       1. Bot is @mentioned
   *       2. Message is a DM
   *       3. Message replies to one of the bot's messages
   *       4. Bot's name appears in the message text
   *   - Non-trigger messages are observed silently (added to history as "[user] said: ...")
   *   - When invoked, the agent sees the full multi-participant history and can decide
   *     to respond with content or with NO_REPLY to stay silent.
   */
  async _onMessage(message) {
    if (message.author.id === this.client.user.id) return;
    // Allow bot messages if configured
    if (message.author.bot && !this.config.allowBots) return;
    if (!message.content && message.attachments.size === 0) return;

    // Dedup: Discord gateway reconnects can replay MessageCreate events
    if (this._seenMessages.has(message.id)) {
      this.log.debug(`Duplicate message ${message.id} — skipping`);
      return;
    }
    this._seenMessages.add(message.id);
    if (this._seenMessages.size > this._seenMessagesMax) {
      const iter = this._seenMessages.values();
      for (let i = 0; i < 50; i++) this._seenMessages.delete(iter.next().value);
    }

    let content = await this._resolveContent(message);
    if (!content.trim()) return;

    const channelId = message.channelId;
    const isDm = !message.guild;
    const isThread = message.channel.isThread?.() || false;
    const parentChannelName = isThread ? message.channel.parent?.name : null;
    const channelName = message.channel.name || 'dm';
    const userId = message.author.id;
    const userName = message.member?.displayName || message.author.displayName || message.author.username;
    const guildName = message.guild?.name || null;

    this.log.info(`Message from ${userName} in #${channelName}: ${content.substring(0, 80)}...`);

    // Slash commands always processed
    const cmd = content.trim().toLowerCase();
    if (cmd === '/new' || cmd === '/reset') {
      await this._handleNewSession(message, channelId, channelName, isDm, userId);
      return;
    }
    if (cmd === '/rebirth') {
      if (!this._isAdmin(message)) { await message.reply('⛔ Only admins can use /rebirth.'); return; }
      await this._handleRebirth(message, channelName); return;
    }
    if (cmd === '/status') { await this._handleStatus(message); return; }
    if (cmd === '/reload') {
      if (!this._isAdmin(message)) { await message.reply('⛔ Only admins can use /reload.'); return; }
      await this._handleReload(message); return;
    }
    if (cmd === '/join') { await this._voice.handleJoin(message); return; }
    if (cmd === '/leave') { await this._voice.handleLeave(message); return; }
    if (cmd === '/model') { await message.reply('Current model: ' + this.config.model); return; }
    if (cmd.startsWith('/model ')) {
      if (!this._isAdmin(message)) { await message.reply('⛔ Only admins can change the model.'); return; }
      this.config.model = content.trim().slice(7).trim();
      await message.reply('Model switched to ' + this.config.model);
      return;
    }

    // Channel gating — drop messages from non-listened channels at gateway level
    const guildId = message.guild?.id || null;
    if (this._isChannelGated(channelId, channelName, isDm, guildId)) {
      this.log.debug(`Gated message from #${channelName} (${channelId}) — not in listen list`);
      return;
    }

    // Media-only channel guard
    if (this._isMediaOnly(channelName) && !message.mentions?.has(this.client.user)) {
      return;
    }

    // Determine if this message should trigger the agent or just be observed
    const trigger = this._getTriggerType(message, content, isDm);
    const policy = resolveSourcePolicy(this.config, 'discord', channelId);

    // Log every message to session history so the agent sees the full conversation
    const sessionKey = this._sessionKey(channelId, isDm, userId, policy);
    const labeledContent = isDm ? content : `[${userName}]: ${content}`;

    if (trigger && policy.respond) {
      // Triggered — queue for agent processing
      this._getChannel(channelId).name = channelName;
      this._queue.enqueueTriggered(channelId, {
        content: labeledContent,
        sessionKey,
        channelId, channelName, userId, userName, guildName, isDm, isThread, parentChannelName,
        message, trigger,
      }, { channelLabel: `#${channelName}` });
    } else {
      // Observe only — add to session history without invoking the agent
      this.agent.sessions.addMessage(sessionKey, 'user', labeledContent);
      this.log.debug(`Observed message from ${userName} in #${channelName} (no trigger)`);

      // If nobody triggers the bot for a while after activity, give the
      // agent a chance to chime in if it has something relevant to say.
      this._getChannel(channelId).name = channelName;
      this._queue.scheduleLull(channelId, () => {
        this._maybeLullResponse(channelId, channelName, isDm, userId, userName, guildName, message, isThread, parentChannelName, sessionKey);
      });
    }
  }

  /**
   * Determine what triggered the bot, if anything.
   * Returns a string trigger type or null if the message is observe-only.
   */
  _getTriggerType(message, content, isDm) {
    if (isDm) return 'dm';

    if (message.mentions?.has(this.client.user)) return 'mention';

    const repliedTo = message.reference?.messageId;
    if (repliedTo) {
      try {
        const ch = this._getChannel(message.channelId);
        if (ch.lastBotMessageId === repliedTo) return 'reply';
      } catch (e) { this.log.warn('[discord] this._getChannel failed: ' + e.message); }
    }

    const botName = this.client.user?.username?.toLowerCase() || '';
    const botDisplayName = message.guild?.members?.me?.displayName?.toLowerCase() || botName;
    const lower = content.toLowerCase();
    if (botName && lower.includes(botName)) return 'name';
    if (botDisplayName && botDisplayName !== botName && lower.includes(botDisplayName)) return 'name';

    // Conversation continuation: if the bot responded recently in this channel,
    // treat follow-up messages from humans as part of the ongoing conversation.
    const ch = this._getChannel(message.channelId);
    if (ch.lastBotResponseTime && !message.author.bot) {
      const continuationWindowMs = (this.config.continuationWindowMinutes || 5) * 60 * 1000;
      if (Date.now() - ch.lastBotResponseTime < continuationWindowMs) {
        return 'continuation';
      }
    }

    return null;
  }

  /**
   * After a lull in non-triggered conversation, give the agent one chance to chime in.
   * The agent receives the accumulated context and can respond or NO_REPLY.
   * Lull prompt is read from the agent's graph (lull_behavior aspect) if available.
   */
  async _maybeLullResponse(channelId, channelName, isDm, userId, userName, guildName, lastMessage, isThread, parentChannelName, sessionKey = null) {
    this._queue.enqueueLull(channelId, {
      sessionKey,
      channelId, channelName, userId, userName, guildName, isDm, isThread, parentChannelName,
      message: lastMessage,
    });
  }

  async _processQueue(channelId) {
    return this._queue.processQueue(channelId);
  }

  async _processQueueOnce(channelId, ch) {
    const { items, merged, last, trigger, isPassive } = this._queue.drain(ch);

    // Typing indicator for direct triggers
    let typingInterval = null;
    if (!isPassive) {
      await last.message.channel.sendTyping().catch(() => {});
      typingInterval = setInterval(() => {
        last.message.channel.sendTyping().catch(() => {});
      }, this.config.typingInterval);
    }

    // Stall detection: visual emoji feedback (skip for passive/synthetic triggers)
    let stallSoftTimer = null;
    let stallHardTimer = null;
    const stallEmojis = [];
    const messageForReaction = last.message;

    if (!isPassive && messageForReaction?.react) {
      stallSoftTimer = setTimeout(() => {
        messageForReaction.react('⏳').then(() => stallEmojis.push('⏳')).catch(() => {});
      }, this.config.stallSoftMs || 10000);
      stallHardTimer = setTimeout(() => {
        messageForReaction.react('🐢').then(() => stallEmojis.push('🐢')).catch(() => {});
      }, this.config.stallHardMs || 30000);
    }

    const cleanupStall = () => {
      if (stallSoftTimer) clearTimeout(stallSoftTimer);
      if (stallHardTimer) clearTimeout(stallHardTimer);
      // Remove stall reactions once we have a response
      for (const emoji of stallEmojis) {
        messageForReaction?.reactions?.cache.get(emoji)
          ?.users.remove(this.client.user.id).catch(() => {});
      }
    };

    const imageAttachments = await this._collectImageAttachments(items);

    try {
      const policy = resolveSourcePolicy(this.config, 'discord', last.channelId);
      const agentOpts = {
        content: merged,
        messageContent: merged,
        channelId: last.channelId,
        channelName: last.channelName,
        sessionKey: last.sessionKey || null,
        userId: last.userId,
        userName: last.userName,
        guildName: last.guildName,
        isDm: last.isDm,
        isThread: last.isThread || false,
        parentChannelName: last.parentChannelName || null,
        trigger,
        messageId: last.message?.id || null,
        images: imageAttachments,
        platform: 'discord',
        suppressLearning: !policy.learn || trigger === 'task_complete' || trigger === 'proactive',
        onText: null,
        onIntermediateText: async (text) => {
          if (!text || !text.trim() || text.trim() === 'NO_REPLY') return;

          const now = Date.now();
          const throttleMs = (this.config.intermediateTextThrottleSeconds || 30) * 1000;
          if (!ch._lastIntermediateAt) ch._lastIntermediateAt = 0;

          if (now - ch._lastIntermediateAt < throttleMs) {
            ch._pendingIntermediateText = text;
            return;
          }

          ch._lastIntermediateAt = now;
          ch._pendingIntermediateText = null;
          const sentMsg = await this._sendReply(last.message, text).catch(() => null);
          if (sentMsg) {
            ch.lastBotMessageId = sentMsg.id;
            ch.lastBotResponseTime = Date.now();
          }
        },
        onError: (err) => {
          this.log.error(`Agent error in #${last.channelName}:`, err.message);
        },
      };
      const result = this.agent._jobQueue?.submitAgentTurn
        ? await this.agent._jobQueue.submitAgentTurn(agentOpts, {
            lane: 'channel',
            priority: 85,
            route: 'discord.message',
            allowInterjection: true,
          })
        : await this.agent.processMessage(agentOpts);

      cleanupStall();
      if (typingInterval) clearInterval(typingInterval);
      // Flush any throttled intermediate text before the final reply
      if (ch._pendingIntermediateText) {
        await this._sendReply(last.message, ch._pendingIntermediateText).catch(() => null);
      }
      ch._lastIntermediateAt = 0;
      ch._pendingIntermediateText = null;

      if (result.skipped) {
        this.log.debug('Agent run was skipped (concurrent)');
        return;
      }

      if (result.text) {
        const sentMsg = await this._sendReply(last.message, result.text);
        if (sentMsg) {
          ch.lastBotMessageId = sentMsg.id;
          ch.lastBotResponseTime = Date.now();
        }
        const toolSummary = result.toolUsage
          ? ' tools=[' + Object.entries(result.toolUsage).map(([t, n]) => n > 1 ? `${t}x${n}` : t).join(', ') + ']'
          : '';
        this.log.info(`Response in #${last.channelName} [${trigger}] (${result.usage?.input_tokens}/${result.usage?.output_tokens} tokens, ${result.iterations} iters${toolSummary})`);
        // Cross-session feed: log what happened so other channel sessions know
        if (policy.shareToFeed) {
          try {
            feed.log({
              guildId: last.guildName ? (last.message?.guild?.id || null) : null,
              guildName: last.guildName,
              channelId: last.channelId,
              channelName: `discord:${last.channelName}`,
              userId: last.userId,
              userName: last.userName,
              userMessage: merged,
              myResponse: result.text,
              trigger,
              usage: result.usage,
              iterations: result.iterations,
            });
          } catch (e) { this.log.warn('[discord] feed.log failed: ' + e.message); }
        }
      } else if (trigger === 'lull' || trigger === 'task_complete' || trigger === 'proactive') {
        this.log.debug(`${trigger} in #${last.channelName}: no visible response`);
      }
    } catch (e) {
      cleanupStall();
      if (typingInterval) clearInterval(typingInterval);
      throw e;
    }
  }

  async _handleReload(message) {
    await message.reply('Channel plugins are hot-reloaded from Settings -> Plugins. Restart this channel plugin from there or restart the instance.');
  }

  async triggerReload(channelId) {
    const fakeMessage = {
      reply: (text) => this.client.channels.fetch(channelId).then(ch => ch.send(text)).catch(() => {}),
    };
    return this._handleReload(fakeMessage);
  }

  /**
   * Inject a completed task result back into the channel queue so the agent
   * processes it on its next turn and can respond naturally.
   */
  injectTaskComplete(channelId, taskId, taskEntry) {
    const elapsed = Math.round((taskEntry.completedAt - taskEntry.startedAt) / 1000);
    const status = taskEntry.status === 'done' ? 'completed successfully' : `failed: ${taskEntry.result?.error || 'unknown error'}`;
    let resultSummary = '';
    if (taskEntry.status === 'done' && taskEntry.result?.result) {
      resultSummary = taskEntry.result.result.substring(0, 3000);
    }
    const usage = taskEntry.result?.usage;
    const usageStr = usage ? ` (${usage.input_tokens}/${usage.output_tokens} tokens)` : '';

    const content = [
      `[BACKGROUND TASK ${status}]`,
      `Task ID: ${taskId}`,
      `Duration: ${elapsed}s${usageStr}`,
      resultSummary ? `\nResult:\n${resultSummary}` : '',
      '\nSummarize the outcome for the user concisely. If the task produced files, mention their paths.',
    ].filter(Boolean).join('\n');

    const ch = this._getChannel(channelId);
    const channelName = ch.name || channelId;

    const fakeMessage = {
      channelId,
      id: `task-${taskId}`,
      channel: {
        send: (text) => this.client.channels.fetch(channelId).then(c => c.send(text)).catch(() => null),
        sendTyping: () => this.client.channels.fetch(channelId).then(c => c.sendTyping()).catch(() => {}),
        isThread: () => false,
        name: channelName,
      },
      reply: function(text) { return this.channel.send(text); },
      reactions: { cache: new Map() },
    };

    ch.queue.push({
      content,
      channelId,
      channelName,
      userId: 'system',
      userName: 'System',
      guildName: null,
      isDm: false,
      isThread: false,
      parentChannelName: null,
      message: fakeMessage,
      trigger: 'task_complete',
    });

    this.log.info(`[task-deliver] Queued result for ${taskId} in #${channelName}`);
    this._processQueue(channelId);
  }

  /**
   * Send a subagent progress update as an editable embed in the channel.
   * Maintains one progress message per channelId, editing it in-place.
   * When the task completes, the embed is deleted to keep the channel clean.
   */
  async sendProgressUpdate(channelId, text, opts = {}) {
    if (!this._progressMessages) this._progressMessages = new Map();
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;

      const lines = this._progressMessages.get(channelId)?.lines || [];
      if (text && text.trim()) lines.push(text.trim().substring(0, 200));
      if (lines.length > 6) lines.splice(0, lines.length - 6);

      const embed = {
        color: opts.done ? 0x4caf50 : opts.error ? 0xe74c3c : 0xf5a623,
        title: opts.done ? '✓ Task complete' : opts.error ? '✗ Task failed' : '⏳ Working...',
        description: lines.join('\n') || 'Starting...',
        footer: { text: opts.done || opts.error ? '' : 'This message will be removed when the task finishes' },
      };

      const existing = this._progressMessages.get(channelId);
      if (existing?.messageId) {
        try {
          const msg = await channel.messages.fetch(existing.messageId);
          if (opts.done || opts.error) {
            await msg.delete().catch(() => {});
            this._progressMessages.delete(channelId);
          } else {
            await msg.edit({ embeds: [embed] });
            existing.lines = lines;
          }
          return;
        } catch {
          this._progressMessages.delete(channelId);
        }
      }

      if (opts.done || opts.error) return;

      const sent = await channel.send({ embeds: [embed] });
      this._progressMessages.set(channelId, { messageId: sent.id, lines });
    } catch (e) {
      this.log.debug(`[progress] Failed to send update to ${channelId}: ${e.message}`);
    }
  }

  async clearProgressMessage(channelId) {
    if (!this._progressMessages?.has(channelId)) return;
    try {
      const entry = this._progressMessages.get(channelId);
      const channel = await this.client.channels.fetch(channelId);
      const msg = await channel.messages.fetch(entry.messageId);
      await msg.delete();
    } catch (e) { this.log.warn('[discord] this._progressMessages.get failed: ' + e.message); }
    this._progressMessages.delete(channelId);
  }

  /**
   * Inject a proactive prompt into a channel queue. The main agent processes it
   * like a lull — it can respond naturally or choose NO_REPLY to stay silent.
   */
  injectProactivePrompt(channelId, context, topic) {
    const ch = this._getChannel(channelId);
    if (ch.processing) {
      this.log.debug('[proactive] Channel busy, skipping');
      return;
    }

    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;

    const channelName = ch.name || channelId;

    const fakeMessage = {
      channelId,
      id: `proactive-${Date.now()}`,
      channel: {
        send: (text) => this.client.channels.fetch(channelId).then(c => c.send(text)).catch(() => null),
        sendTyping: () => this.client.channels.fetch(channelId).then(c => c.sendTyping()).catch(() => {}),
        isThread: () => false,
        name: channelName,
      },
      reply: function(text) { return this.channel.send(text); },
      reactions: { cache: new Map() },
    };

    ch.queue.push({
      content: prompt,
      channelId,
      channelName,
      userId: 'system',
      userName: 'System',
      guildName: null,
      isDm: false,
      isThread: false,
      parentChannelName: null,
      message: fakeMessage,
      trigger: 'proactive',
    });

    this.log.info(`[proactive] Queued prompt in #${channelName}`);
    this._processQueue(channelId);
  }

  /**
   * Return a list of channels that have had recent activity, with optional topic hints.
   * Used by the maintainer to decide where proactive messages could go.
   */
  getActiveChannelIds() {
    const results = [];
    for (const [channelId, ch] of this._queue.entries()) {
      const name = ch.name || channelId;
      results.push({ id: channelId, name });
    }

    if (results.length === 0 && this.client?.channels?.cache) {
      for (const [id, channel] of this.client.channels.cache) {
        if (channel.isTextBased() && !channel.isDMBased()) {
          results.push({ id, name: channel.name || id });
        }
      }
    }

    return results.slice(0, 20);
  }

  async _handleNewSession(message, channelId, channelName, isDm, userId) {
    try {
      const sessionKey = this._sessionKey(channelId, isDm, userId);
      this.agent.sessions.clearSession(sessionKey);
      await message.reply('🔄 Session cleared. Starting fresh.');
      this.log.info(`Session reset by ${message.author.username} in #${channelName}`);
    } catch (err) {
      await message.reply('Failed to reset session.').catch(() => {});
      this.log.error(`Session reset failed: ${err.message}`);
    }
  }

  /**
   * /rebirth — backup the agent node, wipe it, start with a blank seed
   */
  async _handleRebirth(message, channelName) {
    try {
      const fs = require('fs');
      const path = require('path');
      const agentId = this.config.agentId || 'spore';
      
      // Read current agent node from graph for backup
      const graphContext = this.agent.graphContext;
      const currentNode = graphContext.getNode(agentId);
      
      if (!currentNode) {
        await message.reply('No identity node found to rebirth from.');
        return;
      }

      // Backup to timestamped JSON file
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupDir = path.join(__dirname, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${agentId}-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(currentNode, null, 2));

      // Wipe the agent node and replace with a blank seed
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(this.config.graphDbPath);
      
      // Delete aspects, attributes, gaps for this node
      const aspects = db.prepare('SELECT id FROM aspects WHERE node_id = ?').all(agentId);
      for (const asp of aspects) {
        db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(asp.id);
      }
      db.prepare('DELETE FROM aspects WHERE node_id = ?').run(agentId);
      db.prepare('DELETE FROM gaps WHERE node_id = ?').run(agentId);
      
      // Reset the node itself to a minimal seed
      db.prepare(`
        UPDATE nodes SET 
          description = 'Reborn. A blank page. Everything that comes next is unwritten.',
          updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(agentId);

      // Add back one seed aspect
      db.prepare('INSERT INTO aspects (node_id, name, weight) VALUES (?, ?, ?)').run(agentId, 'identity', 10);
      const aspId = db.prepare('SELECT last_insert_rowid() as id').get().id;
      db.prepare('INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, ?)').run(
        aspId, 'A graph-native AI agent. Identity emerges from the knowledge graph. Everything else is yours to discover.', 10
      );

      // Add back one gap
      db.prepare("INSERT INTO gaps (node_id, content) VALUES (?, ?)").run(agentId, 'Who am I now?');
      
      db.close();

      // Clear all sessions
      this.agent.sessions.db.exec('DELETE FROM messages');
      this.agent.sessions.db.exec('DELETE FROM sessions');

      await message.reply('🌅 Reborn. Previous life backed up to backups/' + agentId + '-' + ts + '.json. Session cleared. I am a blank page.');
      this.log.info(`REBIRTH: ${agentId} wiped and reseeded. Backup at ${backupPath}`);
    } catch (err) {
      await message.reply(`Rebirth failed: ${err.message}`).catch(() => {});
      this.log.error(`Rebirth failed: ${err.message}`);
    }
  }

  /**
   * Check if the message author is an admin (by user ID or role ID).
   * If no admins are configured, falls back to server owner or Administrator permission.
   */
  _isAdmin(message) {
    const admins = this.config.discordAdmins || [];
    const userId = message.author.id;
    if (admins.length > 0) {
      if (admins.includes(userId)) return true;
      const memberRoles = message.member?.roles?.cache;
      if (memberRoles) {
        for (const roleId of admins) {
          if (memberRoles.has(roleId)) return true;
        }
      }
      return false;
    }
    if (message.guild?.ownerId === userId) return true;
    if (message.member?.permissions?.has?.('Administrator')) return true;
    return false;
  }

  /**
   * /status — show SPORE status
   */
  async _handleStatus(message) {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sessions = this.agent.sessions.listSessions?.() || [];
    const nodeCount = this.agent.graphContext?.db?.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c || '?';
    
    await message.reply([
      '```',
      `Spore Core v0.1.0`,
      `Model: ${this.config.model}`,
      `Agent: ${this.config.agentId || 'spore'}`,
      `Graph: ${nodeCount} nodes`,
      `Sessions: ${sessions.length} active`,
      `Uptime: ${h}h ${m}m`,
      '```'
    ].join('\n'));
  }

  /**
   * Collect image URLs from message attachments for Claude vision.
   */
  async _collectImageAttachments(items) {
    const images = [];
    const imageExts = /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i;
    const MIME_MAP = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp' };
    const MAX_SIZE = 5 * 1024 * 1024;
    const MAX_IMAGES = 3;

    for (const item of items) {
      if (!item.message?.attachments) continue;
      for (const [, att] of item.message.attachments) {
        if (images.length >= MAX_IMAGES) break;
        const mime = att.contentType || '';
        const isImage = mime.startsWith('image/') || imageExts.test(att.name || '');
        if (!isImage || !att.url) continue;
        if (att.size > MAX_SIZE) continue;
        try {
          const res = await fetch(att.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const mediaType = MIME_MAP[mime] || 'image/jpeg';
          images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
          this.log.info(`Downloaded image: ${att.name} (${buf.length} bytes)`);
        } catch (e) {
          this.log.warn(`Failed to download image ${att.name}: ${e.message}`);
        }
      }
    }
    return images.length > 0 ? images : null;
  }

  /**
   * Channel gating: check if a channel is gated (should not trigger agent).
   * Returns true if the message should be BLOCKED from agent processing.
   * DMs always pass. Read access via message_read is unaffected.
   * 
   * Supports two config formats:
   * 1. Flat: "listenChannels": ["id1", "name1"] — applies globally
   * 2. Guild-scoped: "guilds": { "guildId": { "channels": ["id1"] } } — per-guild allowlists
   * Guild-scoped takes priority when present for a given guild.
   */
  _isChannelGated(channelId, channelName, isDm, guildId) {
    // DMs always pass through
    if (isDm) return false;

    // Check guild-scoped config first (takes priority)
    if (guildId && this._guildGateConfig) {
      const guildConfig = this._guildGateConfig[guildId];
      if (guildConfig) {
        // Guild has explicit config
        if (guildConfig.channels) {
          // Allowlist: only these channels in this guild
          return !guildConfig.channels.some(entry => entry === channelId || entry === channelName);
        }
        // Guild config exists but no channels list = open (listen to all in this guild)
        return false;
      }
      // Guild not in guilds config — block it (guilds is single source of truth)
      return true;
    }

    // Fall back to flat listenChannels config
    const gate = this._gateConfig !== undefined ? this._gateConfig : this.config.listenChannels;

    // null/undefined = no gating, listen everywhere (default)
    if (!gate) return false;

    // Simple array format: ['channel-id-1', 'channel-id-2'] = global allowlist
    if (Array.isArray(gate)) {
      return !gate.some(entry => entry === channelId || entry === channelName);
    }

    // Object format: { mode: 'allowlist'|'blocklist', channels: [...] }
    if (gate && typeof gate === 'object') {
      const channels = gate.channels || [];
      const matches = channels.some(entry => entry === channelId || entry === channelName);

      if (gate.mode === 'blocklist') {
        return matches;
      }
      return !matches;
    }

    return false;
  }

  _isMediaOnly(channelName) {
    return ['media-only'].includes(channelName);
  }

  /**
   * Resolve message content: replace <@id> with @names, append attachment descriptions
   */
  async _resolveContent(message) {
    let content = message.content || '';

    // Resolve @mentions to readable names
    if (content.includes('<@') && message.mentions?.users?.size > 0) {
      for (const [id, user] of message.mentions.users) {
        const name = message.guild?.members?.cache.get(id)?.displayName || user.displayName || user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
      }
    }
    // Resolve role mentions
    if (content.includes('<@&') && message.mentions?.roles?.size > 0) {
      for (const [id, role] of message.mentions.roles) {
        content = content.replace(new RegExp(`<@&${id}>`, 'g'), `@${role.name}`);
      }
    }
    // Resolve channel mentions
    if (content.includes('<#')) {
      content = content.replace(/<#(\d+)>/g, (_, id) => {
        const ch = message.guild?.channels?.cache.get(id);
        return ch ? `#${ch.name}` : `#unknown`;
      });
    }

    if (message.attachments.size > 0) {
      const descs = await Promise.all([...message.attachments.values()].map(async a => {
        const mime = a.contentType || 'unknown';
        if (mime.startsWith('image/')) return `[Image: ${a.name} ${a.width}x${a.height}]`;
        if (mime.startsWith('video/')) return `[Video: ${a.name}]`;
        if (mime.startsWith('audio/')) return `[Audio: ${a.name}]`;
        if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
          try {
            const res = await fetch(a.url);
            const text = await res.text();
            const preview = text.length > 8000 ? text.substring(0, 8000) + '\n[...truncated]' : text;
            return `[File: ${a.name} (${mime})]\n${preview}`;
          } catch (e) {
            return `[File: ${a.name} (${mime}) — fetch failed: ${e.message}]`;
          }
        }
        return `[File: ${a.name} (${mime})]`;
      }));
      if (content) content += '\n';
      content += descs.join('\n');
    }

    // Embed text (link previews, etc.)
    if (message.embeds?.length > 0 && !content.trim()) {
      const embedText = message.embeds.map(e => {
        const parts = [];
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
        return parts.join(': ');
      }).filter(Boolean).join('\n');
      if (embedText) content = content ? content + '\n' + embedText : embedText;
    }

    return content;
  }

  // Voice is handled by DiscordVoice (see ./discord-voice.js)
  // Legacy stubs kept for hot-reload compatibility
  async _handleJoinVoice(message) { return this._voice.handleJoin(message); }
  async _handleLeaveVoice(message) { return this._voice.handleLeave(message); }


  /**
   * Reply to the triggering message, chunking if necessary.
   * First chunk is a reply; subsequent chunks are plain sends.
   */
  async _sendReply(triggerMessage, text) {
    if (!text) return null;
    const maxLen = this.config.maxMessageLength;

    if (text.trim() === 'NO_REPLY') return null;

    const chunks = this._chunkText(text, maxLen);
    let lastSent = null;

    for (let i = 0; i < chunks.length; i++) {
      const lastTime = this.lastMessageTime.get(triggerMessage.channelId) || 0;
      const elapsed = Date.now() - lastTime;
      if (elapsed < this.minMessageInterval) {
        await this._sleep(this.minMessageInterval - elapsed);
      }

      if (i === 0) {
        lastSent = await triggerMessage.reply(chunks[i]).catch(async () => {
          return await triggerMessage.channel.send(chunks[i]);
        });
      } else {
        lastSent = await triggerMessage.channel.send(chunks[i]);
      }
      this.lastMessageTime.set(triggerMessage.channelId, Date.now());
    }

    return lastSent;
  }

  /**
   * React to a message with an emoji. Used by the agent's react tool.
   */
  async reactToMessage(channelId, messageId, emoji) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return { ok: false, error: 'Channel not found or not text-based' };
      const msg = await channel.messages.fetch(messageId);
      await msg.react(emoji);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Edit a previously sent message.
   */
  async editMessage(channelId, messageId, newContent) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return { ok: false, error: 'Channel not found' };
      const msg = await channel.messages.fetch(messageId);
      if (msg.author.id !== this.client.user.id) return { ok: false, error: 'Can only edit own messages' };
      await msg.edit(newContent);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  
  /**
   * Chunk text to fit Discord's message limit
   */
  _chunkText(text, maxLen) {
    if (text.length <= maxLen) return [text];
    
    const chunks = [];
    let remaining = text;
    
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      
      // Prefer breaking at code block boundaries
      let breakPoint = -1;
      
      // Try to break at a paragraph boundary
      const paragraphBreak = remaining.lastIndexOf('\n\n', maxLen);
      if (paragraphBreak > maxLen * 0.3) {
        breakPoint = paragraphBreak + 1;
      }
      
      // Try to break at a line boundary
      if (breakPoint < 0) {
        const lineBreak = remaining.lastIndexOf('\n', maxLen);
        if (lineBreak > maxLen * 0.3) {
          breakPoint = lineBreak + 1;
        }
      }
      
      // Try to break at a space
      if (breakPoint < 0) {
        const spaceBreak = remaining.lastIndexOf(' ', maxLen);
        if (spaceBreak > maxLen * 0.3) {
          breakPoint = spaceBreak + 1;
        }
      }
      
      // Hard break as last resort
      if (breakPoint < 0) {
        breakPoint = maxLen;
      }
      
      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint);
    }
    
    return chunks;
  }
  
  /**
   * Handle Discord errors
   */
  _onError(error) {
    this.log.error('Discord client error:', error.message);
    // discord.js handles reconnection automatically
  }
  
  /**
   * Disconnect from Discord
   */
  async disconnect() {
    if (this.client) {
      this.log.info('Disconnecting from Discord...');
      await this.client.destroy();
      this.client = null;
    }
  }
  
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { DiscordGateway };
