const https = require('https');
const fs = require('fs');
const path = require('path');
const { coreRequire } = require('../../core-require');
const { feed } = coreRequire('graph');
const { resolveSourcePolicy } = coreRequire('gateways/privacy');

// MIME types for file uploads
const TELEGRAM_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

let VoicePipeline = null;
try {
  ({ VoicePipeline } = coreRequire('voice'));
} catch (e) {
  console.warn('[telegram] require failed: ' + e.message);
}

class TelegramGateway {
  constructor(config, logger, agentLoop, pairingStore) {
    this.config = config;
    this.log = logger;
    this.agent = agentLoop;
    this.pairing = pairingStore || null;
    this.channelConfig = config.channels?.telegram || {};
    this.token = this.channelConfig.botToken || config.telegramBotToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.running = false;
    this.offset = 0;
    this.botUsername = null;
    this.recentMessages = new Map();
    this.pendingDmApprovals = new Set();
    this._voicePipeline = null;
  }

  _ensureVoicePipeline() {
    if (this._voicePipeline) return this._voicePipeline;
    if (!this.config.voice?.enabled || !VoicePipeline) return null;
    this._voicePipeline = new VoicePipeline(this.config, this.log, this.agent?._pluginManager || null);
    return this._voicePipeline.enabled ? this._voicePipeline : null;
  }

  async connect() {
    this.channelConfig = this.config.channels?.telegram || {};
    this.token = this.channelConfig.botToken || this.config.telegramBotToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    if (!this.channelConfig.enabled || !this.token) {
      this.log.info('[telegram] Gateway disabled — no bot token configured');
      return null;
    }
    const me = await this._api('getMe', {});
    this.botUsername = me?.result?.username?.toLowerCase() || null;
    this.running = true;
    if (!this.channelConfig.webhookUrl) {
      this._pollLoop().catch(e => this.log.error('[telegram] Poll loop failed:', e.message));
    } else {
      await this._api('setWebhook', {
        url: this.channelConfig.webhookUrl,
        secret_token: this.channelConfig.webhookSecret || undefined,
        allowed_updates: ['message'],
      });
      this.log.info(`[telegram] Webhook mode active on ${this.channelConfig.webhookPath || '/webhooks/telegram'}`);
    }
  }

  getStatus() {
    if (!this.channelConfig.enabled || !this.token) return 'disabled';
    return this.running ? 'connected' : 'disconnected';
  }

  async disconnect() {
    this.running = false;
  }

