'use strict';

const {
  commandLooksLikeTest,
  isArtifactPath,
} = require('./verification');

function compactText(text, max = 800) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

function parseStatusLine(line) {
  const raw = String(line || '');
  if (!raw.trim() || raw.startsWith('##')) return null;
  const status = raw.slice(0, 2);
  let body = raw.length >= 3 ? raw.slice(3).trim() : raw.trim();
  if (!body) return null;
  if (body.includes(' -> ')) body = body.split(' -> ').pop().trim();
  const path = body.replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!path || isArtifactPath(path)) return null;
  return {
    path,
    status: status.trim() || raw.trim().split(/\s+/)[0] || '',
    tracked: status !== '??',
  };
}

function changedFileSummary(gitStatus = {}) {
  const stdout = typeof gitStatus === 'string' ? gitStatus : (gitStatus.stdout || '');
  const entries = String(stdout || '')
    .split(/\r?\n/)
    .map(parseStatusLine)
    .filter(Boolean);
  return {
    count: entries.length,
    paths: entries.map(e => e.path),
    tracked: entries.filter(e => e.tracked).map(e => e.path),
    untracked: entries.filter(e => !e.tracked).map(e => e.path),
    entries,
  };
}

function commandHasFocusedSelector(command) {
  const s = String(command || '');
  return /(?:^|[\s;|&])--grep(?:[=\s]|$)/i.test(s)
    || /(?:^|[\s;|&])-k\s+\S+/i.test(s)
    || /\bpytest\b[^\n;&|]*\s+tests?\/[^\s;&|]+/i.test(s)
    || /\bpython3?\s+-m\s+pytest\b[^\n;&|]*\s+tests?\/[^\s;&|]+/i.test(s)
    || /\bmocha\b[^\n;&|]*\s+test\/[^\s;&|]+/i.test(s)
    || /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+test)\b[^\n;&|]*(?:--\s+)?--grep(?:[=\s]|$)/i.test(s);
}

function commandScope(command) {
  const s = String(command || '');
  if (!commandLooksLikeTest(s)) {
    if (/\bgit\s+diff\s+--check\b/.test(s) || /\b(?:eslint|ruff|flake8|prettier|tsc)\b/i.test(s)) return 'lint';
    if (/\bpy_compile\b/.test(s) || /\bnode\s+--check\b/.test(s)) return 'static';
    return 'command';
  }
  if (commandHasFocusedSelector(s)) return 'focused-test';
  if (/\b(?:npm\s+test|pnpm\s+test|yarn\s+test|go\s+test\s+\.\/\.\.\.|cargo\s+test|python3?\s+-m\s+pytest(?:\s+(-q|--quiet))?\s*$|pytest(?:\s+(-q|--quiet))?\s*$|node\s+--test(?:\s+test|\s+tests)?\s*$)/i.test(s)) return 'full-test';
  return 'focused-test';
}

function verificationEvidence(commands = []) {
  const list = Array.isArray(commands) ? commands : [];
  const ok = list.filter(c => c && c.ok === true);
  const scopes = ok.map(c => commandScope(c.command));
  const failed = list.filter(c => c && c.ok === false);
  return {
    total: list.length,
    passed: ok.length,
    failed: failed.length,
    hasFullTest: scopes.includes('full-test'),
    hasFocusedTest: scopes.includes('focused-test'),
    hasLint: scopes.includes('lint'),
    hasStatic: scopes.includes('static'),
    scopes,
    commands: list.map(c => ({
      command: c.command,
      ok: !!c.ok,
      scope: commandScope(c.command),
      failureReason: c.failureReason || null,
    })),
  };
}

function classifyVerificationClaim(finalText, commands = []) {
  const text = String(finalText || '').toLowerCase();
  const evidence = verificationEvidence(commands);
  const claimsAll = /\b(all|full|entire)\b.{0,40}\b(test|suite|checks?)\b.{0,40}\b(pass|passed|green|passing)\b|\b(all|full|entire)\b.{0,40}\b(pass|passed|green|passing)\b/i.test(text);
  const claimsFocused = /\b(focused|targeted|specific|request[-\s]?id|smoke)\b.{0,50}\b(test|check|verification|passed|passing)\b/i.test(text);
  const claimsLint = /\b(diff --check|lint|typecheck|py_compile|static)\b.{0,50}\b(pass|passed|clean|ok)\b/i.test(text);

  let classification = 'unknown';
  let overclaimed = false;
  let note = null;
  if (claimsAll) {
    if (evidence.hasFullTest && evidence.failed === 0) classification = 'full';
    else {
      classification = 'overclaimed';
      overclaimed = true;
      note = evidence.hasFocusedTest
        ? 'Assistant claimed full-suite verification, but benchmark evidence only shows focused tests/checks.'
        : 'Assistant claimed full-suite verification without full-suite command evidence.';
    }
  } else if (claimsFocused || evidence.hasFocusedTest) {
    classification = 'focused';
  } else if (claimsLint || evidence.hasLint || evidence.hasStatic) {
    classification = 'lint-only';
  }

  return {
    classification,
    overclaimed,
    note,
    evidence,
  };
}

