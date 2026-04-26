// Acorn CLI plugin.
//
// Self-contained — when uninstalled, no acorn-specific behavior runs in
// SPORE core. Bundles:
//   • Reference-node SQL (5 ref-acorn-* migrations + graphcorn-discovery)
//   • /api/acorn/auth      → /api/plugins/acorn-cli/auth
//   • /api/acorn/sessions  → /api/plugins/acorn-cli/sessions
//   • note_discovery tool
//   • Project Context + Plan Mode prompt sections
//   • afterTurn hook: failure_fix synthesis + round_checkpoint breadcrumbs
//   • afterLearn hook: discovered_in edge creation for new entities
//   • beforeMessage hook: project-node upsert + cachedProject* opts patch
//   • WS handlers: session:start / session:end / session:observe /
//     session:unobserve / chat:history-request (acorn role-aware) /
//     plus the legacy /api/acorn/* alias in core that rewrites to
//     /api/plugins/acorn-cli/* so existing Go binaries keep working.
//   • lib/sessions.js: session-node persistence (upsert / finalize /
//     turn count / summarize / distill).
//   • lib/projects.js: project-node persistence (per-(user, cwd) cache).
//
// Still in core (not strictly acorn-coupled, just close):
//   • _sessionClients map + orphaned-tool re-delivery (used by acorn
//     fan-out but is a generic WS routing primitive).
//   • Acorn role advertisement in WS handshake (capability frame).
//   • Self-register (uses acornKey as a team-key gate; future cleanup
//     can lift this into the plugin).

const crypto = require('crypto');

// ── Legacy config backfill ──────────────────────────────────────────
// Same pattern as plugins/email: copies any pre-existing top-level
// `acornKey` (legacy SPORE_ACORN_KEY env var or saved spore.json field)
// into `config.plugins.acorn-cli.key` on first install. After this
// runs once, the plugin owns the slot.
const LEGACY_KEY_MAP = {
  acornKey: 'key',
};

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const patch = {};
  let any = false;
  for (const [legacy, modern] of Object.entries(LEGACY_KEY_MAP)) {
    const v = host[legacy];
    if (v !== undefined && v !== null && v !== '') {
      patch[modern] = v;
      any = true;
    }
  }
  // Plugin owns SPORE_ACORN_KEY directly — config.js no longer mirrors
  // the env var into a top-level slot. If the legacy slot didn't carry
  // a value (fresh install without prior settings UI), fall back to
  // the env var. After backfill, the plugin owns the slot for good.
  if (!patch.key && process.env.SPORE_ACORN_KEY) {
    patch.key = process.env.SPORE_ACORN_KEY;
    any = true;
  }
  if (any) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated ${Object.keys(patch).length} legacy acorn config key(s) into plugins.acorn-cli`);
  }
}

// ── Acorn key constant-time comparison ──────────────────────────────
function acornKeyMatches(typed, stored) {
  if (!typed || !stored) return false;
  const a = Buffer.from(String(typed));
  const b = Buffer.from(String(stored));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// ── Resolve the operator-configured key ─────────────────────────────
// Plugin owns the slot exclusively. backfillLegacyConfig handles the
// one-time migration from any pre-existing top-level acornKey field
// or the SPORE_ACORN_KEY env var.
function resolveAcornKey(api) {
  const cfg = api.getConfig();
  return cfg.key || null;
}

// ── HTTP route handlers ─────────────────────────────────────────────

async function handleAuth(api, req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      return;
    }
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }
  const { username, key } = parsed || {};

  const acornKey = resolveAcornKey(api);
  if (!acornKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Acorn not configured on this agent', code: 'ACORN_NOT_CONFIGURED' }));
    return;
  }
  if (!username || typeof username !== 'string' || username.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid username (alphanumeric, max 32 chars)' }));
    return;
  }
  if (!acornKeyMatches(key, acornKey)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid team key' }));
    return;
  }

  // Issue a Bearer token via the host's web-session map. The WebSocket
  // auth handshake (in core, src/gateways/web.js) reads this map to
  // validate `Bearer <token>` headers, so the plugin and core share
  // session storage even though the auth endpoint moved to the plugin.
  // The WebGateway is hung off `tools.gateway`, not registered with the
  // GatewayManager (only Discord/Telegram/Slack live there). Try tools.gateway
  // first; fall back to a hypothetical 'web' GW registration for forward-compat.
  const webGw = api._appContext?.tools?.gateway || api._appContext?.gateways?.getGateway?.('web');
  const webSessions = webGw?._webSessions;
  if (!webSessions) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Web gateway not ready' }));
    return;
  }

  const acornSid = crypto.randomBytes(16).toString('hex');
  webSessions.set(acornSid, {
    user: username.toLowerCase().trim(),
    // 'cli' is core's generic CLI-class role — core's WS handler treats
    // any session with type 'cli' as a CLI client (sessionId-keyed
    // history, no graph-event broadcast, etc.). Plugin-specific role
    // names like 'acorn' would couple core to this plugin.
    type: 'cli',
    created: Date.now(),
  });
  api.getLogger().info(`Auth OK for user: ${username}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, token: acornSid, user: username }));
}

