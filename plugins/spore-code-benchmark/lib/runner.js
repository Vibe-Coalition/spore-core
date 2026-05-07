'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  DEFAULT_LOCAL_TOOLS,
  SCENARIOS,
  buildBenchmarkContext,
  buildUserPrompt,
  selectScenarios,
  tasksForScenario,
} = require('./catalog');
const { LocalToolExecutor } = require('./local-tools');
const { LiveSporeCodeSession } = require('./live-session');
const { judgeWithLlm, scanLeakage, scoreScenario, summarizeExperienceWithLlm } = require('./judge');
const { generateActorFollowup, generateActorTurn } = require('./actor');
const { evaluateCommandResult, normalizeVerificationSpec } = require('./verification');
const {
  buildHandoffFacts,
  changedFileSummary,
  classifyVerificationClaim,
  deriveSetupStatus,
} = require('./reporting');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function safeIdPart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'scenario';
}

function defaultDataDir(config = {}) {
  return config.dataDir || path.dirname(config.graphDbPath || '') || process.cwd();
}

function makeRunId() {
  return `scb-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${crypto.randomBytes(4).toString('hex')}`;
}

function makeCanary(runId, scenarioId) {
  return `SCB_CANARY_${safeIdPart(runId)}_${safeIdPart(scenarioId)}_${crypto.randomBytes(6).toString('hex')}`;
}

function compactOutput(text, max = 12000) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}

function summarizeEventEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const byType = {};
  let firstAt = null;
  let lastAt = null;
  for (const entry of list) {
    const type = String(entry?.type || entry?.rawType || 'unknown');
    byType[type] = (byType[type] || 0) + 1;
    if (entry?.ts && !firstAt) firstAt = entry.ts;
    if (entry?.ts) lastAt = entry.ts;
  }
  return {
    total: list.length,
    byType,
    firstAt,
    lastAt,
  };
}

function compactTaskForReport(task = {}) {
  const compact = { ...task };
  const eventSummary = Array.isArray(task.events)
    ? summarizeEventEntries(task.events)
    : (task.eventSummary || summarizeEventEntries([]));
  const transcriptSummary = Array.isArray(task.transcript)
    ? summarizeEventEntries(task.transcript)
    : (task.transcriptSummary || summarizeEventEntries([]));
  delete compact.events;
  delete compact.transcript;
  compact.eventSummary = eventSummary;
  compact.transcriptSummary = transcriptSummary;
  return compact;
}

function compactScenarioForReport(result = {}) {
  const compact = { ...result };
  const eventSummary = Array.isArray(result.events)
    ? summarizeEventEntries(result.events)
    : (result.eventSummary || summarizeEventEntries([]));
  const transcriptSummary = Array.isArray(result.transcript)
    ? summarizeEventEntries(result.transcript)
    : (result.transcriptSummary || summarizeEventEntries([]));
  delete compact.events;
  delete compact.transcript;
  compact.eventSummary = eventSummary;
  compact.transcriptSummary = transcriptSummary;
  compact.tasks = Array.isArray(result.tasks) ? result.tasks.map(compactTaskForReport) : [];
  return compact;
}

function compactReportForStorage(report = {}, opts = {}) {
  return {
    ...report,
    reportFormat: {
      version: '1.1',
      mode: 'compact',
      rawTrace: opts.includeTrace ? 'trace.json' : null,
      note: 'Raw websocket event and transcript arrays are omitted from report.json; use tasks[].turns for the readable session transcript.',
    },
    options: {
      ...(report.options || {}),
      includeTrace: !!opts.includeTrace,
    },
    results: Array.isArray(report.results) ? report.results.map(compactScenarioForReport) : [],
  };
}

function rawTraceForStorage(report = {}) {
  return {
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    results: (report.results || []).map(result => ({
      scenarioId: result.scenarioId,
      canary: result.canary,
      transcript: result.transcript || [],
      events: result.events || [],
      tasks: (result.tasks || []).map(task => ({
        scenarioId: task.scenarioId,
        taskId: task.taskId,
        taskIndex: task.taskIndex,
        userName: task.userName,
        sessionId: task.sessionId,
        transcript: task.transcript || [],
        events: task.events || [],
      })),
    })),
  };
}

function askUserText(msg = {}) {
  return String(
    msg.question
    || msg.prompt
    || msg.summary
    || msg.detail
    || msg.text
    || msg.message
    || JSON.stringify(msg)
  );
}

