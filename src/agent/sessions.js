/**
 * sessions.js — Session Manager
 *
 * SQLite-backed conversation history per channel/user. Storage layer
 * only: insert / select / delete + a maxSessionMessages hard cap on
 * insert. Token-aware smart compaction lives in agent/loop.js — see
 * AgentLoop._compactHistory.
 *
 * Session key format:
 *   channel:{channelId}  — guild channel sessions
 *   dm:{userId}          — direct message sessions
 */

const graphEvents = require('../graph/events');

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// SessionManager owns dumb storage: insert/select/delete + a
// maxSessionMessages hard cap. Smart compaction (head/tail protect,
// LLM summary, model-aware budgets) lives in agent/loop.js so the
// model-routing and prompt-mode context that drives those decisions
// stays at one layer.

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
        error       TEXT,
        queue_job_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wakeups_fire_at ON wakeups(fire_at, fired);

      CREATE TABLE IF NOT EXISTS runtime_jobs (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        lane          TEXT NOT NULL,
        priority      INTEGER NOT NULL DEFAULT 1,
        status        TEXT NOT NULL DEFAULT 'queued',
        session_key   TEXT,
        route         TEXT,
        graph         TEXT,
        run_at        INTEGER NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 1,
        payload       TEXT NOT NULL,
        result        TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        started_at    INTEGER,
        completed_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_ready ON runtime_jobs(status, run_at, priority);
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_session ON runtime_jobs(session_key, status);
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_kind ON runtime_jobs(kind, status);

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
    const wakeupCols = this.db.prepare("PRAGMA table_info(wakeups)").all();
    if (!wakeupCols.some(c => c.name === 'queue_job_id')) {
      this.db.exec("ALTER TABLE wakeups ADD COLUMN queue_job_id TEXT");
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

    // PERF: Enforce maxSessionMessages on every insert — trim oldest immediately.
    // This prevents unbounded session growth between compaction cycles. The
    // fallback matches config.js's declared default (200); a partial config
    // missing the field shouldn't silently quarter the cap and start dropping
    // messages without summarization.
    const maxMessages = this.config.maxSessionMessages || 200;
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
    // Token-aware smart compaction (head/tail protect + LLM summary)
    // lives in loop.js — that's the only path that knows which model
    // is about to run, what mode the turn is in, and which summary
    // wrapper to use. SessionManager just keeps maxSessionMessages as
    // a dumb hard cap so a runaway loader never explodes the DB.
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

    // Build the list of writes first (read-only pass), then apply them
    // in a single transaction. Avoids N round-trips and lets SQLite batch
    // the WAL fsync.
    const writes = [];
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

        if (changed) writes.push({ id: row.id, content: JSON.stringify(updated) });
      } catch {
        // silent: malformed JSON → fallback
      }
    }

    if (writes.length === 0) return 0;

    // node:sqlite's DatabaseSync has no .transaction() helper (that's
    // better-sqlite3-specific) — wrap manually so all UPDATEs share one
    // WAL fsync.
    const upd = this.db.prepare('UPDATE messages SET content = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const w of writes) upd.run(w.content, w.id);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    this.log.debug(`[tool-truncate] Truncated ${writes.length} consumed tool results in ${key}`);
    return writes.length;
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

    // Strip thinking / redacted_thinking blocks from historical assistant
    // turns. They're provider-specific scratch state, not conversational
    // substance. Two reasons to drop them on replay:
    //
    // 1. Cross-vendor safety: thinking blocks captured from an OAI-compat
    //    backend (vLLM, GLM, etc.) carry no Anthropic `signature`. If the
    //    operator switches the model to claude-opus-4-7 mid-session, the
    //    Anthropic API replays history and returns
    //    `messages.N.content.M.thinking.signature: Field required` on the
    //    pre-existing unsigned block.
    //
    // 2. Token waste: thinking content can be tens of thousands of tokens
    //    per turn. The model doesn't need its OWN past reasoning replayed
    //    back at it as user-visible context — only the live turn's
    //    thinking blocks need to round-trip (and only when followed by a
    //    tool_use, which agent/loop pushes directly from response.content
    //    with signatures intact, never from this getHistory path).
    //
    // If a turn ends up with zero content blocks after stripping (e.g. an
    // assistant message that was thinking-only), drop the whole message
    // so the API doesn't see an empty content array.
    const stripped = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const filtered = msg.content.filter(b => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
        if (filtered.length === 0) continue;
        stripped.push({ ...msg, content: filtered });
      } else {
        stripped.push(msg);
      }
    }

    // Validate tool_use/tool_result pairing — orphaned results crash the API
    return this._validateToolPairing(stripped);
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
    // EXCLUDES channel:cli:* — those are Spore Code sessions, bounded by
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
