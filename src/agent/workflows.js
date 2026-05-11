'use strict';

const crypto = require('crypto');

const SPORE_CODE_PHASES = new Set([
  'intake', 'research', 'plan', 'execute', 'debug', 'verify', 'review', 'complete', 'blocked',
]);

const GUIDED_POLICY = 'guided';

const MUTATING_TOOLS = new Set([
  'graph_update', 'graph_delete',
  'web_serve', 'exec', 'remote_exec',
  'write_file', 'edit_file', 'remote_write_file',
  'patch_file', 'run_tests', 'bg_kill',
  'email_send', 'message_send', 'message_edit', 'message_react',
  'notify_user', 'env_manage', 'save_tool',
]);

const FILE_MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'remote_write_file', 'patch_file',
]);

const FAILURE_TOOLS = new Set([
  'exec', 'run_tests', 'patch_file', 'web_serve', 'bg_tail', 'bg_kill',
]);

const RECOVERY_STATUS_TOOLS = new Set(['git_status', 'git_diff']);
const RECOVERY_WRITE_FILE_CHAR_LIMIT = 2400;

function nowMs() {
  return Date.now();
}

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stringify(value) {
  return JSON.stringify(value == null ? null : value);
}

function hash(value, len = 10) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

function commandKey(command) {
  return String(command || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeToolName(name) {
  return name === 'graph' ? 'graph_update' : name === 'analyze' ? 'analyze_media' : String(name || '');
}

function hasOwn(input, key) {
  return !!input && Object.prototype.hasOwnProperty.call(input, key);
}

function firstToolString(input, keys, opts = {}) {
  const allowEmpty = opts.allowEmpty === true;
  for (const key of keys) {
    if (!hasOwn(input, key) || input[key] == null) continue;
    const value = String(input[key]);
    if (allowEmpty || value.length > 0) return value;
  }
  return null;
}

function extractSection(text, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = re.exec(text || '');
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = String(text || '').slice(start);
  const next = /^\s*##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function cleanPlanLine(line) {
  return String(line || '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+\[parallel:\s*[^\]]+\]\s*$/i, '')
    .replace(/\*\*/g, '')
    .trim();
}

function cleanPlanBlock(lines) {
  return String(lines || '')
    .split('\n')
    .map((line, idx) => {
      if (idx === 0) return cleanPlanLine(line);
      return String(line || '')
        .replace(/^\s*[-*]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim();
    })
    .filter(Boolean)
    .join('\n');
}

function subjectFromPlanLine(line, fallback) {
  const cleaned = cleanPlanLine(line);
  if (!cleaned) return fallback;
  const beforeDash = cleaned.split(/\s+[--]\s+|\s+-\s+|:\s+/)[0].trim();
  const subject = beforeDash || cleaned;
  return subject.slice(0, 90);
}

function parseTopLevelBullets(section, prefix, opts = {}) {
  const lines = String(section || '').split('\n');
  const blocks = [];
  let current = null;
  const numberedOnly = !!opts.numberedOnly;
  const topLevelRe = numberedOnly
    ? /^\s{0,3}\d+[.)]\s+/
    : /^\s{0,3}(?:[-*]|\d+[.)])\s+/;
  for (const line of lines) {
    if (topLevelRe.test(line)) {
      if (current) blocks.push(current);
      current = { first: line, lines: [line] };
      continue;
    }
    if (!current) continue;
    if (!String(line || '').trim()) {
      current.lines.push(line);
      continue;
    }
    // Keep indented detail under the owning step, but don't promote it to a task.
    if (/^\s+/.test(line)) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map((block, idx) => ({
    subject: subjectFromPlanLine(block.first, `${prefix} ${idx + 1}`),
    raw: cleanPlanBlock(block.lines.join('\n')),
  }));
}

function parseBullets(section, prefix) {
  const lines = String(section || '').split('\n');
  const items = [];
  for (const line of lines) {
    if (!/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) continue;
    const subject = subjectFromPlanLine(line, `${prefix} ${items.length + 1}`);
    items.push({
      subject,
      raw: cleanPlanLine(line),
    });
  }
  return items;
}

function parsePlanArtifacts(text) {
  const steps = parseTopLevelBullets(extractSection(text, 'Steps'), 'Step', { numberedOnly: true });
  const verification = parseTopLevelBullets(extractSection(text, 'Verification'), 'Verification');
  return { steps, verification };
}

function classifyPlanModeMessage(opts = {}) {
  const mode = String(opts.projectContext?.mode || '').toLowerCase();
  const msg = String(opts.content || opts.messageContent || '').trim();
  if (mode === 'execute') return 'execute';
  if (mode !== 'plan') return 'execute';
  if (msg.startsWith('[BUILD_PLAN]')) return 'plan';
  if (msg.startsWith('[RESEARCH]') || opts.trigger === 'task_complete') return 'research';
  if (msg.startsWith('[REVIEW]')) return 'research';
  return 'intake';
}

function isSporeCodeTurn(opts = {}) {
  return opts.platform === 'cli' && !!opts.projectContext;
}

function workflowControlKind(text = '') {
  const trimmed = String(text || '').trim();
  if (/^\s*RESEARCH_DONE:/m.test(trimmed)) return 'research_done';
  if (/^\s*NO_INTERVIEW_NEEDED:/m.test(trimmed)) return 'no_interview_needed';
  if (/^\s*NO_FOLLOWUP_QUESTIONS:/m.test(trimmed)) return 'no_followup_questions';
  if (/^\s*QUESTIONS:/m.test(trimmed)) return 'questions';
  if (/^\s*PLAN_READY\s*$/m.test(trimmed)) return 'plan_ready';
  return null;
}

function isHiddenWorkflowControlText(text = '') {
  return new Set(['research_done', 'no_interview_needed', 'no_followup_questions'])
    .has(workflowControlKind(text));
}

function resultFailed(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.blocked) return false;
  if (resultPendingBackground(result)) return false;
  if (result.error) return true;
  const exitCode = result.exitCode ?? result.exit_code;
  return Number.isFinite(exitCode) && Number(exitCode) !== 0;
}

function resultPendingBackground(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.pending === true) return true;
  if (result.running === true && (result.id != null || result.processId != null || result.logFile || result.log_file)) return true;
  if (result.running === true && result.backgrounded === true) return true;
  if (result.backgrounded === true) {
    const exitCode = result.exitCode ?? result.exit_code;
    if (exitCode == null || Number(exitCode) === -1) return true;
    const note = `${result.note || ''} ${result.status || ''}`;
    if (/moved to background|running in background|use bg_tail/i.test(note)) return true;
  }
  return false;
}

function resultExitCode(result) {
  if (!result || typeof result !== 'object') return null;
  const exitCode = result.exitCode ?? result.exit_code;
  return Number.isFinite(exitCode) ? Number(exitCode) : null;
}

function compactResultPreview(result) {
  return resultText(result, 600);
}

function resultText(result, limit = null) {
  if (result == null) return '';
  if (typeof result === 'string') return limit ? result.slice(0, limit) : result;
  let text = result.output;
  if (!text && result.error) {
    text = [
      result.error,
      result.stdout ? `[stdout]\n${result.stdout}` : '',
      result.stderr ? `[stderr]\n${result.stderr}` : '',
    ].filter(Boolean).join('\n');
  }
  if (!text) text = result.stdout || result.stderr || JSON.stringify(result);
  const out = String(text || '');
  return limit ? out.slice(0, limit) : out;
}

function gitStatusNotRepoText(text) {
  return /\bnot a git repository\b|\boutside work tree\b|\bnot inside a work tree\b/i.test(String(text || ''));
}

function commandLooksFiltered(command) {
  return /\b(--grep|-k|-run|--testNamePattern|--filter|--runTestsByPath|--include|--exclude|--watch|grep)\b/i.test(String(command || ''));
}

function commandTargetsSpecificTestFile(command) {
  const c = String(command || '').replace(/\\/g, '/');
  return /\btests?\/[^\s;&|]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|go|rs)\b/i.test(c)
    || /\b(?:test|spec|__tests__)\/[^\s;&|]+\.(?:js|jsx|ts|tsx|mjs|cjs|go|rs)\b/i.test(c)
    || /\b[^/\s;&|]+(?:_test\.go|_test\.py|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)\b/i.test(c)
    || /::[A-Za-z_][A-Za-z0-9_]*/.test(c);
}

function commandLooksTest(command) {
  const c = String(command || '');
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i.test(c)
    || /\bgo\s+test\b/i.test(c)
    || /\bcargo\s+test\b/i.test(c)
    || /\bnode\s+--test\b/i.test(c)
    || /\bpython3?\s+-m\s+pytest\b/i.test(c)) return true;
  return c
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .some(part => {
      const segment = String(part || '').trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*/, '');
      return /^(?:python3?|python)\s+-m\s+pytest\b/i.test(segment)
        || /^(?:npx\s+)?(?:pytest|mocha|jest|vitest)\b/i.test(segment);
    });
}

function commandLooksFullSuite(command) {
  const c = String(command || '').trim();
  if (!c) return false;
  if (!commandLooksTest(c)) return false;
  if (commandLooksFiltered(c)) return false;
  if (commandTargetsSpecificTestFile(c)) return false;
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i.test(c)
    || /\bgo\s+test\s+\.\/\.\.\./i.test(c)
    || /\bcargo\s+test\b/i.test(c)
    || /\bpytest\b/i.test(c)
    || /\bpython\s+-m\s+pytest\b/i.test(c);
}

function commandLooksGoFmt(command) {
  return /\bgofmt\b|\bgo\s+fmt\b/i.test(String(command || ''));
}

function commandLooksBuildOrVerification(command) {
  const c = String(command || '');
  if (/\bcreate-next-app(?:@[\w@./-]+)?\b/i.test(c)) return false;
  return commandLooksTest(c)
    || /\bgo\s+build\b/i.test(c)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|lint|typecheck)\b/i.test(c)
    || /\bcargo\s+(?:build|check|test)\b/i.test(c)
    || /\b(?:pytest|ruff|mypy|tsc|eslint|make|cmake\s+--build|mvn\s+test|gradle\s+test)\b/i.test(c);
}

function commandLooksStatusOrVerification(command) {
  const c = String(command || '');
  return commandLooksBuildOrVerification(c)
    || /\bgit\s+(?:status|diff|diff\s+--check|show)\b/i.test(c);
}

function isWindowsProject(project = {}) {
  const values = [
    project.os,
    project.platform,
    project.defaultShell,
    project.shell,
    project.cwd,
  ].filter(Boolean).join(' ');
  return /\b(?:win32|windows|cmd\.exe|powershell|pwsh)\b|^[a-z]:\\/i.test(values);
}

