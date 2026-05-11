'use strict';

const {
  commandLooksLikeTest,
  isArtifactPath,
} = require('./verification');

function compactText(text, max = 800) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
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
    || /\bgo\s+test\b[^\n;&|]*\s+-run\s+\S+/i.test(s)
    || /\bmocha\b[^\n;&|]*\s+test\/[^\s;&|]+/i.test(s)
    || /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+test)\b[^\n;&|]*(?:--\s+)?--grep(?:[=\s]|$)/i.test(s);
}

function commandLooksPytestFullSuite(command) {
  const s = String(command || '').replace(/\s+/g, ' ').trim();
  if (!/\b(?:pytest|python3?\s+-m\s+pytest)\b/i.test(s)) return false;
  if (/(?:^|\s)(?:-k|--lf|--last-failed|--failed-first|--ff|--sw|--stepwise|--testmon)(?:\s|=|$)/i.test(s)) return false;
  if (/::/.test(s)) return false;
  if (/\btests?\/[^/\s;&|]+\.py\b/i.test(s)) return false;
  if (/\btests?\/[^\s;&|]*\*/i.test(s)) return false;
  if (/\b(?:pytest|python3?\s+-m\s+pytest)(?:\s+(?:-[A-Za-z][^\s;&|]*|--[A-Za-z0-9_-]+(?:=\S+)?|tests?\/?))*\s*(?:2>&1)?\s*(?:\|\s*(?:tail|head)\b[^\n;&|]*)?$/i.test(s)) return true;
  return false;
}

function combinedCommandOutput(command = {}) {
  return [
    command.stdout,
    command.stderr,
    command.output,
    command.resultSummary,
    command.error,
  ].filter(v => v != null).join('\n');
}

function commandScope(command) {
  const s = String(command || '');
  if (!commandLooksLikeTest(s)) {
    if (/\bgit\s+diff\s+--check\b/.test(s)
      || /\buntracked\s+whitespace\s+check\b/i.test(s)
      || /\bgofmt\b/i.test(s)
      || /\bgo\s+fmt\b/i.test(s)
      || /\b(?:eslint|ruff|flake8|prettier|tsc)\b/i.test(s)) return 'lint';
    if (/\bpy_compile\b/.test(s) || /\bnode\s+--check\b/.test(s)) return 'static';
    return 'command';
  }
  if (commandHasFocusedSelector(s)) return 'focused-test';
  if (commandLooksPytestFullSuite(s)) return 'full-test';
  if (/\b(?:npm\s+test|pnpm\s+test|yarn\s+test|go\s+test\s+\.\/\.\.\.|cargo\s+test|python3?\s+-m\s+pytest(?:\s+(-q|--quiet))?\s*$|pytest(?:\s+(-q|--quiet))?\s*$|node\s+--test(?:\s+test|\s+tests)?\s*$)/i.test(s)) return 'full-test';
  return 'focused-test';
}

function extractTestCounts(text) {
  const out = [];
  const re = /\b(\d{1,6})\s+(?:passing|passed|tests?\s+(?:passed|passing|run|ran))\b/ig;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return [...new Set(out)];
}

function verificationEvidence(commands = []) {
  const list = Array.isArray(commands) ? commands : [];
  const ok = list.filter(c => c && c.ok === true);
  const scopes = ok.map(c => commandScope(c.command));
  const failed = list.filter(c => c && c.ok === false);
  const observedTestCounts = [...new Set(list.flatMap(c => extractTestCounts(combinedCommandOutput(c))))];
  return {
    total: list.length,
    passed: ok.length,
    failed: failed.length,
    hasFullTest: scopes.includes('full-test'),
    hasFocusedTest: scopes.includes('focused-test'),
    hasLint: scopes.includes('lint'),
    hasStatic: scopes.includes('static'),
    observedTestCounts,
    scopes,
    commands: list.map(c => ({
      command: c.command,
      ok: !!c.ok,
      scope: commandScope(c.command),
      failureReason: c.failureReason || null,
    })),
  };
}

function toolCallToVerificationCommand(call = {}) {
  const name = String(call.name || call.tool || '').trim();
  if (!['exec', 'run_tests', 'bg_tail'].includes(name)) return null;
  const input = safeJsonParse(call.input, null) || safeJsonParse(call.inputText, null) || {};
  const result = safeJsonParse(call.result, null) || safeJsonParse(call.resultSummary, null) || {};
  const command = String(
    result.command
    || input.command
    || input.cmd
    || input.path
    || ''
  ).trim();
  if (!commandLooksLikeTest(command) && !/\bgit\s+diff\s+--check\b|\bnode\s+--check\b|\buntracked\s+whitespace\s+check\b/i.test(command)) {
    return null;
  }
  const exitCode = result.exitCode ?? result.exit_code;
  const ok = result.ok === true || (Number.isFinite(Number(exitCode)) && Number(exitCode) === 0);
  return {
    source: 'tool_call',
    tool: name,
    command,
    ok,
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : undefined,
    stdout: result.stdout || result.output || '',
    stderr: result.stderr || result.error || '',
    resultSummary: typeof call.resultSummary === 'string' ? call.resultSummary : '',
    failureReason: result.failureReason || result.error || null,
  };
}

function verificationCommandsFromToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map(toolCallToVerificationCommand)
    .filter(Boolean);
}

function combinedVerificationCommands(commands = [], opts = {}) {
  return [
    ...(Array.isArray(commands) ? commands.map(c => ({ ...c, source: c.source || 'benchmark' })) : []),
    ...verificationCommandsFromToolCalls(opts.toolCalls || []),
  ];
}

