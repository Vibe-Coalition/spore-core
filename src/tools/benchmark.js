/**
 * benchmark.js — Token-reduction benchmark.
 *
 * Operator/debug tool — measures whether the graph-driven system prompt
 * actually saves tokens vs. a naïve "concat all matching attributes +
 * episodes" baseline. Surfaced via GET /api/benchmark/run (admin-gated).
 *
 * Methodology, per question:
 *   • naive_tokens — top-50 attributes whose content matches any query
 *     term, plus top-20 episodes by recency that match. Concatenated and
 *     measured at chars/4.
 *   • prompt_tokens — full graph.buildSystemPromptAsync(opts) for the
 *     same question (mode='full', the heaviest path). Token-budgeted
 *     by section the way every real turn is.
 *   • ratio — naive_tokens / prompt_tokens. >1 means the graph saves
 *     tokens; <1 means the baseline is somehow tighter (rare; usually
 *     means an empty graph).
 *
 * The default question set lives in tools/benchmark-questions.json.
 * Operators can append additional questions per-call.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const _CHARS_PER_TOKEN = 4;

function _estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.floor(String(text).length / _CHARS_PER_TOKEN));
}

function _splitTerms(question) {
  return question
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]{}]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function _loadDefaultQuestions() {
  try {
    const p = path.join(__dirname, 'benchmark-questions.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data.questions) ? data.questions : [];
  } catch (e) {
    return [];
  }
}

/**
 * Compute the naive baseline for a question: top-50 attributes whose
 * `content` matches any term + top-20 episodes by recency that match.
 */
function _naiveContext(db, question) {
  const terms = _splitTerms(question);
  if (terms.length === 0) return '';

  const lines = [];

  // Attributes
  try {
    const likeClauses = terms.map(() => 'a.content LIKE ?').join(' OR ');
    const params = terms.map(t => `%${t}%`);
    const attrs = db.prepare(`
      SELECT a.content, n.label, asp.name AS aspect
      FROM attributes a
      JOIN aspects asp ON asp.id = a.aspect_id
      JOIN nodes n ON n.id = asp.node_id
      WHERE ${likeClauses}
      ORDER BY a.importance DESC, a.id DESC
      LIMIT 50
    `).all(...params);
    for (const r of attrs) {
      lines.push(`[${r.label}::${r.aspect}] ${r.content}`);
    }
  } catch (e) { /* swallow — table missing or schema mismatch */ }

  // Episodes
  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'").get();
    if (tableExists) {
      const likeClauses = terms.map(() => 'e.content LIKE ?').join(' OR ');
      const params = terms.map(t => `%${t}%`);
      const eps = db.prepare(`
        SELECT e.content, e.observed_at
        FROM episodes e
        WHERE ${likeClauses}
        ORDER BY e.observed_at DESC
        LIMIT 20
      `).all(...params);
      for (const r of eps) {
        lines.push(`[episode:${r.observed_at || ''}] ${r.content}`);
      }
    }
  } catch (e) { /* swallow */ }

  return lines.join('\n\n');
}

/**
 * Run the benchmark.
 *
 * @param {object} graph — GraphContext instance (graph.db + graph.buildSystemPromptAsync)
 * @param {object} log
 * @param {object} [opts]
 * @param {string[]} [opts.extraQuestions] — operator-supplied additions to the default set
 * @param {string}   [opts.userId]         — optional userId to scope the prompt
 * @param {string}   [opts.userName]       — optional userName for the person section
 * @returns {Promise<object>} report
 */
async function runBenchmark(graph, log, opts = {}) {
  if (!graph || !graph.db) {
    return { error: 'graph context unavailable' };
  }
  const startedAt = Date.now();

  const questions = [..._loadDefaultQuestions(), ...(opts.extraQuestions || [])].filter(Boolean);
  if (questions.length === 0) {
    return { error: 'no benchmark questions available — provide opts.extraQuestions or restore tools/benchmark-questions.json' };
  }

  const perQuestion = [];
  let naiveTotal = 0;
  let promptTotal = 0;
  let ran = 0;

  for (const q of questions) {
    let naive = 0;
    let prompted = 0;
    try {
      const naiveText = _naiveContext(graph.db, q);
      naive = _estimateTokens(naiveText);

      const promptText = await graph.buildSystemPromptAsync({
        messageContent: q,
        userId: opts.userId,
        userName: opts.userName,
        // 'full' is the canonical heaviest mode (matches what live turns use)
        mode: 'full',
      });
      prompted = _estimateTokens(promptText || '');
      ran++;
    } catch (e) {
      log?.warn?.(`[benchmark] question failed: ${q.slice(0, 40)} — ${e.message}`);
    }
    if (naive === 0 && prompted === 0) continue;
    naiveTotal += naive;
    promptTotal += prompted;
    perQuestion.push({
      question: q,
      naive_tokens: naive,
      prompt_tokens: prompted,
      ratio: prompted > 0 ? Number((naive / prompted).toFixed(2)) : null,
    });
  }

  const avgNaive = ran > 0 ? Math.round(naiveTotal / ran) : 0;
  const avgPrompt = ran > 0 ? Math.round(promptTotal / ran) : 0;

  return {
    ran,
    total_questions: questions.length,
    avg_naive_tokens: avgNaive,
    avg_prompt_tokens: avgPrompt,
    avg_ratio: avgPrompt > 0 ? Number((avgNaive / avgPrompt).toFixed(2)) : null,
    per_question: perQuestion,
    elapsed_ms: Date.now() - startedAt,
    notes: avgPrompt > 0 && avgNaive > avgPrompt
      ? `Graph saves ~${avgNaive - avgPrompt} tokens per question on average.`
      : avgPrompt > 0
        ? 'Graph prompt is comparable to or larger than the naïve baseline — likely a small/empty graph.'
        : 'No measurable signal — the prompt builder returned empty for all questions.',
  };
}

module.exports = { runBenchmark, _estimateTokens };
