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

const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_BATCH_SIZE = 4;

function _minutes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _role(graph) {
  return String(graph?.role || 'custom');
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
    this.scopedDistiller = deps.channelDistiller || deps.scopedDistiller || null;
    this.backup = deps.backup || null;
    this._running = false;
    this._locks = new Set();
    this._lastRunAt = null;
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
    const managed = role === 'project' || role === 'channel' || role === 'user' || role === 'general_kb';
    return {
      role,
      structural: true,
      embedLimit: role === 'general_kb' ? 20 : 12,
      janitor: active && !managed ? 'active' : (role === 'general_kb' ? 'bin' : 'temp'),
      backup: true,
      distill: role === 'project' || role === 'channel' || role === 'user',
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
      distill: null,
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

      if (policy.distill && this.scopedDistiller?.distillGraph && (force || graph.distillDirty)) {
        summary.distill = await this.scopedDistiller.distillGraph(graph);
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
