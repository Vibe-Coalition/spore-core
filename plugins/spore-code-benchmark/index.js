// spore-code-benchmark plugin — live multi-repo Spore Code benchmark.
//
// This intentionally drives the same websocket + local-tool path as the
// Spore Code CLI instead of calling AgentLoop directly. That keeps the
// benchmark useful for regressions in session routing, project graph scoping,
// runtime queue priority, local tool wiring, and cross-session leakage.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { coreRequire, modelForTier } = require('../core-require');
const { SCENARIOS, tasksForScenario } = require('./lib/catalog');
const { SporeCodeBenchmarkRunner } = require('./lib/runner');

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function webGateway(api) {
  return api._appContext?.tools?.gateway || api._appContext?.gateways?.getGateway?.('web') || null;
}

function createCliTicket(api, username, ttlMs) {
  const webGw = webGateway(api);
  const sessions = webGw?._webSessions;
  if (!sessions) throw new Error('Web gateway session map is not ready');
  const token = crypto.randomBytes(18).toString('hex');
  sessions.set(token, {
    user: String(username || 'spore-code-benchmark'),
    type: 'cli',
    auth: 'spore-code-benchmark',
    created: Date.now(),
    expiresAt: Date.now() + (ttlMs || 60 * 60 * 1000),
    singleUse: true,
    wsTicket: true,
    benchmark: true,
  });
  return token;
}

function resultsPath(config) {
  return path.join(config.dataDir || path.dirname(config.graphDbPath || '/data/graph.db'), 'spore-code-benchmark', 'spore-code-benchmark-results.json');
}

function pendingLearnerJobsForSession(queue, sessionKey) {
  if (!queue?.listJobs || !sessionKey) return [];
  try {
    return queue.listJobs({ limit: 500 }).filter(job => (
      job
      && job.kind === 'learner.extract'
      && job.sessionKey === sessionKey
      && (job.status === 'queued' || job.status === 'running')
    ));
  } catch {
    return [];
  }
}

