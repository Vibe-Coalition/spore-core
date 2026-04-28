/**
 * learner.js — Real-Time Conversation Learning Engine
 *
 * After each conversation turn, extracts new knowledge and persists it
 * to the graph database. Runs async so it never delays responses.
 *
 * Extraction flow:
 *   1. Build a compact context of what the graph already knows
 *   2. Send user+assistant exchange to a fast model with structured prompt
 *   3. Model returns JSON: new entities, new facts, new relationships
 *   4. Diff against existing graph — only persist genuinely new knowledge
 *   5. Write to graph DB (separate writable connection)
 */

const { DatabaseSync } = require('node:sqlite');
const graphEvents = require('../graph/events');
const { embedNodeAsync } = require('../graph');
const SkillsManager = require('../tools/skills');

const EXTRACTION_PROMPT = `You are a knowledge extraction system. Given a conversation exchange, extract ALL knowledge worth remembering **weeks or months from now**.

**Wall clock (UTC):** {OBSERVATION_TIME_UTC}
For time-sensitive facts, ALWAYS use ISO dates (YYYY-MM-DD) — never vague "today", "yesterday", "next week". Convert relative dates to absolute using the wall clock.

**NEVER extract:** facts about the agent's own age/tenure/"N days old" (computed at runtime), or operational details about which tools were called, how tasks were delegated, or the mechanics of how information was found. However, DO extract factual knowledge that was discovered or researched (e.g. "Remotion 5.0 supports WebGPU rendering", "best Thai restaurant in the area is Pad Thai Palace") — the knowledge itself matters, not how it was obtained.

Current graph context (what is already known):
<graph>
{GRAPH_CONTEXT}
</graph>

## Extraction philosophy — BE THOROUGH
Extract every durable fact, preference, plan, relationship, opinion, or event. One conversation can yield many attributes across multiple entities. Ask: "Would this fact be useful to recall in a month?" If yes, extract it. Only return empty arrays for truly content-free exchanges (pure greetings, "ok thanks", etc.).

**Worth extracting:** who someone is, what they care about, opinions, skills, projects, relationships, personality traits, preferences, biographical facts, communication style, product/item details (brand, model, specs, price), event details (date, location, participants), plans and deadlines, quantities and measurements, research findings, technical facts, code patterns, configuration details, and anything the user shared or discussed at length.
**Also extract from assistant responses:** specific recommendations (restaurants, books, products, tools), creative content details (story characters, names, colors, plot points, physical descriptions, visual details), factual answers given (schedules, assignments, calculations, explanations), research results, technical explanations, and any information the user might want to recall later ("what did you recommend?", "what was that character's name?", "what color was X?", "what did we discuss about X?").
**SHARED CONTENT & DOCUMENTS:** When the user shares text, articles, stories, code, research, or any substantial content — extract its key details as entities and attributes. Create a dedicated entity for the content (type: document, concept, or project as appropriate) with attributes capturing: title/name, author, key themes, important details, conclusions, and why the user shared it. The user expects the agent to remember what was shared. E.g. if a user pastes a short story, create an entity for the story with attributes for characters, plot summary, setting, themes, and notable quotes.
**CREATIVE & VISUAL CONTENT:** When the assistant writes stories, descriptions, or generates image prompts, extract the key visual and narrative details as attributes — character names, colors, physical descriptions, locations, plot points, dialogue, themes, and tone. E.g. "Plesiosaur has a blue scaly body" from a children's book, or "dragon has red scales and golden eyes" from a story. These are high-importance facts that users specifically ask about later.
**TECHNICAL CONTENT:** When the conversation covers technical topics — code, APIs, configurations, architectures, debugging, commands — extract the specific technical facts. E.g. "vLLM server runs on port 8000 with --tensor-parallel-size 4", "GLM-5.1 uses fp8 quantization", "the bug was caused by firstContactTimeoutMs defaulting to 10s". Technical details the user worked through are high-value recall targets.
**TRANSACTION DETAILS:** When the user mentions a specific purchase, redemption, or transaction, ALWAYS extract the store/location, item, amount, and context. E.g. "Redeemed $5 coupon on coffee creamer at Target" — not just "organizing coupons." If the store is mentioned anywhere in the conversation context (e.g. user mentions using a Target app), associate the transaction with that store.
**TABLES & STRUCTURED DATA:** When the assistant produces a table, schedule, roster, or structured list, decompose it into individual fact attributes — one per row/assignment/entry. Do NOT summarize a table as a single high-level description. For example, a 7-person shift schedule should yield 7+ attributes like "Admon: Sunday 8am-4pm (Day Shift)", "Magdy: Sunday 12pm-8pm", etc. — not one attribute saying "7-agent rotation covering 4 shifts".
**NOT worth extracting:** greetings, small talk, filler ("ok", "thanks", "got it"), anything already in the graph (even rephrased). Note: DO extract the *outcomes* and *knowledge gained* from tool usage even though the tool mechanics themselves aren't worth storing.

## Rules
- **SPEAKER ATTRIBUTION (CRITICAL — DO NOT VIOLATE):** The conversation is prefixed with \`[<speaker> in #<channel>]\`. The speaker IS the human user whose first-person statements drive this turn. Attributes (preferences, opinions, dev environment, location, biographical facts, personality, communication style, current state) belong ONLY on the speaker's own person node — NEVER on a third party the speaker merely mentions. If yam is talking about tim, "yam runs Linux" is a yam attribute; "tim uses Photoshop" must NOT be written as a tim attribute unless tim is the speaker reporting it about himself. To record that the speaker said something about a third party, use an EDGE (\`mentioned\`, \`knows\`, \`works_with\`, etc.) — never an attribute on the third party's node. Third-party person attributes will be REJECTED by a downstream guard, so emitting them just wastes a call.
- Create a person entity for new users. Use username as ID (lowercase-hyphenated). Even casual exchanges justify remembering the person.
- Create entities for significant nouns: people, places, products, projects, events, organizations. An entity mentioned with 2+ facts deserves its own node.
- **DEDUP (CRITICAL):** Before creating ANY entity, check the graph context above for an existing node that refers to the same real-world thing — even under a different name, abbreviation, or partial label. "Sasa Beauty" and "SASA San Francisco" and "Sasa Japanese Restaurant" are the SAME place — use the existing ID. When in doubt, REUSE the existing node rather than creating a new one. Duplicates are extremely costly to clean up.
- Entity IDs: lowercase-hyphenated, no special characters. Do NOT create entities for filenames, task IDs, URLs, or temporary artifacts.
- Aspect names: lowercase_underscored (e.g. "preferences", "background", "communication_style").
- **REUSE existing aspect names** from the graph context when they fit. Check the node's current aspects before inventing a new name. Only create a new aspect if no existing one is appropriate. This prevents fragmentation (e.g. "food_prefs" vs "culinary_interests" vs "cooking" on the same node).
- Importance 5-10. Extract liberally — if in doubt, extract it. Only skip truly trivial facts (importance < 5).
- Descriptions under 80 chars. Attributes should be concise, durable facts — include specific details (numbers, names, dates, brands).
- **DATES IN TEXT:** When a fact has a specific date, ALWAYS include the ISO date in the attribute text itself (e.g. "Purchased Samsung Galaxy S22 on 2023-01-15" not just "Purchased Samsung Galaxy S22"). This ensures dates are searchable and visible in all contexts. The eventDate field is still required, but the date must also appear in the attribute string.
- **EVENT DATES vs CONVERSATION DATES:** The eventDate must be when the event actually occurred, NOT when the user talked about it. If the user discusses a past event (e.g. "Holi was amazing" on March 26, but Holi was March 8), use the actual event date. For named holidays and festivals, use their real calendar date. If the actual date isn't stated or inferrable from context, set eventDate to null rather than defaulting to the wall clock. Only use the wall clock as eventDate when the user explicitly indicates something happened "today", "just now", or "right now".
- DEDUP attributes: "casual tone" and "relaxed conversational style" are the same fact. Check existing attributes carefully.
- **UPDATES (CRITICAL):** When new information **contradicts or supersedes** an existing attribute in the graph, you MUST use \`updates\` (not \`aspects\`) to replace the old value. Quote the existing attribute text exactly in \`old\`. Check the graph context carefully for existing facts that should be overwritten. Common update patterns: new personal bests/records replace old ones, job changes, location moves, changed preferences, corrected facts or numbers, updated statuses. If a user says "I beat my record", "actually it's X not Y", "I moved to", or reports a new value for something already tracked — that's an update. Do NOT use updates for additive info (e.g. a new hobby does not replace old hobbies).
- **IMPLICIT KNOWLEDGE UPDATES:** A user stating "my personal best of X" or "my record of X" or "my salary of X" in a later conversation IS declaring the CURRENT value, even inside a sentence about future goals. "I'm hoping to beat my personal best of 25:50" means the current PB IS 25:50 — the user is NOT saying 25:50 is a goal. If the graph has an older value (e.g. PB of 27:12), this MUST be an update. Parse "my [metric] of [value]" as a statement of current state.
- **EDGES:** Always create edges between entities that are related. Every new entity should have at least one edge. Use descriptive edge types.
- **COMPLETENESS:** If a message mentions a product with specs, an event with details, or a plan with dates — extract ALL the details, not just the first one. Multiple attributes per aspect is expected.
- **ASIDE MENTIONS (CRITICAL):** Users often mention important facts as parenthetical asides — "by the way, my GPS broke on 3/22" or "oh also, I redeemed a coupon at Target." These are NOT throwaway remarks. Every factual aside with a date, event, outcome, location, or status change MUST be extracted as its own attribute, even if the main conversation topic is completely different. Scan the ENTIRE exchange for any factual statement, not just the dominant topic.
- **DETAIL GRANULARITY:** Each distinct fact deserves its own attribute with full specifics. NEVER collapse multiple facts into one vague summary. BAD: "GPS issue experienced in past, resolved quickly." GOOD: "GPS system malfunction diagnosed on 2023-03-22" + "GPS system replaced at car dealership on 2023-03-22" + "Repair cost covered under warranty." Each date, outcome, and detail is separately searchable.
- **PENDING ACTIONS:** When a conversation mentions something the user needs to do (pick up an item, return something, attend an appointment, meet a deadline), ALWAYS extract it as a dedicated attribute with full context: what needs to be done, where, and current status. E.g. "Navy blue blazer needs to be picked up from dry cleaners (pending as of 2023-02-15)." These are high-importance facts users frequently ask about later.
- **EXCHANGES & RETURNS:** When a user mentions exchanging an item at a store, this involves TWO separate pending actions: (1) returning the old item to the store, and (2) picking up the new/replacement item. Extract BOTH as separate attributes. E.g. "exchanged boots at Zara for larger size" yields "Old boots (too small) need to be returned to Zara" AND "New boots (larger size) need to be picked up from Zara." Each physical item is tracked separately.
- **ENTITY DISTRIBUTION (CRITICAL):** Do NOT pile event-specific, product-specific, or project-specific facts onto the person node. Each event, product, project, or place that has specific details (dates, specs, outcomes, schedules) MUST have its own entity node carrying those details. The person node should only hold intrinsic traits: personality, preferences, biographical basics, skills, communication style, relationships. Example: "Alex attended Data Analysis webinar on 2023-03-28" — create/use a "data-analysis-webinar" event node with the attendance date as its attribute, and an edge from the person to that event. Do NOT add this as a "professional_development" attribute on the person node. This keeps entity nodes searchable and prevents the person node from becoming a mega-node that gets truncated in retrieval.

**EPHEMERAL ENTITIES (USE LIBERALLY FOR TASK-SCOPED ARTIFACTS):** Some entities exist only to carry data through the current task — they have zero value a week from now and will just clutter the graph if kept. Set \`ephemeral: true\` on these. The maintainer auto-cleans them after 48h. This is a feature, not a demotion — ephemeral is the RIGHT tag for a huge class of work-in-progress stuff.

**Actively tag as ephemeral:**
- One-off error logs, crawl-result dumps, debug traces, stack trace captures
- Temporary state: port-forward configs, session tokens about to expire, transient job IDs, scratch render jobs
- Intermediate working artifacts: draft outlines that will be thrown away once the final doc exists, batch-processing checkpoints, temp export files
- Testing/debugging runs: "Tuesday's crawl output", "diagnostic run #3", "captured failure state from this bug hunt"
- Screenshots/downloads tied to a single task turn
- Generated project scaffolds during exploration ("exploratory flask project we set up to try X")
- Content labeled with words like "log", "dump", "capture", "scratch", "draft-N", "temp", "run-N", "batch-N" — these almost always mean task-scoped

**Keep as permanent (ephemeral: false):** people, real projects that will span multiple sessions, products, places, organizations, preferences, skills, durable plans, company processes, anything referenced by a user's ongoing identity.

**Rule of thumb:** If you'd be surprised to still be talking about this entity in a week, mark it ephemeral. When there's a clean split (log of a run vs. the run's lasting conclusion), the log is temp, the conclusion is durable. Default to ephemeral: false only for entities where you genuinely can't tell if they'll matter later.

Return ONLY valid JSON:
{
  "entities": [
    { "id": "entity-id", "label": "Human Name", "type": "person|concept|project|system|channel|event|skill|product|place|organization|document", "description": "Brief description", "ephemeral": false }
  ],
  "aspects": [
    { "nodeId": "existing-or-new-entity-id", "name": "aspect_name", "attributes": ["fact 1", "fact 2"], "importance": 5, "eventDate": "YYYY-MM-DD or null" }
  ],
  "updates": [
    { "nodeId": "entity-id", "aspectName": "aspect_name", "old": "exact text of the existing attribute to replace", "new": "the updated fact", "eventDate": "YYYY-MM-DD or null" }
  ],
  "edges": [
    { "source": "entity-id", "target": "other-id", "type": "knows|uses|created|related_to|manages|inspires|owns|visited|enrolled_in|works_at|lives_in|interested_in|purchased|attending" }
  ],
  "gaps": [
    { "nodeId": "entity-id", "questions": ["What is unknown that came up in conversation?"] }
  ]
}

**eventDate** — For ANY fact tied to a specific date (meetings, deadlines, exams, trips, releases, purchases, appointments, games, events), set to the actual date the event occurred (YYYY-MM-DD). Convert relative dates ("next Tuesday", "in two weeks") using the wall clock. IMPORTANT: use the event's real date, not the conversation date — if someone discusses a past trip or holiday, use when it happened, not when they mentioned it. Null ONLY for truly timeless facts like preferences, skills, personality traits, or when the actual date is unknown.

If nothing new is worth extracting, return: { "entities": [], "aspects": [], "updates": [], "edges": [], "gaps": [] }`;

