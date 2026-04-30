/**
 * slack.js — Slack Gateway (Socket Mode)
 *
 * Connects to Slack via Socket Mode (WebSocket — no public URL required),
 * listens for messages and app_mention events, routes them to the agent loop,
 * and sends responses back. Supports threads, reactions, file uploads,
 * channel gating, lull responses, task injection, and proactive outreach.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN  — xoxb-… (Bot User OAuth Token)
 *   SLACK_APP_TOKEN  — xapp-… (App-Level Token for Socket Mode)
 *
 * Required Slack app settings:
 *   - Socket Mode: enabled
 *   - Bot token scopes: channels:history, channels:read, chat:write,
 *     groups:history, groups:read, im:history, im:read, im:write,
 *     mpim:history, reactions:write, users:read, files:write
 *   - Event subscriptions: message.channels, message.groups,
 *     message.im, message.mpim, app_mention
 */

const { App } = require('@slack/bolt');
const path = require('path');
const fs = require('fs');
const { feed } = require('../graph');
const { resolveSourcePolicy } = require('./privacy');
const { MessageQueue } = require('./message-queue');
// Branding strings used in /status messages.
const brand = { name: 'Spore Core', Agent: 'Spore Core' };

class SlackGateway {
  constructor(config, logger, agentLoop) {
    this.config = config;
    this.log = logger;
    this.agent = agentLoop;
    this.app = null;
    this.botUserId = null;

    // Per-channel queues live in MessageQueue. Slack-specific fields
    // (lastBotMessageTs, lastBotThreadTs, lastBotResponseTime, name) are
    // attached lazily by _getChannel below.
    this._queue = new MessageQueue({
      config,
      log: logger,
      processOnce: (channelId, ch) => this._processQueueOnce(channelId, ch),
    });

    // Message dedup: prevents re-processing replayed events
    this._seenMessages = new Set();
    this._seenMessagesMax = 200;

    // Watch spore.json for channel gating changes
    this._gateConfig = null;
    this._loadGateConfig();
    try {
      const configPath = require('path').join(__dirname, '..', 'spore.json');
      require('fs').watch(configPath, () => {
        this._loadGateConfig();
        this.log.info('[slack][gate] spore.json changed — reloaded listenChannels');
      });
    } catch (e) {
      this.log.warn('[slack][gate] Could not watch spore.json:', e.message);
    }
  }