function createSessionSettleWaiter(ctx, log) {
  let graphEvents = null;
  try { graphEvents = coreRequire('graph/events'); } catch {}
  const queue = ctx?.tools?._jobQueue || null;

  return function waitForSessionSettle({
    sessionId,
    sessionKey,
    scenarioId = null,
    taskId = null,
    timeoutMs = 90_000,
    quietMs = 2500,
  } = {}) {
    const nodeId = `session-${sessionId}`;
    const started = Date.now();
    const events = [];
    let lastActivity = started;
    let sawSessionEvent = false;
    let sawSummarizeDone = false;
    let summarizeError = null;
    let sawDistillDone = false;
    let distillError = null;
    let timer = null;

    return new Promise(resolve => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (graphEvents?.off) graphEvents.off('change', onGraphChange);
      };
      const readinessFor = (pendingLearner = [], timedOut = false) => ({
        summary: sawSummarizeDone
          ? (summarizeError ? 'error' : 'ready')
          : (sawSessionEvent ? 'pending' : 'unobserved'),
        projectHandoff: sawSummarizeDone && !summarizeError ? 'ready' : 'pending',
        sharedDistill: sawDistillDone
          ? (distillError ? 'error' : 'done')
          : (sawSummarizeDone ? 'pending' : 'waiting_summary'),
        learnerQueue: pendingLearner.length > 0 ? 'pending' : 'drained',
        timedOut: !!timedOut,
      });
      const statusFromReadiness = (pendingLearner = [], timedOut = false) => {
        if (!sawSummarizeDone) return timedOut ? 'timeout' : 'pending';
        if (summarizeError) return 'summary_error';
        if (sawDistillDone && distillError) return 'project_ready_shared_error';
        if (sawDistillDone && pendingLearner.length > 0) return timedOut
          ? 'project_ready_shared_done_queue_pending_timeout'
          : 'project_ready_shared_done_queue_pending';
        if (sawDistillDone) return 'ready';
        return timedOut ? 'project_ready_shared_pending_timeout' : 'project_ready_shared_pending';
      };
      const finish = (status, extra = {}) => {
        cleanup();
        const pendingLearnerJobs = Number(extra.pendingLearnerJobs || 0);
        const pendingLearner = Array.from({ length: pendingLearnerJobs });
        const readiness = extra.readiness || readinessFor(pendingLearner, /timeout/i.test(String(status || '')));
        resolve({
          status,
          sessionId,
          sessionKey,
          scenarioId,
          taskId,
          timeoutMs,
          quietMs,
          durationMs: Date.now() - started,
          events,
          sawSummarizeDone,
          sawDistillDone,
          summarizeError,
          distillError,
          readiness,
          ...extra,
        });
      };
      const onGraphChange = evt => {
        if (!evt || evt.nodeId !== nodeId) return;
        if (!String(evt.op || '').startsWith('session:')) return;
        sawSessionEvent = true;
        lastActivity = Date.now();
        const entry = {
          ts: new Date().toISOString(),
          op: evt.op,
          graph: evt.graph || evt.graphSlug || null,
          error: evt.error || null,
        };
        if (events.length < 25) events.push(entry);
        if (evt.op === 'session:summarize-done') {
          sawSummarizeDone = true;
          if (evt.error) summarizeError = evt.error;
        }
        if (evt.op === 'session:distill-done') {
          sawDistillDone = true;
          if (evt.error) distillError = evt.error;
        }
      };

      if (graphEvents?.on) graphEvents.on('change', onGraphChange);

      const poll = () => {
        const elapsed = Date.now() - started;
        const pendingLearner = pendingLearnerJobsForSession(queue, sessionKey);
        const quiet = Date.now() - lastActivity >= quietMs;
        if (sawDistillDone && quiet) {
          finish(statusFromReadiness(pendingLearner, false), {
            pendingLearnerJobs: pendingLearner.length,
            readiness: readinessFor(pendingLearner, false),
          });
          return;
        }

        // If this core build/plugin set does not emit session distill events,
        // still avoid immediately starting the next benchmark task. Once the
        // targeted learner queue is clear and we have observed a quiet fallback
        // window, move on and record that the settle signal was inferred.
        const fallbackMs = Math.min(timeoutMs, Math.max(10_000, quietMs * 2));
        if (!sawSessionEvent && pendingLearner.length === 0 && elapsed >= fallbackMs) {
          finish('settled_without_session_events', {
            pendingLearnerJobs: 0,
            readiness: {
              summary: 'unobserved',
              projectHandoff: 'unknown',
              sharedDistill: 'unknown',
              learnerQueue: 'drained',
              timedOut: false,
            },
          });
          return;
        }

        if (elapsed >= timeoutMs) {
          const readiness = readinessFor(pendingLearner, true);
          finish(statusFromReadiness(pendingLearner, true), {
            pendingLearnerJobs: pendingLearner.length,
            readiness,
          });
          if (log?.warn) log.warn(`[spore-code-benchmark] memory settle timed out for ${sessionId}`);
          return;
        }
        timer = setTimeout(poll, 350);
      };
      poll();
    });
  };
}

