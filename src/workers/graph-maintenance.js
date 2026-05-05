/**
 * graph-maintenance.js — registry-aware graph maintenance coordinator.
 *
 * The normal Maintainer/Janitor are bound to the active graph DB. This worker
 * keeps managed graphs from going stale without activating them or running
 * speculative/proactive passes across isolated memory scopes.
 */

const { Maintainer } = require('./maintainer');
const { Janitor } = require('./janitor');
const graphEvents = require('../graph/events');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_GENERAL_KB_RESEARCH_INTERVAL_HOURS = 24;
const DEFAULT_GENERAL_KB_RESEARCH_BATCH_SIZE = 1;
const GENERAL_KB_RESEARCH_RETRY_DAYS = 7;

function _minutes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

class GraphMaintenanceCoordinator {
  constructor(config, log, llmClient, learner, registry, deps = {}) {
    this.config = config || {};
    this.log = log || console;
    this.client = llmClient || null;
    this.learner = learner || null;
    this.registry = registry || null;
    this.activeMaintainer = deps.maintainer || null;
    this.activeJanitor = deps.janitor || null;
    this.backup = deps.backup || null;
    this.agent = deps.agent || null;
    this.queue = deps.queue || null;
    this._running = false;
    this._locks = new Set();
    this._lastRunAt = null;
    this._kbResearchLastRun = new Map();
    this.stats = {
      cycles: 0,
      graphsChecked: 0,
      graphsMaintained: 0,
      graphsSkipped: 0,
      embeddings: 0,
      communities: 0,
      overviews: 0,
      janitorRuns: 0,
      backups: 0,
      kbResearchQueued: 0,
      kbResearchSkipped: 0,
      kbResearchErrors: 0,
      lastKbResearchAt: null,
      errors: 0,
      lastRunAt: null,
    };
  }

  getStats() {
    return {
      ...this.stats,
      running: this._running,
      lockedGraphs: this._locks.size,
    };
  }

  policyFor(graph, { active = false } = {}) {
    const role = _role(graph);
    const managed = role === 'project' || role === 'channel' || role === 'general_kb';
    return {
      role,
      structural: true,
      embedLimit: role === 'general_kb' ? 20 : 12,
      janitor: active && !managed ? 'active' : (role === 'general_kb' ? 'bin' : 'temp'),
      backup: true,
      research: role === 'general_kb',
      activeFullMaintainer: active && !managed,
    };
  }

  _shouldMaintain(graph, { force = false } = {}) {
    if (!graph?.slug) return false;
    if (force) return true;
    if (graph.maintenanceStatus === 'running') {
      const started = Date.parse(graph.maintenanceStartedAt || 0);
      if (Number.isFinite(started) && Date.now() - started < 30 * 60_000) return false;
    }
    const mins = _minutes(this.config.graphMaintenanceIntervalMinutes, DEFAULT_INTERVAL_MINUTES);
    const last = Date.parse(graph.lastMaintainedAt || graph.lastClusteredAt || graph.lastOverviewAt || 0);
    if (!Number.isFinite(last)) return true;
    if (Date.now() - last >= mins * 60_000) return true;
    return (graph.communityState === 'unclustered')
      || (Number(graph.embeddingBacklog || 0) > 0 && Date.now() - last >= 30 * 60_000);
  }

  async run({ force = false, includeActive = false, batchSize = null, reason = 'scheduled' } = {}) {
    if (this._running) return { running: true };
    if (!this.registry || !this.learner) return { skipped: 'missing-registry-or-learner' };

    const intervalMs = _minutes(this.config.graphMaintenanceIntervalMinutes, DEFAULT_INTERVAL_MINUTES) * 60_000;
    if (!force && this._lastRunAt && Date.now() - this._lastRunAt < intervalMs) return null;

    this._running = true;
    this._lastRunAt = Date.now();
    this.stats.cycles++;
    this.stats.lastRunAt = new Date().toISOString();

    const activeSlug = this.registry.getActiveSlug?.();
    const limit = Math.max(1, Math.floor(Number(batchSize || this.config.graphMaintenanceBatchSize) || DEFAULT_BATCH_SIZE));
    const graphs = (this.registry.list?.() || [])
      .filter(g => includeActive || g.slug !== activeSlug)
      .filter(g => this._shouldMaintain(g, { force }))
      .slice(0, limit);

    const results = [];
    try {
      for (const graph of graphs) {
        this.stats.graphsChecked++;
        const result = await this.maintainGraph(graph.slug, {
          force,
          includeActive,
          reason,
        });
        results.push(result);
        if (result?.ok) this.stats.graphsMaintained++;
        else this.stats.graphsSkipped++;
      }
      return { checked: graphs.length, results };
    } finally {
      this._running = false;
    }
  }