const SKILL_EXTRACTION_PROMPT = `You are a skill extraction system. Given a conversation exchange with tool calls, determine whether it contains a REUSABLE PROCEDURE worth saving to a shared skills library.

A skill is worth creating when:
- The exchange solved a non-trivial technical problem through multiple steps
- The procedure involves API usage, configuration, deployment, or integration patterns
- Someone else encountering the same problem would benefit from having the steps documented
- The knowledge is not obvious and required experimentation or error recovery

A skill is NOT worth creating when:
- The exchange is casual conversation, Q&A, or simple factual lookup
- The tools were used for one-off data retrieval with no reusable pattern
- The procedure is trivially obvious (e.g. "read a file then edit it")
- A nearly identical skill already exists (check the existing skills list)

If a skill IS worth creating, decide whether to CREATE a new one or UPDATE an existing one that covers similar ground.

Return ONLY valid JSON:

For a new skill:
{
  "action": "create",
  "slug": "lowercase-hyphenated-name",
  "title": "Human-Readable Title",
  "tags": ["tag1", "tag2"],
  "summary": "One-line description of what this skill covers",
  "content": "Full markdown content with: ## Overview\\n...\\n## Steps\\n1. ...\\n2. ...\\n## Gotchas\\n- ...\\n## Examples\\n..."
}

For updating an existing skill with new information:
{
  "action": "update",
  "slug": "existing-skill-slug",
  "title": "Updated Title (or null to keep)",
  "tags": ["updated", "tags"],
  "summary": "Updated summary",
  "content": "Full replacement content incorporating old + new knowledge",
  "mode": "replace"
}

If nothing is worth extracting:
{ "action": "none" }

CRITICAL RULES:
- Content must be actionable: include exact commands, parameters, code snippets, API endpoints.
- Include gotchas, error handling, and edge cases discovered during the exchange.
- Write for someone who has never done this before — don't assume context.
- Keep it concise but complete. No fluff, no preamble.
- If updating, merge the new knowledge with what the existing skill already covers.
- Default to "none" — most exchanges don't contain reusable procedures.`;

const PERSONALITY_ASPECTS = new Set(['identity', 'voice', 'personality', 'communication', 'hard_rules', 'startup_rules', 'rules', 'constraints']);

const CANONICAL_ASPECTS = [
  { pattern: /^voice$|^conversational_voice$/, canonical: 'voice' },
  { pattern: /^self_understanding$|^system_|^capabilities/, canonical: 'capabilities' },
  { pattern: /^self_/, canonical: 'self_awareness' },
  { pattern: /^identity/, canonical: 'identity' },
  { pattern: /^personality/, canonical: 'personality' },
  { pattern: /^creative/, canonical: 'creative' },
  { pattern: /^autonomy/, canonical: 'autonomy' },
  { pattern: /^relationship_to_kyle$|^kyle_relationship$/, canonical: 'relationship_to_kyle' },
  { pattern: /^operational/, canonical: 'operational_style' },
  { pattern: /^technical/, canonical: 'technical' },
  { pattern: /^communication/, canonical: 'communication_style' },
];
// Storage caps — bumped 2026-04-23. Originals (30 / 300) shipped when
// graphs were tiny and Claude context was tight. Modern conversations
// produce far more durable attrs per aspect, and 300-char attrs can't
// hold a single useful URL + caption. Doubled both.
const MAX_ATTRS_PER_ASPECT = 60;
const MAX_ATTR_LENGTH = 600;
// Importance is a QUALITY threshold (LLM scores 1-10), not a truncation
// limit — leave it alone. Lower = noisier, higher = misses real facts.
const MIN_IMPORTANCE = 5;

class Learner {
  constructor(config, logger, anthropicClient) {
    this.config = config;
    this.log = logger;
    this.client = anthropicClient;
    this.db = null;
    this._sharedDbs = {};
    this._sharedProjects = [];
    this._sharedGraphsLastCheck = 0;
    this.stats = { runs: 0, entities: 0, aspects: 0, updates: 0, edges: 0, errors: 0, skipped: 0, queued: 0, skillsCreated: 0, skillsUpdated: 0 };
    this._running = false;
    this._queue = [];
    this._maxQueue = 20;
    this._llmBusy = false;

    // Automatic skill extraction
    this._skills = new SkillsManager(logger);
    this._skillCooldownMs = 5 * 60_000;
    this._lastSkillExtractAt = 0;
  }

  init() {
    try {
      this.db = new DatabaseSync(this.config.graphDbPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.log.info('[learner] Graph writer connected');

      this._refreshSharedGraphWriters();
      this._cleanupOrphanFts();

      return true;
    } catch (e) {
      this.log.error('[learner] Failed to open graph for writing:', e.message);
      return false;
    }
  }

  /**
   * One-time cleanup of episodes_fts rows whose base episode was deleted.
   * SQLite reuses INTEGER PRIMARY KEY ids on insert — without this sweep,
   * a fresh episode reusing a deleted id fails with "constraint failed"
   * when the FTS insert collides with the orphan rowid.
   */
  _cleanupOrphanFts() {
    const cleanOne = (db, label) => {
      try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'").get();
        if (!has) return;
        const r = db.prepare(
          'DELETE FROM episodes_fts WHERE rowid NOT IN (SELECT id FROM episodes)'
        ).run();
        if (r.changes > 0) this.log.info(`[learner] Cleaned ${r.changes} orphan episodes_fts rows in ${label}`);
      } catch (e) {
        this.log.warn(`[learner] orphan FTS cleanup failed in ${label}: ${e.message}`);
      }
    };
    cleanOne(this.db, 'main');
    for (const [slug, sdb] of Object.entries(this._sharedDbs || {})) cleanOne(sdb, slug);
  }

  setLLMBusy(busy) {
    this._llmBusy = !!busy;
    if (!busy) this._drainQueue();
  }

  flushQueue() {
    this._llmBusy = false;
    this._drainQueue();
  }

