/**
 * graph-maintenance.js — registry-aware graph maintenance coordinator.
 *
 * The normal Maintainer/Janitor are bound to the active graph DB. This worker
 * gives scheduled/manual maintenance a registry-wide path so every graph can be
 * maintained or cleaned without making it the active graph.
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
    this._lastJanitorRunAt = null;
    this.stats = {
      cycles: 0,
      graphsChecked: 0,
      graphsMaintained: 0,
      graphsCleaned: 0,
      graphsSkipped: 0,
      maintainerRuns: 0,
      lifecycleReviews: 0,
      candidatesPromoted: 0,
      embeddings: 0,
      communities: 0,
      overviews: 0,
      janitorRuns: 0,
      backups: 0,
      errors: 0,
      lastRunAt: null,
      lastJanitorRunAt: null,
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
      maintainer: active && !managed ? 'active' : 'scoped',
      janitor: active && !managed ? 'active' : (!managed ? 'full' : 'scoped'),
      backup: true,
      distill: role === 'project' || role === 'channel' || role === 'user',
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

  _shouldClean(graph, { force = false } = {}) {
    if (!graph?.slug) return false;
    if (force) return true;
    if (graph.janitorStatus === 'running') {
      const started = Date.parse(graph.janitorStartedAt || 0);
      if (Number.isFinite(started) && Date.now() - started < 30 * 60_000) return false;
    }
    const mins = _minutes(this.config.janitorIntervalMinutes, 360);
    const last = Date.parse(graph.lastCleanedAt || 0);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last >= mins * 60_000;
  }

  _runLimit(batchSize) {
    const raw = batchSize ?? this.config.graphMaintenanceBatchSize;
    if (raw === 'all' || raw === Infinity) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n <= 0) return null;
    return Math.max(1, Math.floor(Number.isFinite(n) ? n : DEFAULT_BATCH_SIZE));
  }

  async run({
    force = false,
    includeActive = true,
    batchSize = null,
    reason = 'scheduled',
    runMaintainer = true,
    runCandidateReview = runMaintainer,
    runJanitor = false,
    runDistill = true,
    runBackup = true,
  } = {}) {
    if (this._running) return { running: true };
    if (!this.registry || !this.learner) return { skipped: 'missing-registry-or-learner' };

    const intervalMs = (runMaintainer
      ? _minutes(this.config.graphMaintenanceIntervalMinutes, DEFAULT_INTERVAL_MINUTES)
      : _minutes(this.config.janitorIntervalMinutes, 360)) * 60_000;
    const lastRunAt = runMaintainer ? this._lastRunAt : this._lastJanitorRunAt;
    if (!force && lastRunAt && Date.now() - lastRunAt < intervalMs) return null;

    this._running = true;
    if (runMaintainer) this._lastRunAt = Date.now();
    if (runJanitor && !runMaintainer) this._lastJanitorRunAt = Date.now();
    this.stats.cycles++;
    const nowIso = new Date().toISOString();
    if (runMaintainer) this.stats.lastRunAt = nowIso;
    if (runJanitor && !runMaintainer) this.stats.lastJanitorRunAt = nowIso;

    const activeSlug = this.registry.getActiveSlug?.();
    const limit = this._runLimit(batchSize);
    const candidates = (this.registry.list?.() || [])
      .filter(g => includeActive || g.slug !== activeSlug)
      .filter(g => runMaintainer
        ? this._shouldMaintain(g, { force })
        : (runJanitor ? this._shouldClean(g, { force }) : false));
    const graphs = limit ? candidates.slice(0, limit) : candidates;

    const results = [];
    try {
      for (const graph of graphs) {
        this.stats.graphsChecked++;
        const result = await this.maintainGraph(graph.slug, {
          force,
          includeActive,
          reason,
          runMaintainer,
          runCandidateReview,
          runJanitor,
          runDistill,
          runBackup,
        });
        results.push(result);
        if (result?.ok && runMaintainer) this.stats.graphsMaintained++;
        else if (result?.ok && runJanitor) this.stats.graphsCleaned++;
        else this.stats.graphsSkipped++;
      }
      return { checked: graphs.length, results };
    } finally {
      this._running = false;
    }
  }

  async cleanGraph(slug, opts = {}) {
    return this.maintainGraph(slug, {
      ...opts,
      runMaintainer: false,
      runJanitor: true,
      runDistill: false,
      runBackup: false,
      reason: opts.reason || 'manual-clean',
    });
  }

  async maintainGraph(slug, {
    force = false,
    includeActive = true,
    reason = 'manual',
    runMaintainer = true,
    runCandidateReview = runMaintainer,
    runJanitor = true,
    runDistill = true,
    runBackup = true,
  } = {}) {
    const graph = this.registry?.get?.(slug);
    if (!graph) return { slug, ok: false, error: 'graph not found' };
    if (this._locks.has(slug)) return { slug, ok: false, skipped: 'already-running' };

    const active = slug === this.registry.getActiveSlug?.();
    if (active && !includeActive) return { slug, ok: false, skipped: 'active-graph-covered-by-active-workers' };

    const db = active ? (this.learner?.db || null) : this.learner?.getGraphDb?.(slug);
    if (!db) return { slug, ok: false, error: 'graph db unavailable' };

    const started = Date.now();
    const maintenanceStarted = runMaintainer || runCandidateReview || runDistill || runBackup;
    const janitorStarted = runJanitor;
    const policy = this.policyFor(graph, { active });
    const summary = {
      role: policy.role,
      maintainer: null,
      lifecycle: null,
      janitor: null,
      distill: null,
      backup: null,
    };

    this._locks.add(slug);
    if (maintenanceStarted) this.registry.recordMaintenanceStart?.(slug, { reason });
    if (janitorStarted) this.registry.recordJanitorStart?.(slug, { reason });
    try {
      const scoped = (fn) => graphEvents.withGraph({ graph: slug }, fn);
      try {
        graphEvents.emit('change', {
          op: 'graph-maintenance:start',
          graph: slug,
          source: 'graph-maintenance',
          detail: `${policy.role} · ${reason}`,
        });
      } catch {}

      if (runMaintainer) {
        this.log.info(`[graph-maintenance] ${slug} maintainer start`);
        summary.maintainer = await scoped(() => (
          policy.maintainer === 'active' && this.activeMaintainer
            ? this._runActiveMaintainer(db, { force })
            : this._runScopedMaintainer(graph, db, { force })
        ));
        if (summary.maintainer && !summary.maintainer.skipped) this.stats.maintainerRuns++;
        this.stats.embeddings += summary.maintainer?.embedded || 0;
        if (summary.maintainer?.clustered) this.stats.communities++;
        if (summary.maintainer?.overviewed) this.stats.overviews++;
      }

      if (runCandidateReview) {
        this.log.info(`[graph-maintenance] ${slug} candidate lifecycle review start`);
        summary.lifecycle = await scoped(() => this._runCandidateReview(graph, db, { force, promoteOnly: true }));
        if (summary.lifecycle && !summary.lifecycle.skipped) this.stats.lifecycleReviews++;
        this.stats.candidatesPromoted += summary.lifecycle?.candidatesPromoted || 0;
      }

      if (runJanitor) {
        this.log.info(`[graph-maintenance] ${slug} janitor start`);
        summary.janitor = await scoped(() => {
          if (policy.janitor === 'active' && this.activeJanitor) {
            return this._runActiveJanitor({ force });
          }
          if (policy.janitor === 'full') {
            return this._runFullJanitor(db, { force });
          }
          return this._runScopedJanitor(graph, db, { force });
        });
        if (summary.janitor) this.stats.janitorRuns++;
      }

      if (runDistill && policy.distill && this.scopedDistiller?.distillGraph && (force || graph.distillDirty)) {
        summary.distill = await scoped(() => this.scopedDistiller.distillGraph(graph));
      }

      if (runBackup && policy.backup && this.backup?.runBackupForGraph) {
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
      if (maintenanceStarted) {
        this.registry.recordMaintenanceResult?.(slug, {
          success: true,
          durationMs,
          summary,
          embedded: (summary.maintainer?.embedded || 0) > 0,
          clustered: !!summary.maintainer?.clustered,
          overviewed: !!summary.maintainer?.overviewed,
          candidatesPromoted: summary.lifecycle?.candidatesPromoted || 0,
          backedUp: !!(summary.backup?.ok && !summary.backup?.skipped),
          communityState: summary.maintainer?.communityState,
          embeddingBacklog: summary.maintainer?.embeddingBacklog,
        });
      }
      if (janitorStarted) {
        this.registry.recordJanitorResult?.(slug, {
          success: !summary.janitor?.error,
          durationMs,
          summary: summary.janitor,
          error: summary.janitor?.error,
        });
      }
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
      if (maintenanceStarted) {
        this.registry.recordMaintenanceResult?.(slug, {
          success: false,
          durationMs,
          error: e.message,
          summary,
        });
      }
      if (janitorStarted) {
        this.registry.recordJanitorResult?.(slug, {
          success: false,
          durationMs,
          error: e.message,
          summary: summary.janitor,
        });
      }
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

  async _runActiveMaintainer(db, { force = false } = {}) {
    if (!this.activeMaintainer) return { skipped: 'active-maintainer-unavailable' };
    if (this.activeMaintainer._running) return { skipped: 'already-running' };
    const beforeStats = { ...this.activeMaintainer.stats };
    const counts = this._graphCounts(db);
    const result = await this.activeMaintainer.runMaintenance({ force });
    return this._withMaintenanceCounts(result, db, counts, beforeStats, this.activeMaintainer.stats);
  }

  async _runScopedMaintainer(graph, db, { force = false } = {}) {
    const maintainer = new Maintainer(this.config, this.log, this.client, db);
    try {
      maintainer.ensureSchema();
      const counts = this._graphCounts(db);
      const beforeStats = { ...maintainer.stats };
      const result = await maintainer.runMaintenance({ force });
      return this._withMaintenanceCounts(result, db, counts, beforeStats, maintainer.stats);
    } finally {
      try { maintainer.shutdown?.(); } catch {}
    }
  }

  _withMaintenanceCounts(result, db, beforeCounts, beforeStats = {}, afterStats = {}) {
    const afterCounts = this._graphCounts(db);
    const skipped = !result || result.skipped;
    return {
      ...(result || { skipped: 'no-maintainer-result' }),
      nodeCount: afterCounts.nodes,
      edgeCount: afterCounts.edges,
      embedded: (afterStats.nodesEmbedded || 0) - (beforeStats.nodesEmbedded || 0),
      clustered: !skipped && afterCounts.communityCount > 0,
      communityCount: afterCounts.communityCount || 0,
      communityState: afterCounts.communityCount
        ? 'ready'
        : ((afterCounts.nodes >= 20 && afterCounts.edges >= 10) ? 'unclustered' : 'too_small'),
      overviewed: !skipped,
      embeddingBacklog: afterCounts.embeddingBacklog,
      before: beforeCounts,
    };
  }

  async _runActiveJanitor({ force = false } = {}) {
    if (!this.activeJanitor) return { skipped: 'active-janitor-unavailable' };
    if (this.activeJanitor._running) return { skipped: 'already-running' };
    return this.activeJanitor.runJanitor({ force });
  }

  async _runFullJanitor(db, { force = false } = {}) {
    const janitor = new Janitor(this.config, this.log, this.client, db);
    try {
      janitor.ensureSchema();
      return janitor.runJanitor({ force });
    } finally {
      janitor._running = false;
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

  async _runCandidateReview(graph, db, { force = false, promoteOnly = true } = {}) {
    const active = graph?.slug === this.registry?.getActiveSlug?.();
    if (active && this.activeJanitor) {
      return this.activeJanitor.runCandidateReview({ force, promoteOnly });
    }
    const janitor = new Janitor(
      { ...this.config },
      this.log,
      this.client,
      db,
    );
    janitor.ensureSchema();
    return janitor.runCandidateReview({ force, promoteOnly });
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
