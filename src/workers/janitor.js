/**
 * janitor.js — LLM-driven graph cleanup + recycling bin
 *
 * Runs on its own interval (default every 6h). Three passes per cycle:
 *   Phase 1 — Temp node review: LLM judges each temp node that's passed
 *             half its TTL. keep=false → snapshot to recycle_bin + cascade-delete.
 *             keep=true  → refresh tempCreated so the node gets another TTL window.
 *   Phase 2 — Attribute pruning: LLM flags stale state snapshots / low-signal
 *             attributes on permanent nodes (e.g. "Connection status: not connected
 *             as of 2026-04-19") and the janitor moves them to the bin.
 *   Phase 2b — Whole permanent-node pruning (moderate/aggressive only): LLM judges
 *             low-activity permanent nodes that may be one-off mentions or fully
 *             captured elsewhere. Stricter thresholds than Phase 2.
 *   Phase 3 — Housekeeping: hard-deletes recycle_bin rows past expires_at.
 *
 * Aggressiveness is configured via config.janitorMode:
 *   conservative — only delete LLM-high-confidence items, never whole permanent nodes
 *   moderate     — default; whole-node pruning enabled with strict gates
 *   aggressive   — lower thresholds, larger batches, easier whole-node pruning
 */

const graphEvents = require('../graph/events');

const TYPE_BLOCKLIST_WHOLE_NODE = new Set(['self', 'agent', 'person']);

const MODES = {
  conservative: {
    tempKeepFalseMin: 0.85,
    attrPruneMin: 0.85,
    attrRequireAsOfMarker: true,
    nodePruneEnabled: false,
    nodePruneConfidenceMin: 1.1,
    nodePruneMinAgeDays: 365,
    nodePruneMaxEdges: 0,
    batchSize: 3,
  },
  moderate: {
    tempKeepFalseMin: 0.65,
    attrPruneMin: 0.65,
    attrRequireAsOfMarker: false,
    nodePruneEnabled: true,
    nodePruneConfidenceMin: 0.9,
    nodePruneMinAgeDays: 14,
    nodePruneMaxEdges: 1,
    batchSize: 5,
  },
  aggressive: {
    tempKeepFalseMin: 0.4,
    attrPruneMin: 0.4,
    attrRequireAsOfMarker: false,
    nodePruneEnabled: true,
    nodePruneConfidenceMin: 0.75,
    nodePruneMinAgeDays: 7,
    nodePruneMaxEdges: 3,
    batchSize: 10,
  },
};

class Janitor {
  constructor(config, log, llmClient, db) {
    this.config = config;
    this.log = log;
    this.client = llmClient;
    this.db = db;
    this.model = config.learnerModel || config.casualModel || config.model;
    this._running = false;
    this._lastRunAt = null;
    this.stats = {
      cycles: 0,
      tempsReviewed: 0, tempsTrashed: 0, tempsKept: 0,
      attrsReviewed: 0, attrsTrashed: 0,
      nodesReviewed: 0, nodesTrashed: 0,
      restored: 0, expired: 0, errors: 0,
      lastRunAt: null,
    };
    this._rotationCursor = 0;
  }