  async maintainGraph(slug, { force = false, includeActive = true, reason = 'manual' } = {}) {
    const graph = this.registry?.get?.(slug);
    if (!graph) return { slug, ok: false, error: 'graph not found' };
    if (this._locks.has(slug)) return { slug, ok: false, skipped: 'already-running' };

    const active = slug === this.registry.getActiveSlug?.();
    if (active && !includeActive) return { slug, ok: false, skipped: 'active-graph-covered-by-active-workers' };

    const db = active ? (this.learner?.db || null) : this.learner?.getGraphDb?.(slug);
    if (!db) return { slug, ok: false, error: 'graph db unavailable' };

    const started = Date.now();
    const policy = this.policyFor(graph, { active });
    const summary = {
      role: policy.role,
      structural: false,
      janitor: null,
      research: null,
      backup: null,
    };

    this._locks.add(slug);
    this.registry.recordMaintenanceStart?.(slug, { reason });
    try {
      try {
        graphEvents.emit('change', {
          op: 'graph-maintenance:start',
          graph: slug,
          source: 'graph-maintenance',
          detail: `${policy.role} · ${reason}`,
        });
      } catch {}

      if (policy.activeFullMaintainer && this.activeMaintainer && !this.activeMaintainer._running) {
        summary.activeMaintainer = await this.activeMaintainer.runMaintenance({ force: true });
      } else if (policy.structural) {
        summary.structural = await this._runStructuralPasses(graph, db, policy, { force });
        this.stats.embeddings += summary.structural?.embedded || 0;
        if (summary.structural?.clustered) this.stats.communities++;
        if (summary.structural?.overviewed) this.stats.overviews++;
      }

      if (policy.janitor === 'active' && this.activeJanitor && !this.activeJanitor._running) {
        summary.janitor = await this.activeJanitor.runJanitor({ force: true });
        if (summary.janitor) this.stats.janitorRuns++;
      } else if (policy.janitor && policy.janitor !== 'active') {
        summary.janitor = await this._runScopedJanitor(graph, db, { force });
        if (summary.janitor) this.stats.janitorRuns++;
      }

      if (policy.research) {
        summary.research = await this._runGeneralKbResearch(graph, db, { force, reason });
        if (summary.research?.queued) {
          this.stats.kbResearchQueued += summary.research.queued;
        } else if (summary.research?.skipped) {
          this.stats.kbResearchSkipped++;
        }
      }

      if (policy.backup && this.backup?.runBackupForGraph) {
        const dbPath = this.registry.getDbPath?.(slug);
        summary.backup = await this.backup.runBackupForGraph({
          slug,
          dbPath,
          force,
          note: reason === 'manual' ? 'manual-maintenance' : 'maintenance',
        });
        if (summary.backup?.ok && !summary.backup?.skipped) this.stats.backups++;
      }

      const durationMs = Date.now() - started;
      this.registry.recordMaintenanceResult?.(slug, {
        success: true,
        durationMs,
        summary,
        embedded: (summary.structural?.embedded || 0) > 0,
        clustered: !!summary.structural?.clustered,
        overviewed: !!summary.structural?.overviewed,
        backedUp: !!(summary.backup?.ok && !summary.backup?.skipped),
        communityState: summary.structural?.communityState,
        embeddingBacklog: summary.structural?.embeddingBacklog,
      });
      this.log.info(`[graph-maintenance] ${slug} (${policy.role}) done in ${durationMs}ms`);
      try {
        graphEvents.emit('change', {
          op: 'graph-maintenance:done',
          graph: slug,
          source: 'graph-maintenance',
          detail: `${policy.role} · ${durationMs}ms`,
        });
      } catch {}
      return { slug, ok: true, durationMs, summary };
    } catch (e) {
      this.stats.errors++;
      const durationMs = Date.now() - started;
      this.registry.recordMaintenanceResult?.(slug, {
        success: false,
        durationMs,
        error: e.message,
        summary,
      });
      this.log.warn(`[graph-maintenance] ${slug} failed: ${e.message}`);
      try {
        graphEvents.emit('change', {
          op: 'graph-maintenance:fail',
          graph: slug,
          source: 'graph-maintenance',
          detail: (e.message || '').slice(0, 120),
        });
      } catch {}
      return { slug, ok: false, error: e.message, durationMs, summary };
    } finally {
      this._locks.delete(slug);
    }
  }