function windowsPosixCommandIssue(command = '') {
  const c = String(command || '').trim();
  if (!c) return null;
  const checks = [
    { re: /\|\s*head(?:\s|$)/i, utility: 'head' },
    { re: /\|\s*tail(?:\s|$)/i, utility: 'tail' },
    { re: /\|\s*grep(?:\s|$)/i, utility: 'grep' },
    { re: /\|\s*sed(?:\s|$)/i, utility: 'sed' },
    { re: /\|\s*awk(?:\s|$)/i, utility: 'awk' },
    { re: /(^|[&|(;]\s*)head(?:\s|$)/i, utility: 'head' },
    { re: /(^|[&|(;]\s*)tail(?:\s|$)/i, utility: 'tail' },
    { re: /(^|[&|(;]\s*)grep(?:\s|$)/i, utility: 'grep' },
    { re: /(^|[&|(;]\s*)sed(?:\s|$)/i, utility: 'sed' },
    { re: /(^|[&|(;]\s*)awk(?:\s|$)/i, utility: 'awk' },
    { re: /(^|[&|(;]\s*)cat(?:\s|$)/i, utility: 'cat' },
    { re: /(^|[&|(;]\s*)ls(?:\s|$)/i, utility: 'ls' },
  ];
  return checks.find(item => item.re.test(c))?.utility || null;
}

function commandLooksUntrackedWhitespaceCheck(command) {
  const c = String(command || '');
  return /\bgit\s+ls-files\s+--others\b/i.test(c)
    || /\bgit\s+add\s+(?:--intent-to-add|-N)\b/i.test(c)
    || /\buntracked\s+whitespace\s+check\b/i.test(c);
}

function finalClaimPhraseIsFocused(text) {
  return /\b(focused|targeted|specific|named|filtered|matching|selected|subset|grep|request[-\s]?id|req\.?id|single\s+file|test\s+file|file[-\s]?level|smoke|suggest(?:ion)?|hidden|filter\s+runs?)\b/i.test(text || '');
}

function finalNumberedAllTestClaims(text) {
  const out = [];
  const re = /\ball\s+\d{1,6}\s+(?:(?:focused|targeted|specific|named|filtered|request[-\s]?id|req\.?id|smoke)\s+)?(?:tests?\s+)?(?:pass|passed|passing)\b/ig;
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.push({ phrase: m[0], focused: finalClaimPhraseIsFocused(m[0]) });
  }
  return out;
}

function finalClaimsFullSuite(text) {
  const s = String(text || '');
  const broad = [
    /\b(?:all|full|entire)\b.{0,40}\b(?:tests?|suite|checks?)\b.{0,40}\b(?:pass|passed|passing|green)\b/ig,
    /\b(?:everything|all checks)\b.{0,40}\b(?:pass|passed|passing|green)\b/ig,
    /\bverification\b.{0,80}\ball\s+(?:pass|passed|passing|green)\b/ig,
    /\ball\s+(?:pass|passed|passing|green)\b.{0,30}\b(?:zero|0)\s+failures?\b/ig,
  ];
  for (const re of broad) {
    let m;
    while ((m = re.exec(s))) {
      if (!finalClaimPhraseIsFocused(m[0])) return true;
    }
  }
  return finalNumberedAllTestClaims(s).some(c => !c.focused);
}

function finalClaimsComplete(text) {
  return /\b(done|complete|completed|finished|implemented|fixed)\b/i.test(text || '');
}

function finalClaimsWhitespaceClean(text) {
  return /\b(?:git\s+diff\s+--check|diff\s+--check|whitespace|no\s+whitespace|clean\s+diff)\b/i.test(text || '');
}

function finalClaimsAlreadySatisfied(text) {
  return /\b(?:already|no\s+change|no\s+action|exists|correct|not\s+needed|not\s+applicable|out\s+of\s+scope|nothing\s+to\s+do|was\s+fine|were\s+fine)\b/i.test(text || '');
}

function finalClaimsNoActionClosure(text) {
  const s = String(text || '');
  return /\b(?:no\s+action|not\s+needed|not\s+applicable|out\s+of\s+scope|nothing\s+to\s+do)\b/i.test(s)
    || /\balready\b.{0,60}\b(?:done|fixed|implemented|handled|covered|correct|working|exists|there)\b/i.test(s);
}

function finalOnlyClaimsNoFileChanges(text) {
  const s = String(text || '');
  const noFileChange = /\bno\s+(?:files?\s+)?(?:changes?|changed|edits?|modifications?)\b|\bno files were changed\b/i.test(s);
  if (!noFileChange) return false;
  return !/\b(?:already|exists|correct|not\s+needed|not\s+applicable|nothing\s+to\s+do|was\s+fine|were\s+fine)\b/i.test(s);
}

function finalMentionsUntracked(text) {
  return /\b(?:untracked|new files?|created files?)\b/i.test(text || '');
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

function finalClaimedTestCounts(text) {
  const out = extractTestCounts(text);
  const re = /\ball\s+(\d{1,6})\s+tests?\s+(?:pass|passed|passing)\b/ig;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return [...new Set(out)];
}

function finalClaimedChangedFileCount(text) {
  const m = String(text || '').match(/\b(\d{1,4})\s+files?\s+(?:changed|modified|created|updated|touched)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseGitStatusChanged(output) {
  const entries = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('##')) continue;
    if (/files?\s+changed\b/i.test(raw)) continue;
    const status = raw.slice(0, 2);
    let body = raw.length >= 3 ? raw.slice(3).trim() : raw.trim();
    if (!body) continue;
    if (body.includes(' -> ')) body = body.split(' -> ').pop().trim();
    const filePath = body.replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/\/+$/g, '');
    if (!filePath) continue;
    entries.push({ path: filePath, tracked: status !== '??', status: status.trim() || 'M' });
  }
  return {
    count: entries.length,
    tracked: entries.filter(e => e.tracked).map(e => e.path),
    untracked: entries.filter(e => !e.tracked).map(e => e.path),
    paths: entries.map(e => e.path),
  };
}

function normalizeWorkflowPath(p = '') {
  return String(p || '').replace(/\\/g, '/').replace(/^"\s*|\s*"$/g, '').replace(/\/+$/g, '').trim();
}

function taskMatchTokens(text = '') {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'in', 'into', 'for', 'of', 'with', 'on', 'up', 'add', 'make', 'wire', 'implement', 'update', 'fix', 'task', 'step']);
  return new Set(String(text || '')
    .toLowerCase()
    .replace(/[`*_#[\](){}:;,.!?/\\-]+/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 3 && !stop.has(s)));
}

function taskTextSimilar(a = '', b = '') {
  const aTokens = taskMatchTokens(a);
  const bTokens = taskMatchTokens(b);
  if (!aTokens.size || !bTokens.size) return false;
  const aNorm = [...aTokens].join(' ');
  const bNorm = [...bTokens].join(' ');
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return true;
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap += 1;
  return overlap >= 2 && overlap / Math.min(aTokens.size, bTokens.size) >= 0.55;
}

function destructiveGitCommand(command = '') {
  const c = commandKey(command);
  if (!/\bgit\s+/.test(c)) return null;
  if (/\bgit\s+clean\b/.test(c)) return 'git_clean';
  if (/\bgit\s+reset\b/.test(c)) return 'git_reset';
  if (/\bgit\s+restore\b/.test(c)) return 'git_restore';
  if (/\bgit\s+checkout\s+(?:--|head\b|\.|:[/\\]|[\w./\\-]+\s+--)\b/.test(c)) return 'git_checkout_restore';
  return null;
}

function repairReasonForPrompt(prompt = '') {
  const s = String(prompt || '');
  if (/no current git_status/i.test(s)) return 'missing current git_status after changes';
  if (/missing current git_status/i.test(s) || /Call `git_status` before finalizing/i.test(s)) return 'missing current git_status after changes';
  if (/failed verification evidence is unresolved/i.test(s)) return 'failed verification evidence is unresolved';
  if (/all tests|full suite|full-suite/i.test(s)) return 'unsupported full-suite claim';
  if (/test count/i.test(s) || /observed tool output only supports/i.test(s)) return 'unsupported test count claim';
  if (/changed file/i.test(s) || /changed path/i.test(s)) return 'changed-file count mismatch';
  if (/untracked/i.test(s) && /diff --check/i.test(s)) return 'untracked files were not covered by git diff --check';
  if (/untracked/i.test(s)) return 'untracked files missing from final summary';
  if (/gofmt|go fmt/i.test(s)) return 'changed Go files lack formatting evidence';
  if (/workflow checklist is not complete/i.test(s)) return 'workflow checklist is not complete';
  if (/already|no action/i.test(s)) return 'already-satisfied claim lacks concrete evidence';
  return 'final answer did not match recorded workflow evidence';
}

function formatEvidenceCommand(e = {}) {
  const command = String(e.command || '').trim();
  if (command) return `\`${command}\``;
  return e.tool ? `\`${e.tool}\`` : '`tool`';
}

function evidenceLabel(e = {}) {
  const bits = [];
  if (e.fullSuite && !e.filtered) bits.push('full-suite');
  else if (e.filtered) bits.push('focused');
  else if (e.testCommand) bits.push('test');
  else if (e.buildOrVerification) bits.push('build/check');
  if (e.pending) bits.push('pending background');
  if (Array.isArray(e.testCounts) && e.testCounts.length) bits.push(`${e.testCounts.join('/')} observed`);
  const status = e.pending ? 'pending' : (e.ok ? 'passed' : (e.exitCode != null ? `failed, exit ${e.exitCode}` : 'failed'));
  return bits.length ? `${status}, ${bits.join(', ')}` : status;
}

function isVerificationEvidence(e = {}) {
  if (!e || typeof e !== 'object') return false;
  if (e.pending) return false;
  if (/\bcreate-next-app(?:@[\w@./-]+)?\b/i.test(e.command || '')) return false;
  return e.tool === 'verify_implementation'
    || e.tool === 'run_tests'
    || e.testCommand
    || e.buildOrVerification
    || e.fullSuite
    || e.filtered
    || e.goFmt
    || e.untrackedWhitespaceCheck;
}

function evidenceKey(e = {}) {
  const command = String(e.command || '').trim().replace(/\s+/g, ' ');
  if (command) return `${e.tool || 'tool'}:${command}`;
  return `${e.tool || 'tool'}:${e.fullSuite ? 'full-suite' : e.filtered ? 'focused' : 'generic'}`;
}

function verificationEvidenceCovers(success = {}, failure = {}) {
  if (!success?.ok || !failure || failure.ok) return false;
  if (!isVerificationEvidence(success) || !isVerificationEvidence(failure)) return false;
  if (evidenceKey(success) === evidenceKey(failure)) return true;

  const successCommand = commandKey(success.command);
  const failureCommand = commandKey(failure.command);
  if (!successCommand || !failureCommand) {
    return success.tool === 'run_tests' && failure.tool === 'run_tests'
      || success.tool === 'verify_implementation' && failure.tool === 'verify_implementation';
  }

  if (success.tool === 'run_tests' && failure.tool === 'run_tests') return true;
  if (success.tool === 'verify_implementation' && failure.tool === 'verify_implementation') return true;
  if (success.tool !== failure.tool) return false;

  if (success.tool === 'exec') {
    if (/\bcreate-next-app(?:@[\w@./-]+)?\b/i.test(failureCommand)
      && (/\bcreate-next-app(?:@[\w@./-]+)?\b/i.test(successCommand)
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|lint|typecheck)\b/i.test(successCommand)
        || /\bnext\s+build\b/i.test(successCommand))) return true;
    if (/\bgo\s+build\s+\.\/\.\.\./i.test(successCommand)
      && /\bgo\s+build\b/i.test(failureCommand)) return true;
    if (/\bgo\s+test\s+\.\/\.\.\./i.test(successCommand)
      && /\bgo\s+test\b/i.test(failureCommand)) return true;
    if (/\bcargo\s+test\b/i.test(successCommand)
      && /\bcargo\s+test\b/i.test(failureCommand)) return true;
    if (/\bcargo\s+check\b/i.test(successCommand)
      && /\bcargo\s+(?:check|build)\b/i.test(failureCommand)) return true;
    if (success.fullSuite && failure.testCommand) return true;
  }
  return false;
}

function unresolvedFailedVerificationEvidence(evidence = []) {
  const unresolved = [];
  for (const e of evidence || []) {
    if (!isVerificationEvidence(e)) continue;
    if (e.ok) {
      for (let i = unresolved.length - 1; i >= 0; i -= 1) {
        if (verificationEvidenceCovers(e, unresolved[i])) unresolved.splice(i, 1);
      }
      continue;
    }
    const key = evidenceKey(e);
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      if (evidenceKey(unresolved[i]) === key) unresolved.splice(i, 1);
    }
    unresolved.push(e);
  }
  return unresolved.filter(e => !e.ok);
}

function verificationEvidenceList(evidence = [], limit = 6) {
  const seen = new Set();
  const out = [];
  for (const e of [...(evidence || [])].reverse()) {
    if (!isVerificationEvidence(e)) continue;
    const key = `${evidenceKey(e)}:${e.ok ? 'ok' : 'fail'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

function finalAcknowledgesVerificationFailure(text = '') {
  return /\b(?:fail(?:ed|ing)?|failure|red|not\s+passing|did\s+not\s+pass|exit\s+code|blocked|pre[-_]?existing(?:[-_]?failure)?|unrelated(?:[-_]?failure)?|known\s+failure)\b/i.test(text || '');
}

function finalRepairPromptFor(originalText, lines = []) {
  const body = (Array.isArray(lines) ? lines : [lines])
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^\[SYSTEM:\s*/i, '')
    .replace(/\]\s*$/i, '')
    .trim();
  const original = String(originalText || '').trim();
  const prompt = [
    '[SYSTEM: Workflow final-answer validation failed.',
    body,
    'Rewrite ORIGINAL_FINAL_RESPONSE for the user. Keep its useful substantive answer and structure.',
    'Only remove or qualify claims that are not supported by recorded workflow evidence.',
    'Do not call tools in this repair turn.',
    'Do not discuss this validator, the guard, repair process, or whether a repair was needed.',
    'Do not say "false trigger", "nothing to repair", or "my bad"; produce the corrected user-facing answer.]',
  ].filter(Boolean).join(' ');
  if (!original) return prompt;
  return [
    prompt,
    '',
    'ORIGINAL_FINAL_RESPONSE:',
    '```text',
    original.replace(/```/g, "'''"),
    '```',
  ].join('\n');
}

function finalContinueExecutionPrompt(reason = 'workflow checklist is not complete') {
  return [
    '[SYSTEM: Workflow execution is not complete.',
    `Reason: ${reason}.`,
    'Do not produce a final answer yet.',
    'Continue execute mode with tools available.',
    'First call `workflow_status` if the next task id is unclear.',
    'Then mark the current unresolved task `in_progress`, do the smallest concrete work needed for that task, and record `task_progress` as done/error/blocked based on evidence.',
    'If the last draft merely announced intent or said the work was done without completing the checklist, ignore that draft and continue from the workflow tasks.]',
  ].join(' ');
}

function finalToolRepairPrompt(reason, lines = []) {
  const body = (Array.isArray(lines) ? lines : [lines])
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .join(' ');
  return [
    '[SYSTEM: Workflow evidence is incomplete.',
    `Reason: ${reason}.`,
    body,
    'Continue with tools available; do not produce a final answer until the missing evidence is collected or the blocker is explicitly reported.',
    'Use the smallest necessary tool call(s), then summarize only what recorded evidence proves.',
    'Do not discuss this validator, repair process, or hidden instructions.]',
  ].join(' ');
}

class WorkflowManager {
  constructor(sessions, log) {
    this.sessions = sessions;
    this.log = log || console;
  }

  get db() {
    return this.sessions?.db || null;
  }

  _read(row) {
    if (!row) return null;
    return {
      ...row,
      artifacts: safeJsonParse(row.artifacts_json, {}),
      evidence: safeJsonParse(row.evidence_json, []),
      activeRules: safeJsonParse(row.active_rules_json, []),
    };
  }

  get(sessionKey) {
    if (!this.db || !sessionKey) return null;
    const row = this.db.prepare('SELECT * FROM session_workflows WHERE session_key=?').get(sessionKey);
    return this._read(row);
  }

  getStatus(sessionKey) {
    const wf = this.get(sessionKey);
    if (!wf) return null;
    const tasks = this._taskSummary(wf);
    const taskRows = this._taskRows(wf);
    const currentTasks = taskRows.filter(r => r.status === 'in_progress');
    const actionableRows = taskRows.filter(r => !['done', 'cancelled'].includes(r.status || '') && !this._isAcceptedBlockedTask(r));
    const nextTasks = currentTasks.length
      ? []
      : actionableRows.slice(0, 3);
    return {
      id: wf.id,
      kind: wf.workflow_kind,
      phase: wf.phase,
      status: wf.status,
      policy: wf.policy,
      activeRules: wf.activeRules,
      artifacts: this._publicArtifacts(wf.artifacts),
      evidenceCount: Array.isArray(wf.evidence) ? wf.evidence.length : 0,
      latestEvidence: Array.isArray(wf.evidence) ? wf.evidence.slice(-5) : [],
      tasks,
      taskRows,
      workflowTaskIds: taskRows.map(r => r.id),
      currentTask: currentTasks[0] || nextTasks[0] || null,
      currentTasks,
      nextTasks,
      updatedAt: wf.updated_at,
    };
  }

  ensureForTurn(sessionKey, opts = {}) {
    if (!this.db || !sessionKey || !isSporeCodeTurn(opts)) return null;
    this.sessions?.ensureSession?.(sessionKey);
    const phase = classifyPlanModeMessage(opts);
    const existing = this.get(sessionKey);
      const project = opts.projectContext || {};
      const baseArtifacts = {
        project: {
          cwd: project.cwd || null,
          project: project.project || null,
          mode: project.mode || null,
          os: project.os || project.platform || null,
          defaultShell: project.defaultShell || project.shell || null,
        },
      };
    if (!existing) {
      const id = `wf-${hash(sessionKey)}`;
      this.db.prepare(`
        INSERT INTO session_workflows
          (id, session_key, workflow_kind, phase, status, policy, active_rules_json, artifacts_json, evidence_json, created_at, updated_at)
        VALUES (?, ?, 'spore-code', ?, 'active', ?, ?, ?, '[]', ?, ?)
      `).run(
        id,
        sessionKey,
        SPORE_CODE_PHASES.has(phase) ? phase : 'execute',
        GUIDED_POLICY,
        stringify(this._rulesForPhase(phase)),
        stringify(baseArtifacts),
        nowMs(),
        nowMs(),
      );
      this._event(id, sessionKey, 'created', { phase, source: 'turn-start' });
      return this.get(sessionKey);
    }

    const nextPhase = this._nextPhase(existing.phase, phase);
    const nextArtifacts = { ...(existing.artifacts || {}), project: baseArtifacts.project };
    const nextRules = this._rulesForPhase(nextPhase);
    this._update(existing.id, {
      phase: nextPhase,
      status: existing.status === 'complete' && nextPhase !== 'complete' ? 'active' : existing.status,
      activeRules: nextRules,
      artifacts: nextArtifacts,
      evidence: existing.evidence,
    });
    if (nextPhase !== existing.phase) {
      this._event(existing.id, sessionKey, 'phase', { from: existing.phase, to: nextPhase, source: 'turn-start' });
    }
    return this.get(sessionKey);
  }

  _nextPhase(current, desired) {
    if (!SPORE_CODE_PHASES.has(desired)) return current || 'execute';
    if (current === 'debug' && desired === 'execute') return 'debug';
    if (desired === 'execute') return 'execute';
    if (desired === 'plan') return 'plan';
    if (desired === 'research') return 'research';
    if (desired === 'intake') return 'intake';
    return desired;
  }

  _rulesForPhase(phase) {
    if (phase === 'intake') return ['ask_material_questions', 'no_mutation'];
    if (phase === 'research') return ['read_only_research', 'source_grounding', 'no_mutation'];
    if (phase === 'plan') return ['plan_artifact_required', 'verification_plan_required', 'no_mutation'];
    if (phase === 'execute') return ['task_progress', 'incremental_implementation', 'verification_required'];
    if (phase === 'debug') return ['stop_the_line', 'preserve_evidence', 'root_cause_first'];
    if (phase === 'verify') return ['command_derived_claims', 'verification_required'];
    return [];
  }

  _update(id, { phase, status, activeRules, artifacts, evidence }) {
    this.db.prepare(`
      UPDATE session_workflows
      SET phase=?, status=?, active_rules_json=?, artifacts_json=?, evidence_json=?, updated_at=?
      WHERE id=?
    `).run(
      phase,
      status,
      stringify(activeRules || []),
      stringify(artifacts || {}),
      stringify(Array.isArray(evidence) ? evidence.slice(-80) : []),
      nowMs(),
      id,
    );
  }

  _event(workflowId, sessionKey, type, payload = {}) {
    try {
      this.db.prepare(`
        INSERT INTO workflow_events (workflow_id, session_key, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workflowId, sessionKey, type, stringify(payload), nowMs());
    } catch (e) {
      this.log.warn?.(`[workflow] event failed: ${e.message}`);
    }
  }

  _publicArtifacts(artifacts = {}) {
    return {
      project: artifacts.project || null,
      recovery: artifacts.recovery ? {
        active: !!artifacts.recovery.active,
        reason: artifacts.recovery.reason || null,
        enteredAt: artifacts.recovery.enteredAt || null,
        exitedAt: artifacts.recovery.exitedAt || null,
        latestFailedCommand: artifacts.recovery.latestFailedCommand || null,
        statusEvidenceAt: artifacts.recovery.statusEvidenceAt || null,
        triggerTool: artifacts.recovery.triggerTool || null,
        failedCount: artifacts.recovery.failedCount || null,
      } : null,
      contextPressure: artifacts.contextPressure || null,
      questions: artifacts.questions ? { captured: true } : null,
      noInterviewNeeded: artifacts.noInterviewNeeded ? { captured: true, preview: artifacts.noInterviewNeeded.preview || '' } : null,
      noFollowupQuestions: artifacts.noFollowupQuestions ? { captured: true, preview: artifacts.noFollowupQuestions.preview || '' } : null,
      researchDone: !!artifacts.researchDone,
      researchDonePreview: artifacts.researchDone?.preview || '',
      backgroundTaskResults: Array.isArray(artifacts.backgroundTaskResults)
        ? artifacts.backgroundTaskResults.slice(-5)
        : [],
      planReady: !!artifacts.planReady,
      planReadyPreview: artifacts.planReady?.preview || '',
      steps: Array.isArray(artifacts.steps) ? artifacts.steps.length : 0,
      verification: Array.isArray(artifacts.verification) ? artifacts.verification.length : 0,
      tasksCreated: !!artifacts.tasksCreated,
      protectedWipPaths: artifacts.protectedWipPaths ? {
        capturedAt: artifacts.protectedWipPaths.capturedAt || null,
        paths: Array.isArray(artifacts.protectedWipPaths.paths)
          ? artifacts.protectedWipPaths.paths.slice(0, 40)
          : [],
        tracked: Array.isArray(artifacts.protectedWipPaths.tracked)
          ? artifacts.protectedWipPaths.tracked.slice(0, 40)
          : [],
        untracked: Array.isArray(artifacts.protectedWipPaths.untracked)
          ? artifacts.protectedWipPaths.untracked.slice(0, 40)
          : [],
      } : null,
      staleEditFailures: artifacts.staleEditFailures
        ? Object.keys(artifacts.staleEditFailures).slice(0, 20)
        : [],
    };
  }

  recordBackgroundTaskResult(sessionKey, task = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const artifacts = { ...(wf.artifacts || {}) };
    const existing = Array.isArray(artifacts.backgroundTaskResults)
      ? artifacts.backgroundTaskResults.slice(-4)
      : [];
    existing.push({
      capturedAt: nowMs(),
      taskId: String(task.taskId || '').slice(0, 80),
      status: String(task.status || '').slice(0, 40),
      originalRequest: String(task.originalRequest || '').slice(0, 700),
      resultPreview: String(task.result || '').slice(0, 2400),
    });
    artifacts.backgroundTaskResults = existing;
    this._update(wf.id, {
      phase: wf.phase,
      status: wf.status,
      activeRules: wf.activeRules,
      artifacts,
      evidence: wf.evidence,
    });
    this._event(wf.id, sessionKey, 'background_task_result', {
      taskId: task.taskId || null,
      status: task.status || null,
      chars: String(task.result || '').length,
    });
    return this.getStatus(sessionKey);
  }

  recordPlannerAdvisorEvent(sessionKey, payload = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    this._event(wf.id, sessionKey, 'planner_advisor', {
      status: payload.status || null,
      phase: payload.phase || null,
      reason: payload.reason || null,
      reasons: Array.isArray(payload.reasons) ? payload.reasons.slice(0, 8) : [],
      model: payload.model || null,
      activeModel: payload.activeModel || null,
      elapsedMs: Number.isFinite(Number(payload.elapsedMs)) ? Number(payload.elapsedMs) : null,
      usage: payload.usage || null,
      fallback: !!payload.fallback,
      malformed: !!payload.malformed,
      preview: payload.preview ? String(payload.preview).slice(0, 500) : null,
      rawPreview: payload.rawPreview ? String(payload.rawPreview).slice(0, 300) : null,
      error: payload.error ? String(payload.error).slice(0, 300) : null,
    });
    return this.getStatus(sessionKey);
  }

  _taskSummary(wf) {
    const ids = [
      ...((wf.artifacts?.stepTaskIds) || []),
      ...((wf.artifacts?.verificationTaskIds) || []),
    ].filter(Boolean);
    if (!ids.length || !this.db) return { total: 0, pending: 0, done: 0, error: 0, blocked: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count FROM tasks WHERE id IN (${placeholders}) GROUP BY status`).all(...ids);
    const out = { total: ids.length, pending: 0, done: 0, error: 0, blocked: 0, in_progress: 0 };
    for (const r of rows) out[r.status] = Number(r.count) || 0;
    const acceptedBlocked = this._taskRows(wf).filter(row => this._isAcceptedBlockedTask(row)).length;
    if (acceptedBlocked) {
      out.accepted_blocked = acceptedBlocked;
      out.blocked_unaccepted = Math.max(0, (out.blocked || 0) - acceptedBlocked);
    }
    return out;
  }

  _taskRows(wf) {
    const ids = [
      ...((wf.artifacts?.stepTaskIds) || []),
      ...((wf.artifacts?.verificationTaskIds) || []),
    ].filter(Boolean);
    if (!ids.length || !this.db) return [];
    const kindById = new Map();
    for (const id of wf.artifacts?.stepTaskIds || []) kindById.set(id, 'step');
    for (const id of wf.artifacts?.verificationTaskIds || []) kindById.set(id, 'verification');
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id, subject, status, description, result FROM tasks WHERE id IN (${placeholders}) ORDER BY created ASC`).all(...ids);
    return rows.map(r => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      description: String(r.description || '').slice(0, 500),
      result: String(r.result || '').slice(0, 1000),
      kind: kindById.get(r.id) || 'task',
    }));
  }

  _isAcceptedBlockedTask(row = {}) {
    if (!row || row.status !== 'blocked') return false;
    const text = [row.result, row.description].filter(Boolean).join('\n');
    return /(?:\bpre[-_\s]?existing(?:[-_\s]?failure)?\b|\bunrelated(?:[-_\s]?failure)?\b|\boutside\s+scope\b|\bexternal\s+blocker\b|\benvironment\s+blocker\b|\bknown\s+failure\b)/i.test(text)
      && /\b(?:evidence|command|git_diff|git_status|read_file|grep|log|output|exit|failed|passes?|passed)\b/i.test(text);
  }

  _unresolvedTaskRows(wf) {
    return this._taskRows(wf).filter(row => row.status !== 'done' && row.status !== 'cancelled' && !this._isAcceptedBlockedTask(row));
  }

  _parallelGroupForTask(row = {}) {
    const text = [row.subject, row.description].filter(Boolean).join(' ');
    const m = text.match(/\[parallel(?::\s*([^\]]+))?\]/i);
    if (!m) return null;
    return String(m[1] || 'default').trim().toLowerCase();
  }

  _workflowTaskKind(wf, taskId) {
    if (!wf || !taskId) return null;
    if ((wf.artifacts?.stepTaskIds || []).includes(taskId)) return 'step';
    if ((wf.artifacts?.verificationTaskIds || []).includes(taskId)) return 'verification';
    return null;
  }

  _workflowTaskRow(wf, taskId) {
    if (!this.db || !this._workflowTaskKind(wf, taskId)) return null;
    return this.db.prepare('SELECT id, subject, status, description FROM tasks WHERE id=?').get(taskId) || null;
  }

  _hasImplementationEvidence(evidence = []) {
    return evidence.some(e => e?.ok && MUTATING_TOOLS.has(e.tool) && e.tool !== 'bg_tail');
  }

  _hasFileMutationEvidence(evidence = []) {
    return evidence.some(e => e?.ok && FILE_MUTATING_TOOLS.has(e.tool));
  }

  _hasVerificationEvidence(evidence = []) {
    return evidence.some(e => {
      if (!e?.ok) return false;
      if (e.pending) return false;
      if (e.tool === 'verify_implementation') return true;
      if (e.tool === 'run_tests') return true;
      if (e.testCommand || e.fullSuite || e.filtered || e.goFmt || e.untrackedWhitespaceCheck) return true;
      if (e.buildOrVerification) return true;
      if (e.tool === 'exec' && /\b(?:compileall|diff\s+--check|pytest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+(?:run\s+)?test)\b/i.test(e.command || '')) return true;
      return false;
    });
  }

  _latestRecoveryStatusEvidence(evidence = [], recovery = {}) {
    const enteredAt = Number(recovery?.enteredAt || 0);
    return [...(evidence || [])].reverse().find(e => {
      if (!e?.ok) return false;
      if (enteredAt && Number(e.ts || 0) < enteredAt) return false;
      if (RECOVERY_STATUS_TOOLS.has(e.tool)) return true;
      return e.tool === 'exec' && /\bgit\s+(?:status|diff)\b/i.test(e.command || '');
    }) || null;
  }

  _latestSameFailedVerification(evidence = [], recovery = {}, normalizedTool = '', command = '') {
    const enteredAt = Number(recovery?.enteredAt || 0);
    const key = commandKey(command);
    if (!key || !commandLooksBuildOrVerification(command)) return null;
    const recoveryCommandKey = commandKey(recovery?.latestFailedCommand || '');
    return [...(evidence || [])].reverse().find(e => {
      if (e?.pending) return false;
      if (e?.ok) return false;
      if (enteredAt && Number(e.ts || 0) < enteredAt && commandKey(e.command || '') !== recoveryCommandKey) return false;
      if (e.tool !== normalizedTool) return false;
      return commandKey(e.command) === key;
    }) || null;
  }

  _hasFileMutationSince(evidence = [], sinceTs = 0) {
    return (evidence || []).some(e => {
      if (!e?.ok) return false;
      if (Number(e.ts || 0) < Number(sinceTs || 0)) return false;
      return FILE_MUTATING_TOOLS.has(e.tool);
    });
  }

  _repeatedFailedVerificationTrigger(evidence = [], entry = null) {
    if (!entry || entry.ok || !FAILURE_TOOLS.has(entry.tool) || !commandLooksBuildOrVerification(entry.command || '')) {
      return null;
    }
    const unresolved = unresolvedFailedVerificationEvidence(evidence)
      .filter(e => !e?.ok && FAILURE_TOOLS.has(e.tool) && commandLooksBuildOrVerification(e.command || ''));
    if (!unresolved.some(e => e.ts === entry.ts)) return null;

    const entryKey = commandKey(entry.command || entry.tool || 'verification');
    const priorCoveringSuccessTs = Math.max(0, ...(evidence || [])
      .filter(e => e?.ok && verificationEvidenceCovers(e, entry))
      .map(e => Number(e.ts || 0)));
    const sameCommandFailures = (evidence || [])
      .filter(e => !e?.ok
        && FAILURE_TOOLS.has(e.tool)
        && Number(e.ts || 0) > priorCoveringSuccessTs
        && commandKey(e.command || e.tool || 'verification') === entryKey);
    if (sameCommandFailures.length >= 2) {
      return {
        reason: 'repeated_failed_verification',
        failedCount: sameCommandFailures.length,
        latestFailedCommand: entry.command || entry.tool || '',
        triggerTool: entry.tool,
      };
    }
    if (unresolved.length >= 3) {
      return {
        reason: 'repeated_failed_verification',
        failedCount: unresolved.length,
        latestFailedCommand: entry.command || entry.tool || '',
        triggerTool: entry.tool,
      };
    }
    return null;
  }

  _repeatedLargeWriteTrigger(evidence = []) {
    if (!unresolvedFailedVerificationEvidence(evidence).length) return null;
    const recentWrites = (evidence || [])
      .filter(e => e?.ok && e.tool === 'write_file' && e.command)
      .slice(-10);
    const byPath = new Map();
    for (const e of recentWrites) {
      const key = String(e.command || '').replace(/\\/g, '/').toLowerCase();
      const count = (byPath.get(key) || 0) + 1;
      byPath.set(key, count);
      if (count >= 3) {
        return {
          reason: 'repeated_write_after_failed_verification',
          failedCount: count,
          latestFailedCommand: e.command,
          triggerTool: e.tool,
        };
      }
    }
    return null;
  }

  _activateRecovery(wf, artifacts, trigger = {}) {
    const existing = artifacts.recovery || {};
    if (existing.active) {
      return {
        ...existing,
        failedCount: Math.max(Number(existing.failedCount || 0), Number(trigger.failedCount || 0)),
        latestFailedCommand: trigger.latestFailedCommand || existing.latestFailedCommand || null,
        triggerTool: trigger.triggerTool || existing.triggerTool || null,
      };
    }
    const recovery = {
      active: true,
      reason: trigger.reason || 'workflow_recovery',
      enteredAt: nowMs(),
      latestFailedCommand: trigger.latestFailedCommand || null,
      triggerTool: trigger.triggerTool || null,
      failedCount: Number(trigger.failedCount || 0) || null,
      statusEvidenceAt: null,
    };
    this._event(wf.id, wf.session_key, 'circuit_breaker', {
      reason: recovery.reason,
      failedCount: recovery.failedCount,
      latestFailedCommand: recovery.latestFailedCommand,
      triggerTool: recovery.triggerTool,
    });
    return recovery;
  }

  _updateRecoveryForEntry(wf, artifacts, evidence, entry) {
    let recovery = artifacts.recovery || null;

    if (recovery?.active) {
      if (!unresolvedFailedVerificationEvidence(evidence).length) {
        recovery = {
          ...recovery,
          active: false,
          exitedAt: entry.ts,
          resolvedBy: entry.command || entry.tool || 'no_unresolved_verification_failures',
        };
        this._event(wf.id, wf.session_key, 'circuit_breaker_resolved', {
          resolvedBy: recovery.resolvedBy,
          reason: 'no_unresolved_verification_failures',
        });
      }
      if (entry?.ok && (RECOVERY_STATUS_TOOLS.has(entry.tool)
        || (entry.tool === 'exec' && /\bgit\s+(?:status|diff)\b/i.test(entry.command || '')))) {
        recovery = { ...recovery, statusEvidenceAt: entry.ts };
      }
      if (entry?.ok && (entry.tool === 'run_tests'
        || entry.tool === 'verify_implementation'
        || (entry.tool === 'exec' && commandLooksBuildOrVerification(entry.command || '')))) {
        recovery = {
          ...recovery,
          active: false,
          exitedAt: entry.ts,
          resolvedBy: entry.command || entry.tool || null,
        };
        this._event(wf.id, wf.session_key, 'circuit_breaker_resolved', {
          resolvedBy: recovery.resolvedBy,
        });
      }
    }

    if (!recovery?.active) {
      const trigger = this._repeatedFailedVerificationTrigger(evidence, entry)
        || (entry?.ok && entry.tool === 'write_file' ? this._repeatedLargeWriteTrigger(evidence) : null);
      if (trigger) {
        recovery = this._activateRecovery(wf, artifacts, trigger);
      }
    }

    return recovery;
  }

  recordContextPressure(sessionKey, state = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const artifacts = { ...(wf.artifacts || {}) };
    const pressure = {
      level: Number(state.level || 0),
      usedPercent: Number(state.usedPercent || 0),
      totalTokens: Number(state.totalTokens || 0),
      limitTokens: Number(state.limitTokens || 0),
      ts: nowMs(),
    };
    artifacts.contextPressure = pressure;
    const unresolved = unresolvedFailedVerificationEvidence(wf.evidence || []);
    if (pressure.level >= 1 && unresolved.length) {
      const latest = unresolved[unresolved.length - 1];
      artifacts.recovery = this._activateRecovery(wf, artifacts, {
        reason: 'context_pressure_after_failed_verification',
        failedCount: unresolved.length,
        latestFailedCommand: latest.command || latest.tool || '',
        triggerTool: latest.tool,
      });
    }
    const active = artifacts.recovery?.active;
    this._update(wf.id, {
      phase: active ? 'debug' : wf.phase,
      status: active ? 'recovery' : wf.status,
      activeRules: this._rulesForPhase(active ? 'debug' : wf.phase),
      artifacts,
      evidence: wf.evidence,
    });
    return this.getStatus(sessionKey);
  }

  _alreadySatisfiedClaim(text = '') {
    return /\b(already|no\s+change|no\s+action|exists|correct|not\s+needed|not\s+applicable|out\s+of\s+scope|nothing\s+to\s+do)\b/i.test(text || '');
  }

  _hasConcreteEvidenceCitation(text = '') {
    const s = String(text || '');
    return /\b(?:line|lines)\s+\d+\b/i.test(s)
      || /[\w./\\-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|cs|rb|php|css|html|json|ya?ml|md|toml):\d+\b/i.test(s)
      || /\b(?:read_file|grep|get_snippet|search_symbols|trace_calls|verify_implementation|git_diff|git_status)\b/i.test(s)
      || /\b(?:exit(?:ed)?\s*(?:code\s*)?\d+|exitCode\s*[:=]\s*\d+)\b/i.test(s)
      || /\b(?:npm|pnpm|yarn|bun|npx|go|cargo|pytest|python|python3|node|next|eslint)\s+(?:run\s+)?[\w:./@-]+/i.test(s)
      || /\b(?:stdout|stderr|output|log\s+(?:file|path))\b/i.test(s);
  }

  _taskDoneBlock(wf, input = {}) {
    if (!wf || !input || input.status !== 'done') return null;
    if (!['execute', 'verify', 'debug'].includes(wf.phase)) return null;
    const taskId = input.id;
    const kind = this._workflowTaskKind(wf, taskId);
    if (!kind) return null;
    const row = this._workflowTaskRow(wf, taskId);
    if (!row) return null;
    const evidence = Array.isArray(wf.evidence) ? wf.evidence : [];
    const note = [input.note, input.result, input.reason, input.evidence].filter(Boolean).join('\n');
    const evidenceGuidance = 'Use `task_progress({id, status:"error", note:"..."})` for a failed/missing step, or re-read/verify the exact file and include concrete evidence such as `path:line`, `read_file`, `grep`, or `verify_implementation` in the done note.';

    if (this._alreadySatisfiedClaim(note) && !this._hasConcreteEvidenceCitation(note)) {
      return {
        error: `BLOCKED: Workflow task ${taskId} cannot be marked done with an "already/no action" claim that lacks concrete evidence. ${evidenceGuidance}`,
        blocked: true,
        tool: 'task_progress',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        task: { id: taskId, subject: row.subject, kind },
      };
    }

    const unresolvedFailures = unresolvedFailedVerificationEvidence(evidence);
    const noteClassifiesFailure = /\b(?:pre-?existing|unrelated|known\s+failure|outside\s+scope|not\s+caused\s+by)\b/i.test(note)
      && this._hasConcreteEvidenceCitation(note);
    if (kind === 'verification' && unresolvedFailures.length && !noteClassifiesFailure) {
      const latest = unresolvedFailures[unresolvedFailures.length - 1];
      return {
        error: `BLOCKED: Verification task ${taskId} cannot be marked done while the latest verification evidence is failed (${formatEvidenceCommand(latest)}: ${evidenceLabel(latest)}). Fix/rerun the check, mark the task error/blocked, or classify it as unrelated/pre-existing with concrete evidence in the note.`,
        blocked: true,
        tool: 'task_progress',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        task: { id: taskId, subject: row.subject, kind },
      };
    }

    if (kind === 'verification' && !this._hasVerificationEvidence(evidence)) {
      return {
        error: `BLOCKED: Verification task ${taskId} cannot be marked done before a successful verification tool/command is recorded. Run the planned check first, then mark it done with the exact command/outcome.`,
        blocked: true,
        tool: 'task_progress',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        task: { id: taskId, subject: row.subject, kind },
      };
    }

    if (kind === 'step' && !this._alreadySatisfiedClaim(note) && !this._hasImplementationEvidence(evidence)) {
      return {
        error: `BLOCKED: Implementation task ${taskId} cannot be marked done before successful write/edit/exec evidence exists. Do the work first, or mark it error/blocked if the planned step is wrong.`,
        blocked: true,
        tool: 'task_progress',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        task: { id: taskId, subject: row.subject, kind },
      };
    }

    return null;
  }

  _taskProgressBlock(wf, input = {}) {
    if (!wf || !input) return null;
    if (!['execute', 'verify', 'debug'].includes(wf.phase)) return null;
    const taskId = input.id;
    const kind = this._workflowTaskKind(wf, taskId);
    if (!kind) return null;
    const row = this._workflowTaskRow(wf, taskId);
    if (!row) return null;
    const status = String(input.status || '').trim();

    if (status === 'in_progress') {
      if (row.status === 'in_progress') {
        return {
          error: `NOOP: Workflow task ${taskId} is already in_progress. Continue the current work or mark it done/blocked/error when its state changes; do not re-mark it in_progress.`,
          blocked: true,
          tool: 'task_progress',
          reason: 'task_already_in_progress',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
          task: { id: taskId, subject: row.subject, kind, status: row.status },
        };
      }
      const currentRow = { ...row, kind };
      const currentGroup = this._parallelGroupForTask(currentRow);
      const active = this._taskRows(wf).filter(r => r.status === 'in_progress' && r.id !== taskId);
      const conflicting = active.find(other => {
        const otherGroup = this._parallelGroupForTask(other);
        return !currentGroup || !otherGroup || currentGroup !== otherGroup;
      });
      if (conflicting) {
        return {
          error: [
            `BLOCKED: Workflow task ${conflicting.id} (${conflicting.subject}) is already in_progress.`,
            `Finish, block, or error that task before starting ${taskId}.`,
            'Only tasks from the same explicit [parallel: group] can be in_progress together.',
          ].join(' '),
          blocked: true,
          tool: 'task_progress',
          reason: 'another_task_in_progress',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
          task: { id: taskId, subject: row.subject, kind, status: row.status },
          activeTask: { id: conflicting.id, subject: conflicting.subject, kind: conflicting.kind, status: conflicting.status },
        };
      }
      return null;
    }

    if (status === 'blocked') {
      const reason = String(input.reason || '').trim();
      const details = [reason, input.evidence, input.note, input.result].filter(Boolean).join('\n');
      if (/(?:\bpre[-_\s]?existing(?:[-_\s]?failure)?\b|\bunrelated(?:[-_\s]?failure)?\b|\boutside\s+scope\b|\bexternal\s+blocker\b|\benvironment\s+blocker\b|\bknown\s+failure\b)/i.test(details)
        && !/\b(?:evidence|command|git_diff|git_status|read_file|grep|log|output|exit|failed|passes?|passed)\b/i.test(details)) {
        return {
          error: `BLOCKED: Task ${taskId} can only be marked blocked for an unrelated/pre-existing issue when the note/result includes concrete evidence. Include the exact command/output, git_diff/git_status, log path, or file evidence.`,
          blocked: true,
          tool: 'task_progress',
          reason: 'blocked_task_lacks_evidence',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
          task: { id: taskId, subject: row.subject, kind, status: row.status },
        };
      }
      return null;
    }

    return this._taskDoneBlock(wf, input);
  }

  _taskCreateBlock(wf, input = {}) {
    if (!wf?.artifacts?.tasksCreated) return null;
    if (!['execute', 'verify', 'debug'].includes(wf.phase)) return null;
    const subject = String(input.subject || input.title || '').trim();
    const description = String(input.description || '').trim();
    if (!subject && !description) return null;
    const candidate = [subject, description].filter(Boolean).join(' ');
    const existing = this._taskRows(wf).find(row => taskTextSimilar(candidate, [row.subject, row.description].filter(Boolean).join(' ')));
    if (!existing) return null;
    return {
      error: [
        'BLOCKED: The approved plan already has a workflow task for this work.',
        `Use existing task ${existing.id} (${existing.subject}) with \`task_progress\` instead of creating a duplicate.`,
        'Call `workflow_status` if you need the current task ids.',
      ].join(' '),
      blocked: true,
      tool: 'task_create',
      reason: 'duplicate_workflow_task',
      workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
      task: { id: existing.id, subject: existing.subject, status: existing.status, kind: existing.kind || 'task' },
    };
  }

  _destructiveGitBlock(wf, input = {}) {
    const command = String(input?.command || '').trim();
    const reason = destructiveGitCommand(command);
    if (!reason) return null;
    return {
      error: [
        `BLOCKED: Destructive git command is not allowed from Spore Code by default: ${command.slice(0, 180)}`,
        '`git restore`, `git checkout --`, `git reset`, and `git clean` can delete or overwrite user WIP.',
        'Use `git_status`/`git_diff` to inspect, then ask the user explicitly before discarding or restoring files.',
      ].join(' '),
      blocked: true,
      tool: 'exec',
      reason,
      workflow: {
        id: wf.id,
        phase: wf.phase,
        policy: wf.policy,
        protectedWipPaths: wf.artifacts?.protectedWipPaths || null,
      },
    };
  }

  _staleEditBlock(wf, input = {}) {
    const failures = wf.artifacts?.staleEditFailures || null;
    if (!failures || typeof failures !== 'object') return null;
    const filePath = normalizeWorkflowPath(input?.path || input?.file || input?.filePath || '');
    if (!filePath) return null;
    const stale = failures[filePath];
    if (!stale) return null;
    const oldText = String(input?.old_text ?? input?.old_string ?? input?.oldString ?? input?.old_blob ?? input?.oldBlob ?? input?.old_str ?? input?.oldStr ?? input?.old ?? '');
    if (!oldText || hash(oldText) !== stale.oldTextHash) return null;
    return {
      error: [
        `BLOCKED: This exact edit already failed because old_text was stale for ${filePath}.`,
        'Read the current file contents with `read_file` or `get_snippet`, then retry with exact current text.',
        'Do not repeat the same edit_file payload.',
      ].join(' '),
      blocked: true,
      tool: 'edit_file',
      reason: 'stale_edit_retry',
      workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
    };
  }

  _malformedToolInputBlock(wf, normalized, input = {}) {
    if (normalized === 'edit_file') {
      const oldText = firstToolString(input, ['old_text', 'old_string', 'oldString', 'old_blob', 'oldBlob', 'old_str', 'oldStr', 'old', 'find', 'search']);
      const newText = firstToolString(input, ['new_text', 'new_string', 'newString', 'new_blob', 'newBlob', 'new_str', 'newStr', 'new', 'replace', 'replacement'], { allowEmpty: true });
      if (!oldText || newText == null) {
        return {
          error: [
            'BLOCKED: edit_file requires exact `old_text` and `new_text` fields.',
            'Aliases `old_string`/`new_string`, `old_blob`/`new_blob`, and `old_str`/`new_str` are accepted, but line_start/line_end style edits are not.',
            'Read the current file range, then call edit_file with the exact current text to replace.',
          ].join(' '),
          blocked: true,
          tool: 'edit_file',
          reason: 'edit_file_missing_required_text',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        };
      }
    }
    if (normalized === 'patch_file') {
      const hasPatch = firstToolString(input, ['patch', 'diff'], { allowEmpty: true });
      const inventedStructuredPatch = ['edits', 'edit_type', 'line_start', 'line_end', 'start_line', 'end_line', 'old_text', 'new_text']
        .some(key => hasOwn(input, key));
      if ((hasPatch == null || !String(hasPatch).trim()) && inventedStructuredPatch) {
        return {
          error: [
            'BLOCKED: patch_file only accepts a unified diff string in `patch`.',
            'It does not accept edits/edit_type/line_start/line_end structured edits.',
            'Use edit_file with exact old_text/new_text for one replacement, or build a real unified diff for patch_file.',
          ].join(' '),
          blocked: true,
          tool: 'patch_file',
          reason: 'patch_file_requires_unified_diff',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
        };
      }
    }
    return null;
  }

  _windowsExecBlock(wf, input = {}) {
    if (!isWindowsProject(wf.artifacts?.project || {})) return null;
    const command = String(input?.command || '').trim();
    const utility = windowsPosixCommandIssue(command);
    if (!utility) return null;
    const structured = utility === 'cat'
      ? 'read_file/read_many_files'
      : utility === 'ls'
        ? 'list_dir/glob'
        : utility === 'grep'
          ? 'grep'
          : null;
    return {
      error: [
        `BLOCKED: Windows Spore Code exec runs through cmd.exe by default, and this command uses POSIX utility \`${utility}\`: ${command.slice(0, 180)}`,
        structured
          ? `Use the structured ${structured} tool instead.`
          : 'Use a Windows-native command, `powershell_exec` for PowerShell pipelines, or a project tool that works on Windows.',
        'Do not retry the same Unix shell fragment.',
      ].join(' '),
      blocked: true,
      tool: 'exec',
      reason: 'windows_posix_command',
      workflow: { id: wf.id, phase: wf.phase, policy: wf.policy },
    };
  }

  _recoveryToolBlock(wf, normalized, input = {}) {
    const recovery = wf.artifacts?.recovery || null;
    if (!recovery?.active) return null;
    const evidence = Array.isArray(wf.evidence) ? wf.evidence : [];
    if (!unresolvedFailedVerificationEvidence(evidence).length) return null;
    const hasStatus = !!this._latestRecoveryStatusEvidence(evidence, recovery);
    const recoveryMeta = {
      active: true,
      reason: recovery.reason,
      latestFailedCommand: recovery.latestFailedCommand || null,
      statusEvidenceAt: recovery.statusEvidenceAt || null,
    };

    const statusGuidance = 'First collect recovery evidence with `git_status` and, when useful, `git_diff`; then make one narrow fix or report the blocker.';
    const command = String(input?.command || '').trim();
    const gitStatusExec = normalized === 'exec' && /\bgit\s+(?:status|diff)\b/i.test(command);
    const allowedBeforeStatus = RECOVERY_STATUS_TOOLS.has(normalized)
      || normalized === 'workflow_status'
      || normalized === 'request_planner_advice'
      || gitStatusExec;
    if (!hasStatus && !allowedBeforeStatus) {
      return {
        error: `BLOCKED: Workflow recovery is active after repeated failed verification. ${statusGuidance}`,
        blocked: true,
        tool: normalized,
        reason: 'workflow_recovery_requires_status',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy, recovery: recoveryMeta },
      };
    }

    if (normalized === 'write_file') {
      const contentLen = String(input?.content || '').length;
      if (contentLen > RECOVERY_WRITE_FILE_CHAR_LIMIT) {
        return {
          error: [
            `BLOCKED: Workflow recovery is active and this write_file payload is large (${contentLen} chars).`,
            'Large generated rewrites after failed verification are unsafe.',
            'Use `read_file`/`grep` to locate exact source, then `edit_file` or `patch_file` for a narrow fix.',
          ].join(' '),
          blocked: true,
          tool: normalized,
          reason: 'workflow_recovery_large_write',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy, recovery: recoveryMeta },
        };
      }
    }

    if (normalized === 'exec' && hasStatus && commandLooksBuildOrVerification(command)) {
      const latestSameFailure = this._latestSameFailedVerification(evidence, recovery, normalized, command);
      if (latestSameFailure && !this._hasFileMutationSince(evidence, latestSameFailure.ts)) {
        return {
          error: [
            'BLOCKED: Workflow recovery is active and this verification command already failed without a relevant file change since then.',
            `Last failed command: ${command.slice(0, 180)}`,
            'Use the exact error to make one narrow edit, or report the blocker. Do not rerun the same check unchanged.',
          ].join(' '),
          blocked: true,
          tool: normalized,
          reason: 'workflow_recovery_duplicate_verification',
          workflow: { id: wf.id, phase: wf.phase, policy: wf.policy, recovery: recoveryMeta },
        };
      }
    }

    if (normalized === 'exec' && hasStatus && !commandLooksStatusOrVerification(input?.command || '')) {
      return {
        error: [
          'BLOCKED: Workflow recovery is active. Exec is limited to status and verification commands until the failed check is fixed or explicitly reported.',
          'Use structured file tools for edits and inspection.',
        ].join(' '),
        blocked: true,
        tool: normalized,
        reason: 'workflow_recovery_exec_scope',
        workflow: { id: wf.id, phase: wf.phase, policy: wf.policy, recovery: recoveryMeta },
      };
    }

    return null;
  }

  toolBlockForTool(sessionKey, toolName, input = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const normalized = normalizeToolName(toolName);
    const malformedBlock = this._malformedToolInputBlock(wf, normalized, input || {});
    if (malformedBlock) return malformedBlock;
    if (normalized === 'task_create') {
      const taskBlock = this._taskCreateBlock(wf, input || {});
      if (taskBlock) return taskBlock;
    }
    if (normalized === 'task_progress') {
      return this._taskProgressBlock(wf, input || {});
    }
    if (normalized === 'exec') {
      const gitBlock = this._destructiveGitBlock(wf, input || {});
      if (gitBlock) return gitBlock;
      const windowsBlock = this._windowsExecBlock(wf, input || {});
      if (windowsBlock) return windowsBlock;
    }
    if (normalized === 'edit_file') {
      const staleBlock = this._staleEditBlock(wf, input || {});
      if (staleBlock) return staleBlock;
    }
    const recoveryBlock = this._recoveryToolBlock(wf, normalized, input || {});
    if (recoveryBlock) return recoveryBlock;
    if (!MUTATING_TOOLS.has(normalized)) return null;
    if (!['intake', 'research', 'plan'].includes(wf.phase)) return null;
    return {
      error: `BLOCKED: Spore Code workflow phase "${wf.phase}" is read-only. The ${normalized} tool is unavailable until the workflow enters execute mode.`,
      blocked: true,
      workflow: {
        id: wf.id,
        phase: wf.phase,
        policy: wf.policy,
      },
      tool: normalized,
    };
  }

  recordFinalText(sessionKey, opts = {}, text = '') {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const artifacts = { ...(wf.artifacts || {}) };
    let phase = wf.phase;
    let status = wf.status;
    const trimmed = String(text || '').trim();
    if (/^\s*QUESTIONS:/m.test(trimmed)) {
      artifacts.questions = { capturedAt: nowMs(), preview: trimmed.slice(0, 1200) };
      phase = 'intake';
      status = 'waiting_user';
      this._event(wf.id, sessionKey, 'questions', { chars: trimmed.length });
    }
    if (/^\s*NO_INTERVIEW_NEEDED:/m.test(trimmed)) {
      artifacts.noInterviewNeeded = { capturedAt: nowMs(), preview: trimmed.slice(0, 600) };
      phase = 'intake';
      status = 'artifact_ready';
      this._event(wf.id, sessionKey, 'no_interview_needed', { chars: trimmed.length });
    }
    if (/^\s*RESEARCH_DONE:/m.test(trimmed)) {
      artifacts.researchDone = { capturedAt: nowMs(), preview: trimmed.slice(0, 2400) };
      phase = 'research';
      status = 'artifact_ready';
      this._event(wf.id, sessionKey, 'research_done', { chars: trimmed.length });
    }
    if (/^\s*NO_FOLLOWUP_QUESTIONS:/m.test(trimmed)) {
      artifacts.noFollowupQuestions = { capturedAt: nowMs(), preview: trimmed.slice(0, 600) };
      phase = 'research';
      status = 'artifact_ready';
      this._event(wf.id, sessionKey, 'no_followup_questions', { chars: trimmed.length });
    }
    if (/^\s*PLAN_READY\s*$/m.test(trimmed)) {
      const parsed = parsePlanArtifacts(trimmed);
      artifacts.planReady = { capturedAt: nowMs(), preview: trimmed.slice(0, 4000) };
      artifacts.steps = parsed.steps;
      artifacts.verification = parsed.verification;
      artifacts.tasksCreated = false;
      phase = 'plan';
      status = 'awaiting_approval';
      this._event(wf.id, sessionKey, 'plan_ready', {
        steps: parsed.steps.length,
        verification: parsed.verification.length,
      });
    }
    if (!/^\s*(QUESTIONS:|NO_INTERVIEW_NEEDED:|RESEARCH_DONE:|NO_FOLLOWUP_QUESTIONS:|PLAN_READY\s*$)/m.test(trimmed)
      && ['execute', 'verify', 'debug'].includes(phase)
      && finalClaimsComplete(trimmed)) {
      const tasks = this._taskSummary(wf);
      const unresolved = this._unresolvedTaskRows(wf).length;
      const hasUnresolvedFailedVerification = unresolvedFailedVerificationEvidence(wf.evidence || []).length > 0;
      const classifiedUnrelatedFailure = hasUnresolvedFailedVerification
        && finalAcknowledgesVerificationFailure(trimmed)
        && /(?:\bpre[-_\s]?existing(?:[-_\s]?failure)?\b|\bunrelated(?:[-_\s]?failure)?\b|\boutside\s+scope\b|\bexternal\b|\benvironment\b|\bknown\s+failure\b)/i.test(trimmed)
        && this._hasConcreteEvidenceCitation(trimmed);
      if ((!hasUnresolvedFailedVerification || classifiedUnrelatedFailure) && (tasks.total === 0 || unresolved === 0)) {
        phase = 'complete';
        status = 'complete';
        this._event(wf.id, sessionKey, 'complete', { tasks: tasks.total });
      }
    }
    this._update(wf.id, {
      phase,
      status,
      activeRules: this._rulesForPhase(phase),
      artifacts,
      evidence: wf.evidence,
    });
    return this.getStatus(sessionKey);
  }

  shouldPersistFinalText(sessionKey, text = '') {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return true;
    return !isHiddenWorkflowControlText(text);
  }

  hiddenControlKind(sessionKey, text = '') {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    return isHiddenWorkflowControlText(text) ? workflowControlKind(text) : null;
  }

  ensureExecutionTasks(sessionKey, route = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return { created: [], workflow: null };
    const artifacts = { ...(wf.artifacts || {}) };
    if (artifacts.tasksCreated) return { created: [], workflow: this.getStatus(sessionKey) };
    const steps = Array.isArray(artifacts.steps) ? artifacts.steps : [];
    const verification = Array.isArray(artifacts.verification) ? artifacts.verification : [];
    if (!steps.length && !verification.length) return { created: [], workflow: this.getStatus(sessionKey) };

    const created = [];
    const stepTaskIds = [];
    const verificationTaskIds = [];
    const now = nowMs();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO tasks
        (id, subject, description, status, owner, blocked_by, channel_id, session_key, user_id, priority, created, updated)
      VALUES (?, ?, ?, 'pending', 'workflow', ?, ?, ?, ?, ?, ?, ?)
    `);
    const addTask = (kind, item, idx) => {
      const id = `wf-${hash(`${wf.id}:${kind}:${idx}:${item.subject}`)}`;
      insert.run(
        id,
        item.subject || `${kind} ${idx + 1}`,
        item.raw || item.subject || '',
        '[]',
        route.channelId || null,
        sessionKey,
        route.userId || null,
        kind === 'verification' ? 2 : 3,
        now,
        now,
      );
      created.push({ id, subject: item.subject, description: item.raw || '', kind });
      return id;
    };
    steps.forEach((item, idx) => stepTaskIds.push(addTask('step', item, idx)));
    verification.forEach((item, idx) => verificationTaskIds.push(addTask('verification', item, idx)));
    artifacts.stepTaskIds = stepTaskIds;
    artifacts.verificationTaskIds = verificationTaskIds;
    artifacts.tasksCreated = true;
    artifacts.tasksCreatedAt = now;
    this._update(wf.id, {
      phase: 'execute',
      status: 'active',
      activeRules: this._rulesForPhase('execute'),
      artifacts,
      evidence: wf.evidence,
    });
    this._event(wf.id, sessionKey, 'tasks_created', { steps: stepTaskIds.length, verification: verificationTaskIds.length });
    return { created, workflow: this.getStatus(sessionKey) };
  }

  recordToolResult(sessionKey, toolName, input, result) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const normalized = normalizeToolName(toolName);
    const evidence = Array.isArray(wf.evidence) ? wf.evidence.slice() : [];
    const backgroundId = result?.processId ?? result?.id ?? input?.id ?? null;
    const inferredBackgroundCommand = normalized === 'bg_tail' && backgroundId != null
      ? [...evidence].reverse().find(e => e?.pending && e.processId != null && String(e.processId) === String(backgroundId))?.command
      : null;
    const command = input?.command
      || input?.cmd
      || result?.command
      || result?.sourceCommand
      || result?.cmd
      || inferredBackgroundCommand
      || input?.path
      || input?.qnames?.join?.(', ')
      || '';
    const rawText = resultText(result);
    const gitStatusNotRepo = normalized === 'git_status' && gitStatusNotRepoText(rawText);
    const pendingBackground = resultPendingBackground(result);
    const failed = gitStatusNotRepo ? false : resultFailed(result);
    const preview = compactResultPreview(result);
    const fullText = normalized === 'git_status' ? rawText : preview;
    const entry = {
      ts: nowMs(),
      tool: normalized,
      command: String(command || '').slice(0, 240),
      ok: !failed,
      exitCode: resultExitCode(result),
      pending: pendingBackground || undefined,
      backgrounded: result?.backgrounded || undefined,
      running: result?.running || undefined,
      processId: backgroundId ?? undefined,
      testCommand: pendingBackground ? false : commandLooksTest(command),
      buildOrVerification: pendingBackground ? false : commandLooksBuildOrVerification(command),
      filtered: commandLooksFiltered(command),
      fullSuite: pendingBackground ? false : commandLooksFullSuite(command),
      goFmt: pendingBackground ? false : commandLooksGoFmt(command),
      untrackedWhitespaceCheck: pendingBackground ? false : commandLooksUntrackedWhitespaceCheck(command),
      testCounts: extractTestCounts(preview),
      gitStatus: normalized === 'git_status'
        ? (gitStatusNotRepo
          ? { count: 0, tracked: [], untracked: [], paths: [], notRepo: true }
          : parseGitStatusChanged(fullText))
        : null,
      notRepo: gitStatusNotRepo || undefined,
      preview,
    };
    evidence.push(entry);

    const artifacts = { ...(wf.artifacts || {}) };
    const hadActiveRecovery = !!artifacts.recovery?.active;
    if (entry.ok && normalized === 'git_status' && entry.gitStatus && !entry.gitStatus.notRepo
      && !artifacts.protectedWipPaths && Array.isArray(entry.gitStatus.paths) && entry.gitStatus.paths.length
      && ['execute', 'verify', 'debug'].includes(wf.phase)) {
      artifacts.protectedWipPaths = {
        capturedAt: entry.ts,
        paths: entry.gitStatus.paths.slice(0, 120),
        tracked: (entry.gitStatus.tracked || []).slice(0, 120),
        untracked: (entry.gitStatus.untracked || []).slice(0, 120),
      };
      this._event(wf.id, sessionKey, 'protected_wip_snapshot', {
        count: entry.gitStatus.paths.length,
        tracked: (entry.gitStatus.tracked || []).length,
        untracked: (entry.gitStatus.untracked || []).length,
      });
    }

    const staleEditFailures = { ...(artifacts.staleEditFailures || {}) };
    const filePath = normalizeWorkflowPath(input?.path || input?.file || input?.filePath || '');
    if (entry.ok && filePath && ['read_file', 'get_snippet'].includes(normalized)) {
      delete staleEditFailures[filePath];
    }
    if (normalized === 'edit_file' && filePath) {
      if (!entry.ok && /old_(?:text|string)\s+not\s+found|not\s+found\s+in\s+file/i.test(rawText || preview)) {
        staleEditFailures[filePath] = {
          failedAt: entry.ts,
          oldTextHash: hash(input?.old_text ?? input?.old_string ?? input?.oldString ?? input?.old_blob ?? input?.oldBlob ?? input?.old_str ?? input?.oldStr ?? input?.old ?? ''),
          preview: String(preview || '').slice(0, 240),
        };
      } else if (entry.ok) {
        delete staleEditFailures[filePath];
      }
    }
    if (Object.keys(staleEditFailures).length) artifacts.staleEditFailures = staleEditFailures;
    else delete artifacts.staleEditFailures;

    artifacts.recovery = this._updateRecoveryForEntry(wf, artifacts, evidence, entry);

    let phase = wf.phase;
    let status = wf.status === 'awaiting_approval' ? 'active' : wf.status;
    if (failed && FAILURE_TOOLS.has(normalized)) {
      phase = 'debug';
      status = 'active';
      this._event(wf.id, sessionKey, 'debug_entered', {
        tool: normalized,
        command: entry.command,
        exitCode: entry.exitCode,
      });
    } else {
      this._event(wf.id, sessionKey, 'tool_evidence', {
        tool: normalized,
        ok: entry.ok,
        fullSuite: entry.fullSuite,
        filtered: entry.filtered,
      });
    }
    if (artifacts.recovery?.active) {
      phase = 'debug';
      status = 'recovery';
    } else if (hadActiveRecovery) {
      phase = 'execute';
      status = 'active';
    }

    this._update(wf.id, {
      phase,
      status,
      activeRules: this._rulesForPhase(phase),
      artifacts,
      evidence,
    });
    return this.getStatus(sessionKey);
  }

  finalRepairPrompt(sessionKey, text = '') {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    if (!['execute', 'verify', 'debug'].includes(wf.phase)) return null;
    const evidence = Array.isArray(wf.evidence) ? wf.evidence : [];
    const mutatingEvidence = evidence.filter(e => MUTATING_TOOLS.has(e.tool) && e.tool !== 'bg_tail');
    const fileMutationEvidence = evidence.filter(e => FILE_MUTATING_TOOLS.has(e.tool));
    const latestGitStatus = [...evidence].reverse().find(e => e.tool === 'git_status' && e.ok && e.gitStatus);
    const observedTestCounts = [...new Set(evidence.flatMap(e => Array.isArray(e.testCounts) ? e.testCounts : []))];
    const claimedTestCounts = finalClaimedTestCounts(text);
    const testEvidence = evidence.filter(e => e.testCommand || e.fullSuite || e.filtered || (Array.isArray(e.testCounts) && e.testCounts.length));
    const claimedChangedFileCount = finalClaimedChangedFileCount(text);
    const untrackedPaths = latestGitStatus?.gitStatus?.untracked || [];
    const changedGoPaths = (latestGitStatus?.gitStatus?.paths || []).filter(p => /\.go$/i.test(p));
    const hasUntrackedWhitespaceCheck = evidence.some(e => e.ok && e.untrackedWhitespaceCheck);
    const hasGoFmt = evidence.some(e => e.ok && e.goFmt);
    const unresolvedVerificationFailures = unresolvedFailedVerificationEvidence(evidence);

    if (finalClaimsComplete(text)
      && unresolvedVerificationFailures.length
      && !finalAcknowledgesVerificationFailure(text)) {
      return finalToolRepairPrompt('failed verification evidence is unresolved', [
        `Latest failed verification: ${unresolvedVerificationFailures.slice(-3).map(e => `${formatEvidenceCommand(e)} (${evidenceLabel(e)})`).join('; ')}.`,
        'Do not say verification is complete or passing.',
        'Either fix and rerun one relevant failing check, or report the failed verification as the current blocker.',
      ]);
    }

    if (finalClaimsComplete(text) && fileMutationEvidence.length > 0 && !latestGitStatus) {
      return finalToolRepairPrompt('missing current git_status after changes', [
        'Call `git_status` before finalizing.',
        'After `git_status` returns, summarize tracked and untracked changed paths plus exact verification evidence.',
        'If `git_status` fails, report the exact failure and do not claim changed paths are known.',
      ]);
    }

    if (claimedChangedFileCount != null && mutatingEvidence.length > 0 && !latestGitStatus) {
      return finalToolRepairPrompt('missing current git_status after changed-file claim', [
        'Call `git_status` before finalizing a changed-file count.',
        'After `git_status` returns, use its exact tracked/untracked path count.',
      ]);
    }

    const harmlessNoFileChangeClaim = finalOnlyClaimsNoFileChanges(text) && fileMutationEvidence.length === 0;
    const alreadySatisfiedNeedsEvidence = finalClaimsAlreadySatisfied(text)
      && finalClaimsNoActionClosure(text)
      && !harmlessNoFileChangeClaim
      && !this._hasConcreteEvidenceCitation(text);
    if (alreadySatisfiedNeedsEvidence) {
      return finalRepairPromptFor(text, [
        '[SYSTEM: Your final response appears to say something was already correct/no action was needed,',
        'but the response does not cite concrete evidence for that claim.',
        'Repair the response now. Either cite the exact evidence (`path:line`, read_file/grep/get_snippet/verify_implementation),',
        'or say the claim is unverified and list the next check. Do not call tools in this repair turn.',
        'Do not present "already done" as fact without evidence.]',
      ]);
    }

    if (finalClaimsFullSuite(text)) {
      const hasFullSuite = evidence.some(e => e.ok && e.fullSuite && !e.filtered);
      if (!hasFullSuite) {
        return finalRepairPromptFor(text, [
          '[SYSTEM: Your final response appears to claim that all tests or the full suite passed,',
          'but the workflow evidence does not contain an unfiltered full-suite command result.',
          'Repair the response now. State only the exact checks that ran, say "focused" or name the test file when a filter/named test was used,',
          'and do not claim all/full-suite passing unless the evidence proves it. Do not call tools in this repair turn.]',
        ]);
      }
    }

    if (claimedTestCounts.length && testEvidence.length) {
      const unsupported = claimedTestCounts.filter(n => !observedTestCounts.includes(n));
      if (unsupported.length) {
        return finalRepairPromptFor(text, [
          `[SYSTEM: Your final response claims test count(s) ${unsupported.join(', ')},`,
          `but observed tool output only supports count(s) ${observedTestCounts.join(', ') || 'none'}.`,
          'Repair the response now using only exact command/output evidence. Do not invent or round test counts. Do not call tools in this repair turn.]',
        ]);
      }
    }

    if (claimedChangedFileCount != null && latestGitStatus?.gitStatus?.count != null && claimedChangedFileCount !== latestGitStatus.gitStatus.count) {
      return finalRepairPromptFor(text, [
        `[SYSTEM: Your final response says ${claimedChangedFileCount} changed file(s),`,
        `but git_status evidence shows ${latestGitStatus.gitStatus.count} changed path(s): ${latestGitStatus.gitStatus.paths.slice(0, 12).join(', ')}.`,
        'Repair the response now with accurate tracked and untracked file counts. Do not call tools in this repair turn.]',
      ]);
    }

    const admitsTrackedOnlyWhitespace = /\bonly\s+tracked\b.{0,80}\b(?:whitespace|diff --check)\b|\buntracked\b.{0,80}\bnot\s+(?:whitespace\s+)?checked\b/i.test(text || '');
    if (untrackedPaths.length && finalClaimsWhitespaceClean(text) && !hasUntrackedWhitespaceCheck && !admitsTrackedOnlyWhitespace) {
      return finalRepairPromptFor(text, [
        `[SYSTEM: git_status shows untracked changed file(s): ${untrackedPaths.slice(0, 12).join(', ')}.`,
        '`git diff --check` does not cover untracked files. Repair the response now using only recorded evidence.',
        'Do not call tools in this repair turn. Explicitly state that only tracked diff whitespace was checked.]',
      ]);
    }

    if (untrackedPaths.length && finalClaimsComplete(text) && !finalMentionsUntracked(text)) {
      return finalRepairPromptFor(text, [
        `[SYSTEM: git_status shows untracked changed file(s): ${untrackedPaths.slice(0, 12).join(', ')}.`,
        'Repair the response now so the change summary explicitly separates tracked and untracked files. Do not call tools in this repair turn.]',
      ]);
    }

    if (changedGoPaths.length && finalClaimsComplete(text) && !hasGoFmt) {
      return finalRepairPromptFor(text, [
        `[SYSTEM: git_status shows changed Go file(s): ${changedGoPaths.slice(0, 12).join(', ')}.`,
        'Repair the response now using only recorded evidence. Do not call tools in this repair turn.',
        'Do not imply gofmt has run; state that formatting evidence is missing and name the next command to run.]',
      ]);
    }

    if (finalClaimsComplete(text)) {
      const taskSummary = this._taskSummary(wf);
      const unresolved = this._unresolvedTaskRows(wf).length;
      if (taskSummary.total > 0 && unresolved > 0) {
        return finalContinueExecutionPrompt(`workflow checklist is not complete (${unresolved}/${taskSummary.total} tasks unresolved)`);
      }
    }
    return null;
  }

  finalRepairIssue(sessionKey, text = '') {
    const prompt = this.finalRepairPrompt(sessionKey, text);
    if (!prompt) return null;
    const reason = repairReasonForPrompt(prompt);
    const toolNames = reason === 'missing current git_status after changes'
      ? ['git_status']
      : reason === 'failed verification evidence is unresolved'
        ? ['exec', 'run_tests', 'git_status', 'task_progress']
        : null;
    return {
      prompt,
      reason,
      allowTools: reason === 'workflow checklist is not complete'
        || reason === 'missing current git_status after changes'
        || reason === 'failed verification evidence is unresolved',
      toolNames,
    };
  }

  _scrubUnsupportedVerificationFromCandidate(candidate = '', evidence = []) {
    const original = String(candidate || '').trim();
    if (original.length < 40) return null;
    const observedTestCounts = [...new Set(evidence.flatMap(e => Array.isArray(e.testCounts) ? e.testCounts : []))];
    const hasFullSuite = evidence.some(e => e.ok && e.fullSuite && !e.filtered);
    let changed = false;

    const scrubLine = (line) => {
      const raw = String(line || '');
      if (!raw.trim()) return raw;
      const sentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw];
      const kept = sentences.filter(sentence => {
        const unsupportedCounts = finalClaimedTestCounts(sentence).filter(n => !observedTestCounts.includes(n));
        const unsupportedFullSuite = finalClaimsFullSuite(sentence) && !hasFullSuite;
        const unsupportedAllTests = /\ball\s+tests?\s+(?:pass|passed|passing|green)\b/i.test(sentence) && !hasFullSuite;
        if (unsupportedCounts.length || unsupportedFullSuite || unsupportedAllTests) {
          changed = true;
          return false;
        }
        return true;
      });
      return kept.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    };

    const scrubbed = original
      .split(/\r?\n/)
      .map(scrubLine)
      .filter((line, idx, arr) => line.trim() || (idx > 0 && idx < arr.length - 1))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!changed || scrubbed.length < 40) return null;
    const verification = evidence
      .filter(e => e.testCommand || e.fullSuite || e.filtered || e.goFmt || e.untrackedWhitespaceCheck || e.tool === 'run_tests' || e.tool === 'verify_implementation')
      .slice(-4);
    const lines = [scrubbed];
    lines.push('');
    if (verification.length) {
      lines.push('Verification evidence recorded:');
      for (const e of verification) lines.push(`- ${formatEvidenceCommand(e)}: ${evidenceLabel(e)}`);
    } else {
      lines.push('Verification evidence recorded: no full-suite test evidence was recorded in this turn.');
    }
    return lines.join('\n');
  }

  finalFallbackText(sessionKey, opts = {}) {
    const wf = this.get(sessionKey);
    if (!wf || wf.workflow_kind !== 'spore-code') return null;
    const evidence = Array.isArray(wf.evidence) ? wf.evidence : [];
    const latestGitStatus = [...evidence].reverse().find(e => e.tool === 'git_status' && e.ok && e.gitStatus);
    const changed = latestGitStatus?.gitStatus || null;
    const verification = verificationEvidenceList(evidence, 6);
    const taskSummary = this._taskSummary(wf);
    const taskRows = this._taskRows(wf);
    const unresolved = this._unresolvedTaskRows(wf);
    const reason = opts.reason || 'the model final answer did not pass workflow validation';
    const recovery = wf.artifacts?.recovery || null;
    const candidateFallback = this._scrubUnsupportedVerificationFromCandidate(opts.candidate, evidence);
    if (candidateFallback) return candidateFallback;
    const lines = [];

    lines.push('I am stopping here instead of sending another model correction because the workflow guard could not validate the last final answer.');
    lines.push(`Guard reason: ${reason}.`);

    if (recovery?.active) {
      lines.push('');
      lines.push(`Circuit breaker: active (${recovery.reason || 'workflow recovery'}).`);
      if (recovery.latestFailedCommand) lines.push(`Latest failed command: \`${recovery.latestFailedCommand}\`.`);
      lines.push('Recovery rule: collect `git_status`/`git_diff`, then make one narrow fix or report the blocker. Broad writes are blocked until the working tree state is known.');
    }

    if (changed) {
      if (changed.notRepo) {
        lines.push('');
        lines.push('Git status: unavailable because the checked path is not a git repository.');
      } else if (changed.paths.length) {
        lines.push('');
        lines.push('Changed paths from the latest `git_status`:');
        for (const p of changed.paths.slice(0, 12)) {
          const label = changed.untracked.includes(p) ? 'untracked' : 'tracked';
          lines.push(`- ${p} (${label})`);
        }
        if (changed.paths.length > 12) lines.push(`- ...and ${changed.paths.length - 12} more`);
      } else {
        lines.push('');
        lines.push('Changed paths from the latest `git_status`: none.');
      }
    } else if (this._hasFileMutationEvidence(evidence)) {
      lines.push('');
      lines.push('Changed paths: not safely known because no current `git_status` evidence was recorded after edits.');
    }

    lines.push('');
    if (verification.length) {
      lines.push('Verification evidence recorded:');
      for (const e of verification) lines.push(`- ${formatEvidenceCommand(e)}: ${evidenceLabel(e)}`);
    } else {
      lines.push('Verification evidence recorded: none.');
    }

    if (taskSummary.total) {
      const bits = [`${taskSummary.done || 0}/${taskSummary.total} done`];
      if (taskSummary.pending) bits.push(`${taskSummary.pending} pending`);
      if (taskSummary.in_progress) bits.push(`${taskSummary.in_progress} in progress`);
      if (taskSummary.error) bits.push(`${taskSummary.error} error`);
      if (taskSummary.blocked) {
        bits.push(`${taskSummary.blocked} blocked${taskSummary.accepted_blocked ? ` (${taskSummary.accepted_blocked} accepted)` : ''}`);
      }
      lines.push('');
      lines.push(`Workflow tasks: ${bits.join(', ')}.`);
      if (unresolved.length) {
        lines.push('Unresolved tasks:');
        for (const row of unresolved.slice(0, 8)) lines.push(`- ${row.id}: ${row.subject} [${row.kind || 'task'}:${row.status || 'pending'}]`);
      }
    }

    lines.push('');
    lines.push('Safe next step: continue from the evidence above, run any missing status/verification checks, then summarize only what those checks prove.');
    const out = lines.join('\n');
    const prior = this.sessions?.getHistory?.(sessionKey, 3)
      ?.filter(m => m?.role === 'assistant')
      ?.map(m => typeof m.content === 'string' ? m.content : '')
      ?.reverse()
      ?.find(Boolean);
    if (prior && prior.trim() === out.trim()) {
      return [
        'Still blocked by the same workflow evidence issue; I am not repeating the full guard summary.',
        `Reason: ${reason}.`,
        changed
          ? 'Next step: rerun or report the failing verification evidence, then summarize its exact result.'
          : 'Next step: run `git_status`, then rerun or report the failing verification evidence.',
      ].join('\n');
    }
    return out;
  }
}

module.exports = {
  WorkflowManager,
  parsePlanArtifacts,
  classifyPlanModeMessage,
  workflowControlKind,
  isHiddenWorkflowControlText,
  MUTATING_TOOLS,
  FILE_MUTATING_TOOLS,
};