  _loadGateConfig() {
    try {
      const raw = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'spore.json'), 'utf8'
      );
      const parsed = JSON.parse(raw);
      this._gateConfig = parsed.listenChannels || null;
    } catch {
      this._gateConfig = null;
    }
  }

  _getChannel(channelId) {
    const ch = this._queue.getChannel(channelId);
    // Slack-specific fields — initialized lazily on first access so the
    // base record stays minimal.
    if (ch.lastBotMessageTs === undefined) {
      ch.lastBotMessageTs = null;
      ch.lastBotResponseTime = null;
      ch.lastBotThreadTs = null;
      ch.name = channelId;
    }
    return ch;
  }

  /**
   * Initialize and start the Slack app in Socket Mode.
   */
  async connect() {
    const slackCfg = this.config.channels?.slack || {};
    const botToken = slackCfg.botToken || this.config.slackBotToken;
    const appToken = slackCfg.appToken || this.config.slackAppToken;

    if (!botToken) throw new Error('Missing SLACK_BOT_TOKEN');
    if (!appToken) throw new Error('Missing SLACK_APP_TOKEN (required for Socket Mode)');

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: 'error', // suppress bolt's own verbose logging
    });

    // Register message handler (covers all channel types including DMs)
    this.app.message(async ({ message, say, client }) => {
      await this._onMessage(message, say, client);
    });

    // app_mention fires when the bot is @-mentioned in a channel
    // (message.channels + app_mention both fire for mentions in public channels,
    //  so we deduplicate by event_ts tracking)
    this.app.event('app_mention', async ({ event, say, client }) => {
      // The message handler already covers this — skip to avoid double processing.
      // We rely solely on the message event + _getTriggerType('mention') detection.
    });

    // Slash commands
    this.app.command('/new', async ({ command, ack, say }) => {
      await ack();
      await this._handleNewSession(command, say);
    });
    this.app.command('/reset', async ({ command, ack, say }) => {
      await ack();
      await this._handleNewSession(command, say);
    });
    this.app.command('/status', async ({ command, ack, say }) => {
      await ack();
      await this._handleStatus(say);
    });
    this.app.command('/reload', async ({ command, ack, say }) => {
      await ack();
      if (!this._isAdmin(command.user_id)) { await say('⛔ Admin-only command.'); return; }
      await this._handleReload(command, say);
    });

    // Resolve bot user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id;
      this.log.info(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (e) {
      this.log.warn('[slack] Could not resolve bot user ID:', e.message);
    }

    await this.app.start();
    this.log.info('[slack] Connected via Socket Mode');
    return this.app;
  }

  /**
   * Handle an incoming Slack message event.
   */
  async _onMessage(message, say, client) {
    // Ignore messages from bots (including self) unless configured otherwise
    if (message.bot_id || message.subtype === 'bot_message') return;
    if (message.subtype && message.subtype !== 'thread_broadcast') return;
    if (!message.text && !message.files?.length) return;

    // Dedup: Slack can deliver duplicate events during reconnects
    const msgKey = message.client_msg_id || `${message.channel}:${message.ts}`;
    if (this._seenMessages.has(msgKey)) {
      this.log.debug(`Duplicate Slack message ${msgKey} — skipping`);
      return;
    }
    this._seenMessages.add(msgKey);
    if (this._seenMessages.size > this._seenMessagesMax) {
      const iter = this._seenMessages.values();
      for (let i = 0; i < 50; i++) this._seenMessages.delete(iter.next().value);
    }

    const channelId = message.channel;
    const isDm = message.channel_type === 'im' || message.channel_type === 'mpim';
    const threadTs = message.thread_ts || null;
    const isReply = Boolean(threadTs && threadTs !== message.ts);
    const userId = message.user;
    const eventTs = message.ts;

    // Resolve display name
    let userName = userId;
    try {
      const info = await client.users.info({ user: userId });
      userName = info.user?.profile?.display_name || info.user?.real_name || info.user?.name || userId;
    } catch (e) { this.log.warn('[slack] client.users.info failed: ' + e.message); }

    // Resolve channel name
    let channelName = channelId;
    const ch = this._getChannel(channelId);
    if (ch.name === channelId) {
      try {
        const info = isDm
          ? { channel: { name: `dm:${userName}` } }
          : await client.conversations.info({ channel: channelId });
        channelName = info.channel?.name || channelId;
        ch.name = channelName;
      } catch (e) { this.log.warn('[slack] client.conversations.info failed: ' + e.message); }
    } else {
      channelName = ch.name;
    }

    const content = await this._resolveContent(message, client);
    if (!content.trim()) return;

    this.log.info(`[slack] Message from ${userName} in #${channelName} (${content.length} chars)`);

    // Slash-command style text commands (not registered as proper slash commands yet)
    const cmd = content.trim().toLowerCase();
    if (cmd === '/new' || cmd === '/reset') {
      await this._handleNewSession({ channel_id: channelId, user_id: userId, user_name: userName }, say);
      return;
    }
    if (cmd === '/status') { await this._handleStatus(say); return; }

    // Channel gating
    if (this._isChannelGated(channelId, channelName, isDm)) {
      this.log.debug(`[slack] Gated message from #${channelName} — not in listen list`);
      return;
    }

    const trigger = this._getTriggerType(message, content, isDm, isReply, ch);
    const policy = resolveSourcePolicy(this.config, 'slack', channelId);

    const sessionKey = this.agent.sessions.constructor.buildKey(channelId, isDm, userId);
    const labeledContent = isDm ? content : `[${userName}]: ${content}`;

    if (trigger && policy.respond) {
      this._queue.enqueueTriggered(channelId, {
        content: labeledContent,
        channelId, channelName, userId, userName, isDm, threadTs, eventTs,
        trigger, client, say,
        _rawFiles: message.files || [],
      }, { channelLabel: `[slack] #${channelName}` });
    } else {
      this.agent.sessions.addMessage(sessionKey, 'user', labeledContent);
      this.log.debug(`[slack] Observed message from ${userName} in #${channelName} (no trigger)`);
      this._queue.scheduleLull(channelId, () => {
        this._maybeLullResponse(channelId, channelName, isDm, userId, userName, client, say, threadTs);
      });
    }
  }

  /**
   * Determine what triggered the bot, if anything.
   */
  _getTriggerType(message, content, isDm, isReply, ch) {
    if (isDm) return 'dm';

    // Direct mention via @bot
    if (this.botUserId && content.includes(`<@${this.botUserId}>`)) return 'mention';

    // Reply in a thread where the bot previously responded
    if (isReply && ch.lastBotThreadTs && message.thread_ts === ch.lastBotThreadTs) return 'reply';

    // Bot's display name mentioned
    const botName = (this.config.displayName || this.config.agentId || 'spore').toLowerCase();
    if (botName && content.toLowerCase().includes(botName)) return 'name';

    // Check configured nicknames
    const nicknames = this.config.nicknames || [];
    if (nicknames.some(n => content.toLowerCase().includes(n))) return 'name';

    // Conversation continuation window
    const continuationWindowMs = (this.config.continuationWindowMinutes || 5) * 60 * 1000;
    if (ch.lastBotResponseTime && Date.now() - ch.lastBotResponseTime < continuationWindowMs) {
      return 'continuation';
    }

    return null;
  }

  async _maybeLullResponse(channelId, channelName, isDm, userId, userName, client, say, threadTs) {
    this._queue.enqueueLull(channelId, {
      channelId, channelName, userId, userName, isDm, threadTs, client, say,
    });
  }

  async _processQueue(channelId) {
    return this._queue.processQueue(channelId);
  }

  async _processQueueOnce(channelId, ch) {
    const { items, merged, last, trigger, isPassive } = this._queue.drain(ch);

    const client = last.client;

    // Stall detection: post a temporary thinking message for direct triggers
    let thinkingTs = null;
    let stallSoftTimer = null;
    let stallHardTimer = null;

    if (!isPassive && client) {
      stallSoftTimer = setTimeout(async () => {
        try {
          const res = await client.chat.postMessage({
            channel: channelId,
            text: '⏳ thinking…',
            thread_ts: last.threadTs || undefined,
          });
          thinkingTs = res.ts;
        } catch (e) { this.log.warn('[slack] client.chat.postMessage failed: ' + e.message); }
      }, this.config.stallSoftMs || 10000);

      stallHardTimer = setTimeout(async () => {
        if (thinkingTs) {
          try {
            await client.chat.update({ channel: channelId, ts: thinkingTs, text: '🐢 still thinking…' });
          } catch (e) { this.log.warn('[slack] client.chat.update failed: ' + e.message); }
        }
      }, this.config.stallHardMs || 30000);
    }

    const cleanupStall = async () => {
      if (stallSoftTimer) clearTimeout(stallSoftTimer);
      if (stallHardTimer) clearTimeout(stallHardTimer);
      if (thinkingTs && client) {
        try { await client.chat.delete({ channel: channelId, ts: thinkingTs }); } catch (e) { this.log.warn('[slack] client.chat.delete failed: ' + e.message); }
        thinkingTs = null;
      }
    };

    const imageAttachments = await this._collectImageAttachments(items, client);

    try {
      const policy = resolveSourcePolicy(this.config, 'slack', channelId);
      const result = await this.agent.processMessage({
        content: merged,
        messageContent: merged,
        channelId,
        channelName: last.channelName,
        userId: last.userId,
        userName: last.userName,
        guildName: null,
        isDm: last.isDm,
        trigger,
        images: imageAttachments,
        platform: 'slack',
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
          const sentTs = await this._sendReply(channelId, text, last.threadTs, client).catch(() => null);
          if (sentTs) {
            ch.lastBotMessageTs = sentTs;
            ch.lastBotResponseTime = Date.now();
            if (last.threadTs || sentTs) ch.lastBotThreadTs = last.threadTs || sentTs;
          }
        },
        onError: (err) => {
          this.log.error(`[slack] Agent error in #${last.channelName}:`, err.message);
        },
      });

      await cleanupStall();
      ch._lastIntermediateAt = 0;
      ch._pendingIntermediateText = null;

      if (result.skipped) {
        this.log.debug('[slack] Agent run was skipped (concurrent)');
        return;
      }

      if (result.text) {
        const sentTs = await this._sendReply(channelId, result.text, last.threadTs, client);
        if (sentTs) {
          ch.lastBotMessageTs = sentTs;
          ch.lastBotResponseTime = Date.now();
          ch.lastBotThreadTs = last.threadTs || sentTs;
        }
        const toolSummary = result.toolUsage
          ? ' tools=[' + Object.entries(result.toolUsage).map(([t, n]) => n > 1 ? `${t}x${n}` : t).join(', ') + ']'
          : '';
        this.log.info(`[slack] Response in #${last.channelName} [${trigger}] (${result.usage?.input_tokens}/${result.usage?.output_tokens} tokens, ${result.iterations} iters${toolSummary})`);

        if (policy.shareToFeed) {
          try {
            feed.log({
              channelId,
              channelName: `slack:${last.channelName}`,
              userId: last.userId,
              userName: last.userName,
              userMessage: merged,
              myResponse: result.text,
              trigger,
              usage: result.usage,
              iterations: result.iterations,
            });
          } catch (e) { this.log.warn('[slack] feed.log failed: ' + e.message); }
        }
      } else if (isPassive) {
        this.log.debug(`[slack] ${trigger} in #${last.channelName}: no visible response`);
      }
    } catch (e) {
      await cleanupStall();
      throw e;
    }
  }

  /**
   * Resolve message content: strip bot mention, resolve user mentions, append file descriptions.
   */
  async _resolveContent(message, client) {
    let content = message.text || '';

    // Strip self-mention (common in channels where bot must be @-mentioned)
    if (this.botUserId) {
      content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    // Resolve <@U...> user mentions to @name
    const userRefs = content.match(/<@U[A-Z0-9]+>/g) || [];
    for (const ref of userRefs) {
      const uid = ref.slice(2, -1);
      try {
        const info = await client.users.info({ user: uid });
        const name = info.user?.profile?.display_name || info.user?.real_name || uid;
        content = content.replace(ref, `@${name}`);
      } catch {
        content = content.replace(ref, `@${uid}`);
      }
    }

    // Resolve <#C...> channel mentions
    content = content.replace(/<#([A-Z0-9]+)\|([^>]*)>/g, '#$2');
    content = content.replace(/<#([A-Z0-9]+)>/g, '#$1');

    // Convert Slack mrkdwn links <url|text> → text (url)
    content = content.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)');
    content = content.replace(/<(https?:\/\/[^>]+)>/g, '$1');

    // Describe file attachments
    if (message.files?.length) {
      const descs = message.files.map(f => {
        const mime = f.mimetype || 'unknown';
        if (mime.startsWith('image/')) return `[Image: ${f.name || f.id} ${f.original_w || '?'}x${f.original_h || '?'}]`;
        if (mime.startsWith('video/')) return `[Video: ${f.name || f.id}]`;
        if (mime.startsWith('audio/')) return `[Audio: ${f.name || f.id}]`;
        return `[File: ${f.name || f.id} (${mime})]`;
      });
      if (content) content += '\n';
      content += descs.join('\n');
    }

    return content.trim();
  }

  /**
   * Download image files from Slack for Claude vision.
   */
  async _collectImageAttachments(items, client) {
    const images = [];
    const MIME_MAP = {
      'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg',
      'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp',
    };
    const MAX_SIZE = 5 * 1024 * 1024;
    const MAX_IMAGES = 3;

    const slackCfg = this.config.channels?.slack || {};
    const botToken = slackCfg.botToken || this.config.slackBotToken;

    for (const item of items) {
      if (!item._rawFiles) continue;
      for (const f of item._rawFiles) {
        if (images.length >= MAX_IMAGES) break;
        const mime = f.mimetype || '';
        if (!mime.startsWith('image/') || !MIME_MAP[mime]) continue;
        if (f.size > MAX_SIZE) continue;
        const url = f.url_private_download || f.url_private;
        if (!url) continue;
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          images.push({
            type: 'image',
            source: { type: 'base64', media_type: MIME_MAP[mime], data: buf.toString('base64') },
          });
          this.log.info(`[slack] Downloaded image: ${f.name} (${buf.length} bytes)`);
        } catch (e) {
          this.log.warn(`[slack] Failed to download image ${f.name}: ${e.message}`);
        }
      }
    }
    return images.length > 0 ? images : null;
  }

  /**
   * Channel gating: check if messages from this channel should be blocked.
   */
  _isChannelGated(channelId, channelName, isDm) {
    if (isDm) return false;

    const gate = this._gateConfig !== undefined ? this._gateConfig : this.config.listenChannels;
    if (!gate) return false;

    if (Array.isArray(gate)) {
      return !gate.some(entry => entry === channelId || entry === channelName);
    }

    if (gate && typeof gate === 'object') {
      const channels = gate.channels || [];
      const matches = channels.some(entry => entry === channelId || entry === channelName);
      if (gate.mode === 'blocklist') return matches;
      return !matches;
    }

    return false;
  }

  /**
   * Send a reply, chunking if necessary. Returns the ts of the last sent message.
   */
  async _sendReply(channelId, text, threadTs, client) {
    if (!client) return null;
    if (text.trim() === 'NO_REPLY' || text.includes('NO_REPLY')) return null;

    const maxLen = this.config.channels?.slack?.textChunkLimit || 3000;
    const chunks = this._chunkText(this._toMrkdwn(text), maxLen);
    let lastTs = null;

    for (const chunk of chunks) {
      try {
        const res = await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs || undefined,
          unfurl_links: false,
          unfurl_media: false,
        });
        lastTs = res.ts;
      } catch (e) {
        this.log.error(`[slack] Failed to send message: ${e.message}`);
      }
    }

    return lastTs;
  }

  /**
   * Convert Discord-flavoured markdown to Slack mrkdwn.
   * Slack uses *bold*, _italic_, `code`, ```blocks```.
   * Discord uses **bold**, *italic*, `code`, ```blocks```.
   */
  _toMrkdwn(text) {
    // **bold** → *bold* (but don't touch already-correct *bold*)
    return text
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^(#{1,3})\s+(.+)$/gm, '*$2*'); // Headings → bold
  }

  /**
   * Chunk text to fit within Slack's per-message limit.
   */
  _chunkText(text, maxLen) {
    if (text.length <= maxLen) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }

      let breakPoint = -1;
      const paragraphBreak = remaining.lastIndexOf('\n\n', maxLen);
      if (paragraphBreak > maxLen * 0.3) breakPoint = paragraphBreak + 1;

      if (breakPoint < 0) {
        const lineBreak = remaining.lastIndexOf('\n', maxLen);
        if (lineBreak > maxLen * 0.3) breakPoint = lineBreak + 1;
      }

      if (breakPoint < 0) {
        const spaceBreak = remaining.lastIndexOf(' ', maxLen);
        if (spaceBreak > maxLen * 0.3) breakPoint = spaceBreak + 1;
      }

      if (breakPoint < 0) breakPoint = maxLen;

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint);
    }

    return chunks;
  }

  // ─── Gateway Interface Methods ──────────────────────────────────────

  /**
   * Send a message to a Slack channel (used by the agent's message_send tool).
   */
  async sendMessage(channelId, text, filePath, opts) {
    if (!this.app) return { error: 'Slack not connected' };
    try {
      if (filePath) {
        const fs = require('fs');
        const path = require('path');
        const fileContent = fs.readFileSync(filePath);
        const filename = path.basename(filePath);

        const uploadRes = await this.app.client.files.getUploadURLExternal({
          filename,
          length: fileContent.length,
        });

        await fetch(uploadRes.upload_url, {
          method: 'POST',
          body: fileContent,
          headers: { 'Content-Type': 'application/octet-stream' },
        });

        await this.app.client.files.completeUploadExternal({
          files: [{ id: uploadRes.file_id, title: filename }],
          channel_id: channelId,
          initial_comment: text || '',
        });

        return { ok: true };
      }

      const res = await this.app.client.chat.postMessage({
        channel: channelId,
        text: this._toMrkdwn(text || ''),
        thread_ts: opts?.thread_ts || undefined,
        unfurl_links: false,
        unfurl_media: false,
      });

      const ch = this._getChannel(channelId);
      ch.lastBotMessageTs = res.ts;
      ch.lastBotResponseTime = Date.now();
      ch.lastBotThreadTs = opts?.thread_ts || res.ts;

      return { ok: true, ts: res.ts };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Read recent messages from a channel.
   */
  async readMessages(channelId, limit, opts) {
    if (!this.app) return { error: 'Slack not connected' };
    try {
      const res = await this.app.client.conversations.history({
        channel: channelId,
        limit: Math.min(limit || 10, 50),
      });
      const messages = (res.messages || []).reverse().map(m => ({
        id: m.ts,
        author: m.user || m.bot_id || 'unknown',
        content: m.text || '',
        timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
        isBot: Boolean(m.bot_id),
      }));
      return { messages };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * Add a reaction to a message.
   * Accepts either Unicode emoji (best-effort name lookup) or :name: Slack format.
   */
  async reactToMessage(channelId, messageId, emoji, opts) {
    if (!this.app) return { error: 'Slack not connected' };
    try {
      const name = this._emojiToSlackName(emoji);
      await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Edit a previously sent message.
   */
  async editMessage(channelId, messageId, content, opts) {
    if (!this.app) return { error: 'Slack not connected' };
    try {
      await this.app.client.chat.update({
        channel: channelId,
        ts: messageId,
        text: this._toMrkdwn(content),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Map common Unicode emoji to Slack reaction names.
   */
  _emojiToSlackName(emoji) {
    // Strip wrapping colons if agent uses :name: format
    if (emoji.startsWith(':') && emoji.endsWith(':')) {
      return emoji.slice(1, -1);
    }
    const map = {
      '⏳': 'hourglass_flowing_sand', '🐢': 'turtle', '👍': '+1', '👎': '-1',
      '❤️': 'heart', '🔥': 'fire', '✅': 'white_check_mark', '❌': 'x',
      '⭐': 'star', '👀': 'eyes', '🚀': 'rocket', '😂': 'joy',
      '🤔': 'thinking_face', '💡': 'bulb', '⚠️': 'warning',
    };
    return map[emoji] || 'white_check_mark';
  }

  /**
   * Return channels that have seen recent activity.
   */
  getActiveChannelIds() {
    const results = [];
    for (const [channelId, ch] of this._queue.entries()) {
      results.push({ id: channelId, name: ch.name || channelId });
    }
    return results.slice(0, 20);
  }

  /**
   * Inject a completed background task result into a channel queue.
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
    const app = this.app;

    const fakeSay = async (text) => {
      if (!app) return;
      try {
        await app.client.chat.postMessage({ channel: channelId, text: typeof text === 'string' ? text : text.text });
      } catch (e) { this.log.warn('[slack] app.client.chat.postMessage failed: ' + e.message); }
    };

    ch.queue.push({
      content,
      channelId,
      channelName: ch.name || channelId,
      userId: 'system',
      userName: 'System',
      isDm: false,
      threadTs: null,
      eventTs: `task-${taskId}`,
      trigger: 'task_complete',
      client: app?.client || null,
      say: fakeSay,
    });

    this.log.info(`[slack] [task-deliver] Queued result for ${taskId} in #${ch.name || channelId}`);
    this._processQueue(channelId);
  }

  /**
   * Inject a proactive prompt into a channel queue.
   */
  injectProactivePrompt(channelId, context, topic) {
    const ch = this._getChannel(channelId);
    if (ch.processing) {
      this.log.debug('[slack] [proactive] Channel busy, skipping');
      return;
    }

    const app = this.app;
    const fakeSay = async (text) => {
      if (!app) return;
      try {
        await app.client.chat.postMessage({ channel: channelId, text: typeof text === 'string' ? text : text.text });
      } catch (e) { this.log.warn('[slack] app.client.chat.postMessage failed: ' + e.message); }
    };

    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;

    ch.queue.push({
      content: prompt,
      channelId,
      channelName: ch.name || channelId,
      userId: 'system',
      userName: 'System',
      isDm: false,
      threadTs: null,
      eventTs: `proactive-${Date.now()}`,
      trigger: 'proactive',
      client: app?.client || null,
      say: fakeSay,
    });

    this.log.info(`[slack] [proactive] Queued prompt in #${ch.name || channelId}`);
    this._processQueue(channelId);
  }

  /**
   * Send a progress update directly to a channel (no agent loop).
   */
  async sendProgressUpdate(channelId, text) {
    if (!this.app) return;
    try {
      await this.app.client.chat.postMessage({ channel: channelId, text });
    } catch (e) {
      this.log.debug(`[slack] [progress] Failed to send update: ${e.message}`);
    }
  }

  // ─── Slash-Command Handlers ─────────────────────────────────────────

  async _handleNewSession(command, say) {
    const channelId = command.channel_id;
    const userId = command.user_id;
    try {
      const sessionKey = this.agent.sessions.constructor.buildKey(channelId, false, userId);
      this.agent.sessions.clearSession(sessionKey);
      await say('🔄 Session cleared. Starting fresh.');
    } catch (err) {
      await say(`Failed to reset session: ${err.message}`);
    }
  }

  async _handleStatus(say) {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const nodeCount = this.agent.graphContext?.db?.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c || '?';
    await say([
      '```',
      `${brand.name} — ${brand.Agent} Status`,
      `Model: ${this.config.model}`,
      `Agent: ${this.config.agentId || 'spore'}`,
      `Graph: ${nodeCount} nodes`,
      `Uptime: ${h}h ${m}m`,
      '```',
    ].join('\n'));
  }

  async _handleReload(command, say) {
    try {
      const path = require('path');
      const reloaded = [];
      const hotModules = ['./tools.js', './context.js', './config.js', './feed.js', './agent.js'];
      for (const mod of hotModules) {
        const resolved = require.resolve(path.join(__dirname, '..', mod));
        if (require.cache[resolved]) {
          delete require.cache[resolved];
          reloaded.push(mod);
        }
      }

      const { ToolSystem } = require('../tools');
      const { GraphContext } = require('../graph');
      const { loadConfig } = require('../config');
      const freshConfig = loadConfig();
      freshConfig.slackBotToken = this.config.slackBotToken;
      freshConfig.slackAppToken = this.config.slackAppToken;
      Object.assign(this.config, freshConfig);

      const graph = new GraphContext(this.config, this.log);
      graph.init();
      this.agent.graphContext = graph;
      this.agent.graph = graph;

      const tools = new ToolSystem(this.config, this.log, null, graph, this.agent.client);
      tools.platformManager = this.platformManager || null;
      tools.learner = this.agent.learner;
      tools._sessions = this.agent.sessions;
      this.agent.tools = tools;
      if (this.platformManager) {
        this.platformManager.tools = tools;
        this.platformManager.agent = this.agent;
      }

      const { AgentLoop } = require('../agent');
      Object.setPrototypeOf(this.agent, AgentLoop.prototype);
      const { SlackGateway } = require('./slack.js');
      Object.setPrototypeOf(this, SlackGateway.prototype);

      this._loadGateConfig();

      await say(`🔄 Hot-reloaded: ${reloaded.join(', ')}. Config, tools, context, and agent logic refreshed.`);
    } catch (e) {
      await say(`❌ Reload failed: ${e.message}`);
    }
  }

  /**
   * Disconnect from Slack.
   */
  async disconnect() {
    if (this.app) {
      this.log.info('[slack] Disconnecting...');
      try { await this.app.stop(); } catch (e) { this.log.warn('[slack] this.app.stop failed: ' + e.message); }
      this.app = null;
    }
  }

  _isAdmin(userId) {
    const allowed = this.config.adminUsers || [];
    return allowed.includes(userId);
  }

  getStatus() {
    return this.app ? 'connected' : 'disconnected';
  }
}

module.exports = { SlackGateway };