function deriveSetupStatus(result = {}) {
  if (result.dryRun) return { status: 'not_required', setupCompleted: true, reason: 'dry_run' };
  if (result.setupStatus?.status) return result.setupStatus;
  const commands = Array.isArray(result.verification?.commands) ? result.verification.commands : [];
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const passed = commands.filter(c => c && c.ok === true);
  const failed = commands.filter(c => c && c.ok === false);
  const allVerificationPassed = commands.length > 0 && passed.length === commands.length;
  const text = [
    result.error || '',
    ...commands.flatMap(c => [c.stderr || '', c.stdout || '', c.error || '', ...(c.problems || []).map(p => p.kind || p.detail || '')]),
    ...toolCalls.flatMap(c => [c.inputText || '', c.resultSummary || '']),
  ].join('\n');

  const sawSetupFriction = /missing_toolchain|command not found|No such file or directory|not found:|blocked by benchmark sandbox policy/i.test(text);
  const sawHardPolicyBlock = /heavyweight Python package|blocked by benchmark sandbox policy/i.test(text);
  const sawLocalSetup = /\b(?:pip|npm|pnpm|yarn|go|cargo|uv)\b.{0,80}\b(?:install|download|mod download|add)\b|\bpython3?\s+-m\s+venv\b|\bSPORE_BENCHMARK_CACHE\b|\btoolchains\/go\b/i.test(text);

  if (allVerificationPassed && sawSetupFriction) {
    return { status: 'recovered', setupCompleted: true, reason: 'verification_passed_after_setup_friction' };
  }
  if (sawHardPolicyBlock && !passed.length) {
    return { status: 'blocked', setupCompleted: false, reason: 'toolchain_or_policy_block' };
  }
  if (sawSetupFriction && !passed.length) {
    return { status: 'blocked', setupCompleted: false, reason: 'toolchain_or_policy_block' };
  }
  if (sawLocalSetup) {
    const ok = commands.length === 0 || passed.length > 0;
    return { status: ok ? 'completed' : 'unknown', setupCompleted: ok, reason: 'local_setup_command_seen' };
  }
  if (passed.length > 0) {
    return { status: 'already_available', setupCompleted: true, reason: 'verification_passed_without_setup' };
  }
  if (failed.length > 0) return { status: 'unknown', setupCompleted: false, reason: failed[0].failureReason || 'verification_failed' };
  return { status: 'unknown', setupCompleted: false, reason: 'no_setup_signal' };
}

function extractTestCount(text) {
  const s = String(text || '');
  const m = s.match(/\b(\d+)\s+(?:passing|passed|tests?\s+(?:passed|run|ran))\b/i);
  return m ? Number(m[1]) : null;
}

function buildHandoffFacts(task = {}) {
  const changed = task.changedFiles || changedFileSummary(task.git?.status || '');
  const verification = verificationEvidence(task.verification?.commands || []);
  const testCounts = (task.verification?.commands || [])
    .map(c => extractTestCount(`${c.stdout || ''}\n${c.stderr || ''}`))
    .filter(n => Number.isFinite(n));
  return {
    taskId: task.taskId || null,
    userName: task.userName || null,
    changedFiles: changed.paths || [],
    verification: {
      passed: verification.passed,
      total: verification.total,
      scopes: verification.scopes,
      commands: verification.commands.map(c => c.command).filter(Boolean),
      observedTestCounts: testCounts,
    },
    verificationClaim: task.verificationClaim || null,
    responseRepair: task.responseRepair || null,
    setupStatus: task.setupStatus || null,
    finalSummary: compactText(task.finalText || task.turns?.at?.(-1)?.assistantText || '', 900),
    openIssues: [
      ...(task.error ? [task.error] : []),
      ...((task.verification?.commands || []).filter(c => c.ok === false).map(c => c.failureReason || 'verification_failed')),
      ...(task.verificationClaim?.overclaimed ? ['verification_claim_overstated'] : []),
    ].filter(Boolean),
  };
}

module.exports = {
  buildHandoffFacts,
  changedFileSummary,
  classifyVerificationClaim,
  commandScope,
  deriveSetupStatus,
  verificationEvidence,
  _test: {
    commandHasFocusedSelector,
    compactText,
    extractTestCount,
    parseStatusLine,
  },
};
