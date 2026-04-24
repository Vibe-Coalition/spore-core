/**
 * sessions.js — Session Manager
 * 
 * SQLite-backed conversation history per channel/user.
 * Handles context window limits with compaction.
 * 
 * Session key format:
 *   channel:{channelId}  — guild channel sessions
 *   dm:{userId}          — direct message sessions
 * 
 * PERF PATCHES (2026-03-20):
 *   - Enforce maxSessionMessages on every insert (trim oldest immediately)
 *   - Truncate consumed tool results after model has processed them
 */

const graphEvents = require('../graph/events');

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class SessionManager {
  constructor(config, logger, learner) {
    this.config = config;
    this.log = logger;
    this.learner = learner || null;
    this.db = null;
  }
  
  /**
   * Initialize session database
   */
  init() {
    try {
      this.db = new DatabaseSync(this.config.sessionDbPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this._ensureSchema();
      this.log.info(`Session manager initialized at ${this.config.sessionDbPath}`);
      return true;
    } catch (e) {
      this.log.error('Failed to initialize session database:', e.message);
      return false;
    }
  }
  
  /**
   * Create schema if needed
   */
  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use_id TEXT,
        tool_name TEXT,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_key) REFERENCES sessions(key)
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created);
            CREATE TABLE IF NOT EXISTS session_lineage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        compacted_from TEXT,
        FOREIGN KEY (session_key) REFERENCES sessions(key)
      );
      
      CREATE INDEX IF NOT EXISTS idx_lineage_session ON session_lineage(session_key);
      CREATE INDEX IF NOT EXISTS idx_lineage_compacted ON session_lineage(compacted_from);

      CREATE TABLE IF NOT EXISTS wakeups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        channel_id  TEXT,
        channel_name TEXT,
        user_id     TEXT,
        user_name   TEXT,
        platform    TEXT,
        is_dm       INTEGER NOT NULL DEFAULT 1,
        fire_at     INTEGER NOT NULL,
        prompt      TEXT NOT NULL,
        reason      TEXT,
        created     INTEGER NOT NULL,
        fired       INTEGER NOT NULL DEFAULT 0,
        fired_at    INTEGER,
        failed      INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wakeups_fire_at ON wakeups(fire_at, fired);

      CREATE TABLE IF NOT EXISTS tasks (
        id           TEXT PRIMARY KEY,
        subject      TEXT NOT NULL,
        description  TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        owner        TEXT,
        blocked_by   TEXT,
        result       TEXT,
        channel_id   TEXT,
        session_key  TEXT,
        user_id      TEXT,
        priority     INTEGER NOT NULL DEFAULT 3,
        created      INTEGER NOT NULL,
        updated      INTEGER NOT NULL,
        completed    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key);

      CREATE TABLE IF NOT EXISTS task_comments (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id  TEXT NOT NULL,
        author   TEXT NOT NULL,
        body     TEXT NOT NULL,
        created  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

      CREATE TABLE IF NOT EXISTS plan_proposals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        sequence    INTEGER NOT NULL,
        tool        TEXT NOT NULL,
        input       TEXT NOT NULL,
        summary     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        result      TEXT,
        error       TEXT,
        created     INTEGER NOT NULL,
        applied_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_plan_proposals_session ON plan_proposals(session_key, status);
    `);

    // Backward-compatible column add for plan_mode on sessions.
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!cols.some(c => c.name === 'plan_mode')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0");
    }
  }
  
  /**
   * Build a session key.
   * Backwards compatible forms:
   *   buildKey(channelId, isDm, userId)                // legacy Discord-style
   *   buildKey({ platform, channelId, isDm, userId })  // multi-platform
   */
  static buildKey(channelIdOrOpts, isDm = false, userId = null) {
    if (channelIdOrOpts && typeof channelIdOrOpts === 'object') {
      const {
        platform = 'discord',
        channelId = null,
        isDm: objectIsDm = false,
        userId: objectUserId = null,
        private: isPrivate = false,
      } = channelIdOrOpts;
      const scope = isPrivate ? 'private' : 'shared';
      if (objectIsDm && objectUserId) return `${scope}:dm:${platform}:${objectUserId}`;
      return `${scope}:channel:${platform}:${channelId}`;
    }

    if (isDm && userId) return `dm:${userId}`;
    return `channel:${channelIdOrOpts}`;
  }
  
  /**
   * Ensure a session exists
   */
  ensureSession(key) {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (key) VALUES (?)
    `).run(key);
    
    this.db.prepare(`
      UPDATE sessions SET updated = CURRENT_TIMESTAMP WHERE key = ?
    `).run(key);
  }
  
  /**
   * Add a message to a session
   */
  addMessage(key, role, content, toolUseId = null, toolName = null) {
    this.ensureSession(key);
    
    let contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    // Save large user messages as durable artifacts that survive session compaction
    const ARTIFACT_THRESHOLD = 3000;
    if (role === 'user' && typeof content === 'string' && contentStr.length > ARTIFACT_THRESHOLD) {
      try {
        const artifactDir = path.join(this.config.dataDir, 'artifacts');
        fs.mkdirSync(artifactDir, { recursive: true });
        const hash = crypto.createHash('sha256').update(contentStr).digest('hex').slice(0, 8);
        const filename = `${Date.now()}-${hash}.txt`;
        const artifactPath = path.join(artifactDir, filename);
        fs.writeFileSync(artifactPath, contentStr);
        contentStr = `[Full content saved to ${artifactPath} (${contentStr.length.toLocaleString()} chars)]\n\n${contentStr}`;
        this.log.info(`[session] Saved large user message as artifact: ${artifactPath} (${content.length} chars)`);
      } catch (e) {
        this.log.warn(`[session] Failed to save artifact: ${e.message}`);
      }
    }

    // Don't persist 'NO_REPLY' assistant messages. Storing them
    // pollutes the conversation history (every refresh shows the
    // pair, every chat:history-request replays it into the client),
    // and they're not useful as context for future turns — the
    // agent already knows it chose not to reply. The decision and
    // reason are still captured by the [loop-noreply] log line.
    if (role === 'assistant' && typeof contentStr === 'string') {
      const stripped = contentStr.trim();
      if (stripped === 'NO_REPLY' || stripped === '') {
        this.log.debug(`[session] Skipping NO_REPLY persistence for ${key}`);
        return;
      }
    }

    this.db.prepare(`
      INSERT INTO messages (session_key, role, content, tool_use_id, tool_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, role, contentStr, toolUseId, toolName);

    graphEvents.emit('message:added', { sessionKey: key, role, content: contentStr, timestamp: new Date().toISOString() });

    // PERF: Enforce maxSessionMessages on every insert — trim oldest immediately
    // This prevents unbounded session growth between compaction cycles
    const maxMessages = this.config.maxSessionMessages || 50;
    const count = this.getMessageCount(key);
    if (count > maxMessages) {
      const excess = count - maxMessages;
      this.db.prepare(`
        DELETE FROM messages WHERE id IN (
          SELECT id FROM messages WHERE session_key = ? ORDER BY id ASC LIMIT ?
        )
      `).run(key, excess);
      this.log.debug(`[session-trim] Trimmed ${excess} oldest messages from ${key} (${count} → ${maxMessages})`);
    }
    
    // Token-aware compaction: estimate session tokens and compact when needed.
    // Runs async to avoid blocking the tool execution loop.
    const tokenThreshold = this.config.compactTokenThreshold || 80000;
    const sessionTokens = this._estimateSessionTokens(key);
    if (sessionTokens > tokenThreshold && !this._compacting?.has(key)) {
      if (!this._compacting) this._compacting = new Set();
      this._compacting.add(key);
      Promise.resolve().then(() => {
        try { this._compact(key); }
        catch (e) { this.log.warn(`[compact] Error compacting ${key}: ${e.message}`); }
        finally { this._compacting.delete(key); }
      });
    }
  }

  /**
   * Remove the most recent user message from a session.
   * Used to clean up synthetic prompts (lull, proactive) that got NO_REPLY,
   * preventing them from contaminating future conversations via message merging.
   */
  removeLastUserMessage(key) {
    const row = this.db.prepare(`
      SELECT id FROM messages
      WHERE session_key = ? AND role = 'user'
      ORDER BY id DESC LIMIT 1
    `).get(key);
    if (row) {
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
    }
  }

  /**
   * Remove the most recent assistant message from a session iff it's
   * literally 'NO_REPLY'. Belt-and-braces cleanup: the addMessage
   * filter should already prevent these from being stored at all,
   * but this catches any that slipped through (or were stored before
   * the filter landed).
   */
  removeLastAssistantNoReply(key) {
    const row = this.db.prepare(`
      SELECT id, content FROM messages
      WHERE session_key = ? AND role = 'assistant'
      ORDER BY id DESC LIMIT 1
    `).get(key);
    if (row && typeof row.content === 'string' && row.content.trim() === 'NO_REPLY') {
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
    }
  }

  /**
   * Truncate consumed tool results in session history.
   * After the model has seen and responded to tool results, replace large
   * tool_result content with a short summary to save tokens on future calls.
   * Call this after each successful agent iteration that consumed tool results.
   */
  truncateConsumedToolResults(key, maxResultLength = 200) {
    const rows = this.db.prepare(`
      SELECT id, content FROM messages 
      WHERE session_key = ? AND role = 'user'
      ORDER BY id ASC
    `).all(key);

    // Don't truncate the last user message — model may not have consumed it yet
    const toCheck = rows.slice(0, -1);
    let truncated = 0;

    for (const row of toCheck) {
      try {
        const parsed = JSON.parse(row.content);
        if (!Array.isArray(parsed)) continue;

        let changed = false;
        const updated = parsed.map(block => {
          if (block.type !== 'tool_result') return block;
          if (typeof block.content !== 'string') return block;
          if (block.content.length <= maxResultLength) return block;

          changed = true;
          // Keep first N chars as summary
          const summary = block.content.substring(0, maxResultLength) + '... [truncated, was ' + block.content.length + ' chars]';
          return { ...block, content: summary };
        });

        if (changed) {
          this.db.prepare('UPDATE messages SET content = ? WHERE id = ?')
            .run(JSON.stringify(updated), row.id);
          truncated++;
        }
      } catch {
        // Not JSON or not structured — skip
      }
    }

    if (truncated > 0) {
      this.log.debug(`[tool-truncate] Truncated ${truncated} consumed tool results in ${key}`);
    }
    return truncated;
  }
  
  /**
   * Get conversation history for a session, formatted for the Anthropic API
   */
  getHistory(key, limit = null) {
    const maxMessages = limit || this.config.maxSessionMessages;
    
    const rows = this.db.prepare(`
      SELECT role, content, tool_use_id, tool_name, created
      FROM messages
      WHERE session_key = ? AND role IN ('user', 'assistant')
      ORDER BY id DESC
      LIMIT ?
    `).all(key, maxMessages);
    
    // Reverse to chronological order
    rows.reverse();
    
    const messages = rows.map(row => {
      const msg = { role: row.role };
      
      // Try to parse structured content
      try {
        const parsed = JSON.parse(row.content);
        if (Array.isArray(parsed)) {
          msg.content = parsed;
        } else if (typeof parsed === 'object' && parsed.type) {
          msg.content = [parsed];
        } else {
          msg.content = row.content;
        }
      } catch {
        msg.content = row.content;
      }
      
      return msg;
    });

    // Validate tool_use/tool_result pairing — orphaned results crash the API
    return this._validateToolPairing(messages);
  }

  /**
   * Remove orphaned tool_result messages that lack a matching tool_use.
   * This happens when LIMIT truncation cuts between an assistant tool_use
   * and its user tool_result, or when sessions get corrupted.
   */
  _validateToolPairing(messages) {
    // Pass 1: collect all tool_use IDs and all tool_result IDs
    const toolUseIds = new Set();
    const toolResultIds = new Set();
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') toolUseIds.add(block.id);
          if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
        }
      }
    }

    // Pass 2: filter out orphaned blocks in both directions
    const cleaned = [];
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        const validBlocks = msg.content.filter(block => {
          // Remove tool_results whose tool_use was lost
          if (block.type === 'tool_result') return toolUseIds.has(block.tool_use_id);
          // Remove tool_uses whose tool_result was lost
          if (block.type === 'tool_use') return toolResultIds.has(block.id);
          return true;
        });
        if (validBlocks.length === 0) continue;
        cleaned.push({ ...msg, content: validBlocks });
      } else {
        cleaned.push(msg);
      }
    }

    // Ensure history starts with a user message (API requirement)
    while (cleaned.length > 0 && cleaned[0].role !== 'user') {
      cleaned.shift();
    }

    // Ensure strict user/assistant alternation — drop consecutive same-role messages
    const alternated = [];
    for (const msg of cleaned) {
      if (alternated.length > 0 && alternated[alternated.length - 1].role === msg.role) {
        // Merge or skip depending on role
        if (msg.role === 'user' && typeof msg.content === 'string') {
          const prev = alternated[alternated.length - 1];
          if (typeof prev.content === 'string') {
            prev.content += '\n' + msg.content;
            continue;
          }
        }
        // For structured content or assistant messages, skip the orphan
        continue;
      }
      alternated.push(msg);
    }

    return alternated;
  }
  
  /**
   * Get message count for a session
   */
  getMessageCount(key) {
    const row = this.db.prepare(`
      SELECT count(*) as c FROM messages WHERE session_key = ?
    `).get(key);
    return row?.c || 0;
  }
  
  /**
   * Clear a session's history
   */
  clearSession(key) {
    this.db.prepare('DELETE FROM messages WHERE session_key = ?').run(key);
    this.log.info(`Cleared session: ${key}`);
  }

  /**
   * Replace a session's history with the provided messages array.
   * Used after abort to trim partial tool results.
   */
  setMessages(key, messages) {
    const insert = this.db.prepare(`
      INSERT INTO messages (session_key, role, content) VALUES (?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_key = ?').run(key);
      for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        insert.run(key, msg.role, content);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  
  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  }

  _estimateSessionTokens(key) {
    const row = this.db.prepare(
      'SELECT SUM(LENGTH(content)) as total_chars FROM messages WHERE session_key = ?'
    ).get(key);
    return Math.ceil((row?.total_chars || 0) / 3.5);
  }

  /**
   * Compact a session: protect first 2 messages + last N messages,
   * extract knowledge from discarded messages, then LLM-summarize them.
   */
  _compact(key) {
    const allMessages = this.db.prepare(
      'SELECT id, role, content FROM messages WHERE session_key = ? ORDER BY id ASC'
    ).all(key);

    if (allMessages.length <= 6) return;

    const protectHead = Math.min(2, allMessages.length);
    const keepTailCount = this.config.compactKeepTail || 20;
    let protectTail = Math.min(keepTailCount, allMessages.length - protectHead);

    // Adjust boundaries so we never split a tool_use/tool_result pair.
    const _hasToolUse = (msg) => {
      try {
        const p = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        return Array.isArray(p) && p.some(b => b.type === 'tool_use');
      } catch { return false; }
    };
    const _hasToolResult = (msg) => {
      try {
        const p = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        return Array.isArray(p) && p.some(b => b.type === 'tool_result');
      } catch { return false; }
    };

    // Head side: if last head message has tool_use, pull its tool_result in too
    let headEnd = protectHead;
    while (headEnd < allMessages.length - 2 && _hasToolUse(allMessages[headEnd - 1])) {
      headEnd++;
      if (!_hasToolResult(allMessages[headEnd - 1])) continue;
      break;
    }

    // Tail side: walk the cut point back until the first tail message isn't an orphaned tool_result
    let cutIdx = allMessages.length - protectTail;
    if (cutIdx < headEnd) cutIdx = headEnd;
    while (cutIdx > headEnd && cutIdx < allMessages.length) {
      const msg = allMessages[cutIdx];
      if (msg.role === 'user' && _hasToolResult(msg)) {
        cutIdx--;
      } else {
        break;
      }
    }

    const head = allMessages.slice(0, headEnd);
    const toRemove = allMessages.slice(headEnd, cutIdx);
    const tail = allMessages.slice(cutIdx);

    if (toRemove.length === 0) return;

    this.log.info(`Compacting ${key}: ${allMessages.length} msgs, removing ${toRemove.length}, keeping ${head.length}+${tail.length}`);

    // Pre-compaction knowledge flush — extract facts before discarding
    if (this.learner) {
      const exchange = toRemove.map(m => {
        const c = typeof m.content === 'string' ? m.content : '[structured]';
        const limit = m.role === 'user' ? 2000 : 500;
        return `${m.role}: ${c.substring(0, limit)}`;
      }).join('\n');
      this.learner.extractAndLearn(exchange, null, {})
        .catch(e => this.log.error('[compaction] Pre-flush extraction error:', e.message));
    }

    // Retrieve previous summary for iterative update
    if (!this._compactionSummaries) this._compactionSummaries = new Map();
    const previousSummary = this._compactionSummaries.get(key) || null;

    const summaryPromise = this.learner
      ? this.learner.summarizeForCompaction(toRemove, previousSummary)
      : Promise.resolve(this._fallbackSummary(toRemove));

    const placeholderRow = this.db.prepare(
      `INSERT INTO messages (session_key, role, content) VALUES (?, 'user', ?)`
    ).run(key, `[Compacting ${toRemove.length} messages...]`);
    const summaryRowId = placeholderRow.lastInsertRowid;

    const idsToRemove = toRemove.map(m => m.id);
    if (idsToRemove.length > 0) {
      const placeholders = idsToRemove.map(() => '?').join(',');
      this.db.prepare(
        `DELETE FROM messages WHERE session_key = ? AND id IN (${placeholders})`
      ).run(key, ...idsToRemove);
    }

    summaryPromise.then(summary => {
      if (summary) {
        this._compactionSummaries.set(key, summary);
        this.db.prepare(`UPDATE messages SET content = ? WHERE id = ?`)
          .run(`[CONTEXT COMPACTION — ${toRemove.length} earlier turns compacted]\n${summary}\n[END CONTEXT COMPACTION]`, summaryRowId);
      } else {
        this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(summaryRowId);
      }
    }).catch(e => {
      this.log.error('[compaction] Summary injection failed:', e.message);
      this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(summaryRowId);
    });
  }

  _fallbackSummary(messages) {
    if (!messages || messages.length === 0) return null;
    const topics = new Set();
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const snippet = content.substring(0, 120).trim();
      if (snippet) topics.add(snippet);
    }
    return `${messages.length} messages compacted. Topics: ${[...topics].slice(0, 5).join('; ')}`;
  }
  
  /**
   * Get session metadata
   */
  getSessionMeta(key) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
    if (!row) return null;
    
    return {
      key: row.key,
      created: row.created,
      updated: row.updated,
      metadata: JSON.parse(row.metadata || '{}'),
      messageCount: this.getMessageCount(key),
    };
  }
  
  /**
   * Update session metadata
   */
  setSessionMeta(key, metadata) {
    this.ensureSession(key);
    this.db.prepare(`
      UPDATE sessions SET metadata = ?, updated = CURRENT_TIMESTAMP WHERE key = ?
    `).run(JSON.stringify(metadata), key);
  }
  
  /**
   * List all active sessions
   */
  listSessions() {
    return this.db.prepare(`
      SELECT s.key, s.created, s.updated, 
             (SELECT count(*) FROM messages m WHERE m.session_key = s.key) as message_count
      FROM sessions s
      ORDER BY s.updated DESC
    `).all();
  }
  
  /**
   * Reset sessions that are stale (idle timeout or daily reset).
   * Called by the heartbeat timer.
   */
  cleanupStaleSessions() {
    const idleMinutes = this.config.sessionIdleTimeoutMinutes || 60;
    const dailyResetHour = this.config.sessionDailyResetHour ?? 4; // 4am UTC

    let cleaned = 0;

    // Idle timeout: clear group channel sessions idle longer than threshold.
    //
    // EXCLUDES channel:cli:* — those are acorn-cli sessions, bounded by
    // the CLI's own lifetime and a stable WS connection. The user
    // stepping away from a coding session for 60+ minutes is normal
    // (lunch, meeting, sleep); wiping their conversation under them
    // produces the dreaded 'what's "4"?' moment when they come back
    // to a numbered list and reply with one digit. acorn manages its
    // own session lifecycle via /new and /clear.
    const idleSessions = this.db.prepare(`
      SELECT key FROM sessions
      WHERE key LIKE 'channel:%'
        AND key NOT LIKE 'channel:cli:%'
        AND updated < datetime('now', '-${idleMinutes} minutes')
    `).all();

    for (const s of idleSessions) {
      const count = this.getMessageCount(s.key);
      if (count > 0) {
        this.clearSession(s.key);
        cleaned++;
      }
    }

    // Daily reset: check if any sessions span across the reset hour.
    // Same acorn carve-out as above — coding sessions can sit
    // overnight without being abandoned.
    const now = new Date();
    if (now.getUTCHours() === dailyResetHour) {
      const oldSessions = this.db.prepare(`
        SELECT key FROM sessions
        WHERE updated < datetime('now', '-12 hours')
          AND key NOT LIKE 'channel:cli:%'
      `).all();
      for (const s of oldSessions) {
        const count = this.getMessageCount(s.key);
        if (count > 0) {
          this.clearSession(s.key);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.log.info(`[session-cleanup] Cleared ${cleaned} stale sessions`);
    }
    return cleaned;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.log.info('Session manager closed');
    }
  }
  /**
   * Record that this session was compacted from another. Simple 3-arg lineage trace.
   * Called when context window flush happens and a message trim occurs.
   */
  recordCompaction(sessionKey, messageCount, fromSessionKey) {
    try {
      this.db.prepare(
        'INSERT INTO session_lineage (session_key, message_count, compacted_from) VALUES (?, ?, ?)'
      ).run(sessionKey, messageCount, fromSessionKey);
      this.log.debug('[session] Compaction recorded: ' + messageCount + ' msgs from ' + fromSessionKey);
      return true;
    } catch (err) {
      this.log.error('Failed to record compaction lineage:', err.message);
      return false;
    }
  }

}

module.exports = { SessionManager };