  ensureSchema() {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS recycle_bin (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_type TEXT NOT NULL,
          item_id TEXT,
          label TEXT,
          payload TEXT NOT NULL,
          deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          deleted_by TEXT,
          reason TEXT,
          confidence REAL,
          expires_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON recycle_bin(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_recycle_bin_type ON recycle_bin(item_type);
        CREATE INDEX IF NOT EXISTS idx_recycle_bin_expires ON recycle_bin(expires_at);
      `);
    } catch (e) {
      this.log.warn('[janitor] ensureSchema:', e.message);
    }
  }

  _mode() {
    const m = this.config.janitorMode || 'moderate';
    return MODES[m] || MODES.moderate;
  }

  _hasUsableModel() {
    const c = this.config || {};
    const tiers = [c.plannerModel, c.normalModel, c.casualModel, c.subagentModel, c.learnerModel].filter(Boolean);
    if (!tiers.length) return false;
    for (const tier of tiers) {
      const ref = String(tier);
      const slash = ref.indexOf('/');
      const prefix = slash > 0 ? ref.slice(0, slash) : '';
      if (!prefix || prefix === 'anthropic') { if (c.anthropicApiKey) return true; continue; }
      if (prefix === 'openai') { if (c.openaiApiKey) return true; continue; }
      if (prefix === 'openrouter') { if (c.openrouterApiKey) return true; continue; }
      if (prefix === 'local') { if (c.localModelBaseUrl) return true; continue; }
      if (c.customProviders && c.customProviders[prefix]) return true;
    }
    return false;
  }

  async runJanitor({ force = false } = {}) {
    if (!this.db) return null;
    if (this._running) {
      this.log.debug('[janitor] Skipping — already running');
      return null;
    }
    if (this.config.janitorEnabled === false) {
      this.log.debug('[janitor] Disabled via config');
      return null;
    }
    if (!this._hasUsableModel()) {
      if (!this._warnedNoModel) {
        this.log.info('[janitor] No model/provider configured — sleeping until setup is complete.');
        this._warnedNoModel = true;
      }
      return null;
    }
    this._warnedNoModel = false;

    if (!force) {
      const minIntervalMs = (this.config.janitorIntervalMinutes || 360) * 60_000;
      if (this._lastRunAt && (Date.now() - this._lastRunAt) < minIntervalMs) {
        return null;
      }
    }

    // Refresh model + client mid-life
    try {
      const newModel = this.config.learnerModel || this.config.casualModel || this.config.model;
      if (newModel && newModel !== this.model) this.model = newModel;
      const { createClientForModel } = require('../providers');
      const fresh = createClientForModel(this.model, this.config);
      if (fresh) this.client = fresh;
    } catch (e) {
      this.log.warn(`[janitor] client refresh failed: ${e.message}`);
    }

    this._running = true;
    this._lastRunAt = Date.now();
    const start = Date.now();
    const before = { ...this.stats };

    try {
      const mode = this._mode();
      this.log.info(`[janitor] Starting cycle — mode=${this.config.janitorMode || 'moderate'}`);

      await this._phaseTempReview(mode);
      await this._phaseAttrPrune(mode);
      if (mode.nodePruneEnabled) {
        await this._phaseWholeNodePrune(mode);
      }
      await this._phaseBinHousekeep();

      this.stats.cycles++;
      this.stats.lastRunAt = new Date().toISOString();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      this.log.info(
        `[janitor] Cycle #${this.stats.cycles} done in ${elapsed}s — ` +
        `temps:${this.stats.tempsReviewed - before.tempsReviewed}rev/${this.stats.tempsTrashed - before.tempsTrashed}trash ` +
        `attrs:${this.stats.attrsReviewed - before.attrsReviewed}rev/${this.stats.attrsTrashed - before.attrsTrashed}trash ` +
        `nodes:${this.stats.nodesReviewed - before.nodesReviewed}rev/${this.stats.nodesTrashed - before.nodesTrashed}trash ` +
        `expired:${this.stats.expired - before.expired}`
      );
      return {
        tempsTrashed: this.stats.tempsTrashed - before.tempsTrashed,
        attrsTrashed: this.stats.attrsTrashed - before.attrsTrashed,
        nodesTrashed: this.stats.nodesTrashed - before.nodesTrashed,
        expired: this.stats.expired - before.expired,
      };
    } catch (e) {
      this.stats.errors++;
      this.log.error('[janitor] Cycle error:', e.message);
      return null;
    } finally {
      this._running = false;
    }
  }

  // ── Phase 1 — Temp node review ──────────────────────────────────────────

