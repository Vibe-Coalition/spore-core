/**
 * maintainer.js — Autonomous Graph Maintenance Engine
 *
 * Handles gap detection, gap filling, reflections, stale checks, sparse
 * node connection, and formal reasoning ("dreaming") — all in one native module.
 *
 * Called by the heartbeat in gateway.js. Uses the learner model (Haiku) for
 * cheap, frequent maintenance passes. No staging, no file-based state — everything
 * lives in the graph DB.
 *
 * Maintenance cycle:
 *   1. Detect new gaps on high-importance, low-density nodes
 *   2. Fill open gaps using graph context + web search + LLM
 *   3. Generate reflections on recently active or unreflected nodes
 *   4. Check for stale data based on type-specific decay
 *   5. Connect sparse/orphan nodes
 *   6. Formal reasoning ("dreaming"):
 *      - Deductive: derive conclusions that necessarily follow from premises
 *      - Inductive: identify patterns across many data points
 *      - Abductive: infer simplest explanations for observed behavior
 */

const https = require('https');
const graphEvents = require('../graph/events');
const { embedNode, getActive: getActiveEmbedder, buildNodeText } = require('../graph/embedder');
const { ProactiveEngine } = require('./proactive');
const { parseExtra } = require('../graph/node-lifecycle');

const DECAY_DAYS = {
  system: 14, process: 14, tool: 21, project: 30, channel: 30,
  person: 90, agent: 120, concept: 365, lore: 365, default: 45,
};

class Maintainer {
  constructor(config, log, llmClient, db) {
    this.config = config;
    this.log = log;
    this.client = llmClient;
    this.db = db;
    this.model = config.learnerModel || config.casualModel || config.model;
    this._running = false;
    this._lastGraphChangeAt = 0;
    this._lastCreativeRunAt = 0;

    this._onGraphChange = (evt) => {
      if (evt?.source === 'maintainer') return;
      this._lastGraphChangeAt = Date.now();
    };
    graphEvents.on('change', this._onGraphChange);

    this.stats = {
      cycles: 0, gapsDetected: 0, gapsFilled: 0, gapsDormant: 0,
      reflections: 0, staleMarked: 0, edgesCreated: 0,
      semanticEdgesCreated: 0, reasonedMergeCandidates: 0, errors: 0,
    };

    this.proactive = new ProactiveEngine(this);
  }

  /**
   * Detach event listeners so a recreated Maintainer doesn't accumulate
   * stale 'change' handlers on the global graphEvents emitter.
   */
  shutdown() {
    if (this._onGraphChange) {
      graphEvents.removeListener('change', this._onGraphChange);
      this._onGraphChange = null;
    }
  }

  /**
   * Ensure schema extensions exist (idempotent).
   * Called once at boot by gateway.js.
   */
  ensureSchema() {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reflections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          model TEXT,
          source TEXT DEFAULT 'maintainer',
          created DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_reflections_node ON reflections(node_id);
      `);

      const gapCols = this.db.prepare("PRAGMA table_info(gaps)").all().map(c => c.name);
      if (!gapCols.includes('status')) {
        this.db.exec("ALTER TABLE gaps ADD COLUMN status TEXT DEFAULT 'open'");
        this.db.exec("ALTER TABLE gaps ADD COLUMN answer TEXT");
        this.db.exec("ALTER TABLE gaps ADD COLUMN answered_at DATETIME");
        this.db.exec("ALTER TABLE gaps ADD COLUMN source TEXT");
        this.db.exec("ALTER TABLE gaps ADD COLUMN attempts INTEGER DEFAULT 0");
        this.db.exec("ALTER TABLE gaps ADD COLUMN dormant_since DATETIME");
      }

      this.db.exec("CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status)");

      const refCols = this.db.prepare("PRAGMA table_info(reflections)").all().map(c => c.name);
      if (!refCols.includes('model')) {
        this.db.exec("ALTER TABLE reflections ADD COLUMN model TEXT");
        this.db.exec("ALTER TABLE reflections ADD COLUMN source TEXT DEFAULT 'maintainer'");
        this.db.exec("ALTER TABLE reflections ADD COLUMN updated DATETIME DEFAULT CURRENT_TIMESTAMP");
      }

      // Temporal metadata + source provenance on attributes (Wins 1 & 2)
      const attrCols = this.db.prepare("PRAGMA table_info(attributes)").all().map(c => c.name);
      if (!attrCols.includes('event_date')) {
        this.db.exec("ALTER TABLE attributes ADD COLUMN event_date TEXT");
        this.db.exec("ALTER TABLE attributes ADD COLUMN document_date TEXT");
      }
      if (!attrCols.includes('source_excerpt')) {
        this.db.exec("ALTER TABLE attributes ADD COLUMN source_excerpt TEXT");
      }

      // Derived facts table with formal reasoning support.
      // Create the table + safe-index first. Do NOT put the reasoning_type
      // index in the same exec() — on older DBs the column doesn't exist
      // yet, CREATE TABLE IF NOT EXISTS would skip, and the index creation
      // would throw "no such column: reasoning_type", aborting the migration.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS derived_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          source_node_ids TEXT NOT NULL,
          confidence TEXT DEFAULT 'medium',
          reasoning_type TEXT DEFAULT 'derived',
          premises TEXT,
          created DATETIME DEFAULT CURRENT_TIMESTAMP,
          invalidated_at DATETIME
        );
      `);
      try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_derived_facts_created ON derived_facts(created)"); } catch (e) { this.log.warn('[maintainer] db.exec failed: ' + e.message); }

      // Add reasoning_type + premises to pre-existing tables that never had them
      const dfCols = this.db.prepare("PRAGMA table_info(derived_facts)").all().map(c => c.name);
      if (!dfCols.includes('reasoning_type')) {
        try { this.db.exec("ALTER TABLE derived_facts ADD COLUMN reasoning_type TEXT DEFAULT 'derived'"); }
        catch (e) { this.log.warn('[maintainer] add reasoning_type:', e.message); }
      }
      if (!dfCols.includes('premises')) {
        try { this.db.exec("ALTER TABLE derived_facts ADD COLUMN premises TEXT"); }
        catch (e) { this.log.warn('[maintainer] add premises:', e.message); }
      }
      // Now the column definitely exists — safe to create the index
      try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_derived_facts_type ON derived_facts(reasoning_type)"); } catch (e) { this.log.warn('[maintainer] db.exec failed: ' + e.message); }

