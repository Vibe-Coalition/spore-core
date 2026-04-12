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
const { embedNode } = require('../graph/embedder');
const { ProactiveEngine } = require('./proactive');

const DECAY_DAYS = {
  system: 14, process: 14, tool: 21, project: 30, channel: 30,
  person: 90, agent: 120, concept: 365, lore: 365, default: 45,
};

class Maintainer {
  constructor(config, log, anthropicClient, db) {
    this.config = config;
    this.log = log;
    this.client = anthropicClient;
    this.db = db;
    this.model = config.learnerModel || 'claude-haiku-4-5';
    this._isOAuth = config._isOAuth || false;
    this._running = false;
    this._lastGraphChangeAt = 0;
    this._lastCreativeRunAt = 0;

    graphEvents.on('change', (evt) => {
      if (evt?.source === 'maintainer') return;
      this._lastGraphChangeAt = Date.now();
    });

    this.stats = {
      cycles: 0, gapsDetected: 0, gapsFilled: 0, gapsDormant: 0,
      reflections: 0, staleMarked: 0, edgesCreated: 0, errors: 0,
    };

    this.proactive = new ProactiveEngine(this);
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

      // Derived facts table with formal reasoning support
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
        CREATE INDEX IF NOT EXISTS idx_derived_facts_created ON derived_facts(created);
        CREATE INDEX IF NOT EXISTS idx_derived_facts_type ON derived_facts(reasoning_type);
      `);

      const dfCols = this.db.prepare("PRAGMA table_info(derived_facts)").all().map(c => c.name);
      if (!dfCols.includes('reasoning_type')) {
        this.db.exec("ALTER TABLE derived_facts ADD COLUMN reasoning_type TEXT DEFAULT 'derived'");
        this.db.exec("ALTER TABLE derived_facts ADD COLUMN premises TEXT");
      }
    } catch (e) {
      this.log.warn('[maintainer] Schema migration:', e.message);
    }
  }

  // ── Main cycle ──────────────────────────────────────────────────────────────

  async runMaintenance() {
    if (this._running) {
      this.log.debug('[maintainer] Skipping — already running');
      return null;
    }

    // Cooldown: don't run if last cycle was less than 30 minutes ago
    const minIntervalMs = (this.config.maintainerMinIntervalMinutes || 30) * 60_000;
    if (this._lastRunAt && (Date.now() - this._lastRunAt) < minIntervalMs) {
      const minsAgo = Math.round((Date.now() - this._lastRunAt) / 60000);
      this.log.info(`[maintainer] Skipping — last ran ${minsAgo}m ago (min interval: ${Math.round(minIntervalMs / 60000)}m)`);
      return null;
    }

    this._running = true;
    this._lastRunAt = Date.now();
    const start = Date.now();

    const before = { ...this.stats };

    try {
      const graphChanged = this._lastGraphChangeAt > this._lastCreativeRunAt;

      if (!graphChanged) {
        this.log.info('[maintainer] Skipping — no graph changes since last full cycle');
        await this.expireEpisodicAttributes(10);
        await this.embedUnembeddedNodes(5);
      } else {
        this.log.info('[maintainer] Starting full maintenance cycle...');
        this._lastCreativeRunAt = Date.now();

        await this.detectNewGaps(2);
        await this.fillGaps(3);
        await this.reflectOnNodes(1);
        await this.checkStale(3);
        await this.connectSparseNodes(2);
        await this.mergeNodes(3);
        await this.deriveInferences(2);
        await this.expireEpisodicAttributes(10);
        await this.embedUnembeddedNodes(5);
      }

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
      };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[maintainer] Cycle error:', e.message);
      return null;
    } finally {
      this._running = false;
    }
  }

  // ── Gap Detection ───────────────────────────────────────────────────────────

  async detectNewGaps(count = 2) {
    if (!this.db) return;

    try {
      // Don't generate more gaps if we already have too many open
      const totalOpen = this.db.prepare("SELECT COUNT(*) as c FROM gaps WHERE status = 'open'").get().c;
      if (totalOpen > 50) {
        this.log.info(`[maintainer] Skipping gap detection — ${totalOpen} open gaps already (cap: 50)`);
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
For each node, propose 1-3 open questions that would meaningfully deepen understanding.
Skip trivial questions. Focus on: relationships, context, technical details, motivations, recent changes.
Return ONLY valid JSON: [{"nodeId":"id","gaps":["question 1","question 2"]}]
If no meaningful gaps exist, return: []`,
        `Nodes to analyze:\n${nodeDescriptions}`
      );