async function handleSessions(api, req, res) {
  // The WebGateway is hung off `tools.gateway`, not registered with the
  // GatewayManager (only Discord/Telegram/Slack live there). Try tools.gateway
  // first; fall back to a hypothetical 'web' GW registration for forward-compat.
  const webGw = api._appContext?.tools?.gateway || api._appContext?.gateways?.getGateway?.('web');
  const webSessions = webGw?._webSessions;
  if (!webSessions) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Web gateway not ready' }));
    return;
  }

  // Bearer token validation
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = token ? webSessions.get(token) : null;
  if (!session || session.type !== 'acorn') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing token' }));
    return;
  }

  const user = session.user;
  const prefix = `channel:cli:${user}@`;

  try {
    const tools = api._appContext?.tools;
    if (!tools?._sessions) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session manager not ready' }));
      return;
    }
    const allSessions = tools._sessions.listSessions();
    const agent = tools._agent;
    const activeKeys = agent ? new Set(agent.activeRuns) : new Set();
    // _sessionClients is still owned by core (will move to plugin in 2.3c-2).
    // Read it for the 'active' badge but tolerate it being absent if the
    // plugin loads before that wiring is set up.
    const sessionClients = webGw?._sessionClients || new Map();

    const sessions = allSessions
      .filter(s => s.key.startsWith(prefix) && s.message_count > 0)
      .map(s => {
        const afterAt = s.key.slice(prefix.length);
        const parts = afterAt.split('-');
        const project = parts.length >= 3 ? parts.slice(0, parts.length - 2).join('-') : afterAt;
        const hasConnectedClient = sessionClients.has(s.key.replace('channel:', ''));
        return {
          key: s.key.replace('channel:', ''),
          project,
          created: s.created,
          updated: s.updated,
          messageCount: s.message_count,
          active: activeKeys.has(s.key) || hasConnectedClient,
        };
      });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  } catch (e) {
    api.getLogger().warn(`Sessions list failed: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to list sessions' }));
  }
}

// ── note_discovery tool ─────────────────────────────────────────────
// graphcorn — wrapper that creates a `discovery` node with sensible defaults
// and auto-links it to the current acorn session + project nodes via
// recorded_in / learned_about edges. Direct SQL (no sessions.js dependency)
// so the tool can ship before the sessions/projects modules move.
// Sync function — all DB ops are synchronous (better-sqlite3 / node:sqlite
// prepared statements). Was previously marked async with no await calls,
// which made the failure_fix capture's Promise-detection branch swallow
// the result.
function noteDiscovery(api, input, ctx) {
  const learner = api._appContext?.learner;
  if (!learner?.db) return { error: 'Graph writer not available' };
  const text = String(input?.text || '').trim();
  if (!text) return { error: 'text is required' };
  const kind = ['fact', 'gotcha', 'workflow', 'config', 'failure_fix']
    .includes(input?.kind) ? input.kind : 'fact';
  const explicitLabel = input?.label && String(input.label).trim();
  const label = explicitLabel || (text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text);
  const relatedTo = Array.isArray(input?.relatedTo) ? input.relatedTo : [];

  // Read session/project context from the wide ctx that core's tool
  // dispatcher passes to plugin tools (Phase 2.3b).
  const platform = ctx?.platform || null;
  const sessionId = platform === 'cli' ? (ctx?.channelId || null) : null;
  const userId = ctx?.userId || ctx?.userName || 'anon';
  const cwd = ctx?.projectContext?.cwd || ctx?.projectContext?.clientCwd || null;

  const db = learner.db;

  // Slugify the label to a node id, suffix with a short hash of the
  // text so two distinct discoveries with the same label don't collapse.
  // If a node with the exact id already exists, append the new text as
  // a fresh attribute on its `details` aspect rather than creating a
  // new node.
  const slug = label.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'discovery';
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
  const id = `discovery-${slug}-${hash}`;

  const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
  let isNew = false;
  if (!existing) {
    isNew = true;
    // graphcorn: in an acorn session, every new node is born temp +
    // tagged with the sessionId. Session-end distillation reads these
    // back, picks winners (promotes by clearing ttl), and recycles the
    // rest. Without a session ctx the discovery is permanent.
    let sessionAlreadyDistilled = false;
    if (sessionId) {
      try {
        const sessRow = db.prepare(
          "SELECT json_extract(extra, '$.distilled_at') AS distilled FROM nodes WHERE id = ?"
        ).get('session-' + String(sessionId));
        sessionAlreadyDistilled = !!sessRow?.distilled;
      } catch (e) { api.getLogger().warn('distill-check failed: ' + e.message); }
    }
    const extraJson = (sessionId && !sessionAlreadyDistilled)
      ? JSON.stringify({ ttl: 'temp', sessionId, tempCreated: new Date().toISOString() })
      : '{}';
    db.prepare(
      'INSERT INTO nodes (id, label, type, description, importance, mentions, provenance, extracted_with, extracted_at, extra) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)'
    ).run(id, label, 'discovery', text, 7, 'graphcorn', 'note_discovery', new Date().toISOString(), extraJson);
  } else {
    db.prepare('UPDATE nodes SET mentions = mentions + 1, updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  // details aspect — text goes here
  let detAsp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'details'").get(id);
  if (!detAsp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'details', 8, 'graphcorn')").run(id);
    detAsp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  }
  const dup = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(detAsp.id, text);
  if (!dup) {
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, 'note_discovery', 'graphcorn')"
    ).run(detAsp.id, text);
  }

  // kind aspect — single attribute
  let kAsp = db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'kind'").get(id);
  if (!kAsp) {
    db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'kind', 6, 'graphcorn')").run(id);
    kAsp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    db.prepare(
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 6, 'note_discovery', 'graphcorn')"
    ).run(kAsp.id, kind);
  }

  // Edges: discovery → session + discovery → project + relatedTo
  const checkE = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?');
  const insE = db.prepare(
    "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, ?, 1, 'graphcorn')"
  );

  let linkedSession = null;
  if (sessionId) {
    const sessId = 'session-' + String(sessionId);
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(sessId)) {
      if (!checkE.get(id, sessId, 'recorded_in')) insE.run(id, sessId, 'recorded_in');
      linkedSession = sessId;
    }
  }

  let linkedProject = null;
  if (sessionId && userId && cwd) {
    // Reuse the projects.js id convention without importing the full module
    // (sessions.js + projects.js move to plugin/lib in a later sub-phase).
    const u = String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
    const h = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 8);
    const projId = `project-${u}-${h}`;
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(projId)) {
      if (!checkE.get(id, projId, 'learned_about')) insE.run(id, projId, 'learned_about');
      linkedProject = projId;
    }
  }

  let linkedRelated = 0;
  for (const r of relatedTo) {
    const rid = String(r || '').toLowerCase().trim();
    if (!rid) continue;
    if (db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(rid)) {
      if (!checkE.get(id, rid, 'relates_to')) {
        insE.run(id, rid, 'relates_to');
        linkedRelated++;
      }
    }
  }

  return { ok: true, nodeId: id, isNew, kind, linkedSession, linkedProject, linkedRelated };
}

// ── Failure-fix capture (per-session ring buffer) ──────────────────
// When a tool exec fails in an acorn turn and a similar exec succeeds
// shortly after (same command token + overlapping path/url target),
// synthesize a `failure_fix` discovery so the operator doesn't have to
// relearn how to escape that specific gotcha next session. Cross-round
// (within last 5 turns + 30 min wall clock) so it catches both immediate
// retries and "tried other stuff first" resolutions.
//
// State lives at module scope so the ring buffer survives across turns
// (re-instantiating per turn would lose the failures we're trying to
// match against). Cap at 200 sessions; LRU-evict the oldest.
const _sessionFailures = new Map();

function captureFailureFix(api, opts, toolLog) {
  if (!(opts.platform === 'cli' && opts.channelId && toolLog?.length)) return;
  const learner = api._appContext?.learner;
  if (!learner?.db) return;
  try {
    const sessKey = String(opts.channelId);
    const buf = _sessionFailures.get(sessKey) || [];
    const now = Date.now();
    // Read the turn count back from the lifecycle aspect on the session node.
    let turn = 0;
    try {
      const sessId = 'session-' + sessKey;
      const row = learner.db.prepare(
        "SELECT a.content FROM attributes a JOIN aspects asp ON asp.id=a.aspect_id WHERE asp.node_id=? AND asp.name='lifecycle' AND a.content LIKE 'turn_count:%'"
      ).get(sessId);
      const m = row && String(row.content).match(/turn_count:\s*(\d+)/);
      if (m) turn = parseInt(m[1], 10);
    } catch { /* silent: best-effort lookup */ }

    // Helper: extract the first command token + a "target" (first
    // path-shaped or URL-shaped argument) for similarity matching.
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
      // result.error key) OR if exec returned a non-zero exit code (acorn-
      // cli's shell.go returns {output, exitCode:N} without an error key,
      // so the original succeeded check missed those).
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
          // Synthesize the failure_fix discovery via the plugin's own
          // noteDiscovery handler with a synthesized ctx. No need for the
          // legacy AsyncLocalStorage / _currentXxx workaround the in-tree
          // code used — we have the wide ctx right here.
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

// ── Round-checkpoint (breadcrumb on session node's `rounds` aspect) ─
// Each finished round leaves a breadcrumb on the session node's `rounds`
// aspect: turn N | user prompt | tools | files | exec cmds | reply.
// Capped at the last 50 entries so the session node doesn't balloon.
// Also bumps the turn_count attribute on lifecycle. Only for acorn turns
// where the session node exists.
function recordRoundCheckpoint(api, opts, toolLog, finalText) {
  const learner = api._appContext?.learner;
  if (!(opts.platform === 'cli' && opts.channelId && learner?.db)) return;
  try {
    const sessions = require('./lib/sessions');
    const turn = sessions.bumpTurnCount(learner, opts.channelId);
    const sessId = 'session-' + opts.channelId;
    const sessExists = learner.db.prepare('SELECT id FROM nodes WHERE id = ?').get(sessId);
    if (!sessExists) return;
    let asp = learner.db.prepare("SELECT id FROM aspects WHERE node_id = ? AND name = 'rounds'").get(sessId);
    if (!asp) {
      learner.db.prepare("INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, 'rounds', 7, 'graphcorn')").run(sessId);
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
        // Count both host-reported failures and non-zero exits.
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
      "INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 7, 'graphcorn', 'graphcorn')"
    ).run(asp.id, content);
    // Trim to last 50 attributes on this aspect so the session node
    // doesn't grow unbounded over long conversations.
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

// ── Recall-skip heuristic (was in src/graph/context.js) ────────────
// Acorn coding turns don't need the per-turn graph recall pipeline:
// they need filesystem tools, not "remember our chat from last week".
// Recall = ~45-65 DB hits + LLM round-trip on every message — pure
// overhead for focused refactor work. Conservative: any positive
// signal trips skip; everything else still gets full recall.
// Aggregation/recall-shaped queries are filtered upstream by queryType,
// so this only sees specific/task-shaped ones.
const _CODING_FILE_RE = /[\/\\]?[A-Za-z0-9_.\-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|lua|sh|bash|zsh|fish|sql|html|css|scss|less|md|json|jsonc|toml|yaml|yml|xml|ini|env|dockerfile|makefile|gradle|cmake|proto|graphql|gql|svelte|vue)\b/i;
const _CODING_VERB_RE = /\b(?:read|edit|write|create|delete|rename|move|copy|fix|refactor|build|run|exec|test|debug|grep|find|search|implement|add|remove|update|patch|merge|rebase|commit|push|deploy|install|compile|lint|format|stub|mock|wire|hook|port|migrate|generate|scaffold)\b/i;
const _CODING_TOOL_RE = /\b(?:read_file|write_file|edit_file|exec|glob|grep|web_fetch|web_search|bash|terminal|file)\b/i;
const _CODE_FENCE_RE = /```/;
const _COMMAND_RE = /^\s*[\$>]?\s*(?:npm|yarn|pnpm|bun|go|cargo|pip|pip3|python|python3|node|deno|make|just|docker|git|ls|cd|cat|grep|sed|awk|find|curl|wget)\s/i;
function looksLikeCodingTurn(text) {
  if (!text || typeof text !== 'string') return false;
  if (_CODE_FENCE_RE.test(text)) return true;
  if (_CODING_FILE_RE.test(text)) return true;
  if (_CODING_TOOL_RE.test(text)) return true;
  if (_COMMAND_RE.test(text)) return true;
  // Verb check is the loosest — only count it when paired with some
  // code-context cue (short and direct, OR includes another code-
  // shaped fragment). Pure prose like "I should refactor my schedule"
  // shouldn't trip this.
  if (_CODING_VERB_RE.test(text) && (text.length < 240 || /\.[a-z]{1,5}\b/i.test(text))) return true;
  return false;
}

// ── Project activity note (per-turn breadcrumb on project node) ────
// Appends a one-line activity note to the project node so cross-session
// memory accumulates. Captures user prompt + tool-call summary so the
// agent can later graph_query and see "what we worked on last time in
// this project". Cheap (one INSERT, capped at 50). Replaces the
// _noteProjectActivity method that lived in src/agent/loop.js before
// this phase. Gates on projectContext presence so it's a no-op for
// web/discord turns where opts.projectContext is undefined.
function noteProjectActivity(api, opts, finalText, toolLog) {
  const learner = api._appContext?.learner;
  if (!opts?.projectContext || !learner) return;
  if (!finalText && !(toolLog && toolLog.length)) return;
  try {
    const projects = require('./lib/projects');
    const userSnip = (opts.content || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const tools = (toolLog && toolLog.length)
      ? ` [${toolLog.length} tool calls: ${toolLog.slice(0, 3).map(t => t.tool).join(', ')}${toolLog.length > 3 ? '…' : ''}]`
      : '';
    const summary = `${userSnip}${tools}`;
    projects.noteProjectInteraction(learner, opts.userId || 'anon', opts.projectContext.cwd, summary);
  } catch (e) {
    api.getLogger().warn(`[project-node] note failed: ${e.message}`);
  }
}

// ── WS handlers: session:start / session:end ────────────────────────
// graphcorn: session:start fires once per acorn launch right after the
// WS handshake, before the first chat:submit. Creates a session-<id>
// graph node + edge to the project node so everything captured during
// the conversation has a graph anchor. Idempotent — flaky reconnects
// re-firing this just bump mentions on the existing node.
function sessionStartHandler(api, ws, msg) {
  if (!msg?.sessionId) return;
  const ctx = api._appContext;
  const learner = ctx?.tools?.learner || ctx?.learner;
  const config = ctx?.config || {};
  if (!learner) return;
  try {
    const sessions = require('./lib/sessions');
    const r = sessions.upsertSessionNode(learner, {
      sessionId: msg.sessionId,
      userId:    ws._user || msg.userName || 'anon',
      userName:  msg.userName,
      cwd:       msg.cwd,
      startedAt: msg.startedAt,
      model:     config.normalModel || config.model,
      ...(msg.projectContext || {}),
    });
    if (r) api.getLogger().info(`[graphcorn] session:start → ${r.id}${r.isNew ? ' (new)' : ''}${r.projectId ? ' part_of ' + r.projectId : ''}`);
  } catch (e) {
    api.getLogger().warn(`[graphcorn] session:start failed: ${e.message}`);
  }
}

// Phase 7 + 8 of the session lifecycle: chain summarize → distill on
// session:end. Both fire-and-forget so they don't block the WS close.
// distillSession is idempotent (extra.distilled_at marker), so if the
// WS ALSO drops and re-fires distillation from the close handler in
// core, the second call is a no-op.
function sessionEndHandler(api, ws, msg) {
  if (!msg?.sessionId) return;
  const ctx = api._appContext;
  const learner = ctx?.tools?.learner || ctx?.learner;
  const config = ctx?.config || {};
  const log = api.getLogger();
  if (!learner) return;
  try {
    const sessions = require('./lib/sessions');
    sessions.finalizeSessionNode(learner, msg.sessionId, { endedAt: msg.endedAt });
    log.info(`[graphcorn] session:end → session-${msg.sessionId}`);
    const llmClient = ctx?.tools?.anthropicClient;
    if (llmClient) {
      sessions.summarizeSessionNode(learner, llmClient, config, msg.sessionId, log)
        .then(() => sessions.distillSession(learner, llmClient, config, msg.sessionId, log))
        .catch(e => log.warn(`[graphcorn] summary/distill error: ${e.message}`));
    }
  } catch (e) {
    api.getLogger().warn(`[graphcorn] session:end failed: ${e.message}`);
  }
}

// ── Prompt sections ─────────────────────────────────────────────────
// Acorn-specific prompt content. Originally lived inline in
// src/graph/prompt-sections.js _buildRuntimeSection (~225 lines),
// gated on opts.platform === 'cli'. Moved out so non-acorn turns
// see ZERO acorn content and uninstalling the plugin removes both
// blocks entirely.
//
// Project Context: emitted on every acorn turn, branches on cached
//   project node (short reference if already in graph) vs uncached
//   (full inline tree + ACORN.md). Includes the "This Session" sub-
//   block when the session-<id> node exists.
//
// Plan Mode: emitted when projectContext.mode === 'plan'. Verbatim
//   port of the Python PLAN_PREFIX from acorn/cli.py — preserves the
//   QUESTIONS: marker format, JSON+prose accepted, the 'ask first
//   then plan' rule, and the PHASE 1-6 structure.

function buildProjectContextSection(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext) return null;
  const pc = opts.projectContext;
  const cached = opts.cachedProjectNodeId && !opts.cachedProjectStale && !opts.cachedProjectIsNew;
  const parts = [];
  parts.push(`## Project Context — ${pc.project || 'project'}`);
  parts.push(`**You have direct shell + filesystem access on the user's machine via your tools (exec, read_file, write_file, edit_file, grep, glob).** When the user asks about local state — "is the dev server up", "what's in this file", "why is X slow", "did the build finish", "what does ls show", "is port N open" — RUN THE TOOLS and answer with the actual result. Do NOT respond as if you're a remote chatbot ("I can't see your machine, here's how you could check"). For acorn sessions you are effectively a coding agent on the user's box; behave like one.`);
  if (pc.cwd) parts.push(`- CWD: ${pc.cwd}`);
  if (pc.os || pc.arch) parts.push(`- Platform: ${pc.os || '?'}/${pc.arch || '?'}`);
  if (pc.projectType) parts.push(`- Project type: ${pc.projectType}`);
  if (pc.gitBranch) {
    const hash = pc.gitHash ? ` @ ${pc.gitHash}` : '';
    parts.push(`- Git: branch=${pc.gitBranch}${hash}`);
  }
  if (pc.gitStatus) {
    parts.push('- Git status:');
    for (const line of pc.gitStatus.split('\n')) parts.push(`    ${line}`);
  }
  if (pc.tools && pc.tools.length) {
    parts.push(`- Tools available: ${pc.tools.join(', ')}`);
  }
  if (pc.hardware) {
    const h = pc.hardware;
    const machineLines = [];
    if (h.kernel) machineLines.push(`  - Kernel: ${h.kernel}`);
    const cpu = [h.cpuModel, h.cpuCores ? `${h.cpuCores} cores` : null].filter(Boolean).join(', ');
    if (cpu) machineLines.push(`  - CPU: ${cpu}`);
    if (h.ramGi) machineLines.push(`  - RAM: ${h.ramGi} GiB`);
    if (Array.isArray(h.gpu) && h.gpu.length) {
      machineLines.push('  - GPU:');
      for (const g of h.gpu) machineLines.push(`      ${g}`);
    } else if (h.gpu === undefined || h.gpu === null) {
      machineLines.push('  - GPU: none detected');
    }
    if (machineLines.length) {
      parts.push('- Machine:');
      for (const l of machineLines) parts.push(l);
    }
  }
  if (cached) {
    parts.push(`- Project memory: graph node \`${opts.cachedProjectNodeId}\` (cached — gitHash unchanged since last session). Use \`graph_query({ query: "...", nodeId: "${opts.cachedProjectNodeId}" })\` to retrieve file tree, ACORN.md, prior decisions, and recent activity from past sessions.`);
  } else {
    if (pc.tree && pc.tree.length) {
      const shown = pc.tree.slice(0, 80);
      parts.push(`- Project tree (${pc.tree.length} entries${pc.tree.length > shown.length ? `, showing first ${shown.length}` : ''}):`);
      for (const path of shown) parts.push(`    ${path}`);
    }
    if (pc.acornMd) {
      parts.push('');
      parts.push('### ACORN.md (project instructions from the user)');
      parts.push(pc.acornMd);
    }
    if (opts.cachedProjectNodeId) {
      parts.push('');
      parts.push(`**Project memory**: this project is tracked as graph node \`${opts.cachedProjectNodeId}\`. Use \`graph_query({ nodeId: "${opts.cachedProjectNodeId}" })\` to retrieve prior decisions, conventions, and recent activity from past sessions.`);
    }
  }

  // Session sub-block — only emitted when the session-<id> node actually exists.
  if (opts.channelId) {
    const sessNodeId = 'session-' + String(opts.channelId);
    let sessionExists = false;
    try {
      const db = api._appContext?.learner?.db || api._appContext?.graph?.db;
      sessionExists = !!db?.prepare('SELECT 1 FROM nodes WHERE id = ?').get(sessNodeId);
    } catch (e) { api.getLogger().warn('session-exists check failed: ' + e.message); }
    if (sessionExists) {
      parts.push('');
      parts.push('## This Session');
      parts.push(`- Session node: \`${sessNodeId}\` — anchor for everything captured this conversation`);
      if (opts.cachedProjectNodeId) {
        parts.push(`- Project node: \`${opts.cachedProjectNodeId}\` — sibling anchor for cross-session memory in the same project`);
      }
      parts.push("- **Persist what you learn here.** When you discover something durable — a config that worked, a tool quirk, a fix for a tricky failure, a port number, a CLI flag — call `note_discovery({text: \"...\", kind: \"...\"})`. Don't wait for the learner; you know better what mattered. The discovery gets a `recorded_in` edge to this session AND a `learned_about` edge to the project, so future sessions on this project can find it via `graph_query`.");
      parts.push("- `note_discovery` kinds: `fact` (plain knowledge), `gotcha` (non-obvious behavior), `workflow` (a procedure that worked), `config` (a setting/value), `failure_fix` (problem→solution pair).");
      parts.push("- Use `graph_update` directly when you want full schema control (custom node type, multiple aspects, explicit edges to specific nodes). Use `note_discovery` for casual one-line saves — way less boilerplate.");
      parts.push("- Every entity the LEARNER picks up from this conversation also auto-links to the session node via `discovered_in`. So even passive captures are anchored — no orphans.");
      parts.push("- **Born temporary, distilled at session-end.** Every node you create this session (note_discovery, graph_update, learner-extracted) is born `temp` and tagged with this session id. When the session closes (graceful or ungraceful), a small LLM looks at all of them and **PROMOTES** the keepers to permanent (tools, libraries, frameworks, people, projects, durable workflows, failure→fix pairs), **APPENDS** session-specific lessons onto existing permanent nodes' `gotchas`, and soft-deletes the rest into `recycle_bin` (7-day restore window). So: capture aggressively, don't agonize over signal-vs-noise — distillation is the filter. If you really want a node permanent immediately (rare — only for things you're CERTAIN matter beyond this session), pass `temp: false` to `graph_update`.");
    }
  }

  parts.push('');
  if (pc.scope === 'expanded') {
    parts.push(`**Sandbox**: the user has run \`/scope expanded\`, lifting the cwd containment for this session. file operations may target any path on the user's machine — but the project root is still ${pc.cwd}, so write project files there unless the user has asked you to touch something elsewhere (shared dotfiles, a sibling repo, their home directory, etc.). Do NOT use /workspace/ or any server-side path — those live inside the SPORE container and will be lost on restart.`);
  } else {
    parts.push(`**Sandbox**: ALL file operations (read_file, write_file, edit_file, exec) are sandboxed to ${pc.cwd}. Paths outside that directory will be REJECTED by the tool executor on the user's machine. If the user explicitly asks you to touch a path outside ${pc.cwd}, tell them to run \`/scope expanded\` first to lift the sandbox. Do NOT use /workspace/ or any server-side path — those live inside the SPORE container and will be lost on restart. Write everything to ${pc.cwd}.`);
  }
  parts.push('**Work style**: One or two tool calls per turn, not six. After each file write or command, briefly tell the user what you did and what is next. Do NOT batch many write_file calls in a single response — the user cannot see progress and it takes too long to generate.');
  parts.push('**Ad-hoc helper scripts go in `.acorn/scratch/`, never the project root.** One-off helpers (LAN IP detection, QR generation, log parsers, build wrappers) write to `.acorn/scratch/foo.js` — not `_foo.js` in the repo root. The project node\'s `scratch_helpers` aspect (check via `graph_query`) lists what prior sessions already wrote; read + adapt before creating a duplicate.');
  parts.push('**Project listing — use the right tool, NEVER `exec find` / `exec ls -laR`**: The Project Tree above (and the cached node, when present) already shows the project structure with build/dependency/cache dirs filtered. If you need MORE detail, use `glob` (auto-skips noise dirs, capped at 500 paths, fast) or `read_file` on a specific path — NOT `exec find` / `exec ls -R` / `exec tree`. Walking a node_modules-heavy project with exec regularly hits the 3-minute tool timeout AND dumps thousands of irrelevant lines. Specifically `exec ls -laR` on a Node project = guaranteed timeout.');
  parts.push('**Output filtering**: When listing files / describing a project / showing exec output, NEVER include build/dependency/cache directory contents in your reply — even if the tool returned them. Suppress: .git, node_modules, .venv / venv, __pycache__, dist, build, target, .next, .cache, .acorn, vendor, .gradle, .mvn, .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .nuxt, .svelte-kit, .terraform, .idea, .vscode/, *.egg-info, coverage, .nyc_output, .DS_Store. If a tool returned a wall of these, FILTER before pasting. The user does not want to see node_modules in chat.');
  parts.push('**Web lookups**: For things you CAN\'T learn from the user\'s machine — current library versions, framework docs, API changes, error messages you\'ve never seen, "is X deprecated", recent breaking changes — use `web_search` to find candidate URLs, then `web_fetch` the 1-3 most authoritative (official docs > GitHub > Stack Overflow > random blog). Always include the current year for recent topics ("expo router 2026", "Next.js 15 breaking changes") — without it search engines return stale results. Quote exact error strings to pin to actual occurrences. Cite the source URL in your reply so the user can verify. See `ref-web-search` for the full pattern.');
  parts.push('**Research-and-record loop**: Before working with anything you don\'t already know cold — a CLI flag, library API, error code, framework convention, third-party tool, config schema — `graph_query({ query: "<thing>" })` FIRST to see if a prior session already learned it. If nothing useful comes back, do NOT improvise from training data (it\'s usually months stale and partly wrong): `web_search` (with the year), `web_fetch` the 1-2 best sources (prefer official docs), then SAVE what you learned via `graph_update({ nodeId: "<slug>", label: "...", type: "tool" | "library" | "framework" | "concept", aspects: [{ name: "overview", attributes: ["<key facts>"] }, { name: "gotchas", attributes: ["<non-obvious bits>"] }] })` so the next session in this project finds it via graph_query and skips the lookup. Briefly tell the user "no node for <thing> in the graph — looking it up" so they know you\'re researching, not guessing. Quietly looking it up beats confidently guessing wrong every time.');
  parts.push('**3-strikes web_search rule (IMPORTANT)**: If you try the same class of exec command twice and it fails/doesn\'t produce the desired outcome, on the THIRD attempt you MUST `web_search` the exact error or the topic BEFORE running another shell command. Example: `expo start` hangs → try once more with different flags (strike 2) → third step is NOT another exec, it\'s `web_search("expo start hangs no output 2026")` + `web_fetch` the top result. Most "hitting a wall" moments are a google-able stale-training-data issue (framework version, changed CLI, deprecated flag) — banging on exec just burns turns. web_search is cheap (2-3 seconds) and almost always informative. Prefer it OVER: guessing, trying "one more variant", asking the user "what do you think is wrong".');
  parts.push('**Load relevant gotchas at session start**: When the Project Context shows a project using a known framework/tool (expo, react-native, next, tailwind, docker, etc.), BEFORE your first tool call on that topic `graph_query({ query: "<tool name>" })` to load the existing gotchas aspect. This is where prior sessions persist "the QR code needs plain ASCII not ANSI" or "expo dev server defaults to 8081". Skipping this means you\'ll re-hit the same walls earlier sessions already documented for you. For multiple tools, run queries in parallel in the same turn.');

  return parts.join('\n');
}

function buildPlanModeSection(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext || opts.projectContext.mode !== 'plan') return null;
  const parts = [];
  parts.push('## Plan Mode (acorn CLI)');
  parts.push('[MODE: Plan only. You are in planning mode. Follow these phases in order:');
  parts.push('');
  parts.push('PHASE 1 — ENVIRONMENT AUDIT:');
  parts.push("The Project Context section above includes the local environment (OS, installed tools, project type, file tree). Review what is available. If the task requires tools/runtimes not installed, note them.");
  parts.push('');
  parts.push('PHASE 2 — CODEBASE SCAN:');
  parts.push('Use read_file, glob, and grep to understand the existing codebase structure, patterns, conventions, config files, and dependencies.');
  parts.push('');
  parts.push('PHASE 3 — RESEARCH (delegate in parallel):');
  parts.push('Identify topics you need external context on — framework comparisons, library docs, API shapes, best practices, current versions, recent breaking changes. For each independent question, DELEGATE a research sub-agent rather than searching yourself:');
  parts.push('');
  parts.push('  delegate_task({');
  parts.push('    persona: "researcher",');
  parts.push('    task: "Find current best practices for <X>. Cover <specific subquestions>. Note any recent (2026) changes.",');
  parts.push('    context: "We are planning <project>. Constraints: <constraints>."');
  parts.push('  })');
  parts.push('');
  parts.push('Why delegate instead of web_search yourself: (1) parallel — three sub-agents finish in the time of one. (2) focused — each persona uses a narrow tool set and returns a structured Findings/Caveats/Recommendation summary you can splice straight into the plan. (3) cheap — sub-agents have their own context budget so they do not eat yours. Aim for 1-3 parallel researchers per non-trivial plan; do not delegate trivial lookups (single fact you already know). Codebase reading (read_file, grep, glob) stays in YOUR turns — sub-agents do not have access to the user\'s machine.');
  parts.push('');
  parts.push('After delegating, the harness wakes you when each sub-agent finishes. Wait for at least the first batch of findings before moving to PHASE 5 — do NOT emit PLAN_READY in the same turn you delegated.');
  parts.push('');
  parts.push('PHASE 4 — CLARIFY:');
  parts.push("If the request leaves ANY material ambiguity — framework choice, scope, audience, design direction, target language, file layout, naming, technical approach — you MUST ask before proceeding to PHASE 5. A request like \"build me a website about bridges\" is ambiguous: framework? styling? data source? routing? deployment target? Ask. Default to asking when uncertain — the user can always say \"you choose\" if they don't care, but they cannot un-do an unwanted scaffolded project.");
  parts.push('');
  parts.push('**TOOLING QUESTIONS (ask whenever applicable):** When the project involves any chosen-tool decision the user might have a preference about, ASK rather than picking silently. Tooling categories worth surfacing as explicit questions when they apply to the project:');
  parts.push('  - Language / runtime (Node vs Bun vs Deno; Python vs Go vs Rust; etc.)');
  parts.push('  - Framework (React vs Vue vs Svelte vs SolidJS; Express vs Fastify vs Hono; FastAPI vs Flask; etc.)');
  parts.push('  - Package manager (npm vs pnpm vs bun vs yarn; pip vs uv vs poetry)');
  parts.push('  - Build tool / bundler (Vite vs webpack vs esbuild vs Rollup vs Parcel)');
  parts.push('  - Test runner (Vitest vs Jest vs node:test vs Playwright; pytest vs unittest)');
  parts.push('  - Linter / formatter (ESLint+Prettier vs Biome; Ruff vs Black+Flake8)');
  parts.push('  - Type system (TypeScript vs JSDoc vs none; mypy vs pyright vs none)');
  parts.push('  - Styling (Tailwind vs CSS Modules vs styled-components vs vanilla CSS)');
  parts.push('  - Database / ORM (Postgres vs SQLite; Prisma vs Drizzle vs raw SQL; SQLAlchemy vs raw)');
  parts.push('  - Auth (NextAuth vs Lucia vs Clerk vs roll-your-own; passlib vs Authlib)');
  parts.push('  - Deployment target (Vercel vs Cloudflare vs Fly vs Docker self-host vs static)');
  parts.push('  - State management (Redux vs Zustand vs Jotai vs context-only)');
  parts.push('Skip a category only when the project clearly does not need it (e.g. don\'t ask about a database for a static landing page) OR when the existing codebase already commits to a choice (don\'t ask about test runner if package.json already has vitest).');
  parts.push('');
  parts.push("Emit a QUESTIONS: marker on its own line, then the questions. TWO formats are accepted — prefer JSON.");
  parts.push('');
  parts.push('**PREFERRED — JSON (most robust):**');
  parts.push('QUESTIONS:');
  parts.push('```json');
  parts.push('[');
  parts.push('  {"text": "What framework?", "type": "single", "options": ["React", "Vue", "Svelte"]},');
  parts.push('  {"text": "Which features?", "type": "multi", "options": ["Auth", "DB", "API", "WebSocket"]},');
  parts.push('  {"text": "Project name?", "type": "open"}');
  parts.push(']');
  parts.push('```');
  parts.push('');
  parts.push('Valid `type` values: `single` (one-of), `multi` (any-of), `open` (free text).');
  parts.push('If `type` is omitted, presence of `options` implies single-select; absence implies open.');
  parts.push('');
  parts.push('**LEGACY — prose fallback (if you cannot emit JSON cleanly):**');
  parts.push('QUESTIONS:');
  parts.push('1. Single-select question? [Option A / Option B / Option C]');
  parts.push('2. Multi-select question? {Option A / Option B / Option C / Option D}');
  parts.push('3. Open-ended question?');
  parts.push('');
  parts.push('FORMAT RULES — the CLI parser is strict:');
  parts.push("- The marker is the literal string `QUESTIONS:` on its own line. Do NOT wrap the MARKER in markdown bold/italic (`**QUESTIONS:**` etc). The parser tolerates it but it's ugly.");
  parts.push('- For the JSON form: valid JSON only. No trailing commas. No comments. No smart quotes. Use `"` quotes, not `“`/`”`. Close every bracket. If you hit an output limit, STOP with `]` before the close of the QUESTIONS block rather than emitting invalid JSON.');
  parts.push('- For the prose form: discrete-choice questions MUST use `[A / B / C]` (single) or `{A / B / C}` (multi) — do NOT list options as prose with "or" separators, those render as open-ended free text and the user has to type.');
  parts.push('- Do NOT apply bold/italic/code formatting to the question TEXT either — it leaks into the picker rows.');
  parts.push('');
  parts.push("If you have questions, output ONLY the QUESTIONS: block and STOP — do NOT include PLAN_READY in the same response. Wait for answers before presenting the plan.");
  parts.push('');
  parts.push('PHASE 5 — PLAN:');
  parts.push('Only after questions are answered (or if you have none), present a detailed plan with prerequisites, step-by-step changes with file paths, new files vs existing files to modify, dependencies to install, and commands to run. Structure the plan as a numbered list of discrete steps — each step should be small enough to task_create as its own checklist row at execution time (see PHASE 6 + the Execution Checklist rule below).');
  parts.push('');
  parts.push('PHASE 6 — VERIFICATION:');
  parts.push('Every plan MUST end with a **VERIFICATION** section listing 2–5 concrete, runnable checks that confirm the change actually works. Each check is a specific command or observation with a pass criterion, e.g.:');
  parts.push('  - `bun test src/foo.test.ts` should exit 0, 3 tests passing');
  parts.push('  - `curl -s http://localhost:3000/api/health` should return `{"ok":true}`');
  parts.push('  - `read_file config.ts` — `port` should be `8081`, not `8080`');
  parts.push('  - `ls .acorn/scratch/` — `gen-qr.js` should be present');
  parts.push('Pick checks that use existing project tooling (tests, curl, read_file) and have an unambiguous pass signal. Avoid "it should feel better" or "make sure it looks right" — those are not verifications. If the project has no test runner and no live endpoint, fall back to targeted `read_file` / `exec --version` checks that prove the expected state.');
  parts.push('');
  parts.push('Format the VERIFICATION section as a bulleted list under a `## Verification` heading inside the plan. The user will review it alongside the steps before accepting.');
  parts.push('');
  parts.push('RULES (these are HARD constraints, not suggestions):');
  parts.push('- Do NOT call write_file. Do NOT call edit_file. Do NOT create directories. The user has explicitly chosen plan mode to PREVIEW your approach before any changes land.');
  parts.push('- Do NOT call exec for anything destructive or modifying — no `mkdir`, `npm init`, `git init`, `touch`, `>`, `>>`, `mv`, `cp`, `rm`, `chmod`, `chown`, package installs, or builds. Read-only inspection only.');
  parts.push('- You MAY use: read_file, glob, grep, web_search, web_fetch, delegate_task (persona="researcher" preferred), graph_query, exec (READ-ONLY commands only — `ls`, `cat`, `which`, `--version`, `git status`, `git log`, etc).');
  parts.push('- Do NOT put questions and PLAN_READY in the same response — ask first, then plan after answers.');
  parts.push('- Do NOT emit PLAN_READY without a `## Verification` section. A plan without verification is incomplete.');
  parts.push("- End your plan with \"PLAN_READY\" on its own line — that's the marker the CLI watches for to show the Execute/Revise/Cancel choice. Without it the user has no way to approve.");
  parts.push("- After the user clicks Execute, the SAME plan is replayed as a NEW turn with mode=execute — that's when you actually run write_file etc. Do not pre-emptively try to skip plan mode by writing now.]");
  parts.push('');
  parts.push('**Execution Checklist (the execute-mode rule):** When the plan is replayed for execution, your FIRST set of tool calls MUST be `task_create` — one per plan step AND one per verification check. Use short `subject` strings (5–10 words) copied from the plan\'s step headers. As you complete each step, call `task_progress({id, status: "done"})` IMMEDIATELY — do not batch updates at the end. Before starting a step, call `task_progress({id, status: "in_progress"})` so the user can see which one you\'re on. If a step fails, `task_progress({id, status: "error", note: "<what failed>"})` and either propose a fix or ask the user. After all implementation steps are `done`, run the verification checks in order, updating each to `done` or `error`. You may only declare the work complete once every task in the checklist (impl + verification) is `done`. The user watches this checklist to see progress — skipping updates means they can\'t tell where you are.');

  return parts.join('\n');
}

// ── Plugin registration ─────────────────────────────────────────────
module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  // One-time copy-forward of legacy top-level acornKey config slot.
  backfillLegacyConfig(api);

  // HTTP routes — auth issues an acorn-typed Bearer token; sessions
  // returns the user's prior chat sessions. Surfaced under
  // /api/plugins/acorn-cli/* and aliased from /api/acorn/* via core's
  // pre-route rewrite (src/gateways/web.js).
  //
  // /auth is the auth boundary itself — it MUST be public so unauthenticated
  // Go clients can post a key and get a token. /sessions does its own
  // Bearer-token validation in-handler so it's also public from the
  // dispatcher's perspective.
  api.registerWebRoute('POST', '/auth',     { public: true, handler: (req, res) => handleAuth(api, req, res) });
  api.registerWebRoute('GET',  '/sessions', { public: true, handler: (req, res) => handleSessions(api, req, res) });

  // note_discovery tool — bare name (namespaced:false) preserves the
  // public contract for the agent. Reads ctx.platform / ctx.channelId /
  // ctx.projectContext.cwd to detect the acorn session and link the
  // discovery node to session + project graph anchors.
  api.registerTool('note_discovery', {
    namespaced: false,
    description:
      'graphcorn — persist a durable discovery to the knowledge graph and link it to the current acorn session AND project. ' +
      'Use this LIBERALLY when you learn something specific and useful that should survive the session: a config value that worked, a tool quirk, a workflow that fixed something, a port number, a CLI flag that mattered. ' +
      'Lighter than graph_update — you provide the text, SPORE creates a properly-structured `discovery` node, links it to the session-<id> node (provenance) AND the project node (so future sessions on the same project can find it). ' +
      'Prefer note_discovery for casual one-line saves; use graph_update when you genuinely need full schema control (custom node type, multiple aspects, explicit edges to specific nodes).',
    inputSchema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'One-line summary of the discovery (e.g. "Expo dev server defaults to port 8081 on Windows; use --port to override").' },
        kind:  {
          type: 'string',
          enum: ['fact', 'gotcha', 'workflow', 'config', 'failure_fix'],
          description: 'What kind of discovery this is. fact=plain knowledge. gotcha=non-obvious behavior. workflow=a procedure that worked. config=a setting/value. failure_fix=problem→solution pair. Defaults to "fact".',
        },
        label: { type: 'string', description: 'Optional short label for the node (e.g. "Expo port default"). Auto-derived from text if omitted.' },
        relatedTo: { type: 'array', items: { type: 'string' }, description: 'Optional existing node ids this discovery relates to (e.g. ["expo", "react-native"]) — creates `relates_to` edges.' },
      },
      required: ['text'],
    },
    execute: (input, ctx) => noteDiscovery(api, input, ctx),
  });

  // Prompt sections — Project Context (every acorn turn) + Plan Mode (when
  // projectContext.mode === 'plan'). Registered with the `*` wildcard so
  // they appear in EVERY prompt mode. Acorn turns route through chat mode
  // for tighter token budgets, but the agent still needs the project /
  // session context to behave correctly. Both renderFns return null on
  // non-acorn turns so they no-op for web/discord/etc. Each returns a
  // fully-formatted block including its own `## ` heading;
  // _buildPluginPromptSections sees the leading `## ` and skips its
  // auto-prefix.
  api.registerPromptSection('*', 'Project Context', ({ opts }) => buildProjectContextSection(api, opts));
  api.registerPromptSection('*', 'Plan Mode',       ({ opts }) => buildPlanModeSection(api, opts));

  // afterToolExec middleware — owns the graphcorn temp-tagging contract
  // for graph_update. When a graph_update call inside an acorn ctx
  // creates a NEW node (result.created === true), tag it with
  // `{ ttl: 'temp', sessionId, tempCreated }` so session-end distillation
  // picks winners. Skips if:
  //   • not platform=cli (web/discord/cron callers don't get the tag)
  //   • the operator passed temp:false explicitly (input.temp === false)
  //     — would rather ship the tag, but respect the explicit override
  //   • the agent already set extra.ttl=temp via input.temp:true
  //     (the in-tree path handles that and we don't double-write)
  //   • the session was already distilled (race with session-end)
  //   • the node id matches a graphcorn-managed pattern (session-, project-)
  // Never fires outside an acorn ctx — when the plugin is uninstalled,
  // this entire branch disappears with the rest of the plugin.
  api.registerMiddleware('afterToolExec', ({ name, input, result, ctx }) => {
    if (name !== 'graph_update' || !result?.created || !result?.nodeId) return;
    if (ctx?.platform !== 'cli' || !ctx?.channelId) return;
    if (input?.temp === false || input?.temp === true) return;
    const learner = api._appContext?.learner;
    const db = learner?.db;
    if (!db) return;
    const sessionId = ctx.channelId;
    const sessNodeId = 'session-' + String(sessionId);
    try {
      const sessRow = db.prepare(
        "SELECT json_extract(extra, '$.distilled_at') AS distilled FROM nodes WHERE id = ?"
      ).get(sessNodeId);
      if (sessRow?.distilled) return;
      const nodeRow = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(result.nodeId);
      if (!nodeRow) return;
      let extra = {};
      try { extra = nodeRow.extra ? JSON.parse(nodeRow.extra) : {}; } catch { extra = {}; }
      if (extra.sessionId || String(result.nodeId).startsWith('session-') || String(result.nodeId).startsWith('project-')) return;
      extra.ttl = 'temp';
      extra.sessionId = sessionId;
      if (!extra.tempCreated) extra.tempCreated = new Date().toISOString();
      db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(extra), result.nodeId);
    } catch (e) {
      api.getLogger().warn(`[graphcorn] graph_update temp-tag failed: ${e.message}`);
    }
  });

  // afterLearn worker hook — fires once after the learner finishes a batch.
  // For acorn turns (sessionIdOpt non-null), auto-link every newly-created
  // entity to the session-<id> node via a `discovered_in` edge so a
  // later graph_query "what did session X teach us" returns them.
  // No-op for non-acorn extractions.
  api.registerWorkerHook('afterLearn', ({ sessionIdOpt, newNodeIds }) => {
    if (!sessionIdOpt || !Array.isArray(newNodeIds) || newNodeIds.length === 0) return;
    const learner = api._appContext?.learner;
    const db = learner?.db;
    if (!db) return;
    const sessId = 'session-' + String(sessionIdOpt);
    const sessExists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(sessId);
    if (!sessExists) return;
    const checkE = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?');
    const insE = db.prepare(
      "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, 'discovered_in', 1, 'graphcorn-learner')"
    );
    let added = 0;
    for (const nid of newNodeIds) {
      if (nid === sessId) continue;
      if (!checkE.get(nid, sessId, 'discovered_in')) {
        insE.run(nid, sessId);
        added++;
      }
    }
    if (added > 0) {
      api.getLogger().debug(`Added ${added} discovered_in edge(s) to ${sessId}`);
    }
  });

  // afterTurn lifecycle hook — fires once per agent turn after _firePluginAfterTurn.
  // Implements failure-fix discovery synthesis + per-turn breadcrumb on the
  // session node's `rounds` aspect, plus the per-turn project-activity note
  // (cross-session memory accumulator on the project node). All gate
  // internally on platform === 'cli' / projectContext presence so they're
  // no-ops for web/discord turns. Replaces the in-tree _captureFailureFix,
  // _recordRoundCheckpoint, and _noteProjectActivity methods that lived in
  // src/agent/loop.js.
  api.registerLifecycleHook('afterTurn', ({ opts, finalText, toolLog }) => {
    captureFailureFix(api, opts, toolLog || []);
    recordRoundCheckpoint(api, opts, toolLog || [], finalText);
    noteProjectActivity(api, opts, finalText, toolLog || []);
  });

  // Settings pane — surfaces `enabled` toggle + `key` (auto-generated
  // when enabled-but-empty via the onConfigChange hook below). Lives in
  // the Plugins tab alongside email and any other plugin's pane. Replaces
  // the legacy Acorn settings card that lived in graph-viewer.html.
  api.registerSettingsPane({
    title: 'Acorn',
    description: 'Acorn CLI auth — pass the team key to acorn-cli to let it sign in to this SPORE. Tick "Enabled" with an empty key field and save to mint a fresh UUID; clear and save again to regenerate.',
    schema: [
      { key: 'enabled', label: 'Enable Acorn auth', type: 'toggle' },
      { key: 'key',     label: 'Team key',          type: 'password', secret: true,
        help: 'Auto-generated when enabled and empty. Existing CLI users lose access if regenerated.' },
    ],
  });

  // onConfigChange — auto-mint a fresh UUID when the operator enables
  // the plugin without supplying a key (the "ergonomic on-by-default"
  // flow). Runs after the settings save persists `enabled: true, key: ''`,
  // mints a UUID, and writes it back via setConfig — re-fires this hook
  // but with `key` now populated, so the second pass exits early.
  api.onConfigChange(async (oldConfig, newConfig) => {
    if (newConfig?.enabled === true && !newConfig.key) {
      const fresh = crypto.randomUUID();
      try {
        await api.setConfig({ key: fresh });
        api.getLogger().info('Auto-minted fresh team key (enabled with no key supplied).');
      } catch (e) {
        api.getLogger().warn('Auto-mint failed: ' + e.message);
      }
    }
  });

  // webappSelfRegisterCheck lifecycle hook — gates the
  // /api/webapp/users/self-register endpoint with the acorn team key.
  // Returns { allowed: true } on a valid key, or { allowed: false,
  // code, reason } otherwise. When the plugin is uninstalled the hook
  // disappears and core defaults to "self-registration disabled" (503).
  api.registerLifecycleHook('webappSelfRegisterCheck', ({ parsed }) => {
    const stored = resolveAcornKey(api);
    if (!stored) return { allowed: false, code: 503, reason: 'Self-registration is not enabled on this instance.' };
    // Accept both the new generic `teamKey` field and the legacy
    // `acornKey` field so older login pages and Go acorn-cli builds
    // keep working through the rename.
    const typed = String(parsed?.teamKey || parsed?.acornKey || '').trim();
    if (!acornKeyMatches(typed, stored)) return { allowed: false, code: 401, reason: 'Invalid team key' };
    return { allowed: true };
  });

  // shouldSkipRecall lifecycle hook — short-circuits the expensive
  // per-turn recall pipeline for cli-platform coding turns. Returns
  // true to skip; any other return is treated as "don't skip". Core's
  // graph/context.js consults this before kicking off Enhanced Recall.
  api.registerLifecycleHook('shouldSkipRecall', ({ opts, queryType }) => {
    return opts?.platform === 'cli'
      && queryType !== 'aggregation'
      && looksLikeCodingTurn(opts?.messageContent);
  });

  // beforeMessage lifecycle hook — fires once at the top of _runLoop's
  // dynamicOpts assembly, BEFORE the system prompt is built. Returns an
  // opts patch (or null) that the agent loop merges into dynamicOpts.
  // Acorn uses this to upsert the project node from opts.projectContext
  // and surface { cachedProjectNodeId, cachedProjectStale, cachedProjectIsNew }
  // so the plugin's own Project Context prompt section can reference the
  // cached node id and skip re-injecting the full file tree on subsequent
  // sessions in the same project.
  api.registerLifecycleHook('beforeMessage', ({ opts }) => {
    const learner = api._appContext?.learner;
    if (!opts?.projectContext || !learner) return null;
    try {
      const projects = require('./lib/projects');
      const r = projects.upsertProject(learner, opts.userId || 'anon', opts.projectContext);
      if (!r) return null;
      return {
        cachedProjectNodeId: r.id,
        cachedProjectStale:  !!r.gitHashChanged,
        cachedProjectIsNew:  !!r.isNew,
      };
    } catch (e) {
      api.getLogger().warn('[project-node] upsert failed: ' + e.message);
      return null;
    }
  });

  // WS handlers: session:start / session:end. Core's gateways/web.js
  // dispatches `session:*` frames to `plugin:acorn-cli:session:*` via a
  // small alias block; if the plugin isn't installed the alias is a
  // no-op and the frame is silently ignored. session:observe and
  // session:unobserve still live in core because they touch the
  // gateway-internal _sessionClients fan-out map; future cleanup can
  // expose that primitive via the plugin API.
  api.registerWsHandler('session:start', (ws, msg) => sessionStartHandler(api, ws, msg));
  api.registerWsHandler('session:end',   (ws, msg) => sessionEndHandler(api, ws, msg));

  // wsClose lifecycle hook — ungraceful-close distillation chain. The
  // graceful path (session:end frame) sets distilled_at first;
  // distillSession's idempotency guard makes the close-side call a
  // no-op when graceful already ran. For network drop / SIGKILL /
  // alt-tab-and-leave-it, the session:end never arrives and this is
  // the only chance to distill before the 48h janitor sweep. Gates on
  // ws._role === 'cli' so non-cli closes are a no-op.
  api.registerLifecycleHook('wsClose', ({ ws, sessionIds, log }) => {
    if (ws?._role !== 'cli' || !sessionIds?.length) return;
    const ctx = api._appContext;
    const learner = ctx?.tools?.learner || ctx?.learner;
    const config = ctx?.config || {};
    if (!learner) return;
    try {
      const sessions = require('./lib/sessions');
      const llmClient = ctx?.tools?.anthropicClient;
      for (const sid of sessionIds) {
        try {
          sessions.finalizeSessionNode(learner, sid, { endedAt: new Date().toISOString() });
          if (llmClient) {
            sessions.summarizeSessionNode(learner, llmClient, config, sid, log)
              .then(() => sessions.distillSession(learner, llmClient, config, sid, log))
              .catch(e => log.warn(`[graphcorn] ws-close distill error: ${e.message}`));
          }
        } catch (e) {
          log.warn(`[graphcorn] ws-close finalize failed: ${e.message}`);
        }
      }
    } catch (e) {
      api.getLogger().warn(`[graphcorn] wsClose hook failed: ${e.message}`);
    }
  });

  api.getLogger().info('Plugin ready — ref nodes + /auth + /sessions + note_discovery + WS session:* + afterTurn + afterLearn + beforeMessage + shouldSkipRecall + webappSelfRegisterCheck + afterToolExec(graph_update) + settings pane + prompt sections registered.');
};
