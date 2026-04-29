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

// ── Compaction-threshold scaling constants ───────────────────────────
// Mirror the budget scaling in loop.js so the per-insert (this file) and
// in-loop (loop.js) paths agree on when to start compacting. Operator can
// still pin an absolute value via config.compactTokenThreshold.
const COMPACT_THRESHOLD_FRACTION = 0.20; // 20% of largest model's contextWindow
const COMPACT_THRESHOLD_FLOOR    = 80000; // historic floor — small-ctx deployments don't regress
const DEFAULT_CONTEXT_WINDOW     = 200000;

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
    
    // Token-aware compaction: estimate session tokens and compact when needed.
    // Runs async to avoid blocking the tool execution loop.
    //
    // Threshold scales with the LARGEST model's contextWindow we know
    // about (across modelLimits + the global config.contextWindow).
    // 80k default was sized for 200k Sonnet/Haiku — Opus 4.7 with 1M ctx
    // would otherwise compact at 8% of capacity. The floor stays at 80k
    // so small-context-only deployments keep historic behavior.
    const tokenThreshold = this._compactTokenThreshold ?? this._computeCompactTokenThreshold();
    if (this._compactTokenThreshold == null) this._compactTokenThreshold = tokenThreshold;
    const sessionTokens = this._estimateSessionTokens(key);
    if (sessionTokens > tokenThreshold && !this._compacting?.has(key)) {
      if (!this._compacting) this._compacting = new Set();
      this._compacting.add(key);
      // _compact returns a promise that resolves after the async summary
      // tail completes — keep the lock held until then so a second
      // compaction can't start concurrently for the same key.
      Promise.resolve()
        .then(() => this._compact(key))
        .catch((e) => this.log.warn(`[compact] Error compacting ${key}: ${e.message}`))
        .finally(() => this._compacting.delete(key));
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
    //    backend (vLLM, GLM, BFL) carry no Anthropic `signature`. If the
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

  // Computes the per-insert async compaction threshold once per
  // SessionManager. Operator can pin via config.compactTokenThreshold;
  // otherwise we scale with the largest contextWindow we know about
  // across modelLimits[] + config.contextWindow. The floor is the
  // historic 80k so small-context-only deployments don't regress.
  _computeCompactTokenThreshold() {
    const explicit = this.config.compactTokenThreshold;
    if (explicit && Number.isFinite(Number(explicit))) {
      return Number(explicit);
    }
    let maxCtx = Number(this.config.contextWindow) || DEFAULT_CONTEXT_WINDOW;
    for (const lim of Object.values(this.config.modelLimits || {})) {
      const c = Number(lim?.contextWindow) || 0;
      if (c > maxCtx) maxCtx = c;
    }
    const scaled = Math.floor(maxCtx * COMPACT_THRESHOLD_FRACTION);
    const threshold = Math.max(COMPACT_THRESHOLD_FLOOR, scaled);
    if (this.log?.info) {
      this.log.info(`[sessions] compactTokenThreshold = ${threshold} (ctx=${maxCtx}, fraction=${COMPACT_THRESHOLD_FRACTION}, floor=${COMPACT_THRESHOLD_FLOOR})`);
    }
    return threshold;
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
    let toRemove = allMessages.slice(headEnd, cutIdx);
    const tail = allMessages.slice(cutIdx);

    if (toRemove.length === 0) return;

    // Filter out useless messages (acks, cleared tool stubs, blanks).
    // They get DELETED from the DB without contributing to the summary.
    // Same _isMessageUseless logic as loop.js's _compactHistory; lifted
    // inline here because sessions.js doesn't share the AgentLoop class.
    const _isUseless = (m) => this._sessionsCompactIsMessageUseless(m);
    const droppedUseless = [];
    toRemove = toRemove.filter(m => {
      if (_isUseless(m)) {
        droppedUseless.push(m);
        return false;
      }
      return true;
    });
    if (droppedUseless.length > 0) {
      // Delete the useless rows from DB outright — they vanish without
      // a summary trace.
      const ids = droppedUseless.map(m => m.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(
        `DELETE FROM messages WHERE session_key = ? AND id IN (${placeholders})`
      ).run(key, ...ids);
      this.log.info(`[compact-sessions] Skipped ${droppedUseless.length} useless messages from summarization (acks, cleared stubs, blanks)`);
    }

    if (toRemove.length === 0) return;

    this.log.info(`Compacting ${key}: ${allMessages.length} msgs, removing ${toRemove.length} (+${droppedUseless.length} useless), keeping ${head.length}+${tail.length}`);

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

    return summaryPromise.then(summary => {
      if (summary) {
        // Cap at 200 sessions (insertion-order eviction).
        if (!this._compactionSummaries.has(key) && this._compactionSummaries.size >= 200) {
          this._compactionSummaries.delete(this._compactionSummaries.keys().next().value);
        }
        this._compactionSummaries.set(key, summary);
        // Same wrapper rewrite as loop.js _compactHistory — frame the
        // summary as ACTIVE working memory, not background context.
        // The old wording made the agent treat compaction as a reset.
        this.db.prepare(`UPDATE messages SET content = ? WHERE id = ?`)
          .run(`[ACTIVE SESSION STATE — ${toRemove.length} earlier turns compressed below. THIS IS YOUR WORKING MEMORY for the rest of this session: the user's goal, decisions already made, files touched, what's done, what's in progress, and what's next. The messages after this block are the most recent exchanges — combine them with the state here to know where you are. DO NOT restart the conversation or treat this as background; continue the work in progress.]\n${summary}\n[END SESSION STATE]`, summaryRowId);
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

  // Mirror of AgentLoop._isMessageUseless. SessionManager rows store
  // content as a JSON string (or plain string), so we parse before
  // applying the same logic. Used by _compact above to drop useless
  // rows without burning summarizer tokens on them.
  _sessionsCompactIsMessageUseless(row) {
    if (!row) return true;
    let c = row.content;
    if (c == null) return true;
    if (typeof c === 'string') {
      // Try parsing as JSON-encoded array (tool blocks); if not, treat as text.
      const trimmed = c.trim();
      if (trimmed === '') return true;
      if (trimmed === '[Acknowledged.]') return true;
      if (this._sessionsCompactHasMarker(trimmed)) return false;
      if (trimmed.startsWith('[Old tool output cleared')) return true;
      if (trimmed.length < 5) return true;
      // Attempt JSON parse only if it looks structured
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try { c = JSON.parse(trimmed); } catch { return false; }
      } else {
        return false;
      }
    }
    if (!Array.isArray(c) || c.length === 0) return true;
    if (c.some(b => b && b.type === 'tool_use')) return false; // tool calls always carry signal
    return c.every(b => {
      if (!b) return true;
      if (b.type === 'tool_result') {
        const tc = typeof b.content === 'string' ? b.content : '';
        if (!tc || tc.startsWith('[Old tool output cleared') || tc.length < 5) return true;
        if (this._sessionsCompactHasMarker(tc)) return false;
        return false;
      }
      if (b.type === 'text') {
        const tx = (b.text || '').trim();
        if (!tx) return true;
        if (this._sessionsCompactHasMarker(tx)) return false;
        if (tx === '[Acknowledged.]') return true;
        if (tx.length < 5) return true;
        return false;
      }
      return false; // unknown block — preserve to be safe
    });
  }

  _sessionsCompactHasMarker(text) {
    if (!text || typeof text !== 'string') return false;
    return /\b(RESEARCH_DONE:|PLAN_READY|NO_INTERVIEW_NEEDED:|NO_FOLLOWUP_QUESTIONS:|QUESTIONS:|\[BUILD_PLAN\]|\[REVIEW\]|\[RESEARCH\])/.test(text);
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
