// Acorn CLI plugin.
//
// Currently bundles:
//   • Reference-node SQL (5 ref-acorn-* migrations folded in — phase 2.3a)
//   • /api/acorn/auth      → /api/plugins/acorn-cli/auth   (phase 2.3c-1)
//   • /api/acorn/sessions  → /api/plugins/acorn-cli/sessions (phase 2.3c-1)
//   • note_discovery tool   (phase 2.3c-2)
//
// Still in core, scheduled for follow-up sub-phases:
//   • WS handlers (session:start / session:end / session:observe / etc.)
//   • _sessionClients map + orphaned-tool re-delivery
//   • WS-close distillation chain
//   • graph_update acorn-aware branches (need afterToolExec-with-mutation contract)
//   • src/graph/sessions.js + src/graph/projects.js
//   • Loop helpers (_captureFailureFix, _recordRoundCheckpoint)
//   • Acorn-specific prompt sections
//   • Learner discovered_in edge creation
//   • acornKey settings UI

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
// During the transitional period before phase 2.3g, the Acorn settings
// UI in the host (graph-viewer.html) writes to config.acornKey at the
// top level. We accept either: plugin slot first, then legacy fallback.
function resolveAcornKey(api) {
  const cfg = api.getConfig();
  if (cfg.key) return cfg.key;
  const host = api.getHostConfig();
  return host.acornKey || null;
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
    type: 'acorn',
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
async function noteDiscovery(api, input, ctx) {
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

  api.getLogger().info('Plugin ready — ref nodes + /auth + /sessions + note_discovery registered.');
};