      // Ensure embedding column exists on nodes
      const nodeCols = this.db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
      if (!nodeCols.includes('embedding')) {
        try { this.db.exec("ALTER TABLE nodes ADD COLUMN embedding TEXT"); } catch (e) { this.log.warn('[maintainer] db.exec failed: ' + e.message); }
      }
      if (!nodeCols.includes('extracted_at')) {
        try { this.db.exec("ALTER TABLE nodes ADD COLUMN extracted_at DATETIME"); } catch (e) { this.log.warn('[maintainer] db.exec failed: ' + e.message); }
      }
    } catch (e) {
      this.log.warn('[maintainer] Schema migration:', e.message);
    }
  }

  // ── Main cycle ──────────────────────────────────────────────────────────────

  async runMaintenance({ force = false } = {}) {
    if (this._running) {
      this.log.debug('[maintainer] Skipping — already running');
      return null;
    }

    if (!force) {
      const minIntervalMs = (this.config.maintainerMinIntervalMinutes || 15) * 60_000;
      if (this._lastRunAt && (Date.now() - this._lastRunAt) < minIntervalMs) {
        const minsAgo = Math.round((Date.now() - this._lastRunAt) / 60000);
        this.log.info(`[maintainer] Skipping — last ran ${minsAgo}m ago (min interval: ${Math.round(minIntervalMs / 60000)}m)`);
        return null;
      }
    }

    // Skip silently if no usable LLM is configured (e.g. fresh install before
    // the onboarding wizard runs). The maintainer's first cron tick fires
    // before the user has entered any credentials and would otherwise spam
    // "Could not resolve authentication method" errors every cycle.
    if (!this._hasUsableModel()) {
      if (!this._warnedNoModel) {
        this.log.info('[maintainer] No model/provider configured yet — sleeping until setup is complete.');
        this._warnedNoModel = true;
      }
      return null;
    }
    this._warnedNoModel = false;

    // Re-resolve the model + client from the *current* config every cycle.
    // The maintainer is constructed once at boot, but settings can change
    // mid-life (onboarding wizard, settings pane edits) and we should pick
    // those up without a server restart.
    try {
      const newModel = this.config.learnerModel || this.config.casualModel || this.config.model;
      if (newModel && newModel !== this.model) {
        this.model = newModel;
      }
      const { MultiProvider } = require('../providers');
      const fresh = new MultiProvider(this.config);
      if (fresh) this.client = fresh;
    } catch (e) {
      this.log.warn(`[maintainer] client refresh failed: ${e.message}`);
    }

    this._running = true;
    this._lastRunAt = Date.now();
    const start = Date.now();

    const before = { ...this.stats };

    try {
      this.log.info('[maintainer] Starting maintenance cycle...');
      this._lastCreativeRunAt = Date.now();

      const nodeCount = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      const scale = Math.max(1, Math.min(5, Math.floor(nodeCount / 50)));

      await this.purgeExpiredTempNodes();
      await this.detectNewGaps(scale);
      await this.fillGaps(scale + 1);
      await this.reflectOnNodes(Math.min(scale, 2));
      await this.checkStale(scale + 1);
      await this.embedUnembeddedNodes(10);
      await this.connectSparseNodes(scale);
      await this.connectSemanticNeighbors(scale + 2);
      await this.mergeNodes(scale + 2);
      await this.deriveInferences(scale);
      await this.expireEpisodicAttributes(10);
      await this.runCommunityDetection({ force });
      await this.runGraphOverview({ force });

      this.stats.cycles++;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      this.log.info(`[maintainer] Cycle #${this.stats.cycles} complete in ${elapsed}s — ` +
        `gaps:+${this.stats.gapsDetected}/filled:${this.stats.gapsFilled} ` +
        `reflect:${this.stats.reflections} stale:${this.stats.staleMarked} edges:${this.stats.edgesCreated}` +
        `${this.stats.merged ? ` merged:${this.stats.merged}` : ''}` +
        `${this.stats.derived ? ` derived:${this.stats.derived}` : ''}` +
        `${this.stats.expired ? ` expired:${this.stats.expired}` : ''}` +
        `${this.stats.nodesEmbedded ? ` embed:${this.stats.nodesEmbedded}` : ''}`);

      return {
        gapsDetected: this.stats.gapsDetected - before.gapsDetected,
        gapsFilled: this.stats.gapsFilled - before.gapsFilled,
        reflections: this.stats.reflections - before.reflections,
        staleMarked: this.stats.staleMarked - before.staleMarked,
        edgesCreated: this.stats.edgesCreated - before.edgesCreated,
        semanticEdgesCreated: this.stats.semanticEdgesCreated - before.semanticEdgesCreated,
      };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[maintainer] Cycle error:', e.message);
      return null;
    } finally {
      this._running = false;
      if (this._pluginManager) {
        try { await this._pluginManager.fireWorkerHook('afterMaintain', { elapsedMs: Date.now() - start, stats: { ...this.stats } }); } catch (e) { this.log.warn('[maintainer] afterMaintain hook failed: ' + e.message); }
      }
    }
  }

  // ── Gap Detection ───────────────────────────────────────────────────────────

  async detectNewGaps(count = 2) {
    if (!this.db) return;

    try {
      // Don't generate more gaps if we already have too many open
      const totalOpen = this.db.prepare("SELECT COUNT(*) as c FROM gaps WHERE status = 'open'").get().c;
      const nodeCount = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      // Cap scales with graph size — was hardcoded 50 which permanently
      // blocked detection on any real graph (e.g. 281 open on a 446-node
      // graph). Cap = 1.5× node count with a floor of 30 and ceiling of 800.
      const gapCap = Math.max(30, Math.min(800, Math.round(nodeCount * 1.5)));
      if (totalOpen > gapCap) {
        this.log.info(`[maintainer] Skipping gap detection — ${totalOpen} open gaps already (cap: ${gapCap} for ${nodeCount} nodes)`);
        return;
      }

      const candidates = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description, n.importance,
               (SELECT COUNT(*) FROM aspects WHERE node_id = n.id) as aspect_count,
               (SELECT COUNT(*) FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = n.id) as attr_count,
               (SELECT COUNT(*) FROM gaps WHERE node_id = n.id AND status = 'open') as open_gaps
        FROM nodes n
        WHERE n.importance >= 5
          AND n.type NOT IN ('tool')
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          -- ref-* nodes are seed-managed (reference-nodes.sql + migrate-ref-*.sql)
          -- and don't accept maintainer writes per the persist guard. Skip
          -- them at detection time too so we don't burn LLM calls on
          -- gap-questions whose answers will just be discarded.
          AND n.id NOT LIKE 'ref-%'
          AND (SELECT COUNT(*) FROM gaps WHERE node_id = n.id AND status = 'open') < 10
        ORDER BY n.importance DESC, n.updated DESC
        LIMIT 15
      `).all();

      const lowDensity = candidates
        .map(c => ({
          ...c,
          density: (c.attr_count * c.aspect_count) - (c.open_gaps * 2),
        }))
        .sort((a, b) => a.density - b.density)
        .slice(0, count);

      if (lowDensity.length === 0) return;

      const nodeDescriptions = lowDensity.map(n => {
        const aspects = this.db.prepare(
          'SELECT name FROM aspects WHERE node_id = ? LIMIT 8'
        ).all(n.id).map(a => a.name);
        const existingGaps = this.db.prepare(
          "SELECT content FROM gaps WHERE node_id = ? AND status = 'open' LIMIT 5"
        ).all(n.id).map(g => g.content);
        return `- ${n.id} (${n.type}, importance:${n.importance}): ${n.description || n.label}\n` +
          `  Aspects: [${aspects.join(', ') || 'none'}]\n` +
          `  Existing gaps: [${existingGaps.join('; ') || 'none'}]`;
      }).join('\n');

      const response = await this._callLLM(
        `You identify gaps in a knowledge graph — things that SHOULD be known but aren't.
For each node, propose 1-2 questions that a user might naturally answer in conversation.
Questions must be answerable from real-world conversation, NOT from speculation or web search.
BAD: "What query language does the platform expose?" (too meta/technical)
GOOD: "What does the user like about this restaurant?" (answerable from conversation)
GOOD: "When did the user last visit?" (concrete, time-bound)
Skip nodes that already have good coverage. Return ONLY valid JSON:
[{"nodeId":"id","gaps":["question 1"]}]
If no meaningful gaps exist, return: []`,
        `Nodes to analyze:\n${nodeDescriptions}`
      );

      const parsed = this._parseJSON(response, "detectNewGaps");
      if (!Array.isArray(parsed)) return;

      let added = 0;
      for (const item of parsed) {
        if (!item.nodeId || !Array.isArray(item.gaps)) continue;
        const nodeExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(item.nodeId);
        if (!nodeExists) continue;

        for (const gap of item.gaps) {
          if (!gap || typeof gap !== 'string' || gap.length < 10) continue;
          const dup = this.db.prepare(
            "SELECT id FROM gaps WHERE node_id = ? AND content = ? AND status = 'open'"
          ).get(item.nodeId, gap);
          if (dup) continue;

          this.db.prepare(
            "INSERT INTO gaps (node_id, content, status, source) VALUES (?, ?, 'open', 'maintainer')"
          ).run(item.nodeId, gap);
          added++;
        }
      }

      if (added > 0) {
        this.stats.gapsDetected += added;
        this.log.info(`[maintainer] Detected ${added} new gaps`);
      }
    } catch (e) {
      this.log.error('[maintainer] Gap detection error:', e.message);
    }
  }

  // ── Gap Filling ─────────────────────────────────────────────────────────────

  async fillGaps(count = 5) {
    if (!this.db) return;

    try {
      // Revive dormant gaps whose target node changed since dormancy OR
      // that have been dormant for >7 days (circumstances may have changed).
      // Without this, a gap that failed 3 attempts is stuck forever.
      try {
        const revived = this.db.prepare(`
          UPDATE gaps
          SET status = 'open', attempts = 0
          WHERE status = 'dormant'
            AND (
              dormant_since < datetime('now', '-7 days')
              OR node_id IN (
                SELECT id FROM nodes WHERE updated > gaps.dormant_since
              )
            )
        `).run();
        if (revived.changes > 0) this.log.info(`[maintainer] Revived ${revived.changes} dormant gap(s)`);
      } catch (e) { this.log.debug?.('[maintainer] dormant revive:', e.message); }

      const gaps = this.db.prepare(`
        SELECT g.id, g.node_id, g.content, g.attempts,
               n.label, n.type, n.description
        FROM gaps g
        JOIN nodes n ON g.node_id = n.id
        WHERE g.status = 'open' AND g.attempts < 3
        ORDER BY n.importance DESC, g.attempts ASC, g.created ASC
        LIMIT ?
      `).all(count);

      for (const gap of gaps) {
        await this._resolveGap(gap);
      }
    } catch (e) {
      this.log.error('[maintainer] Gap filling error:', e.message);
    }
  }

  async _resolveGap(gap) {
    try {
      const context = this._buildNodeContext(gap.node_id);

      let webContext = '';
      if (this._isFactualGap(gap.content) && (this.config.searxngUrl || this.config.braveApiKey)) {
        try {
          const results = await this._webSearch(gap.content, 3);
          if (results.length > 0) {
            webContext = '\n\nWeb search results:\n' + results
              .map(r => `- ${r.title}: ${r.description}`).join('\n');
          }
        } catch (e) { this.log.warn('[maintainer] _webSearch failed: ' + e.message); }
      }

      const response = await this._callLLM(
        `You are resolving an open question about an entity in a knowledge graph.
ONLY answer from the provided context — do NOT make up information or speculate.
If the answer is clearly stated in the context, provide it with high confidence.
If the context has partial info, provide what's known with medium confidence.
If the answer is NOT in the context at all, respond UNKNOWN — do not hallucinate.
You may propose 0-1 follow-up question, but ONLY if it would naturally come up in conversation.
Return ONLY JSON: {"answer":"your answer or UNKNOWN","confidence":"high|medium|low","followUps":["question"]}`,
        `Node: ${gap.label} (${gap.type}): ${gap.description || ''}\n` +
        `Gap: ${gap.content}\n\n` +
        `Graph context:\n${context}${webContext}`
      );

      const result = this._parseJSON(response, "fillGaps._resolveGap");
      if (!result) {
        this.db.prepare('UPDATE gaps SET attempts = attempts + 1 WHERE id = ?').run(gap.id);
        return;
      }

      if (result.answer === 'UNKNOWN' || result.confidence === 'low') {
        const newAttempts = gap.attempts + 1;
        if (newAttempts >= 3) {
          this.db.prepare(
            "UPDATE gaps SET status = 'dormant', attempts = ?, dormant_since = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(newAttempts, gap.id);
          this.stats.gapsDormant++;
          this.log.debug(`[maintainer] Gap dormant after 3 attempts: "${gap.content.substring(0, 50)}"`);
        } else {
          this.db.prepare('UPDATE gaps SET attempts = ? WHERE id = ?').run(newAttempts, gap.id);
        }
      } else {
        this.db.prepare(
          "UPDATE gaps SET status = 'answered', answer = ?, answered_at = CURRENT_TIMESTAMP, source = 'maintainer', attempts = attempts + 1 WHERE id = ?"
        ).run(result.answer, gap.id);
        this.stats.gapsFilled++;
        this.log.info(`[maintainer] Filled gap on ${gap.node_id}: "${gap.content.substring(0, 40)}..."`);

        if (result.answer && result.confidence !== 'low') {
          this._persistAnswerToGraph(gap.node_id, gap.content, result.answer);
        }
      }

      if (Array.isArray(result.followUps)) {
        const openGaps = this.db.prepare("SELECT COUNT(*) as c FROM gaps WHERE status = 'open'").get().c;
        if (openGaps < 30) {
          for (const fu of result.followUps.slice(0, 1)) {
            if (!fu || typeof fu !== 'string' || fu.length < 10) continue;
            const dup = this.db.prepare(
              "SELECT id FROM gaps WHERE node_id = ? AND content = ?"
            ).get(gap.node_id, fu);
            if (!dup) {
              this.db.prepare(
                "INSERT INTO gaps (node_id, content, status, source) VALUES (?, ?, 'open', 'curiosity')"
              ).run(gap.node_id, fu);
              this.stats.gapsDetected++;
            }
          }
        }
      }
    } catch (e) {
      this.log.error(`[maintainer] Gap resolve error (${gap.node_id}):`, e.message);
      this.db.prepare('UPDATE gaps SET attempts = attempts + 1 WHERE id = ?').run(gap.id);
    }
  }

  _persistAnswerToGraph(nodeId, question, answer) {
    // Reference-node guard. The `ref-*` nodes are seeded operational
    // knowledge managed by reference-nodes.sql + migrate-ref-*.sql.
    // The maintainer's gap-fill flow was attaching "learned_facts"
    // attributes to nodes like ref-search-tools — clobbering the seed
    // contract with session-derived noise. Ref nodes do not accept
    // gap-fill writes; if a question is interesting enough to record,
    // it belongs on a non-ref node.
    if (typeof nodeId === 'string' && nodeId.startsWith('ref-')) {
      this.log.debug(`[maintainer] Skipped gap persist on ref-* node: ${nodeId} (ref nodes are seed-managed)`);
      return;
    }
    try {
      const aspectName = 'learned_facts';
      let aspect = this.db.prepare(
        'SELECT id FROM aspects WHERE node_id = ? AND name = ?'
      ).get(nodeId, aspectName);

      if (!aspect) {
        this.db.prepare(
          "INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 6, 'maintainer')"
        ).run(nodeId, aspectName);
        aspect = { id: this.db.prepare('SELECT last_insert_rowid() as id').get().id };
      }

      const content = `${answer} (from gap: "${question.substring(0, 60)}")`;
      const existing = this.db.prepare(
        'SELECT id FROM attributes WHERE aspect_id = ? AND content = ?'
      ).get(aspect.id, content);

      if (!existing) {
        this.db.prepare(
          "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'gap-fill', 'maintainer')"
        ).run(aspect.id, content);
        graphEvents.emit('change', { op: 'attribute:create', nodeId, aspect: aspectName, content, source: 'maintainer' });
      }
    } catch (e) {
      this.log.debug('[maintainer] Failed to persist gap answer:', e.message);
    }
  }

  // ── Reflections ─────────────────────────────────────────────────────────────

  async reflectOnNodes(count = 3) {
    if (!this.db) return;

    try {
      const unreflected = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description, n.importance,
               (SELECT COUNT(*) FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = n.id) as attr_count
        FROM nodes n
        WHERE n.type NOT IN ('tool')
          AND n.importance >= 5
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          AND n.id NOT IN (SELECT DISTINCT node_id FROM reflections)
          AND (SELECT COUNT(*) FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = n.id) >= 3
        ORDER BY n.importance DESC, n.updated DESC
        LIMIT ?
      `).all(count);

      const recentlyTouched = this.db.prepare(`
        SELECT DISTINCT n.id, n.label, n.type, n.description, n.importance
        FROM nodes n
        WHERE n.updated > datetime('now', '-24 hours')
          AND n.type NOT IN ('tool')
          AND n.importance >= 4
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          AND n.id NOT IN (
            SELECT node_id FROM reflections WHERE updated > datetime('now', '-48 hours')
          )
        ORDER BY n.updated DESC
        LIMIT ?
      `).all(Math.max(1, count - unreflected.length));

      const nodes = [...unreflected, ...recentlyTouched]
        .filter((n, i, arr) => arr.findIndex(x => x.id === n.id) === i)
        .slice(0, count);

      if (nodes.length === 0) return;

      for (const node of nodes) {
        await this._reflectOnNode(node);
      }
    } catch (e) {
      this.log.error('[maintainer] Reflection error:', e.message);
    }
  }

  async _reflectOnNode(node) {
    try {
      const context = this._buildNodeContext(node.id);
      const edges = this.db.prepare(
        'SELECT target, type FROM edges WHERE source = ? LIMIT 10'
      ).all(node.id);
      const edgeStr = edges.map(e => `→ ${e.target} (${e.type})`).join(', ');

      const existingReflection = this.db.prepare(
        'SELECT content FROM reflections WHERE node_id = ? ORDER BY updated DESC LIMIT 1'
      ).get(node.id);

      const response = await this._callLLM(
        `Write a 1-2 sentence factual summary of what you know about this entity and what's missing.
Focus on concrete facts, not feelings. No poetry, no metaphors, no creative musing.
If the node has almost no data, say so briefly — don't pad with speculation.
${existingReflection ? 'A previous reflection exists — only update if you have genuinely new information.' : ''}
Return ONLY the reflection text, no JSON wrapping.`,
        `Entity: ${node.label} (${node.type}): ${node.description || ''}\n` +
        `Connections: ${edgeStr || 'none'}\n` +
        `Context:\n${context}` +
        (existingReflection ? `\n\nPrevious reflection: ${existingReflection.content}` : '')
      );

      if (!response || response.length < 20) return;

      if (existingReflection) {
        this.db.prepare(
          'UPDATE reflections SET content = ?, model = ?, updated = CURRENT_TIMESTAMP WHERE node_id = ? AND id = (SELECT MAX(id) FROM reflections WHERE node_id = ?)'
        ).run(response.trim(), this.model, node.id, node.id);
      } else {
        this.db.prepare(
          'INSERT INTO reflections (node_id, content, model, source) VALUES (?, ?, ?, ?)'
        ).run(node.id, response.trim(), this.model, 'maintainer');
      }
      graphEvents.emit('change', { op: 'reflection:upsert', nodeId: node.id, source: 'maintainer' });

      this.stats.reflections++;
      this.log.debug(`[maintainer] Reflected on ${node.id}`);
    } catch (e) {
      this.log.error(`[maintainer] Reflection error (${node.id}):`, e.message);
    }
  }

  // ── Temp Node Purge ──────────────────────────────────────────────────────────
  // Hard-deletes nodes tagged as ephemeral (extra.ttl === 'temp') once they've
  // aged past the configured TTL. Cascades aspects, attributes, edges, aliases.

  async purgeExpiredTempNodes() {
    if (!this.db) return;
    // Safety net: the janitor worker normally handles temp review starting at
    // ttlHours × 0.5. The maintainer only fires as a backstop at 2× TTL, so a
    // crashed/disabled janitor can't leave temps around forever.
    const ttlHours = Number(this.config?.tempNodeTtlHours) || 48;
    const multiplier = this.config?.janitorEnabled === false ? 1 : 2;
    const thresholdMs = ttlHours * multiplier * 3600 * 1000;
    const now = Date.now();
    let rows = [];
    try {
      rows = this.db.prepare("SELECT id, extra, created FROM nodes WHERE extra LIKE '%\"ttl\":\"temp\"%'").all();
    } catch (e) {
      this.log.warn(`[maintainer] temp-purge scan failed: ${e.message}`);
      return;
    }
    const victims = [];
    for (const row of rows) {
      let extraObj = {};
      try { extraObj = row.extra ? JSON.parse(row.extra) : {}; } catch (e) { this.log.warn('[maintainer] JSON.parse failed: ' + e.message); }
      if (extraObj.ttl !== 'temp') continue;
      const refIso = extraObj.tempCreated || row.created;
      const refMs = refIso ? Date.parse(refIso) : NaN;
      if (!Number.isFinite(refMs)) continue;
      if (now - refMs >= thresholdMs) victims.push(row.id);
    }
    if (!victims.length) return;
    const delAttrs = this.db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)');
    const delAspects = this.db.prepare('DELETE FROM aspects WHERE node_id = ?');
    const delEdges = this.db.prepare('DELETE FROM edges WHERE source = ? OR target = ?');
    const delAliases = this.db.prepare('DELETE FROM aliases WHERE node_id = ?');
    const delNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    let purged = 0;
    for (const id of victims) {
      try {
        delAttrs.run(id);
        delAspects.run(id);
        delEdges.run(id, id);
        delAliases.run(id);
        delNode.run(id);
        graphEvents.emit('change', { op: 'node:delete', nodeId: id, source: 'maintainer-temp-purge' });
        purged++;
      } catch (e) {
        this.log.warn(`[maintainer] temp-purge failed for ${id}: ${e.message}`);
      }
    }
    if (purged > 0) {
      this.stats.tempNodesPurged = (this.stats.tempNodesPurged || 0) + purged;
      this.log.info(`[maintainer] Purged ${purged} expired temp node(s): ${victims.slice(0, 5).join(', ')}${victims.length > 5 ? `, …(+${victims.length - 5})` : ''}`);
    }
  }

  // ── Stale Data Check ────────────────────────────────────────────────────────

  async checkStale(count = 5) {
    if (!this.db) return;

    try {
      const candidates = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description, n.importance, n.updated,
               CAST((julianday('now') - julianday(n.updated)) AS INTEGER) as age_days
        FROM nodes n
        WHERE n.type NOT IN ('tool', 'agent')
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          AND n.importance >= 4
        ORDER BY n.updated ASC
        LIMIT 20
      `).all();

      const staleChecks = candidates.filter(c => {
        const decayDays = DECAY_DAYS[c.type] || DECAY_DAYS.default;
        return c.age_days > decayDays;
      }).slice(0, count);

      if (staleChecks.length === 0) return;

      for (const node of staleChecks) {
        await this._checkNodeStaleness(node);
      }
    } catch (e) {
      this.log.error('[maintainer] Stale check error:', e.message);
    }
  }

  async _checkNodeStaleness(node) {
    try {
      const context = this._buildNodeContext(node.id);
      const answeredGaps = this.db.prepare(
        "SELECT content, answer FROM gaps WHERE node_id = ? AND status = 'answered' LIMIT 10"
      ).all(node.id);

      const factsStr = answeredGaps.map(g => `Q: ${g.content} → A: ${g.answer}`).join('\n');

      const response = await this._callLLM(
        `You are checking if knowledge about an entity is stale or outdated.
Given the entity's current graph data and its age, determine if the information is likely still accurate.
Return ONLY JSON: {"status":"current"|"stale"|"uncertain","reason":"brief explanation","staleAspects":["aspect names that may be outdated"]}`,
        `Entity: ${node.label} (${node.type}): ${node.description || ''}\n` +
        `Last updated: ${node.updated} (${node.age_days} days ago)\n` +
        `Decay threshold for ${node.type}: ${DECAY_DAYS[node.type] || DECAY_DAYS.default} days\n\n` +
        `Current knowledge:\n${context}\n\n` +
        (factsStr ? `Answered questions:\n${factsStr}` : '')
      );

      const result = this._parseJSON(response, "checkStale._checkNodeStaleness");
      if (!result) return;

      if (result.status === 'stale') {
        const staleGap = `[STALE] ${result.reason || 'Information may be outdated'} (detected ${new Date().toISOString().substring(0, 10)})`;
        const existing = this.db.prepare(
          "SELECT id FROM gaps WHERE node_id = ? AND content LIKE '[STALE]%' AND status = 'open'"
        ).get(node.id);

        if (!existing) {
          this.db.prepare(
            "INSERT INTO gaps (node_id, content, status, source) VALUES (?, ?, 'open', 'stale-check')"
          ).run(node.id, staleGap);
        }

        if (Array.isArray(result.staleAspects)) {
          for (const aspectName of result.staleAspects) {
            this.db.prepare(
              "UPDATE aspects SET extracted_with = 'stale:' || extracted_with WHERE node_id = ? AND name = ? AND extracted_with NOT LIKE 'stale:%'"
            ).run(node.id, aspectName);
          }
        }

        this.stats.staleMarked++;
        this.log.info(`[maintainer] Stale data on ${node.id}: ${result.reason}`);
      }
      // NOTE: do NOT update nodes.updated here. That column means "this
      // node's content changed" — the staleness check is a read-only audit
      // and touching it would permanently hide every node from the next
      // cycle's decay-age query, making checkStale find 0 candidates forever.
    } catch (e) {
      this.log.error(`[maintainer] Stale check error (${node.id}):`, e.message);
    }
  }

  // ── Sparse Node Connection ──────────────────────────────────────────────────

  async connectSparseNodes(count = 3) {
    if (!this.db) return;

    try {
      const orphans = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description
        FROM nodes n
        WHERE n.type NOT IN ('tool')
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          AND (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) < 2
          AND n.importance >= 4
        ORDER BY n.importance DESC
        LIMIT ?
      `).all(count * 2);

      if (orphans.length < 2) return;

      const allNodes = this.db.prepare(
        "SELECT id, label, type, description FROM nodes WHERE type NOT IN ('tool') LIMIT 30"
      ).all();

      const nodeList = allNodes.map(n => `${n.id} (${n.type}): ${n.description || n.label}`).join('\n');
      const orphanList = orphans.map(o => `${o.id} (${o.type}): ${o.description || o.label}`).join('\n');

      const response = await this._callLLM(
        `You connect sparse nodes in a knowledge graph. Given some orphan/low-connectivity nodes and the full node list, suggest edges that would meaningfully connect them.
Only suggest edges where a real relationship exists — don't force connections.
Edge types: knows, uses, created, related_to, manages, inspires, part_of, depends_on, similar_to
Return ONLY JSON: [{"source":"id","target":"id","type":"edge_type"}]
If no good connections exist, return: []`,
        `Orphan/sparse nodes:\n${orphanList}\n\nAll nodes:\n${nodeList}`
      );

      const edges = this._parseJSON(response, "connectSparseNodes");
      if (!Array.isArray(edges)) return;

      let created = 0;
      for (const edge of edges) {
        if (!edge.source || !edge.target || !edge.type) continue;
        if (edge.source === edge.target) continue;

        const srcExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(edge.source);
        const tgtExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(edge.target);
        if (!srcExists || !tgtExists) continue;

        const dup = this.db.prepare(
          'SELECT id FROM edges WHERE source = ? AND target = ? AND type = ?'
        ).get(edge.source, edge.target, edge.type);
        if (dup) continue;

        this.db.prepare(
          "INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?, ?, ?, 0.6, 'maintainer', 'inferred')"
        ).run(edge.source, edge.target, edge.type);
        graphEvents.emit('change', { op: 'edge:create', edge: { source: edge.source, target: edge.target, type: edge.type, confidence: 'inferred' }, source: 'maintainer' });
        created++;
      }

      if (created > 0) {
        this.stats.edgesCreated += created;
        this.log.info(`[maintainer] Connected ${created} sparse nodes`);
      }
    } catch (e) {
      this.log.error('[maintainer] Sparse connect error:', e.message);
    }
  }

  // ── Semantic Neighbor Connection ───────────────────────────────────────────

  async connectSemanticNeighbors(count = 4) {
    if (!this.db) return;

    try {
      const active = getActiveEmbedder();
      const providerFilter = active
        ? 'AND ((n.embedding_provider = ? AND n.embedding_dim = ?) OR (n.embedding_provider IS NULL AND n.embedding_dim IS NULL))'
        : '';
      const providerArgs = active ? [active.name, active.dim] : [];
      const rows = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description, n.importance, n.embedding,
               COALESCE(n.updated, n.extracted_at, n.created) AS touched_at,
               (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) AS degree,
               (
                 SELECT COUNT(*)
                 FROM edges e
                 JOIN nodes other ON other.id = CASE WHEN e.source = n.id THEN e.target ELSE e.source END
                 WHERE (e.source = n.id OR e.target = n.id)
                   AND other.type IN ('person', 'self', 'agent')
               ) AS person_edges,
               (
                 SELECT COUNT(*)
                 FROM edges e
                 WHERE (e.source = n.id OR e.target = n.id)
                   AND e.type NOT IN ('knows', 'owns', 'created', 'mentioned', 'discovered_in')
               ) AS semantic_edges
        FROM nodes n
        WHERE n.embedding IS NOT NULL
          AND n.embedding != ''
          ${providerFilter}
          AND n.id NOT LIKE 'ref-%'
          AND n.type NOT IN ('tool', 'reference', 'episode', 'message', 'session')
          AND (n.provenance = 'self' OR n.provenance IS NULL)
        ORDER BY n.importance DESC, touched_at DESC
        LIMIT 1200
      `).all(...providerArgs);

      if (rows.length < 2) return;

      const nodes = [];
      for (const row of rows) {
        const vec = this._parseEmbedding(row.embedding);
        if (!vec) continue;
        const semanticText = this._normalizeSemanticText(`${row.label} ${row.description || ''} ${this._buildNodeContext(row.id)}`);
        nodes.push({
          ...row,
          vec,
          semantic_text: semanticText,
          semantic_tokens: this._semanticTokens(semanticText),
          semantic_prefixes: this._extractEntityPrefixes(semanticText),
          degree: Number(row.degree || 0),
          person_edges: Number(row.person_edges || 0),
          semantic_edges: Number(row.semantic_edges || 0),
        });
      }
      if (nodes.length < 2) return;

      const existingPairs = this._loadExistingEdgePairs();
      const sources = this._semanticSourceNodes(nodes, count);
      const targetCandidates = Math.max(12, count * 8);
      const candidates = [];
      const seen = new Set();

      for (const source of sources) {
        for (const target of nodes) {
          if (source.id === target.id) continue;
          if (this._skipSemanticCandidate(source, target, existingPairs)) continue;

          const sim = this._cosine(source.vec, target.vec);
          if (sim < 0.52) continue;

          const lexical = this._semanticLexicalBoost(source, target);
          const typeBoost = this._semanticTypeBoost(source, target);
          const sparseBoost = source.semantic_edges === 0 || source.person_edges >= Math.max(1, source.degree - 1) ? 0.04 : 0;
          const score = sim + lexical + typeBoost + sparseBoost;
          const lowDegreeParentCandidate = source.degree <= 4 && typeBoost > 0;
          if (sim < 0.76 && score < 0.80 && !(lowDegreeParentCandidate && score >= 0.74)) continue;

          const key = [source.id, target.id].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ source, target, sim, score, lexical, typeBoost });
        }
      }

      if (candidates.length === 0) return;

      candidates.sort((a, b) => b.score - a.score || b.sim - a.sim);
      const shortlist = candidates.slice(0, targetCandidates);
      const shortlistPairs = new Set(shortlist.map(c => [c.source.id, c.target.id].sort().join('|')));
      const prompt = shortlist.map((c, idx) => {
        const sourceText = this._nodeSemanticText(c.source.id);
        const targetText = this._nodeSemanticText(c.target.id);
        return [
          `Candidate ${idx + 1}`,
          `A: ${c.source.id} | "${c.source.label}" (${c.source.type}, degree ${c.source.degree}, semantic_edges ${c.source.semantic_edges})`,
          this._truncate(sourceText, 700),
          `B: ${c.target.id} | "${c.target.label}" (${c.target.type}, degree ${c.target.degree}, semantic_edges ${c.target.semantic_edges})`,
          this._truncate(targetText, 700),
          `embedding_similarity=${c.sim.toFixed(3)} score=${c.score.toFixed(3)}`,
        ].join('\n');
      }).join('\n\n');

      const response = await this._callLLM(
        `You add missing semantic edges in a personal knowledge graph.
You are given candidate node pairs found by embedding similarity. Approve ONLY relationships that are clearly useful and supported by the labels/descriptions/aspects.
Do not merge nodes. Do not create duplicate person ownership edges. Prefer connecting a low-degree entity/device/file/account/event into the system, skill, project, registry, or concept it belongs to.
Allowed edge types: part_of, uses, depends_on, manages, configured_by, related_to, documents, implements, monitors.
Direction rules:
- part_of: child/source -> parent/target
- uses: actor/tool/system -> resource/system
- depends_on: dependent/source -> dependency/target
- configured_by: configured thing/source -> configuring system/skill/agent
- related_to: either direction, choose the more useful navigation direction
Return ONLY JSON:
[{"source":"node_id","target":"node_id","type":"edge_type","confidence":"inferred","reason":"brief"}]
Return [] if no candidate is strong enough.`,
        prompt
      );

      const approved = this._parseJSON(response, "connectSemanticNeighbors");
      if (!Array.isArray(approved)) return;

      const validIds = new Set(nodes.map(n => n.id));
      let created = 0;
      for (const edge of approved.slice(0, count)) {
        if (!edge?.source || !edge?.target || !edge?.type) continue;
        if (edge.source === edge.target) continue;
        if (!validIds.has(edge.source) || !validIds.has(edge.target)) continue;
        if (!shortlistPairs.has([edge.source, edge.target].sort().join('|'))) continue;
        if (!this._isAllowedSemanticEdgeType(edge.type)) continue;

        const srcExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(edge.source);
        const tgtExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(edge.target);
        if (!srcExists || !tgtExists) continue;

        const dup = this.db.prepare(
          'SELECT id FROM edges WHERE source = ? AND target = ? AND type = ?'
        ).get(edge.source, edge.target, edge.type);
        if (dup) continue;

        this.db.prepare(
          "INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?, ?, ?, 0.7, 'maintainer-semantic', 'inferred')"
        ).run(edge.source, edge.target, edge.type);
        graphEvents.emit('change', {
          op: 'edge:create',
          edge: { source: edge.source, target: edge.target, type: edge.type, confidence: 'inferred' },
          source: 'maintainer',
        });
        created++;
      }

      if (created > 0) {
        this.stats.edgesCreated += created;
        this.stats.semanticEdgesCreated += created;
        this.log.info(`[maintainer] Connected ${created} semantic neighbor edge(s)`);
      }
    } catch (e) {
      this.log.error('[maintainer] Semantic neighbor connect error:', e.message);
    }
  }

  // ── Community Detection ────────────────────────────────────────────────────

  /**
   * Run pure-JS Louvain over the current graph and persist communities into
   * node_groups / node_group_members. Gated by a node+edge-count delta:
   * if the graph has barely changed since the last run, skip — communities
   * are advisory and stale-by-a-cycle is fine.
   */
  async runCommunityDetection({ force = false } = {}) {
    if (!this.db) return null;
    try {
      const nodeCount = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get()?.c || 0;
      const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get()?.c || 0;

      // Need enough scaffolding to make community detection meaningful.
      if (nodeCount < 20 || edgeCount < 10) {
        this.log.debug?.(`[community] graph too small (${nodeCount}n / ${edgeCount}e) — skipping`);
        return null;
      }

      const lastNode = this._lastCommunityNodeCount ?? 0;
      const lastEdge = this._lastCommunityEdgeCount ?? 0;
      const delta = Math.abs(nodeCount - lastNode) + Math.abs(edgeCount - lastEdge);
      if (!force && delta < 50 && this._lastCommunityRunAt) {
        this.log.debug?.(`[community] only ${delta} graph deltas since last run — skipping`);
        return null;
      }

      const { runCommunityDetection } = require('./community');
      const result = runCommunityDetection(this.db, this.log);

      this._lastCommunityRunAt = Date.now();
      this._lastCommunityNodeCount = nodeCount;
      this._lastCommunityEdgeCount = edgeCount;
      this.stats.communities = result.communityCount;

      return result;
    } catch (e) {
      this.log.error('[maintainer] Community detection error:', e.message);
      return null;
    }
  }

  // ── Graph Overview ─────────────────────────────────────────────────────────

  /**
   * Compute the graph overview (god nodes / surprising bridges / suggested
   * questions) and persist it to graph_overviews. Runs after community
   * detection so the bridge-scorer has community memberships to work with.
   * Same change-counter gate — overview runs are advisory and reusing
   * yesterday's payload is fine if the graph hasn't moved much.
   */
  async runGraphOverview({ force = false } = {}) {
    if (!this.db) return null;
    try {
      const nodeCount = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get()?.c || 0;
      const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get()?.c || 0;

      if (nodeCount < 20 || edgeCount < 10) {
        this.log.debug?.(`[overview] graph too small (${nodeCount}n / ${edgeCount}e) — skipping`);
        return null;
      }

      const lastNode = this._lastOverviewNodeCount ?? 0;
      const lastEdge = this._lastOverviewEdgeCount ?? 0;
      const delta = Math.abs(nodeCount - lastNode) + Math.abs(edgeCount - lastEdge);
      if (!force && delta < 25 && this._lastOverviewRunAt) {
        this.log.debug?.(`[overview] only ${delta} graph deltas since last run — skipping`);
        return null;
      }

      const { computeOverview } = require('./overview');
      const result = computeOverview(this.db, this.log);

      this._lastOverviewRunAt = Date.now();
      this._lastOverviewNodeCount = nodeCount;
      this._lastOverviewEdgeCount = edgeCount;

      return result;
    } catch (e) {
      this.log.error('[maintainer] Graph overview error:', e.message);
      return null;
    }
  }

  // ── Duplicate Node Merging ──────────────────────────────────────────────────

  async mergeNodes(batchSize = 5) {
    if (!this.db) return;
    try {
      // Prioritize recently created nodes — they're most likely to be duplicates
      const freshNodes = this.db.prepare(
        "SELECT id, label, type, embedding, extracted_at FROM nodes WHERE embedding IS NOT NULL AND embedding != '' AND extracted_at > datetime('now', '-24 hours') ORDER BY extracted_at DESC LIMIT 50"
      ).all();
      const olderNodes = this.db.prepare(
        "SELECT id, label, type, embedding FROM nodes WHERE embedding IS NOT NULL AND embedding != '' ORDER BY importance DESC LIMIT 500"
      ).all();

      const freshIds = new Set(freshNodes.map(n => n.id));
      const allNodes = [...freshNodes, ...olderNodes.filter(n => !freshIds.has(n.id))];
      const reviewNodes = this._loadMergeReviewNodes();
      if (allNodes.length < 2 && reviewNodes.length < 2) return;

      const candidates = [];
      const candidateKeys = new Set();
      const targetCandidates = Math.max(50, batchSize * 12);

      this._seedExactLabelMergeCandidates(reviewNodes.length ? reviewNodes : allNodes, candidates, candidateKeys);
      await this._seedReasonedMergeCandidates(reviewNodes, candidates, candidateKeys, batchSize);

      // Phase 1: compare every fresh node against ALL other nodes (aggressive)
      for (const fresh of freshNodes) {
        let emb_f;
        try { emb_f = JSON.parse(fresh.embedding); } catch { continue; }
        for (const other of allNodes) {
          if (other.id === fresh.id) continue;
          if (candidates.length >= targetCandidates) break;
          let emb_o;
          try { emb_o = JSON.parse(other.embedding); } catch { continue; }
          const sim = this._cosine(emb_f, emb_o);
          if (sim >= 0.85) {
            this._addMergeCandidate(candidates, candidateKeys, fresh, other, sim);
          }
        }
      }

      // Phase 2: pairwise scan of remaining nodes at higher threshold
      for (let i = 0; i < allNodes.length && candidates.length < targetCandidates; i++) {
        if (freshIds.has(allNodes[i].id)) continue;
        let emb_i;
        try { emb_i = JSON.parse(allNodes[i].embedding); } catch { continue; }
        for (let j = i + 1; j < allNodes.length && candidates.length < targetCandidates; j++) {
          if (freshIds.has(allNodes[j].id)) continue;
          let emb_j;
          try { emb_j = JSON.parse(allNodes[j].embedding); } catch { continue; }
          const sim = this._cosine(emb_i, emb_j);
          if (sim >= 0.92) {
            this._addMergeCandidate(candidates, candidateKeys, allNodes[i], allNodes[j], sim);
          }
        }
      }

      if (candidates.length === 0) return;

      // Deduplicate pairs (avoid A-B and B-A)
      const seen = new Set();
      const unique = [];
      for (const c of candidates) {
        const key = [c.a.id, c.b.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
      }
      unique.sort((x, y) =>
        (y.auto ? 1 : 0) - (x.auto ? 1 : 0) ||
        (y.reasoned ? 1 : 0) - (x.reasoned ? 1 : 0) ||
        y.sim - x.sim
      );

      let merged = 0;
      for (const pair of unique) {
        try {
          const aExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(pair.a.id);
          const bExists = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(pair.b.id);
          if (!aExists || !bExists) continue;
          const ctxA = this._buildNodeContext(pair.a.id);
          const ctxB = this._buildNodeContext(pair.b.id);
          let result = pair.auto
            ? { same: true, reason: pair.reason || 'normalized labels match' }
            : null;

          if (!result) {
            const prompt = `Two nodes in a knowledge graph may refer to the same real-world entity.

Node A: "${pair.a.label}" (${pair.a.type})
${ctxA}

Node B: "${pair.b.label}" (${pair.b.type})
${ctxB}

${pair.reasoned ? `Inventory review reason: ${pair.reason || 'candidate proposed by full-node inventory review'}\n` : ''}Embedding similarity: ${pair.reasoned ? 'not used for this candidate' : pair.sim.toFixed(3)}

Do these two nodes refer to the SAME real-world entity/concept? Consider that the same place, person, or thing can have multiple names or partial names. Answer ONLY with JSON:
{"same": true/false, "reason": "brief explanation"}`;

            const response = await this._callLLM(
              'You are a knowledge graph deduplication judge. Determine if two nodes refer to the same entity. Consider aliases, abbreviations, and partial names.',
              prompt
            );
            result = this._parseJSON(response, "mergeNodes");
          }
          if (!result || !result.same) continue;

          const attrsA = this.db.prepare('SELECT COUNT(*) as c FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = ?').get(pair.a.id).c;
          const attrsB = this.db.prepare('SELECT COUNT(*) as c FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = ?').get(pair.b.id).c;
          const extraA = parseExtra(this.db.prepare('SELECT extra FROM nodes WHERE id = ?').get(pair.a.id)?.extra);
          const extraB = parseExtra(this.db.prepare('SELECT extra FROM nodes WHERE id = ?').get(pair.b.id)?.extra);
          const candidateA = extraA.lifecycle === 'candidate';
          const candidateB = extraB.lifecycle === 'candidate';
          const [canonical, duplicate] = candidateA !== candidateB
            ? (candidateA ? [pair.b, pair.a] : [pair.a, pair.b])
            : (attrsA >= attrsB ? [pair.a, pair.b] : [pair.b, pair.a]);
          const preferredLabel = this._preferredMergeLabel(canonical, duplicate);

          this._mergeNodeInto(canonical.id, duplicate.id);
          if (preferredLabel && preferredLabel !== canonical.label) {
            try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(canonical.id, canonical.label); } catch (e) { this.log.warn('[maintainer] db.prepare failed: ' + e.message); }
            try { this.db.prepare("UPDATE nodes SET label = ?, updated = datetime('now') WHERE id = ?").run(preferredLabel, canonical.id); } catch (e) { this.log.warn('[maintainer] db.prepare failed: ' + e.message); }
            canonical.label = preferredLabel;
          }
          merged++;
          const basis = pair.reasoned ? 'reasoned-inventory' : `sim=${pair.sim.toFixed(3)}`;
          this.log.info(`[maintainer] Merged duplicate: "${duplicate.label}" → "${canonical.label}" (${basis}, reason: ${result.reason})`);
          graphEvents.emit('change', { op: 'node:merge', canonicalId: canonical.id, duplicateId: duplicate.id, source: 'maintainer' });
        } catch (e) {
          this.log.debug?.(`[maintainer] Merge pair failed: ${e.message}`);
        }
      }

      if (merged > 0) {
        this.stats.merged = (this.stats.merged || 0) + merged;
        this.log.info(`[maintainer] Merged ${merged} duplicate node pairs`);
      }
    } catch (e) {
      this.log.error('[maintainer] mergeNodes error:', e.message);
    }
  }

  _addMergeCandidate(candidates, seen, a, b, sim, extra = {}) {
    if (!a?.id || !b?.id || a.id === b.id) return false;
    const key = [a.id, b.id].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    candidates.push({ a, b, sim, ...extra });
    return true;
  }

  _seedExactLabelMergeCandidates(nodes, candidates, seen) {
    const buckets = new Map();
    for (const node of nodes || []) {
      if (!node?.id || String(node.id).startsWith('ref-')) continue;
      const key = this._normalizedMergeLabel(node.label);
      if (!key) continue;
      const bucket = buckets.get(key) || [];
      bucket.push(node);
      buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          this._addMergeCandidate(candidates, seen, bucket[i], bucket[j], 1, {
            auto: true,
            reason: `normalized label match: ${key}`,
          });
        }
      }
    }
  }

  _loadMergeReviewNodes() {
    if (!this.db) return [];
    try {
      const total = this.db.prepare(`
        SELECT COUNT(*) AS c
        FROM nodes
        WHERE id NOT LIKE 'ref-%'
          AND type NOT IN ('tool', 'reference', 'episode', 'message', 'session')
          AND (provenance = 'self' OR provenance IS NULL)
      `).get()?.c || 0;
      if (total < 2) return [];

      const limit = Math.max(50, Math.min(500, Number(this.config.maintainerMergeInventoryLimit || 350)));
      const rows = this.db.prepare(`
        SELECT n.id, n.label, n.type, n.description, n.importance, n.embedding, n.extra,
               COALESCE(n.updated, n.extracted_at, n.created) AS touched_at,
               (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) AS degree
        FROM nodes n
        WHERE n.id NOT LIKE 'ref-%'
          AND n.type NOT IN ('tool', 'reference', 'episode', 'message', 'session')
          AND (n.provenance = 'self' OR n.provenance IS NULL)
        ORDER BY
          CASE WHEN n.extra LIKE '%"lifecycle":"candidate"%' THEN 0 ELSE 1 END,
          CASE WHEN (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) <= 4 THEN 0 ELSE 1 END,
          n.importance DESC,
          touched_at DESC
        LIMIT ?
      `).all(limit);

      for (const row of rows) {
        row.degree = Number(row.degree || 0);
        row.total_graph_nodes = Number(total);
      }
      return rows;
    } catch (e) {
      this.log.debug?.(`[maintainer] merge inventory load failed: ${e.message}`);
      return [];
    }
  }

  async _seedReasonedMergeCandidates(nodes, candidates, seen, batchSize = 5) {
    if (!Array.isArray(nodes) || nodes.length < 2) return;
    try {
      const maxGroups = Math.max(4, Math.min(12, batchSize * 2));
      const byId = new Map(nodes.map(n => [n.id, n]));
      const total = nodes[0]?.total_graph_nodes || nodes.length;
      const listed = nodes.length;
      const nodeList = nodes.map(n => this._mergeInventoryLine(n)).join('\n');

      const response = await this._callLLM(
        `You review a knowledge graph node inventory for duplicate or fragmented nodes.
Find merge groups using reasoning over labels, types, descriptions, aliases, aspects, and obvious naming variants. Do NOT rely on embedding similarity.
Only propose merges when nodes are the same real-world entity, account, project, device, concept, or artifact.
Do NOT merge parent/child relationships, systems with their devices, a person with things they own, related but distinct projects, or broad categories with examples.
Return ONLY JSON:
{"groups":[{"canonical":"node_id","duplicates":["node_id"],"reason":"why they are the same"}]}
Return {"groups":[]} if no safe merges are visible. Max ${maxGroups} groups.`,
        `Total graph nodes: ${total}
Listed nodes for this review: ${listed}${listed < total ? ' (bounded inventory window for prompt safety)' : ' (full graph inventory)'}

Nodes:
${nodeList}`
      );

      const parsed = this._parseJSON(response, "_seedReasonedMergeCandidates");
      const groups = Array.isArray(parsed) ? parsed : parsed?.groups;
      if (!Array.isArray(groups) || groups.length === 0) return;

      let added = 0;
      for (const group of groups.slice(0, maxGroups)) {
        const ids = Array.isArray(group?.ids)
          ? group.ids
          : [group?.canonical, ...(Array.isArray(group?.duplicates) ? group.duplicates : [])];
        const uniqueIds = [...new Set(ids.filter(id => typeof id === 'string' && byId.has(id)))];
        if (uniqueIds.length < 2) continue;

        const canonicalId = byId.has(group?.canonical) ? group.canonical : uniqueIds[0];
        for (const id of uniqueIds) {
          if (id === canonicalId) continue;
          const ok = this._addMergeCandidate(candidates, seen, byId.get(canonicalId), byId.get(id), 0, {
            reasoned: true,
            reason: group.reason || 'candidate proposed by node inventory review',
          });
          if (ok) added++;
        }
      }

      if (added > 0) {
        this.stats.reasonedMergeCandidates += added;
        this.log.info(`[maintainer] Reasoned merge inventory proposed ${added} candidate pair(s)`);
      }
    } catch (e) {
      this.log.warn(`[maintainer] Reasoned merge inventory failed: ${e.message}`);
    }
  }

  _mergeInventoryLine(node) {
    const aliases = this._nodeAliases(node.id).slice(0, 4).join(', ');
    const aspects = this._nodeAspectNames(node.id).slice(0, 6).join(', ');
    const desc = this._truncate(String(node.description || '').replace(/\s+/g, ' ').trim(), 180);
    const lifecycle = parseExtra(node.extra).lifecycle || null;
    return [
      `- ${node.id}`,
      `label="${node.label}"`,
      `type=${node.type}`,
      lifecycle ? `lifecycle=${lifecycle}` : null,
      `importance=${node.importance || 0}`,
      `degree=${node.degree || 0}`,
      desc ? `desc="${desc}"` : null,
      aliases ? `aliases=[${aliases}]` : null,
      aspects ? `aspects=[${aspects}]` : null,
    ].filter(Boolean).join(' | ');
  }

  _nodeAliases(nodeId) {
    try {
      return this.db.prepare('SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias LIMIT 8')
        .all(nodeId)
        .map(r => r.alias)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  _nodeAspectNames(nodeId) {
    try {
      return this.db.prepare('SELECT name FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 10')
        .all(nodeId)
        .map(r => r.name)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  _normalizedMergeLabel(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const normalized = raw
      .replace(/['’]s\b/g, 's')
      .replace(/[()[\]{}]/g, ' ')
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length < 2 && normalized.length < 12) return '';
    return normalized;
  }

  _preferredMergeLabel(a, b) {
    const labelA = String(a?.label || '').trim();
    const labelB = String(b?.label || '').trim();
    if (!labelA || !labelB) return '';
    if (this._normalizedMergeLabel(labelA) !== this._normalizedMergeLabel(labelB)) return '';
    const score = (label) => {
      let s = 0;
      if (!/^(the|a|an)\s+/i.test(label)) s += 4;
      if (!/[()[\]{}]/.test(label)) s += 3;
      if (!/[_-]/.test(label)) s += 1;
      s += Math.max(0, 60 - label.length) / 20;
      return s;
    };
    return score(labelB) > score(labelA) ? labelB : labelA;
  }

  _cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < a.length; k++) {
      dot += a[k] * b[k];
      na += a[k] * a[k];
      nb += b[k] * b[k];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  _mergeNodeInto(canonicalId, duplicateId) {
    // Move aspects and attributes from duplicate to canonical
    const dupAspects = this.db.prepare('SELECT id, name FROM aspects WHERE node_id = ?').all(duplicateId);
    for (const dupAsp of dupAspects) {
      let canonAsp = this.db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(canonicalId, dupAsp.name);
      if (!canonAsp) {
        this.db.prepare('UPDATE aspects SET node_id = ? WHERE id = ?').run(canonicalId, dupAsp.id);
        continue;
      }
      // Merge attributes: move non-duplicate attrs
      const canonAttrs = this.db.prepare('SELECT content FROM attributes WHERE aspect_id = ?').all(canonAsp.id);
      const canonSet = new Set(canonAttrs.map(a => a.content.toLowerCase()));
      const dupAttrs = this.db.prepare('SELECT id, content FROM attributes WHERE aspect_id = ?').all(dupAsp.id);
      for (const attr of dupAttrs) {
        const lower = attr.content.toLowerCase();
        const isDup = canonSet.has(lower) || [...canonSet].some(ex => {
          if (ex.includes(lower) || lower.includes(ex)) return true;
          const newW = new Set(lower.split(/\s+/).filter(w => w.length > 2));
          const exW = new Set(ex.split(/\s+/).filter(w => w.length > 2));
          if (newW.size === 0 || exW.size === 0) return false;
          let overlap = 0;
          for (const w of newW) { if (exW.has(w)) overlap++; }
          return overlap / Math.min(newW.size, exW.size) >= 0.6;
        });
        if (!isDup) {
          this.db.prepare('UPDATE attributes SET aspect_id = ? WHERE id = ?').run(canonAsp.id, attr.id);
        }
      }
      // Delete remaining duplicate aspect attrs and the aspect
      this.db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(dupAsp.id);
      this.db.prepare('DELETE FROM aspects WHERE id = ?').run(dupAsp.id);
    }

    // Reparent edges
    const edges = this.db.prepare('SELECT id, source, target, type FROM edges WHERE source = ? OR target = ?').all(duplicateId, duplicateId);
    for (const e of edges) {
      const newSrc = e.source === duplicateId ? canonicalId : e.source;
      const newTgt = e.target === duplicateId ? canonicalId : e.target;
      if (newSrc === newTgt) { this.db.prepare('DELETE FROM edges WHERE id = ?').run(e.id); continue; }
      const exists = this.db.prepare('SELECT id FROM edges WHERE source = ? AND target = ? AND type = ?').get(newSrc, newTgt, e.type);
      if (exists) {
        this.db.prepare('DELETE FROM edges WHERE id = ?').run(e.id);
      } else {
        this.db.prepare('UPDATE edges SET source = ?, target = ? WHERE id = ?').run(newSrc, newTgt, e.id);
      }
    }

    // Add alias
    try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(canonicalId, this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(duplicateId)?.label); } catch (e) { this.log.warn('[maintainer] db.prepare failed: ' + e.message); }
    try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(canonicalId, duplicateId); } catch (e) { this.log.warn('[maintainer] db.prepare failed: ' + e.message); }

    // Delete duplicate node
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(duplicateId);

    // Re-embed canonical node with merged content
    try { embedNode(canonicalId, this.db); } catch (e) { this.log.warn('[maintainer] embedNode failed: ' + e.message); }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _buildNodeContext(nodeId) {
    try {
      const aspects = this.db.prepare(
        'SELECT id, name, weight FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 8'
      ).all(nodeId);

      const lines = [];
      for (const asp of aspects) {
        const attrs = this.db.prepare(
          'SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 6'
        ).all(asp.id);
        if (attrs.length > 0) {
          lines.push(`[${asp.name}] ${attrs.map(a => a.content).join(' | ')}`);
        }
      }

      const gaps = this.db.prepare(
        "SELECT content FROM gaps WHERE node_id = ? AND status = 'open' LIMIT 5"
      ).all(nodeId);
      if (gaps.length > 0) {
        lines.push(`[open gaps] ${gaps.map(g => g.content).join('; ')}`);
      }

      return lines.join('\n') || 'No context available.';
    } catch {
      return 'Context query failed.';
    }
  }

  _parseEmbedding(raw) {
    try {
      const vec = JSON.parse(raw);
      if (!Array.isArray(vec) || vec.length === 0) return null;
      if (!vec.every(v => Number.isFinite(Number(v)))) return null;
      return vec.map(Number);
    } catch {
      return null;
    }
  }

  _loadExistingEdgePairs() {
    const pairs = new Map();
    try {
      const rows = this.db.prepare('SELECT source, target, type FROM edges').all();
      for (const row of rows) {
        const key = [row.source, row.target].sort().join('|');
        if (!pairs.has(key)) pairs.set(key, new Set());
        pairs.get(key).add(row.type);
      }
    } catch {}
    return pairs;
  }

  _semanticSourceNodes(nodes, count) {
    const max = Math.max(30, count * 24);
    const lowDegree = nodes
      .filter(n => !['person', 'self', 'agent'].includes(n.type))
      .filter(n => n.degree <= 4 || n.semantic_edges <= 1 || n.person_edges >= Math.max(1, n.degree - 1));

    const sourceIds = new Set();
    const sources = [];
    const add = (node) => {
      if (!node || sourceIds.has(node.id) || sources.length >= max) return;
      sourceIds.add(node.id);
      sources.push(node);
    };

    lowDegree
      .sort((a, b) =>
        (a.semantic_edges - b.semantic_edges) ||
        (a.degree - b.degree) ||
        (b.importance - a.importance)
      )
      .forEach(add);

    // On small graphs, scan every non-person node so manual maintenance has
    // the "look at the whole graph" behavior users expect.
    if (nodes.length <= 250) {
      nodes
        .filter(n => !['person', 'self', 'agent'].includes(n.type))
        .sort((a, b) => b.importance - a.importance)
        .forEach(add);
    }

    return sources;
  }

  _skipSemanticCandidate(source, target, existingPairs) {
    if (!source || !target || source.id === target.id) return true;
    if (['person', 'self', 'agent'].includes(target.type)) return true;
    if (['person', 'self', 'agent'].includes(source.type) && ['person', 'self', 'agent'].includes(target.type)) return true;
    const pairKey = [source.id, target.id].sort().join('|');
    const types = existingPairs.get(pairKey);
    if (!types) return false;

    // Existing ownership/person edges are not enough semantic structure, but
    // an existing non-person semantic edge means this pair is already useful.
    for (const type of types) {
      if (!['knows', 'owns', 'created', 'mentioned', 'discovered_in'].includes(type)) {
        return true;
      }
    }
    return false;
  }

  _nodeSemanticText(nodeId) {
    try {
      return buildNodeText(this.db, nodeId) || this._buildNodeContext(nodeId);
    } catch {
      return this._buildNodeContext(nodeId);
    }
  }

  _semanticLexicalBoost(source, target) {
    const sourceText = source.semantic_text || this._normalizeSemanticText(`${source.label} ${source.description || ''}`);
    const targetText = target.semantic_text || this._normalizeSemanticText(`${target.label} ${target.description || ''}`);
    const sourceTokens = source.semantic_tokens || this._semanticTokens(sourceText);
    const targetTokens = target.semantic_tokens || this._semanticTokens(targetText);
    if (sourceTokens.length === 0 || targetTokens.length === 0) return 0;

    let overlap = 0;
    const targetSet = new Set(targetTokens);
    for (const token of sourceTokens) {
      if (targetSet.has(token)) overlap++;
    }

    const directLabelMention =
      targetText.includes(this._normalizeSemanticText(source.label)) ||
      sourceText.includes(this._normalizeSemanticText(target.label));
    const entityMention =
      (source.semantic_prefixes || this._extractEntityPrefixes(sourceText)).some(prefix => targetText.includes(prefix)) ||
      (target.semantic_prefixes || this._extractEntityPrefixes(targetText)).some(prefix => sourceText.includes(prefix));

    let boost = Math.min(0.08, overlap / Math.min(sourceTokens.length, targetTokens.length) * 0.08);
    if (directLabelMention) boost += 0.08;
    if (entityMention) boost += 0.06;
    return Math.min(0.18, boost);
  }

  _semanticTypeBoost(source, target) {
    const sourceTypes = new Set(['product', 'device', 'sensor', 'entity', 'account', 'file', 'system_event', 'system_state', 'planned_action']);
    const parentTypes = new Set(['project', 'system', 'service', 'device_registry', 'concept', 'skill', 'software_agent']);
    if (sourceTypes.has(source.type) && parentTypes.has(target.type)) return 0.06;
    if (source.type === 'project' && ['system', 'service', 'concept'].includes(target.type)) return 0.03;
    if (source.type === 'file' && ['project', 'system'].includes(target.type)) return 0.05;
    return 0;
  }

  _isAllowedSemanticEdgeType(type) {
    return new Set([
      'part_of', 'uses', 'depends_on', 'manages', 'configured_by',
      'related_to', 'documents', 'implements', 'monitors',
    ]).has(String(type || '').trim());
  }

  _normalizeSemanticText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[_./:-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _semanticTokens(value) {
    const stop = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'used',
      'user', 'node', 'system', 'status', 'current', 'main', 'skill',
    ]);
    return this._normalizeSemanticText(value)
      .split(/\s+/)
      .filter(token => token.length >= 4 && !stop.has(token))
      .slice(0, 80);
  }

  _extractEntityPrefixes(value) {
    const prefixes = [];
    const text = String(value || '').toLowerCase();
    const re = /\b(?:sensor|switch|light|climate|cover|lock|media_player|camera|binary_sensor)\.([a-z0-9_]+)/g;
    let match;
    while ((match = re.exec(text))) {
      const parts = match[1].split('_').filter(Boolean);
      for (let len = Math.min(parts.length, 4); len >= 2; len--) {
        prefixes.push(parts.slice(0, len).join(' '));
      }
    }
    return [...new Set(prefixes)].slice(0, 20);
  }

  _truncate(text, max = 1000) {
    const s = String(text || '');
    return s.length <= max ? s : `${s.slice(0, max)}...`;
  }

  // ── Formal Reasoning / Dreaming ─────────────────────────────────────────────

  async deriveInferences(count = 2) {
    if (!this.db) return;

    try {
      const totalDerived = this.db.prepare(
        "SELECT COUNT(*) as c FROM derived_facts WHERE invalidated_at IS NULL"
      ).get().c;
      if (totalDerived >= 40) return;

      await this._dreamDeductive(count);
      await this._dreamInductive(Math.max(1, count - 1));
      await this._dreamAbductive(1);
    } catch (e) {
      this.log.warn('[maintainer] deriveInferences error:', e.message);
    }
  }

  /**
   * Deductive reasoning: Given explicit premises from connected entities,
   * derive conclusions that necessarily follow.
   */
  async _dreamDeductive(count = 2) {
    const clusters = this.db.prepare(`
      SELECT e.source, e.target, e.type,
             ns.label as source_label, ns.type as source_type,
             nt.label as target_label, nt.type as target_type
      FROM edges e
      JOIN nodes ns ON ns.id = e.source
      JOIN nodes nt ON nt.id = e.target
      WHERE ns.type NOT IN ('tool', 'system', 'reference') AND nt.type NOT IN ('tool', 'system', 'reference')
        AND ns.importance >= 5 AND nt.importance >= 5
      ORDER BY ns.importance + nt.importance DESC
      LIMIT ?
    `).all(count * 4);

    if (clusters.length === 0) return;

    const candidatePairs = [];
    for (const cluster of clusters) {
      const existing = this.db.prepare(
        "SELECT id FROM derived_facts WHERE invalidated_at IS NULL AND reasoning_type = 'deductive' AND source_node_ids LIKE ? AND source_node_ids LIKE ? LIMIT 1"
      ).get(`%${cluster.source}%`, `%${cluster.target}%`);
      if (!existing) {
        candidatePairs.push(cluster);
        if (candidatePairs.length >= count) break;
      }
    }

    for (const pair of candidatePairs) {
      try {
        const srcCtx = this._buildNodeContext(pair.source);
        const tgtCtx = this._buildNodeContext(pair.target);

        const text = await this._callLLM(
          `You perform formal DEDUCTIVE reasoning over a knowledge graph. Given explicit facts (premises) about related entities, derive conclusions that NECESSARILY follow from the premises. Only state what is logically certain — no speculation.

Return ONLY valid JSON:
{
  "conclusions": [
    {
      "premises": ["premise 1 (exact fact used)", "premise 2"],
      "conclusion": "what necessarily follows",
      "confidence": "high"
    }
  ]
}
Return {"conclusions":[]} if no deductive conclusions can be drawn. Max 3 conclusions.`,
          `Entity A: "${pair.source_label}" (${pair.source_type}) — connected to B via "${pair.type}"
${srcCtx}

Entity B: "${pair.target_label}" (${pair.target_type})
${tgtCtx}`
        );

        const result = this._parseJSON(text, "_dreamDeductive");
        if (!result?.conclusions?.length) continue;

        const sourceNodeIds = JSON.stringify([pair.source, pair.target]);
        for (const c of result.conclusions.slice(0, 3)) {
          if (!c.conclusion || c.conclusion.length < 10) continue;
          this.db.prepare(
            "INSERT INTO derived_facts (content, source_node_ids, confidence, reasoning_type, premises) VALUES (?, ?, ?, 'deductive', ?)"
          ).run(c.conclusion, sourceNodeIds, c.confidence || 'high', JSON.stringify(c.premises || []));
          this.stats.derived = (this.stats.derived || 0) + 1;
          graphEvents.emit('change', { op: 'derived:create', content: c.conclusion, reasoningType: 'deductive', sourceNodeIds, source: 'maintainer' });
        }
      } catch (e) {
        this.log.warn(`[maintainer] Deductive reasoning failed for ${pair.source}↔${pair.target}: ${e.message}`);
      }
    }
  }

  /**
   * Inductive reasoning: Identify patterns across multiple entities/facts.
   * Looks for recurring themes, habits, preferences — things only visible
   * in aggregate across many data points.
   */
  async _dreamInductive(count = 1) {
    const personNodes = this.db.prepare(`
      SELECT n.id, n.label, n.type
      FROM nodes n
      WHERE n.type IN ('person', 'agent') AND n.importance >= 5
        AND (n.provenance = 'self' OR n.provenance IS NULL)
      ORDER BY n.importance DESC, n.updated DESC
      LIMIT 5
    `).all();

    if (personNodes.length === 0) return;

    const existing = this.db.prepare(
      "SELECT content FROM derived_facts WHERE reasoning_type = 'inductive' AND invalidated_at IS NULL ORDER BY created DESC LIMIT 10"
    ).all().map(r => r.content);

    for (const person of personNodes.slice(0, count)) {
      try {
        const aspects = this.db.prepare(`
          SELECT asp.name, GROUP_CONCAT(a.content, ' | ') as facts
          FROM aspects asp
          JOIN attributes a ON a.aspect_id = asp.id
          WHERE asp.node_id = ?
          GROUP BY asp.name
          ORDER BY asp.weight DESC
          LIMIT 12
        `).all(person.id);

        if (aspects.length < 2) continue;

        const relatedNodes = this.db.prepare(`
          SELECT n.label, n.type, e.type as edge_type
          FROM edges e JOIN nodes n ON n.id = e.target
          WHERE e.source = ? AND n.type NOT IN ('tool', 'system', 'reference')
          LIMIT 10
        `).all(person.id);

        const factsBlock = aspects.map(a => `[${a.name}] ${a.facts}`).join('\n');
        const relBlock = relatedNodes.map(r => `→ ${r.label} (${r.type}, ${r.edge_type})`).join('\n');
        const existingStr = existing.length ? `\nAlready derived (do not duplicate):\n${existing.join('\n')}` : '';

        const text = await this._callLLM(
          `You perform formal INDUCTIVE reasoning. Given many facts about an entity, identify PATTERNS that emerge across multiple data points. These are probabilistic conclusions — things that are likely true based on repeated evidence, not stated explicitly anywhere.

Focus on: behavioral patterns, underlying motivations, lifestyle inferences, personality traits that emerge from actions, recurring themes across different contexts.

Return ONLY valid JSON:
{
  "patterns": [
    {
      "evidence": ["fact 1 used as evidence", "fact 2", "fact 3"],
      "pattern": "the inductive conclusion / pattern identified",
      "confidence": "high|medium"
    }
  ]
}
Return {"patterns":[]} if no meaningful patterns emerge. Max 2 patterns. Each must cite 2+ pieces of evidence.`,
          `Entity: "${person.label}" (${person.type})

Facts:
${factsBlock}

Relationships:
${relBlock || 'none'}${existingStr}`
        );

        const result = this._parseJSON(text, "_dreamInductive");
        if (!result?.patterns?.length) continue;

        const sourceNodeIds = JSON.stringify([person.id]);
        for (const p of result.patterns.slice(0, 2)) {
          if (!p.pattern || p.pattern.length < 10) continue;
          if (existing.some(ex => ex.toLowerCase().includes(p.pattern.toLowerCase().substring(0, 30)))) continue;
          this.db.prepare(
            "INSERT INTO derived_facts (content, source_node_ids, confidence, reasoning_type, premises) VALUES (?, ?, ?, 'inductive', ?)"
          ).run(p.pattern, sourceNodeIds, p.confidence || 'medium', JSON.stringify(p.evidence || []));
          this.stats.derived = (this.stats.derived || 0) + 1;
          existing.push(p.pattern);
          graphEvents.emit('change', { op: 'derived:create', content: p.pattern, reasoningType: 'inductive', sourceNodeIds, source: 'maintainer' });
        }
      } catch (e) {
        this.log.warn(`[maintainer] Inductive reasoning failed for ${person.id}: ${e.message}`);
      }
    }
  }

  /**
   * Abductive reasoning: Given observed behavior or facts, infer the simplest
   * explanation. "Inference to the best explanation" — why someone does what
   * they do, what their unstated goals might be.
   */
  async _dreamAbductive(count = 1) {
    const recentDerived = this.db.prepare(
      "SELECT content, source_node_ids, reasoning_type FROM derived_facts WHERE invalidated_at IS NULL ORDER BY created DESC LIMIT 15"
    ).all();

    const recentReflections = this.db.prepare(
      "SELECT r.content, r.node_id, n.label FROM reflections r JOIN nodes n ON n.id = r.node_id ORDER BY r.updated DESC LIMIT 8"
    ).all();

    if (recentDerived.length < 2 && recentReflections.length < 2) return;

    const derivedBlock = recentDerived.map(d => `[${d.reasoning_type || 'derived'}] ${d.content}`).join('\n');
    const reflectionBlock = recentReflections.map(r => `[reflection on ${r.label}] ${r.content}`).join('\n');

    try {
      const text = await this._callLLM(
        `You perform ABDUCTIVE reasoning — "inference to the best explanation." Given a set of observations (derived facts, reflections, patterns), propose the simplest explanation that accounts for multiple observations at once. These are hypotheses, not certainties.

Focus on: underlying motivations, unspoken goals, personality dynamics, relationship dynamics, lifestyle choices that explain multiple behaviors.

Return ONLY valid JSON:
{
  "hypotheses": [
    {
      "observations": ["observation 1 this explains", "observation 2"],
      "hypothesis": "the simplest explanation that accounts for these observations",
      "confidence": "medium|low"
    }
  ]
}
Return {"hypotheses":[]} if no compelling explanations emerge. Max 2 hypotheses. Each must explain 2+ observations.`,
        `Recent derived facts and reflections:

Derived facts:
${derivedBlock || 'none yet'}

Reflections:
${reflectionBlock || 'none yet'}`
      );

      const result = this._parseJSON(text, "_dreamAbductive");
      if (!result?.hypotheses?.length) return;

      const allNodeIds = new Set();
      for (const d of recentDerived) {
        try { JSON.parse(d.source_node_ids).forEach(id => allNodeIds.add(id)); } catch { /* silent: malformed JSON → fallback */ }
      }
      for (const r of recentReflections) allNodeIds.add(r.node_id);
      const sourceNodeIds = JSON.stringify([...allNodeIds].slice(0, 5));

      for (const h of result.hypotheses.slice(0, count)) {
        if (!h.hypothesis || h.hypothesis.length < 15) continue;
        this.db.prepare(
          "INSERT INTO derived_facts (content, source_node_ids, confidence, reasoning_type, premises) VALUES (?, ?, ?, 'abductive', ?)"
        ).run(h.hypothesis, sourceNodeIds, h.confidence || 'low', JSON.stringify(h.observations || []));
        this.stats.derived = (this.stats.derived || 0) + 1;
        graphEvents.emit('change', { op: 'derived:create', content: h.hypothesis, reasoningType: 'abductive', sourceNodeIds, source: 'maintainer' });
      }
    } catch (e) {
      this.log.warn('[maintainer] Abductive reasoning error:', e.message);
    }
  }

  // ── Auto-Expiry for Episodic Attributes (Win 4) ──────────────────────────

  async expireEpisodicAttributes(limit = 10) {
    if (!this.db) return;

    const EPHEMERAL_PATTERNS = /\b(appointment|scheduled|reminder|deadline|due\b|pickup by|expires on|reservation|booking|meeting at|class at|session at)\b/i;

    try {
      const candidates = this.db.prepare(`
        SELECT a.id, a.content, a.event_date
        FROM attributes a
        WHERE a.event_date IS NOT NULL
          AND a.event_date < date('now', '-1 day')
          AND a.importance > 0
        LIMIT ?
      `).all(limit * 3);

      if (candidates.length === 0) return;

      const stmt = this.db.prepare('UPDATE attributes SET importance = 0 WHERE id = ?');
      let expired = 0;
      for (const attr of candidates) {
        if (EPHEMERAL_PATTERNS.test(attr.content)) {
          stmt.run(attr.id);
          expired++;
          if (expired >= limit) break;
        }
      }

      if (expired > 0) {
        this.stats.expired = (this.stats.expired || 0) + expired;
        this.log.info(`[maintainer] Expired ${expired} ephemeral attribute(s) past event date`);
      }
    } catch (e) {
      this.log.warn('[maintainer] expireEpisodicAttributes error:', e.message);
    }
  }

  async embedUnembeddedNodes(limit = 5) {
    if (!this.db) return;
    // Picks up: rows that are unembedded, AND rows whose stored
    // embedding was produced by a provider/dim that no longer matches
    // the active embedder. The latter handles operator-driven provider
    // switches (e.g. uninstall gemini-embedder, install embedder-gemma)
    // — vectorSearch ignores stale-tagged rows, this loop rebuilds them
    // at idle time, eventually restoring full coverage.
    const active = getActiveEmbedder();
    if (!active) return; // no embedder plugin installed/configured — skip

    try {
      for (const col of [
        'ALTER TABLE nodes ADD COLUMN embedding TEXT',
        'ALTER TABLE nodes ADD COLUMN embedding_provider TEXT',
        'ALTER TABLE nodes ADD COLUMN embedding_dim INTEGER',
      ]) {
        try { this.db.exec(col); } catch (e) {
          if (!String(e.message || '').includes('duplicate column')) throw e;
        }
      }
      const rows = this.db.prepare(`
        SELECT id FROM nodes
        WHERE embedding IS NULL
           OR embedding_provider IS NULL
           OR embedding_provider != ?
           OR embedding_dim != ?
        LIMIT ?
      `).all(active.name, active.dim, limit);

      if (rows.length === 0) return;

      this.log.info(`[maintainer] Embedding ${rows.length} node(s) via ${active.name}...`);
      for (const row of rows) {
        try {
          await embedNode(row.id, this.db);
          this.stats.nodesEmbedded = (this.stats.nodesEmbedded || 0) + 1;
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          this.log.warn(`[maintainer] Failed to embed ${row.id}: ${e.message}`);
        }
      }
    } catch (e) {
      this.log.warn('[maintainer] embedUnembeddedNodes error:', e.message);
    }
  }

  // Returns true when at least one model tier resolves to a provider whose
  // credentials are present. Used to gate maintenance cycles on a fresh
  // install where no onboarding has run yet.
  _hasUsableModel() {
    const c = this.config || {};
    const tiers = [c.plannerModel, c.normalModel, c.casualModel, c.subagentModel, c.learnerModel].filter(Boolean);
    if (!tiers.length) return false;
    for (const tier of tiers) {
      const ref = String(tier);
      const slash = ref.indexOf('/');
      const prefix = slash > 0 ? ref.slice(0, slash) : '';
      // Anthropic-style bare model name → needs anthropicApiKey
      if (!prefix || prefix === 'anthropic') { if (c.anthropicApiKey) return true; continue; }
      if (prefix === 'openai') { if (c.openaiApiKey) return true; continue; }
      if (prefix === 'openrouter') { if (c.openrouterApiKey) return true; continue; }
      if (prefix === 'local') { if (c.localModelBaseUrl) return true; continue; }
      // Custom OAI-compatible provider (any other prefix)
      if (c.customProviders && c.customProviders[prefix]) return true;
    }
    return false;
  }

  _isFactualGap(content) {
    const factualPatterns = /\b(what|where|when|who|how many|which|version|url|address|name of)\b/i;
    return factualPatterns.test(content);
  }

  async _webSearch(query, count = 3) {
    // Use the shared helper — SearXNG first, Brave fallback. Stays in sync
    // with the web_search tool.
    const { searchWeb } = require('../lib/web-search');
    const searxngUrl = this.config.searxngUrl || process.env.SEARXNG_URL || '';
    const searxngApiKey = this.config.searxngApiKey || process.env.SEARXNG_API_KEY || '';
    const braveApiKey = this.config.braveApiKey || '';
    if (!searxngUrl && !braveApiKey) return [];
    try {
      const res = await searchWeb({ query, count, searxngUrl, searxngApiKey, braveApiKey, log: this.log });
      return Array.isArray(res?.results) ? res.results : [];
    } catch { return []; }
  }

  async _callLLM(systemPrompt, prompt) {
    const { wrapSystemPromptForModel } = require('../providers');
    const system = wrapSystemPromptForModel(
      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      this.model,
      this.config,
    );

    // Use streaming: non-streaming requests keep the HTTP connection idle
    // while the model thinks, which trips nginx's default 60s idle timeout
    // (→ HTTP 504) on slow reasoning models like Qwen. Streaming sends
    // tokens continuously so the connection stays warm.
    //
    // MultiProvider.messages.stream() returns { on, abort, finalMessage } —
    // NOT an async iterable. finalMessage() resolves with the full result
    // once the stream finishes, while the underlying HTTP connection is
    // fed a continuous token stream the whole time.
    const params = {
      model: this.model,
      max_tokens: 16384,
      system,
      messages: [{ role: 'user', content: prompt }],
    };
    let text = '';
    try {
      const stream = this.client.messages.stream(params);
      if (stream && typeof stream.finalMessage === 'function') {
        const result = await stream.finalMessage();
        text = (result?.content || []).find(b => b.type === 'text')?.text || '';
      } else if (stream && typeof stream.on === 'function') {
        // Older shape: fall back to listener-based collection
        await new Promise((resolve, reject) => {
          stream.on('text', chunk => { text += chunk; });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      } else {
        // Shape we don't recognize — fall back to non-streaming
        const response = await this.client.messages.create(params);
        text = response.content.find(b => b.type === 'text')?.text || '';
      }
    } catch (e) {
      this.log.debug?.('[maintainer] stream failed, falling back to create():', e?.message);
      const response = await this.client.messages.create(params);
      text = response.content.find(b => b.type === 'text')?.text || '';
    }
    return text;
  }

  _parseJSON(text, context = 'unknown') {
    if (!text || !String(text).trim()) {
      this.log.debug?.(`[maintainer] _parseJSON (${context}): empty response from LLM`);
      return null;
    }
    try {
      // Strip markdown fences AND extract the JSON blob from a longer response
      // (Qwen emits "<reasoning>\n\n{...json...}" — pull out the first {...} or [...])
      let cleaned = String(text).replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      if (cleaned[0] !== '{' && cleaned[0] !== '[') {
        const m = cleaned.match(/[\{\[][\s\S]*[\}\]]/);
        if (m) cleaned = m[0];
      }
      return JSON.parse(cleaned);
    } catch (e) {
      this.log.warn(`[maintainer] _parseJSON (${context}) failed: ${e.message} | head: ${String(text).slice(0,180).replace(/\n/g,' ')}`);
      return null;
    }
  }

  // Proactive outreach is handled by ProactiveEngine (see ./proactive.js)
  // Backward-compatible delegate
  async maybeProactiveAction(cycleSummary, channelHints) {
    return this.proactive.maybeAction(cycleSummary, channelHints);
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = { Maintainer };
