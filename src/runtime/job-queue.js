'use strict';

const crypto = require('node:crypto');
const graphEvents = require('../graph/events');

const DEFAULT_LANE_LIMITS = {
  interactive: 2,
  channel: 1,
  deferred: 1,
  learner: 1,
  maintenance: 1,
  background: 1,
};

const DEFAULT_PRIORITIES = {
  interactive: 100,
  channel: 80,
  deferred: 60,
  learner: 40,
  maintenance: 25,
  background: 10,
};

const PERSISTENT_STATUSES = new Set(['queued', 'running', 'failed', 'done', 'cancelled']);

function now() {
  return Date.now();
}

function parseJson(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function stringifyJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function normalizeLane(lane) {
  return DEFAULT_LANE_LIMITS[lane] ? lane : 'background';
}

function jobId(prefix = 'job') {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

class RuntimeJobQueue {
  constructor(config, log, sessions, deps = {}) {
    this.config = config || {};
    this.log = log || console;
    this.sessions = sessions || null;
    this.db = sessions?.db || null;
    this.agent = deps.agent || null;
    this.tools = deps.tools || null;
    this.learner = deps.learner || null;
    this.handlers = new Map();
    this.workerDeps = { ...deps };
    this.laneLimits = { ...DEFAULT_LANE_LIMITS, ...(this.config.runtimeQueueLaneLimits || {}) };
    this._memoryJobs = new Map();
    this._resolvers = new Map();
    this._running = new Map();
    this._runningSessions = new Set();
    this._timer = null;
    this._stopped = true;
    this._pumpScheduled = false;
    this.stats = {
      queued: 0,
      started: 0,
      done: 0,
      failed: 0,
      retried: 0,
      cancelled: 0,
      yielded: 0,
    };
    this._registerDefaultHandlers();
  }

  init() {
    this.db = this.sessions?.db || this.db;
    this._ensureSchema();
    this._recoverPersistentJobs();
    this.start();
    return true;
  }

  start() {
    if (this._timer) return;
    this._stopped = false;
    this._timer = setInterval(() => this._pump(), 500);
    this._pump();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  setDeps(deps = {}) {
    Object.assign(this.workerDeps, deps);
    for (const [k, v] of Object.entries(deps)) {
      if (k === 'agent') this.agent = v;
      else if (k === 'tools') this.tools = v;
      else if (k === 'learner') this.learner = v;
    }
  }

  registerHandler(kind, handler, defaults = {}) {
    if (!kind || typeof handler !== 'function') throw new Error('registerHandler requires kind + handler');
    this.handlers.set(kind, { handler, defaults });
  }

  submitAgentTurn(opts, meta = {}) {
    if (!opts || typeof opts !== 'object') throw new Error('submitAgentTurn requires opts');
    const sessionKey = opts.sessionKey || this._buildSessionKey(opts);
    opts.sessionKey = sessionKey;
    const lane = normalizeLane(meta.lane || this._laneForAgentTurn(opts, meta));
    const priority = meta.priority ?? DEFAULT_PRIORITIES[lane] ?? 1;

    if (meta.allowInterjection !== false && this._isInteractiveLane(lane) && this._isSessionBusy(sessionKey)) {
      const injected = this.agent?.interject?.(sessionKey, opts.content || '', opts);
      if (injected) {
        this._emit('queue:interject', {
          id: null,
          kind: 'agent.turn',
          lane,
          sessionKey,
          route: meta.route || opts.platform || 'agent',
          detail: 'queued into running session',
        });
        return Promise.resolve({ text: null, interjected: true, sessionKey });
      }
    }

    return this.submit('agent.turn', { opts }, {
      ...meta,
      lane,
      priority,
      sessionKey,
      route: meta.route || opts.platform || 'agent',
      graph: meta.graph || opts.memoryEnvelope?.primarySlug || null,
    });
  }

  submitWorkerJob(kind, payload = {}, meta = {}) {
    const registered = this.handlers.get(kind);
    const lane = normalizeLane(meta.lane || registered?.defaults?.lane || 'background');
    return this.submit(kind, payload, {
      ...registered?.defaults,
      ...meta,
      lane,
      priority: meta.priority ?? registered?.defaults?.priority ?? DEFAULT_PRIORITIES[lane] ?? 1,
    });
  }

  submit(kind, payload = {}, meta = {}) {
    const lane = normalizeLane(meta.lane || this.handlers.get(kind)?.defaults?.lane || 'background');
    const persistent = meta.persistent === true;
    const id = meta.id || jobId(kind.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'job');
    const created = now();
    const job = {
      id,
      kind,
      lane,
      priority: Number(meta.priority ?? DEFAULT_PRIORITIES[lane] ?? 1),
      status: 'queued',
      sessionKey: meta.sessionKey || null,
      route: meta.route || kind,
      graph: meta.graph || null,
      runAt: Number(meta.runAt || created),
      attempts: 0,
      maxAttempts: Math.max(1, Number(meta.maxAttempts || (persistent ? 3 : 1))),
      payload,
      persistent,
      created,
      updated: created,
    };

    if (persistent) {
      this._insertPersistent(job);
      if (meta.awaitResult) {
        const promise = new Promise((resolve, reject) => {
          this._resolvers.set(id, { resolve, reject });
        });
        this._schedulePump();
        return promise;
      }
      this._schedulePump();
      return { queued: true, jobId: id, persistent: true, lane };
    }

    const promise = new Promise((resolve, reject) => {
      this._memoryJobs.set(id, job);
      this._resolvers.set(id, { resolve, reject });
    });
    this._schedulePump();
    return promise;
  }

  cancelJob(id, reason = 'cancelled') {
    const mem = this._memoryJobs.get(id);
    if (mem && mem.status === 'queued') {
      mem.status = 'cancelled';
      this._memoryJobs.delete(id);
      this.stats.cancelled++;
      this._resolve(id, { cancelled: true, reason });
      this._emit('queue:cancel', mem, { detail: reason });
      return { ok: true, id, status: 'cancelled' };
    }
    if (this.db) {
      const row = this._getPersistentRow(id);
      if (row && row.status === 'queued') {
        this.db.prepare("UPDATE runtime_jobs SET status='cancelled', error=?, updated_at=?, completed_at=? WHERE id=?")
          .run(reason, now(), now(), id);
        this.stats.cancelled++;
        this._emit('queue:cancel', this._rowToJob(row), { detail: reason });
        return { ok: true, id, status: 'cancelled' };
      }
    }
    return { ok: false, error: 'job not found or not cancellable' };
  }

  retryJob(id) {
    if (!this.db) return { ok: false, error: 'persistent queue unavailable' };
    const row = this._getPersistentRow(id);
    if (!row || !['failed', 'cancelled'].includes(row.status)) return { ok: false, error: 'job not retryable' };
    this.db.prepare("UPDATE runtime_jobs SET status='queued', error=NULL, run_at=?, updated_at=? WHERE id=?")
      .run(now(), now(), id);
    this.stats.retried++;
    this._emit('queue:retry', this._rowToJob(row));
    this._schedulePump();
    return { ok: true, id, status: 'queued' };
  }

  getStats() {
    const lanes = {};
    for (const lane of Object.keys(this.laneLimits)) {
      lanes[lane] = {
        limit: this._laneLimit(lane),
        running: this._runningCount(lane),
      };
    }
    const memoryPending = [...this._memoryJobs.values()].filter(j => j.status === 'queued').length;
    let persistent = {};
    if (this.db) {
      try {
        for (const row of this.db.prepare('SELECT status, COUNT(*) AS c FROM runtime_jobs GROUP BY status').all()) {
          persistent[row.status] = row.c;
        }
      } catch {}
    }
    return {
      ...this.stats,
      running: this._running.size,
      memoryPending,
      persistent,
      lanes,
      stopped: this._stopped,
    };
  }

  listJobs({ status = null, limit = 100 } = {}) {
    const out = [];
    for (const job of this._memoryJobs.values()) {
      if (!status || job.status === status) out.push(this._publicJob(job));
    }
    if (this.db) {
      const max = Math.max(1, Math.min(Number(limit) || 100, 500));
      const rows = status
        ? this.db.prepare('SELECT * FROM runtime_jobs WHERE status=? ORDER BY priority DESC, run_at ASC, created_at ASC LIMIT ?').all(status, max)
        : this.db.prepare('SELECT * FROM runtime_jobs ORDER BY created_at DESC LIMIT ?').all(max);
      out.push(...rows.map(r => this._publicJob(this._rowToJob(r))));
    }
    return out.slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  shouldYield(job) {
    const lane = typeof job === 'string' ? this._running.get(job)?.lane : job?.lane;
    if (lane === 'interactive' || lane === 'channel') return false;
    return this._hasQueuedInteractive();
  }

  _registerDefaultHandlers() {
    this.registerHandler('agent.turn', payload => this._runAgentTurn(payload), { lane: 'interactive', priority: 100 });
    this.registerHandler('wakeup.fire', payload => this._runWakeup(payload), { lane: 'deferred', priority: 65, persistent: true });
    this.registerHandler('learner.extract', payload => {
      const learner = this.learner || this.workerDeps.learner;
      if (!learner?.extractAndLearn) return { skipped: 'learner-unavailable' };
      return learner.extractAndLearn(payload.userMessage, payload.assistantResponse, payload.opts || {});
    }, { lane: 'learner', priority: 40, maxAttempts: 1 });
    this.registerHandler('maintenance.run', payload => this.workerDeps.maintainer?.runMaintenance?.(payload?.opts || {}), { lane: 'maintenance', priority: 25 });
    this.registerHandler('janitor.run', payload => this.workerDeps.janitor?.runJanitor?.(payload?.opts || {}), { lane: 'maintenance', priority: 20 });
    this.registerHandler('backup.run', payload => this.workerDeps.backup?.runBackups?.(payload?.opts || {}), { lane: 'maintenance', priority: 15 });
    this.registerHandler('graphMaintenance.run', payload => this.workerDeps.graphMaintenance?.run?.(payload?.opts || {}), { lane: 'maintenance', priority: 22 });
    this.registerHandler('graphMaintenance.maintainGraph', payload => this.workerDeps.graphMaintenance?.maintainGraph?.(payload.slug, payload.opts || {}), { lane: 'maintenance', priority: 30 });
    this.registerHandler('generalKbResearch.run', payload => this.workerDeps.graphMaintenance?.runGeneralKbResearchJob?.(payload), { lane: 'background', priority: 10 });
    this.registerHandler('channelDistill.run', payload => this.workerDeps.channelDistiller?.run?.(payload?.opts || {}), { lane: 'background', priority: 12 });
  }

  async _runAgentTurn(payload) {
    if (!this.agent?.processMessage) throw new Error('agent not available');
    const opts = { ...(payload.opts || {}) };
    opts.queueJob = payload.queueJob;
    return this.agent.processMessage(opts);
  }

  async _runWakeup(payload) {
    const wakeupId = payload.wakeupId;
    if (wakeupId && this.db) {
      this.db.prepare('UPDATE wakeups SET fired=1, fired_at=? WHERE id=? AND fired=0').run(now(), wakeupId);
    }
    try {
      return await this._runAgentTurn(payload);
    } catch (e) {
      if (wakeupId && this.db) {
        this.db.prepare('UPDATE wakeups SET failed=1, error=? WHERE id=?')
          .run(String(e.message || e).slice(0, 500), wakeupId);
      }
      throw e;
    }
  }

  _ensureSchema() {
    if (!this.db) return;
    this.db.exec(`
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
    `);

    const wakeupCols = this.db.prepare('PRAGMA table_info(wakeups)').all().map(c => c.name);
    if (!wakeupCols.includes('queue_job_id')) {
      try { this.db.exec('ALTER TABLE wakeups ADD COLUMN queue_job_id TEXT'); } catch {}
    }
  }

  _recoverPersistentJobs() {
    if (!this.db) return;
    const t = now();
    try {
      this.db.prepare("UPDATE runtime_jobs SET status='queued', updated_at=?, started_at=NULL WHERE status='running'")
        .run(t);
    } catch (e) {
      this.log.warn(`[queue] recovery failed: ${e.message}`);
    }
  }

  _insertPersistent(job) {
    if (!this.db) throw new Error('persistent queue unavailable');
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_jobs
        (id, kind, lane, priority, status, session_key, route, graph, run_at, attempts, max_attempts, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.kind, job.lane, job.priority, job.status, job.sessionKey,
      job.route, job.graph, job.runAt, job.attempts, job.maxAttempts,
      stringifyJson(job.payload), job.created, job.updated,
    );
    this.stats.queued++;
    this._emit('queue:queued', job);
  }

  _schedulePump() {
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    setImmediate(() => {
      this._pumpScheduled = false;
      this._pump();
    });
  }

  _pump() {
    if (this._stopped) return;
    let started = false;
    for (;;) {
      const job = this._nextStartableJob();
      if (!job) break;
      started = true;
      this._start(job);
    }
    if (started) setImmediate(() => this._pump());
  }

  _nextStartableJob() {
    const candidates = [];
    const t = now();
    for (const job of this._memoryJobs.values()) {
      if (job.status === 'queued' && job.runAt <= t) candidates.push(job);
    }
    if (this.db) {
      try {
        const rows = this.db.prepare(`
          SELECT * FROM runtime_jobs
          WHERE status='queued' AND run_at<=?
          ORDER BY priority DESC, run_at ASC, created_at ASC
          LIMIT 50
        `).all(t);
        candidates.push(...rows.map(r => this._rowToJob(r)));
      } catch (e) {
        this.log.warn(`[queue] persistent poll failed: ${e.message}`);
      }
    }

    candidates.sort((a, b) => (b.priority - a.priority) || (a.runAt - b.runAt) || (a.created - b.created));
    return candidates.find(j => this._canStart(j)) || null;
  }

  _canStart(job) {
    if (!this.handlers.has(job.kind)) return true; // start so it can fail visibly
    if (this._runningCount(job.lane) >= this._laneLimit(job.lane)) return false;
    if (job.sessionKey && (this._runningSessions.has(job.sessionKey) || this.agent?.activeRuns?.has?.(job.sessionKey))) return false;
    if (!this._isInteractiveLane(job.lane) && this._hasQueuedInteractive()) return false;
    return true;
  }

  _start(job) {
    job.status = 'running';
    job.startedAt = now();
    job.updated = job.startedAt;
    job.payload = {
      ...(job.payload || {}),
      queueJob: {
        id: job.id,
        lane: job.lane,
        kind: job.kind,
        shouldYield: () => this.shouldYield(job),
      },
    };
    this._running.set(job.id, job);
    if (job.sessionKey) this._runningSessions.add(job.sessionKey);
    if (job.persistent) {
      this.db.prepare("UPDATE runtime_jobs SET status='running', attempts=attempts+1, started_at=?, updated_at=? WHERE id=?")
        .run(job.startedAt, job.updated, job.id);
    }
    this.stats.started++;
    this._emit('queue:start', job);

    Promise.resolve()
      .then(() => {
        const entry = this.handlers.get(job.kind);
        if (!entry) throw new Error(`No queue handler registered for ${job.kind}`);
        return entry.handler(job.payload, job);
      })
      .then(result => this._complete(job, result))
      .catch(error => this._fail(job, error));
  }

  _complete(job, result) {
    this._release(job);
    if (result?.yielded) {
      this.stats.yielded++;
      job.status = 'queued';
      job.runAt = now() + 2000;
      if (job.persistent) {
        this.db.prepare("UPDATE runtime_jobs SET status='queued', run_at=?, updated_at=?, started_at=NULL WHERE id=?")
          .run(job.runAt, now(), job.id);
      } else {
        this._memoryJobs.set(job.id, job);
      }
      this._emit('queue:yield', job);
      this._schedulePump();
      return;
    }

    job.status = 'done';
    job.completedAt = now();
    this.stats.done++;
    if (job.persistent) {
      this.db.prepare("UPDATE runtime_jobs SET status='done', result=?, updated_at=?, completed_at=? WHERE id=?")
        .run(stringifyJson(this._compactResult(result)), job.completedAt, job.completedAt, job.id);
    } else {
      this._memoryJobs.delete(job.id);
    }
    this._emit('queue:done', job, { detail: this._resultDetail(result) });
    this._resolve(job.id, result);
    this._schedulePump();
  }

  _fail(job, error) {
    this._release(job);
    const message = String(error?.message || error || 'job failed').slice(0, 1000);
    job.attempts = Number(job.attempts || 0) + 1;
    const retry = job.persistent && job.attempts < job.maxAttempts;
    if (retry) {
      const delay = Math.min(60_000, 1000 * Math.pow(2, job.attempts - 1));
      job.status = 'queued';
      job.runAt = now() + delay;
      this.db.prepare("UPDATE runtime_jobs SET status='queued', attempts=?, error=?, run_at=?, updated_at=?, started_at=NULL WHERE id=?")
        .run(job.attempts, message, job.runAt, now(), job.id);
      this.stats.retried++;
      this._emit('queue:retry', job, { detail: message });
      this._schedulePump();
      return;
    }

    job.status = 'failed';
    job.completedAt = now();
    this.stats.failed++;
    if (job.persistent) {
      this.db.prepare("UPDATE runtime_jobs SET status='failed', attempts=?, error=?, updated_at=?, completed_at=? WHERE id=?")
        .run(job.attempts, message, job.completedAt, job.completedAt, job.id);
    } else {
      this._memoryJobs.delete(job.id);
    }
    this._emit('queue:fail', job, { detail: message });
    this._reject(job.id, error);
    this._schedulePump();
  }

  _release(job) {
    this._running.delete(job.id);
    if (job.sessionKey) this._runningSessions.delete(job.sessionKey);
  }

  _rowToJob(row) {
    return {
      id: row.id,
      kind: row.kind,
      lane: row.lane,
      priority: row.priority,
      status: row.status,
      sessionKey: row.session_key,
      route: row.route,
      graph: row.graph,
      runAt: row.run_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      payload: parseJson(row.payload, {}),
      result: parseJson(row.result, null),
      error: row.error,
      persistent: true,
      created: row.created_at,
      updated: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  _getPersistentRow(id) {
    try { return this.db?.prepare('SELECT * FROM runtime_jobs WHERE id=?').get(id) || null; } catch { return null; }
  }

  _laneLimit(lane) {
    return Math.max(1, Number(this.laneLimits[lane] || DEFAULT_LANE_LIMITS[lane] || 1));
  }

  _runningCount(lane) {
    let count = 0;
    for (const job of this._running.values()) if (job.lane === lane) count++;
    return count;
  }

  _isInteractiveLane(lane) {
    return lane === 'interactive' || lane === 'channel';
  }

  _hasQueuedInteractive() {
    for (const job of this._memoryJobs.values()) {
      if (job.status === 'queued' && this._isInteractiveLane(job.lane)) return true;
    }
    if (!this.db) return false;
    try {
      return !!this.db.prepare("SELECT 1 FROM runtime_jobs WHERE status='queued' AND lane IN ('interactive','channel') AND run_at<=? LIMIT 1").get(now());
    } catch {
      return false;
    }
  }

  _isSessionBusy(sessionKey) {
    if (!sessionKey) return false;
    return this._runningSessions.has(sessionKey) || !!this.agent?.activeRuns?.has?.(sessionKey);
  }

  _buildSessionKey(opts) {
    const sessions = this.agent?.sessions || this.sessions;
    if (sessions?.constructor?.buildKey) {
      return sessions.constructor.buildKey(opts.channelId, opts.isDm, opts.userId);
    }
    return opts.isDm && opts.userId ? `dm:${opts.userId}` : `channel:${opts.channelId || 'default'}`;
  }

  _laneForAgentTurn(opts, meta) {
    if (meta.lane) return meta.lane;
    const trigger = String(opts.trigger || '').toLowerCase();
    if (opts.platform === 'discord' || opts.platform === 'slack' || opts.platform === 'telegram') return 'channel';
    if (trigger === 'task_complete' || trigger === 'wakeup' || trigger === 'proactive') return 'deferred';
    if (opts.platform === 'system' || trigger === 'worker') return 'background';
    return 'interactive';
  }

  _publicJob(job) {
    return {
      id: job.id,
      kind: job.kind,
      lane: job.lane,
      priority: job.priority,
      status: job.status,
      sessionKey: job.sessionKey,
      route: job.route,
      graph: job.graph,
      runAt: job.runAt,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      persistent: !!job.persistent,
      created: job.created,
      updated: job.updated,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      error: job.error || null,
    };
  }

  _compactResult(result) {
    if (!result || typeof result !== 'object') return result;
    return {
      text: typeof result.text === 'string' ? result.text.slice(0, 1000) : undefined,
      usage: result.usage,
      iterations: result.iterations,
      skipped: result.skipped,
      yielded: result.yielded,
      ok: result.ok,
    };
  }

  _resultDetail(result) {
    if (result?.text) return String(result.text).slice(0, 120);
    if (result?.ok !== undefined) return `ok=${result.ok}`;
    return '';
  }

  _resolve(id, value) {
    const r = this._resolvers.get(id);
    if (!r) return;
    this._resolvers.delete(id);
    r.resolve(value);
  }

  _reject(id, error) {
    const r = this._resolvers.get(id);
    if (!r) return;
    this._resolvers.delete(id);
    r.reject(error);
  }

  _emit(op, job, extra = {}) {
    const payload = typeof job === 'object' ? job : {};
    try {
      graphEvents.emit('change', {
        op,
        source: 'runtime-queue',
        graph: payload.graph || undefined,
        jobId: payload.id || undefined,
        kind: payload.kind || undefined,
        lane: payload.lane || undefined,
        sessionKey: payload.sessionKey || undefined,
        route: payload.route || undefined,
        detail: extra.detail || `${payload.kind || 'job'} · ${payload.lane || 'lane'}`,
      });
    } catch {}
  }
}

module.exports = { RuntimeJobQueue, DEFAULT_LANE_LIMITS };