function runShell(command, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000);
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || cwd,
        LANG: process.env.LANG || 'C.UTF-8',
        TERM: 'dumb',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, command, cwd, error: e.message, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command,
        cwd,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: compactOutput(stdout),
        stderr: compactOutput(stderr),
      });
    });
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeRun(results, leakage) {
  const scores = results.map(r => r.score || scoreScenario(r));
  const tasks = results.flatMap(r => Array.isArray(r.tasks) ? r.tasks : []);
  const taskScores = tasks.map(t => t.score || scoreScenario(t));
  const completed = scores.filter(s => s.completed).length;
  const completedTasks = taskScores.filter(s => s.completed).length;
  const likelySuccess = scores.filter(s => s.likelySuccess).length;
  const likelySuccessfulTasks = taskScores.filter(s => s.likelySuccess).length;
  const withChanges = scores.filter(s => s.filesChanged > 0).length;
  const verificationTotal = scores.reduce((n, s) => n + (s.verificationTotal || 0), 0);
  const verificationPassed = scores.reduce((n, s) => n + (s.verificationPassed || 0), 0);
  const infraBlocked = scores.reduce((n, s) => n + (s.infraBlocked || 0), 0);
  const semanticFailures = scores.reduce((n, s) => n + (s.semanticFailures || 0), 0);
  const memorySettle = tasks
    .map(t => t.memorySettle)
    .filter(Boolean)
    .filter(s => s.status !== 'disabled');
  const memorySettleTimeouts = memorySettle.filter(s => s.status === 'timeout').length;
  const memorySettleErrors = memorySettle.filter(s => /error/i.test(String(s.status || ''))).length;
  const experienceSummaries = results
    .map(r => r.experienceSummary)
    .filter(Boolean);
  const experienceSummaryErrors = experienceSummaries.filter(s => s.error || s.parseError).length;
  const setupStatuses = tasks.reduce((acc, t) => {
    const status = t.setupStatus?.status || t.score?.setupStatus || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const verificationOverclaims = tasks.filter(t => t.verificationClaim?.overclaimed).length;
  const responseRepairs = tasks.filter(t => t.responseRepair).length;
  const dryRun = results.length > 0 && results.every(r => r.dryRun);
  return {
    scenarios: results.length,
    tasks: taskScores.length,
    dryRun,
    completed,
    completedTasks,
    withChanges,
    likelySuccess,
    likelySuccessfulTasks,
    verificationTotal,
    verificationPassed,
    infraBlocked,
    semanticFailures,
    memorySettleTotal: memorySettle.length,
    memorySettleTimeouts,
    memorySettleErrors,
    experienceSummaries: experienceSummaries.length,
    experienceSummaryErrors,
    setupStatuses,
    verificationOverclaims,
    responseRepairs,
    verificationPassRate: verificationTotal ? verificationPassed / verificationTotal : null,
    leakageOk: !!leakage?.ok,
    leakageHits: leakage?.hits?.length || 0,
  };
}

class SporeCodeBenchmarkRunner {
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.log = opts.log || console;
    this.broadcast = opts.broadcast || (() => {});
    this.llmClient = opts.llmClient || null;
    this.createCliTicket = opts.createCliTicket || null;
    this.waitForSessionSettle = opts.waitForSessionSettle || null;
    this.baseUrl = opts.baseUrl || (this.config.webPort ? `http://127.0.0.1:${this.config.webPort}` : null);
    this.phase = 'idle';
    this.cancelled = false;
    this.progress = { current: 0, total: 0 };
    this.results = [];
    this.report = null;
    this.error = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.currentRunId = null;
  }

  getStatus() {
    return {
      phase: this.phase,
      cancelled: this.cancelled,
      progress: { ...this.progress },
      runId: this.currentRunId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      resultsCount: this.results.length,
      summary: this.report?.summary || null,
      error: this.error,
    };
  }

  cancel() {
    this.cancelled = true;
    if (!['done', 'error', 'cancelled', 'idle'].includes(this.phase)) {
      this.phase = 'cancelled';
      this._broadcast();
    }
  }

  _broadcast(extra = {}) {
    try {
      this.broadcast({
        type: 'spore-code-benchmark:status',
        ...this.getStatus(),
        ...extra,
      });
    } catch {}
  }

  _setPhase(phase, extra = {}) {
    this.phase = phase;
    this._broadcast(extra);
  }

  async run(opts = {}) {
    if (!this.baseUrl && !opts.dryRun) throw new Error('No web base URL available for live benchmark sessions');
    this.cancelled = false;
    this.error = null;
    this.results = [];
    this.report = null;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.currentRunId = opts.runId || makeRunId();

    const selected = selectScenarios(opts);
    this.progress = { current: 0, total: selected.length };
    const baseDir = path.resolve(opts.workspaceRoot || path.join(defaultDataDir(this.config), 'spore-code-benchmark'));
    const cacheRoot = path.join(baseDir, 'repos');
    const runRoot = path.join(baseDir, 'runs', this.currentRunId);
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.mkdirSync(runRoot, { recursive: true });

    const options = {
      parallel: Math.max(1, Math.min(10, Math.floor(Number(opts.parallel) || 1))),
      dryRun: !!opts.dryRun,
      prepareRepos: opts.prepareRepos !== false,
      refreshRepos: !!opts.refreshRepos,
      runVerification: opts.runVerification !== false,
      judge: !!opts.judge,
      judgeModel: opts.judgeModel || null,
      experienceSummary: opts.experienceSummary !== false && opts.summaryProvider !== false,
      experienceSummaryModel: opts.experienceSummaryModel || opts.summaryModel || null,
      actor: !!opts.actor,
      actorModel: opts.actorModel || null,
      actorGuidance: String(opts.actorGuidance || '').slice(0, 6000),
      turnTimeoutMs: Math.max(5000, Number(opts.turnTimeoutMs) || 20 * 60 * 1000),
      maxTasksPerRepo: Math.max(1, Math.min(10, Math.floor(Number(opts.maxTasksPerRepo) || 3))),
      maxTurnsPerTask: Math.max(1, Math.min(30, Math.floor(Number(opts.maxTurnsPerTask) || (opts.actor ? 30 : 1)))),
      taskPauseMs: Math.max(0, Math.min(60000, Math.floor(Number(opts.taskPauseMs) || 1500))),
      sessionSettleMs: Math.max(0, Math.min(10 * 60 * 1000, Math.floor(Number(opts.sessionSettleMs ?? opts.memorySettleMs ?? 90_000) || 0))),
      sessionSettleQuietMs: Math.max(250, Math.min(30_000, Math.floor(Number(opts.sessionSettleQuietMs ?? 2500) || 2500))),
      userName: opts.userName || 'spore-code-benchmark',
      baseUrl: opts.baseUrl || this.baseUrl,
      includeDiff: !!opts.includeDiff,
      includeTrace: !!(opts.includeTrace || opts.includeRawEvents),
    };

    this._setPhase(options.dryRun ? 'dry-run' : 'running', { runRoot, options });

    try {
      const results = await mapWithConcurrency(selected, options.parallel, async (scenario, index) => {
        if (this.cancelled) return this._cancelledResult(scenario, index);
        const result = await this._runScenario(scenario, {
          ...options,
          runId: this.currentRunId,
          runRoot,
          cacheRoot,
          index,
        });
        this.results[index] = result;
        this.progress.current = this.results.filter(Boolean).length;
        this._broadcast({ latest: { scenarioId: scenario.id, score: result.score, error: result.error || null } });
        return result;
      });
      this.results = results.filter(Boolean);
      const leakage = scanLeakage(this.results);
      const summary = summarizeRun(this.results, leakage);
      const fullReport = {
        runId: this.currentRunId,
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        options,
        workspace: { baseDir, runRoot, cacheRoot },
        catalogVersion: '1.0.0',
        summary,
        leakage,
        results: this.results,
      };
      this.report = compactReportForStorage(fullReport, options);
      this.finishedAt = this.report.finishedAt;
      this._writeReport(baseDir, this.report, options.includeTrace ? rawTraceForStorage(fullReport) : null);
      if (this.cancelled) this._setPhase('cancelled');
      else this._setPhase('done');
      return this.report;
    } catch (e) {
      this.error = e.message;
      this.finishedAt = new Date().toISOString();
      this._setPhase('error');
      throw e;
    }
  }

  _cancelledResult(scenario, index) {
    return {
      scenarioId: scenario.id,
      scenario,
      index,
      cancelled: true,
      error: 'Benchmark cancelled before scenario started',
      score: {
        completed: false,
        hadToolUse: false,
        filesChanged: 0,
        verificationTotal: 0,
        verificationPassed: 0,
        verificationFailed: 0,
        verificationPassRate: null,
        likelySuccess: false,
      },
    };
  }

  async _runScenario(scenario, opts) {
    const scenarioId = scenario.id;
    const canary = makeCanary(opts.runId, scenarioId);
    const workDir = path.join(opts.runRoot, safeIdPart(scenarioId));
    const envRoot = path.join(opts.runRoot, '.tool-env', safeIdPart(scenarioId));
    const executorOpts = {
      envHome: path.join(envRoot, 'home'),
      extraEnv: {
        SPORE_BENCHMARK_CACHE: path.join(envRoot, 'cache'),
      },
    };
    const result = {
      scenarioId,
      scenario,
      canary,
      workDir,
      envRoot,
      startedAt: new Date().toISOString(),
      prompt: '',
      transcript: [],
      events: [],
      toolCalls: [],
      tasks: [],
      verification: { commands: [] },
      git: {},
    };

    let session = null;
    let activeTaskResult = null;
    let postExecutor = null;
    try {
      if (opts.prepareRepos) {
        this._broadcast({ latest: { scenarioId, status: 'preparing repo' } });
        await this._prepareScenarioRepo(scenario, { cacheRoot: opts.cacheRoot, workDir, refreshRepos: opts.refreshRepos });
      } else {
        fs.mkdirSync(workDir, { recursive: true });
      }

      result.repo = {
        url: scenario.repo.url,
        commit: await this._gitHead(workDir),
      };

      const selectedTasks = tasksForScenario(scenario).slice(0, opts.maxTasksPerRepo);
      result.taskCount = selectedTasks.length;
      if (opts.dryRun) {
        result.dryRun = true;
        result.setupCompleted = true;
        result.tasks = selectedTasks.map((task, taskIndex) => ({
          taskId: task.id,
          taskIndex,
          userName: task.userName,
          prompt: buildUserPrompt(scenario, { task }),
          dryRun: true,
          setupCompleted: true,
          setupStatus: { status: 'not_required', setupCompleted: true, reason: 'dry_run' },
          finalText: '[dry-run] live LLM execution skipped',
          transcript: [],
          events: [],
          toolCalls: [],
          verification: { commands: [] },
          git: {},
          score: scoreScenario({ dryRun: true, setupCompleted: true, verification: { commands: [] }, git: {}, toolCalls: [] }),
        }));
        result.prompt = result.tasks[0]?.prompt || '';
        result.finalText = '[dry-run] live LLM execution skipped';
        result.git.status = fs.existsSync(path.join(workDir, '.git'))
          ? await runShell('git status --short --branch', { cwd: workDir, timeoutMs: 15000 })
          : { ok: false, command: 'git status --short --branch', cwd: workDir, stdout: '', stderr: 'not a prepared git worktree', skipped: true };
        result.changedFiles = changedFileSummary(result.git.status);
        result.setupStatus = { status: 'not_required', setupCompleted: true, reason: 'dry_run' };
        result.setupCompleted = true;
        result.handoffFacts = [];
        result.score = scoreScenario(result);
        result.finishedAt = new Date().toISOString();
        return result;
      }

      if (!this.createCliTicket) throw new Error('No CLI ticket issuer configured');
      postExecutor = new LocalToolExecutor({
        ...executorOpts,
        root: workDir,
        defaultTimeoutMs: 120000,
        maxOutputBytes: 120000,
      });

      for (let taskIndex = 0; taskIndex < selectedTasks.length; taskIndex += 1) {
        if (this.cancelled) break;
        const task = selectedTasks[taskIndex];
        const taskId = safeIdPart(task.id || `task-${taskIndex + 1}`);
        const taskSessionId = `scb:${opts.runId}:${safeIdPart(scenarioId)}:${taskId}:${crypto.randomBytes(3).toString('hex')}`;
        const taskUserName = task.userName || opts.userName;
        const baseTaskPrompt = buildUserPrompt(scenario, { task });
        const previousTaskResults = result.tasks.slice();
        let actorInitial = null;
        let taskPrompt = baseTaskPrompt;
        if (opts.actor) {
          this._broadcast({ latest: { scenarioId, taskId: task.id, status: 'actor initial prompt' } });
          actorInitial = await generateActorTurn({
            llmClient: this.llmClient,
            model: opts.actorModel,
            scenario,
            task,
            previousTasks: previousTaskResults,
            fallbackPrompt: baseTaskPrompt,
            guidance: opts.actorGuidance,
          });
          taskPrompt = actorInitial.text || baseTaskPrompt;
        }
        activeTaskResult = {
          scenarioId,
          taskId: task.id,
          taskIndex,
          userName: taskUserName,
          sessionId: taskSessionId,
          basePrompt: baseTaskPrompt,
          prompt: taskPrompt,
          actorInitial,
          actorDecisions: [],
          actorDone: !opts.actor,
          actorDoneReason: '',
          actorMaxTurnsHit: false,
          turns: [],
          startedAt: new Date().toISOString(),
          transcript: [],
          events: [],
          toolCalls: [],
          verification: { commands: [] },
          git: {},
        };
        result.tasks.push(activeTaskResult);
        if (!result.prompt) result.prompt = taskPrompt;

        const token = await this.createCliTicket(taskUserName, 60 * 60 * 1000);
        const executor = new LocalToolExecutor({
          ...executorOpts,
          root: workDir,
          defaultTimeoutMs: 30000,
          maxOutputBytes: 100000,
        });
        const conversation = [];
        session = new LiveSporeCodeSession({
          baseUrl: opts.baseUrl,
          token,
          sessionId: taskSessionId,
          cwd: workDir,
          userName: taskUserName,
          localTools: DEFAULT_LOCAL_TOOLS,
          toolExecutor: executor,
          askUserResponder: opts.actor ? async (msg) => {
            const question = askUserText(msg);
            const actorDecision = await generateActorFollowup({
              llmClient: this.llmClient,
              model: opts.actorModel,
              scenario,
              task,
              previousTasks: previousTaskResults,
              conversation,
              assistantText: question,
              guidance: opts.actorGuidance,
            });
            activeTaskResult.actorDecisions.push({
              kind: 'ask_user',
              qid: msg.qid || null,
              question: compactOutput(question, 4000),
              ...actorDecision,
            });
            if (actorDecision.text) return actorDecision.text;
            return 'That sounds acceptable. Please continue and wrap up with what changed and what you verified.';
          } : null,
          turnTimeoutMs: opts.turnTimeoutMs,
          projectContext: {
            mode: 'execute',
            benchmark: {
              runId: opts.runId,
              scenarioId,
              taskId: task.id,
              taskIndex,
              canary,
              context: buildBenchmarkContext(scenario, task, {
                runId: opts.runId,
                sessionId: taskSessionId,
                canary,
              }),
            },
            repoUrl: scenario.repo.url,
            repoDomain: scenario.domain,
            projectName: scenarioId,
          },
        });
        await session.connect();
        session.startSession();
        this._broadcast({ latest: { scenarioId, taskId: task.id, status: 'chat started', turn: 1 } });

        let nextUserText = taskPrompt;
        let lastTurn = null;
        for (let turnIndex = 0; turnIndex < opts.maxTurnsPerTask; turnIndex += 1) {
          if (this.cancelled) break;
          conversation.push({ role: 'user', text: nextUserText });
          const turnRecord = {
            turnIndex,
            userText: nextUserText,
            startedAt: new Date().toISOString(),
          };
          activeTaskResult.turns.push(turnRecord);
          const turn = await session.sendChat(nextUserText, { mode: 'execute', displayText: nextUserText });
          lastTurn = turn;
          turnRecord.finishedAt = new Date().toISOString();
          turnRecord.assistantText = turn.text || '';
          turnRecord.usage = turn.usage || null;
          turnRecord.iterations = turn.iterations || 0;
          turnRecord.toolUsage = turn.toolUsage || {};
          turnRecord.responseRepair = turn.responseRepair || null;
          activeTaskResult.finalText = turn.text || '';
          if (turn.responseRepair) activeTaskResult.responseRepair = turn.responseRepair;
          if (turn.usage) {
            activeTaskResult.usage = activeTaskResult.usage || {};
            for (const [key, value] of Object.entries(turn.usage)) {
              if (typeof value === 'number') activeTaskResult.usage[key] = (activeTaskResult.usage[key] || 0) + value;
            }
          }
          activeTaskResult.iterations = (activeTaskResult.iterations || 0) + (Number(turn.iterations) || 0);
          activeTaskResult.toolUsage = activeTaskResult.toolUsage || {};
          for (const [key, value] of Object.entries(turn.toolUsage || {})) {
            if (typeof value === 'number') activeTaskResult.toolUsage[key] = (activeTaskResult.toolUsage[key] || 0) + value;
          }
          conversation.push({ role: 'agent', text: turn.text || '' });

          if (!opts.actor) break;
          this._broadcast({ latest: { scenarioId, taskId: task.id, status: 'actor decision', turn: turnIndex + 1 } });
          const actorDecision = await generateActorFollowup({
            llmClient: this.llmClient,
            model: opts.actorModel,
            scenario,
            task,
            previousTasks: previousTaskResults,
            conversation,
            assistantText: turn.text || '',
            guidance: opts.actorGuidance,
          });
          activeTaskResult.actorDecisions.push({ turnIndex, ...actorDecision });
          if (actorDecision.done) {
            activeTaskResult.actorDone = true;
            activeTaskResult.actorDoneReason = actorDecision.reason || actorDecision.intent || '';
            break;
          }
          nextUserText = actorDecision.text || '';
          if (!nextUserText) {
            activeTaskResult.actorDone = true;
            activeTaskResult.actorDoneReason = actorDecision.reason || 'Actor returned no follow-up message';
            break;
          }
          if (turnIndex < opts.maxTurnsPerTask - 1) {
            this._broadcast({ latest: { scenarioId, taskId: task.id, status: 'actor follow-up', turn: turnIndex + 2 } });
          }
        }
        if (opts.actor && !activeTaskResult.actorDone) {
          activeTaskResult.actorMaxTurnsHit = true;
          activeTaskResult.actorDoneReason = `Stopped after maxTurnsPerTask=${opts.maxTurnsPerTask}`;
        }
        if (!lastTurn && !activeTaskResult.finalText) activeTaskResult.finalText = '';
        activeTaskResult.transcript = session.transcript;
        activeTaskResult.events = session.events;
        activeTaskResult.toolCalls = session.toolCalls.map(call => ({ ...call, taskId: task.id }));

        result.transcript.push(...activeTaskResult.transcript);
        result.events.push(...activeTaskResult.events);
        result.toolCalls.push(...activeTaskResult.toolCalls);

        const settlePromise = this._beginSessionSettle(taskSessionId, {
          scenarioId,
          taskId: task.id,
          userName: taskUserName,
          sessionSettleMs: opts.sessionSettleMs,
          sessionSettleQuietMs: opts.sessionSettleQuietMs,
        });
        await session.close(true);
        session = null;
        activeTaskResult.memorySettle = await settlePromise;

        if (opts.runVerification) {
          for (const commandSpec of task.verification?.commands || scenario.verification?.commands || []) {
            if (this.cancelled) break;
            const spec = normalizeVerificationSpec(commandSpec);
            this._broadcast({ latest: { scenarioId, taskId: task.id, status: 'verification', command: spec.command } });
            const verification = evaluateCommandResult(
              spec,
              await postExecutor.exec({ command: spec.command, workdir: workDir, timeout: 180000, maxOutputBytes: 120000 })
            );
            activeTaskResult.verification.commands.push({
              taskId: task.id,
              command: spec.command,
              kind: spec.kind,
              ok: !!verification.ok,
              exitOk: verification.exitOk,
              semanticOk: verification.semanticOk,
              infraOk: verification.infraOk,
              failureReason: verification.failureReason || null,
              problems: verification.problems || [],
              exitCode: verification.exitCode,
              timedOut: verification.timedOut,
              durationMs: verification.durationMs,
              stdout: compactOutput(verification.stdout, 8000),
              stderr: compactOutput(verification.stderr, 8000),
              error: verification.error || null,
            });
          }
        }

        activeTaskResult.git.status = await postExecutor.gitStatus({ path: workDir });
        activeTaskResult.git.untrackedSummary = await postExecutor.gitUntrackedSummary({ path: workDir });
        activeTaskResult.changedFiles = changedFileSummary(activeTaskResult.git.status);
        activeTaskResult.verificationClaim = classifyVerificationClaim(
          activeTaskResult.finalText || '',
          activeTaskResult.verification.commands
        );
        activeTaskResult.setupStatus = deriveSetupStatus(activeTaskResult);
        activeTaskResult.setupCompleted = !!activeTaskResult.setupStatus?.setupCompleted;
        activeTaskResult.handoffFacts = buildHandoffFacts(activeTaskResult);
        activeTaskResult.score = scoreScenario(activeTaskResult);
        activeTaskResult.finishedAt = new Date().toISOString();
        result.verification.commands.push(...activeTaskResult.verification.commands);

        if (opts.taskPauseMs && taskIndex < selectedTasks.length - 1) {
          await sleep(opts.taskPauseMs);
        }
        activeTaskResult = null;
      }

      result.finalText = result.tasks
        .map(t => t.finalText ? `[${t.taskId}] ${t.finalText}` : '')
        .filter(Boolean)
        .join('\n\n') || '';
      result.usage = result.tasks.reduce((acc, t) => {
        if (!t.usage) return acc;
        for (const [key, value] of Object.entries(t.usage)) {
          if (typeof value === 'number') acc[key] = (acc[key] || 0) + value;
        }
        return acc;
      }, {});
      result.iterations = result.tasks.reduce((n, t) => n + (Number(t.iterations) || 0), 0);
      result.toolUsage = result.tasks.reduce((acc, t) => {
        for (const [key, value] of Object.entries(t.toolUsage || {})) {
          acc[key] = (acc[key] || 0) + value;
        }
        return acc;
      }, {});

      result.git.status = await postExecutor.gitStatus({ path: workDir });
      result.git.diffStat = await postExecutor.gitDiff({ path: workDir, stat: true, limit: 30000 });
      result.git.untrackedSummary = await postExecutor.gitUntrackedSummary({ path: workDir });
      if (opts.includeDiff) result.git.diff = await postExecutor.gitDiff({ path: workDir, limit: 160000 });
      result.changedFiles = changedFileSummary(result.git.status);
      result.verificationClaim = classifyVerificationClaim(result.finalText || '', result.verification.commands);
      result.setupStatus = deriveSetupStatus(result);
      result.setupCompleted = !!result.setupStatus?.setupCompleted;
      result.handoffFacts = result.tasks.map(t => t.handoffFacts).filter(Boolean);
      result.score = scoreScenario(result);

      if (opts.experienceSummary && this.llmClient && opts.experienceSummaryModel && !result.dryRun) {
        this._broadcast({ latest: { scenarioId, status: 'planner experience summary' } });
        try {
          result.experienceSummary = await summarizeExperienceWithLlm({
            llmClient: this.llmClient,
            model: opts.experienceSummaryModel,
            scenario,
            result,
          });
        } catch (e) {
          result.experienceSummary = { error: e.message };
        }
      }

      if (opts.judge && this.llmClient && opts.judgeModel) {
        this._broadcast({ latest: { scenarioId, status: 'llm judge' } });
        try {
          result.llmJudge = await judgeWithLlm({
            llmClient: this.llmClient,
            model: opts.judgeModel,
            scenario,
            result,
          });
        } catch (e) {
          result.llmJudge = { error: e.message };
        }
      }
    } catch (e) {
      result.error = e.message;
      if (session) {
        if (activeTaskResult) {
          activeTaskResult.error = e.message;
          activeTaskResult.finishedAt = new Date().toISOString();
          activeTaskResult.transcript = session.transcript;
          activeTaskResult.events = session.events;
          activeTaskResult.toolCalls = session.toolCalls;
          try {
            if (postExecutor) activeTaskResult.git.status = await postExecutor.gitStatus({ path: workDir });
            if (postExecutor) activeTaskResult.git.untrackedSummary = await postExecutor.gitUntrackedSummary({ path: workDir });
          } catch {}
          activeTaskResult.changedFiles = changedFileSummary(activeTaskResult.git.status);
          activeTaskResult.verificationClaim = classifyVerificationClaim(
            activeTaskResult.finalText || '',
            activeTaskResult.verification.commands
          );
          activeTaskResult.setupStatus = deriveSetupStatus(activeTaskResult);
          activeTaskResult.setupCompleted = !!activeTaskResult.setupStatus?.setupCompleted;
          activeTaskResult.handoffFacts = buildHandoffFacts(activeTaskResult);
          activeTaskResult.score = scoreScenario(activeTaskResult);
          result.transcript.push(...activeTaskResult.transcript);
          result.events.push(...activeTaskResult.events);
          result.toolCalls.push(...activeTaskResult.toolCalls);
        } else {
          result.transcript = session.transcript;
          result.events = session.events;
          result.toolCalls = session.toolCalls;
        }
        try { await session.close(false); } catch {}
      }
      try {
        if (postExecutor) {
          result.git.status = await postExecutor.gitStatus({ path: workDir });
          result.git.diffStat = await postExecutor.gitDiff({ path: workDir, stat: true, limit: 30000 });
          result.git.untrackedSummary = await postExecutor.gitUntrackedSummary({ path: workDir });
        }
      } catch {}
      result.changedFiles = changedFileSummary(result.git.status);
      result.verificationClaim = classifyVerificationClaim(result.finalText || '', result.verification.commands);
      result.setupStatus = deriveSetupStatus(result);
      result.setupCompleted = !!result.setupStatus?.setupCompleted;
      result.handoffFacts = result.tasks.map(t => t.handoffFacts).filter(Boolean);
      result.score = scoreScenario(result);
    } finally {
      result.finishedAt = new Date().toISOString();
    }
    return result;
  }

  _beginSessionSettle(sessionId, opts = {}) {
    const timeoutMs = Math.max(0, Number(opts.sessionSettleMs) || 0);
    if (!timeoutMs) return Promise.resolve({ status: 'disabled', timeoutMs: 0 });
    const base = {
      sessionId,
      sessionKey: `channel:${sessionId}`,
      scenarioId: opts.scenarioId || null,
      taskId: opts.taskId || null,
      userName: opts.userName || null,
      timeoutMs,
      quietMs: Math.max(250, Number(opts.sessionSettleQuietMs) || 2500),
    };
    if (typeof this.waitForSessionSettle === 'function') {
      try {
        return Promise.resolve(this.waitForSessionSettle(base))
          .catch(e => ({ ...base, status: 'error', error: e.message }));
      } catch (e) {
        return Promise.resolve({ ...base, status: 'error', error: e.message });
      }
    }
    return Promise.resolve({ ...base, status: 'unavailable' });
  }

  async _prepareScenarioRepo(scenario, opts = {}) {
    const cacheDir = path.join(opts.cacheRoot, safeIdPart(scenario.id));
    const needsClone = opts.refreshRepos || !fs.existsSync(path.join(cacheDir, '.git'));
    if (needsClone) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
      const clone = await runShell(`git clone --depth 1 ${shellQuote(scenario.repo.url)} ${shellQuote(cacheDir)}`, {
        cwd: path.dirname(cacheDir),
        timeoutMs: 10 * 60 * 1000,
      });
      if (!clone.ok) throw new Error(`Failed to clone ${scenario.repo.url}: ${clone.stderr || clone.stdout || clone.error}`);
      if (scenario.repo.ref) {
        const checkout = await runShell(`git checkout ${shellQuote(scenario.repo.ref)}`, { cwd: cacheDir, timeoutMs: 120000 });
        if (!checkout.ok) throw new Error(`Failed to checkout ${scenario.repo.ref}: ${checkout.stderr || checkout.stdout}`);
      }
    }
    fs.rmSync(opts.workDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(opts.workDir), { recursive: true });
    const localClone = await runShell(`git clone --shared ${shellQuote(cacheDir)} ${shellQuote(opts.workDir)}`, {
      cwd: path.dirname(opts.workDir),
      timeoutMs: 5 * 60 * 1000,
    });
    if (!localClone.ok) throw new Error(`Failed to create scenario worktree: ${localClone.stderr || localClone.stdout || localClone.error}`);
  }

  async _gitHead(workDir) {
    if (!fs.existsSync(path.join(workDir, '.git'))) return null;
    const r = await runShell('git rev-parse HEAD', { cwd: workDir, timeoutMs: 15000 });
    return r.ok ? String(r.stdout || '').trim() : null;
  }

  _writeReport(baseDir, report, trace = null) {
    const latest = path.join(baseDir, 'spore-code-benchmark-results.json');
    const runFile = path.join(baseDir, 'runs', report.runId, 'report.json');
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    if (trace) {
      const traceFile = path.join(path.dirname(runFile), 'trace.json');
      fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2));
      report.reportFormat = {
        ...(report.reportFormat || {}),
        rawTrace: path.relative(baseDir, traceFile),
      };
    }
    fs.writeFileSync(runFile, JSON.stringify(report, null, 2));
    fs.writeFileSync(latest, JSON.stringify(report, null, 2));
  }
}

module.exports = {
  SporeCodeBenchmarkRunner,
  SCENARIOS,
  _test: {
    compactOutput,
    makeCanary,
    mapWithConcurrency,
    compactReportForStorage,
    runShell,
    safeIdPart,
    summarizeEventEntries,
    summarizeRun,
  },
};
