/**
 * longmemeval.js — LongMemEval Benchmark Runner
 *
 * Ingests LongMemEval conversation sessions through the Learner to build a
 * knowledge graph, then evaluates questions using GraphContext + LLM, scored
 * by an LLM judge with the official LongMemEval prompts.
 *
 * Runs in-process so graphEvents fire in real time for the graph viewer.
 */

const fs = require('fs');
const path = require('path');
const { download, resolveDatasetPath, VARIANTS } = require('./download-dataset');
const { coreRequire, modelForTier } = require('../../core-require');

// ── LLM-as-Judge Prompt Templates (from LongMemEval evaluate_qa.py) ─────────

const JUDGE_STANDARD = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: {QUESTION}
Correct answer: {ANSWER}
Model response: {HYPOTHESIS}`;

const JUDGE_TEMPORAL = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. Do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: {QUESTION}
Correct answer: {ANSWER}
Model response: {HYPOTHESIS}`;

const JUDGE_KNOWLEDGE_UPDATE = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: {QUESTION}
Correct answer: {ANSWER}
Model response: {HYPOTHESIS}`;

const JUDGE_PREFERENCE = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: {QUESTION}
Desired response rubric: {ANSWER}
Model response: {HYPOTHESIS}`;

const JUDGE_ABSTENTION = `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: {QUESTION}
Explanation: {ANSWER}
Model response: {HYPOTHESIS}`;

const JUDGE_PROMPTS = {
  'single-session-user': JUDGE_STANDARD,
  'single-session-assistant': JUDGE_STANDARD,
  'single-session-preference': JUDGE_PREFERENCE,
  'multi-session': JUDGE_STANDARD,
  'temporal-reasoning': JUDGE_TEMPORAL,
  'knowledge-update': JUDGE_KNOWLEDGE_UPDATE,
};

const QUESTION_TYPE_LABELS = {
  'single-session-user': 'Single-Session (User)',
  'single-session-assistant': 'Single-Session (Assistant)',
  'single-session-preference': 'Single-Session (Preference)',
  'multi-session': 'Multi-Session',
  'temporal-reasoning': 'Temporal Reasoning',
  'knowledge-update': 'Knowledge Update',
};

const DEFAULT_MAX_QUESTIONS = 500;
const FOCUSED_MAX_QUESTIONS = 50;
const FOCUSED_MAX_SESSIONS = 10;

function _questionSessionIds(question, index = 0) {
  const ids = Array.isArray(question?.haystack_session_ids)
    ? question.haystack_session_ids.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  if (ids.length) return [...new Set(ids)];

  const sessions = Array.isArray(question?.haystack_sessions) ? question.haystack_sessions : [];
  return sessions.map((_, i) => `q${index}:session${i}`);
}

function _countUniqueQuestionSessions(questions) {
  const ids = new Set();
  (questions || []).forEach((q, index) => {
    for (const id of _questionSessionIds(q, index)) ids.add(id);
  });
  return ids.size;
}

function _filterQuestionTypes(dataset, questionTypes) {
  if (!questionTypes || questionTypes.length === 0) return dataset;
  const typeSet = new Set(questionTypes);
  return dataset.filter(q => typeSet.has(q.question_type));
}

function _selectStratifiedQuestions(filtered, maxQuestions = DEFAULT_MAX_QUESTIONS) {
  const maxQ = Math.max(1, Math.floor(Number(maxQuestions) || DEFAULT_MAX_QUESTIONS));
  if (filtered.length <= maxQ) return filtered;

  const byType = {};
  for (const q of filtered) {
    const t = q.question_type || 'unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(q);
  }
  const types = Object.keys(byType);
  const questions = [];
  const perType = Math.max(1, Math.floor(maxQ / types.length));
  let remaining = maxQ;
  for (const t of types) {
    const take = Math.min(perType, byType[t].length, remaining);
    questions.push(...byType[t].slice(0, take));
    remaining -= take;
  }
  for (const t of types) {
    if (remaining <= 0) break;
    const already = questions.filter(q => q.question_type === t).length;
    const extra = byType[t].slice(already, already + remaining);
    questions.push(...extra);
    remaining -= extra.length;
  }
  return questions;
}

