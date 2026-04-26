// Per-session breadcrumbs + cross-turn failure-fix synthesis.
//
// captureFailureFix: when a tool exec fails in a session and a similar
// exec succeeds shortly after (same command token + overlapping path /
// url target), synthesize a `failure_fix` discovery so the operator
// doesn't have to relearn how to escape that specific gotcha next
// session. Cross-round (within last 5 turns + 30 min wall clock) so
// it catches both immediate retries and "tried other stuff first"
// resolutions. State lives at module scope so the ring buffer survives
// across turns. Cap at 200 sessions; LRU-evict the oldest.
//
// recordRoundCheckpoint: each finished round leaves a breadcrumb on
// the session node's `rounds` aspect:
//   turn N | user prompt | tools | files | exec cmds | reply.
// Capped at the last 50 entries so the session node doesn't balloon.
// Also bumps the turn_count attribute on lifecycle.
//
// Both helpers gate internally on opts.platform === 'cli' + a
// channelId + the session node existing — they're no-ops outside a
// CLI session.

const { noteDiscovery } = require('./discovery');
const sessions = require('./sessions');

const _sessionFailures = new Map();

function captureFailureFix(api, opts, toolLog) {
  if (!(opts.platform === 'cli' && opts.channelId && toolLog?.length)) return;
  const learner = api._appContext?.learner;
  if (!learner?.db) return;
  try {
    const sessKey = String(opts.channelId);
    const buf = _sessionFailures.get(sessKey) || [];
    const now = Date.now();
    let turn = 0;
    try {
      const sessId = 'session-' + sessKey;
      const row = learner.db.prepare(
        "SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='lifecycle' AND a.content LIKE 'turn_count:%'"
      ).get(sessId);
      const m = row && String(row.content).match(/turn_count:\s*(\d+)/);
      if (m) turn = parseInt(m[1], 10);
    } catch { /* silent: best-effort lookup */ }

    const parseCmd = (cmd) => {
      if (typeof cmd !== 'string') return { token: '', target: '' };
      const trimmed = cmd.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
      const parts = trimmed.split(/\s+/);
      let token = (parts[0] || '').toLowerCase();
      if ((token === 'npx' || token === 'pnpx' || token === 'bunx' || token === 'yarn' || token === 'pnpm' || token === 'bun' || token === 'npm') && parts[1]) {
        token = token + ' ' + parts[1].toLowerCase();
      }
      const target = parts.slice(1).find(p => /[\\/.]/.test(p) || p.startsWith('http')) || '';
      return { token, target };
    };

    for (const t of toolLog) {
      if (t.tool !== 'exec') continue;
      let cmd = '';
      try {
        const inp = typeof t.input === 'string' ? JSON.parse(t.input) : t.input;
        cmd = inp?.command || '';
      } catch { /* silent: malformed JSON → fallback */ }
      if (!cmd) continue;
      const parsed = parseCmd(cmd);
      // A tool "failed" if the host reported it (succeeded:false from a
      // result.error key) OR if exec returned a non-zero exit code (CLI
      // shells return {output, exitCode:N} without an error key, so the
      // succeeded check alone misses those).
      const failed = t.succeeded === false || (typeof t.exitCode === 'number' && t.exitCode !== 0);
      if (failed) {
        buf.push({ turn, ts: now, cmd, ...parsed, preview: String(t.resultPreview || '').slice(0, 300), exitCode: t.exitCode ?? null });
        if (buf.length > 10) buf.shift();
      } else {
        const fiveTurnsAgo = turn - 5;
        const thirtyMinAgo = now - 30 * 60 * 1000;
        const match = buf.find(f =>
          f.token === parsed.token &&
          f.turn >= fiveTurnsAgo &&
          f.ts >= thirtyMinAgo &&
          (!parsed.target || !f.target || parsed.target.includes(f.target) || f.target.includes(parsed.target))
        );
        if (match) {
          try {
            const exitStr = (typeof match.exitCode === 'number') ? String(match.exitCode) : '≠0';
            const text = `Failed: ${match.cmd.slice(0, 200)} (exit ${exitStr}). Fixed by: ${cmd.slice(0, 200)}`;
            const ctx = {
              platform: 'cli',
              channelId: sessKey,
              userId: opts.userId || 'anon',
              projectContext: opts.projectContext || null,
            };
            const result = noteDiscovery(api, { text, kind: 'failure_fix' }, ctx);
            if (result?.ok) {
              api.getLogger().info(`failure_fix captured: ${result.nodeId} (${match.token} → ${parsed.token})`);
            }
          } catch (e) {
            api.getLogger().warn(`failure_fix capture failed: ${e.message}`);
          }
          buf.splice(buf.indexOf(match), 1);
        }
      }
    }
    if (!_sessionFailures.has(sessKey) && _sessionFailures.size >= 200) {
      _sessionFailures.delete(_sessionFailures.keys().next().value);
    }
    _sessionFailures.set(sessKey, buf);
  } catch (e) {
    api.getLogger().warn(`failure capture loop failed: ${e.message}`);
  }
}

