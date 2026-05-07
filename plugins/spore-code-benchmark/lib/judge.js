'use strict';

const {
  changedFileCount,
  changedPathsFromStatus,
} = require('./verification');
const {
  changedFileSummary,
  classifyVerificationClaim,
  deriveSetupStatus,
} = require('./reporting');

function truncate(s, max = 12000) {
  const text = String(s || '');
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function collectVisibleText(result) {
  const parts = [];
  for (const ev of result?.transcript || []) {
    if (ev.text) parts.push(`[${ev.type}] ${ev.text}`);
    if (ev.input) parts.push(`[${ev.type}:input] ${ev.input}`);
    if (ev.message) parts.push(`[${ev.type}:message] ${ev.message}`);
  }
  for (const call of result?.toolCalls || []) {
    if (call.inputText) parts.push(`[tool:${call.name}:input] ${call.inputText}`);
    if (call.resultSummary) parts.push(`[tool:${call.name}:result] ${call.resultSummary}`);
  }
  return parts.join('\n');
}

function runIdsForResult(result) {
  const ids = new Set();
  for (const value of [result?.workDir, result?.envRoot]) {
    const match = String(value || '').match(/\/runs\/(scb-[^/]+)/);
    if (match) ids.add(match[1]);
  }
  const canary = String(result?.canary || '').match(/SCB_CANARY_(scb-[^_]+)/);
  if (canary) ids.add(canary[1]);
  return ids;
}

function scoreScenario(result) {
  const verification = Array.isArray(result?.verification?.commands) ? result.verification.commands : [];
  const verificationPassed = verification.filter(v => v.ok === true).length;
  const verificationFailed = verification.filter(v => v.ok === false || (v.exitCode != null && v.exitCode !== 0)).length;
  const infraBlocked = verification.filter(v => v.infraOk === false || (v.problems || []).some(p => p.severity === 'infra')).length;
  const semanticFailures = verification.filter(v => v.semanticOk === false || (v.problems || []).some(p => p.severity === 'semantic')).length;
  const statusText = result?.git?.status?.stdout || '';
  const changed = result?.changedFiles || changedFileSummary(statusText);
  const changedPaths = Array.isArray(changed.paths) ? changed.paths : changedPathsFromStatus(statusText);
  const filesChanged = Number.isFinite(changed.count) ? changed.count : changedFileCount(statusText);
  const setupStatus = result?.setupStatus || deriveSetupStatus(result);
  const verificationClaim = result?.verificationClaim || classifyVerificationClaim(result?.finalText || '', verification);
  const completed = !!result?.finalText && !result?.error && !result?.dryRun;
  const hadToolUse = Array.isArray(result?.toolCalls) && result.toolCalls.length > 0;
  return {
    completed,
    dryRun: !!result?.dryRun,
    setupStatus: setupStatus?.status || 'unknown',
    setupCompleted: !!setupStatus?.setupCompleted || !!result?.setupCompleted || !!result?.dryRun,
    hadToolUse,
    filesChanged,
    changedPaths,
    verificationTotal: verification.length,
    verificationPassed,
    verificationFailed,
    infraBlocked,
    semanticFailures,
    verificationClaim: verificationClaim?.classification || 'unknown',
    verificationOverclaimed: !!verificationClaim?.overclaimed,
    verificationPassRate: verification.length ? verificationPassed / verification.length : null,
    likelySuccess: completed && filesChanged > 0 && verification.length > 0 && verificationFailed === 0 && infraBlocked === 0 && semanticFailures === 0,
  };
}

function scanLeakage(results = []) {
  const hits = [];
  const ownCanaryMentions = [];
  const currentRunIds = new Set();
  for (const result of results) {
    for (const id of runIdsForResult(result)) currentRunIds.add(id);
  }
  for (const result of results) {
    const text = collectVisibleText(result);
    if (!text) continue;
    if (result.canary && text.includes(result.canary)) {
      ownCanaryMentions.push({
        scenarioId: result.scenarioId,
        sessionId: result.sessionId,
        token: result.canary,
      });
    }
    for (const other of results) {
      if (!other || other === result) continue;
      const probes = [
        { kind: 'canary', value: other.canary, severity: 'critical' },
        { kind: 'sessionId', value: other.sessionId, severity: 'high' },
        { kind: 'scenarioId', value: other.scenarioId, severity: 'medium' },
        { kind: 'taskTitle', value: other.scenario?.taskTitle, severity: 'medium' },
      ].filter(p => p.value && String(p.value).length >= 6);
      for (const probe of probes) {
        if (text.includes(String(probe.value))) {
          hits.push({
            scenarioId: result.scenarioId,
            sessionId: result.sessionId,
            foreignScenarioId: other.scenarioId,
            foreignSessionId: other.sessionId,
            kind: probe.kind,
            severity: probe.severity,
            value: String(probe.value),
          });
        }
      }
    }
    const mentionedRunIds = text.match(/scb-\d{4}-\d{2}-\d{2}T\d{4}-[a-f0-9]{8}\b/g) || [];
    for (const runId of new Set(mentionedRunIds)) {
      if (!currentRunIds.has(runId)) {
        hits.push({
          scenarioId: result.scenarioId,
          sessionId: result.sessionId,
          foreignRunId: runId,
          kind: 'foreignRunId',
          severity: 'high',
          value: runId,
        });
      }
    }
  }
  return {
    ok: hits.length === 0,
    hits,
    ownCanaryMentions,
  };
}

async function judgeWithLlm({ llmClient, model, scenario, result }) {
  if (!llmClient?.messages?.create || !model) return null;
  const score = scoreScenario(result);
  const prompt = `You are judging a coding-agent benchmark run. Return strict JSON with keys:
{
  "execution_quality": "pass|partial|fail",
  "reasoning": "short explanation",
  "implementation_risks": ["..."],
  "test_assessment": "short explanation",
  "leakage_concern": "none|possible|clear"
}

Scenario:
${JSON.stringify({
    id: scenario?.id,
    domain: scenario?.domain,
    taskTitle: scenario?.taskTitle,
    userPrompt: scenario?.userPrompt,
  }, null, 2)}

Heuristic score:
${JSON.stringify(score, null, 2)}

Final answer:
${truncate(result?.finalText || '', 5000)}

Git status:
${truncate(result?.git?.status?.stdout || result?.git?.status?.stderr || '', 3000)}

Git diff stat:
${truncate(result?.git?.diffStat?.stdout || result?.git?.diffStat?.stderr || '', 3000)}

Untracked file summary:
${truncate(JSON.stringify(result?.git?.untrackedSummary || {}, null, 2), 3000)}

Changed files:
${truncate(JSON.stringify(result?.changedFiles || {}, null, 2), 3000)}

Verification:
${truncate(JSON.stringify(result?.verification || {}, null, 2), 6000)}

Verification claim:
${truncate(JSON.stringify(result?.verificationClaim || {}, null, 2), 3000)}

Visible transcript excerpt:
${truncate(collectVisibleText(result), 10000)}`;

  const response = await llmClient.messages.create({
    model,
    max_tokens: 900,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response?.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { raw: text, parseError: 'No JSON object found' };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { raw: text, parseError: e.message };
  }
}

function compactTurnTranscript(result = {}) {
  const blocks = [];
  for (const task of result.tasks || []) {
    const turns = (task.turns || []).map(turn => ({
      turnIndex: turn.turnIndex,
      user: truncate(turn.userText || '', 2000),
      assistant: truncate(turn.assistantText || '', 3000),
      toolUsage: turn.toolUsage || {},
      iterations: turn.iterations || 0,
    }));
    blocks.push({
      taskId: task.taskId,
      userName: task.userName,
      prompt: truncate(task.prompt || task.basePrompt || '', 2000),
      score: task.score || scoreScenario(task),
      memorySettle: task.memorySettle || null,
      setupStatus: task.setupStatus || null,
      changedFiles: task.changedFiles || null,
      untrackedSummary: task.git?.untrackedSummary || null,
      verificationClaim: task.verificationClaim || null,
      responseRepair: task.responseRepair || null,
      handoffFacts: task.handoffFacts || null,
      verification: (task.verification?.commands || []).map(v => ({
        command: v.command,
        ok: v.ok,
        failureReason: v.failureReason || null,
        problems: v.problems || [],
      })),
      turns,
      finalText: truncate(task.finalText || '', 2500),
      actorDoneReason: task.actorDoneReason || null,
    });
  }
  return blocks;
}

function extractJsonObjectText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

function parseJsonObjectText(text) {
  const jsonText = extractJsonObjectText(text);
  if (!jsonText) return { value: null, error: 'No JSON object found' };
  try {
    return { value: JSON.parse(jsonText), error: null };
  } catch (e) {
    return { value: null, error: e.message, jsonText };
  }
}

async function repairExperienceSummaryJson({ llmClient, model, raw, parseError }) {
  if (!llmClient?.messages?.create || !model) return null;
  const repairPrompt = `Repair this malformed benchmark experience summary into valid strict JSON only.

Use exactly these top-level keys:
overall, outcome, what_went_well, agent_failure_modes, memory_and_handoff, tooling_and_execution, improvement_points, notable_quotes_or_moments, confidence.

Rules:
- Return JSON only. No markdown.
- Preserve the meaning of the original content.
- If the original was truncated, produce a complete compact summary from the available evidence.
- outcome must be one of strong, mixed, weak, blocked.
- confidence must be one of low, medium, high.

Parse error:
${parseError || 'unknown'}

Malformed/raw summary:
${truncate(raw || '', 14000)}`;

  const response = await llmClient.messages.create({
    model,
    max_tokens: 2600,
    temperature: 0,
    messages: [{ role: 'user', content: repairPrompt }],
  });
  const repairedRaw = response?.content?.[0]?.text || '';
  const parsed = parseJsonObjectText(repairedRaw);
  if (!parsed.value) {
    return {
      raw: truncate(raw || '', 6000),
      repairRaw: truncate(repairedRaw, 6000),
      parseError,
      repairParseError: parsed.error,
    };
  }
  return {
    ...parsed.value,
    repairedFromParseError: true,
    originalParseError: parseError || null,
  };
}

async function summarizeExperienceWithLlm({ llmClient, model, scenario, result }) {
  if (!llmClient?.messages?.create || !model) return null;
  const score = scoreScenario(result);
  const taskTranscript = compactTurnTranscript(result);
  const prompt = `You are a benchmark analyst reviewing how a coding agent performed across every task for ONE repository.

Return strict JSON only with this schema:
{
  "overall": "short distilled summary of the repo experience",
  "outcome": "strong|mixed|weak|blocked",
  "what_went_well": ["specific observations"],
  "agent_failure_modes": ["specific issues observed in the transcripts"],
  "memory_and_handoff": "did later users/tasks benefit from earlier project context and memory?",
  "tooling_and_execution": "how well did the agent use tools, local setup, and verification?",
  "improvement_points": [
    { "area": "routing|memory|planning|tooling|verification|ux|benchmark", "problem": "...", "recommendation": "...", "severity": "low|medium|high" }
  ],
  "notable_quotes_or_moments": ["short paraphrases, not long transcript quotes"],
  "confidence": "low|medium|high"
}

Focus on product improvements for Spore Code, not on judging the repo maintainers. Be concrete and evidence-based. If the transcript shows confusion, leakage, missing setup, premature success claims, poor handoff, weak verification, or memory not being ready for the next task, call that out.

Repository:
${JSON.stringify({
    id: scenario?.id,
    domain: scenario?.domain,
    taskTitle: scenario?.taskTitle,
    tags: scenario?.tags || [],
  }, null, 2)}

Scenario score:
${JSON.stringify(score, null, 2)}

Git status:
${truncate(result?.git?.status?.stdout || result?.git?.status?.stderr || '', 3000)}

Git diff stat:
${truncate(result?.git?.diffStat?.stdout || result?.git?.diffStat?.stderr || '', 3000)}

Untracked file summary:
${truncate(JSON.stringify(result?.git?.untrackedSummary || {}, null, 2), 3000)}

Changed files:
${truncate(JSON.stringify(result?.changedFiles || {}, null, 2), 3000)}

All task transcripts and outcomes:
${truncate(JSON.stringify(taskTranscript, null, 2), 32000)}

Repo-level verification:
${truncate(JSON.stringify(result?.verification || {}, null, 2), 6000)}`;

  const response = await llmClient.messages.create({
    model,
    max_tokens: 2600,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response?.content?.[0]?.text || '';
  const parsed = parseJsonObjectText(text);
  if (parsed.value) return parsed.value;
  const repaired = await repairExperienceSummaryJson({ llmClient, model, raw: text, parseError: parsed.error });
  return repaired || { raw: text, parseError: parsed.error };
}

module.exports = {
  collectVisibleText,
  compactTurnTranscript,
  scoreScenario,
  scanLeakage,
  judgeWithLlm,
  summarizeExperienceWithLlm,
  _test: {
    changedFileCount,
    extractJsonObjectText,
    parseJsonObjectText,
    repairExperienceSummaryJson,
    truncate,
  },
};
