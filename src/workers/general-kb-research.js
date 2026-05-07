/**
 * general-kb-research.js — dedicated General Knowledge Base enrichment worker.
 *
 * This is intentionally separate from graph maintenance. Structural upkeep
 * needs to stay fast so embeddings, clustering, and overviews keep flowing;
 * web research can take minutes and runs on the background lane.
 */

const graphEvents = require('../graph/events');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_GENERAL_KB_RESEARCH_INTERVAL_HOURS = 24;
const DEFAULT_GENERAL_KB_RESEARCH_BATCH_SIZE = 1;
const GENERAL_KB_RESEARCH_RETRY_DAYS = 7;

function _hours(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _role(graph) {
  return String(graph?.role || 'custom');
}

function _parseExtra(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function _parseIsoMs(value) {
  if (!value || typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

class GeneralKbResearchWorker {
  constructor(config, log, llmClient, learner, registry, deps = {}) {
    this.config = config || {};
    this.log = log || console;
    this.client = llmClient || null;
    this.learner = learner || null;
    this.registry = registry || null;
    this.agent = deps.agent || null;
    this.queue = deps.queue || null;
    this._lastRunBySlug = new Map();
    this.stats = {
      queued: 0,
      skipped: 0,
      completed: 0,
      failed: 0,
      lastQueuedAt: null,
      lastCompletedAt: null,
      lastError: null,
    };
  }

  getStats() {
    return {
      ...this.stats,
      lastRunBySlug: Object.fromEntries(this._lastRunBySlug.entries()),
    };
  }

  async enqueue({ slug = null, force = false, batchSize = null, reason = 'scheduled' } = {}) {
    const targetSlug = slug || this.registry?.getGeneralKnowledgeSlug?.() || 'spore-knowledge-base';
    const graph = this.registry?.get?.(targetSlug);
    if (!graph) return { ok: false, error: `graph not found: ${targetSlug}` };
    if (_role(graph) !== 'general_kb') return { ok: false, error: `graph is not the General Knowledge Base: ${targetSlug}` };
    if (!this.learner?.getGraphDb) return { ok: false, error: 'graph db unavailable' };
    const db = this.learner.getGraphDb(targetSlug);
    if (!db) return { ok: false, error: 'graph db unavailable' };
    return this._enqueueForGraph(graph, db, { force, batchSize, reason });
  }

  async _enqueueForGraph(graph, db, { force = false, batchSize = null, reason = 'scheduled' } = {}) {
    const slug = graph?.slug;
    if (!slug || _role(graph) !== 'general_kb') return null;
    const manual = reason === 'manual' || force === true;
    if (!manual && this.config.generalKbResearchEnabled === false) return this._skip('disabled');
    if (!this.agent?.processMessage) return this._skip('agent-unavailable');

    const intervalHours = _hours(this.config.generalKbResearchIntervalHours, DEFAULT_GENERAL_KB_RESEARCH_INTERVAL_HOURS);
    const nowMs = Date.now();
    const lastRun = this._lastRunBySlug.get(slug);
    if (!force && lastRun && nowMs - lastRun < intervalHours * 60 * 60_000) {
      return this._skip('interval', {
        nextEligibleAt: new Date(lastRun + intervalHours * 60 * 60_000).toISOString(),
      });
    }

    const limit = Math.max(
      1,
      Math.floor(Number(batchSize || this.config.generalKbResearchBatchSize) || DEFAULT_GENERAL_KB_RESEARCH_BATCH_SIZE),
    );
    const candidates = this._selectCandidates(db, { batchSize: limit });
    this._lastRunBySlug.set(slug, nowMs);
    if (!candidates.length) return this._skip('no-candidates');

    const queuedAt = new Date(nowMs).toISOString();
    const nodeIds = candidates.map(n => n.id);
    this._markQueued(db, candidates, { queuedAt, reason });
    const prompt = this._buildPrompt(graph, db, candidates, { queuedAt, reason });
    const sessionKey = `general-kb-research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const memoryEnvelope = this._memoryEnvelope(graph);

    try {
      graphEvents.emit('change', {
        op: 'general-kb-research:start',
        graph: slug,
        source: 'general-kb-research',
        detail: `${nodeIds.length} node(s) queued`,
      });
    } catch {}

    const agentOpts = {
      content: prompt,
      channelId: sessionKey,
      channelName: 'general-kb-research',
      sessionKey,
      userId: 'system',
      userName: 'General KB Researcher',
      trigger: 'worker',
      platform: 'system',
      isDm: false,
      memoryEnvelope,
    };

    let job = null;
    if (this.queue?.submitWorkerJob) {
      job = this.queue.submitWorkerJob('generalKbResearch.run', {
        slug,
        nodeIds,
        agentOpts,
      }, {
        id: `general-kb-research-${slug}-${nowMs}`,
        persistent: true,
        lane: 'background',
        priority: 10,
        route: 'general-kb-research',
        graph: slug,
        maxAttempts: 2,
      });
    } else {
      Promise.resolve(this.runJob({ slug, nodeIds, agentOpts }))
        .catch(e => this.log.warn(`[general-kb-research] ${slug} failed: ${e.message}`));
      job = { queued: true, persistent: false, lane: 'background' };
    }

    this.stats.queued += nodeIds.length;
    this.stats.lastQueuedAt = queuedAt;
    return { ok: true, queued: nodeIds.length, nodes: nodeIds, sessionKey, job };
  }

  async runJob({ slug, nodeIds = [], agentOpts = null } = {}) {
    if (!slug) throw new Error('generalKbResearch.run requires slug');
    if (!this.agent?.processMessage) throw new Error('agent unavailable');
    const graph = this.registry?.get?.(slug);
    if (!graph) throw new Error(`graph not found: ${slug}`);
    const dbPath = this.registry?.getDbPath?.(slug);
    if (!dbPath) throw new Error(`graph db path not found: ${slug}`);

    const db = new DatabaseSync(dbPath);
    try {
      const result = await this.agent.processMessage(agentOpts || {});
      const completedAt = new Date().toISOString();
      this._markCompleted(db, nodeIds, {
        completedAt,
        resultPreview: String(result?.text || result?.content || '').slice(0, 500),
      });
      this.stats.completed += nodeIds.length;
      this.stats.lastCompletedAt = completedAt;
      this.stats.lastError = null;
      try {
        graphEvents.emit('change', {
          op: 'general-kb-research:done',
          graph: slug,
          source: 'general-kb-research',
          detail: `${nodeIds.length} node(s) researched`,
        });
      } catch {}
      return { ok: true, nodes: nodeIds, text: result?.text || null, iterations: result?.iterations };
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = e.message || String(e);
      this._markFailed(db, nodeIds, {
        failedAt: new Date().toISOString(),
        error: (e.message || String(e)).slice(0, 300),
      });
      try {
        graphEvents.emit('change', {
          op: 'general-kb-research:fail',
          graph: slug,
          source: 'general-kb-research',
          detail: (e.message || '').slice(0, 120),
        });
      } catch {}
      throw e;
    } finally {
      try { db.close(); } catch {}
    }
  }

  _skip(reason, extra = {}) {
    this.stats.skipped++;
    return { skipped: reason, ...extra };
  }

  _selectCandidates(db, { batchSize = 1 } = {}) {
    const rows = db.prepare(`
      SELECT id, label, type, description, importance, extra, created, updated
      FROM nodes
      ORDER BY COALESCE(importance, 5) DESC, updated ASC, created ASC
      LIMIT 100
    `).all();
    const retryMs = GENERAL_KB_RESEARCH_RETRY_DAYS * 24 * 60 * 60_000;
    const now = Date.now();
    const skipTypes = new Set(['session', 'episode', 'message', 'log', 'activity_log', 'token_log']);
    const out = [];

    for (const row of rows) {
      const id = String(row.id || '').trim();
      const label = String(row.label || '').trim();
      const type = String(row.type || 'concept').trim().toLowerCase();
      if (!id || !label) continue;
      if (id.startsWith('ref-') || id.startsWith('session-') || id.startsWith('project-')) continue;
      if (id === 'spore-activity-log' || id === 'spore-token-log') continue;
      if (skipTypes.has(type)) continue;

      const extra = _parseExtra(row.extra);
      const state = extra.generalKbResearch || {};
      if (state.disabled) continue;

      const completedAt = _parseIsoMs(state.lastCompletedAt);
      if (completedAt) continue;

      const queuedAt = _parseIsoMs(state.lastQueuedAt);
      if (queuedAt && now - queuedAt < retryMs) continue;

      const failedAt = _parseIsoMs(state.lastFailedAt);
      if (failedAt && now - failedAt < retryMs) continue;

      out.push(row);
      if (out.length >= batchSize) break;
    }

    return out;
  }

  _buildPrompt(graph, db, candidates, { queuedAt, reason }) {
    const brief = candidates.map(row => this._nodeBrief(db, row)).join('\n\n');
    const slug = graph.slug;
    return [
      `You are running background research for Spore's General Knowledge Base graph.`,
      `Graph slug: \`${slug}\`. The \`project\` field in graph tools means graph slug here; include \`project: "${slug}"\` in every \`graph_update\` call.`,
      `Queued at: ${queuedAt}. Reason: ${reason}.`,
      ``,
      `Research only the nodes below. Do not ask the user questions and do not switch graphs.`,
      ``,
      brief,
      ``,
      `Procedure:`,
      `1. For each node, use web_search and web_fetch when current usage, APIs, package state, or recommendations may have changed. Prefer official docs and reputable sources.`,
      `2. Add useful, reusable facts back onto the same node with graph_update. Be additive: do not delete or rename existing nodes.`,
      `3. Prefer these aspects when relevant: overview, recommended_usage, when_to_use, setup, examples, limitations, pitfalls, related_tools, source_notes, research_status.`,
      `4. Keep each aspect compact. Store practical guidance, not long article summaries.`,
      `5. If a node is too vague to research, add a research_status attribute explaining why it was skipped.`,
      `6. Finish with a short summary of which nodes were enriched.`,
    ].join('\n');
  }

  _nodeBrief(db, row) {
    let aspectLines = '';
    try {
      const aspects = db.prepare('SELECT id, name, weight FROM aspects WHERE node_id = ? ORDER BY weight DESC, id ASC LIMIT 8').all(row.id);
      aspectLines = aspects.map(a => {
        const attrs = db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC, id ASC LIMIT 4').all(a.id);
        const content = attrs.map(at => at.content).filter(Boolean).join(' | ').slice(0, 320);
        return `  - ${a.name}: ${content || '(no attributes)'}`;
      }).join('\n');
    } catch {}
    return [
      `- ${row.label} (\`${row.id}\`, type=${row.type || 'concept'}, importance=${row.importance || 5})`,
      `  Description: ${row.description || '(none)'}`,
      `  Existing aspects:`,
      aspectLines || `  - (none)`,
    ].join('\n');
  }

  _memoryEnvelope(graph) {
    const slug = graph?.slug;
    const mainSlug = this.registry?.getMainSlug?.() || null;
    const scope = {
      slug,
      role: 'general_kb',
      label: graph?.name || 'General Knowledge Base',
      dbPath: this.registry?.getDbPath?.(slug) || null,
      budget: 18,
    };
    return {
      version: 1,
      source: 'general-kb-research',
      mode: 'general-kb-research',
      activeSlug: this.registry?.getActiveSlug?.() || slug,
      primarySlug: slug,
      readScopes: [scope],
      writeScopes: {
        defaultSlug: slug,
        personalSlug: mainSlug,
        generalKbSlug: slug,
        generalKnowledgeSlug: slug,
      },
    };
  }

  _markQueued(db, nodes, { queuedAt, reason }) {
    for (const node of nodes) {
      this._updateExtra(db, node.id, prev => ({
        ...prev,
        status: 'queued',
        attempts: Math.max(0, Number(prev.attempts) || 0) + 1,
        lastQueuedAt: queuedAt,
        lastReason: reason,
        lastError: null,
      }));
    }
  }

  _markCompleted(db, nodeIds, { completedAt, resultPreview }) {
    for (const id of nodeIds) {
      this._updateExtra(db, id, prev => ({
        ...prev,
        status: 'completed',
        lastCompletedAt: completedAt,
        lastResultPreview: resultPreview || null,
        lastError: null,
      }));
    }
  }

  _markFailed(db, nodeIds, { failedAt, error }) {
    for (const id of nodeIds) {
      this._updateExtra(db, id, prev => ({
        ...prev,
        status: 'failed',
        lastFailedAt: failedAt,
        lastError: error,
      }));
    }
  }

  _updateExtra(db, nodeId, updater) {
    try {
      const row = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(nodeId);
      if (!row) return;
      const extra = _parseExtra(row.extra);
      const prev = extra.generalKbResearch && typeof extra.generalKbResearch === 'object'
        ? extra.generalKbResearch
        : {};
      extra.generalKbResearch = updater(prev);
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extra), nodeId);
    } catch (e) {
      this.log.warn(`[general-kb-research] failed to update node ${nodeId}: ${e.message}`);
    }
  }
}

module.exports = { GeneralKbResearchWorker };