function register(api) {
  const log = api.getLogger();
  const ctx = api._appContext || {};

  api.registerWebRoute('GET', '/catalog', async (_req, res) => {
    json(res, 200, {
      scenarios: SCENARIOS.map(s => ({
        id: s.id,
        domain: s.domain,
        repo: s.repo,
        taskTitle: s.taskTitle,
        userPrompt: s.userPrompt,
        verification: s.verification,
        taskCount: tasksForScenario(s).length,
        tasks: tasksForScenario(s).map(t => ({
          id: t.id,
          userName: t.userName,
          prompt: t.prompt,
          verification: t.verification,
          tags: t.tags,
        })),
        tags: s.tags,
      })),
    });
  });

  api.registerWebRoute('POST', '/run', async (req, res) => {
    try {
      const tools = ctx.tools;
      if (!tools) return json(res, 503, { error: 'core tools not available' });
      const existing = tools._sporeCodeBenchmarkRunner;
      if (existing && !['done', 'error', 'cancelled', 'idle'].includes(existing.phase)) {
        return json(res, 409, { error: 'Spore Code benchmark already running', phase: existing.phase });
      }

      const body = await readJsonBody(req);
      const webGw = webGateway(api);
      const baseUrl = body.baseUrl || (ctx.config?.webPort ? `http://127.0.0.1:${ctx.config.webPort}` : null);
      const broadcast = webGw?.broadcast?.bind(webGw) || (() => {});
      const runner = new SporeCodeBenchmarkRunner({
        config: ctx.config || {},
        log,
        llmClient: tools.llmClient,
        broadcast,
        baseUrl,
        createCliTicket: (username, ttlMs) => createCliTicket(api, username, ttlMs),
        waitForSessionSettle: createSessionSettleWaiter(ctx, log),
      });
      tools._sporeCodeBenchmarkRunner = runner;

      const judgeModel = body.judge
        ? (body.judgeModel || modelForTier('normal', ctx.config || {}))
        : null;
      const actorModel = body.actor
        ? (body.actorModel || modelForTier('planner', ctx.config || {}) || modelForTier('normal', ctx.config || {}))
        : null;
      const wantsExperienceSummary = body.experienceSummary !== false && body.summaryProvider !== false;
      const experienceSummaryModel = wantsExperienceSummary
        ? (body.experienceSummaryModel || body.summaryModel || modelForTier('planner', ctx.config || {}) || modelForTier('normal', ctx.config || {}))
        : null;
      const runOpts = {
        scenarioIds: body.scenarioIds || null,
        maxScenarios: body.maxScenarios,
        parallel: body.parallel,
        workspaceRoot: body.workspaceRoot,
        refreshRepos: body.refreshRepos,
        prepareRepos: body.prepareRepos,
        runVerification: body.runVerification,
        dryRun: body.dryRun,
        judge: !!body.judge,
        judgeModel,
        experienceSummary: wantsExperienceSummary,
        experienceSummaryModel,
        actor: !!body.actor,
        actorModel,
        actorGuidance: body.actorGuidance || '',
        turnTimeoutMs: body.turnTimeoutMs,
        maxTasksPerRepo: body.maxTasksPerRepo,
        maxTurnsPerTask: body.maxTurnsPerTask,
        taskPauseMs: body.taskPauseMs,
        sessionSettleMs: body.sessionSettleMs,
        sessionSettleQuietMs: body.sessionSettleQuietMs,
        includeDiff: !!body.includeDiff,
        includeTrace: !!(body.includeTrace || body.includeRawEvents),
        userName: body.userName || 'spore-code-benchmark',
        baseUrl,
      };

      runner.run(runOpts).catch(e => {
        log.error(`[spore-code-benchmark] Runner error: ${e.stack || e.message}`);
      });

      json(res, 200, {
        ok: true,
        runId: runner.currentRunId,
        status: runner.getStatus(),
        catalogSize: SCENARIOS.length,
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  api.registerWebRoute('GET', '/status', async (_req, res) => {
    const runner = ctx.tools?._sporeCodeBenchmarkRunner;
    json(res, 200, runner ? runner.getStatus() : { phase: 'idle' });
  });

  api.registerWebRoute('GET', '/results', async (_req, res) => {
    try {
      const file = resultsPath(ctx.config || {});
      if (!fs.existsSync(file)) return json(res, 200, { empty: true });
      json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  api.registerWebRoute('POST', '/cancel', async (_req, res) => {
    const runner = ctx.tools?._sporeCodeBenchmarkRunner;
    if (runner) runner.cancel();
    json(res, 200, { ok: true });
  });

  api.registerPromptSection('*', 'Spore Code Benchmark Harness', ({ opts }) => {
    if (opts?.platform !== 'cli') return null;
    const context = opts?.projectContext?.benchmark?.context;
    return context ? String(context) : null;
  });

  api.registerFrontendAsset('spore-code-benchmark.js');

  api.registerSettingsPane({
    title: 'Spore Code Benchmark',
    description:
      'Live coding benchmark for Spore Code. It clones public repos into disposable workspaces, simulates CLI coding sessions, supports parallel runs, verifies changes, waits for session memory settle, summarizes each repo experience with the planner model, and scans transcripts/tool calls for cross-session leakage.',
    html: `
      <button type="button"
              class="settings-btn-secondary"
              onclick="window.__scbOpen && window.__scbOpen()">
        Open benchmark
      </button>
      <div class="settings-note" style="margin-top:6px;opacity:0.65">
        Results are saved under dataDir/spore-code-benchmark. Use dry-run first to validate repo preparation and catalog selection.
      </div>
    `,
  });

  try {
    const graphEvents = coreRequire('graph/events');
    graphEvents.emit('change', { op: 'plugin:ready', plugin: 'spore-code-benchmark' });
  } catch {}
  log.info('Plugin ready — live coding benchmark routes + HUD asset registered.');
}

register._test = {
  createSessionSettleWaiter,
  pendingLearnerJobsForSession,
};

module.exports = register;
