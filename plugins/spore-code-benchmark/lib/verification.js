'use strict';

const ARTIFACT_DIRS = new Set([
  '.cache',
  '.local',
  '.mypy_cache',
  '.npm',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.uv-cache',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'target',
  'venv',
]);

function normalizeVerificationSpec(spec) {
  if (typeof spec === 'string') return { command: spec, kind: inferCommandKind(spec) };
  if (!spec || typeof spec !== 'object') return { command: String(spec || ''), kind: 'unknown' };
  return {
    ...spec,
    command: String(spec.command || ''),
    kind: spec.kind || inferCommandKind(spec.command || ''),
  };
}

function inferCommandKind(command) {
  const s = String(command || '');
  if (commandLooksLikeTest(s)) return 'test';
  if (/\bgit\s+diff\s+--check\b/.test(s)
    || /\buntracked\s+whitespace\s+check\b/i.test(s)
    || /\bgofmt\b/i.test(s)
    || /\bgo\s+fmt\b/i.test(s)) return 'lint';
  return 'command';
}

function commandLooksLikeTest(command) {
  const s = String(command || '');
  if (/\b(?:npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test)|yarn\s+test|go\s+test|cargo\s+test|node\s+--test|python3?\s+-m\s+pytest)\b/i.test(s)) {
    return true;
  }
  return s
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .some(part => {
      const segment = String(part || '').trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*/, '');
      return /^(?:python3?|python)\s+-m\s+pytest\b/i.test(segment)
        || /^(?:npx\s+)?(?:pytest|vitest|jest|mocha)\b/i.test(segment);
    });
}

function combinedOutput(result = {}) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function detectZeroTests(text) {
  const s = String(text || '');
  const patterns = [
    /\b0\s+passing\b/i,
    /\b0\s+tests?\s+(?:run|ran|passed|found|collected)\b/i,
    /\bcollected\s+0\s+items?\b/i,
    /\bno\s+tests?\s+(?:found|to\s+run|ran)\b/i,
    /\bRan\s+0\s+tests?\b/,
  ];
  return patterns.some(re => re.test(s));
}

function detectTestFailureOutput(text) {
  const s = String(text || '');
  const patterns = [
    /(?:^|[^\d])([1-9]\d*)\s+(?:failed|failing|failures?)\b/i,
    /^FAILED\b/m,
    /\bFAILED\s+\[/,
    /^=+\s+FAILURES\s+=+$/m,
    /^--- FAIL:/m,
    /^FAIL\b/m,
    /\bno\s+tests?\s+ran\b/i,
    /\bERROR:\s+not\s+found\b/i,
  ];
  return patterns.some(re => re.test(s));
}

function detectMissingToolchain(result = {}) {
  const text = combinedOutput(result);
  if (result.exitCode === 127) return true;
  return /(?:command not found|No such file or directory|not found:|executable file not found)/i.test(text);
}

function evaluateCommandResult(commandOrSpec, result = {}) {
  const spec = normalizeVerificationSpec(commandOrSpec);
  const output = combinedOutput(result);
  const problems = Array.isArray(result.problems) ? [...result.problems] : [];

  if (result.timedOut && !problems.some(p => p.kind === 'timeout')) {
    problems.push({ kind: 'timeout', severity: 'infra', detail: 'Command timed out' });
  }
  if (detectMissingToolchain(result) && !problems.some(p => p.kind === 'missing_toolchain')) {
    problems.push({
      kind: 'missing_toolchain',
      severity: 'infra',
      detail: 'Required command or runtime was not available',
    });
  }
  if ((spec.kind === 'test' || commandLooksLikeTest(spec.command)) && !spec.allowZeroTests && detectZeroTests(output)) {
    if (!problems.some(p => p.kind === 'zero_tests')) {
      problems.push({
        kind: 'zero_tests',
        severity: 'semantic',
        detail: 'Test command exited without running any tests',
      });
    }
  }
  if ((spec.kind === 'test' || commandLooksLikeTest(spec.command)) && detectTestFailureOutput(output)) {
    if (!problems.some(p => p.kind === 'test_failure_output' || p.kind === 'zero_tests')) {
      problems.push({
        kind: 'test_failure_output',
        severity: 'semantic',
        detail: 'Test command output contains failure markers',
      });
    }
  }

  const exitOk = result.ok === true || result.exitCode === 0;
  const semanticOk = !problems.some(p => p.severity === 'semantic');
  const infraOk = !problems.some(p => p.severity === 'infra');
  const ok = exitOk && semanticOk && infraOk;
  const failureReason = ok
    ? null
    : problems[0]?.kind || (result.exitCode != null && result.exitCode !== 0 ? 'exit_nonzero' : 'verification_failed');

  return {
    ...result,
    command: spec.command || result.command,
    kind: spec.kind,
    ok,
    exitOk,
    semanticOk,
    infraOk,
    problems,
    failureReason,
  };
}

function statusLinePath(line) {
  const raw = String(line || '');
  if (!raw.trim() || raw.startsWith('##')) return null;
  let body = raw.length >= 3 ? raw.slice(3).trim() : raw.trim();
  if (!body) return null;
  if (body.includes(' -> ')) body = body.split(' -> ').pop().trim();
  return body.replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isArtifactPath(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/g, '');
  if (!p) return false;
  const first = p.split('/')[0];
  return ARTIFACT_DIRS.has(first);
}

function changedPathsFromStatus(statusText) {
  return String(statusText || '')
    .split(/\r?\n/)
    .map(statusLinePath)
    .filter(Boolean)
    .filter(p => !isArtifactPath(p));
}

function changedFileCount(statusText) {
  return changedPathsFromStatus(statusText).length;
}

module.exports = {
  ARTIFACT_DIRS,
  changedFileCount,
  changedPathsFromStatus,
  commandLooksLikeTest,
  detectMissingToolchain,
  detectTestFailureOutput,
  detectZeroTests,
  evaluateCommandResult,
  inferCommandKind,
  isArtifactPath,
  normalizeVerificationSpec,
};