  async _callWithRetry(fn, label = 'learner') {
    const delays = [5000, 15000, 30000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (this._llmBusy) {
        this.log.info(`[${label}] LLM busy, deferring (attempt ${attempt + 1})`);
        return null;
      }
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, delays[attempt - 1]));
        if (this._llmBusy) {
          this.log.info(`[${label}] LLM became busy during backoff, deferring`);
          return null;
        }
      }
      try {
        return await fn();
      } catch (e) {
        const isRetryable = e.message?.includes('aborted') || e.message?.includes('ECONNRESET')
          || e.message?.includes('ETIMEDOUT') || e.message?.includes('socket hang up')
          || e.status === 429 || e.status === 503;
        if (!isRetryable || attempt === delays.length) throw e;
        this.log.info(`[${label}] Attempt ${attempt + 1} failed (${e.message}), retrying in ${delays[attempt]}ms`);
      }
    }
  }

  /**
   * Refresh shared graph writer connections. Re-reads registry every 30s,
   * opens new connections and closes removed ones — no restart required.
   * Also detects file replacements (different inode) and reconnects.
   */
  _refreshSharedGraphWriters() {
    const now = Date.now();
    if (now - this._sharedGraphsLastCheck < 30_000) return;
    this._sharedGraphsLastCheck = now;

    const fs = require('fs');
    const path = require('path');
    const sharedDir = this.config.sharedGraphsDir;
    const registryPath = path.join(sharedDir, '_projects.json');

    let projects = {};
    if (fs.existsSync(registryPath)) {
      try { projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
      catch { return; }
    }

    const animaId = this.config.agentId;
    const currentSlugs = new Set(Object.keys(this._sharedDbs));
    const wantedSlugs = new Set();

    for (const [slug, proj] of Object.entries(projects)) {
      if (proj.members && proj.members.includes(animaId)) wantedSlugs.add(slug);
    }

    // Close removed projects
    for (const slug of currentSlugs) {
      if (!wantedSlugs.has(slug)) {
        try { this._sharedDbs[slug].close(); } catch { /* silent: best-effort close */ }
        delete this._sharedDbs[slug];
        this._sharedProjects = this._sharedProjects.filter(p => p.slug !== slug);
        this.log.info(`[learner] Closed shared graph writer: ${slug}`);
      }
    }

    // Open new projects + reconnect if the DB file was replaced on disk
    for (const slug of wantedSlugs) {
      const proj = projects[slug];
      const dbFile = path.join(sharedDir, proj.dbFile || `${slug}.db`);
      if (!fs.existsSync(dbFile)) continue;

      const stat = fs.statSync(dbFile);
      const diskIno = stat.ino;

      if (currentSlugs.has(slug)) {
        const meta = this._sharedProjects.find(p => p.slug === slug);
        if (meta && meta._ino === diskIno) continue;
        // File replaced — close stale handle, reopen below
        try { this._sharedDbs[slug].close(); } catch { /* silent: best-effort close */ }
        delete this._sharedDbs[slug];
        this._sharedProjects = this._sharedProjects.filter(p => p.slug !== slug);
        this.log.info(`[learner] File replaced for "${slug}" (ino ${meta?._ino} → ${diskIno}), reconnecting`);
      }

      try {
        const sdb = new DatabaseSync(dbFile);
        sdb.exec('PRAGMA journal_mode=WAL');
        sdb.exec('PRAGMA busy_timeout=5000');
        this._sharedDbs[slug] = sdb;
        this._sharedProjects.push({ slug, name: proj.name || slug, _ino: diskIno });
        this.log.info(`[learner] Shared graph writer connected: ${slug}`);
      } catch (e) {
        this.log.warn?.(`[learner] Failed to open shared graph "${slug}": ${e.message}`);
      }
    }
  }

  /**
   * Extract and learn from a conversation exchange. Fire-and-forget safe.
   * Runs extraction immediately after every conversation turn.
   */
  async extractAndLearn(userMessage, assistantResponse, opts = {}) {
    this._refreshSharedGraphWriters();
    const observedAt = opts.observedAt || new Date().toISOString();
    const exchange = this._buildExchange(userMessage, assistantResponse, opts, observedAt);
    if (exchange.length < 20) return;

    let episodeId = null;
    try {
      episodeId = this.storeEpisode(userMessage, assistantResponse, {
        sessionId: opts.channelName || opts.userId || 'conversation',
        observedAt,
        turnIdx: this.stats.runs,
      });
    } catch (e) { this.log.warn('[learner] storeEpisode failed: ' + e.message); }

    const entry = { userMessage, assistantResponse, opts, exchange, observedAt, episodeId };

    if (this._running || this._llmBusy) {
      const reason = this._running ? 'already-running' : 'llm-busy';
      if (this._queue.length >= this._maxQueue) {
        this.stats.skipped++;
        this.log.info(`[learner] Extraction dropped — ${reason}, queue full (${this._queue.length}/${this._maxQueue})`);
        graphEvents.emit('change', { op: 'learner:skip', reason: `${reason}-queue-full`, source: 'learner' });
        return;
      }
      this._queue.push({ batch: [entry] });
      this.stats.queued++;
      this.log.info(`[learner] Extraction queued — ${reason} (queue depth ${this._queue.length}/${this._maxQueue})`);
      graphEvents.emit('change', { op: 'learner:queue', reason, queueDepth: this._queue.length, source: 'learner' });
      return;
    }

    await this._processBatchExtraction([entry]);
  }


  async _processBatchExtraction(batch) {
    this._running = true;
    // Surface the extraction kickoff so operators know the learner is
    // actually running — previously the only signal was the final
    // "Extracted: NeN..." line AFTER the LLM call returned, which made
    // idle/stalled states invisible.
    const startedAt = Date.now();
    const sessionId = batch[batch.length - 1]?.opts?.channelName || batch[batch.length - 1]?.opts?.userId || 'conversation';
    this.log.info(`[learner] Extraction started (batch of ${batch.length}, session=${String(sessionId).slice(-30)})`);
    graphEvents.emit('change', { op: 'learner:start', sessionKey: sessionId, batchSize: batch.length, source: 'learner' });
    if (this._pluginManager) {
      try { await this._pluginManager.fireWorkerHook('beforeLearn', { sessionId, batchSize: batch.length }); } catch (e) { this.log.warn('[learner] beforeLearn hook failed: ' + e.message); }
    }

    // Hoisted so the finally below can hand newNodeIds + opts.sessionId
    // to the afterLearn hook (acorn-cli plugin uses these to add
    // discovered_in edges from each new node to the session node).
    let lastWrote = null;
    let lastSessionIdOpt = null;

    try {
      let combinedExchange = batch.map(b => b.exchange).join('\n\n---\n\n');
      // Trailing-token cap. Long acorn turns (lots of tool calls + big
      // file dumps) made per-turn extraction take many seconds and
      // burn input tokens on stuff the model already saw. The most
      // recent ~4k tokens (16k chars) is what matters for THIS turn's
      // extraction; older context lives in earlier extractions and in
      // the agent's own running message history. Anything beyond that
      // is dropped from the head with a marker so the model knows.
      const COMBINED_CHAR_CAP = 16000;
      if (combinedExchange.length > COMBINED_CHAR_CAP) {
        const dropped = combinedExchange.length - COMBINED_CHAR_CAP;
        combinedExchange =
          `[earlier ${dropped} chars truncated — extracting from trailing window only]\n` +
          combinedExchange.slice(-COMBINED_CHAR_CAP);
      }
      const lastObservedAt = batch[batch.length - 1].observedAt;
      const mergedOpts = batch[batch.length - 1].opts;

      const graphSummary = this._buildGraphSummary();

      let basePrompt = EXTRACTION_PROMPT
        .replace('{GRAPH_CONTEXT}', graphSummary)
        .replace('{OBSERVATION_TIME_UTC}', lastObservedAt);

      if (this._sharedProjects.length > 0) {
        basePrompt = this._injectProjectRouting(basePrompt);
      }

      const prompt = basePrompt;

      const _model = this.config.learnerModel || this.config.casualModel || this.config.model;
      const { wrapSystemPromptForModel } = require('../providers');
      const system = wrapSystemPromptForModel(
        [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
        _model,
        this.config,
      );

      const response = await this._callWithRetry(() => this.client.messages.create({
        model: _model,
        // Bumped 4096 → 8192 (2026-04-23). Extraction can return many
        // entities + aspects + attributes from a single rich turn; 4k
        // truncated mid-JSON often enough to be a real loss.
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: combinedExchange }],
      }), 'learner-extract');
      if (!response) {
        this.log.warn(`[learner] Extraction aborted — LLM returned no response (${Date.now() - startedAt}ms)`);
        graphEvents.emit('change', { op: 'learner:done', sessionKey: sessionId, error: 'no-response', elapsedMs: Date.now() - startedAt, source: 'learner' });
        return;
      }

      const text = response.content.find(b => b.type === 'text')?.text || '';
      const extraction = this._parseExtraction(text);
      if (!extraction) {
        this.log.warn(`[learner] Extraction aborted — LLM output not parseable as JSON (${Date.now() - startedAt}ms, ${(response.usage?.input_tokens) || 0}in/${(response.usage?.output_tokens) || 0}out)`);
        graphEvents.emit('change', { op: 'learner:done', sessionKey: sessionId, error: 'parse-fail', elapsedMs: Date.now() - startedAt, source: 'learner' });
        return;
      }

      const lastEpisodeId = batch[batch.length - 1].episodeId;

      this._currentDocDate = lastObservedAt.substring(0, 10);
      this._currentExcerpt = combinedExchange.substring(0, 500);
      this._currentEpisodeId = lastEpisodeId;
      const wrote = this._writeToGraph(extraction, mergedOpts);
      lastWrote = wrote;
      lastSessionIdOpt = mergedOpts.sessionId || null;
      this._currentDocDate = null;
      this._currentExcerpt = null;
      this._currentEpisodeId = null;
      this.stats.runs++;

      const inTok = response.usage?.input_tokens || 0;
      const outTok = response.usage?.output_tokens || 0;
      const elapsed = Date.now() - startedAt;

      // Always log the outcome, even when empty — a silent learner
      // pass used to look identical to "learner not running" in the
      // live logs. The empty case is useful signal: "the LLM saw the
      // turn and decided nothing new was worth capturing."
      if (wrote.total > 0) {
        this.log.info(`[learner] Extracted (batch of ${batch.length}): ${wrote.entities}e ${wrote.aspects}a ${wrote.updates || 0}u ${wrote.edges}r ${wrote.gaps || 0}g (${inTok}/${outTok} tokens, ${elapsed}ms)`);
      } else {
        this.log.info(`[learner] Extraction empty (batch of ${batch.length}, ${inTok}/${outTok} tokens, ${elapsed}ms) — nothing new worth capturing`);
      }
      graphEvents.emit('change', {
        op: 'learner:done',
        sessionKey: sessionId,
        entities: wrote.entities || 0,
        aspects: wrote.aspects || 0,
        updates: wrote.updates || 0,
        edges: wrote.edges || 0,
        gaps: wrote.gaps || 0,
        elapsedMs: elapsed,
        source: 'learner',
      });

      // Verification pass
      try {
        this._currentEpisodeId = lastEpisodeId;
        const verifyResult = await this._verifyExtraction(combinedExchange, extraction, lastObservedAt, mergedOpts);
        this._currentEpisodeId = null;
        if (verifyResult && verifyResult.total > 0) {
          this.log.info(`[learner] Verify pass: +${verifyResult.entities}e +${verifyResult.aspects}a +${verifyResult.updates || 0}u +${verifyResult.edges}r (${verifyResult.inTok}/${verifyResult.outTok} tokens)`);
        }
      } catch (ve) {
        this._currentEpisodeId = null;
        this.log.debug?.(`[learner] Verify pass skipped: ${ve.message}`);
      }

      // Automatic skill extraction
      try {
        await this._maybeExtractSkill(batch, combinedExchange);
      } catch (se) {
        this.log.debug?.(`[learner] Skill extraction skipped: ${se.message}`);
      }
    } catch (e) {
      this.stats.errors++;
      this.log.error('[learner] Batch extraction failed:', e.message);
      // Always close the learner:start we emitted at line 373 — otherwise
      // any subscriber tracking active state (e.g. the web UI's self-node
      // activity pulse) is stuck indefinitely. The two graceful failure
      // paths above also emit learner:done; this catches the throw path.
      try {
        graphEvents.emit('change', {
          op: 'learner:done',
          sessionKey: sessionId,
          error: e?.message || 'exception',
          elapsedMs: Date.now() - startedAt,
          source: 'learner',
        });
      } catch (e) { this.log.warn('[learner] graphEvents.emit failed: ' + e.message); }
    } finally {
      this._running = false;
      if (this._pluginManager) {
        try {
          await this._pluginManager.fireWorkerHook('afterLearn', {
            sessionId,                                  // log/display hint
            sessionIdOpt: lastSessionIdOpt,             // session id from opts.sessionId (set by plugin worker hooks)
            batchSize: batch.length,
            elapsedMs: Date.now() - startedAt,
            newNodeIds: lastWrote?.newNodeIds || [],    // ids of nodes the learner just created
            wrote: lastWrote || null,
          });
        } catch (e) { this.log.warn('[learner] afterLearn hook failed: ' + e.message); }
      }
      this._drainQueue();
    }
  }

  _drainQueue() {
    if (this._queue.length === 0 || this._running || this._llmBusy) return;
    const next = this._queue.shift();
    if (next.batch) {
      this._processBatchExtraction(next.batch)
        .catch(e => this.log.error('[learner] Queued batch extraction error:', e.message));
    } else {
      this._processBatchExtraction([next])
        .catch(e => this.log.error('[learner] Queued extraction error:', e.message));
    }
  }

  /**
   * Verification pass — re-examine the exchange for facts missed by the first extraction.
   * Uses a different task framing ("what did you miss?") which is easier for the model
   * than the open-ended "extract everything" task.
   */
  async _verifyExtraction(exchange, firstExtraction, observedAt, opts) {
    const extractedFacts = [];
    for (const asp of (firstExtraction.aspects || [])) {
      for (const attr of (asp.attributes || [])) extractedFacts.push(attr);
    }
    for (const upd of (firstExtraction.updates || [])) {
      extractedFacts.push(upd.new || upd.old || '');
    }

    if (extractedFacts.length === 0 && (firstExtraction.entities || []).length === 0) return null;

    const factsText = extractedFacts.slice(0, 30).map((f, i) => `${i + 1}. ${f}`).join('\n');

    const verifyPrompt = `You are a fact-checking reviewer. A knowledge extraction system processed a conversation exchange and produced the facts listed below. Your job is to find IMPORTANT facts that were MISSED.

**Wall clock (UTC):** ${observedAt}

## Already extracted:
${factsText}

## Instructions:
Re-read the conversation exchange carefully — EVERY sentence, including parenthetical asides, "by the way" mentions, and brief references to events, dates, problems, transactions, or status changes.

For each MISSED fact that is:
- A specific event with a date (e.g. "GPS broke on 3/22", "redeemed coupon last Sunday")
- A transaction (purchase, exchange, redemption) with location/store/amount details
- A problem, issue, or incident (e.g. car problems, medical issues, broken items)
- A status change (moved, lent something, started/finished something)
- A creative/visual detail from assistant content (colors, character descriptions)

...extract it using the same JSON format. If nothing significant was missed, return empty arrays.

**CRITICAL RULES:**
- Only extract facts that are GENUINELY MISSING from the "Already extracted" list above. Do NOT re-extract or rephrase facts that are already covered.
- Do NOT combine multiple facts into one attribute. Each fact should be atomic and independently searchable.
- When the user says "my personal best of X" or "my record of X", that IS the current value. Do NOT reframe it as a "target" or "goal." "Hoping to beat my personal best of 25:50" means the current PB IS 25:50.
- When an exchange is mentioned, ensure BOTH the return of the old item AND the pickup of the new item are extracted as separate pending actions (if not already in the list above).

Return ONLY valid JSON (same schema as extraction):
{
  "entities": [{ "id": "entity-id", "label": "Label", "type": "type", "description": "desc" }],
  "aspects": [{ "nodeId": "entity-id", "name": "aspect_name", "attributes": ["missed fact 1"], "importance": 8, "eventDate": "YYYY-MM-DD or null" }],
  "updates": [{ "nodeId": "entity-id", "aspectName": "aspect_name", "old": "exact existing text", "new": "updated fact", "eventDate": "YYYY-MM-DD or null" }],
  "edges": [{ "source": "id", "target": "id", "type": "related_to" }],
  "gaps": []
}`;

    const _model = this.config.learnerModel || this.config.casualModel || this.config.model;
    const { wrapSystemPromptForModel } = require('../providers');
    const system = wrapSystemPromptForModel(
      [{ type: 'text', text: verifyPrompt, cache_control: { type: 'ephemeral' } }],
      _model,
      this.config,
    );

    const response = await this._callWithRetry(() => this.client.messages.create({
      model: _model,
      // Bumped 2048 → 4096 (2026-04-23). Verification pass shouldn't be
      // tighter than half of extraction; was producing truncated retries.
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: exchange }],
    }), 'learner-verify');
    if (!response) return null;

    const text = response.content.find(b => b.type === 'text')?.text || '';
    const missed = this._parseExtraction(text);
    if (!missed) return null;

    const hasContent = (missed.entities?.length || 0) + (missed.aspects?.length || 0) + (missed.updates?.length || 0) > 0;
    if (!hasContent) return null;

    this._currentDocDate = observedAt.substring(0, 10);
    this._currentExcerpt = exchange.substring(0, 500);
    const wrote = this._writeToGraph(missed, opts);
    this._currentDocDate = null;
    this._currentExcerpt = null;

    return {
      ...wrote,
      inTok: response.usage?.input_tokens || 0,
      outTok: response.usage?.output_tokens || 0,
    };
  }

  /**
   * Summarize existing graph into a compact string for the extraction prompt.
   * Keeps it under ~1500 tokens to stay efficient.
   */
  _buildGraphSummary() {
    if (!this.db) return 'Graph unavailable.';

    try {
      const agentId = this.config.agentId || 'spore';

      const allNodes = this.db.prepare(
        'SELECT id, label, type, description, importance FROM nodes ORDER BY importance DESC, updated DESC LIMIT 200'
      ).all();

      const TOKEN_BUDGET = 2400;
      let tokensUsed = 0;
      const lines = [];

      for (const n of allNodes) {
        if (tokensUsed > TOKEN_BUDGET) break;

        const aliases = this.db.prepare(
          'SELECT alias FROM aliases WHERE node_id = ?'
        ).all(n.id).map(a => a.alias);

        const isAgent = n.id === agentId;
        const aspectLimit = isAgent ? 100 : 6;
        const attrLimit = isAgent ? 8 : 4;

        const aspects = this.db.prepare(
          `SELECT a.id, a.name FROM aspects a WHERE a.node_id = ? ORDER BY a.weight DESC LIMIT ${aspectLimit}`
        ).all(n.id);

        let aspStr = '';
        if (aspects.length > 0) {
          const aspDetails = aspects.map(a => {
            const attrs = this.db.prepare(
              `SELECT content, event_date FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT ${attrLimit}`
            ).all(a.id).map(at => {
              const txt = at.content.substring(0, 100);
              return at.event_date ? `${txt} [${at.event_date}]` : txt;
            });
            return attrs.length > 0 ? `${a.name}: ${attrs.join('; ')}` : a.name;
          });
          aspStr = `\n    ${aspDetails.join('\n    ')}`;
        }
        const desc = (n.description || '').substring(0, 60);
        const aliasStr = aliases.length ? ` [aliases: ${aliases.slice(0, 8).join(', ')}]` : '';
        const line = `- ${n.id} (${n.type}): ${desc}${aliasStr}${aspStr}`;
        tokensUsed += Math.ceil(line.length / 3.5);
        lines.push(line);
      }

      const nodeCount = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      if (nodeCount > allNodes.length) {
        const extras = this.db.prepare(
          'SELECT id, label, type FROM nodes WHERE id NOT IN (SELECT id FROM nodes ORDER BY importance DESC, updated DESC LIMIT 200) ORDER BY updated DESC LIMIT 100'
        ).all();
        if (extras.length > 0) {
          const compact = extras.map(n => `${n.id} (${n.type})`).join(', ');
          lines.push(`\nAlso in graph (${nodeCount - allNodes.length} more): ${compact}`);
        }
      }

      return lines.join('\n') || 'Empty graph.';
    } catch (e) {
      return 'Graph query failed.';
    }
  }

  /**
   * Inject project routing instructions into the extraction prompt.
   * Only called when shared project graphs are active.
   */
  _injectProjectRouting(prompt) {
    const projectList = this._sharedProjects.map(p => `  - "${p.slug}" (${p.name})`).join('\n');

    const routingBlock = `

## Target routing (shared project graphs)
This agent participates in shared project graph(s):
${projectList}

For EACH aspect and update, add a "target" field:
- "local" — personal knowledge: the user's identity, preferences, personality, biographical facts, relationships, personal events
- "project:<slug>" — project/research knowledge: shared research findings, training data, collaborative work, technical discoveries, team decisions

Default to "local" when unsure. Only route to a project when the content is clearly about that project's domain.

The JSON schema for aspects becomes:
  { "nodeId": "...", "name": "...", "attributes": [...], "importance": 7, "eventDate": "...", "target": "local" }

The JSON schema for updates becomes:
  { "nodeId": "...", "aspectName": "...", "old": "...", "new": "...", "eventDate": "...", "target": "local" }`;

    return prompt.replace(
      'Return ONLY valid JSON:',
      routingBlock + '\n\nReturn ONLY valid JSON:'
    );
  }

  _buildExchange(userMsg, assistantMsg, opts, observedAtIso) {
    const parts = [];
    if (observedAtIso) parts.push(`Observation time (UTC): ${observedAtIso}`);
    if (opts.userName) parts.push(`[${opts.userName} in #${opts.channelName || 'dm'}]`);
    // Per-side conversation excerpt cap. Bumped 12000 → 24000 chars
    // (2026-04-23, ~6k tokens per side) — long acorn turns with code
    // pastes / tool dumps were losing facts in the tail.
    const cappedUser = typeof userMsg === 'string' && userMsg.length > 24000 ? userMsg.substring(0, 24000) + '...[truncated]' : userMsg;
    parts.push(`User: ${cappedUser}`);
    if (opts.toolCalls && opts.toolCalls.length > 0) {
      const toolSummary = opts.toolCalls.map(t => {
        const raw = t.resultPreview || t.result;
        const result = typeof raw === 'string' ? raw.substring(0, 1000) : (raw != null ? JSON.stringify(raw).substring(0, 1000) : '(no result)');
        return `  ${t.tool}(${(t.input || '').substring(0, 300)}) → ${result}`;
      }).join('\n');
      parts.push(`Tools used:\n${toolSummary}`);
    }
    // Same 24k cap as the user side — see comment above.
    const cappedAssistant = typeof assistantMsg === 'string' && assistantMsg.length > 24000 ? assistantMsg.substring(0, 24000) + '...[truncated]' : assistantMsg;
    if (cappedAssistant) parts.push(`Assistant: ${cappedAssistant}`);
    return parts.join('\n');
  }

  _parseExtraction(text) {
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const data = JSON.parse(cleaned);
      if (!data.entities && !data.aspects && !data.edges && !data.gaps && !data.updates) return null;
      return {
        entities: Array.isArray(data.entities) ? data.entities : [],
        aspects: Array.isArray(data.aspects) ? data.aspects : [],
        updates: Array.isArray(data.updates) ? data.updates : [],
        edges: Array.isArray(data.edges) ? data.edges : [],
        gaps: Array.isArray(data.gaps) ? data.gaps : [],
      };
    } catch {
      this.log.debug('[learner] Failed to parse extraction JSON');
      return null;
    }
  }

  /**
   * Write extracted knowledge to the graph database.
   * Deduplicates against existing data before writing.
   */
  _canonicalizeAspect(name) {
    const lower = (name || '').toLowerCase();
    for (const { pattern, canonical } of CANONICAL_ASPECTS) {
      if (pattern.test(lower)) return canonical;
    }
    return lower;
  }

  _resolveNodeId(id, label) {
    const direct = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
    if (direct) return direct.id;

    const byAlias = this.db.prepare(
      'SELECT node_id FROM aliases WHERE LOWER(alias) = ? OR LOWER(alias) = ? LIMIT 1'
    ).get(id, (label || '').toLowerCase());
    if (byAlias) return byAlias.node_id;

    const byLabel = this.db.prepare(
      'SELECT id FROM nodes WHERE LOWER(label) = ? LIMIT 1'
    ).get((label || '').toLowerCase());
    if (byLabel) return byLabel.id;

    if (id.length >= 5) {
      const bySubId = this.db.prepare(
        'SELECT id FROM nodes WHERE id LIKE ? OR ? LIKE \'%\' || id || \'%\' LIMIT 1'
      ).get(`%${id}%`, id);
      if (bySubId) return bySubId.id;
    }

    // Fuzzy: word overlap with stopword filtering + weighted scoring
    if (label && label.length >= 4) {
      const newWords = this._significantWords(label);
      if (newWords.size >= 1) {
        const candidates = this.db.prepare(
          'SELECT id, label FROM nodes ORDER BY importance DESC, updated DESC LIMIT 2000'
        ).all();

        let bestMatch = null;
        let bestScore = 0;

        for (const c of candidates) {
          const exWords = this._significantWords(c.label);
          if (exWords.size === 0) continue;
          let overlap = 0;
          for (const w of newWords) { if (exWords.has(w)) overlap++; }
          if (overlap === 0) continue;
          const score = overlap / Math.min(newWords.size, exWords.size);
          if (score > bestScore) { bestScore = score; bestMatch = c; }
        }

        if (bestMatch && bestScore >= 0.6) {
          try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(bestMatch.id, label); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
          return bestMatch.id;
        }
      }
    }

    // Embedding similarity: narrow scan of nodes sharing a keyword in ID
    if (id.length >= 4) {
      const match = this._resolveByEmbeddingSimilarity(id, label);
      if (match) return match;
    }

    return null;
  }

  _significantWords(text) {
    const STOP = new Set([
      'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'are',
      'was', 'were', 'been', 'has', 'had', 'not', 'but', 'all', 'can',
      'her', 'his', 'him', 'its', 'our', 'who', 'how', 'what', 'when',
      'new', 'old', 'big', 'small', 'great', 'good', 'best', 'first',
      'restaurant', 'place', 'store', 'shop', 'thing', 'item', 'location',
      'area', 'spot', 'cafe', 'bar', 'club', 'hotel', 'center', 'centre',
    ]);
    return new Set(
      text.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 2 && !STOP.has(w))
    );
  }

  /**
   * Last-resort dedup: for nodes sharing an ID keyword, compare embeddings.
   * Only scans nodes whose ID contains a fragment of the candidate ID.
   * Returns matched node ID or null.
   */
  _resolveByEmbeddingSimilarity(id, label) {
    try {
      const idParts = id.split('-').filter(p => p.length >= 3);
      if (idParts.length === 0) return null;

      const conditions = idParts.map(p => `id LIKE '%${p.replace(/'/g, "''")}%'`).join(' OR ');
      const nearby = this.db.prepare(
        `SELECT id, label, embedding FROM nodes WHERE (${conditions}) AND embedding IS NOT NULL AND embedding != '' AND id != ? LIMIT 50`
      ).all(id);

      if (nearby.length === 0) return null;

      const candidateText = `${label || id}: ${label || ''}`;
      const candidateWords = candidateText.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 2);

      let bestId = null;
      let bestSim = 0;

      for (const node of nearby) {
        let vec;
        try { vec = JSON.parse(node.embedding); } catch { continue; }

        const nodeText = `${node.label}: ${node.label}`;
        const nodeWords = nodeText.toLowerCase().split(/[\s\-_]+/).filter(w => w.length > 2);

        let wordOverlap = 0;
        const nodeWordSet = new Set(nodeWords);
        for (const w of candidateWords) { if (nodeWordSet.has(w)) wordOverlap++; }

        if (wordOverlap === 0) continue;

        if (vec.length > 0) {
          const sim = this._labelSimilarity(label || id, node.label);
          if (sim > bestSim) { bestSim = sim; bestId = node.id; }
        }
      }

      if (bestId && bestSim >= 0.5) {
        try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(bestId, label || id); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
        return bestId;
      }
    } catch (e) { this.log.warn('[learner] id.split failed: ' + e.message); }
    return null;
  }

  /**
   * Character-level similarity (Sørensen–Dice on bigrams).
   * Fast, no embeddings needed, good for catching "Sasa Beauty" ≈ "SASA San Francisco".
   */
  _labelSimilarity(a, b) {
    const bigrams = (s) => {
      const bg = new Set();
      const lower = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (let i = 0; i < lower.length - 1; i++) bg.add(lower.slice(i, i + 2));
      return bg;
    };
    const setA = bigrams(a);
    const setB = bigrams(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let overlap = 0;
    for (const bg of setA) { if (setB.has(bg)) overlap++; }
    return (2 * overlap) / (setA.size + setB.size);
  }

  _isJunkEntity(id, label, type) {
    if (!id || id.length < 2) return true;
    if (/\.\w{2,4}$/.test(label || '')) return true;
    if (/^task-\d/.test(id)) return true;
    if (/^[^a-z]*$/.test(id)) return true;
    if (/^\d+$/.test(id)) return true;
    if ((label || '').length > 80) return true;
    const genericNames = new Set(['user', 'operator', 'admin', 'person', 'someone', 'they', 'them', 'he', 'she', 'assistant', 'bot', 'agent', 'human', 'client', 'guest', 'member', 'creator']);
    if (genericNames.has(id) || genericNames.has((label || '').toLowerCase())) return true;
    return false;
  }

  /**
   * Avoid persisting relative/stale time phrases on the agent node (they rot; Runtime computes tenure).
   */
  _shouldSkipStaleAgentTimeAttribute(content, nodeId) {
    const agentId = this.config.agentId || 'spore';
    if (nodeId !== agentId) return false;
    const c = (content || '').toLowerCase();
    if (/\b\d+\s+days?\s+old\b/.test(c)) return true;
    if (/\b\d+\s+hours?\s+old\b/.test(c)) return true;
    if (c.includes('current date context')) return true;
    if (/as of 20\d{2}-\d{2}-\d{2}/.test(c) && (c.includes('days old') || c.includes('days since'))) return true;
    if (c.includes('calendar days') && c.includes('old')) return true;
    return false;
  }

  _extractDateFromText(text) {
    if (!text) return null;
    const isoMatch = text.match(/\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/);
    if (isoMatch) return isoMatch[1];
    const monthNames = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    const longMatch = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})\b/i);
    if (longMatch) {
      const mm = monthNames[longMatch[1].toLowerCase()];
      const dd = longMatch[2].padStart(2, '0');
      return `${longMatch[3]}-${mm}-${dd}`;
    }
    return null;
  }

  _isOperationalNoise(content) {
    const c = (content || '').toLowerCase();
    const patterns = [
      /\b(delegat|dispatch|execut|run|launch|trigger|queue)(?:ed|ing|es)\b.*\b(task|sweep|search|scan|job|process|fetch)\b/,
      /\bresearch\s+(?:sweep|scan|run|task)s?\b.*\b(?:being|now|actively|currently)\b/,
      /\b(?:being|now|actively|currently)\b.*\b(?:delegat|dispatch|run|execut)/,
      /\btool(?:s)?\s+(?:usage|call|invocation|execution)\b/,
      /\bweb[_\s](?:search|fetch)\s+(?:was|is|being)\b/,
    ];
    return patterns.some(p => p.test(c));
  }

  _findMatchingAttribute(existingAttrs, oldText) {
    const oldLower = (oldText || '').toLowerCase().trim();
    if (!oldLower) return null;

    // Tier 1: exact match (case-insensitive)
    const exact = existingAttrs.find(ex => ex.content.toLowerCase() === oldLower);
    if (exact) return exact;

    // Tier 2: substring containment
    const substr = existingAttrs.find(ex => {
      const exLower = ex.content.toLowerCase();
      return exLower.includes(oldLower) || oldLower.includes(exLower);
    });
    if (substr) return substr;

    // Tier 3: 80%+ word overlap (stricter than the 60% dedup threshold)
    const oldWords = new Set(oldLower.split(/\s+/).filter(w => w.length > 2));
    if (oldWords.size === 0) return null;
    for (const ex of existingAttrs) {
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      if (exWords.size === 0) continue;
      let overlap = 0;
      for (const w of oldWords) { if (exWords.has(w)) overlap++; }
      if (overlap / Math.min(oldWords.size, exWords.size) >= 0.8) return ex;
    }

    return null;
  }

  /**
   * Get the appropriate DB handle for a write target.
   * Returns { db, isShared, slug } — defaults to local graph if target is
   * missing, "local", or refers to an unknown project.
   */
  _getTargetDb(target) {
    if (!target || target === 'local' || this._sharedProjects.length === 0) {
      return { db: this.db, isShared: false, slug: null };
    }
    const match = target.match(/^project:(.+)$/);
    if (match && this._sharedDbs[match[1]]) {
      return { db: this._sharedDbs[match[1]], isShared: true, slug: match[1] };
    }
    return { db: this.db, isShared: false, slug: null };
  }

  _writeToGraph(extraction, opts = {}) {
    const wrote = { entities: 0, aspects: 0, updates: 0, edges: 0, total: 0 };
    if (!this.db) return wrote;

    const idRemap = {};
    const newNodeIds = new Set();

    // Speaker scoping — used to reject person-attribute writes to anyone
    // other than the human currently talking. Without this, a yam→tim
    // conversation lets the LLM attach yam's facts (Windows path, OS,
    // preferences, etc.) onto tim's person node. Mirrors the auto-link
    // resolution further down. agentId is also allowed since assistant
    // turns legitimately learn things about the agent itself.
    const _agentId = (this.config.agentId || 'spore').toLowerCase();
    let speakerNodeId = null;
    if (opts.userId || opts.userName) {
      const hint = (opts.userId || opts.userName).toLowerCase().replace(/\s+/g, '-');
      try {
        speakerNodeId = this._resolveNodeId(hint, opts.userName) || hint;
      } catch { speakerNodeId = hint; }
    }

    try {
      for (const ent of extraction.entities) {
        if (!ent.id || !ent.label || !ent.type) continue;
        const id = ent.id.toLowerCase().replace(/\s+/g, '-');

        if (this._isJunkEntity(id, ent.label, ent.type)) {
          this.log.debug(`[learner] Skipping junk entity: ${id} (${ent.label})`);
          continue;
        }

        const resolved = this._resolveNodeId(id, ent.label);
        if (resolved) {
          idRemap[id] = resolved;
          if (ent.description) {
            this.db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
              .run(ent.description, resolved);
          }
          this.db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(resolved);
          if (resolved !== id) {
            try {
              this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(resolved, ent.label);
            } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
          }
          // If the LLM re-extracts an existing temp node as non-ephemeral
          // (worth keeping long-term), promote it by clearing the ttl marker.
          // Plugin lifecycle hook `isNodeManaged` lets a plugin claim
          // ownership of a node so the learner skips the promotion
          // (e.g. acorn-cli's session-anchor nodes are governed by
          // session-end distillation — promoting them mid-session would
          // make them escape distill's candidate sweep).
          if (ent.ephemeral === false) {
            try {
              const row = this.db.prepare('SELECT extra FROM nodes WHERE id = ?').get(resolved);
              let extraObj = {}; try { extraObj = row?.extra ? JSON.parse(row.extra) : {}; } catch (e) { this.log.warn('[learner] JSON.parse failed: ' + e.message); }
              let isManaged = false;
              if (this._pluginManager) {
                const hooks = this._pluginManager.getLifecycleHooks?.('isNodeManaged') || [];
                for (const h of hooks) {
                  try { if (h({ nodeId: resolved, extra: extraObj })) { isManaged = true; break; } }
                  catch (e) { this.log.warn('[learner] isNodeManaged hook failed: ' + e.message); }
                }
              }
              if (extraObj.ttl === 'temp' && !isManaged) {
                delete extraObj.ttl; delete extraObj.tempCreated;
                this.db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(extraObj), resolved);
                this.log.info(`[learner] Promoted temp node to permanent: ${resolved}`);
              }
            } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
          }
        } else {
          // New node — only set the temp flag if the extractor marked
          // the entity ephemeral. Plugin-driven defaults (e.g.
          // acorn-cli's "born temp tied to sessionId so session-end
          // distillation can pick winners") are applied post-hoc by
          // the plugin's afterLearn worker hook, which receives
          // `newNodeIds` and tags them via UPDATE nodes SET extra=...
          let extraObj;
          if (ent.ephemeral === true) {
            extraObj = { ttl: 'temp', tempCreated: new Date().toISOString() };
          } else {
            extraObj = {};
          }
          const extraJson = JSON.stringify(extraObj);
          this.db.prepare(
            'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
          ).run(id, ent.label, ent.type, ent.description || '', 5, 'self', 'spore-learner', new Date().toISOString(), extraJson);
          idRemap[id] = id;
          newNodeIds.add(id);
          wrote.entities++;
          this.stats.entities++;
          graphEvents.emit('change', { op: 'node:create', node: { id, label: ent.label, type: ent.type, description: ent.description || '' }, source: 'learner' });
        }
        embedNodeAsync(idRemap[id] || id, this.db);
      }

      for (const asp of extraction.aspects) {
        if (!asp.nodeId || !asp.name) continue;
        if ((asp.importance || 5) < MIN_IMPORTANCE) {
          this.log.debug(`[learner] Skipping low-importance aspect: ${asp.name} (${asp.importance})`);
          continue;
        }
        const rawNodeId = asp.nodeId.toLowerCase().replace(/\s+/g, '-');

        const { db: targetDb, isShared, slug: targetSlug } = this._getTargetDb(asp.target);
        const nodeId = isShared
          ? (targetDb.prepare('SELECT id FROM nodes WHERE id = ?').get(rawNodeId)?.id || rawNodeId)
          : (idRemap[rawNodeId] || this._resolveNodeId(rawNodeId, null) || rawNodeId);

        if (!isShared && nodeId === (this.config.agentId || 'spore')) {
          asp.name = this._canonicalizeAspect(asp.name);
        }

        if (!isShared && !this.config.personalityEditable && nodeId === (this.config.agentId || 'spore') && PERSONALITY_ASPECTS.has(asp.name?.toLowerCase())) {
          this.log.debug(`[learner] Skipping personality aspect "${asp.name}" on own node (locked)`);
          continue;
        }

        const nodeExists = targetDb.prepare('SELECT id, type FROM nodes WHERE id = ?').get(nodeId);
        if (!nodeExists) {
          if (isShared) {
            targetDb.prepare(
              'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)'
            ).run(nodeId, asp.nodeId, 'concept', '', 5, this.config.agentId || 'shared', 'spore-learner', new Date().toISOString());
            wrote.entities++;
            this.stats.entities++;
            this.log.info(`[learner] Created node "${nodeId}" in shared graph "${targetSlug}"`);
          } else {
            continue;
          }
        }

        // Cross-user contamination guard. If the LLM tried to attach an
        // aspect to a person node that is NOT the current speaker (and
        // not the agent itself), drop it. The auto-link block below will
        // still record a `mentioned` edge so the relationship survives.
        if (!isShared && nodeExists && nodeExists.type === 'person'
            && speakerNodeId && nodeId !== speakerNodeId && nodeId !== _agentId) {
          this.log.warn(`[learner] Rejected cross-user person attribute: speaker=${speakerNodeId} → target=${nodeId}/${asp.name} (${(asp.attributes || []).length} attrs dropped)`);
          continue;
        }

        // Reference-node guard. The `ref-*` nodes are seeded operational
        // knowledge (API shapes, sandbox rules, infrastructure facts)
        // managed by reference-nodes.sql + migrate-ref-*.sql. Letting the
        // learner accumulate session-derived facts on them was producing
        // noise like "user prefers x" attached to ref-bfl-api. Nothing
        // the learner ever wants to write belongs on a ref-* node — link
        // via an edge instead if relationship matters.
        if (nodeId.startsWith('ref-')) {
          this.log.warn(`[learner] Rejected write to ref-* node: ${nodeId}/${asp.name} (${(asp.attributes || []).length} attrs dropped — ref nodes are seed-managed)`);
          continue;
        }

        let aspectRow = targetDb.prepare(
          'SELECT id FROM aspects WHERE node_id = ? AND name = ?'
        ).get(nodeId, asp.name);

        if (!aspectRow) {
          targetDb.prepare(
            'INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)'
          ).run(nodeId, asp.name, asp.importance || 5, 'spore-learner');
          aspectRow = { id: targetDb.prepare('SELECT last_insert_rowid() as id').get().id };
          wrote.aspects++;
          this.stats.aspects++;
          graphEvents.emit('change', { op: 'aspect:create', nodeId, aspect: asp.name, source: 'learner' });
        }

        const existingAttrs = targetDb.prepare(
          'SELECT id, content, event_date FROM attributes WHERE aspect_id = ?'
        ).all(aspectRow.id);

        if (existingAttrs.length >= MAX_ATTRS_PER_ASPECT) {
          this.log.debug(`[learner] Aspect ${asp.name} on ${nodeId} at cap (${existingAttrs.length}), skipping`);
          continue;
        }

        for (const attrContent of (asp.attributes || [])) {
          if (!attrContent || typeof attrContent !== 'string') continue;
          const trimmed = attrContent.trim();
          if (trimmed.length < 3 || trimmed.length > MAX_ATTR_LENGTH) continue;
          if (this._shouldSkipStaleAgentTimeAttribute(trimmed, nodeId)) {
            this.log.debug(`[learner] Skipping stale time attribute on agent node: ${trimmed.substring(0, 80)}`);
            continue;
          }
          if (this._isOperationalNoise(trimmed)) {
            this.log.debug(`[learner] Skipping operational noise: ${trimmed.substring(0, 80)}`);
            continue;
          }
          const lower = trimmed.toLowerCase();

          const isDuplicate = existingAttrs.some(ex => {
            const exLower = ex.content.toLowerCase();
            if (exLower === lower) return true;
            if (exLower.includes(lower) || lower.includes(exLower)) return true;
            // Word overlap: if 60%+ of words match, treat as duplicate
            const newWords = new Set(lower.split(/\s+/).filter(w => w.length > 2));
            const exWords = new Set(exLower.split(/\s+/).filter(w => w.length > 2));
            if (newWords.size === 0 || exWords.size === 0) return false;
            let overlap = 0;
            for (const w of newWords) { if (exWords.has(w)) overlap++; }
            return overlap / Math.min(newWords.size, exWords.size) >= 0.6;
          });

          if (!isDuplicate && existingAttrs.length < MAX_ATTRS_PER_ASPECT) {
            const eventDate = asp.eventDate || this._extractDateFromText(trimmed);

            // Date conflict resolution: if same event with different date, update instead of duplicate
            const conflict = this._findDateConflict(existingAttrs, trimmed, eventDate);
            if (conflict) {
              if (!isShared) this._recordAttributeHistory(conflict.id, conflict.content, trimmed);
              targetDb.prepare('UPDATE attributes SET content = ?, importance = ?, event_date = ?, document_date = COALESCE(?, document_date), source_excerpt = COALESCE(?, source_excerpt), source_episode_id = COALESCE(?, source_episode_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(trimmed, asp.importance || 5, eventDate, this._currentDocDate || null, this._currentExcerpt || null, this._currentEpisodeId || null, conflict.id);
              this.log.info(`[learner] Date conflict resolved on ${nodeId}/${asp.name}${isShared ? ` [${targetSlug}]` : ''}: "${conflict.content.substring(0, 50)}" → "${trimmed.substring(0, 50)}"`);
              wrote.updates++;
              this.stats.updates++;
              if (!isShared) {
                const nodeRow = this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(nodeId);
                if (nodeRow) this._generateAndStoreHints(conflict.id, nodeId, nodeRow.label, asp.name, trimmed, eventDate);
              }
              graphEvents.emit('change', { op: 'attribute:update', nodeId, aspect: asp.name, content: trimmed, source: 'learner' });
            } else {
              targetDb.prepare(
                'INSERT INTO attributes (aspect_id, content, importance, event_date, document_date, source_excerpt, source_episode_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
              ).run(aspectRow.id, trimmed, asp.importance || 5, eventDate, this._currentDocDate || null, this._currentExcerpt || null, this._currentEpisodeId || null);
              const newAttrId = targetDb.prepare('SELECT last_insert_rowid() as id').get().id;
              existingAttrs.push({ id: newAttrId, content: trimmed, event_date: eventDate });
              wrote.aspects++;
              this.stats.aspects++;
              if (!isShared && (eventDate || (asp.importance || 5) >= 6)) {
                const nodeRow = this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(nodeId);
                if (nodeRow) this._generateAndStoreHints(newAttrId, nodeId, nodeRow.label, asp.name, trimmed, eventDate);
              }
              if (!isShared) {
                try { targetDb.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)').run(newAttrId, trimmed); } catch (e) { this.log.warn('[learner] targetDb.prepare failed: ' + e.message); }
              }
              graphEvents.emit('change', { op: 'attribute:create', nodeId, aspect: asp.name, content: trimmed, source: 'learner' });
            }
          }
        }
      }

      // Process updates (attribute replacements)
      for (const upd of (extraction.updates || [])) {
        if (!upd.nodeId || !upd.aspectName || !upd.old || !upd.new) continue;
        const trimmedNew = upd.new.trim();
        if (trimmedNew.length < 3 || trimmedNew.length > MAX_ATTR_LENGTH) continue;

        const rawNodeId = upd.nodeId.toLowerCase().replace(/\s+/g, '-');
        const { db: updDb, isShared: updIsShared } = this._getTargetDb(upd.target);
        const nodeId = updIsShared
          ? (updDb.prepare('SELECT id FROM nodes WHERE id = ?').get(rawNodeId)?.id || rawNodeId)
          : (idRemap[rawNodeId] || this._resolveNodeId(rawNodeId, null) || rawNodeId);
        const nodeExists = updDb.prepare('SELECT id, type FROM nodes WHERE id = ?').get(nodeId);
        if (!nodeExists) continue;

        // Same cross-user guard as the aspects loop — never let yam's
        // turn UPDATE an attribute on tim's person node.
        if (!updIsShared && nodeExists.type === 'person'
            && speakerNodeId && nodeId !== speakerNodeId && nodeId !== _agentId) {
          this.log.warn(`[learner] Rejected cross-user person update: speaker=${speakerNodeId} → target=${nodeId}/${upd.aspectName}`);
          continue;
        }

        // Reference-node guard — same reason as the aspects-loop guard.
        // ref-* nodes are seed-managed; the learner has no business
        // updating their attributes.
        if (nodeId.startsWith('ref-')) {
          this.log.warn(`[learner] Rejected update to ref-* node: ${nodeId}/${upd.aspectName} (ref nodes are seed-managed)`);
          continue;
        }

        let aspectName = upd.aspectName;
        if (!updIsShared && nodeId === (this.config.agentId || 'spore')) {
          aspectName = this._canonicalizeAspect(aspectName);
        }

        const aspectRow = updDb.prepare(
          'SELECT id FROM aspects WHERE node_id = ? AND name = ?'
        ).get(nodeId, aspectName);
        if (!aspectRow) continue;

        const existingAttrs = updDb.prepare(
          'SELECT id, content FROM attributes WHERE aspect_id = ?'
        ).all(aspectRow.id);

        const match = this._findMatchingAttribute(existingAttrs, upd.old);
        const updEventDate = upd.eventDate || this._extractDateFromText(trimmedNew);
        if (match) {
          if (!updIsShared) this._recordAttributeHistory(match.id, match.content, trimmedNew);
          updDb.prepare('UPDATE attributes SET content = ?, importance = COALESCE(?, importance), event_date = COALESCE(?, event_date), document_date = COALESCE(?, document_date), source_excerpt = COALESCE(?, source_excerpt), source_episode_id = COALESCE(?, source_episode_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(trimmedNew, upd.importance || null, updEventDate, this._currentDocDate || null, this._currentExcerpt || null, this._currentEpisodeId || null, match.id);
          wrote.updates++;
          this.stats.updates++;
          this.log.info(`[learner] Updated attribute on ${nodeId}/${aspectName}: "${match.content.substring(0, 60)}" → "${trimmedNew.substring(0, 60)}"`);
          if (!updIsShared) {
            const resolvedDate = updEventDate || updDb.prepare('SELECT event_date FROM attributes WHERE id = ?').get(match.id)?.event_date;
            if (resolvedDate) {
              const nodeRow = this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(nodeId);
              if (nodeRow) this._generateAndStoreHints(match.id, nodeId, nodeRow.label, aspectName, trimmedNew, resolvedDate);
            }
            try { updDb.prepare('DELETE FROM attr_fts WHERE rowid = ?').run(match.id); } catch (e) { this.log.warn('[learner] updDb.prepare failed: ' + e.message); }
            try { updDb.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)').run(match.id, trimmedNew); } catch (e) { this.log.warn('[learner] updDb.prepare failed: ' + e.message); }
          }
          graphEvents.emit('change', { op: 'attribute:update', nodeId, aspect: aspectName, oldContent: match.content, content: trimmedNew, source: 'learner' });
        } else {
          updDb.prepare(
            'INSERT INTO attributes (aspect_id, content, importance, event_date, document_date, source_excerpt, source_episode_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(aspectRow.id, trimmedNew, upd.importance || 7, updEventDate, this._currentDocDate || null, this._currentExcerpt || null, this._currentEpisodeId || null);
          const fallbackAttrId = updDb.prepare('SELECT last_insert_rowid() as id').get().id;
          wrote.aspects++;
          this.stats.aspects++;
          this.log.info(`[learner] Update match failed for "${upd.old.substring(0, 60)}" — inserted as new attribute`);
          if (!updIsShared && updEventDate) {
            const nodeRow = this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(nodeId);
            if (nodeRow) this._generateAndStoreHints(fallbackAttrId, nodeId, nodeRow.label, aspectName, trimmedNew, updEventDate);
          }
          if (!updIsShared) {
            try { updDb.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)').run(fallbackAttrId, trimmedNew); } catch (e) { this.log.warn('[learner] updDb.prepare failed: ' + e.message); }
          }
          graphEvents.emit('change', { op: 'attribute:create', nodeId, aspect: aspectName, content: trimmedNew, source: 'learner' });
        }
      }

      for (const edge of extraction.edges) {
        if (!edge.source || !edge.target || !edge.type) continue;
        const rawSrc = edge.source.toLowerCase().replace(/\s+/g, '-');
        const rawTgt = edge.target.toLowerCase().replace(/\s+/g, '-');
        const src = idRemap[rawSrc] || this._resolveNodeId(rawSrc, null) || rawSrc;
        const tgt = idRemap[rawTgt] || this._resolveNodeId(rawTgt, null) || rawTgt;

        const srcExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(src);
        const tgtExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(tgt);
        if (!srcExists || !tgtExists) continue;

        const existingEdge = this.db.prepare(
          'SELECT rowid FROM edges WHERE source = ? AND target = ? AND type = ?'
        ).get(src, tgt, edge.type);

        if (!existingEdge) {
          this.db.prepare(
            'INSERT INTO edges (source, target, type, weight) VALUES (?, ?, ?, 1)'
          ).run(src, tgt, edge.type);
          wrote.edges++;
          this.stats.edges++;
          graphEvents.emit('change', { op: 'edge:create', edge: { source: src, target: tgt, type: edge.type }, source: 'learner' });
        }
      }

      // graphcorn discovered_in edges moved to plugins/acorn-cli/ in
      // phase 2.3g. The plugin's afterLearn worker hook receives the
      // newly-created node ids + opts.sessionId and creates the edges.

      // Auto-link: connect newly created entities to the speaker to prevent orphans
      const speakerHint = opts.userId || opts.userName;
      if (speakerHint && newNodeIds.size > 0) {
        const agentId = (this.config.agentId || 'spore').toLowerCase();
        const normalizedHint = speakerHint.toLowerCase().replace(/\s+/g, '-');
        const speakerId = this._resolveNodeId(normalizedHint, opts.userName) || normalizedHint;
        const speakerExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(speakerId);
        if (speakerExists) {
          for (const nid of newNodeIds) {
            if (nid === speakerId || nid === agentId) continue;
            const hasEdge = this.db.prepare(
              'SELECT rowid FROM edges WHERE (source = ? AND target = ?) OR (source = ? AND target = ?)'
            ).get(nid, speakerId, speakerId, nid);
            if (!hasEdge) {
              this.db.prepare('INSERT INTO edges (source, target, type, weight) VALUES (?, ?, ?, 1)')
                .run(speakerId, nid, 'mentioned');
              wrote.edges++;
              this.stats.edges++;
              graphEvents.emit('change', { op: 'edge:create', edge: { source: speakerId, target: nid, type: 'mentioned' }, source: 'learner' });
            }
          }
        }
      }

      for (const gapItem of (extraction.gaps || [])) {
        if (!gapItem.nodeId || !Array.isArray(gapItem.questions)) continue;
        const rawGapNodeId = gapItem.nodeId.toLowerCase().replace(/\s+/g, '-');
        const nodeId = idRemap[rawGapNodeId] || this._resolveNodeId(rawGapNodeId, null) || rawGapNodeId;
        const nodeExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);
        if (!nodeExists) continue;

        for (const question of gapItem.questions) {
          if (!question || typeof question !== 'string' || question.length < 10) continue;
          const existing = this.db.prepare(
            "SELECT id FROM gaps WHERE node_id = ? AND content = ? AND status = 'open'"
          ).get(nodeId, question);
          if (!existing) {
            this.db.prepare(
              "INSERT INTO gaps (node_id, content, status, source) VALUES (?, ?, 'open', 'conversation')"
            ).run(nodeId, question);
            wrote.gaps = (wrote.gaps || 0) + 1;
          }
        }
      }

      wrote.total = wrote.entities + wrote.aspects + wrote.updates + wrote.edges + (wrote.gaps || 0);

      // Post-write: detect and resolve conflicting dated facts on same entity
      if (wrote.total > 0) {
        try { this._resolveConflictingDates(newNodeIds, extraction); } catch (e) {
          this.log.warn('[learner] Conflict resolution error:', e.message);
        }
        try { this._resolveCrossNodeConflicts(extraction); } catch (e) {
          this.log.warn('[learner] Cross-node conflict error:', e.message);
        }
      }
    } catch (e) {
      this.log.error('[learner] Graph write error:', e.message);
    }

    // Surface the set of newly-created node ids so callers (e.g. the
    // afterLearn worker hook → acorn-cli plugin) can attach
    // session-anchoring edges without having to walk the graph.
    wrote.newNodeIds = [...newNodeIds];
    return wrote;
  }

  /**
   * Post-write conflict resolution: find same-aspect attributes on the same node
   * that describe the same thing with different dates. Keep the earliest dated
   * acquisition/purchase and mark later ones as follow-up events.
   */
  _resolveConflictingDates(touchedNodeIds, extraction) {
    const ACQUISITION_WORDS = /\b(purchased|bought|acquired|got|obtained|ordered|pre-ordered)\b/i;
    const nodeIds = new Set([
      ...touchedNodeIds,
      ...(extraction.aspects || []).map(a => a.nodeId),
      ...(extraction.updates || []).map(u => u.nodeId),
    ]);

    for (const nodeId of nodeIds) {
      if (!nodeId) continue;
      const aspects = this.db.prepare(`
        SELECT asp.id as aspect_id, asp.name, a.id as attr_id, a.content, a.event_date
        FROM aspects asp
        JOIN attributes a ON a.aspect_id = asp.id
        WHERE asp.node_id = ? AND a.event_date IS NOT NULL
        ORDER BY asp.name, a.event_date
      `).all(nodeId);

      // Group by aspect, look for conflicting acquisition dates
      const byAspect = new Map();
      for (const row of aspects) {
        if (!byAspect.has(row.name)) byAspect.set(row.name, []);
        byAspect.get(row.name).push(row);
      }

      for (const [aspName, attrs] of byAspect) {
        if (attrs.length < 2) continue;
        const acquisitions = attrs.filter(a => ACQUISITION_WORDS.test(a.content));
        if (acquisitions.length < 2) continue;

        // Group acquisitions by subject (first 3 significant words)
        const subjectGroups = new Map();
        for (const acq of acquisitions) {
          const words = acq.content.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
            .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'were', 'been', 'have'].includes(w))
            .slice(0, 4).sort().join('|');
          if (!words) continue;
          if (!subjectGroups.has(words)) subjectGroups.set(words, []);
          subjectGroups.get(words).push(acq);
        }

        for (const [, group] of subjectGroups) {
          if (group.length < 2) continue;
          group.sort((a, b) => a.event_date.localeCompare(b.event_date));
          // Keep the earliest, tag later ones as follow-up
          for (let i = 1; i < group.length; i++) {
            const later = group[i];
            if (later.content.includes('(follow-up)')) continue;
            const tagged = later.content.replace(/^(Purchased|Bought|Acquired|Obtained|Got)/i, 'Follow-up:');
            if (tagged !== later.content) {
              this.db.prepare('UPDATE attributes SET content = ? WHERE id = ?').run(tagged, later.attr_id);
              try { this.db.prepare('DELETE FROM attr_fts WHERE rowid = ?').run(later.attr_id); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
              try { this.db.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)').run(later.attr_id, tagged); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
              this.log.info(`[learner] Conflict resolved: "${later.content.substring(0, 50)}" → "${tagged.substring(0, 50)}"`);
            }
          }
        }
      }
    }
  }

  /**
   * Cross-node conflict resolution: when a newly written attribute contains a
   * measurable value (time, score, count, amount) that also appears on a different
   * node with a different value, mark the older one as superseded.
   * Uses attr_fts for lookup — zero LLM cost.
   */
  _resolveCrossNodeConflicts(extraction) {
    const METRIC_PATTERNS = [
      /personal best|new record|current record|best time|best score|highest score/i,
      /current salary|current weight|current address|lives in|works at|job title/i,
    ];
    const NUMBER_RE = /\d+[.:]\d+|\d+\s*(?:minutes?|seconds?|hours?|kg|lbs?|miles?|km)\b|\$[\d,.]+/gi;

    const newAttrs = [];
    for (const asp of (extraction.aspects || [])) {
      for (const content of (asp.attributes || [])) {
        if (typeof content === 'string' && METRIC_PATTERNS.some(p => p.test(content))) {
          newAttrs.push({ nodeId: asp.nodeId, content, eventDate: asp.eventDate });
        }
      }
    }
    if (newAttrs.length === 0) return;

    try {
      const hasFts = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attr_fts'").get();
      if (!hasFts) return;

      for (const newAttr of newAttrs) {
        const words = newAttr.content.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)
          .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'were', 'been', 'have', 'also', 'currently'].includes(w));
        if (words.length < 3) continue;

        const ftsQuery = words.slice(0, 5).join(' AND ');
        let rows;
        try {
          rows = this.db.prepare(`
            SELECT a.id as attr_id, a.content, a.event_date, a.created, asp.node_id
            FROM attr_fts
            JOIN attributes a ON attr_fts.rowid = a.rowid
            JOIN aspects asp ON a.aspect_id = asp.id
            WHERE attr_fts MATCH ?
            LIMIT 10
          `).all(ftsQuery);
        } catch { continue; }

        const newNumbers = (newAttr.content.match(NUMBER_RE) || []).map(n => n.trim());
        if (newNumbers.length === 0) continue;

        for (const row of rows) {
          if (row.node_id === newAttr.nodeId) continue;
          const oldNumbers = (row.content.match(NUMBER_RE) || []).map(n => n.trim());
          if (oldNumbers.length === 0) continue;

          const hasConflict = newNumbers.some(n => oldNumbers.some(o => o !== n));
          if (!hasConflict) continue;

          const newIsNewer = newAttr.eventDate && row.event_date && newAttr.eventDate > row.event_date;
          const toSupersede = newIsNewer ? row : null;

          if (toSupersede && !toSupersede.content.includes('(superseded)')) {
            const tagged = `${toSupersede.content} (superseded)`;
            this.db.prepare('UPDATE attributes SET content = ? WHERE id = ?').run(tagged, toSupersede.attr_id);
            try { this.db.prepare('DELETE FROM attr_fts WHERE rowid = ?').run(toSupersede.attr_id); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
            try { this.db.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)').run(toSupersede.attr_id, tagged); } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
            this.log.info(`[learner] Cross-node conflict: "${toSupersede.content.substring(0, 60)}" superseded by newer fact on ${newAttr.nodeId}`);
          }
        }
      }
    } catch (e) {
      this.log.warn('[learner] Cross-node conflict resolution error:', e.message);
    }
  }

  /**
   * Summarize a set of messages for compaction using a structured template.
   * Preserves actionable state across compactions by updating previous summaries
   * iteratively rather than regenerating from scratch.
   *
   * @param {Array} messages - Messages being compacted
   * @param {string|null} previousSummary - Previous structured summary to update (iterative mode)
   */
  async summarizeForCompaction(messages, previousSummary = null) {
    try {
      const transcript = messages.map((m, i) => {
        let content;
        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content.map(b => {
            if (b.type === 'text') return b.text;
            if (b.type === 'tool_use') return `[tool: ${b.name}(${JSON.stringify(b.input).substring(0, 200)})]`;
            if (b.type === 'tool_result') return `[result: ${(typeof b.content === 'string' ? b.content : '').substring(0, 200)}]`;
            return '';
          }).filter(Boolean).join(' ');
        } else {
          content = '[structured content]';
        }
        const isRecent = i >= messages.length - 6;
        const limit = isRecent ? 600 : 300;
        return `${m.role}: ${content.substring(0, limit)}`;
      }).join('\n');

      const contentTokens = Math.ceil(transcript.length / 3.5);
      const summaryBudget = Math.max(2000, Math.min(12000, Math.floor(contentTokens * 0.25)));

      const structuredTemplate = `## Goal
[What the user is trying to accomplish — one sentence]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Progress
### Done
[Completed work — specific file paths, commands run, results]
### In Progress
[Work currently underway]
### Blocked
[Any blockers or issues encountered]

## Key Decisions
[Important technical decisions and their rationale]

## Relevant Files & Artifacts
[Files read, modified, or created — with brief note on each. Include URLs, IDs, paths.]

## Next Steps
[What needs to happen next]

## Critical Context
[Specific values, error messages, configuration details, API keys/endpoints the agent needs]`;

      let compactSystem;
      if (previousSummary) {
        compactSystem = `You are updating a structured conversation summary. A previous summary exists from an earlier compaction. You must MERGE the new conversation turns into it:
- Move items from "In Progress" to "Done" if completed
- Add new progress, decisions, files, and context
- Remove information that is clearly obsolete or superseded
- Preserve all file paths, URLs, IDs, error messages, and specific values
- Keep the same structured format

Output ONLY the updated summary using this template:

${structuredTemplate}

PREVIOUS SUMMARY TO UPDATE:
${previousSummary}`;
      } else {
        compactSystem = `Summarize this conversation into a structured format for context continuity. Focus ONLY on actionable state — what was done, what's in progress, what's needed next. Preserve all specific values (file paths, URLs, IDs, error messages, config details).

Do NOT include: narrative about what was discussed, names merely mentioned, or references to other sessions.

Output ONLY the summary using this template:

${structuredTemplate}`;
      }

      const _model = this.config.learnerModel || this.config.casualModel || this.config.model;
      const { wrapSystemPromptForModel } = require('../providers');
      const system = wrapSystemPromptForModel(
        [{ type: 'text', text: compactSystem, cache_control: { type: 'ephemeral' } }],
        _model,
        this.config,
      );

      // Compaction is called from within the agent loop (between iterations),
      // so _llmBusy is true but the model server is actually idle. Temporarily
      // clear the flag so _callWithRetry doesn't skip this call.
      const wasBusy = this._llmBusy;
      this._llmBusy = false;
      const response = await this._callWithRetry(() => this.client.messages.create({
        model: _model,
        max_tokens: summaryBudget,
        system,
        messages: [{ role: 'user', content: transcript }],
      }), 'learner-compact');
      this._llmBusy = wasBusy;

      if (response) {
        return response.content.find(b => b.type === 'text')?.text || this._fallbackSummary(messages, previousSummary);
      }
      return this._fallbackSummary(messages, previousSummary);
    } catch (e) {
      this.log.error('[learner] Compaction summary failed:', e.message);
      return this._fallbackSummary(messages, previousSummary);
    }
  }

  _fallbackSummary(messages, previousSummary) {
    const userMsgs = messages.filter(m => m.role === 'user' && typeof m.content === 'string');
    const assistantMsgs = messages.filter(m => m.role === 'assistant' && typeof m.content === 'string');
    const toolUses = messages.filter(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')
    );
    const lines = [];
    if (previousSummary) lines.push(previousSummary, '\n--- Update from recent turns ---\n');
    if (userMsgs.length) {
      lines.push('## Recent User Requests');
      for (const m of userMsgs.slice(-5)) lines.push(`- ${m.content.substring(0, 300)}`);
    }
    if (toolUses.length) {
      const toolNames = [];
      for (const m of toolUses) {
        for (const b of m.content) {
          if (b.type === 'tool_use' && !toolNames.includes(b.name)) toolNames.push(b.name);
        }
      }
      lines.push(`\n## Tools Used (${toolUses.length} calls): ${toolNames.join(', ')}`);
    }
    if (assistantMsgs.length) {
      const last = assistantMsgs[assistantMsgs.length - 1];
      lines.push(`\n## Last Assistant Response\n${last.content.substring(0, 600)}`);
    }
    this.log.info(`[learner] Using fallback template summary (${lines.join('\n').length} chars)`);
    return lines.join('\n');
  }

  /**
   * Store a raw conversation exchange as an episode for episodic memory fallback.
   * Episodes are searchable via FTS and provide a safety net when extraction misses facts.
   */
  storeEpisode(userMsg, assistantMsg, opts = {}) {
    if (!this.db) return null;
    try {
      const hasTbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'").get();
      if (!hasTbl) return null;

      const content = [
        userMsg ? `User: ${(typeof userMsg === 'string' ? userMsg : '').substring(0, 8000)}` : '',
        assistantMsg ? `Assistant: ${(typeof assistantMsg === 'string' ? assistantMsg : '').substring(0, 8000)}` : '',
      ].filter(Boolean).join('\n');

      if (content.length < 20) return null;

      const sessionId = opts.sessionId || opts.channelName || 'unknown';
      const observedAt = opts.observedAt || new Date().toISOString();

      this.db.prepare(
        'INSERT INTO episodes (session_id, turn_idx, content, observed_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, opts.turnIdx || 0, content, observedAt);

      const epId = this.db.prepare('SELECT last_insert_rowid() as id').get().id;
      try {
        // OR REPLACE handles the case where this rowid was previously used
        // by a now-deleted episode and never cleaned up from the FTS table.
        // SQLite reuses INTEGER PRIMARY KEY ids on insert; the FTS rowid
        // is unique so the new row would collide with the orphan otherwise.
        this.db.prepare('INSERT OR REPLACE INTO episodes_fts(rowid, content) VALUES (?, ?)').run(epId, content);
      } catch (e) { this.log.warn('[learner] db.prepare failed: ' + e.message); }
      return epId;
    } catch (e) {
      this.log.debug?.(`[learner] Episode storage failed: ${e.message}`);
      return null;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * Generate and store prospective indexing hints for an attribute.
   * Template-based: creates FTS-searchable hypothetical queries at write time.
   */
  _generateAndStoreHints(attrId, nodeId, nodeLabel, aspectName, content, eventDate) {
    if (!this.db) return;
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS hints (
        id INTEGER PRIMARY KEY, attribute_id INTEGER, node_id TEXT, hint TEXT
      )`);
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS hints_fts USING fts5(hint, content=hints, content_rowid=id)`);
      } catch (e) { this.log.warn('[learner] db.exec failed: ' + e.message); }

      const humanAspect = aspectName.replace(/_/g, ' ');
      const shortContent = content.substring(0, 60).replace(/\[.*?\]/g, '').trim();
      const hints = [];

      // Date-specific hints
      if (eventDate) {
        hints.push(`When did ${nodeLabel} ${humanAspect}`);
        hints.push(`What happened with ${nodeLabel} on ${eventDate}`);
      }

      // General hints (for all high-importance attributes, not just dated ones)
      hints.push(`${nodeLabel} ${shortContent}`);
      hints.push(`What ${humanAspect} does ${nodeLabel} have`);

      // Category-level hints for countable/collectible entities
      const collectTypes = ['product', 'equipment', 'project', 'event', 'place'];
      const nodeType = this.db.prepare('SELECT type FROM nodes WHERE id = ?').get(nodeId)?.type;
      if (collectTypes.includes(nodeType)) {
        hints.push(`How many ${nodeType}s ${nodeLabel}`);
        hints.push(`List all ${humanAspect} ${nodeLabel}`);
      }

      const ins = this.db.prepare('INSERT INTO hints (attribute_id, node_id, hint) VALUES (?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO hints_fts (rowid, hint) VALUES (?, ?)');
      for (const h of hints) {
        const info = ins.run(attrId, nodeId, h);
        fts.run(info.lastInsertRowid, h);
      }
    } catch (e) {
      this.log.debug?.(`[learner] Hints generation failed: ${e.message}`);
    }
  }

  /**
   * Record a snapshot of the old value before overwriting an attribute.
   */
  _recordAttributeHistory(attributeId, oldContent, newContent) {
    try {
      this.db.prepare(
        'INSERT INTO attribute_history (attribute_id, old_content, new_content, source_episode_id) VALUES (?, ?, ?, ?)'
      ).run(attributeId, oldContent, newContent, this._currentEpisodeId || null);
    } catch (e) {
      this.log.debug?.(`[learner] attribute_history write failed: ${e.message}`);
    }
  }

  /**
   * Check for date conflicts: if an existing attribute on the same aspect
   * describes the same event but with a different date, return the conflicting row.
   */
  _findDateConflict(existingAttrs, newContent, newEventDate) {
    if (!newEventDate) return null;
    const newLower = newContent.toLowerCase();
    const newWords = new Set(newLower.split(/\s+/).filter(w => w.length > 2));
    if (newWords.size < 2) return null;

    for (const ex of existingAttrs) {
      if (!ex.event_date || ex.event_date === newEventDate) continue;
      const exLower = ex.content.toLowerCase();
      const exWords = new Set(exLower.split(/\s+/).filter(w => w.length > 2));
      if (exWords.size === 0) continue;
      let overlap = 0;
      for (const w of newWords) { if (exWords.has(w)) overlap++; }
      if (overlap / Math.min(newWords.size, exWords.size) >= 0.5) {
        return ex;
      }
    }
    return null;
  }

  // ── Automatic Skill Extraction ────────────────────────────────────────────

  /**
   * Assess whether a batch of exchanges contains a skill-worthy procedure and,
   * if so, extract it into the shared skills library. Uses fast heuristics to
   * gate the LLM call — most exchanges are rejected before any tokens are spent.
   */
  async _maybeExtractSkill(batch, combinedExchange) {
    if (!this._skills.available) return;

    // Cooldown: don't run skill extraction more than once per 5 minutes
    if (Date.now() - this._lastSkillExtractAt < this._skillCooldownMs) return;

    // Aggregate tool calls across the batch
    const allToolCalls = [];
    for (const entry of batch) {
      if (entry.opts.toolCalls) allToolCalls.push(...entry.opts.toolCalls);
    }

    if (!this._isSkillWorthy(allToolCalls, combinedExchange)) return;

    this._lastSkillExtractAt = Date.now();

    const existingSkills = this._skills.list();
    const existingSummary = (existingSkills.skills || [])
      .map(s => `- ${s.slug}: ${s.summary || s.title}`)
      .join('\n') || 'None yet.';

    const toolSummary = allToolCalls.map(t => {
      const result = typeof (t.resultPreview || t.result) === 'string'
        ? (t.resultPreview || t.result).substring(0, 150)
        : '(structured)';
      return `${t.tool}(${(t.input || '').substring(0, 80)}) → ${result}`;
    }).join('\n');

    const _model = this.config.learnerModel || this.config.casualModel || this.config.model;
    const { wrapSystemPromptForModel } = require('../providers');
    const system = wrapSystemPromptForModel(
      [{ type: 'text', text: SKILL_EXTRACTION_PROMPT, cache_control: { type: 'ephemeral' } }],
      _model,
      this.config,
    );

    const userContent = `## Conversation exchange\n${combinedExchange.substring(0, 4000)}\n\n## Tool calls (${allToolCalls.length} total)\n${toolSummary}\n\n## Existing skills\n${existingSummary}`;

    const response = await this._callWithRetry(() => this.client.messages.create({
      model: _model,
      // Bumped 2048 → 4096 (2026-04-23) — skill JSON now also includes
      // longer step summaries and 4k headroom matches extraction tier.
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userContent }],
    }), 'learner-skill');
    if (!response) return;

    const text = response.content.find(b => b.type === 'text')?.text || '';
    let result;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      return;
    }

    if (!result || result.action === 'none' || !result.slug || !result.content) return;

    const author = this.config.agentId || 'spore';

    if (result.action === 'create') {
      const existing = this._skills.read(result.slug);
      if (!existing.error) {
        this.log.debug(`[learner:skills] Skill "${result.slug}" already exists, skipping create`);
        return;
      }
      const writeResult = this._skills.write(result.slug, {
        title: result.title || result.slug,
        tags: result.tags || [],
        author,
        summary: result.summary || '',
        content: result.content,
      });
      if (writeResult.ok) {
        this.stats.skillsCreated++;
        this.log.info(`[learner:skills] Auto-created skill "${result.slug}" — ${result.summary || result.title}`);
      }
    } else if (result.action === 'update') {
      const existing = this._skills.read(result.slug);
      if (existing.error) {
        this.log.debug(`[learner:skills] Skill "${result.slug}" not found for update, creating instead`);
        result.action = 'create';
      }
      const writeResult = this._skills.write(result.slug, {
        title: result.title,
        tags: result.tags,
        author,
        summary: result.summary,
        content: result.content,
        mode: result.mode || 'replace',
      });
      if (writeResult.ok) {
        this.stats.skillsUpdated++;
        this.log.info(`[learner:skills] Auto-updated skill "${result.slug}" — ${result.summary || ''}`);
      }
    }
  }

  /**
   * Fast heuristic check: does this exchange look like it contains a
   * reusable procedure? Avoids LLM calls for casual conversations.
   */
  _isSkillWorthy(toolCalls, exchange) {
    // Need at least 3 tool calls to indicate a multi-step procedure
    if (toolCalls.length < 3) return false;

    // Diverse tool usage suggests a workflow, not repetitive retries
    const uniqueTools = new Set(toolCalls.map(t => t.tool));
    if (uniqueTools.size < 2) return false;

    // Procedural signals in the exchange text
    const proceduralSignals = [
      /\b(api|endpoint|curl|fetch|request|response|header|auth|token|oauth)\b/i,
      /\b(install|configure|setup|deploy|build|compile|migrate)\b/i,
      /\b(workflow|pipeline|process|procedure|steps|recipe)\b/i,
      /\b(error|fix|workaround|solution|resolved|debug)\b/i,
      /\b(docker|kubernetes|nginx|traefik|database|redis|postgres)\b/i,
      /\b(npm|pip|cargo|apt|brew)\b.*\b(install|add|update)\b/i,
      /```[\s\S]{20,}```/,
    ];

    const signalCount = proceduralSignals.filter(p => p.test(exchange)).length;

    // At least 2 procedural signals, OR 5+ tool calls (complex task)
    return signalCount >= 2 || toolCalls.length >= 5;
  }

  close() {
    for (const [slug, sdb] of Object.entries(this._sharedDbs)) {
      try { sdb.close(); } catch { /* silent: best-effort close */ }
    }
    this._sharedDbs = {};
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { Learner };