function _scoreFocusedCandidate(candidate, selectedSessions, typeCounts) {
  let newSessions = 0;
  for (const id of candidate.sessionIds) {
    if (!selectedSessions.has(id)) newSessions++;
  }
  return [
    newSessions === 0 ? 0 : 1,
    typeCounts[candidate.type] || 0,
    newSessions,
    candidate.sessionIds.length,
    candidate.index,
  ];
}

function _compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function _selectFocusedQuestions(filtered, opts = {}) {
  const maxQuestions = Math.max(1, Math.floor(Number(opts.maxQuestions) || FOCUSED_MAX_QUESTIONS));
  const maxSessions = Math.max(1, Math.floor(Number(opts.maxSessions) || FOCUSED_MAX_SESSIONS));
  const candidates = filtered
    .map((question, index) => ({
      question,
      index,
      type: question.question_type || 'unknown',
      sessionIds: _questionSessionIds(question, index),
    }))
    .filter(c => c.sessionIds.length > 0 && c.sessionIds.length <= maxSessions);

  const selected = [];
  const used = new Set();
  const selectedSessions = new Set();
  const typeCounts = {};

  while (selected.length < maxQuestions) {
    let best = null;
    let bestScore = null;
    for (const candidate of candidates) {
      if (used.has(candidate.index)) continue;
      let added = 0;
      for (const id of candidate.sessionIds) {
        if (!selectedSessions.has(id)) added++;
      }
      if (selectedSessions.size + added > maxSessions) continue;

      const score = _scoreFocusedCandidate(candidate, selectedSessions, typeCounts);
      if (!best || _compareScores(score, bestScore) < 0) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    used.add(best.index);
    selected.push(best);
    typeCounts[best.type] = (typeCounts[best.type] || 0) + 1;
    for (const id of best.sessionIds) selectedSessions.add(id);
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map(c => c.question);
}

// ─────────────────────────────────────────────────────────────────────────────

class LongMemEvalRunner {
  constructor({ config, graph, learner, maintainer, llmClient, log, broadcast, learnerModel, answerModel }) {
    this.config = config;
    this.graph = graph;
    this.learner = learner;
    this.maintainer = maintainer || null;
    this.llmClient = llmClient;
    this.log = log;
    this.broadcast = broadcast || (() => {});
    // Fallback chains for learner / answer models live in the settings
    // registry (`models.learner` → casual → normal). Both call sites
    // are equivalent today; kept separate so future tuning can diverge.
    this.learnerModel = learnerModel || modelForTier('learner', config);
    this.answerModel = answerModel || modelForTier('learner', config);

    this.phase = 'idle';
    this.cancelled = false;
    this.progress = { current: 0, total: 0 };
    this.results = [];
    this.scores = null;
    this.startTime = null;

    this._stats = {
      sessionsIngested: 0,
      exchangesProcessed: 0,
      questionsAnswered: 0,
      questionsJudged: 0,
      nodesCreated: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLatencyMs: 0,
    };
  }

  /** Return serializable status snapshot. */
  getStatus() {
    return {
      phase: this.phase,
      progress: { ...this.progress },
      stats: { ...this._stats },
      scores: this.scores,
      elapsed: this.startTime ? Date.now() - this.startTime : 0,
      resultsCount: this.results.length,
    };
  }

  cancel() {
    this.cancelled = true;
    this.phase = 'cancelled';
    if (this.results.length > 0) {
      this.log.info(`[longmemeval] Saving ${this.results.length} partial results on cancel`);
      this._writeResultsFile();
    }
    this.broadcast({ type: 'benchmark:error', message: 'Benchmark cancelled by user' });
  }

  // ── Main Entry ──────────────────────────────────────────────────────────

  async run(opts = {}) {
    const mode = opts.mode === 'focused' || opts.mode === 'micro' ? 'focused' : 'standard';
    const variant = opts.variant || 'oracle';
    const maxQuestions = Math.max(1, Math.floor(Number(opts.maxQuestions) || (mode === 'focused' ? FOCUSED_MAX_QUESTIONS : DEFAULT_MAX_QUESTIONS)));
    const maxSessions = Math.max(1, Math.floor(Number(opts.maxSessions) || FOCUSED_MAX_SESSIONS));
    const skipIngestion = opts.skipIngestion || false;
    const forceReeval = opts.forceReeval || false;
    const questionTypes = opts.questionTypes || null; // null = all types
    this.startTime = Date.now();
    this.phase = 'loading';

    this.log.info(`[longmemeval] Starting benchmark: mode=${mode} variant=${variant} maxQ=${maxQuestions} maxSessions=${mode === 'focused' ? maxSessions : 'n/a'} skip=${skipIngestion} fresh=${forceReeval} types=${questionTypes ? questionTypes.join(',') : 'all'}`);
    this.log.info(`[longmemeval] Models: learner=${this.learnerModel} answer=${this.answerModel}`);
    this.log.info(`[longmemeval] Enhanced Recall: ${!!this.config.enhancedRecall}`);

    try {
      this.broadcast({ type: 'benchmark:start', mode, variant, maxQuestions, maxSessions: mode === 'focused' ? maxSessions : null });

      // Load dataset
      const dataset = await this._loadDataset(variant);

      // Filter by question type if specified, then sample.
      const filtered = _filterQuestionTypes(dataset, questionTypes);
      const questions = mode === 'focused'
        ? _selectFocusedQuestions(filtered, { maxQuestions, maxSessions })
        : _selectStratifiedQuestions(filtered, maxQuestions);
      if (questions.length === 0) {
        throw new Error(mode === 'focused'
          ? `focused slice found no questions fitting ${maxSessions} sessions`
          : 'no questions selected');
      }
      const selectedSessionCount = _countUniqueQuestionSessions(questions);
      const modeLabel = mode === 'focused'
        ? `focused slice, ${selectedSessionCount}/${maxSessions} sessions`
        : 'stratified';

      this.broadcast({
        type: 'benchmark:progress',
        phase: 'loaded',
        totalQuestions: questions.length,
        message: `Loaded ${questions.length} questions (${modeLabel}, ${variant} variant)`,
      });

      // Phase 1: Ingestion (temporarily override learnerModel if a custom one was requested)
      if (!skipIngestion) {
        const origLearnerModel = this.config.learnerModel;
        if (this.learnerModel !== origLearnerModel) {
          this.config.learnerModel = this.learnerModel;
          this.log.info(`[longmemeval] Overriding learnerModel: ${origLearnerModel} -> ${this.learnerModel}`);
        }
        try {
          await this._runIngestion(questions);
        } finally {
          if (this.learnerModel !== origLearnerModel) this.config.learnerModel = origLearnerModel;
        }
        if (this.cancelled) return this.getStatus();
      }

      // Phase 1.5: Post-ingestion synthesis — run maintenance tasks to create
      // cross-entity inferences, wire orphan nodes, and embed all nodes
      if (!skipIngestion && this.maintainer) {
        this.phase = 'synthesis';
        this.log.info('[longmemeval] Phase 1.5: Post-ingestion synthesis');
        this.broadcast({ type: 'benchmark:progress', phase: 'synthesis', message: 'Running post-ingestion synthesis...' });
        try {
          await this.maintainer.connectSparseNodes(5);
          await this.maintainer.deriveInferences(5);
          await this.maintainer.embedUnembeddedNodes(30);
          this.log.info('[longmemeval] Post-ingestion synthesis complete');
        } catch (e) {
          this.log.warn(`[longmemeval] Synthesis error (non-fatal): ${e.message}`);
        }
      }

      // Resume: load any partial results from a previous interrupted run
      if (!forceReeval) {
        this._resumeFromPartial(questions);
      } else {
        this.log.info('[longmemeval] Force re-eval: skipping resume, re-answering all questions');
      }

      // Phase 2: Evaluation
      await this._runEvaluation(questions);
      if (this.cancelled) return this.getStatus();

      // Phase 3: Scoring
      this.scores = this._computeScores();
      this.phase = 'done';

      this.broadcast({
        type: 'benchmark:done',
        scores: this.scores,
        elapsed: Date.now() - this.startTime,
        stats: this._stats,
      });

      this._writeResultsFile();

      return this.getStatus();
    } catch (e) {
      this.phase = 'error';
      this.log.error(`[longmemeval] Benchmark failed: ${e.message}`);
      if (this.results.length > 0) {
        this.log.info(`[longmemeval] Saving ${this.results.length} partial results before exit`);
        this._writeResultsFile();
      }
      this.broadcast({ type: 'benchmark:error', message: e.message });
      throw e;
    }
  }

  // ── Phase 1: Ingestion ─────────────────────────────────────────────────

  async _runIngestion(questions) {
    this.phase = 'ingestion';
    this.log.info('[longmemeval] Phase 1: Ingestion — extracting knowledge from sessions');

    // Deduplicate sessions across all questions
    const sessionMap = new Map();
    for (const q of questions) {
      const ids = q.haystack_session_ids || [];
      const sessions = q.haystack_sessions || [];
      const dates = q.haystack_dates || [];
      for (let i = 0; i < sessions.length; i++) {
        const sid = ids[i] || `session-${i}`;
        if (!sessionMap.has(sid)) {
          sessionMap.set(sid, { id: sid, turns: sessions[i], date: dates[i] || null });
        }
      }
    }

    // Sort chronologically
    const allSessions = [...sessionMap.values()].sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return a.date.localeCompare(b.date);
    });

    this.progress = { current: 0, total: allSessions.length };
    this.log.info(`[longmemeval] ${allSessions.length} unique sessions to ingest`);

    this.broadcast({
      type: 'benchmark:progress',
      phase: 'ingestion',
      current: 0,
      total: allSessions.length,
      message: `Ingesting ${allSessions.length} unique sessions...`,
    });

    // Track node creation events for stats
    const graphEvents = coreRequire('graph/events');
    const changeListener = (evt) => {
      if (evt.op === 'node:create') this._stats.nodesCreated++;
    };
    graphEvents.on('change', changeListener);

    // Track ingestion timing so we can broadcast a rolling ETA. Slow
    // learner models (e.g. self-hosted FP8 GLM at ~115s/exchange) make
    // this phase take many minutes per session — without per-exchange
    // updates the UI looks frozen for the whole first session.
    const ingestStartedAt = Date.now();
    let exchangesAtStart = this._stats.exchangesProcessed;
    const broadcastIngest = (sessionIdx, exchangeNote) => {
      const exchangesDone = this._stats.exchangesProcessed - exchangesAtStart;
      const elapsedSec = (Date.now() - ingestStartedAt) / 1000;
      const perExchange = exchangesDone > 0 ? elapsedSec / exchangesDone : 0;
      const sessionsLeft = allSessions.length - sessionIdx;
      // Use a rolling avg of exchanges-per-session (so far) to estimate.
      const avgExchPerSession = sessionIdx > 0 ? exchangesDone / sessionIdx : (exchangesDone || 1);
      const etaSec = Math.round(sessionsLeft * avgExchPerSession * perExchange);
      const etaStr = etaSec > 60 ? `${Math.round(etaSec / 60)} min` : `${etaSec}s`;
      const msg = exchangeNote
        ? `[session ${sessionIdx + 1}/${allSessions.length}] ${exchangeNote} · ${exchangesDone} exchanges · ETA ${etaStr}`
        : `Session ${sessionIdx + 1}/${allSessions.length} done · ${exchangesDone} exchanges · ETA ${etaStr}`;
      this.broadcast({
        type: 'benchmark:progress',
        phase: 'ingestion',
        current: sessionIdx + (exchangeNote ? 0 : 1),
        total: allSessions.length,
        stats: { ...this._stats },
        message: msg,
      });
    };

    for (let si = 0; si < allSessions.length; si++) {
      if (this.cancelled) return;

      const session = allSessions[si];
      const turns = session.turns || [];

      // Pair user/assistant turns into exchanges
      let lastProcessedIdx = -1;
      let exchangeIdx = 0;
      const totalExchanges = Math.max(1, Math.floor(turns.length / 2));
      for (let t = 0; t < turns.length - 1; t++) {
        if (this.cancelled) return;
        const turn = turns[t];
        const next = turns[t + 1];
        if (turn.role === 'user' && next.role === 'assistant') {
          const exchStart = Date.now();
          await this._learnerExtract(turn.content, next.content, session.date, session.id);
          this._stats.exchangesProcessed++;
          exchangeIdx++;
          lastProcessedIdx = t + 1;
          t++;
          // Per-exchange broadcast — keeps the UI alive while a slow
          // learner model is still chewing through the first session.
          broadcastIngest(si, `exchange ${exchangeIdx}/${totalExchanges} (${Math.round((Date.now() - exchStart) / 1000)}s)`);
        }
      }

      // Process any trailing user message not paired with an assistant response
      const last = turns[turns.length - 1];
      if (last && last.role === 'user' && turns.length - 1 > lastProcessedIdx) {
        await this._learnerExtract(last.content, null, session.date, session.id);
        this._stats.exchangesProcessed++;
      }

      this._stats.sessionsIngested++;
      this.progress.current = si + 1;
      broadcastIngest(si);
    }

    // Wait for any queued learner work to finish
    await this._waitForLearnerIdle();
    graphEvents.off('change', changeListener);

    this.log.info(`[longmemeval] Ingestion complete: ${this._stats.sessionsIngested} sessions, ${this._stats.exchangesProcessed} exchanges, ${this._stats.nodesCreated} nodes`);
  }

  /** Feed one exchange to the Learner, waiting for it to be idle first. Also store as episode. */
  async _learnerExtract(userMsg, assistantMsg, dateStr, sessionId) {
    await this._waitForLearnerIdle();
    const observedAt = dateStr ? new Date(dateStr).toISOString() : undefined;
    try {
      await this.learner.extractAndLearn(userMsg || '', assistantMsg || '', {
        userName: 'Alex',
        userId: 'alex',
        channelName: 'benchmark',
        observedAt,
      });
    } catch (e) {
      this.log.warn(`[longmemeval] Learner extraction error: ${e.message}`);
    }
    // Store raw episode for episodic memory fallback
    try {
      this.learner.storeEpisode(userMsg || '', assistantMsg || '', {
        sessionId: sessionId || 'benchmark',
        observedAt,
        turnIdx: this._stats.exchangesProcessed,
      });
    } catch (e) { this.log.warn('[longmemeval] this.learner.storeEpisode failed: ' + e.message); }
  }

  /** Poll until the learner queue is fully drained. */
  async _waitForLearnerIdle() {
    let waited = 0;
    while (this.learner._running || this.learner._queue.length > 0) {
      await sleep(200);
      waited += 200;
      if (waited > 60000) {
        this.log.warn('[longmemeval] Learner idle wait exceeded 60s, continuing');
        break;
      }
    }
  }

  // ── Resume from partial results ────────────────────────────────────────

  _resumeFromPartial(questions) {
    try {
      const outDir = path.dirname(this.config.graphDbPath);
      const outPath = path.join(outDir, 'longmemeval-results.json');
      if (!fs.existsSync(outPath)) return;

      const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (!prev.results || prev.results.length === 0) return;
      if (prev.phase === 'done') return; // completed run, don't resume

      // Build set of question IDs from current run to ensure compatibility
      const currentIds = new Set(questions.map(q => q.question_id));
      const resumable = prev.results.filter(r => currentIds.has(r.questionId));

      if (resumable.length === 0) return;

      this.results = resumable;
      this._answeredIds = new Set(resumable.map(r => r.questionId));
      this._stats.questionsAnswered = resumable.length;
      this._stats.questionsJudged = resumable.length;

      const scores = this._computeScores();
      this.log.info(`[longmemeval] Resuming: ${resumable.length} questions already answered (accuracy so far: ${(scores.overall * 100).toFixed(1)}%)`);
      this.broadcast({
        type: 'benchmark:progress',
        phase: 'evaluation',
        current: resumable.length,
        total: questions.length,
        message: `Resumed — ${resumable.length}/${questions.length} already answered`,
      });
    } catch (e) {
      this.log.warn(`[longmemeval] Resume failed (starting fresh): ${e.message}`);
    }
  }

  // ── Phase 2: Evaluation ────────────────────────────────────────────────

  async _runEvaluation(questions) {
    this.phase = 'evaluation';
    const alreadyDone = this._answeredIds ? this._answeredIds.size : 0;
    const remaining = questions.length - alreadyDone;
    this.progress = { current: alreadyDone, total: questions.length };
    this.log.info(`[longmemeval] Phase 2: Evaluation — ${remaining} questions remaining (${alreadyDone} already answered)`);

    this.broadcast({
      type: 'benchmark:progress',
      phase: 'evaluation',
      current: alreadyDone,
      total: questions.length,
      message: remaining < questions.length
        ? `Resuming evaluation — ${remaining} questions remaining...`
        : `Evaluating ${questions.length} questions...`,
    });

    for (let qi = 0; qi < questions.length; qi++) {
      if (this.cancelled) return;

      const q = questions[qi];

      // Skip questions already answered (resume support)
      if (this._answeredIds && this._answeredIds.has(q.question_id)) {
        this.progress.current = qi + 1;
        continue;
      }

      const isAbstention = q.question_id.endsWith('_abs');

      const questionStart = Date.now();
      let qInputTokens = 0;
      let qOutputTokens = 0;

      // Build system prompt using hybrid search + recall mode for maximum context
      let systemPrompt;
      const retrievalStart = Date.now();
      try {
        systemPrompt = await this.graph.buildSystemPromptAsync({
          promptMode: 'recall',
          messageContent: q.question,
          userName: 'Benchmark',
          userId: 'benchmark',
          channelId: 'benchmark',
          channelName: 'benchmark',
          _llmClient: this.llmClient,
          _referenceDate: q.question_date || null,
        });
      } catch (e) {
        this.log.warn(`[longmemeval] buildSystemPrompt failed for ${q.question_id}: ${e.message}`);
        systemPrompt = 'You are a helpful assistant with a long-term memory of past conversations.';
      }
      const retrievalMs = Date.now() - retrievalStart;

      // Answer the question (with optional second-pass retrieval)
      const answerStart = Date.now();
      let answerResult = await this._answerQuestion(systemPrompt, q.question, q.question_date);
      let hypothesis = answerResult.text;
      qInputTokens += answerResult.inputTokens;
      qOutputTokens += answerResult.outputTokens;

      // Two-pass: retry with targeted retrieval when answer quality is low
      const needsRetry =
        /don['']t have that information|not in my memory|no.*record|no specific date recorded|cannot recall|don['']t recall|i['']m not sure|i don['']t (?:remember|know)|unable to find|no information|not mentioned|haven['']t discussed/i.test(hypothesis) ||
        (hypothesis.length < 80 && !/\d/.test(hypothesis)) ||
        (q.question_type === 'temporal-reasoning' && !/\d{4}/.test(hypothesis));

      if (needsRetry) {
        try {
          const missing = await this._identifyMissingInfo(q.question, hypothesis);
          if (missing) {
            this.log.info(`[longmemeval] Two-pass: retrying with targeted search for "${missing.substring(0, 60)}"`);
            const secondPrompt = await this.graph.buildSystemPromptAsync({
              promptMode: 'recall',
              messageContent: missing,
              userName: 'Benchmark',
              userId: 'benchmark',
              channelId: 'benchmark',
              channelName: 'benchmark',
              _llmClient: this.llmClient,
              _referenceDate: q.question_date || null,
            });
            const retryResult = await this._answerQuestion(secondPrompt, q.question, q.question_date);
            qInputTokens += retryResult.inputTokens;
            qOutputTokens += retryResult.outputTokens;
            // Only use retry answer if it's more substantive
            if (retryResult.text.length > hypothesis.length || /\d/.test(retryResult.text)) {
              hypothesis = retryResult.text;
            }
          }
        } catch (e) {
          this.log.warn(`[longmemeval] Two-pass retry failed: ${e.message}`);
        }
      }

      const answerMs = Date.now() - answerStart;

      // Judge the answer
      const judgeStart = Date.now();
      const judgeResult = await this._judgeAnswer(q, hypothesis, isAbstention);
      qInputTokens += judgeResult.inputTokens;
      qOutputTokens += judgeResult.outputTokens;
      const judgeMs = Date.now() - judgeStart;

      const questionLatencyMs = Date.now() - questionStart;
      this.log.info(`[longmemeval] Timing Q${qi+1}: retrieval=${retrievalMs}ms answer=${answerMs}ms judge=${judgeMs}ms total=${questionLatencyMs}ms`);

      const result = {
        questionId: q.question_id,
        questionType: q.question_type,
        question: q.question,
        answer: q.answer,
        hypothesis,
        pass: judgeResult.pass,
        isAbstention,
        latencyMs: questionLatencyMs,
        inputTokens: qInputTokens,
        outputTokens: qOutputTokens,
      };
      this.results.push(result);
      this._stats.questionsAnswered++;
      this._stats.questionsJudged++;
      this._stats.totalInputTokens += qInputTokens;
      this._stats.totalOutputTokens += qOutputTokens;
      this._stats.totalLatencyMs += questionLatencyMs;
      this.progress.current = qi + 1;

      // Persist after every question so progress survives crashes
      this._writeResultsFile();

      this.broadcast({
        type: 'benchmark:question',
        ...result,
        current: qi + 1,
        total: questions.length,
      });

      if ((qi + 1) % 10 === 0) {
        const running = this._computeScores();
        const avgLatency = Math.round(this._stats.totalLatencyMs / this._stats.questionsAnswered);
        const totalTok = ((this._stats.totalInputTokens + this._stats.totalOutputTokens) / 1000).toFixed(1);
        this.log.info(`[longmemeval] Progress: ${qi + 1}/${questions.length} — accuracy: ${(running.overall * 100).toFixed(1)}% | avg ${avgLatency}ms/q | ${totalTok}K tok`);
      }
    }

    this.log.info(`[longmemeval] Evaluation complete: ${this._stats.questionsAnswered} questions answered`);
  }

  /** Use the agent's LLM to answer a question given the graph system prompt. */
  async _answerQuestion(systemPrompt, question, questionDate) {
    const dateContext = questionDate ? `\n\nCurrent date: ${questionDate}. Use this date to anchor any temporal reasoning (e.g. "how long ago", "when did", relative date calculations).` : '';
    const userContent = `${question}${dateContext}

Answer based on our past conversations. Be specific — include names, dates, numbers, and details. If a fact was updated over time, give the most recent version. For temporal questions, show your date math. If you truly don't have the information, say so rather than guessing.`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await Promise.race([
          this.llmClient.messages.create({
            model: this.answerModel,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000)),
        ]);
        const usage = response.usage || {};
        return {
          text: response.content?.[0]?.text || '',
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        };
      } catch (e) {
        this.log.warn(`[longmemeval] Answer attempt ${attempt + 1}/3 failed (model=${this.answerModel}): ${e.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    return { text: 'Error: all attempts failed', inputTokens: 0, outputTokens: 0 };
  }

  /** Extract what specific info the model was missing so we can do a targeted retry. */
  async _identifyMissingInfo(question, answer) {
    try {
      const response = await this.llmClient.messages.create({
        model: this.learnerModel,
        max_tokens: 80,
        temperature: 0,
        messages: [{
          role: 'user',
          content: `The question was: "${question}"
The answer said it couldn't find certain information: "${answer.substring(0, 300)}"

What specific fact, entity, or date was missing? Reply with ONLY a short search query (under 15 words) to find the missing information in a knowledge graph. No explanation.`,
        }],
      });
      const text = (response.content?.[0]?.text || '').trim();
      return text.length > 3 && text.length < 150 ? text : null;
    } catch {
      return null;
    }
  }

  /** Use LLM-as-judge to evaluate if the answer is correct. */
  async _judgeAnswer(question, hypothesis, isAbstention) {
    const template = isAbstention
      ? JUDGE_ABSTENTION
      : (JUDGE_PROMPTS[question.question_type] || JUDGE_STANDARD);

    const answerStr = Array.isArray(question.answer) ? question.answer.join(', ') : String(question.answer || '');
    const prompt = template
      .replace('{QUESTION}', question.question)
      .replace('{ANSWER}', answerStr)
      .replace('{HYPOTHESIS}', hypothesis);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await Promise.race([
          this.llmClient.messages.create({
            model: this.answerModel,
            max_tokens: 10,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
        ]);
        const text = (response.content?.[0]?.text || '').toLowerCase();
        const usage = response.usage || {};
        return {
          pass: text.includes('yes'),
          raw: text,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        };
      } catch (e) {
        this.log.warn(`[longmemeval] Judge attempt ${attempt + 1}/3 failed: ${e.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    return { pass: false, raw: 'error: all attempts failed', inputTokens: 0, outputTokens: 0 };
  }

  // ── Scoring ────────────────────────────────────────────────────────────

  _computeScores() {
    const byType = {};
    let totalPass = 0;

    for (const r of this.results) {
      if (!byType[r.questionType]) byType[r.questionType] = { total: 0, pass: 0 };
      byType[r.questionType].total++;
      if (r.pass) {
        byType[r.questionType].pass++;
        totalPass++;
      }
    }

    const typeScores = {};
    for (const [type, data] of Object.entries(byType)) {
      typeScores[type] = {
        label: QUESTION_TYPE_LABELS[type] || type,
        total: data.total,
        pass: data.pass,
        accuracy: data.total > 0 ? data.pass / data.total : 0,
      };
    }

    // Abstention questions
    const abstentionResults = this.results.filter(r => r.isAbstention);
    const abstentionPass = abstentionResults.filter(r => r.pass).length;

    // Efficiency metrics from per-question tracking
    const totalInput = this.results.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const totalOutput = this.results.reduce((s, r) => s + (r.outputTokens || 0), 0);
    const totalLatency = this.results.reduce((s, r) => s + (r.latencyMs || 0), 0);
    const n = this.results.length || 1;

    return {
      overall: this.results.length > 0 ? totalPass / this.results.length : 0,
      totalQuestions: this.results.length,
      totalPass,
      byType: typeScores,
      abstention: {
        total: abstentionResults.length,
        pass: abstentionPass,
        accuracy: abstentionResults.length > 0 ? abstentionPass / abstentionResults.length : 0,
      },
      efficiency: {
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
        avgInputTokensPerQ: Math.round(totalInput / n),
        avgOutputTokensPerQ: Math.round(totalOutput / n),
        avgLatencyMs: Math.round(totalLatency / n),
        totalLatencyMs: totalLatency,
        // Rough cost estimate (Sonnet 4.6: $3/MTok in, $15/MTok out)
        estimatedCostUsd: +(totalInput * 3 / 1e6 + totalOutput * 15 / 1e6).toFixed(4),
      },
    };
  }

  // ── Dataset Loading ────────────────────────────────────────────────────

  async _loadDataset(variant) {
    const dataDir = this.config.dataDir || path.dirname(this.config.graphDbPath);
    const benchDir = path.join(dataDir, 'benchmark');
    let dataPath = resolveDatasetPath(variant, benchDir);

    if (!dataPath) {
      this.broadcast({
        type: 'benchmark:progress',
        phase: 'downloading',
        message: `Downloading ${variant} dataset from HuggingFace...`,
      });
      dataPath = await download(variant, benchDir);
    }

    this.log.info(`[longmemeval] Loading dataset: ${dataPath}`);
    const raw = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(raw);
    this.log.info(`[longmemeval] Dataset loaded: ${data.length} questions`);
    return data;
  }

  // ── Results File ───────────────────────────────────────────────────────

  _writeResultsFile() {
    try {
      const outDir = path.dirname(this.config.graphDbPath);
      const outPath = path.join(outDir, 'longmemeval-results.json');
      const scores = this.scores || this._computeScores();
      const payload = {
        timestamp: new Date().toISOString(),
        elapsed: Date.now() - this.startTime,
        phase: this.phase,
        scores,
        stats: this._stats,
        results: this.results,
      };
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      if (this.phase === 'done') {
        this.log.info(`[longmemeval] Results written to ${outPath}`);
      }
    } catch (e) {
      this.log.warn(`[longmemeval] Failed to write results file: ${e.message}`);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  LongMemEvalRunner,
  _test: {
    questionSessionIds: _questionSessionIds,
    countUniqueQuestionSessions: _countUniqueQuestionSessions,
    filterQuestionTypes: _filterQuestionTypes,
    selectStratifiedQuestions: _selectStratifiedQuestions,
    selectFocusedQuestions: _selectFocusedQuestions,
  },
};
