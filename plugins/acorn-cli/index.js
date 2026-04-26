// Acorn CLI plugin.
//
// Currently bundles:
//   • Reference-node SQL (5 ref-acorn-* migrations folded in — phase 2.3a)
//   • /api/acorn/auth      → /api/plugins/acorn-cli/auth   (phase 2.3c)
//   • /api/acorn/sessions  → /api/plugins/acorn-cli/sessions (phase 2.3c)
//
// Still in core, scheduled for follow-up sub-phases:
//   • WS handlers (session:start / session:end / session:observe / etc.)
//   • _sessionClients map + orphaned-tool re-delivery
//   • WS-close distillation chain
//   • note_discovery tool + graph_update acorn branches
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

  api.getLogger().info('Plugin ready — ref nodes + /auth + /sessions registered.');
};