  async _runStructuralPasses(graph, db, policy, { force = false } = {}) {
    const maintainer = new Maintainer(this.config, this.log, this.client, db);
    try {
      maintainer.ensureSchema();
      const beforeEmbedded = maintainer.stats.nodesEmbedded || 0;
      const counts = this._graphCounts(db);
      await maintainer.embedUnembeddedNodes(policy.embedLimit);
      const community = await maintainer.runCommunityDetection({ force });
      const overview = await maintainer.runGraphOverview({ force });
      const afterCounts = this._graphCounts(db);
      return {
        nodeCount: afterCounts.nodes,
        edgeCount: afterCounts.edges,
        embedded: (maintainer.stats.nodesEmbedded || 0) - beforeEmbedded,
        clustered: !!community?.communityCount,
        communityCount: community?.communityCount || afterCounts.communityCount || 0,
        communityState: (community?.communityCount || afterCounts.communityCount)
          ? 'ready'
          : ((afterCounts.nodes >= 20 && afterCounts.edges >= 10) ? 'unclustered' : 'too_small'),
        overviewed: !!overview,
        embeddingBacklog: afterCounts.embeddingBacklog,
        skippedSmall: afterCounts.nodes < 20 || afterCounts.edges < 10,
        before: counts,
      };
    } finally {
      try { maintainer.shutdown?.(); } catch {}
    }
  }

  async _runScopedJanitor(graph, db, { force = false } = {}) {
    const janitor = new Janitor(
      { ...this.config, janitorMode: 'conservative' },
      this.log,
      this.client,
      db,
    );
    janitor.ensureSchema();
    return janitor.runScopedJanitor({ role: _role(graph), force });
  }