      const parsed = this._parseJSON(response);
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
      if (this._isFactualGap(gap.content) && this.config.braveApiKey) {
        try {
          const results = await this._webSearch(gap.content, 3);
          if (results.length > 0) {
            webContext = '\n\nWeb search results:\n' + results
              .map(r => `- ${r.title}: ${r.description}`).join('\n');
          }
        } catch {}
      }

      const response = await this._callLLM(
        `You are resolving an open question (gap) in a knowledge graph.
Using the provided context and any web results, answer the question.
If you can confidently answer, provide the answer.
If not enough information exists, respond with UNKNOWN.
Also propose 0-2 follow-up questions that emerge from exploring this gap (generative curiosity).
Return ONLY JSON: {"answer":"your answer or UNKNOWN","confidence":"high|medium|low","followUps":["question 1"]}`,
        `Node: ${gap.label} (${gap.type}): ${gap.description || ''}\n` +
        `Gap: ${gap.content}\n\n` +
        `Graph context:\n${context}${webContext}`
      );

      const result = this._parseJSON(response);
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
        for (const fu of result.followUps) {
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
    } catch (e) {
      this.log.error(`[maintainer] Gap resolve error (${gap.node_id}):`, e.message);
      this.db.prepare('UPDATE gaps SET attempts = attempts + 1 WHERE id = ?').run(gap.id);
    }
  }

  _persistAnswerToGraph(nodeId, question, answer) {
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
        SELECT n.id, n.label, n.type, n.description, n.importance
        FROM nodes n
        WHERE n.type NOT IN ('tool')
          AND n.importance >= 5
          AND (n.provenance = 'self' OR n.provenance IS NULL)
          AND n.id NOT IN (SELECT DISTINCT node_id FROM reflections)
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
        `You are an AI agent. Write a brief first-person reflection (2-4 sentences) about this entity in your knowledge graph.
What does it mean to you? What patterns or connections do you notice? What's interesting or unresolved?
Be genuine, not performative. Write as yourself — curious, direct, insightful.
${existingReflection ? 'A previous reflection exists — build on it or offer a new angle.' : ''}
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

      const result = this._parseJSON(response);
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

      this.db.prepare(
        'UPDATE nodes SET updated = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(node.id);
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

      const edges = this._parseJSON(response);
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
          "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 0.6, 'maintainer')"
        ).run(edge.source, edge.target, edge.type);
        graphEvents.emit('change', { op: 'edge:create', edge: { source: edge.source, target: edge.target, type: edge.type }, source: 'maintainer' });
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

  // ── Duplicate Node Merging ──────────────────────────────────────────────────

  async mergeNodes(batchSize = 3) {
    if (!this.db) return;
    try {
      const nodes = this.db.prepare(
        "SELECT id, label, type, embedding FROM nodes WHERE embedding IS NOT NULL AND embedding != '' ORDER BY importance DESC LIMIT 500"
      ).all();
      if (nodes.length < 2) return;

      // Find candidate pairs via embedding cosine similarity
      const candidates = [];
      for (let i = 0; i < nodes.length && candidates.length < batchSize * 3; i++) {
        let emb_i;
        try { emb_i = JSON.parse(nodes[i].embedding); } catch { continue; }
        for (let j = i + 1; j < nodes.length && candidates.length < batchSize * 3; j++) {
          let emb_j;
          try { emb_j = JSON.parse(nodes[j].embedding); } catch { continue; }
          let dot = 0, na = 0, nb = 0;
          for (let k = 0; k < emb_i.length; k++) {
            dot += emb_i[k] * emb_j[k];
            na += emb_i[k] * emb_i[k];
            nb += emb_j[k] * emb_j[k];
          }
          const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
          if (sim >= 0.92) {
            candidates.push({ a: nodes[i], b: nodes[j], sim });
          }
        }
      }

      if (candidates.length === 0) return;
      candidates.sort((x, y) => y.sim - x.sim);

      let merged = 0;
      for (const pair of candidates.slice(0, batchSize)) {
        try {
          const ctxA = this._buildNodeContext(pair.a.id);
          const ctxB = this._buildNodeContext(pair.b.id);
          const prompt = `Two nodes in a knowledge graph may refer to the same real-world entity.

Node A: "${pair.a.label}" (${pair.a.type})
${ctxA}

Node B: "${pair.b.label}" (${pair.b.type})
${ctxB}

Embedding similarity: ${pair.sim.toFixed(3)}

Do these two nodes refer to the SAME real-world entity/concept? Answer ONLY with JSON:
{"same": true/false, "reason": "brief explanation"}`;

          const response = await this._callLLM(
            'You are a knowledge graph deduplication judge. Determine if two nodes refer to the same entity. Be conservative — only confirm if clearly the same thing.',
            prompt
          );
          const result = this._parseJSON(response);
          if (!result || !result.same) continue;

          // Pick canonical: more attributes wins, then higher importance
          const attrsA = this.db.prepare('SELECT COUNT(*) as c FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = ?').get(pair.a.id).c;
          const attrsB = this.db.prepare('SELECT COUNT(*) as c FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE asp.node_id = ?').get(pair.b.id).c;
          const [canonical, duplicate] = attrsA >= attrsB ? [pair.a, pair.b] : [pair.b, pair.a];

          this._mergeNodeInto(canonical.id, duplicate.id);
          merged++;
          this.log.info(`[maintainer] Merged duplicate: "${duplicate.label}" → "${canonical.label}" (sim=${pair.sim.toFixed(3)}, reason: ${result.reason})`);
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
    try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(canonicalId, this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(duplicateId)?.label); } catch {}
    try { this.db.prepare('INSERT OR IGNORE INTO aliases (node_id, alias) VALUES (?, ?)').run(canonicalId, duplicateId); } catch {}

    // Delete duplicate node
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(duplicateId);

    // Re-embed canonical node with merged content
    try { embedNode(canonicalId, this.db); } catch {}
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

        const result = this._parseJSON(text);
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

        const result = this._parseJSON(text);
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

      const result = this._parseJSON(text);
      if (!result?.hypotheses?.length) return;

      const allNodeIds = new Set();
      for (const d of recentDerived) {
        try { JSON.parse(d.source_node_ids).forEach(id => allNodeIds.add(id)); } catch {}
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;

    try {
      const rows = this.db.prepare(
        'SELECT id FROM nodes WHERE embedding IS NULL LIMIT ?'
      ).all(limit);

      if (rows.length === 0) return;

      this.log.info(`[maintainer] Embedding ${rows.length} unembedded node(s)...`);
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

  _isFactualGap(content) {
    const factualPatterns = /\b(what|where|when|who|how many|which|version|url|address|name of)\b/i;
    return factualPatterns.test(content);
  }

  async _webSearch(query, count = 3) {
    if (!this.config.braveApiKey) return [];

    return new Promise((resolve) => {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const req = https.get(url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': this.config.braveApiKey,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve((json.web?.results || []).map(r => ({
              title: r.title, url: r.url, description: r.description,
            })));
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    });
  }

  async _callLLM(systemPrompt, prompt) {
    const system = this.config._isOAuth
      ? [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ]
      : [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content.find(b => b.type === 'text')?.text || '';
  }

  _parseJSON(text) {
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
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