  async _phaseTempReview(mode) {
    const ttlHours = Number(this.config.tempNodeTtlHours) || 48;
    const minAgeMs = ttlHours * 0.5 * 3600 * 1000;
    const now = Date.now();

    let rows = [];
    try {
      rows = this.db.prepare(
        "SELECT id, label, type, description, extra, created FROM nodes WHERE extra LIKE '%\"ttl\":\"temp\"%'"
      ).all();
    } catch (e) {
      this.log.warn(`[janitor] temp scan failed: ${e.message}`);
      return;
    }

    const candidates = [];
    for (const row of rows) {
      let extraObj = {};
      try { extraObj = row.extra ? JSON.parse(row.extra) : {}; } catch (e) { this.log.warn('[janitor] JSON.parse failed: ' + e.message); }
      if (extraObj.ttl !== 'temp') continue;
      const refIso = extraObj.tempCreated || row.created;
      const refMs = refIso ? Date.parse(refIso) : NaN;
      if (!Number.isFinite(refMs)) continue;
      if (now - refMs < minAgeMs) continue;
      candidates.push({ ...row, tempCreated: refIso, ageHours: (now - refMs) / 3600_000 });
    }
    if (!candidates.length) return;

    // Batch in groups of 10
    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const summaries = batch.map(n => {
        const aspects = this.db.prepare('SELECT id, name FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 5').all(n.id);
        const aspectLines = aspects.map(a => {
          const firstAttr = this.db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 1').get(a.id);
          return `    ${a.name}${firstAttr ? `: ${String(firstAttr.content).slice(0, 120)}` : ''}`;
        }).join('\n');
        const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges WHERE source = ? OR target = ?').get(n.id, n.id).c;
        return `- id: ${n.id}\n  label: ${n.label}\n  type: ${n.type}\n  age_hours: ${n.ageHours.toFixed(1)}\n  edges: ${edgeCount}\n  description: ${(n.description || '').slice(0, 160)}\n  aspects:\n${aspectLines || '    (none)'}`;
      }).join('\n\n');

      const system = `You are the graph janitor. For each temporary node, decide whether to KEEP (still useful for future tasks or ongoing work) or DELETE (task-scoped ephemeral scratch that's no longer needed).

Return ONLY valid JSON:
{ "verdicts": [ { "id": "...", "keep": true|false, "reason": "...", "confidence": 0..1 } ] }

Keep guidance: names/labels that will be referenced again, configs, permanent-looking concepts, anything with useful durable information.
Delete guidance: crawl/error logs from completed runs, one-off scratch nodes, step-by-step breadcrumbs, obvious task artifacts whose info is captured elsewhere.`;
      const prompt = `Temp nodes to review:\n\n${summaries}`;
      this.stats.tempsReviewed += batch.length;

      let parsed = null;
      try {
        const text = await this._callLLM(system, prompt);
        parsed = this._parseJSON(text, 'temp-review');
      } catch (e) {
        this.log.warn(`[janitor] temp batch LLM error: ${e.message}`);
        continue;
      }
      const verdicts = parsed?.verdicts || [];
      for (const v of verdicts) {
        if (!v || typeof v.id !== 'string') continue;
        const node = batch.find(b => b.id === v.id);
        if (!node) continue;
        const conf = Number(v.confidence) || 0;

        if (v.keep === false && conf >= mode.tempKeepFalseMin) {
          this._trashNode(node.id, 'janitor-temp', String(v.reason || '').slice(0, 240), conf);
          this.stats.tempsTrashed++;
        } else {
          // Keep path — refresh tempCreated so it gets another TTL window
          try {
            const row = this.db.prepare('SELECT extra FROM nodes WHERE id = ?').get(node.id);
            let extraObj = {};
            try { extraObj = row?.extra ? JSON.parse(row.extra) : {}; } catch (e) { this.log.warn('[janitor] JSON.parse failed: ' + e.message); }
            extraObj.tempCreated = new Date().toISOString();
            this.db.prepare("UPDATE nodes SET extra = ?, updated = datetime('now') WHERE id = ?").run(JSON.stringify(extraObj), node.id);
            this.stats.tempsKept++;
          } catch (e) {
            this.log.warn(`[janitor] refresh temp ${node.id}: ${e.message}`);
          }
        }
      }
    }
  }

  // ── Phase 2 — Attribute pruning on permanent nodes ─────────────────────

  async _phaseAttrPrune(mode) {
    // Rotate through permanent nodes with many attributes
    const nodes = this.db.prepare(`
      SELECT n.id, n.label, n.type, n.description,
             (SELECT COUNT(*) FROM attributes a JOIN aspects s ON s.id = a.aspect_id WHERE s.node_id = n.id) AS attr_count
      FROM nodes n
      WHERE (n.extra IS NULL OR n.extra NOT LIKE '%"ttl":"temp"%')
        AND n.type NOT IN ('self', 'agent', 'person')
      ORDER BY attr_count DESC, n.updated ASC
      LIMIT ?
    `).all(mode.batchSize * 3);

    const picked = nodes.filter(n => n.attr_count >= 3).slice(0, mode.batchSize);
    if (!picked.length) return;

    for (const node of picked) {
      this.stats.attrsReviewed++;
      try {
        const aspects = this.db.prepare('SELECT id, name FROM aspects WHERE node_id = ? ORDER BY weight DESC').all(node.id);
        const perAspect = aspects.map(a => {
          const attrs = this.db.prepare('SELECT id, content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC').all(a.id);
          return { aspectName: a.name, attrs };
        });
        const attrLines = perAspect.flatMap(a =>
          a.attrs.map(x => `  [#${x.id}] (${a.aspectName}) ${String(x.content).slice(0, 260)}`)
        ).join('\n');
        if (!attrLines) continue;

        const system = `You are the graph janitor. For the given permanent node, identify which attributes should be pruned because they are:
(a) stale state snapshots with a concrete "as of YYYY-MM-DD" date — e.g. "Connection status: not connected (as of 2026-04-19)"
(b) trivially ephemeral — step-by-step traces, debug dumps
(c) exact duplicates or near-duplicates of another attribute on the same node

DO NOT prune: core facts, preferences, biographical info, capabilities, identity/voice/rules, anything long-term.
${mode.attrRequireAsOfMarker ? 'CONSERVATIVE MODE: only prune attrs that have an explicit "as of <date>" marker.' : ''}

Return ONLY valid JSON:
{ "prune": [ { "id": <attribute id>, "reason": "...", "confidence": 0..1 } ] }
Return {"prune":[]} if nothing should be pruned.`;
        const prompt = `Node: ${node.label} (type=${node.type})\nDescription: ${(node.description || '').slice(0, 240)}\n\nAttributes:\n${attrLines}`;

        const text = await this._callLLM(system, prompt);
        const parsed = this._parseJSON(text, 'attr-prune');
        const items = parsed?.prune || [];
        for (const it of items) {
          const conf = Number(it?.confidence) || 0;
          if (conf < mode.attrPruneMin) continue;
          const attrId = Number(it?.id);
          if (!Number.isFinite(attrId)) continue;
          // If conservative, require explicit "as of" marker
          const row = this.db.prepare(`
            SELECT a.*, s.name AS aspect_name, s.node_id AS node_id
            FROM attributes a JOIN aspects s ON s.id = a.aspect_id
            WHERE a.id = ?
          `).get(attrId);
          if (!row) continue;
          if (row.node_id !== node.id) continue;
          if (mode.attrRequireAsOfMarker && !/\bas of\s+\d{4}-\d{2}-\d{2}\b/i.test(String(row.content))) continue;

          this._trashAttribute(row, 'janitor-prune', String(it.reason || '').slice(0, 240), conf);
          this.stats.attrsTrashed++;
        }
      } catch (e) {
        this.log.warn(`[janitor] attr prune ${node.id}: ${e.message}`);
      }
    }
  }

  // ── Phase 2b — Whole permanent-node pruning ─────────────────────────────

  async _phaseWholeNodePrune(mode) {
    // Candidates: low-edge, low-activity permanent nodes, not in blocklist,
    // not referenced by reflections or derived_facts, past min age.
    const blockIds = new Set();
    try {
      const refRows = this.db.prepare("SELECT DISTINCT node_id FROM reflections").all();
      for (const r of refRows) blockIds.add(r.node_id);
    } catch (e) { this.log.warn('[janitor] db.prepare failed: ' + e.message); }
    try {
      const dfRows = this.db.prepare("SELECT source_node_ids FROM derived_facts WHERE invalidated_at IS NULL").all();
      for (const d of dfRows) {
        try {
          const ids = JSON.parse(d.source_node_ids);
          if (Array.isArray(ids)) for (const id of ids) blockIds.add(id);
        } catch { /* silent: malformed JSON → fallback */ }
      }
    } catch (e) { this.log.warn('[janitor] db.prepare failed: ' + e.message); }

    const candidates = this.db.prepare(`
      SELECT n.id, n.label, n.type, n.description, n.importance,
             CAST((julianday('now') - julianday(n.created)) AS INTEGER) AS age_days,
             CAST((julianday('now') - julianday(n.updated)) AS INTEGER) AS since_updated_days,
             (SELECT COUNT(*) FROM edges WHERE source = n.id OR target = n.id) AS edge_count
      FROM nodes n
      WHERE (n.extra IS NULL OR n.extra NOT LIKE '%"ttl":"temp"%')
        AND n.type NOT IN ('self', 'agent', 'person')
        AND (n.id NOT LIKE 'system:%' OR n.id LIKE 'system:scratch%')
      ORDER BY n.updated ASC
      LIMIT 100
    `).all();

    const pool = candidates.filter(n =>
      (n.age_days || 0) >= mode.nodePruneMinAgeDays &&
      (n.edge_count || 0) <= mode.nodePruneMaxEdges &&
      !blockIds.has(n.id) &&
      !TYPE_BLOCKLIST_WHOLE_NODE.has(n.type)
    );
    if (!pool.length) return;

    // Rotate cursor so we don't always pick the same nodes
    const start = this._rotationCursor % pool.length;
    const ordered = pool.slice(start).concat(pool.slice(0, start));
    this._rotationCursor += mode.batchSize;

    const picked = ordered.slice(0, mode.batchSize);
    for (const node of picked) {
      this.stats.nodesReviewed++;
      try {
        const aspects = this.db.prepare('SELECT id, name FROM aspects WHERE node_id = ? ORDER BY weight DESC').all(node.id);
        const aspectBlocks = aspects.map(a => {
          const attrs = this.db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 5').all(a.id);
          return `  ${a.name}:\n${attrs.map(x => `    - ${String(x.content).slice(0, 200)}`).join('\n') || '    (empty)'}`;
        }).join('\n');
        const edges = this.db.prepare(`
          SELECT e.type AS rel, e.source, e.target,
                 (SELECT label FROM nodes WHERE id = e.source) AS src_label,
                 (SELECT label FROM nodes WHERE id = e.target) AS tgt_label
          FROM edges e WHERE e.source = ? OR e.target = ? LIMIT 10
        `).all(node.id, node.id);
        const edgeLines = edges.map(e => {
          const other = e.source === node.id ? e.tgt_label : e.src_label;
          const dir = e.source === node.id ? '→' : '←';
          return `    ${dir} ${e.rel} ${other || '(unknown)'}`;
        }).join('\n');
        const recentMentions = this.db.prepare(`
          SELECT COUNT(*) AS c FROM node_sources
          WHERE node_id = ? AND rowid > (SELECT MAX(rowid) - 500 FROM node_sources)
        `).get(node.id).c;

        const system = `You are the graph janitor. This is a permanent node that hasn't been touched in a while. Decide: KEEP as durable knowledge, or DELETE because it's a one-off mention, fully captured on a richer neighbor, or has no lasting value?

Strict criteria — DELETE only if ALL of:
- The node has no durable insight or unique content
- Its information is either trivial OR covered elsewhere
- Removing it won't leave a hole in the graph

If DELETE: name the node id where the useful piece lives in "preserved_in", OR set "no_durable_signal": true if nothing was worth preserving.

Return ONLY valid JSON:
{
  "keep": true|false,
  "reason": "...",
  "confidence": 0..1,
  "preserved_in": "<node id>" | null,
  "no_durable_signal": true|false
}`;
        const prompt = `Node: ${node.label} (${node.type})
Age: ${node.age_days}d (last updated ${node.since_updated_days}d ago)
Importance: ${node.importance}
Edges: ${node.edge_count}
Recent mentions in learner output: ${recentMentions}
Description: ${(node.description || '').slice(0, 300)}

Aspects:
${aspectBlocks || '  (none)'}

Relations:
${edgeLines || '    (no edges)'}`;

        const text = await this._callLLM(system, prompt);
        const parsed = this._parseJSON(text, 'node-prune');
        if (!parsed) continue;
        const conf = Number(parsed.confidence) || 0;
        if (parsed.keep === false && conf >= mode.nodePruneConfidenceMin) {
          const hasJustification = parsed.no_durable_signal === true ||
            (typeof parsed.preserved_in === 'string' && !!this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(parsed.preserved_in));
          if (!hasJustification) {
            this.log.debug(`[janitor] node ${node.id} passed threshold but no valid preserved_in — keeping`);
            continue;
          }
          const reasonSuffix = parsed.preserved_in ? ` (preserved in ${parsed.preserved_in})` : ' (no durable signal)';
          this._trashNode(node.id, 'janitor-node-prune', String(parsed.reason || '').slice(0, 220) + reasonSuffix, conf);
          this.stats.nodesTrashed++;
        } else {
          // Keep — bump updated so the node doesn't come up again next cycle
          try { this.db.prepare("UPDATE nodes SET updated = datetime('now') WHERE id = ?").run(node.id); } catch (e) { this.log.warn('[janitor] db.prepare failed: ' + e.message); }
        }
      } catch (e) {
        this.log.warn(`[janitor] node prune ${node.id}: ${e.message}`);
      }
    }
  }

  // ── Phase 3 — Housekeeping ─────────────────────────────────────────────

  async _phaseBinHousekeep() {
    try {
      const res = this.db.prepare("DELETE FROM recycle_bin WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
      if (res?.changes > 0) {
        this.stats.expired += res.changes;
        this.log.info(`[janitor] Expired ${res.changes} recycle-bin row(s)`);
      }
    } catch (e) {
      this.log.warn(`[janitor] bin housekeeping: ${e.message}`);
    }
  }

  // ── Trash helpers ──────────────────────────────────────────────────────

  _trashNode(nodeId, deletedBy, reason, confidence) {
    try {
      const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
      if (!node) return;
      const aspects = this.db.prepare('SELECT * FROM aspects WHERE node_id = ?').all(nodeId);
      const aspectIds = aspects.map(a => a.id);
      const attributes = aspectIds.length
        ? this.db.prepare(`SELECT * FROM attributes WHERE aspect_id IN (${aspectIds.map(() => '?').join(',')})`).all(...aspectIds)
        : [];
      const edges = this.db.prepare('SELECT * FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
      const aliases = this.db.prepare('SELECT * FROM aliases WHERE node_id = ?').all(nodeId);
      const nodeSources = this.db.prepare('SELECT * FROM node_sources WHERE node_id = ?').all(nodeId);

      const payload = JSON.stringify({ node, aspects, attributes, edges, aliases, nodeSources });
      const label = `${node.label || nodeId} (${node.type || '?'}, ${aspects.length} aspects, ${edges.length} edges)`;
      const ttlDays = Number(this.config.janitorRecycleBinTtlDays);
      const expiresSql = Number.isFinite(ttlDays) && ttlDays > 0
        ? `datetime('now', '+${Math.floor(ttlDays)} days')`
        : `datetime('now')`;

      this.db.prepare(`
        INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at)
        VALUES ('node', ?, ?, ?, ?, ?, ?, ${expiresSql})
      `).run(nodeId, label, payload, deletedBy, reason, confidence);

      // Cascade delete
      const delAttrs = this.db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)');
      const delAspects = this.db.prepare('DELETE FROM aspects WHERE node_id = ?');
      const delEdges = this.db.prepare('DELETE FROM edges WHERE source = ? OR target = ?');
      const delAliases = this.db.prepare('DELETE FROM aliases WHERE node_id = ?');
      const delNodeSources = this.db.prepare('DELETE FROM node_sources WHERE node_id = ?');
      const delNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
      delAttrs.run(nodeId);
      delAspects.run(nodeId);
      delEdges.run(nodeId, nodeId);
      delAliases.run(nodeId);
      try { delNodeSources.run(nodeId); } catch (e) { this.log.warn('[janitor] delNodeSources.run failed: ' + e.message); }
      delNode.run(nodeId);

      graphEvents.emit('change', { op: 'node:delete', nodeId, source: deletedBy });
      this.log.info(`[janitor] Trashed node ${nodeId} (${deletedBy}, conf ${confidence.toFixed(2)}): ${reason}`);
    } catch (e) {
      this.log.warn(`[janitor] trashNode ${nodeId}: ${e.message}`);
    }
  }

  _trashAttribute(attrRow, deletedBy, reason, confidence) {
    try {
      const payload = JSON.stringify({
        attribute: {
          id: attrRow.id, content: attrRow.content, importance: attrRow.importance,
          source: attrRow.source, created: attrRow.created, updated_at: attrRow.updated_at,
          event_date: attrRow.event_date, document_date: attrRow.document_date,
          source_excerpt: attrRow.source_excerpt, extracted_with: attrRow.extracted_with,
        },
        aspectName: attrRow.aspect_name,
        nodeId: attrRow.node_id,
      });
      const label = `${attrRow.aspect_name || 'attr'}: ${String(attrRow.content || '').slice(0, 90)}`;
      const ttlDays = Number(this.config.janitorRecycleBinTtlDays);
      const expiresSql = Number.isFinite(ttlDays) && ttlDays > 0
        ? `datetime('now', '+${Math.floor(ttlDays)} days')`
        : `datetime('now')`;

      this.db.prepare(`
        INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at)
        VALUES ('attribute', ?, ?, ?, ?, ?, ?, ${expiresSql})
      `).run(String(attrRow.id), label, payload, deletedBy, reason, confidence);

      this.db.prepare('DELETE FROM attributes WHERE id = ?').run(attrRow.id);

      graphEvents.emit('change', { op: 'attribute:delete', nodeId: attrRow.node_id, attributeId: attrRow.id, source: deletedBy });
      this.log.info(`[janitor] Trashed attr #${attrRow.id} on ${attrRow.node_id} (conf ${confidence.toFixed(2)}): ${reason}`);
    } catch (e) {
      this.log.warn(`[janitor] trashAttr ${attrRow.id}: ${e.message}`);
    }
  }

  // ── Bin API ────────────────────────────────────────────────────────────

  listBin({ limit = 100, offset = 0 } = {}) {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT id, item_type, item_id, label, deleted_at, deleted_by, reason, confidence, expires_at
        FROM recycle_bin
        ORDER BY deleted_at DESC
        LIMIT ? OFFSET ?
      `).all(Number(limit) || 100, Number(offset) || 0);
      const total = this.db.prepare('SELECT COUNT(*) AS c FROM recycle_bin').get().c;
      return { items: rows, total };
    } catch (e) {
      this.log.warn(`[janitor] listBin: ${e.message}`);
      return { items: [], total: 0 };
    }
  }

  restoreItem(binId) {
    if (!this.db) return { ok: false, error: 'no db' };
    const row = this.db.prepare('SELECT * FROM recycle_bin WHERE id = ?').get(Number(binId));
    if (!row) return { ok: false, error: 'not found' };
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch (e) { return { ok: false, error: 'corrupt payload: ' + e.message }; }

    try {
      if (row.item_type === 'node') {
        const { node, aspects = [], attributes = [], edges = [], aliases = [], nodeSources = [] } = payload;
        if (!node || !node.id) return { ok: false, error: 'payload missing node' };
        const existing = this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(node.id);
        if (existing) return { ok: false, error: 'node already exists: ' + node.id };

        this.db.prepare(`
          INSERT INTO nodes (id, label, type, description, importance, mentions, session_count,
                             provenance, extracted_with, extracted_at, created, updated, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          node.id, node.label, node.type, node.description || null,
          node.importance ?? 5, node.mentions ?? 1, node.session_count ?? 0,
          node.provenance || null, node.extracted_with || null, node.extracted_at || null,
          node.created || new Date().toISOString(), new Date().toISOString(), node.extra || '{}'
        );

        const aspectIdMap = new Map();
        const insAspect = this.db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)');
        for (const a of aspects) {
          const r = insAspect.run(node.id, a.name, a.weight ?? 5, a.extracted_with || null);
          aspectIdMap.set(a.id, r.lastInsertRowid);
        }
        const insAttr = this.db.prepare(`
          INSERT INTO attributes (aspect_id, content, importance, source, created, updated_at,
                                  extracted_with, event_date, document_date, source_excerpt, source_episode_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const at of attributes) {
          const newAspectId = aspectIdMap.get(at.aspect_id);
          if (!newAspectId) continue;
          insAttr.run(
            newAspectId, at.content, at.importance ?? 5, at.source || null,
            at.created || new Date().toISOString(), at.updated_at || new Date().toISOString(),
            at.extracted_with || null, at.event_date || null, at.document_date || null,
            at.source_excerpt || null, at.source_episode_id || null
          );
        }
        const insEdge = this.db.prepare('INSERT INTO edges (source, target, type, weight, created, extracted_with) VALUES (?, ?, ?, ?, ?, ?)');
        let edgesRestored = 0, edgesSkipped = 0;
        for (const e of edges) {
          const other = e.source === node.id ? e.target : e.source;
          const otherExists = this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(other);
          if (!otherExists) { edgesSkipped++; continue; }
          insEdge.run(e.source, e.target, e.type, e.weight ?? 1.0, e.created || new Date().toISOString(), e.extracted_with || null);
          edgesRestored++;
        }
        const insAlias = this.db.prepare('INSERT INTO aliases (node_id, alias) VALUES (?, ?)');
        for (const al of aliases) insAlias.run(node.id, al.alias);

        const insSrc = this.db.prepare('INSERT INTO node_sources (node_id, source) VALUES (?, ?)');
        for (const ns of nodeSources) { try { insSrc.run(node.id, ns.source); } catch (e) { this.log.warn('[janitor] insSrc.run failed: ' + e.message); } }

        this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(row.id);
        this.stats.restored++;
        graphEvents.emit('change', { op: 'node:restore', nodeId: node.id, source: 'janitor-restore' });
        return { ok: true, restored: { nodeId: node.id, aspects: aspects.length, attributes: attributes.length, edges: edgesRestored, edgesSkipped, aliases: aliases.length } };
      }

      if (row.item_type === 'attribute') {
        const { attribute, aspectName, nodeId } = payload;
        if (!attribute || !nodeId || !aspectName) return { ok: false, error: 'payload missing fields' };
        const nodeExists = this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
        if (!nodeExists) return { ok: false, error: 'owning node no longer exists: ' + nodeId };
        let aspect = this.db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, aspectName);
        if (!aspect) {
          const r = this.db.prepare('INSERT INTO aspects (node_id, name, weight) VALUES (?, ?, 5)').run(nodeId, aspectName);
          aspect = { id: r.lastInsertRowid };
        }
        this.db.prepare(`
          INSERT INTO attributes (aspect_id, content, importance, source, created, updated_at,
                                  extracted_with, event_date, document_date, source_excerpt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          aspect.id, attribute.content, attribute.importance ?? 5, attribute.source || null,
          attribute.created || new Date().toISOString(), new Date().toISOString(),
          attribute.extracted_with || null, attribute.event_date || null,
          attribute.document_date || null, attribute.source_excerpt || null
        );
        this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(row.id);
        this.stats.restored++;
        graphEvents.emit('change', { op: 'attribute:restore', nodeId, source: 'janitor-restore' });
        return { ok: true, restored: { nodeId, aspectName } };
      }

      return { ok: false, error: 'unknown item_type: ' + row.item_type };
    } catch (e) {
      this.log.warn(`[janitor] restore ${binId}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  deleteBinItem(binId) {
    if (!this.db) return { ok: false, error: 'no db' };
    try {
      const res = this.db.prepare('DELETE FROM recycle_bin WHERE id = ?').run(Number(binId));
      return { ok: res.changes > 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  emptyBin() {
    if (!this.db) return { ok: false, error: 'no db' };
    try {
      const res = this.db.prepare('DELETE FROM recycle_bin').run();
      return { ok: true, deleted: res.changes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getStats() {
    return { ...this.stats };
  }

  // ── LLM + JSON helpers (same shape as maintainer) ───────────────────────

  async _callLLM(systemPrompt, prompt) {
    const { wrapSystemPromptForModel } = require('../providers');
    const system = wrapSystemPromptForModel(
      [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      this.model,
      this.config,
    );
    const params = {
      model: this.model,
      max_tokens: 8192,
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
        await new Promise((resolve, reject) => {
          stream.on('text', chunk => { text += chunk; });
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      } else {
        const response = await this.client.messages.create(params);
        text = response.content.find(b => b.type === 'text')?.text || '';
      }
    } catch (e) {
      this.log.debug?.('[janitor] stream failed, falling back to create():', e?.message);
      const response = await this.client.messages.create(params);
      text = response.content.find(b => b.type === 'text')?.text || '';
    }
    return text;
  }

  _parseJSON(text, context = 'janitor') {
    if (!text || !String(text).trim()) return null;
    try {
      let cleaned = String(text).replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      if (cleaned[0] !== '{' && cleaned[0] !== '[') {
        const m = cleaned.match(/[\{\[][\s\S]*[\}\]]/);
        if (m) cleaned = m[0];
      }
      return JSON.parse(cleaned);
    } catch (e) {
      this.log.warn(`[janitor] _parseJSON (${context}) failed: ${e.message} | head: ${String(text).slice(0, 180).replace(/\n/g, ' ')}`);
      return null;
    }
  }
}

module.exports = { Janitor };