  async _pollLoop() {
    while (this.running) {
      try {
        const data = await this._api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        });
        for (const update of data.result || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message) {
            await this._handleMessage(update.message);
          }
        }
      } catch (e) {
        this.log.warn('[telegram] Poll error:', e.message);
        await this._sleep(3000);
      }
    }
  }

  async _handleMessage(message) {
    const chatId = String(message.chat.id);
    const isDm = message.chat.type === 'private';
    const threadId = message.message_thread_id ? String(message.message_thread_id) : null;

    // Voice note handling — route through voice pipeline
    if (message.voice || message.audio) {
      await this._handleVoiceMessage(message, chatId, isDm, threadId);
      return;
    }

    const mediaBlocks = await this._extractMediaBlocks(message);

    // Describe attached media so the agent knows what arrived
    let mediaPrefix = '';
    if (message.photo) {
      mediaPrefix = '[Photo] ';
    } else if (message.document) {
      const fname = message.document.file_name || 'file';
      const mime = message.document.mime_type ? ` (${message.document.mime_type})` : '';
      mediaPrefix = `[Document: ${fname}${mime}] `;
    } else if (message.video) {
      mediaPrefix = '[Video] ';
    } else if (message.animation) {
      mediaPrefix = '[GIF/Animation] ';
    } else if (message.sticker) {
      const emoji = message.sticker.emoji ? ` ${message.sticker.emoji}` : '';
      mediaPrefix = `[Sticker${emoji}] `;
    }

    const rawText = (message.text || message.caption || '').trim();
    const content = mediaPrefix ? (mediaPrefix + rawText).trim() : rawText;
    if (!content) return;

    const userId = String(message.from?.id || chatId);
    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
      || message.from?.username
      || `telegram:${userId}`;
    const channelName = message.chat.title || message.chat.username || (isDm ? 'telegram-dm' : `telegram:${chatId}`);
    const policy = resolveSourcePolicy(this.config, 'telegram', chatId);
    const targetId = threadId ? `${chatId}:topic:${threadId}` : chatId;
    const sessionTargetId = (threadId && this.channelConfig.sessionMode !== 'chat') ? targetId : chatId;
    const sessionKey = this.agent.sessions.constructor.buildKey({
      platform: 'telegram',
      channelId: sessionTargetId,
      isDm,
      userId,
      private: !!policy.private,
    });

    const cmd = content.trim().toLowerCase();
    if (cmd === '/new' || cmd === '/reset') {
      await this._handleNewSession(message, targetId, channelName, sessionKey);
      return;
    }

    const trigger = this._getTriggerType(message, content, isDm);
    if (!this._isAllowed(message, isDm, trigger)) {
      await this._handleRejectedMessage(message, isDm, chatId, userId);
      return;
    }

    this._rememberMessage(threadId ? `${chatId}:topic:${threadId}` : chatId, {
      messageId: String(message.message_id),
      author: userName,
      authorId: userId,
      isBot: !!message.from?.is_bot,
      content: content.slice(0, 500),
      timestamp: new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      platform: 'telegram',
      target: threadId ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`,
    });

    const labeledContent = isDm ? content : `[${userName}]: ${content}`;

    if (!trigger || !policy.respond) {
      this.agent.sessions.addMessage(sessionKey, 'user', labeledContent);
      this.log.debug(`[telegram] Observed in ${channelName} (no trigger)`);
      return;
    }

    const targetChatId = this._parseTarget(targetId).chatId;

    // Send typing indicator and keep it alive every 4s (Telegram expires it after ~5s)
    this._api('sendChatAction', { chat_id: targetChatId, action: 'typing' }).catch(() => {});
    const typingInterval = setInterval(() => {
      this._api('sendChatAction', { chat_id: targetChatId, action: 'typing' }).catch(() => {});
    }, 4000);

    let result;
    try {
      const agentOpts = {
        content: labeledContent,
        messageContent: labeledContent,
        media: mediaBlocks,
        channelId: targetId,
        channelName,
        sessionKey,
        userId,
        userName,
        guildName: 'Telegram',
        isDm,
        trigger,
        messageId: String(message.message_id),
        platform: 'telegram',
        sourceId: targetId,
        suppressLearning: !policy.learn,
      };
      result = this.agent._jobQueue?.submitAgentTurn
        ? await this.agent._jobQueue.submitAgentTurn(agentOpts, {
            lane: 'channel',
            priority: 85,
            route: 'telegram.message',
            allowInterjection: true,
          })
        : await this.agent.processMessage(agentOpts);
    } catch (e) {
      clearInterval(typingInterval);
      this.log.error(`[telegram] Agent error in ${channelName}: ${e.message}`);
      await this.sendMessage(targetId, "Sorry, I ran into an error and couldn't process that. Please try again.", null, { replyToMessageId: message.message_id });
      return;
    }
    clearInterval(typingInterval);

    if (result?.interjected) {
      this.log.info(`[telegram] Interjected follow-up into active session for ${channelName}`);
      return;
    }

    if (result?.text) {
      await this.sendMessage(targetId, result.text, null, { replyToMessageId: message.message_id });
      if (policy.shareToFeed) {
        feed.log({
          channelName: `telegram:${channelName}`,
          userName,
          userMessage: labeledContent,
          myResponse: result.text,
          trigger,
          usage: result.usage,
        });
      }
      this.log.info(`[telegram] Response in ${channelName} [${trigger}] (${result.iterations} iters)`);
    } else if (isDm || trigger === 'mention' || trigger === 'reply') {
      this.log.warn(`[telegram] No response for direct trigger in ${channelName} — sending fallback`);
      await this.sendMessage(targetId, "Sorry, I ran into an issue and couldn't generate a response. Please try again.", null, { replyToMessageId: message.message_id });
    }
  }

  async _extractMediaBlocks(message) {
    const blocks = [];
    const pushDownloaded = async ({ type, fileId, mimeType, filename, label }) => {
      if (!fileId) return;
      try {
        const { buffer, filePath } = await this._downloadFileWithMeta(fileId);
        const resolvedName = filename || path.basename(filePath) || `${label || type}-${Date.now()}`;
        const resolvedMime = this._guessTelegramMimeType(resolvedName, mimeType, type);
        blocks.push({
          type,
          source: {
            type: 'base64',
            media_type: resolvedMime,
            data: buffer.toString('base64'),
            filename: resolvedName,
          },
        });
        this.log.info(`[telegram] Downloaded ${type} attachment ${resolvedName} (${buffer.length} bytes, ${resolvedMime})`);
      } catch (e) {
        this.log.warn(`[telegram] Failed to download ${label || type} attachment: ${e.message}`);
      }
    };

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const best = message.photo[message.photo.length - 1];
      await pushDownloaded({
        type: 'image',
        fileId: best.file_id,
        mimeType: 'image/jpeg',
        filename: `telegram-photo-${best.file_unique_id || best.file_id}.jpg`,
        label: 'photo',
      });
    }

    if (message.video) {
      await pushDownloaded({
        type: 'video',
        fileId: message.video.file_id,
        mimeType: message.video.mime_type,
        filename: message.video.file_name || `telegram-video-${message.video.file_unique_id || message.video.file_id}`,
        label: 'video',
      });
    }

    if (message.animation) {
      await pushDownloaded({
        type: 'video',
        fileId: message.animation.file_id,
        mimeType: message.animation.mime_type,
        filename: message.animation.file_name || `telegram-animation-${message.animation.file_unique_id || message.animation.file_id}`,
        label: 'animation',
      });
    }

    if (message.document) {
      const docName = message.document.file_name || `telegram-document-${message.document.file_unique_id || message.document.file_id}`;
      await pushDownloaded({
        type: this._telegramMediaKind(docName, message.document.mime_type),
        fileId: message.document.file_id,
        mimeType: message.document.mime_type,
        filename: docName,
        label: 'document',
      });
    }

    return blocks;
  }

  _telegramMediaKind(filename = '', mimeType = '') {
    const lowerMime = String(mimeType || '').toLowerCase();
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (lowerMime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic'].includes(ext)) {
      return 'image';
    }
    if (lowerMime.startsWith('video/') || ['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
      return 'video';
    }
    if (lowerMime.startsWith('audio/') || ['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.flac', '.aac'].includes(ext)) {
      return 'audio';
    }
    return 'file';
  }

  _guessTelegramMimeType(filename = '', mimeType = '', type = 'file') {
    const lowerMime = String(mimeType || '').toLowerCase();
    if (lowerMime) return lowerMime;
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (TELEGRAM_MIME[ext]) return TELEGRAM_MIME[ext];
    if (type === 'image') return 'image/jpeg';
    if (type === 'video') return 'video/mp4';
    if (type === 'audio') return 'audio/mpeg';
    return 'application/octet-stream';
  }

  async _handleNewSession(message, targetId, channelName, sessionKey) {
    try {
      this.agent.sessions.clearSession(sessionKey);
      await this.sendMessage(targetId, '🔄 Session cleared. Starting fresh.', null, {
        replyToMessageId: message.message_id,
      });
      this.log.info(`[telegram] Session reset in ${channelName}`);
    } catch (e) {
      this.log.error(`[telegram] Session reset failed in ${channelName}: ${e.message}`);
      await this.sendMessage(targetId, 'Failed to reset session.', null, {
        replyToMessageId: message.message_id,
      });
    }
  }

  _getTriggerNames() {
    const names = [
      this.botUsername,
      ...(this.config.nicknames || []),
      this.config.displayName ? this.config.displayName.toLowerCase() : null,
      this.config.agentId,
    ].filter(Boolean).map(n => String(n).toLowerCase().trim());
    return [...new Set(names)];
  }

  _getTriggerType(message, content, isDm) {
    if (isDm) return 'dm';
    if (this.channelConfig.requireMention === false) return 'group';
    const lower = content.toLowerCase();
    if (this.botUsername && lower.includes(`@${this.botUsername}`)) return 'mention';
    if (message.reply_to_message?.from?.username?.toLowerCase() === this.botUsername) return 'reply';
    const triggers = this._getTriggerNames();
    if (triggers.some(t => lower.includes(t))) return 'name';
    return null;
  }

  async sendMessage(chatId, content, filePath = null, opts = {}) {
    const target = this._parseTarget(chatId);
    const baseFields = {
      chat_id: target.chatId,
      ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      ...(opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
    };

    if (filePath) {
      try {
        return await this._sendFile(target, content, filePath, baseFields);
      } catch (e) {
        this.log.error(`[telegram] File send failed (${filePath}): ${e.message}`);
        return { error: `File upload failed: ${e.message}` };
      }
    }

    const chunks = this._chunkText(
      content || '',
      this.channelConfig.textChunkLimit || this.config.maxMessageLength || 4000,
      this.channelConfig.chunkMode || 'length'
    );
    const messages = [];
    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        ...baseFields,
        text: this._formatTelegramHtml(chunks[i]),
        parse_mode: 'HTML',
      };
      if (i > 0) {
        delete payload.reply_to_message_id;
      }
      const data = await this._apiText('sendMessage', payload, 'text', chunks[i]);
      messages.push({
        messageId: String(data.result.message_id),
        channelId: String(data.result.chat.id),
        platform: 'telegram',
        target: `telegram:${data.result.chat.id}`,
      });
    }
    return { sent: messages.length, messages };
  }

  /**
   * Inject a scheduled/background prompt into a Telegram target. Used by
   * /api/proactive/trigger mode:"agent" when cron should produce a natural
   * agent response in the same Telegram DM, group, or topic that requested it.
   */
  injectProactivePrompt(chatId, context, topic) {
    const target = this._parseTarget(chatId);
    const targetId = target.threadId ? `${target.chatId}:topic:${target.threadId}` : target.chatId;
    const isDm = !String(target.chatId).startsWith('-');
    const userId = isDm ? String(target.chatId) : 'cron';
    const channelName = isDm ? 'telegram-dm' : `telegram:${target.chatId}`;
    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;

    setImmediate(async () => {
      try {
        this._api('sendChatAction', { chat_id: target.chatId, action: 'typing' }).catch(() => {});
        const agentOpts = {
          content: prompt,
          messageContent: prompt,
          channelId: targetId,
          channelName,
          sessionKey: this.agent.sessions.constructor.buildKey({
            platform: 'telegram',
            channelId: targetId,
            isDm,
            userId,
          }),
          userId,
          userName: 'Cron',
          guildName: 'Telegram',
          isDm,
          trigger: 'proactive',
          platform: 'telegram',
          sourceId: targetId,
          suppressLearning: true,
        };
        const result = this.agent._jobQueue?.submitAgentTurn
          ? await this.agent._jobQueue.submitAgentTurn(agentOpts, {
              lane: 'deferred',
              priority: 55,
              route: 'telegram.proactive',
              allowInterjection: false,
            })
          : await this.agent.processMessage(agentOpts);

        const text = result?.text;
        if (!text || text.trim() === 'NO_REPLY' || text.includes('NO_REPLY')) {
          this.log.info('[telegram] [proactive] Agent chose NO_REPLY');
          return;
        }
        await this.sendMessage(targetId, text);
        try {
          feed.log({
            channelName: `telegram:${channelName}`,
            userName: 'Cron',
            userMessage: prompt,
            myResponse: text,
            trigger: 'proactive',
          });
        } catch (e) { this.log.warn('[telegram] feed.log failed: ' + e.message); }
      } catch (e) {
        this.log.warn(`[telegram] [proactive] Failed for ${targetId}: ${e.message}`);
      }
    });
  }

  /**
   * Deliver a completed delegate_task result back into the same Telegram
   * chat/topic that launched it. Slack/Discord go through MessageQueue;
   * Telegram is direct, so it needs an explicit task-complete path.
   */
  injectTaskComplete(chatId, taskId, taskEntry) {
    const target = this._parseTarget(chatId);
    const targetId = target.threadId ? `${target.chatId}:topic:${target.threadId}` : target.chatId;
    const isDm = taskEntry?.isDm ?? !String(target.chatId).startsWith('-');
    const userId = taskEntry?.userId || (isDm ? String(target.chatId) : 'system');
    const channelName = taskEntry?.channelName || (isDm ? 'telegram-dm' : `telegram:${target.chatId}`);
    const elapsed = Math.round(((taskEntry?.completedAt || Date.now()) - (taskEntry?.startedAt || Date.now())) / 1000);
    const status = taskEntry?.status === 'done' ? 'completed successfully' : `failed: ${taskEntry?.result?.error || 'unknown error'}`;
    const resultSummary = taskEntry?.status === 'done' && taskEntry?.result?.result
      ? String(taskEntry.result.result).slice(0, 3000)
      : '';
    const usage = taskEntry?.result?.usage;
    const usageStr = usage ? ` (${usage.input_tokens}/${usage.output_tokens} tokens)` : '';
    const content = [
      `[BACKGROUND TASK ${status}]`,
      `Task ID: ${taskId}`,
      `Duration: ${elapsed}s${usageStr}`,
      resultSummary ? `\nResult:\n${resultSummary}` : '',
      '\nSummarize the outcome for the user concisely. If the task produced files, mention their paths.',
    ].filter(Boolean).join('\n');

    setImmediate(async () => {
      try {
        this._api('sendChatAction', { chat_id: target.chatId, action: 'typing' }).catch(() => {});
        const policy = resolveSourcePolicy(this.config, 'telegram', String(target.chatId));
        const agentOpts = {
          content,
          messageContent: content,
          channelId: targetId,
          channelName,
          sessionKey: taskEntry?.sessionKey || this.agent.sessions.constructor.buildKey({
            platform: 'telegram',
            channelId: targetId,
            isDm,
            userId,
            private: !!policy.private,
          }),
          userId,
          userName: taskEntry?.originalUserName || 'System',
          guildName: 'Telegram',
          isDm,
          trigger: 'task_complete',
          platform: 'telegram',
          sourceId: targetId,
          suppressLearning: true,
        };
        const result = this.agent._jobQueue?.submitAgentTurn
          ? await this.agent._jobQueue.submitAgentTurn(agentOpts, {
              lane: 'channel',
              priority: 80,
              route: 'telegram.task_complete',
              allowInterjection: false,
            })
          : await this.agent.processMessage(agentOpts);

        if (result?.text && result.text.trim() !== 'NO_REPLY' && !result.text.includes('NO_REPLY')) {
          await this.sendMessage(targetId, result.text);
        }
        this.log.info(`[telegram] [task-deliver] Delivered result for ${taskId} in ${channelName}`);
      } catch (e) {
        this.log.warn(`[telegram] [task-deliver] Failed for ${taskId}: ${e.message}`);
      }
    });
  }

  async _sendFile(target, caption, filePath, baseFields) {
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }

    const ext = path.extname(filePath).toLowerCase();
    const IMAGE_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const ANIM_EXTS   = new Set(['.gif']);
    const VIDEO_EXTS  = new Set(['.mp4', '.avi', '.mov', '.mkv']);
    const AUDIO_EXTS  = new Set(['.mp3', '.m4a', '.ogg', '.oga', '.flac', '.wav']);

    let method, fileField;
    if (IMAGE_EXTS.has(ext))  { method = 'sendPhoto';     fileField = 'photo'; }
    else if (ANIM_EXTS.has(ext))  { method = 'sendAnimation'; fileField = 'animation'; }
    else if (VIDEO_EXTS.has(ext)) { method = 'sendVideo';     fileField = 'video'; }
    else if (AUDIO_EXTS.has(ext)) { method = 'sendAudio';     fileField = 'audio'; }
    else                          { method = 'sendDocument';  fileField = 'document'; }

    const fields = { ...baseFields };
    const rawCaption = caption ? caption.slice(0, 1024) : '';
    if (rawCaption) {
      fields.caption = this._formatTelegramHtml(rawCaption);
      fields.parse_mode = 'HTML';
    }

    let data;
    try {
      data = await this._apiMultipart(method, fields, fileField, filePath);
    } catch (e) {
      if (!rawCaption) throw e;
      this.log.warn(`[telegram] ${method} HTML caption failed, falling back to plain text: ${e.message}`);
      const fallbackFields = { ...baseFields, caption: rawCaption };
      data = await this._apiMultipart(method, fallbackFields, fileField, filePath);
    }
    return {
      sent: 1,
      messages: [{
        messageId: String(data.result.message_id),
        channelId: String(data.result.chat.id),
        platform: 'telegram',
        target: `telegram:${data.result.chat.id}`,
      }],
    };
  }

  async _apiMultipart(method, fields, fileField, filePath) {
    const boundary = `----TGBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = TELEGRAM_MIME[ext] || 'application/octet-stream';
    const fileData = fs.readFileSync(filePath);

    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ));
    }
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const req = https.request(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode >= 400 || parsed.ok === false) {
              return reject(new Error(parsed.description || `Telegram API error ${res.statusCode}`));
            }
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async readMessages(chatId, limit = 10) {
    const target = this._parseTarget(chatId);
    const list = (this.recentMessages.get(String(target.key)) || []).slice(-Math.min(limit, 50));
    return { messages: list, count: list.length };
  }

  async reactToMessage(chatId, messageId, emoji) {
    try {
      const target = this._parseTarget(chatId);
      await this._api('setMessageReaction', {
        chat_id: target.chatId,
        message_id: Number(messageId),
        reaction: [{ type: 'emoji', emoji }],
        is_big: false,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async editMessage(chatId, messageId, content) {
    try {
      const target = this._parseTarget(chatId);
      await this._apiText('editMessageText', {
        chat_id: target.chatId,
        message_id: Number(messageId),
        text: this._formatTelegramHtml(content),
        parse_mode: 'HTML',
      }, 'text', content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  _rememberMessage(chatId, message) {
    const key = String(chatId);
    const list = this.recentMessages.get(key) || [];
    list.push(message);
    this.recentMessages.set(key, list.slice(-50));
  }

  async handleWebhook(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    const expectedSecret = this.channelConfig.webhookSecret;
    if (!expectedSecret) {
      this.log.error('[telegram] Webhook secret not configured — rejecting all webhook requests');
      res.writeHead(403);
      res.end('Forbidden: webhookSecret required');
      return;
    }
    const secret = req.headers['x-telegram-bot-api-secret-token'] || '';
    if (secret.length !== expectedSecret.length ||
        !require('crypto').timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.message) await this._handleMessage(payload.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        this.log.warn('[telegram] Webhook error:', e.message);
        res.writeHead(500);
        res.end('error');
      }
    });
  }

  async handleHttp(req, res, url) {
    const webhookPath = this.channelConfig.webhookPath || '/webhooks/telegram';
    if (url.pathname !== webhookPath) return false;
    await this.handleWebhook(req, res);
    return true;
  }

  // ─── Voice Note Handling ──────────────────────────────────────────────

  async _handleVoiceMessage(message, chatId, isDm, threadId) {
    const voiceObj = message.voice || message.audio;
    const userId = String(message.from?.id || chatId);
    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
      || message.from?.username
      || `telegram:${userId}`;
    const channelName = message.chat.title || message.chat.username || (isDm ? 'telegram-dm' : `telegram:${chatId}`);

    const trigger = this._getTriggerType(message, '[voice message]', isDm);
    const policy = resolveSourcePolicy(this.config, 'telegram', chatId);

    if (!this._isAllowed(message, isDm, trigger)) {
      await this._handleRejectedMessage(message, isDm, chatId, userId);
      return;
    }

    if (!trigger && !isDm) {
      this.log.debug(`[telegram] Voice note in ${channelName} — no trigger, ignoring`);
      return;
    }

    const pipeline = this._ensureVoicePipeline();
    if (!pipeline) {
      this.log.info(`[telegram] Voice note from ${userName} but voice pipeline not configured`);
      await this.sendMessage(
        threadId ? `${chatId}:topic:${threadId}` : chatId,
        'I received your voice message but voice processing is not configured. Please send a text message instead.',
        null,
        { replyToMessageId: message.message_id },
      );
      return;
    }

    // Download the voice file
    let audioBuffer;
    try {
      audioBuffer = await this._downloadFile(voiceObj.file_id);
    } catch (e) {
      this.log.error(`[telegram] Voice download failed: ${e.message}`);
      await this.sendMessage(
        threadId ? `${chatId}:topic:${threadId}` : chatId,
        'Sorry, I couldn\'t download your voice message.',
        null,
        { replyToMessageId: message.message_id },
      );
      return;
    }

    const mimeType = voiceObj.mime_type || 'audio/ogg';
    this.log.info(`[telegram] Voice note from ${userName} (${audioBuffer.length} bytes, ${voiceObj.duration}s)`);

    const targetId = threadId ? `${chatId}:topic:${threadId}` : chatId;

    // Run the full voice pipeline: STT → agent → TTS
    const result = await pipeline.process(audioBuffer, mimeType, this.agent, {
      channelId: targetId,
      channelName,
      userId,
      userName,
      guildName: 'Telegram',
      isDm,
      trigger: trigger || 'voice',
      platform: 'telegram',
      sourceId: targetId,
      suppressLearning: !policy.learn,
    });

    if (result.error) {
      this.log.warn(`[telegram] Voice pipeline error: ${result.error}`);
      if (result.transcription) {
        // STT worked but something else failed — at least process as text
        await this.sendMessage(targetId, `(I heard: "${result.transcription}")\n\n${result.error}`, null, {
          replyToMessageId: message.message_id,
        });
      }
      return;
    }

    if (!result.transcription || !result.transcription.trim()) {
      this.log.debug(`[telegram] Empty transcription from voice note`);
      return;
    }

    // Send voice response if we have audio, otherwise fall back to text
    if (result.audioBuffer && result.responseText) {
      await this._sendVoiceNote(targetId, result.audioBuffer, {
        caption: result.responseText.length > 1024 ? result.responseText.slice(0, 1021) + '...' : result.responseText,
        replyToMessageId: message.message_id,
        threadId,
      });

      if (policy.shareToFeed) {
        feed.log({
          channelName: `telegram:${channelName}`,
          userName,
          userMessage: `[Voice: ${result.transcription}]`,
          myResponse: result.responseText,
          trigger: trigger || 'voice',
        });
      }
      this.log.info(`[telegram] Voice response in ${channelName} (${result.audioBuffer.length} bytes audio)`);
    } else if (result.responseText) {
      // TTS failed but we have text — send as text
      await this.sendMessage(targetId, result.responseText, null, {
        replyToMessageId: message.message_id,
      });
      this.log.info(`[telegram] Text fallback response in ${channelName} (TTS unavailable)`);
    }
  }

  /**
   * Download a file from Telegram by file_id.
   * @returns {Promise<Buffer>}
   */
  async _downloadFile(fileId) {
    const { buffer } = await this._downloadFileWithMeta(fileId);
    return buffer;
  }

  async _downloadFileWithMeta(fileId) {
    const fileInfo = await this._api('getFile', { file_id: fileId });
    const filePath = fileInfo.result?.file_path;
    if (!filePath) throw new Error('No file_path in getFile response');

    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), filePath }));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Send a voice note via Telegram's sendVoice API (multipart form data).
   */
  async _sendVoiceNote(chatId, audioBuffer, opts = {}) {
    const target = this._parseTarget(chatId);
    const boundary = '----VoiceBoundary' + Date.now();
    const parts = [];

    const addField = (name, value) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };

    addField('chat_id', target.chatId);
    if (target.threadId) addField('message_thread_id', target.threadId);
    if (opts.replyToMessageId) addField('reply_to_message_id', opts.replyToMessageId);
    const rawCaption = opts.caption ? String(opts.caption).slice(0, 1024) : '';
    if (rawCaption) {
      addField('caption', opts._plainCaption ? rawCaption : this._formatTelegramHtml(rawCaption));
      if (!opts._plainCaption) addField('parse_mode', 'HTML');
    }

    // The voice file
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(`${this.baseUrl}/sendVoice`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data || '{}');
              if (res.statusCode >= 400 || parsed.ok === false) {
                this.log.warn(`[telegram] sendVoice failed: ${parsed.description || res.statusCode}`);
                return reject(new Error(parsed.description || `sendVoice ${res.statusCode}`));
              }
              resolve(parsed);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (e) {
      if (!rawCaption || opts._plainCaption) throw e;
      this.log.warn(`[telegram] sendVoice HTML caption failed, falling back to plain text: ${e.message}`);
      return this._sendVoiceNote(chatId, audioBuffer, { ...opts, caption: rawCaption, _plainCaption: true });
    }
  }

  // ─── End Voice ───────────────────────────────────────────────────────

  _chunkText(text, maxLen, chunkMode = 'length') {
    if (chunkMode === 'newline') {
      return text.split('\n').filter(Boolean).flatMap(line => line.length <= maxLen ? [line] : this._chunkText(line, maxLen, 'length'));
    }
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let breakPoint = remaining.lastIndexOf('\n\n', maxLen);
      if (breakPoint < maxLen * 0.3) breakPoint = remaining.lastIndexOf('\n', maxLen);
      if (breakPoint < maxLen * 0.3) breakPoint = remaining.lastIndexOf(' ', maxLen);
      if (breakPoint < maxLen * 0.3) breakPoint = maxLen;
      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }
    return chunks;
  }

  _escapeTelegramHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _formatTelegramHtml(text) {
    const lines = String(text || '').split(/\r?\n/);
    const rendered = [];
    let inCodeBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) {
        rendered.push(inCodeBlock ? '</pre>' : '<pre>');
        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) {
        rendered.push(this._escapeTelegramHtml(line));
        continue;
      }

      let html = this._escapeTelegramHtml(line);
      html = html.replace(/^#{1,6}\s+(.+)$/u, '<b>$1</b>');
      html = html.replace(/^(\s*)[-*]\s+/u, '$1• ');
      html = html.replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>');
      html = html.replace(/__([^_\n]+)__/gu, '<b>$1</b>');
      html = html.replace(/`([^`\n]+)`/gu, '<code>$1</code>');
      rendered.push(html);
    }

    if (inCodeBlock) {
      rendered.push('</pre>');
    }
    return rendered.join('\n');
  }

  async _apiText(method, payload, textField, plainText) {
    try {
      return await this._api(method, payload);
    } catch (e) {
      if (!payload.parse_mode) throw e;
      this.log.warn(`[telegram] ${method} HTML formatting failed, falling back to plain text: ${e.message}`);
      const fallback = { ...payload, [textField]: plainText };
      delete fallback.parse_mode;
      return this._api(method, fallback);
    }
  }

  _parseTarget(raw) {
    const value = String(raw || '').replace(/^telegram:/i, '');
    const explicitTopic = /^(.+?):topic:(\d+)$/.exec(value);
    if (explicitTopic) {
      return { chatId: explicitTopic[1], threadId: explicitTopic[2], key: `${explicitTopic[1]}:topic:${explicitTopic[2]}` };
    }
    const colonTopic = /^(.+):(\d+)$/.exec(value);
    if (colonTopic && String(colonTopic[1]).startsWith('-')) {
      return { chatId: colonTopic[1], threadId: colonTopic[2], key: `${colonTopic[1]}:topic:${colonTopic[2]}` };
    }
    return { chatId: value, threadId: null, key: value };
  }

  _isAllowed(message, isDm, trigger) {
    const sender = String(message.from?.id || '');

    if (isDm) {
      const dmPolicy = this.channelConfig.dmPolicy || 'pairing';
      const allowFrom = new Set((this.channelConfig.allowFrom || []).map(v => String(v)));
      if (dmPolicy === 'disabled') return false;
      if (dmPolicy === 'open') return true;
      if (allowFrom.has('*') || allowFrom.has(sender)) return true;
      // Check dynamic pairing store
      if (this.pairing?.isApproved('telegram', sender)) return true;
      if (dmPolicy === 'allowlist') return false;
      // pairing mode — handled by _handleRejectedMessage
      return false;
    }

    const groupPolicy = this.channelConfig.groupPolicy || 'open';
    const groupAllowFrom = new Set([...(this.channelConfig.groupAllowFrom || []), ...(this.channelConfig.allowFrom || [])].map(v => String(v)));
    if (groupPolicy === 'disabled') return false;
    if (groupPolicy === 'allowlist' && !groupAllowFrom.has('*') && !groupAllowFrom.has(sender)) return false;
    if (this.channelConfig.requireMention !== false && !trigger) return false;
    return true;
  }

  async _handleRejectedMessage(message, isDm, chatId, userId) {
    if (!isDm) return;
    const dmPolicy = this.channelConfig.dmPolicy || 'pairing';
    if (dmPolicy !== 'pairing') return;

    if (this.pairing) {
      const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ')
        || message.from?.username || null;
      const { code, created } = this.pairing.upsertRequest('telegram', userId, { name, username: message.from?.username });
      if (created) {
        const displayName = this.config.displayName || 'This bot';
        try {
          await this.sendMessage(chatId,
            `Hi! I'm ${displayName}. I require owner approval before I can respond to you.\n\n` +
            `Your pairing code is:\n\n  ${code}\n\n` +
            `Share this code with the bot owner to get access.`
          );
        } catch (e) { this.log.warn('[telegram] this.sendMessage failed: ' + e.message); }
        this.log.info(`[telegram] Pairing request from ${name || userId} — code: ${code}`);
      }
      return;
    }

    // Fallback (no pairing store)
    if (this.pendingDmApprovals.has(userId)) return;
    // Cap at 1000 entries (insertion-order eviction) — prevents unbounded
    // growth across many users hitting the no-pairing-store fallback path.
    if (this.pendingDmApprovals.size >= 1000) {
      this.pendingDmApprovals.delete(this.pendingDmApprovals.values().next().value);
    }
    this.pendingDmApprovals.add(userId);
    try {
      await this.sendMessage(chatId, 'This bot is in pairing mode. Ask the owner to add your Telegram user ID to `channels.telegram.allowFrom` or switch `dmPolicy` to `open`.');
    } catch (e) { this.log.warn('[telegram] this.sendMessage failed: ' + e.message); }
  }

  _api(method, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode >= 400 || parsed.ok === false) {
              return reject(new Error(parsed.description || `Telegram API ${res.statusCode}`));
            }
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { TelegramGateway };