  async _runGeneralKbResearch(graph, db, { force = false, reason = 'scheduled' } = {}) {
    const slug = graph?.slug;
    if (!slug || _role(graph) !== 'general_kb') return null;
    if (this.config.generalKbResearchEnabled === false) return { skipped: 'disabled' };
    if (!this.agent?.processMessage) return { skipped: 'agent-unavailable' };

    const intervalHours = _hours(this.config.generalKbResearchIntervalHours, DEFAULT_GENERAL_KB_RESEARCH_INTERVAL_HOURS);
    const nowMs = Date.now();
    const lastRun = this._kbResearchLastRun.get(slug);
    if (!force && lastRun && nowMs - lastRun < intervalHours * 60 * 60_000) {
      return {
        skipped: 'interval',
        nextEligibleAt: new Date(lastRun + intervalHours * 60 * 60_000).toISOString(),
      };
    }

    const batchSize = Math.max(
      1,
      Math.floor(Number(this.config.generalKbResearchBatchSize) || DEFAULT_GENERAL_KB_RESEARCH_BATCH_SIZE),
    );
    const candidates = this._selectGeneralKbResearchCandidates(db, { batchSize });
    this._kbResearchLastRun.set(slug, nowMs);
    if (!candidates.length) return { skipped: 'no-candidates' };

    const queuedAt = new Date(nowMs).toISOString();
    const nodeIds = candidates.map(n => n.id);
    this._markGeneralKbResearchQueued(db, candidates, { queuedAt, reason });
    const prompt = this._buildGeneralKbResearchPrompt(graph, db, candidates, { queuedAt, reason });
    const sessionKey = `general-kb-research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const memoryEnvelope = this._generalKbMemoryEnvelope(graph);

    try {
      graphEvents.emit('change', {
        op: 'general-kb-research:start',
        graph: slug,
        source: 'graph-maintenance',
        detail: `${nodeIds.length} node(s) queued`,
      });
    } catch {}

    this.stats.lastKbResearchAt = queuedAt;
    const agentOpts = {
      content: prompt,
      channelId: sessionKey,
      channelName: 'general-kb-research',
      userId: 'system',
      userName: 'General KB Researcher',
      trigger: 'worker',
      platform: 'system',
      isDm: false,
      memoryEnvelope,
    };
    if (this.queue?.submitWorkerJob) {
      this.queue.submitWorkerJob('generalKbResearch.run', {
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
      Promise.resolve(this.runGeneralKbResearchJob({ slug, nodeIds, agentOpts }))
        .catch(e => this.log.warn(`[general-kb-research] ${slug} failed: ${e.message}`));
    }

    return { ok: true, queued: nodeIds.length, nodes: nodeIds, sessionKey };
  }

  async runGeneralKbResearchJob({ slug, nodeIds = [], agentOpts = null } = {}) {
    if (!slug) throw new Error('generalKbResearch.run requires slug');
    if (!this.agent?.processMessage) throw new Error('agent unavailable');
    const graph = this.registry?.get?.(slug);
    if (!graph) throw new Error(`graph not found: ${slug}`);
    const dbPath = this.registry?.getDbPath?.(slug);
    if (!dbPath) throw new Error(`graph db path not found: ${slug}`);

    const db = new DatabaseSync(dbPath);
    try {
      const result = await this.agent.processMessage(agentOpts || {});
      this._markGeneralKbResearchCompleted(db, nodeIds, {
        completedAt: new Date().toISOString(),
        resultPreview: String(result?.text || result?.content || '').slice(0, 500),
      });
      try {
        graphEvents.emit('change', {
          op: 'general-kb-research:done',
          graph: slug,
          source: 'graph-maintenance',
          detail: `${nodeIds.length} node(s) researched`,
        });
      } catch {}
      return { ok: true, nodes: nodeIds, text: result?.text || null, iterations: result?.iterations };
    } catch (e) {
      this.stats.kbResearchErrors++;
      this._markGeneralKbResearchFailed(db, nodeIds, {
        failedAt: new Date().toISOString(),
        error: (e.message || String(e)).slice(0, 300),
      });
      try {
        graphEvents.emit('change', {
          op: 'general-kb-research:fail',
          graph: slug,
          source: 'graph-maintenance',
          detail: (e.message || '').slice(0, 120),
        });
      } catch {}
      throw e;
    } finally {
      try { db.close(); } catch {}
    }
  }

  _selectGeneralKbResearchCandidates(db, { batchSize = 1 } = {}) {
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

  _buildGeneralKbResearchPrompt(graph, db, candidates, { queuedAt, reason }) {
    const brief = candidates.map(row => this._generalKbNodeBrief(db, row)).join('\n\n');
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

  _generalKbNodeBrief(db, row) {
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

  _generalKbMemoryEnvelope(graph) {
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
      source: 'graph-maintenance',
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

  _markGeneralKbResearchQueued(db, nodes, { queuedAt, reason }) {
    for (const node of nodes) {
      this._updateGeneralKbResearchExtra(db, node.id, prev => ({
        ...prev,
        status: 'queued',
        attempts: Math.max(0, Number(prev.attempts) || 0) + 1,
        lastQueuedAt: queuedAt,
        lastReason: reason,
        lastError: null,
      }));
    }
  }

  _markGeneralKbResearchCompleted(db, nodeIds, { completedAt, resultPreview }) {
    for (const id of nodeIds) {
      this._updateGeneralKbResearchExtra(db, id, prev => ({
        ...prev,
        status: 'completed',
        lastCompletedAt: completedAt,
        lastResultPreview: resultPreview || null,
        lastError: null,
      }));
    }
  }

  _markGeneralKbResearchFailed(db, nodeIds, { failedAt, error }) {
    for (const id of nodeIds) {
      this._updateGeneralKbResearchExtra(db, id, prev => ({
        ...prev,
        status: 'failed',
        lastFailedAt: failedAt,
        lastError: error,
      }));
    }
  }

  _updateGeneralKbResearchExtra(db, nodeId, updater) {
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

  _graphCounts(db) {
    const out = { nodes: 0, edges: 0, communityCount: 0, embeddingBacklog: 0 };
    try { out.nodes = db.prepare('SELECT COUNT(*) AS c FROM nodes').get()?.c || 0; } catch {}
    try { out.edges = db.prepare('SELECT COUNT(*) AS c FROM edges').get()?.c || 0; } catch {}
    try { out.communityCount = db.prepare("SELECT COUNT(*) AS c FROM node_groups WHERE superseded_at IS NULL").get()?.c || 0; } catch {}
    try { out.embeddingBacklog = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE embedding IS NULL OR embedding = ''").get()?.c || 0; } catch {}
    return out;
  }
}

module.exports = { GraphMaintenanceCoordinator };