function focusedClaimQualifier(text = '') {
  return /\b(focused|targeted|specific|named|filtered|matching|selected|subset|grep|request[-\s]?id|req\.?id|single\s+file|test\s+file|file[-\s]?level|smoke|suggest(?:ion)?|hidden|filter\s+runs?)\b/i.test(text);
}

function numberedAllTestClaims(finalText = '') {
  const text = String(finalText || '');
  const out = [];
  const re = /\ball\s+\d{1,6}\s+(?:(?:focused|targeted|specific|named|filtered|request[-\s]?id|req\.?id|smoke)\s+)?(?:tests?\s+)?(?:pass|passed|passing)\b/ig;
  let m;
  while ((m = re.exec(text))) {
    const phrase = m[0];
    out.push({
      phrase,
      focused: focusedClaimQualifier(phrase),
    });
  }
  return out;
}

function finalClaimedTestCounts(finalText = '') {
  const out = extractTestCounts(finalText);
  const re = /\ball\s+(\d{1,6})\s+(?:tests?\s+)?(?:pass|passed|passing)\b/ig;
  let m;
  while ((m = re.exec(String(finalText || '')))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return [...new Set(out)];
}

function hasUnqualifiedBroadAllClaim(finalText = '') {
  const text = String(finalText || '');
  const patterns = [
    /\b(?:all|full|entire)\b.{0,40}\b(?:test|suite|checks?)\b.{0,40}\b(?:pass|passed|green|passing)\b/ig,
    /\b(?:all|full|entire)\b.{0,40}\b(?:pass|passed|green|passing)\b/ig,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const phrase = m[0];
      if (!focusedClaimQualifier(phrase)) return true;
    }
  }
  return false;
}

function auditVerificationClaim(finalText, commands = [], opts = {}) {
  const text = String(finalText || '');
  const combined = combinedVerificationCommands(commands, opts);
  const evidence = verificationEvidence(combined);
  const numberedClaims = numberedAllTestClaims(text);
  const claimsAll = hasUnqualifiedBroadAllClaim(text)
    || numberedClaims.some(c => !c.focused);
  const claimsFocused = /\b(focused|targeted|specific|request[-\s]?id|smoke)\b.{0,50}\b(test|check|verification|passed|passing)\b/i.test(text);
  const claimsLint = /\b(diff --check|lint|typecheck|py_compile|static)\b.{0,50}\b(pass|passed|clean|ok)\b/i.test(text);
  const claimedTestCounts = finalClaimedTestCounts(text);
  const unsupportedTestCounts = claimedTestCounts.filter(n => !evidence.observedTestCounts.includes(n));

  let classification = 'unknown';
  let overclaimed = false;
  let note = null;
  if (claimsAll) {
    if (evidence.hasFullTest) classification = 'full';
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
  if (!overclaimed && unsupportedTestCounts.length && evidence.observedTestCounts.length) {
    classification = 'overclaimed';
    overclaimed = true;
    note = `Assistant claimed unsupported test count(s): ${unsupportedTestCounts.join(', ')}.`;
  }

  return {
    classification,
    overclaimed,
    note,
    evidence,
    fullSuiteClaim: !!claimsAll,
    focusedClaim: !!claimsFocused,
    lintClaim: !!claimsLint,
    numberedAllClaims: numberedClaims,
    claimedTestCounts,
    observedTestCounts: evidence.observedTestCounts,
    unsupportedTestCounts,
    sourceBreakdown: {
      benchmarkCommands: Array.isArray(commands) ? commands.length : 0,
      toolCommands: verificationCommandsFromToolCalls(opts.toolCalls || []).length,
    },
  };
}

function classifyVerificationClaim(finalText, commands = [], opts = {}) {
  return auditVerificationClaim(finalText, commands, opts);
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
  return extractTestCounts(text)[0] ?? null;
}

function buildHandoffFacts(task = {}) {
  const changed = task.changedFiles || changedFileSummary(task.git?.status || '');
  const claimAudit = task.verificationClaim || classifyVerificationClaim(task.finalText || '', task.verification?.commands || [], { toolCalls: task.toolCalls || [] });
  const verification = claimAudit.evidence || verificationEvidence(task.verification?.commands || []);
  return {
    taskId: task.taskId || null,
    userName: task.userName || null,
    changedFiles: changed.paths || [],
    verification: {
      passed: verification.passed,
      total: verification.total,
      scopes: verification.scopes,
      commands: verification.commands.map(c => c.command).filter(Boolean),
      observedTestCounts: verification.observedTestCounts || [],
    },
    verificationClaim: claimAudit || null,
    responseRepair: task.responseRepair || null,
    setupStatus: task.setupStatus || null,
    finalSummary: compactText(task.finalText || task.turns?.at?.(-1)?.assistantText || '', 900),
    openIssues: [
      ...(task.error ? [task.error] : []),
      ...((task.verification?.commands || []).filter(c => c.ok === false).map(c => c.failureReason || 'verification_failed')),
      ...(claimAudit?.overclaimed ? ['verification_claim_overstated'] : []),
    ].filter(Boolean),
  };
}

module.exports = {
  buildHandoffFacts,
  changedFileSummary,
  classifyVerificationClaim,
  commandScope,
  auditVerificationClaim,
  deriveSetupStatus,
  extractTestCounts,
  verificationEvidence,
  verificationCommandsFromToolCalls,
  _test: {
    commandHasFocusedSelector,
    commandLooksPytestFullSuite,
    compactText,
    extractTestCount,
    extractTestCounts,
    focusedClaimQualifier,
    hasUnqualifiedBroadAllClaim,
    numberedAllTestClaims,
    parseStatusLine,
  },
};