function recordRoundCheckpoint(api, opts, toolLog, finalText) {
  const learner = api._appContext?.learner;
  if (!(opts.platform === 'cli' && opts.channelId && learner?.db)) return;
  try {
    const turn = sessions.bumpTurnCount(learner, opts.channelId);
    const sessId = 'session-' + opts.channelId;
    const sessExists = learner.db.prepare('SELECT id FROM nodes WHERE id = ?').get(sessId);
    if (!sessExists) return;
    let asp = learner.db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'rounds'").get(sessId);
    if (!asp) {
      learner.db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'rounds', 7, 'session-graph')").run(sessId);
      asp = { id: learner.db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    const parseInput = (t) => {
      if (t == null || t.input == null) return null;
      if (typeof t.input === 'object') return t.input;
      try { return JSON.parse(t.input); } catch { return null; }
    };
    const toolNames = [...new Set(toolLog.map(t => t.tool))].join(',') || 'none';
    const fileSet = new Set();
    const execCmds = [];
    let failedExecs = 0;
    for (const t of toolLog) {
      if (['read_file', 'write_file', 'edit_file'].includes(t.tool)) {
        const inp = parseInput(t);
        const p = inp?.path;
        if (typeof p === 'string') fileSet.add(p);
      }
      if (t.tool === 'exec') {
        const inp = parseInput(t);
        const cmd = inp?.command || '';
        if (cmd) execCmds.push(String(cmd).replace(/\s+/g, ' ').slice(0, 200));
        if (t.succeeded === false || (typeof t.exitCode === 'number' && t.exitCode !== 0)) failedExecs++;
      }
    }
    const files = fileSet.size ? [...fileSet].slice(0, 10).join(' | ') : 'none';
    const execPart = execCmds.length
      ? ` | exec[${execCmds.length}${failedExecs ? `, ${failedExecs} failed` : ''}]: ${execCmds.slice(0, 6).join(' ; ')}${execCmds.length > 6 ? ' …' : ''}`
      : '';
    const userSnip = String(opts.content || '').replace(/\s+/g, ' ').trim().slice(0, 250);
    const replySnip = (finalText || '').replace(/\s+/g, ' ').trim();
    const replyPreview = replySnip.length > 800 ? replySnip.slice(0, 797) + '…' : replySnip;
    const content = `turn ${turn} | user: "${userSnip}" | tools: ${toolNames} | files: ${files}${execPart} | reply: "${replyPreview || '(no text)'}"`;
    learner.db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, 'session-graph', 'session-graph')"
    ).run(asp.id, content);
    const overflow = learner.db.prepare(
      'SELECT id FROM attributes WHERE aspect_id = ? ORDER BY id DESC LIMIT -1 OFFSET 50'
    ).all(asp.id);
    if (overflow.length) {
      const ids = overflow.map(r => r.id);
      learner.db.prepare(`DELETE FROM attributes WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
  } catch (e) {
    api.getLogger().warn(`round checkpoint failed: ${e.message}`);
  }
}

module.exports = { captureFailureFix, recordRoundCheckpoint };
