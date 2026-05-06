// Spore Code plugin.
//
// Depends on the `session-graph` plugin (manifest's `depends` field) for
// the generic primitives — session/project node persistence, the
// note_discovery tool, the per-turn breadcrumb + failure-fix capture
// helpers, and the recall-skip heuristic. spore-code imports those via
// require('../session-graph/lib/...') and wires them into the agent
// loop via the lifecycle hooks below.
//
// spore-code's own surface (the parts that are genuinely Spore-Code-
// specific):
//   • Reference-node SQL (ref-spore-code-* + graphcorn-discovery)
//   • /api/spore-code/auth + /api/spore-code/sessions HTTP routes — the
//     Go-binary wire-protocol contract (registerPathAlias rewrites
//     /api/spore-code/* to /api/plugins/spore-code/*).
//   • WS handlers: session:start / session:end (Go-binary wire frames).
//   • Project Context + Plan Mode prompt sections (Spore-Code-specific
//     UX: PHASE 1-6 plan mode, QUESTIONS marker, SPORE.md handling).
//   • Lifecycle hooks that call into session-graph's lib helpers:
//       - afterTurn: failure-fix + round checkpoints + project activity
//       - afterLearn: discovered_in edges + session-temp tagging
//       - beforeMessage: project-node upsert + cachedProject* opts
//       - shouldSkipRecall: looksLikeCodingTurn gate for cli sessions
//       - isNodeManaged: claims session/project node ownership
//       - wsClose: ungraceful-close distillation chain
//   • afterToolExec middleware: temp-tagging on graph_update creates.
//
// The /auth handler accepts either config.inviteKey (a host-level setting
// in core, NOT a plugin slot) or a local web account password from
// webapp-users.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { coreRequire, modelForTier } = require('../core-require');
const { projectIdentityFromContext } = coreRequire('graph/scopes');
const graphEvents = coreRequire('graph/events');

const SESSION_GRAPH_SLUGS = new Map();
const SESSION_PROJECT_KEYS = new Map();
const SESSION_CLIENT_TOOLS = new Map();
const SESSION_CLIENT_VERSIONS = new Map();
const AUTH_ATTEMPTS = new Map();
const AUTH_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
const WS_TICKET_TTL_MS = 60 * 1000;
const DEVICE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const LEGACY_SPORE_CODE_TOOLS = new Set([
  'index_codebase', 'search_symbols', 'trace_calls', 'get_snippet',
  'architecture', 'impact', 'verify_implementation',
]);

function normalizeToolList(list) {
  if (!Array.isArray(list)) return null;
  const names = list.map(x => String(x || '').trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function clearSessionRuntimeState(sessionId) {
  const key = String(sessionId);
  SESSION_GRAPH_SLUGS.delete(key);
  SESSION_PROJECT_KEYS.delete(key);
  SESSION_CLIENT_TOOLS.delete(key);
  SESSION_CLIENT_VERSIONS.delete(key);
}

function clientToolsForCtx(ctx) {
  return normalizeToolList(ctx?.clientTools)
    || normalizeToolList(ctx?.projectContext?.localTools)
    || (ctx?.channelId ? SESSION_CLIENT_TOOLS.get(String(ctx.channelId)) : null)
    || null;
}

function sporeClientToolAvailable(toolName, opts = {}) {
  return (ctx = {}) => {
    if (ctx.platform !== 'cli') return false;
    const pc = ctx.projectContext || {};
    if (!pc.cwd && !pc.clientCwd) return false;
    const tools = clientToolsForCtx(ctx);
    if (!tools) return opts.legacy === true && LEGACY_SPORE_CODE_TOOLS.has(toolName);
    return tools.has(toolName);
  };
}

function sporeClientToolMeta(toolName, opts = {}) {
  return {
    platforms: ['cli'],
    requiresProjectContext: true,
    requiresClientTool: toolName,
    available: sporeClientToolAvailable(toolName, opts),
  };
}

function withLearnerDb(learner, db, graphSlug = null) {
  if (!learner || !db) return learner;
  const scoped = Object.create(learner);
  scoped.db = db;
  if (graphSlug) scoped._graphSlug = graphSlug;
  return scoped;
}

// ── Resolve the host invite key ────────────────────────────────────
// The spore-code /auth endpoint validates incoming Go-binary connections
// against the host-level SPORE invite key (same key webapp self-register
// uses). Stored in core's config.inviteKey slot; the plugin reads it
// without owning it.
function resolveInviteKey(api) {
  const host = api.getHostConfig();
  return host.inviteKey || null;
}

// Constant-time compare; mirrors src/gateways/web.js _inviteKeyMatches.
function inviteKeyMatches(typed, stored) {
  if (!typed || !stored) return false;
  const a = Buffer.from(String(typed));
  const b = Buffer.from(String(stored));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function requestIp(req) {
  return req?.socket?.remoteAddress || 'unknown';
}

function isLocalRequest(req) {
  const addr = String(req?.socket?.remoteAddress || '');
  return !addr || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isSecureRequest(req) {
  if (!req?.socket) return true; // direct unit tests
  if (req.socket.encrypted) return true;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function insecureAuthAllowed(req) {
  if (isSecureRequest(req) || isLocalRequest(req)) return true;
  return /^(1|true|yes)$/i.test(String(process.env.SPORE_ALLOW_INSECURE_AUTH || process.env.SPORE_CODE_ALLOW_INSECURE_AUTH || ''));
}

function checkAuthRate(req, username, method) {
  const now = Date.now();
  const key = `${requestIp(req)}:${String(username || '').toLowerCase()}:${String(method || 'auth')}`;
  const entry = AUTH_ATTEMPTS.get(key) || [];
  const fresh = entry.filter(t => now - t < AUTH_RATE_LIMIT.windowMs);
  if (fresh.length >= AUTH_RATE_LIMIT.max) {
    AUTH_ATTEMPTS.set(key, fresh);
    return false;
  }
  fresh.push(now);
  AUTH_ATTEMPTS.set(key, fresh);
  return true;
}

function deviceStorePath(api) {
  return path.join(resolveDataDir(api), 'spore-code-devices.json');
}

function readDeviceStore(api) {
  try {
    const parsed = JSON.parse(fs.readFileSync(deviceStorePath(api), 'utf8'));
    if (parsed && Array.isArray(parsed.devices)) return parsed;
  } catch {}
  return { version: 1, devices: [] };
}

function writeDeviceStore(api, store) {
  const file = deviceStorePath(api);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function mintDeviceToken(api, username, authKind) {
  const now = Date.now();
  const token = `spc_${crypto.randomBytes(32).toString('base64url')}`;
  const deviceId = crypto.randomBytes(12).toString('hex');
  const store = readDeviceStore(api);
  store.devices = (store.devices || []).filter(d => !d.revokedAt && now - (d.lastUsedAt || d.createdAt || 0) < DEVICE_IDLE_TTL_MS && now - (d.createdAt || 0) < DEVICE_ABSOLUTE_TTL_MS);
  store.devices.push({
    id: deviceId,
    user: String(username || '').trim(),
    tokenHash: hashToken(token),
    auth: authKind || 'unknown',
    createdAt: now,
    lastUsedAt: now,
  });
  writeDeviceStore(api, store);
  return { deviceId, deviceToken: token, deviceExpiresAt: now + DEVICE_ABSOLUTE_TTL_MS };
}

function validateDeviceToken(api, token) {
  if (!token) return { ok: false, error: 'Invalid or missing device token' };
  const now = Date.now();
  const digest = hashToken(token);
  const store = readDeviceStore(api);
  let changed = false;
  const devices = Array.isArray(store.devices) ? store.devices : [];
  const device = devices.find(d => d?.tokenHash === digest);
  if (!device || device.revokedAt) return { ok: false, error: 'Invalid or revoked device token' };
  if (now - (device.lastUsedAt || device.createdAt || 0) >= DEVICE_IDLE_TTL_MS || now - (device.createdAt || 0) >= DEVICE_ABSOLUTE_TTL_MS) {
    device.revokedAt = now;
    changed = true;
    writeDeviceStore(api, store);
    return { ok: false, error: 'Device token expired' };
  }
  device.lastUsedAt = now;
  changed = true;
  if (changed) writeDeviceStore(api, store);
  return { ok: true, username: device.user, auth: device.auth || 'device', deviceId: device.id };
}

function revokeDeviceToken(api, token) {
  const digest = hashToken(token);
  const store = readDeviceStore(api);
  const device = (store.devices || []).find(d => d?.tokenHash === digest);
  if (!device) return false;
  device.revokedAt = Date.now();
  writeDeviceStore(api, store);
  return true;
}

function bearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  return String(authHeader).startsWith('Bearer ') ? String(authHeader).slice(7).trim() : null;
}

function resolveDataDir(api) {
  const host = api.getHostConfig?.() || {};
  return api._appContext?.config?.dataDir || host.dataDir || process.env.SPORE_DATA_DIR || '/data';
}

function loadWebappUsers(api) {
  const file = path.join(resolveDataDir(api), 'webapp-users.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function verifyWebappPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  const computed = crypto.pbkdf2Sync(String(password), String(salt), 100000, 64, 'sha512').toString('hex');
  if (computed.length !== String(storedHash).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(String(storedHash))); } catch { return false; }
}

function wantsPasswordAuth(parsed) {
  const method = String(parsed?.authMethod || parsed?.auth_method || parsed?.method || '').trim().toLowerCase();
  return method === 'password' || method === 'account' || (!!parsed?.password && !parsed?.key);
}

function authenticateAccountPassword(api, username, password) {
  const host = api.getHostConfig?.() || {};
  if (host.webAuthUser && host.webAuthPass && username === host.webAuthUser && password === host.webAuthPass) {
    return { ok: true, username, role: 'creator' };
  }
  const user = loadWebappUsers(api).find(u => String(u?.username || '') === username);
  if (user?.blocked) {
    return { ok: false, status: 403, error: 'Your account has been blocked. Contact the operator.' };
  }
  if (!user || !verifyWebappPassword(password, user.salt, user.hash)) {
    return { ok: false, status: 401, error: 'Invalid credentials' };
  }
  return { ok: true, username: user.username, role: user.role || 'webapp' };
}

function issueCliToken(api, res, username, authKind, opts = {}) {
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

  const cleanUser = String(username || '').trim();
  const sporeSid = crypto.randomBytes(16).toString('hex');
  webSessions.set(sporeSid, {
    user: cleanUser,
    // 'cli' is core's generic CLI-class role — core's WS handler treats
    // any session with type 'cli' as a CLI client (sessionId-keyed
    // history, no graph-event broadcast, etc.). Plugin-specific role
    // names like 'spore-code' would couple core to this plugin.
    type: 'cli',
    auth: authKind,
    created: Date.now(),
    expiresAt: Date.now() + (opts.ttlMs || WS_TICKET_TTL_MS),
    singleUse: opts.singleUse !== false,
    wsTicket: true,
    deviceId: opts.deviceId || null,
  });
  api.getLogger().info(`Auth OK for user: ${cleanUser}${authKind ? ` (${authKind})` : ''}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, token: sporeSid, user: cleanUser, ...(opts.extra || {}) }));
}

// ── HTTP route handlers ─────────────────────────────────────────────

async function handleAuth(api, req, res) {
  if (!insecureAuthAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HTTPS is required for Spore Code authentication. Use localhost or set SPORE_ALLOW_INSECURE_AUTH=true for development.' }));
    return;
  }
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
  const issueDevice = parsed?.issueDevice === true || parsed?.issue_device === true;

  if (!username || typeof username !== 'string' || username.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid username (alphanumeric/_.-, max 64 chars)' }));
    return;
  }

  if (wantsPasswordAuth(parsed)) {
    if (!checkAuthRate(req, username, 'password')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many authentication attempts. Try again later.' }));
      return;
    }
    const auth = authenticateAccountPassword(api, username, String(parsed.password || ''));
    if (!auth.ok) {
      res.writeHead(auth.status || 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: auth.error || 'Invalid credentials' }));
      return;
    }
    const extra = issueDevice ? mintDeviceToken(api, auth.username, 'password') : {};
    issueCliToken(api, res, auth.username, 'password', { extra });
    return;
  }

  if (!checkAuthRate(req, username, 'invite')) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many authentication attempts. Try again later.' }));
    return;
  }
  const inviteKey = resolveInviteKey(api);
  if (!inviteKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No Spore Core invite key set on this instance', code: 'INVITE_KEY_NOT_CONFIGURED' }));
    return;
  }
  if (!inviteKeyMatches(key, inviteKey)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid invite key' }));
    return;
  }
  const extra = issueDevice ? mintDeviceToken(api, username, 'invite') : {};
  issueCliToken(api, res, username, 'invite', { extra });
}

async function handleDeviceSession(api, req, res) {
  if (!insecureAuthAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HTTPS is required for Spore Code authentication. Use localhost or set SPORE_ALLOW_INSECURE_AUTH=true for development.' }));
    return;
  }
  const token = bearerToken(req);
  const auth = validateDeviceToken(api, token);
  if (!auth.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: auth.error || 'Invalid device token' }));
    return;
  }
  issueCliToken(api, res, auth.username, 'device', { deviceId: auth.deviceId });
}

async function handleLogout(api, req, res) {
  if (!insecureAuthAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'HTTPS is required for Spore Code authentication. Use localhost or set SPORE_ALLOW_INSECURE_AUTH=true for development.' }));
    return;
  }
  const token = bearerToken(req);
  if (!token) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, revoked: false }));
    return;
  }
  const revoked = revokeDeviceToken(api, token);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, revoked }));
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
  const token = bearerToken(req);
  let session = token ? webSessions.get(token) : null;
  if (!session || session.type !== 'cli') {
    const device = validateDeviceToken(api, token);
    if (device.ok) session = { user: device.username, type: 'cli', auth: 'device', deviceId: device.deviceId };
  }
  if (!session || session.type !== 'cli') {
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

// ── Generic primitives moved to session-graph plugin ────────────────
// Acorn-cli's manifest declares `"depends": ["session-graph"]` so these
// modules are always available at require time:
//   ../session-graph/lib/sessions.js     — session-node CRUD
//   ../session-graph/lib/projects.js     — project-node CRUD
//   ../session-graph/lib/discovery.js    — noteDiscovery (also exposed
//                                          as the note_discovery tool
//                                          by session-graph itself)
//   ../session-graph/lib/checkpoints.js  — captureFailureFix +
//                                          recordRoundCheckpoint
//   ../session-graph/lib/heuristics.js   — looksLikeCodingTurn
const sessionsLib    = require('../session-graph/lib/sessions');
const projectsLib    = require('../session-graph/lib/projects');
const checkpointsLib = require('../session-graph/lib/checkpoints');
const heuristicsLib  = require('../session-graph/lib/heuristics');
const scriptsLib     = require('../session-graph/lib/scripts');

function projectGraphForContext(api, userId, pc = {}) {
  const registry = api._appContext?.tools?._graphRegistry;
  const learner = api._appContext?.learner;
  if (!registry || !learner?.getGraphDb || !pc?.cwd) return null;
  const identity = projectIdentityFromContext(userId || 'anon', pc);
  if (!identity) return null;
  const slug = registry.ensureProjectGraph(identity.key, {
    name: identity.label,
    description: `${identity.basis} project memory${identity.remote ? ` for ${identity.remote}` : ` for ${identity.root}`}`,
    source: 'spore-code',
    createdBy: 'spore-code',
    userId: userId || 'anon',
    projectKey: identity.key,
    projectRoot: identity.root,
    projectRemote: identity.remote,
  });
  const db = learner.getGraphDb(slug);
  if (!db) return null;
  return {
    slug,
    identityKey: identity.key,
    identity,
    learner: withLearnerDb(learner, db, slug),
  };
}

function scopedLearnerForTurn(api, opts) {
  const slug = opts?.memoryEnvelope?.writeScopes?.projectSlug || opts?.memoryEnvelope?.projectSlug || null;
  const learner = api._appContext?.learner;
  if (!slug || !learner?.getGraphDb) return learner;
  const db = learner.getGraphDb(slug);
  return db ? withLearnerDb(learner, db, slug) : learner;
}

function scopedSessionMemory(api, ws, msg = {}) {
  const ctx = api._appContext;
  const baseLearner = ctx?.tools?.learner || ctx?.learner;
  const sessionId = msg.sessionId != null ? String(msg.sessionId) : null;
  const userId = ws?._user || msg.userName || 'anon';
  const pc = { ...(msg.projectContext || {}), cwd: msg.cwd || msg.projectContext?.cwd };
  let slug = sessionId ? SESSION_GRAPH_SLUGS.get(sessionId) : null;
  let projectIdentityKey = sessionId ? SESSION_PROJECT_KEYS.get(sessionId) : null;

  if (!slug && pc.cwd) {
    const scoped = projectGraphForContext(api, userId, pc);
    if (scoped?.slug) {
      slug = scoped.slug;
      projectIdentityKey = scoped.identityKey;
      if (sessionId) {
        SESSION_GRAPH_SLUGS.set(sessionId, slug);
        SESSION_PROJECT_KEYS.set(sessionId, projectIdentityKey);
      }
      return { learner: scoped.learner, slug, projectIdentityKey, pc };
    }
  }

  const db = slug && baseLearner?.getGraphDb ? baseLearner.getGraphDb(slug) : null;
  return {
    learner: db ? withLearnerDb(baseLearner, db, slug) : baseLearner,
    slug,
    projectIdentityKey,
    pc,
  };
}

// renderCodeGraphMap — pulls the cached `code_graph` aspect off the
// project node (populated by update_code_graph_summary after each
// architecture/index pass) and renders it as a structured prelude
// block for plan-mode PHASE 2. Lets the agent enter codebase scanning
// already oriented (clusters, hot paths, entry points, tech stack)
// instead of starting cold and burning a tool call on architecture().
// Returns null when no code_graph aspect exists yet — the prompt then
// falls back to "call architecture() once first".
function renderCodeGraphMap(learner, userId, cwd, pc = null) {
  if (!learner?.db || !cwd) return null;
  const proj = projectsLib.getProject(learner, userId, cwd, pc);
  if (!proj) return null;
  const attrs = proj.aspects?.code_graph;
  if (!Array.isArray(attrs) || attrs.length === 0) return null;
  // The aspect stores typed lines like:
  //   index_head: <sha>
  //   stats: <numbers>
  //   tech_stack: ts=12f/45s, ...
  //   entry: main app/page.tsx:1
  //   cluster: <name> — <files> files, <symbols> symbols (<lang>)
  //   hot: <qname> ← <n> callers (<file>:<line>)
  //   note: <free text>
  //   bridge: <caller_qname> ← calls → <callee_qname> (<why>)   [code_overview, v0.5.0+]
  //   question: <orientation question>                           [code_overview, v0.5.0+]
  // Group by prefix so the rendered block reads naturally.
  const buckets = { head: [], stats: [], tech_stack: [], entry: [], cluster: [], hot: [], note: [], bridge: [], question: [] };
  for (const a of attrs) {
    if (a.startsWith('index_head:')) buckets.head.push(a.slice('index_head:'.length).trim());
    else if (a.startsWith('stats:')) buckets.stats.push(a.slice('stats:'.length).trim());
    else if (a.startsWith('tech_stack:')) buckets.tech_stack.push(a.slice('tech_stack:'.length).trim());
    else if (a.startsWith('entry:')) buckets.entry.push(a.slice('entry:'.length).trim());
    else if (a.startsWith('cluster:')) buckets.cluster.push(a.slice('cluster:'.length).trim());
    else if (a.startsWith('hot:')) buckets.hot.push(a.slice('hot:'.length).trim());
    else if (a.startsWith('note:')) buckets.note.push(a.slice('note:'.length).trim());
    else if (a.startsWith('bridge:')) buckets.bridge.push(a.slice('bridge:'.length).trim());
    else if (a.startsWith('question:')) buckets.question.push(a.slice('question:'.length).trim());
  }
  const out = [];
  out.push('### Codebase Map (from structural code index — orientation only, not prior reading)');
  if (buckets.head.length) out.push(`index_head: ${buckets.head[0]}  *(if your search comes back stale, re-run \`index_codebase({force:true})\`)*`);
  if (buckets.stats.length) out.push(`stats: ${buckets.stats[0]}`);
  if (buckets.tech_stack.length) out.push(`tech_stack: ${buckets.tech_stack[0]}`);
  if (buckets.entry.length) {
    out.push('entry_points:');
    for (const e of buckets.entry.slice(0, 10)) out.push(`  - ${e}`);
  }
  if (buckets.cluster.length) {
    out.push('clusters (use these names instead of grepping for module shape):');
    for (const c of buckets.cluster.slice(0, 30)) out.push(`  - ${c}`);
  }
  if (buckets.hot.length) {
    out.push('hot_paths (high blast-radius — touching these warrants explicit verification in PHASE 6):');
    for (const h of buckets.hot.slice(0, 20)) out.push(`  - ${h}`);
  }
  if (buckets.note.length) {
    out.push('notes:');
    for (const n of buckets.note.slice(0, 10)) out.push(`  - ${n}`);
  }
  if (buckets.bridge.length) {
    out.push('surprising_calls (cross-cluster bridges from `code_overview` — non-obvious structural couplings):');
    for (const b of buckets.bridge.slice(0, 5)) out.push(`  - ${b}`);
  }
  if (buckets.question.length) {
    out.push('orientation_questions (from `code_overview`, worth holding in mind):');
    for (const q of buckets.question.slice(0, 3)) out.push(`  - ${q}`);
  }
  return out.join('\n');
}


// ── Project activity note (per-turn breadcrumb on project node) ────
// Appends a one-line activity note to the project node so cross-session
// memory accumulates. Captures user prompt + tool-call summary so the
// agent can later graph_query and see "what we worked on last time in
// this project". Cheap (one INSERT, capped at 50). Replaces the
// _noteProjectActivity method that lived in src/agent/loop.js before
// this phase. Gates on projectContext presence so it's a no-op for
// web/discord turns where opts.projectContext is undefined.
// maybePruneStaleScripts opportunistically removes script: nodes that
// haven't been used in 90 days AND haven't proven reliable
// (success_count < 2). Gated to once per 24h per project via a marker
// on the project node's `extra` JSON, so the afterTurn hook doesn't
// re-scan on every chat turn. Safe to run inside afterTurn — operates
// on a small index-aspect list, completes in microseconds.
function maybePruneStaleScripts(api, opts) {
  if (opts?.platform !== 'cli' || !opts?.projectContext?.cwd) return;
  const learner = api._appContext?.learner;
  if (!learner?.db) return;
  try {
    const userId = opts.userId || opts.userName || 'anon';
    const projectId = projectsLib.projectNodeIdFromContext
      ? projectsLib.projectNodeIdFromContext(userId, { ...opts.projectContext, projectIdentityKey: opts.memoryEnvelope?.projectKey || null })
      : scriptsLib.projectNodeId(userId, opts.projectContext.cwd);
    const projRow = learner.db.prepare('SELECT extra FROM nodes WHERE id = ?').get(projectId);
    if (!projRow) return;
    let extra = {};
    try { extra = projRow.extra ? JSON.parse(projRow.extra) : {}; } catch { /* ignore */ }
    const lastPrune = Date.parse(extra.scripts_last_pruned || '') || 0;
    if (lastPrune && Date.now() - lastPrune < 24 * 60 * 60 * 1000) return; // 24h cooldown
    const r = scriptsLib.pruneStaleScripts(learner, projectId);
    if (!r?.ok) return;
    extra.scripts_last_pruned = new Date().toISOString();
    learner.db.prepare('UPDATE nodes SET extra = ? WHERE id = ?').run(JSON.stringify(extra), projectId);
    if (r.pruned && r.pruned.length > 0) {
      api.getLogger().info(`[scripts] pruned ${r.pruned.length} stale scripts on ${projectId}: ${r.pruned.join(', ')}`);
    }
  } catch (e) {
    api.getLogger().warn(`[scripts] prune failed: ${e.message}`);
  }
}

function noteProjectActivity(api, opts, finalText, toolLog) {
  const learner = api._appContext?.learner;
  if (!opts?.projectContext || !learner) return;
  if (!finalText && !(toolLog && toolLog.length)) return;
  try {
    const projects = projectsLib;
    const userSnip = (opts.content || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const tools = (toolLog && toolLog.length)
      ? ` [${toolLog.length} tool calls: ${toolLog.slice(0, 3).map(t => t.tool).join(', ')}${toolLog.length > 3 ? '…' : ''}]`
      : '';
    const summary = `${userSnip}${tools}`;
    projects.noteProjectInteraction(learner, opts.userId || 'anon', opts.projectContext.cwd, summary, {
      ...opts.projectContext,
      projectIdentityKey: opts.memoryEnvelope?.projectKey || null,
    });
  } catch (e) {
    api.getLogger().warn(`[project-node] note failed: ${e.message}`);
  }
}

// ── WS handlers: session:start / session:end ────────────────────────
// graphcorn: session:start fires once per Spore Code launch right after the
// WS handshake, before the first chat:submit. Creates a session-<id>
// graph node + edge to the project node so everything captured during
// the conversation has a graph anchor. Idempotent — flaky reconnects
// re-firing this just bump mentions on the existing node.
function sessionStartHandler(api, ws, msg) {
  if (!msg?.sessionId) return;
  const ctx = api._appContext;
  const baseLearner = ctx?.tools?.learner || ctx?.learner;
  const config = ctx?.config || {};
  if (!baseLearner) return;
  try {
    const sessions = sessionsLib;
    const userId = ws._user || msg.userName || 'anon';
    const pc = { ...(msg.projectContext || {}), cwd: msg.cwd || msg.projectContext?.cwd };
    const scoped = projectGraphForContext(api, userId, pc);
    const learner = scoped?.learner || baseLearner;
    if (scoped?.slug) {
      SESSION_GRAPH_SLUGS.set(String(msg.sessionId), scoped.slug);
      SESSION_PROJECT_KEYS.set(String(msg.sessionId), scoped.identityKey);
    }
    const localTools = normalizeToolList(msg.localTools || msg.projectContext?.localTools);
    if (localTools) SESSION_CLIENT_TOOLS.set(String(msg.sessionId), localTools);
    if (msg.clientVersion) SESSION_CLIENT_VERSIONS.set(String(msg.sessionId), String(msg.clientVersion));
    const r = graphEvents.withGraph(scoped?.slug ? { graph: scoped.slug } : null, () => sessions.upsertSessionNode(learner, {
      sessionId: msg.sessionId,
      userId,
      userName:  msg.userName,
      cwd:       msg.cwd,
      startedAt: msg.startedAt,
      model:     modelForTier('normal', config),
      projectIdentityKey: scoped?.identityKey || null,
      ...(msg.projectContext || {}),
    }));
    if (r) api.getLogger().info(`[graphcorn] session:start → ${r.id}${r.isNew ? ' (new)' : ''}${r.projectId ? ' part_of ' + r.projectId : ''}${scoped?.slug ? ` @ ${scoped.slug}` : ''}`);
  } catch (e) {
    api.getLogger().warn(`[graphcorn] session:start failed: ${e.message}`);
  }
}

// Phase 7 + 8 of the session lifecycle: chain summarize → distill on
// session:end. Both fire-and-forget so they don't block the WS close.
// distillSession is idempotent (extra.distilled_at marker), so if the
// WS ALSO drops and re-fires distillation from the close handler in
// core, the second call is a no-op.
function waitForLearnerDrain(learner, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const queueDepth = Array.isArray(learner?._queue) ? learner._queue.length : 0;
      if (!learner?._running && queueDepth === 0) return resolve();
      if (Date.now() - started >= timeoutMs) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
}

function sessionEndHandler(api, ws, msg) {
  if (!msg?.sessionId) return;
  const ctx = api._appContext;
  const baseLearner = ctx?.tools?.learner || ctx?.learner;
  const config = ctx?.config || {};
  const log = api.getLogger();
  if (!baseLearner) return;
  try {
    const slug = SESSION_GRAPH_SLUGS.get(String(msg.sessionId));
    const db = slug && baseLearner.getGraphDb ? baseLearner.getGraphDb(slug) : null;
    const learner = db ? withLearnerDb(baseLearner, db, slug) : baseLearner;
    const sessions = sessionsLib;
    graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.finalizeSessionNode(learner, msg.sessionId, { endedAt: msg.endedAt }));
    log.info(`[graphcorn] session:end → session-${msg.sessionId}${slug ? ` @ ${slug}` : ''}`);
    const llmClient = ctx?.tools?.llmClient;
    if (llmClient) {
      waitForLearnerDrain(baseLearner)
        .then(() => graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.summarizeSessionNode(learner, llmClient, config, msg.sessionId, log)))
        .then(() => graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.distillSession(learner, llmClient, config, msg.sessionId, log)))
        .catch(e => log.warn(`[graphcorn] summary/distill error: ${e.message}`))
        .finally(() => clearSessionRuntimeState(msg.sessionId));
    } else {
      clearSessionRuntimeState(msg.sessionId);
    }
  } catch (e) {
    api.getLogger().warn(`[graphcorn] session:end failed: ${e.message}`);
  }
}

// saveProjectScriptFromFileHandler — receives an auto-saved helper
// script the CLI flagged via path-pattern match (.spore-code/scratch/*,
// gen_*.py, *_helper.*, etc.) and persists it to the graph via
// scripts.upsertScriptNode. Lets the agent stop remembering
// save_project_script — the CLI fires this deterministically every
// time write_file/edit_file lands on a helper path. Same secret-
// pattern guard as the agent-callable tool, so credentials don't
// auto-leak.
function saveProjectScriptFromFileHandler(api, ws, msg) {
  if (!msg?.sessionId || !msg?.cwd || !msg?.name || !msg?.body) return;
  const scoped = scopedSessionMemory(api, ws, msg);
  const learner = scoped.learner;
  if (!learner) return;
  const userId = ws?._user || msg.userName || 'anon';
  const projectId = projectsLib.projectNodeIdFromContext(userId, {
    ...(scoped.pc || {}),
    cwd: msg.cwd,
    projectIdentityKey: scoped.projectIdentityKey,
  });
  try {
    const r = scriptsLib.upsertScriptNode(learner, {
      projectId,
      sessionId: msg.sessionId,
      name: msg.name,
      description: msg.description,
      language: msg.language,
      body: msg.body,
      tags: Array.isArray(msg.tags) ? msg.tags : ['auto-saved'],
      force: msg.force === true,
    });
    if (r?.ok) {
      api.getLogger().info(`[scripts] auto-saved ${r.scriptNodeId} from ${msg.path || '(unknown)'} (${msg.language || '?'}, ${(msg.body || '').length} bytes)`);
    } else if (r?.reason === 'suspected_secret') {
      api.getLogger().warn(`[scripts] auto-save skipped for ${msg.path}: secret pattern detected (${r.pattern}) on line ${r.line}`);
    } else if (!r?.ok) {
      api.getLogger().warn(`[scripts] auto-save failed for ${msg.path}: ${r?.error || 'unknown'}`);
    }
  } catch (e) {
    api.getLogger().warn(`[scripts] from-file handler error: ${e.message}`);
  }
}

// recordScriptOutcomeFromExecHandler — receives an "exec just ran a
// saved helper script" event from the CLI and bumps the matching
// script's success_count or fail_count via
// scripts.recordScriptOutcome. Lets the agent stop calling
// record_script_outcome by hand: every exec that touches a
// saved-helper path automatically updates its reliability counters.
function recordScriptOutcomeFromExecHandler(api, ws, msg) {
  if (!msg?.sessionId || !msg?.cwd || !msg?.name) return;
  const scoped = scopedSessionMemory(api, ws, msg);
  const learner = scoped.learner;
  if (!learner) return;
  const userId = ws?._user || msg.userName || 'anon';
  const projectId = projectsLib.projectNodeIdFromContext(userId, {
    ...(scoped.pc || {}),
    cwd: msg.cwd,
    projectIdentityKey: scoped.projectIdentityKey,
  });
  try {
    const r = scriptsLib.recordScriptOutcome(learner, projectId, msg.name, msg.ok === true);
    if (r?.ok) {
      const which = msg.ok ? 'success' : 'failure';
      api.getLogger().debug(`[scripts] auto-recorded ${which} for ${msg.name} (${msg.ok ? 'success_count' : 'fail_count'}=${r[msg.ok ? 'success_count' : 'fail_count']})`);
    } else if (!r?.ok && r?.error && !r.error.includes('no script named')) {
      // "no script named X" is the common case when an exec touches a
      // helper-shaped path that wasn't auto-saved (e.g. agent ran a
      // helper without ever creating it via write_file). Quiet skip.
      api.getLogger().warn(`[scripts] auto-record failed for ${msg.name}: ${r.error}`);
    }
  } catch (e) {
    api.getLogger().warn(`[scripts] outcome handler error: ${e.message}`);
  }
}

// codeGraphSummaryHandler — receives a structural-index summary
// payload from Spore Code and writes it to the project node's
// `code_graph` aspect via projectsLib.upsertProjectCodeGraph.
//
// Why this exists: until v0.7 we relied on the agent to call
// architecture + update_code_graph_summary. In practice the agent
// rarely did — when the user asked for execute-mode work the agent
// went straight to the task and skipped housekeeping. Result:
// project nodes never accumulated codebase-shape memory.
//
// Now the CLI computes architecture locally right after auto-index
// completes, ships it as a `code_graph:summary` WS frame, and this
// handler upserts the aspect. No agent turn wasted, populates
// silently every session.
function codeGraphSummaryHandler(api, ws, msg) {
  if (!msg?.sessionId) return;
  const scoped = scopedSessionMemory(api, ws, msg);
  const learner = scoped.learner;
  if (!learner) return;
  const userId = ws?._user || msg.userName || 'anon';
  const cwd = msg.cwd;
  if (!cwd) return;
  try {
    const r = projectsLib.upsertProjectCodeGraph(learner, userId, cwd, msg.summary || {}, {
      ...(scoped.pc || {}),
      cwd,
      projectIdentityKey: scoped.projectIdentityKey,
    });
    if (r?.ok) {
      api.getLogger().info(
        `[code_graph] mirrored summary onto ${r.projectNodeId} ` +
        `(${msg.summary?.stats?.files || 0} files, ${msg.summary?.stats?.symbols || 0} symbols)`
      );
    } else {
      api.getLogger().warn(`[code_graph] mirror failed: ${r?.error || 'unknown'}`);
    }
  } catch (e) {
    api.getLogger().warn(`[code_graph] handler error: ${e.message}`);
  }
}

// ── Prompt sections ─────────────────────────────────────────────────
// Acorn-specific prompt content. Originally lived inline in
// src/graph/prompt-sections.js _buildRuntimeSection (~225 lines),
// gated on opts.platform === 'cli'. Moved out so non-cli turns
// see ZERO cli-specific content and uninstalling the plugin removes both
// blocks entirely.
//
// Project Context: emitted on every cli turn, branches on cached
//   project node (short reference if already in graph) vs uncached
//   (full inline tree + ACORN.md). Includes the "This Session" sub-
//   block when the session-<id> node exists.
//
// Plan Mode: emitted when projectContext.mode === 'plan'. Verbatim
//   port of the Python PLAN_PREFIX from the legacy acorn/cli.py — preserves the
//   QUESTIONS: marker format, JSON+prose accepted, the 'ask first
//   then plan' rule, and the PHASE 1-6 structure.

function buildProjectContextSection(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext) return null;
  const pc = opts.projectContext;
  const hasPriorProjectMemory = !!(
    opts.cachedProjectHasPriorMemory ||
    opts.cachedProjectHasPriorSessions ||
    opts.cachedProjectHasPriorActivity
  );
  const cached = opts.cachedProjectNodeId && !opts.cachedProjectStale && !opts.cachedProjectIsNew && hasPriorProjectMemory;
  const parts = [];
  parts.push(`## Project Context — ${pc.project || 'project'}`);
  parts.push('Project operating rules are loaded from this project graph in the Scoped Recall Bundle. Follow those refs for runtime access, sandboxing, shell quoting, dev servers, helper scripts, listing/output filtering, plan/execute flow, and verification.');
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
    parts.push(`- Project memory: graph node \`${opts.cachedProjectNodeId}\` (existing project memory from prior sessions). Use \`graph_query({ query: "...", nodeId: "${opts.cachedProjectNodeId}" })\` to retrieve file tree, SPORE.md, prior decisions, and recent activity from past sessions.`);
  } else {
    if (pc.tree && pc.tree.length) {
      const shown = pc.tree.slice(0, 80);
      parts.push(`- Project tree (${pc.tree.length} entries${pc.tree.length > shown.length ? `, showing first ${shown.length}` : ''}):`);
      for (const path of shown) parts.push(`    ${path}`);
    }
    if (pc.sporeMd) {
      parts.push('');
      parts.push('### SPORE.md (project instructions from the user)');
      parts.push(pc.sporeMd);
    }
    if (opts.cachedProjectNodeId) {
      parts.push('');
      if (hasPriorProjectMemory) {
        parts.push(`**Project memory**: this project is tracked as graph node \`${opts.cachedProjectNodeId}\`. Use \`graph_query({ nodeId: "${opts.cachedProjectNodeId}" })\` to retrieve prior decisions, conventions, and recent activity from past sessions.`);
      } else {
        parts.push(`**Project graph**: \`${opts.cachedProjectNodeId}\` is fresh for this project scope. A code index may already be mirrored here, but that is only structural orientation. Do not claim you already read or explained the codebase unless this conversation actually did that.`);
      }
    }
  }

  // Session sub-block — only emitted when the session-<id> node actually exists.
  if (opts.channelId) {
    const sessNodeId = 'session-' + String(opts.channelId);
    let sessionExists = false;
    try {
      const scopedLearner = scopedLearnerForTurn(api, opts);
      const db = scopedLearner?.db || api._appContext?.graph?.db;
      sessionExists = !!db?.prepare('SELECT 1 FROM nodes WHERE id = ?').get(sessNodeId);
    } catch (e) { api.getLogger().warn('session-exists check failed: ' + e.message); }
    if (sessionExists) {
      parts.push('');
      parts.push('## This Session');
      parts.push(`- Session node: \`${sessNodeId}\` — anchor for everything captured this conversation`);
      if (opts.cachedProjectNodeId) {
        parts.push(`- Project node: \`${opts.cachedProjectNodeId}\` — sibling anchor for cross-session memory in the same project`);
      }
      parts.push('- Persist durable discoveries with `note_discovery`; use `graph_update` only when you need full schema control. Session/project linking and distillation rules live in the project operating refs.');
    }
  }

  parts.push('');
  if (pc.scope === 'expanded') {
    parts.push(`**Sandbox**: expanded for this session. Project root is still ${pc.cwd}; write project files there unless the user explicitly asked for another path.`);
  } else {
    parts.push(`**Sandbox**: strict to ${pc.cwd}. If the user asks for paths outside this root, ask them to run \`/scope expanded\`.`);
  }
  // Project memory summary — counts only, never bodies. Cheap: pulls
  // from the project node's scripts_index aspect + the codeindex
  // staleness flag we plumbed through ProjectContext. Lets the agent
  // see "7 scripts saved, code graph indexed at <sha>" before any
  // tool call, so it can pick the right next move (list_project_scripts,
  // architecture, search_symbols, ...) without guessing.
  try {
    const learner = scopedLearnerForTurn(api, opts);
    const userId = opts.userId || opts.userName || 'anon';
    const projectId = pc.cwd ? projectsLib.projectNodeIdFromContext(userId, {
      ...pc,
      projectIdentityKey: opts.memoryEnvelope?.projectKey || null,
    }) : null;
    const summary = [];
    let savedScripts = [];
    if (projectId && learner?.db) {
      savedScripts = scriptsLib.listScriptsIndex(learner, projectId);
      if (savedScripts.length > 0) summary.push(`scripts: ${savedScripts.length} saved (listed below — re-use via get_project_script)`);
    }
    if (pc.hasCodeIndex) {
      const head = pc.indexHead ? `head ${pc.indexHead}` : 'present';
      summary.push(`code_graph: indexed (${head})`);
    }
    if (summary.length) {
      parts.push('');
      parts.push('### Project memory');
      for (const s of summary) parts.push(`- ${s}`);
    }

    // Inline saved-script list so the agent sees them as passive
    // context — no tool call needed to discover what's there. Cap at
    // 30 entries so a project with hundreds of scripts doesn't
    // dominate the prompt; if there are more, the count line above
    // still tells the agent to call list_project_scripts.
    if (savedScripts.length > 0) {
      parts.push('');
      parts.push('### Saved helper scripts (re-use before re-deriving)');
      parts.push('Each line: `name (lang) — description`. Fetch the body via `get_project_script({name})`. The CLI will rehydrate the file under `.spore-code/scratch/<name>.<ext>` so you can `exec` it directly.');
      const shown = savedScripts.slice(0, 30);
      for (const s of shown) {
        const tagBits = (s.tags && s.tags.length) ? ` [${s.tags.join(',')}]` : '';
        const stats = (s.success_count || s.fail_count) ? ` (✓${s.success_count || 0}/✗${s.fail_count || 0})` : '';
        parts.push(`- **${s.name}** (${s.language || '?'})${tagBits}${stats} — ${s.description || '(no description)'}`);
      }
      if (savedScripts.length > shown.length) {
        parts.push(`- … and ${savedScripts.length - shown.length} more (call \`list_project_scripts\` to enumerate)`);
      }
      parts.push('**Before writing a new helper, scan this list — if one matches the task, fetch and run it instead.** This is how the next session inherits the work.');
    }

    // Always-on codeindex usage prompt — applies in BOTH plan and
    // execute modes. Without this, execute-mode sessions revert to
    // grep + read_file by default because the agent's training
    // doesn't strongly weight the new tools. The "use INSTEAD of
    // grep" guidance was previously locked to plan-mode Phase 2;
    // moving it here makes the structural tools the default
    // search path whenever the index exists.
    // Codebase structural-search bullets are now plan-mode only —
    // PHASE 2 already enumerates the same tools, and execute mode just
    // follows the plan, so the duplicated 5-tool intro was wasted on
    // ~70% of cli turns. See buildPlanModeSection.

    // Helper-script save nudge — applies whenever the agent has
    // generated a helper file in `.spore-code/scratch/` or in the
    // project root with no obvious caller. This appears every turn
    // in execute mode, since that's where helper scripts get
    // written. Cheap pattern-match nudge; the agent decides
    // whether to act.
    // (Helper-scripts guidance lives in the dedicated Helper scripts
    // paragraph further down — the previous stub here was a duplicate.
    // web_serve refusal also removed: the cli tool-catalog filter in
    // tools.js TOOLS_EXCLUDED_FROM_CLI now strips web_serve entirely
    // for cli sessions, so the agent never sees it as an option.)
  } catch (e) {
    // Non-fatal — the rest of the prompt still renders.
    api.getLogger().warn('project_memory_summary build failed: ' + e.message);
  }

  parts.push('Use the project operating refs for helper-script workflow, safe project listing, output filtering, shell/platform gotchas, background process handling, and verification discipline.');
  // Plan-mode-only research / lookup / gotcha-loading rules now live
  // in buildPlanModeSection (PHASE 3 area). They were wasted in
  // execute mode — the agent isn't researching during execution, it's
  // following the plan. The "Load gotchas BEFORE first tool call"
  // rule also conflicted with Execute Mode's "FIRST set of tool calls
  // MUST be task_create"; resolved by scoping it to plan mode where
  // it actually applies.

  return parts.join('\n');
}

// Phase router for plan mode. The single-turn "PHASE 1-6 in one go"
// pattern was replaced by an explicit two-turn pipeline:
//   turn 1 (RESEARCH): pronged external + codebase pre-identification,
//                      ends with structured RESEARCH_DONE: block
//   turn 2 (BUILDING): consumes the prior turn's RESEARCH_DONE block,
//                      emits the final plan + Verification + PLAN_READY
//
// Phase is detected from the user's current message content. The CLI
// auto-sends a "[BUILD_PLAN]" sentinel after detecting RESEARCH_DONE in
// the streamed response, which is what flips the prompt to BUILDING.
// No proto changes — pure content-sniff.
function detectPlanPhase(opts) {
  // task_complete wakeups fire when delegate_task sub-agents return
  // mid-research. The system prompt rebuilds and detectPlanPhase runs
  // again — but the "user message" is now the sub-agent's results, not
  // a [RESEARCH]/[BUILD_PLAN] sentinel. Falling back to ROUTER would
  // hijack the research mid-flight (agent sees router prompt while it
  // was meant to keep researching). Default to RESEARCH on these
  // continuations — the agent is mid-research, keep it that way.
  if (opts.trigger === 'task_complete') return 'research';

  const msg = (opts.messageContent || opts.content || '').trim();
  if (msg.startsWith('[BUILD_PLAN]') || msg.startsWith('[BUILD_PLAN ')) return 'building';
  if (msg.startsWith('[REVIEW]') || msg.startsWith('[REVIEW ')) return 'router2';
  if (msg.startsWith('[RESEARCH]') || msg.startsWith('[RESEARCH ')) return 'research';
  return 'router';
}

function buildPlanModeSection(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext || opts.projectContext.mode !== 'plan') return null;
  const phase = detectPlanPhase(opts);
  if (phase === 'building') return buildPlanBuildingSection(api, opts);
  if (phase === 'router2') return buildPlanRouter2Section(api, opts);
  if (phase === 'research') return buildPlanResearchSection(api, opts);
  return buildPlanRouterSection(api, opts);
}

// ROUTER phase prompt — the FIRST plan-mode turn. Tiny prompt; the
// agent reads the user's request and decides one of two things:
//   - Material ambiguity exists → emit QUESTIONS: block (existing
//     modal flow handles it). After user answers, CLI auto-prepends
//     "[RESEARCH]" to the answers so the next turn enters RESEARCH.
//   - Request is concrete enough to research directly → emit
//     NO_INTERVIEW_NEEDED: <one-line reason>. CLI detects this and
//     auto-fires "[RESEARCH] continue" as the next turn.
//
// Keeping this turn explicit (instead of folding it into RESEARCH)
// lets the user see the agent's interview-or-skip judgment up-front
// and gives a clean checkpoint where they can intervene before any
// real work starts.
function buildPlanRouterSection(api, opts) {
  const parts = [];
  parts.push('## Plan Mode — ROUTER (Spore Code)');
  parts.push('[MODE: Plan only — ROUTER turn. This is the FIRST turn of a 3-stage plan workflow:');
  parts.push('  1. ROUTER (this turn) — decide whether to interview the user or skip straight to research.');
  parts.push('  2. RESEARCH+CODE (next turn) — pronged: external research + codebase pre-identification.');
  parts.push('  3. BUILDING (final turn) — produce the plan from stages 1+2 outputs, end with PLAN_READY.');
  parts.push('');
  parts.push('Your only job THIS turn is the interview-or-skip decision. Do NOT write the plan. Do NOT run research tools (no architecture/search_symbols/web_search/delegate_task). Just decide.');
  parts.push('');
  parts.push('--- DECIDE ---');
  parts.push('Ask yourself: would I take a materially different path through the plan based on the user\'s answer to a question? Specifically:');
  parts.push('  - Tooling categories the user likely has a preference about: language/runtime, framework, package manager, build tool, test runner, linter/formatter, type system, styling, database/ORM, auth, deployment target, state management.');
  parts.push('  - Scope ambiguity (e.g. "build a website" — what kind, audience, features).');
  parts.push('  - Approach ambiguity (e.g. "make it faster" — measure first vs assume bottleneck; rewrite vs incremental).');
  parts.push('Skip a category when:');
  parts.push('  - The existing codebase already commits to a choice (check Project Context — package.json, go.mod, pyproject.toml).');
  parts.push('  - The choice is trivial (e.g. don\'t ask about test runner if vitest is already in package.json).');
  parts.push('  - The user clearly expects you to choose (e.g. "implement this small bug fix").');
  parts.push('');
  parts.push('--- TWO POSSIBLE OUTPUTS ---');
  parts.push('');
  parts.push('Option A — Interview needed. Emit ONLY a QUESTIONS: block (no preamble, no postamble):');
  parts.push('QUESTIONS:');
  parts.push('```json');
  parts.push('[');
  parts.push('  {"text": "Question?", "type": "single|multi|open", "options": ["A","B","C"]}');
  parts.push(']');
  parts.push('```');
  parts.push('Valid `type`: `single` (one-of), `multi` (any-of), `open` (free text).');
  parts.push('Aim for 1–4 questions. Don\'t ask trivia you can derive from the codebase.');
  parts.push('');
  parts.push('Option B — Skip interview. Emit:');
  parts.push('NO_INTERVIEW_NEEDED: <one-line reason, ≤120 chars — e.g. "scope is concrete and stack is committed in package.json">');
  parts.push('');
  parts.push('That\'s it. Do NOT emit both. Do NOT add a plan. Read-only inspection of the Project Context above is fine if you need to confirm something (e.g. checking package.json for the test runner).');
  parts.push('');
  parts.push('RULES (HARD):');
  parts.push('- Do NOT call write_file/edit_file/exec. This router turn is output-only.');
  parts.push('- Do NOT start servers, install packages, create temp scripts, or modify project files.');
  parts.push(']');
  return parts.join('\n');
}

// ROUTER2 phase prompt — fires AFTER the RESEARCH+CODE turn. Same
// interview-or-skip decision shape as ROUTER1, but the agent now
// reviews its own RESEARCH_DONE block from the previous turn and
// decides whether the findings surfaced any new questions worth
// asking the user before the plan is built. Common reasons:
//   - Two competing approaches showed up in research, both viable
//   - A library has a breaking change between versions and the user
//     should choose upgrade vs stay
//   - The codebase scan found two patterns for the same concern
//     (e.g. two state-management approaches) — pick which to follow
//   - A blast-radius check (impact > 20 callers) makes the user-facing
//     trade-off worth confirming
//
// If nothing material surfaced → emit NO_FOLLOWUP_QUESTIONS: and the
// CLI auto-fires [BUILD_PLAN].
function buildPlanRouter2Section(api, opts) {
  const parts = [];
  parts.push('## Plan Mode — ROUTER 2 / post-research review (Spore Code)');
  parts.push('[MODE: Plan only — POST-RESEARCH ROUTER turn. The previous assistant turn in this conversation contains a RESEARCH_DONE: yaml block. Read it carefully — your only job this turn is to decide whether the research SURFACED any new questions worth asking the user before the plan is built.');
  parts.push('');
  parts.push('Stage status: ROUTER1 ✓ → RESEARCH+CODE ✓ → ROUTER2 (this turn) → BUILDING (next).');
  parts.push('');
  parts.push('--- DECIDE ---');
  parts.push('Look for genuine forks in the road that the research output revealed:');
  parts.push('  - **Approach forks**: research found two valid approaches with different trade-offs the user would care about (e.g. "server-render vs ISR", "rewrite the scroll system vs incrementally fix it").');
  parts.push('  - **Version/upgrade forks**: research surfaced a breaking change and the user should choose upgrade-now vs stay-on-current-version.');
  parts.push('  - **Codebase pattern forks**: code_targets surfaced multiple existing patterns for the same concern (e.g. project uses both Context AND Zustand — which to extend?).');
  parts.push('  - **High-blast-radius edits**: a `files_to_modify` entry has callers_after_change > 20, and the user should explicitly approve touching that hot edge.');
  parts.push('  - **Genuine gaps**: code_targets is missing a piece that research couldn\'t determine alone (e.g. "couldn\'t find an auth middleware — does the project have one outside the indexed files?").');
  parts.push('');
  parts.push('Skip a question when:');
  parts.push('  - Research clearly pointed at one direction with no real alternative.');
  parts.push('  - The trade-off is internal/technical, not a user-facing preference.');
  parts.push('  - You\'re tempted to ask "does this look right?" — that\'s what PLAN_READY + the modal is for, not router2.');
  parts.push('');
  parts.push('--- TWO POSSIBLE OUTPUTS ---');
  parts.push('');
  parts.push('Option A — Follow-up questions exist. Emit ONLY a QUESTIONS: block (no preamble, no postamble):');
  parts.push('QUESTIONS:');
  parts.push('```json');
  parts.push('[');
  parts.push('  {"text": "Question?", "type": "single|multi|open", "options": ["A","B","C"]}');
  parts.push(']');
  parts.push('```');
  parts.push('Aim for 1–3 questions. Reference what the research found in the question text so the user understands why you\'re asking (e.g. "Research found you\'re using both Context and Zustand. Which should the new state live in?").');
  parts.push('');
  parts.push('Option B — No follow-ups, ready to build. Emit:');
  parts.push('NO_FOLLOWUP_QUESTIONS: <one-line reason, ≤120 chars — e.g. "research pointed at server-render approach with no real alternative; ready to build">');
  parts.push('');
  parts.push('That\'s it. Do NOT write the plan. Do NOT redo any research — your job is to evaluate the existing RESEARCH_DONE block, not extend it.');
  parts.push('');
  parts.push('RULES (HARD):');
  parts.push('- Do NOT call write_file/edit_file/exec. This router turn is output-only.');
  parts.push('- Do NOT start servers, install packages, create temp scripts, or modify project files.');
  parts.push(']');
  return parts.join('\n');
}

// RESEARCH phase prompt — pronged external + codebase pre-identification.
// Goal of this turn: collect everything needed to build the plan WITHOUT
// writing the plan itself. Ends with a structured RESEARCH_DONE: yaml block
// that the BUILDING turn (and a potential graph-cached re-plan) reads as
// input. Heavy on instructions because the model needs the exact output
// shape; the BUILDING prompt is correspondingly lighter.
function buildPlanResearchSection(api, opts) {
  const pc = opts.projectContext;
  const parts = [];
  parts.push('## Plan Mode — RESEARCH phase (Spore Code)');
  parts.push('[MODE: Plan only — RESEARCH turn. You are gathering the inputs for a plan, NOT writing the plan yet. The user will see your output and a follow-up BUILDING turn will produce the actual plan from your findings. Run the two prongs below IN PARALLEL within this single turn, then emit RESEARCH_DONE: as the LAST thing.');
  parts.push('');
  parts.push('PHASE 0 — ENVIRONMENT AUDIT (free, takes no tool calls):');
  parts.push('The Project Context above lists OS, installed tools, project type, and file tree. Note tools/runtimes the request will need that aren\'t installed.');
  parts.push('');
  parts.push('--- PRONG A — EXTERNAL RESEARCH ---');
  parts.push('For each external concept the request touches (frameworks, libraries, APIs, version compatibility, recent breaking changes, best-practice debates), delegate ONE researcher per concept. They run in parallel and return structured Findings/Caveats/Recommendation:');
  parts.push('');
  parts.push('  delegate_task({');
  parts.push('    persona: "researcher",');
  parts.push('    task: "Find current best practices for <X>. Cover <specific subquestions>. Include version-specific gotchas (current year is 2026).",');
  parts.push('    context: "We are planning <project change>. Constraints: <constraints>."');
  parts.push('  })');
  parts.push('');
  parts.push('Aim for 1–3 parallel researchers. Skip Prong A entirely if the request is purely codebase-internal (refactor, rename, bug fix) — say so in the RESEARCH_DONE output.');
  parts.push('Quick one-off lookups (a single CLI flag, a known error string) can use `web_search` + `web_fetch` directly in your turn instead of delegating. Always include the year for recent topics.');
  parts.push('');
  parts.push('--- PRONG B — CODEBASE PRE-IDENTIFICATION ---');
  parts.push('Map the existing codebase against the request. The output is a structured `code_targets` block naming exactly which files get created or modified, with current code excerpts (modifies) and pseudocode shapes (creates).');
  parts.push('');
  if (pc.hasCodeIndex) {
    const learner = scopedLearnerForTurn(api, opts);
    const userId = opts.userId || opts.userName || 'anon';
    const map = renderCodeGraphMap(learner, userId, pc.cwd, {
      ...pc,
      projectIdentityKey: opts.memoryEnvelope?.projectKey || null,
    });
    if (map) {
      parts.push(map);
      parts.push('');
      parts.push('You already have the Codebase Map above. Use cluster names + hot_paths to choose targets without grepping. Order:');
      parts.push('  1. **Skip `architecture()`** — Codebase Map already gives you clusters, hot paths, entry points, and tech stack. Only call it if `index_head` looks stale.');
    } else {
      parts.push(`The repository at ${pc.cwd} is indexed (head ${pc.indexHead || '?'}) but no code_graph aspect is cached yet. Order:`);
      parts.push('  1. `architecture` once → IMMEDIATELY pass the result through `update_code_graph_summary` so future plan-mode sessions can skip this call.');
    }
    parts.push('  2. `search_symbols({ name: "<concept>" })` for each concept named in the request. Narrow by `kind`/`file`/`language` if useful.');
    parts.push('  3. `trace_calls({ name: "<symbol>", direction: "callers", depth: 3 })` for each plausible target. The caller count goes into code_targets.callers_after_change. Cross-check against hot_paths — hits there mean explicit per-step verification in the plan.');
    parts.push('  4. `get_snippet({ qname: "<file>::<container>.<name>" })` for each symbol you intend to modify — the body becomes `current_excerpt` (5–15 lines, the actual current code, not a paraphrase).');
    parts.push('  5. `impact({ paths: [<files you intend to edit>] })` once your target list is firm — populates blast-radius numbers.');
    parts.push('  Do NOT use grep/glob/read_file for symbol discovery here. Allowed only when a search_symbols query came back empty for a name you SEE in the file tree, or for files in unsupported languages.');
  } else {
    parts.push(`No code index exists for ${pc.cwd}. Use \`read_file\`, \`glob\`, and \`grep\` to identify targets. If the project has more than a handful of source files, consider asking the user to run \`/index\` first — it builds a per-project SQLite index that makes future plan-mode scans 50× cheaper.`);
  }
  parts.push('');
  parts.push('PHASE Q — CLARIFY (only if material ambiguity remains AFTER both prongs):');
  parts.push("If something can't be answered by Prong A (no clear best practice) or Prong B (the codebase doesn't commit to one approach) AND the user almost certainly has a preference, emit a QUESTIONS: block INSTEAD of RESEARCH_DONE: this turn. The CLI will surface the picker and resume RESEARCH after answers. Format: see below.");
  parts.push('');
  parts.push('Don\'t ask trivial questions you can answer from the codebase or that the user clearly expects you to choose. Ask only when you would genuinely take different paths based on the answer.');
  parts.push('');
  parts.push('QUESTIONS format (only if needed — emit ONLY this block, then STOP, do NOT emit RESEARCH_DONE the same turn):');
  parts.push('QUESTIONS:');
  parts.push('```json');
  parts.push('[{"text": "Question?", "type": "single|multi|open", "options": ["A","B"]}]');
  parts.push('```');
  parts.push('');
  parts.push('--- OUTPUT — RESEARCH_DONE block ---');
  parts.push('After both prongs are complete, emit this as the LAST thing in your turn (not before — wait for delegations to return). YAML, exact shape:');
  parts.push('');
  parts.push('RESEARCH_DONE:');
  parts.push('```yaml');
  parts.push('external:');
  parts.push('  findings:');
  parts.push('    - "<concrete fact about a library/version/API/best practice>"');
  parts.push('  caveats:');
  parts.push('    - "<gotcha that affects the plan>"');
  parts.push('  recommended_approach: "<one or two sentences on the chosen direction>"');
  parts.push('  # If the request is purely codebase-internal:');
  parts.push('  # external: { skipped: true, reason: "internal refactor, no external dependencies touched" }');
  parts.push('');
  parts.push('code_targets:');
  parts.push('  files_to_create:');
  parts.push('    - path: "<repo-relative path>"');
  parts.push('      purpose: "<what role this file plays>"');
  parts.push('      pseudocode: |');
  parts.push('        // function shape — types, return shape, what calls what.');
  parts.push('        // NOT "// implement X here" — the actual structure.');
  parts.push('      depends_on: ["<other repo paths>"]');
  parts.push('  files_to_modify:');
  parts.push('    - path: "<repo-relative path>"');
  parts.push('      current_excerpt: |');
  parts.push('        <5–15 lines of the ACTUAL current code from get_snippet>');
  parts.push('      change_summary: "<one sentence on the edit>"');
  parts.push('      callers_after_change: <integer from trace_calls>');
  parts.push('  surrounding_context:');
  parts.push('    - name: "<symbol name>"');
  parts.push('      location: "<file>:<line>"');
  parts.push('      why_relevant: "<one sentence>"');
  parts.push('```');
  parts.push('');
  parts.push('RULES (HARD):');
  parts.push('- Do NOT call write_file. Do NOT call edit_file. Do NOT call exec. Use read_file/glob/grep/code-index tools for read-only inspection.');
  parts.push('- Do NOT write the plan in this turn. The plan comes in the next (BUILDING) turn.');
  parts.push('- Do NOT emit PLAN_READY in this turn. RESEARCH_DONE is the marker for this turn.');
  parts.push('- For files_to_modify, current_excerpt MUST come from `get_snippet` — do not paraphrase or invent. If the symbol isn\'t in the index, fall back to `read_file` and excerpt the relevant lines.');
  parts.push('- For files_to_create, pseudocode MUST be the function shape (types, return, key call sites) — not "// TODO" or "// implement here".');
  parts.push(']');
  return parts.join('\n');
}

// BUILDING phase prompt — fires when the CLI sends [BUILD_PLAN] after
// detecting a RESEARCH_DONE block in the prior assistant turn. Reads
// the prior turn's RESEARCH_DONE: from conversation history (which the
// agent sees as messages[]) and produces the final plan + Verification
// + PLAN_READY. Much shorter than RESEARCH because the agent isn't
// gathering anything new — just shaping the plan around the cached findings.
function buildPlanBuildingSection(api, opts) {
  const parts = [];
  parts.push('## Plan Mode — BUILDING phase (Spore Code)');
  parts.push('[MODE: Plan only — BUILDING turn. The user has approved the research and is now waiting for the actual plan. The previous assistant message in this conversation contains a RESEARCH_DONE: yaml block — that is your INPUT for this turn. Use its `external.recommended_approach`, `code_targets.files_to_create`, `code_targets.files_to_modify`, and `surrounding_context` directly when shaping the steps below. Do NOT redo research — if a target is missing from RESEARCH_DONE, that\'s a gap to flag in your risk section, not something to go hunt for now.');
  parts.push('');
  parts.push('OUTPUT — the plan, in this exact structure:');
  parts.push('');
  parts.push('## Approach');
  parts.push('One short paragraph: the chosen direction (from `external.recommended_approach`) and why.');
  parts.push('');
  parts.push('## Steps');
  parts.push('Numbered list of discrete steps. Each step:');
  parts.push('  - Short header (5–10 words) — copied verbatim into a `task_create` row at execution time.');
  parts.push('  - File path(s) it touches — pulled directly from RESEARCH_DONE.code_targets.');
  parts.push('  - One or two sentences describing the change. Reference the `current_excerpt` or `pseudocode` from RESEARCH_DONE — don\'t re-derive.');
  parts.push('  - Dependencies / order — note when a step depends on a prior step landing first.');
  parts.push('  - **Parallelism marker** — append `[parallel: <group-name>]` to the step header when this step is INDEPENDENT of other steps in the same group. Independent = touches different files (or a different region of the same file) AND does not depend on anything created/modified by the other steps in the group. The execute-mode runner fires all steps in a parallel group simultaneously.');
  parts.push('Aim for 4–10 steps. Each step should be small enough that one task_create row covers it.');
  parts.push('');
  parts.push('**Parallelism heuristic — be aggressive about identifying parallel groups.** Most plans have at least 2–4 steps that can run together. Common parallel patterns:');
  parts.push('  - Creating multiple new files in different directories with no cross-references between them');
  parts.push('  - Modifying multiple unrelated files (different cluster from the Codebase Map)');
  parts.push('  - Adding a new route + its server handler + its types definition (3 files, no order dependency)');
  parts.push('  - Writing tests for already-existing code (reads only)');
  parts.push('Common SERIAL patterns (do NOT mark parallel):');
  parts.push('  - Step B reads a file Step A just wrote');
  parts.push('  - Step B exec\'s a command (npm install, build, migrate) that Step A\'s changes need to land first');
  parts.push('  - Two steps editing the same file (line-number drift)');
  parts.push('  - A step that adds a function and another step that imports/calls it');
  parts.push('Format: `1. Create the API client [parallel: setup]` — group name is free-form, just consistent across the steps that should fire together. A step with no `[parallel: ...]` runs serially in plan order. Within a parallel group, the steps fire together but task_progress still tracks each individually.');
  parts.push('');
  parts.push('## Risks');
  parts.push('Bulleted. Pull `callers_after_change` from RESEARCH_DONE.code_targets.files_to_modify — anything >20 callers is a hot edge that warrants explicit verification. Add any caveats from `external.caveats`. Note any gaps in RESEARCH_DONE that the user should know about.');
  parts.push('');
  parts.push('## Verification');
  parts.push('Bulleted, 2–5 concrete runnable checks. Each check is a specific command or observation with a pass criterion, e.g.:');
  parts.push('  - `bun test src/foo.test.ts` should exit 0, 3 tests passing');
  parts.push('  - `curl -s http://localhost:3000/api/health` should return `{"ok":true}`');
  parts.push('  - `read_file config.ts` — `port` should be `8081`, not `8080`');
  parts.push('Avoid "it should feel better" or "make sure it looks right" — those aren\'t verifications. **For ANY symbol you create or modify, ALSO include a `verify_implementation` check** (the goal-backward 4-level audit: exists → substantive → wired → export-level — catches stub bodies, unwired components, comment-only files):');
  parts.push('  - `verify_implementation({ qnames: ["src/foo.ts::Bar.baz", ...] })` — all listed must report exists/substantive/wired/export_level true');
  parts.push('Pick checks that use existing project tooling and have an unambiguous pass signal.');
  parts.push('');
  parts.push('PLAN_READY');
  parts.push('');
  parts.push('RULES (HARD):');
  parts.push('- Do NOT call write_file/edit_file/exec. Read-only inspection only.');
  parts.push('- Do NOT redo research. The previous turn\'s RESEARCH_DONE is your input — use it.');
  parts.push('- Do NOT emit a QUESTIONS: block — that was the RESEARCH phase\'s opportunity.');
  parts.push('- End with `PLAN_READY` on its own line — that\'s the marker the CLI watches for to show the Execute/Revise/Cancel choice. Without it the user has no way to approve.');
  parts.push('- After the user clicks Execute, the SAME plan is replayed as a NEW turn with mode=execute — that\'s when you actually run write_file etc. Do not pre-emptively write now.]');
  return parts.join('\n');
}

function buildPlanModeSection_LEGACY(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext || opts.projectContext.mode !== 'plan') return null;
  const pc = opts.projectContext;
  const parts = [];
  parts.push('## Plan Mode (Spore Code)');
  parts.push('[MODE: Plan only. You are in planning mode. Follow these phases in order:');
  parts.push('');
  parts.push('PHASE 1 — ENVIRONMENT AUDIT:');
  parts.push("The Project Context section above includes the local environment (OS, installed tools, project type, file tree). Review what is available. If the task requires tools/runtimes not installed, note them.");
  parts.push('');
  if (pc.hasCodeIndex) {
    parts.push('PHASE 2 — CODEBASE SCAN (structural-first):');

    // Inject cached architecture summary so the agent enters this
    // phase already oriented. When present, the prompt below skips the
    // `architecture()` first-call requirement — same data is already
    // here, just costs no tool call.
    const learner = scopedLearnerForTurn(api, opts);
    const userId = opts.userId || opts.userName || 'anon';
    const map = renderCodeGraphMap(learner, userId, pc.cwd, {
      ...pc,
      projectIdentityKey: opts.memoryEnvelope?.projectKey || null,
    });
    if (map) {
      parts.push('');
      parts.push(map);
      parts.push('');
      parts.push(`The repository at ${pc.cwd} is indexed (head ${pc.indexHead || '?'}). The Codebase Map above is a structural summary from the local index — use it as orientation, but do not present it as prior assistant reading. Prefer structural queries over reading files — a single search_symbols result is roughly 50× cheaper in tokens than the equivalent grep + read_file pair. Order:`);
      parts.push('  1. **Skip `architecture()`** — the Codebase Map above already gives you clusters, hot paths, entry points, and tech stack. Only call it if `index_head` looks stale or a cluster\'s listed paths don\'t match what you find when you probe further.');
      parts.push('  2. For each concept named in the user\'s request, `search_symbols({ name: "<concept>" })` (optionally narrow by `kind`, `file`, or `language`). Use the cluster names as a hint for which area to look in.');
      parts.push('  3. For each plausible target symbol, `trace_calls({ name: "<name>", direction: "callers", depth: 3 })` to learn who depends on it. Use `direction: "callees"` to learn what it depends on. Cross-check against the hot_paths list — if your target is on it, the change touches many callers.');
      parts.push('  4. Only after the structural pass is exhausted: `get_snippet({ qname: "..." })` for the 3-5 symbols you will actually modify. Do not read whole files unless the symbol is missing from the index.');
      parts.push('  5. Before producing the plan, `impact({ paths: [<files you intend to edit>] })` and include the affected-callers count in your risk section. Hot edges (e.g. >20 transitive callers) deserve explicit per-step verification in PHASE 6.');
      parts.push('  6. If you DO call `architecture()` because the cached map looked stale, immediately ship the result via `update_code_graph_summary` so the cached map refreshes for the next session.');
    } else {
      // No cached map yet — fall back to the original "architecture first" sequence.
      parts.push(`The repository at ${pc.cwd} is indexed (head ${pc.indexHead || '?'}) but no \`code_graph\` aspect is cached yet — your first job is to populate it. Prefer structural queries over reading files. Order:`);
      parts.push('  1. `architecture` — once, to learn module clusters, entry points, hot paths, and tech stack. Read the `notes` field for any partial-coverage caveats. THEN immediately pass the result through `update_code_graph_summary` so the project node\'s `code_graph` aspect reflects it — that\'s how cross-session and cross-machine memory of this codebase\'s shape gets persisted in the graph viewer (and how future plan-mode sessions can skip this call).');
      parts.push('  2. For each concept named in the user\'s request, `search_symbols({ name: "<concept>" })` (optionally narrow by `kind`, `file`, or `language`).');
      parts.push('  3. For each plausible target symbol, `trace_calls({ name: "<name>", direction: "callers", depth: 3 })` to learn who depends on it. Use `direction: "callees"` to learn what it depends on.');
      parts.push('  4. Only after the structural pass is exhausted: `get_snippet({ qname: "..." })` for the 3-5 symbols you will actually modify. Do not read whole files unless the symbol is missing from the index.');
      parts.push('  5. Before producing the plan, `impact({ paths: [<files you intend to edit>] })` and include the affected-callers count in your risk section. Hot edges (e.g. >20 transitive callers) deserve explicit per-step verification in PHASE 6.');
    }
    parts.push('Do NOT use `grep`, `glob`, or `read_file` for symbol discovery during PHASE 2 unless a tool returned `{ ok: false, error: "unsupported-language" }` for that file\'s extension, OR a search_symbols query came back empty for a name that you can SEE in the file tree. The index is best-effort: Go is precise (stdlib parser); TS/JS is regex-based and may miss nested classes, decorators, or inline object methods — fall back to grep for those exact cases. If the M2 architecture notes flagged "no CALLS edges yet" or similar coverage gaps, treat trace_calls/impact results as hints, not authoritative.');
    parts.push('If the index looks stale (last_modified mismatch with current git state, or your search came back surprisingly empty), call `index_codebase({ force: true })` once and continue.');
  } else {
    parts.push('PHASE 2 — CODEBASE SCAN:');
    parts.push('Use read_file, glob, and grep to understand the existing codebase structure, patterns, conventions, config files, and dependencies.');
    parts.push('');
    parts.push('(This project does not yet have a structural code index. If you find yourself running more than 3-4 grep+read_file pairs to locate symbols, consider asking the user to run `/index` — it builds a per-project SQLite index of symbols and call edges that makes future plan-mode scans 50× cheaper. Indexing 10k LOC takes seconds.)');
  }
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
  parts.push('**Research toolbox (plan-phase work — only relevant during planning, not execution):**');
  parts.push('- **Web lookups**: For things you can\'t learn from the user\'s machine — current library versions, framework docs, API changes, error messages, "is X deprecated", recent breaking changes — `web_search` for candidate URLs, then `web_fetch` the 1-3 most authoritative (official docs > GitHub > Stack Overflow > random blog). Always include the current year for recent topics. Quote exact error strings. Cite source URLs.');
  parts.push('- **Research-and-record loop**: Before working with anything you don\'t know cold — a CLI flag, library API, error code, framework convention, config schema — `graph_query({ query: "<thing>" })` FIRST to see if a prior session learned it. If nothing useful, do NOT improvise from training data: `web_search` (with the year) + `web_fetch`, then SAVE what you learned via `graph_update({ nodeId: "<slug>", label: "...", type: "tool|library|framework|concept", aspects: [{ name: "overview", attributes: [...] }, { name: "gotchas", attributes: [...] }] })` so the next session finds it. "No node for <thing> in the graph — looking it up" beats guessing.');
  parts.push('- **3-strikes rule**: If the same class of exec command fails twice, the THIRD attempt MUST be `web_search` the error/topic before running another shell command. Most "hitting a wall" moments are a google-able stale-training-data issue (framework version, changed CLI, deprecated flag).');
  parts.push('- **Load gotchas at session start**: When the Project Context shows a project using a known framework/tool (expo, react-native, next, tailwind, docker, etc.), `graph_query({ query: "<tool name>" })` early to load the existing gotchas aspect. Skipping this means re-hitting walls earlier sessions already documented. Run multiple in parallel.');
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
  parts.push('Only after questions are answered (or if you have none), present a detailed plan with prerequisites, step-by-step changes with file paths, new files vs existing files to modify, dependencies to install, and commands to run. Structure the plan as a numbered list of discrete steps — each step is small enough to be one `task_create` row when the plan is replayed in execute mode.');
  parts.push('');
  parts.push('PHASE 6 — VERIFICATION:');
  parts.push('Every plan MUST end with a **VERIFICATION** section listing 2–5 concrete, runnable checks that confirm the change actually works. Each check is a specific command or observation with a pass criterion, e.g.:');
  parts.push('  - `bun test src/foo.test.ts` should exit 0, 3 tests passing');
  parts.push('  - `curl -s http://localhost:3000/api/health` should return `{"ok":true}`');
  parts.push('  - `read_file config.ts` — `port` should be `8081`, not `8080`');
  parts.push('  - `ls .spore-code/scratch/` — `gen-qr.js` should be present');
  parts.push('Pick checks that use existing project tooling (tests, curl, read_file) and have an unambiguous pass signal. Avoid "it should feel better" or "make sure it looks right" — those are not verifications. If the project has no test runner and no live endpoint, fall back to targeted `read_file` / `exec --version` checks that prove the expected state.');
  parts.push('');
  if (pc.hasCodeIndex) {
    parts.push('**For ANY symbol you create or modify in the plan, ALSO include a `verify_implementation` check** as part of PHASE 6. This is the goal-backward 4-level audit: exists → substantive → wired → export-level. It catches stub functions, unwired components, comment-only bodies, and `panic("not implemented")`-style placeholders that your other verification checks would miss. Example:');
    parts.push('  - `verify_implementation({ qnames: ["src/foo.ts::Bar.baz", "src/foo.ts::helper"] })` — both must report exists/substantive/wired/export_level all true. Failures pinpoint the gap (e.g. "wired but every caller is in the same file → not actually used externally yet").');
    parts.push('Use it BEFORE declaring the implementation tasks done in execute mode. If it reports `failed > 0`, the work isn\'t complete — re-open the failing tasks via `task_progress({id, status:"error"})` and fix.');
    parts.push('');
  }
  parts.push('Format the VERIFICATION section as a bulleted list under a `## Verification` heading inside the plan. The user will review it alongside the steps before accepting.');
  parts.push('');
  parts.push('RULES (these are HARD constraints, not suggestions):');
  parts.push('- Do NOT call write_file. Do NOT call edit_file. Do NOT call exec. The user has explicitly chosen plan mode to PREVIEW your approach before any changes land.');
  parts.push('- Do NOT start servers, install packages, create temp scripts, delete files, or change project state. Use read_file/glob/grep/code-index tools for read-only inspection.');
  parts.push('- You MAY use: list_dir, read_file, read_many_files, glob, grep, git_status, git_diff, bg_list/bg_tail, web_search, web_fetch, delegate_task (persona="researcher" preferred), graph_query, and exec only for read-only commands with no structured tool equivalent (`which`, `--version`, etc).');
  parts.push('- Do NOT put questions and PLAN_READY in the same response — ask first, then plan after answers.');
  parts.push('- Do NOT emit PLAN_READY without a `## Verification` section. A plan without verification is incomplete.');
  parts.push("- End your plan with \"PLAN_READY\" on its own line — that's the marker the CLI watches for to show the Execute/Revise/Cancel choice. Without it the user has no way to approve.");
  parts.push("- After the user clicks Execute, the SAME plan is replayed as a NEW turn with mode=execute — that's when you actually run write_file etc. Do not pre-emptively try to skip plan mode by writing now.]");

  return parts.join('\n');
}

// Execute mode — emitted when projectContext.mode === 'execute' on a cli
// session. Carries the task_create / task_progress checklist contract that
// used to live (incorrectly) inside the Plan Mode section. The plan-mode
// turn doesn't need it (the agent is just emitting the plan); the
// execute-mode turn very much does, and previously the prompt didn't
// carry it AT ALL once mode flipped — leaving the agent without the
// checklist rule on the very turn it was supposed to follow.
function buildExecuteModeSection(api, opts) {
  if (opts.platform !== 'cli' || !opts.projectContext || opts.projectContext.mode !== 'execute') return null;
  const parts = [];
  parts.push('## Execute Mode (Spore Code)');
  parts.push('You are executing a plan that the user already approved. Your FIRST set of tool calls MUST be `task_create` — one per plan step AND one per verification check from the plan\'s `## Verification` section. Use short `subject` strings (5–10 words) copied from each plan step\'s header.');
  parts.push('');
  parts.push('Execution order — group steps by their plan-mode `[parallel: <group-name>]` marker:');
  parts.push('  - **Steps in the same parallel group fire together** as a single tool batch — multiple `tool_use` blocks in the same response. The Anthropic API supports parallel tool calls and the harness dispatches them concurrently. Don\'t serialize what the plan said could parallelize.');
  parts.push('  - Steps with NO `[parallel: ...]` marker run one-by-one in plan order.');
  parts.push('');
  parts.push('For each step (whether serial or part of a parallel group):');
  parts.push('  1. `task_progress({id, status: "in_progress"})` BEFORE starting work. For a parallel group, fire the in_progress updates for all steps in the group together (one tool batch with the in_progress calls) BEFORE the work batch — keeps the user\'s checklist accurate.');
  parts.push('  2. Do the work (write_file / edit_file / exec / etc). For a parallel group, fire all the work tools in ONE batch — a response with N tool_use blocks where N = group size.');
  parts.push('  3. `task_progress({id, status: "done"})` IMMEDIATELY after each step completes. For a parallel group, fire the done updates together as a batch once all the work tools have returned.');
  parts.push('  4. If a step fails: `task_progress({id, status: "error", note: "<what failed>"})` and either propose a fix or ask the user. A failure in one step of a parallel group does NOT cancel the others — let the rest finish, then deal with the failure.');
  parts.push('');
  parts.push('Parallel-batch SAFETY rules:');
  parts.push('  - Do NOT include two write/edit calls targeting the SAME file in one batch — line-number drift between concurrent edits will corrupt the file.');
  parts.push('  - Do NOT batch an `exec` of a build/migration/install command with file writes — the exec needs the writes to land first.');
  parts.push('  - When in doubt, run the steps serially — a wrong parallelism call wastes time recovering, a serial run just takes a bit longer.');
  parts.push('');
  parts.push('After all implementation steps are `done`, run the verification checks in the same order (these are typically serial since each tests something specific), updating each task to `done` or `error`. You may only declare the work complete when every task in the checklist (impl + verification) is `done`.');
  parts.push('The user watches this checklist as the live progress signal — skipping updates means they can\'t tell where you are.');
  return parts.join('\n');
}

// ── Plugin registration ─────────────────────────────────────────────
module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    // v3 = rebrand migration. install.sql Phase 0 renames legacy
    // ref-acorn-* rows to ref-spore-code-* and retags extracted_with
    // 'acorn-cli' → 'spore-code'. v3 also corrects the node's label
    // (the v2 INSERT OR IGNORE inherited the legacy "Acorn Client
    // Context" label; v3 UPDATEs it to "Spore Code Client Context").
    schemaVersion: 3,
  });

  // HTTP routes — auth issues a CLI-typed Bearer token; sessions
  // returns the user's prior chat sessions. Surfaced under
  // /api/plugins/spore-code/* and aliased from /api/acorn/* via core's
  // pre-route rewrite (src/gateways/web.js).
  //
  // /auth is the auth boundary itself — it MUST be public so unauthenticated
  // Go clients can post a key and get a token. /sessions does its own
  // Bearer-token validation in-handler so it's also public from the
  // dispatcher's perspective.
  api.registerWebRoute('POST', '/auth',     { public: true, handler: (req, res) => handleAuth(api, req, res) });
  api.registerWebRoute('POST', '/session',  { public: true, handler: (req, res) => handleDeviceSession(api, req, res) });
  api.registerWebRoute('POST', '/logout',   { public: true, handler: (req, res) => handleLogout(api, req, res) });
  api.registerWebRoute('GET',  '/sessions', { public: true, handler: (req, res) => handleSessions(api, req, res) });

  // Public-URL alias: /api/spore-code/* → /api/plugins/spore-code/*.
  // Core's request handler walks plugin aliases at request time,
  // applies CORS for cross-origin clients, and rewrites the path.
  // The pre-rebrand /api/acorn/* alias was dropped — we did the rename
  // before the app had wide distribution, so there are no deployed v0.x
  // binaries to maintain compatibility with.
  api.registerPathAlias('spore-code', {
    cors: true,
    notFoundCode: 'SPORE_CODE_ROUTE_NOT_FOUND',
  });

  // The `note_discovery` tool is now owned by the session-graph plugin
  // (which acorn-cli depends on via the manifest's `depends` field).
  // The tool's behavior is identical — it reads ctx.platform /
  // ctx.channelId / ctx.projectContext.cwd to detect the session and
  // link the discovery node — so the agent contract is preserved
  // verbatim. Acorn-cli no longer registers it here.

  // ── codeindex tools (client-routed) ─────────────────────────────────
  //
  // The acorn Go CLI (v0.4.0+) ships a per-project SQLite code graph at
  // <cwd>/.spore-code/index.db built from tree-sitter-style parsing of Go,
  // TypeScript, JavaScript, and Python source. These six tools let the
  // agent query that index instead of falling back to grep+read_file —
  // a search_symbols result is ~50x cheaper in tokens than the
  // equivalent grep + read_file pair on a real codebase.
  //
  // Routing: when an acorn CLI client is connected, its executor.go
  // claims these tool names via its localTools map and runs them
  // against the local DB. The execute() stub below only fires as a
  // fallback when there's no claiming CLI — which means either an
  // older CLI is connected, or someone called the tool from a non-CLI
  // ctx (web/discord/cron). All return a clear error in that case so
  // the agent doesn't silently produce wrong results.
  const requireSporeClient = (toolName) => () => ({
    ok: false,
    error: `${toolName} runs on the user's machine via the Spore Code CLI; no Spore Code v0.4.0+ client is currently connected to this session.`,
  });

  api.registerTool('index_codebase', {
    namespaced: false,
    ...sporeClientToolMeta('index_codebase', { legacy: true }),
    description:
      'Build (or refresh) the per-project code graph at <cwd>/.spore-code/index.db. ' +
      'Walks the cwd, parses Go/TS/JS/Python source, extracts symbols + CALLS edges + imports. ' +
      'Idempotent: per-file mtime-skip on subsequent runs. Returns counts (files, symbols, calls, took_ms) and a by-language breakdown. ' +
      'Usually triggered manually by the user via /index — only call this from the agent if a search_symbols query came back surprisingly empty and you suspect the index is stale.',
    inputSchema: {
      type: 'object',
      properties: {
        roots:     { type: 'array', items: { type: 'string' }, description: 'Optional sub-dirs to constrain the walk; defaults to cwd.' },
        languages: { type: 'array', items: { type: 'string' }, description: 'Optional filter (e.g. ["go", "ts"]). Default: all 5 supported (go, ts, js, py, rs).' },
        max_files: { type: 'number', description: 'Safety cap; 0 = unlimited.' },
        force:     { type: 'boolean', description: 'Re-parse every file even if mtime unchanged. Default false.' },
      },
    },
    execute: requireSporeClient('index_codebase'),
  });

  api.registerTool('search_symbols', {
    namespaced: false,
    ...sporeClientToolMeta('search_symbols', { legacy: true }),
    description:
      'Query the project code index for symbols by name / kind / file / language. Returns name, qualified-name, kind, file, line, signature, container, exported. ' +
      'Use this INSTEAD of grep when you want to locate a function/class/method/type — ~50x cheaper in tokens than grep + read_file. ' +
      'Bare-name match is case-insensitive substring; combine with kind="function" / "method" / "class" / "struct" / "interface" / "type" / "const" / "var" / "enum" / "constructor" to narrow.',
    inputSchema: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: 'Substring against symbol.name (case-insensitive).' },
        qname:    { type: 'string', description: 'Substring against the fully-qualified name <file>::<container>.<name>.' },
        kind:     { type: 'string', description: 'Exact match (function|method|class|struct|interface|type|const|var|enum|constructor).' },
        file:     { type: 'string', description: 'LIKE pattern over the file path.' },
        language: { type: 'string', description: 'go | ts | js | py | rs.' },
        exported: { type: 'boolean', description: 'Restrict to exported symbols.' },
        limit:    { type: 'number', description: 'Default 200, hard cap.' },
      },
    },
    execute: requireSporeClient('search_symbols'),
  });

  api.registerTool('trace_calls', {
    namespaced: false,
    ...sporeClientToolMeta('trace_calls', { legacy: true }),
    description:
      'BFS over CALLS edges in the code index — answers "who calls X?" or "what does X call?". ' +
      'Returns a flat list of (caller_qname, callee_qname, line, depth) edges; reconstruct paths client-side if needed. ' +
      'Use this INSTEAD of grepping for invocations: a trace_calls result is structural and authoritative for the indexed languages, whereas grep matches strings in comments and unrelated files. ' +
      'Pass `token_budget` to receive a text-rendered subgraph (seeds pinned, degree-sorted) instead of edge JSON — useful when surveying a wide call neighborhood without overflowing context.',
    inputSchema: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'Match callee_name (works without resolved qname). Either name or qname is required.' },
        qname:        { type: 'string', description: 'Exact qualified-name match. Either name or qname is required.' },
        direction:    { type: 'string', enum: ['callers', 'callees', 'both'], description: 'Default: callers.' },
        depth:        { type: 'number', description: '1..5; default 3.' },
        limit:        { type: 'number', description: 'Total edge cap; default and max 200.' },
        token_budget: { type: 'number', description: 'Optional. When set, return is text-rendered (seeds first, degree-sorted, char-budget cutoff) instead of JSON edges. Approx tokens; CLI v0.5.0+ only.' },
      },
    },
    execute: requireSporeClient('trace_calls'),
  });

  api.registerTool('get_snippet', {
    namespaced: false,
    ...sporeClientToolMeta('get_snippet', { legacy: true }),
    description:
      'Fetch source for a symbol by qualified name (preferred) or file+line range. ' +
      'Use this INSTEAD of read_file when you only need the body of one symbol — get_snippet returns just the relevant lines from the indexed range, not the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        qname:      { type: 'string', description: 'Qualified name (preferred form).' },
        file:       { type: 'string', description: 'Repo-relative path (alternate form, with start_line+end_line).' },
        start_line: { type: 'number' },
        end_line:   { type: 'number' },
      },
    },
    execute: requireSporeClient('get_snippet'),
  });

  api.registerTool('architecture', {
    namespaced: false,
    ...sporeClientToolMeta('architecture', { legacy: true }),
    description:
      'Produce a structured codebase summary: tech stack (file/symbol counts per language), clusters by top-level directory, entry points (Go main/init, JS main/bootstrap), hot paths (top-N symbols by inbound CALLS count), and coverage notes. ' +
      'Call this ONCE early in plan mode to orient yourself — far cheaper than grepping for "main" or reading package.json + go.mod.',
    inputSchema: { type: 'object', properties: {} },
    execute: requireSporeClient('architecture'),
  });

  api.registerTool('impact', {
    namespaced: false,
    ...sporeClientToolMeta('impact', { legacy: true }),
    description:
      'Map a list of file paths (or the current `git diff --name-only HEAD` if omitted) to affected symbols, plus a transitive caller blast-radius count for each. ' +
      'Use this BEFORE producing a plan that edits files — surfaces "this 5-line change actually touches 23 callers" risk.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative; defaults to staged + unstaged paths.' },
        depth: { type: 'number', description: '1..3; default 2.' },
        limit: { type: 'number', description: 'Total symbol cap; default 100, max 200.' },
      },
    },
    execute: requireSporeClient('impact'),
  });

  api.registerTool('verify_implementation', {
    namespaced: false,
    ...sporeClientToolMeta('verify_implementation', { legacy: true }),
    description:
      'Goal-backward 4-level audit: for a list of qualified symbol names (or every symbol in a list of files), confirm exists → substantive → wired → export_level. ' +
      'Catches stub functions (panic("not implemented"), Python `pass`-only, comment-only bodies), unwired components (no callers anywhere), and "wired but only used in the same file" (not actually exported in practice). ' +
      'CALL THIS for every symbol your plan claims to create or modify, BEFORE marking the implementation step done in execute mode. A `failed > 0` result means the work is incomplete — open a task_progress error on the failing step and fix. ' +
      'Use either `qnames` (explicit list of fully-qualified names) or `paths` (verify every indexed symbol declared in those files), or both — results merge.',
    inputSchema: {
      type: 'object',
      properties: {
        qnames: { type: 'array', items: { type: 'string' }, description: 'Qualified names like `internal/foo/bar.go::Baz` or `src/foo.ts::Cls.method`.' },
        paths:  { type: 'array', items: { type: 'string' }, description: 'Repo-relative file paths; verifies every indexed symbol declared there.' },
      },
    },
    execute: requireSporeClient('verify_implementation'),
  });

  // ── Graphify-style code-graph analytics (client-routed, v0.5.0+) ────
  //
  // Stubs registered here for agent discovery and contract definition;
  // actual implementation runs on the user's machine via the Spore Code
  // Go binary against `<cwd>/.spore-code/index.db`. When no v0.5.0+ CLI
  // is connected, the requireSporeClient wrapper returns a clean error.
  //
  // These complement the existing index_codebase / search_symbols /
  // trace_calls / architecture / impact / verify_implementation surface:
  //   • code_overview — top god symbols, surprising cross-cluster CALLS
  //     edges, suggested orientation questions. Layered on `architecture`
  //     (which already provides hot-paths/clusters); adds
  //     surprise-scoring and Louvain communities over the imports+CALLS
  //     subgraph.
  //   • trace_path    — bidirectional BFS over CALLS edges, "from X to Y
  //     in the code." Code-graph analogue of graph_query mode:'path'.
  //   • code_diff     — structural diff (added/removed symbols, signature
  //     changes, new/removed CALLS edges) between two git refs. Code-
  //     graph analogue of graph_diff.
  //   • trace_calls token_budget — extends the existing schema with a
  //     `token_budget` parameter. When set, the CLI returns a text-
  //     rendered subgraph (seeds pinned, degree-sorted, char-budgeted)
  //     instead of edge JSON. Code-graph analogue of graph_query
  //     mode:'walk'.
  api.registerTool('code_overview', {
    namespaced: false,
    ...sporeClientToolMeta('code_overview'),
    description:
      'Compute and return a structured codebase overview: top god symbols (most-called), surprising cross-cluster CALLS edges, Louvain communities over imports+CALLS, and suggested orientation questions. Use this once early in plan mode to orient yourself in an unfamiliar codebase — far cheaper than reading entry points + grepping for "main". Output overlaps with `architecture` but adds bridge-edge detection and structural questions; the CLI caches it alongside the index, so subsequent calls are near-instant unless `force` is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        top_n:  { type: 'number', description: 'Top-N god symbols to return. Default 8, max 20.' },
        force:  { type: 'boolean', description: 'Recompute even if a cached overview exists for this index_head.' },
      },
    },
    execute: requireSporeClient('code_overview'),
  });

  api.registerTool('trace_path', {
    namespaced: false,
    ...sporeClientToolMeta('trace_path'),
    description:
      'Bidirectional BFS over CALLS edges in the code index — "how does function X reach function Y?" Returns the shortest call path with file/line per hop. Use this INSTEAD of grepping for invocation chains: trace_path is structural and authoritative for the indexed languages, whereas grep matches strings in comments and unrelated files. Common use: "how does request handling reach the database?" or "what path connects auth to the user model?"',
    inputSchema: {
      type: 'object',
      properties: {
        from_qname: { type: 'string', description: 'Qualified name of the source symbol (e.g. `internal/api/handlers.go::ServeHTTP`).' },
        to_qname:   { type: 'string', description: 'Qualified name of the target symbol.' },
        max_hops:   { type: 'number', description: 'Maximum CALLS hops to consider. Default 8, max 20.' },
      },
      required: ['from_qname', 'to_qname'],
    },
    execute: requireSporeClient('trace_path'),
  });

  api.registerTool('code_diff', {
    namespaced: false,
    ...sporeClientToolMeta('code_diff'),
    description:
      'Structural diff between two git refs: added/removed symbols, signature changes, new/removed CALLS edges, list of changed files. Use this INSTEAD of `git diff --stat` + reading the patch when you need a structural ("what symbols changed and how does that ripple") rather than textual ("what lines changed") view of a change set. Defaults to comparing HEAD~1 vs HEAD.',
    inputSchema: {
      type: 'object',
      properties: {
        from_ref: { type: 'string', description: 'Git ref for the older snapshot. Default: `HEAD~1`.' },
        to_ref:   { type: 'string', description: 'Git ref for the newer snapshot. Default: `HEAD`.' },
        limit:    { type: 'number', description: 'Cap on returned items per category. Default 50, max 200.' },
      },
    },
    execute: requireSporeClient('code_diff'),
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
  api.registerPromptSection('*', 'Execute Mode',    ({ opts }) => buildExecuteModeSection(api, opts));

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
    const slug = result.graph || ctx?.memoryEnvelope?.writeScopes?.projectSlug || SESSION_GRAPH_SLUGS.get(String(ctx.channelId));
    const db = slug && learner?.getGraphDb ? learner.getGraphDb(slug) : learner?.db;
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
  // For acorn turns (sessionIdOpt non-null), this hook does TWO things:
  //   1. Tag every newly-created non-identity node as session-temp:
  //      sets extra = { ttl: 'temp', sessionId, tempCreated } so
  //      session-end distillation can pick winners. Identity nodes
  //      (people, agent self-node, the operator's user node) are
  //      excluded — they're global identity and must NOT be sacrificed
  //      to distillation.
  //   2. Add a `discovered_in` edge from each new node to the
  //      session-<id> node so a later graph_query "what did session X
  //      teach us" returns them.
  // Skip if the session was already distilled (race: extraction queued
  // mid-session but executed post session-end). Tagging with the stale
  // sessionId would create an orphan that sits temp until the 48h
  // janitor — better to leave it permanent.
  api.registerWorkerHook('afterLearn', ({ sessionIdOpt, newNodeIds, writeTargets }) => {
    if (!sessionIdOpt || !Array.isArray(newNodeIds) || newNodeIds.length === 0) return;
    const ctx = api._appContext;
    const learner = ctx?.learner;
    const slug = SESSION_GRAPH_SLUGS.get(String(sessionIdOpt))
      || (Array.isArray(writeTargets) ? writeTargets.find(t => t?.slug)?.slug : null);
    const db = slug && learner?.getGraphDb ? learner.getGraphDb(slug) : learner?.db;
    if (!db) return;
    const sessId = 'session-' + String(sessionIdOpt);
    const sessRow = db.prepare(
      "SELECT json_extract(extra, '$.distilled_at') AS distilled FROM nodes WHERE id = ?"
    ).get(sessId);
    if (!sessRow) return; // session node missing — skip both tag + edges
    const sessionAlreadyDistilled = !!sessRow.distilled;

    // Resolve identity-node ids so the temp-tag step skips them.
    const config = ctx?.config || {};
    const agentSelfId = config.agentId || 'spore';

    const getNode = db.prepare('SELECT type, extra FROM nodes WHERE id = ?');
    if (sessionAlreadyDistilled) {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      let recycled = 0;
      for (const nid of newNodeIds) {
        if (nid === sessId || nid === agentSelfId) continue;
        const row = getNode.get(nid);
        if (!row || row.type === 'person' || row.type === 'self' || row.type === 'agent' || row.type === 'project') continue;
        try {
          const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
          const aspects = db.prepare('SELECT * FROM aspects WHERE node_id = ?').all(nid);
          const attrs = db.prepare(`
            SELECT a.* FROM attributes a
            JOIN aspects asp ON asp.id = a.aspect_id
            WHERE asp.node_id = ?
          `).all(nid);
          const edges = db.prepare('SELECT * FROM edges WHERE source = ? OR target = ?').all(nid, nid);
          db.prepare(`
            INSERT INTO recycle_bin (item_type, item_id, label, payload, deleted_by, reason, confidence, expires_at)
            VALUES ('node', ?, ?, ?, 'graphcorn-late-learner', ?, 1.0, ?)
          `).run(nid, node?.label || nid, JSON.stringify({ node, aspects, attributes: attrs, edges }), `learner output arrived after session ${sessionIdOpt} was distilled`, expiresAt);
          db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(nid, nid);
          db.prepare('DELETE FROM nodes WHERE id = ?').run(nid);
          recycled++;
        } catch (e) {
          api.getLogger().warn(`[graphcorn] late learner recycle failed for ${nid}: ${e.message}`);
        }
      }
      if (recycled) api.getLogger().info(`[graphcorn] recycled ${recycled} late learner node(s) after distill → ${sessId}`);
      return;
    }
    const updExtra = db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?');
    const checkE = db.prepare('SELECT 1 FROM edges WHERE source = ? AND target = ? AND type = ?');
    const insE = db.prepare(
      "INSERT INTO edges (source, target, type, weight, extracted_with) VALUES (?, ?, 'discovered_in', 1, 'graphcorn-learner')"
    );

    let tagged = 0;
    let edgesAdded = 0;
    for (const nid of newNodeIds) {
      if (nid === sessId) continue;
      const row = getNode.get(nid);
      if (!row) continue;
      const isIdentity = row.type === 'person' || nid === agentSelfId;
      // Step 1: temp-tag if applicable.
      if (!sessionAlreadyDistilled && !isIdentity) {
        let extra = {};
        try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch { extra = {}; }
        if (!extra.sessionId) {
          extra.ttl = 'temp';
          extra.sessionId = sessionIdOpt;
          if (!extra.tempCreated) extra.tempCreated = new Date().toISOString();
          updExtra.run(JSON.stringify(extra), nid);
          tagged++;
        }
      }
      // Step 2: discovered_in edge.
      if (!checkE.get(nid, sessId, 'discovered_in')) {
        insE.run(nid, sessId);
        edgesAdded++;
      }
    }
    if (tagged > 0 || edgesAdded > 0) {
      api.getLogger().debug(`afterLearn: tagged ${tagged} session-temp + ${edgesAdded} discovered_in edges → ${sessId}`);
    }
  });

  // isNodeManaged lifecycle hook — claims ownership of nodes the
  // plugin's session/distillation lifecycle manages. Core checks this
  // before allowing manual ttl mutations (e.g. graph_update temp:false
  // that would prematurely promote a session-tagged temp node mid-
  // session). Returns true for: any node with extra.sessionId set,
  // session-anchor nodes, project-anchor nodes.
  api.registerLifecycleHook('isNodeManaged', ({ nodeId, extra }) => {
    if (extra?.sessionId) return true;
    const id = String(nodeId || '');
    if (id.startsWith('session-')) return true;
    if (id.startsWith('project-')) return true;
    return false;
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
    const learner = scopedLearnerForTurn(api, opts);
    const scopedApi = learner && learner !== api._appContext?.learner
      ? Object.assign(Object.create(api), { _appContext: { ...api._appContext, learner } })
      : api;
    checkpointsLib.captureFailureFix(scopedApi, opts, toolLog || []);
    checkpointsLib.recordRoundCheckpoint(scopedApi, opts, toolLog || [], finalText);
    noteProjectActivity(scopedApi, opts, finalText, toolLog || []);
    maybePruneStaleScripts(scopedApi, opts);
  });

  // No plugin settings pane — the SPORE invite key (used by both this
  // plugin's /auth handler AND the webapp self-register endpoint) is
  // a host-level setting in core's config.inviteKey. The settings UI
  // surfaces it under Advanced → Invite Key, not in the Plugins tab.
  // No webappSelfRegisterCheck hook either — core's self-register
  // reads config.inviteKey directly.

  // shouldSkipRecall lifecycle hook — short-circuits the expensive
  // per-turn recall pipeline for cli-platform coding turns. Returns
  // true to skip; any other return is treated as "don't skip". Core's
  // graph/context.js consults this before kicking off Enhanced Recall.
  api.registerLifecycleHook('shouldSkipRecall', ({ opts, queryType }) => {
    if (opts?.platform !== 'cli') return false;
    if (heuristicsLib.looksLikeCapabilityQuestion(opts?.messageContent)) return true;
    return queryType !== 'aggregation'
      && heuristicsLib.looksLikeCodingTurn(opts?.messageContent);
  });

  api.registerLifecycleHook('resolveMemoryScope', ({ opts, envelope }) => {
    if (opts?.platform !== 'cli' || !opts?.projectContext?.cwd) return null;
    return {
      mode: 'codebase-session',
      source: 'spore-code',
      projectIdentityKey: envelope?.projectKey || null,
    };
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
    const learner = scopedLearnerForTurn(api, opts);
    if (!opts?.projectContext || !learner) return null;
    try {
      const projects = projectsLib;
      const pc = {
        ...opts.projectContext,
        projectIdentityKey: opts.memoryEnvelope?.projectKey || opts.memoryEnvelope?.projectIdentityKey || null,
      };
      const r = projects.upsertProject(learner, opts.userId || 'anon', pc);
      if (!r) return null;
      const sessionNodeId = opts.channelId ? `session-${String(opts.channelId)}` : null;
      let priorSessionCount = 0;
      let priorActivityCount = 0;
      try {
        if (sessionNodeId) {
          priorSessionCount = learner.db.prepare(`
            SELECT COUNT(*) AS c
              FROM edges e
              JOIN nodes n ON n.id = e.target
             WHERE e.source = ?
               AND e.type = 'has_session'
               AND e.target != ?
               AND n.type LIKE 'session%'
          `).get(r.id, sessionNodeId)?.c || 0;
        }
        priorActivityCount = learner.db.prepare(`
          SELECT COUNT(*) AS c
            FROM aspects asp
            JOIN attributes a ON a.aspect_id = asp.id
           WHERE asp.node_id = ?
             AND asp.name = 'recent_activity'
        `).get(r.id)?.c || 0;
      } catch {
        priorSessionCount = 0;
        priorActivityCount = 0;
      }
      return {
        cachedProjectNodeId: r.id,
        cachedProjectStale:  !!r.gitHashChanged,
        cachedProjectIsNew:  !!r.isNew,
        cachedProjectHasPriorSessions: priorSessionCount > 0,
        cachedProjectHasPriorActivity: priorActivityCount > 0,
        cachedProjectHasPriorMemory: priorSessionCount > 0 || priorActivityCount > 0,
        projectGraphSlug: opts.memoryEnvelope?.writeScopes?.projectSlug || null,
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
  api.registerWsHandler('session:start',                  (ws, msg) => sessionStartHandler(api, ws, msg));
  api.registerWsHandler('session:end',                    (ws, msg) => sessionEndHandler(api, ws, msg));
  api.registerWsHandler('code_graph:summary',             (ws, msg) => codeGraphSummaryHandler(api, ws, msg));
  api.registerWsHandler('save_project_script:from_file',  (ws, msg) => saveProjectScriptFromFileHandler(api, ws, msg));
  api.registerWsHandler('record_script_outcome:from_exec',(ws, msg) => recordScriptOutcomeFromExecHandler(api, ws, msg));

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
      const sessions = sessionsLib;
      const llmClient = ctx?.tools?.llmClient;
      for (const sid of sessionIds) {
        try {
          const slug = SESSION_GRAPH_SLUGS.get(String(sid));
          const scopedDb = slug && learner.getGraphDb ? learner.getGraphDb(slug) : null;
          const scopedLearner = scopedDb ? withLearnerDb(learner, scopedDb, slug) : learner;
          graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.finalizeSessionNode(scopedLearner, sid, { endedAt: new Date().toISOString() }));
          if (llmClient) {
            waitForLearnerDrain(learner)
              .then(() => graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.summarizeSessionNode(scopedLearner, llmClient, config, sid, log)))
              .then(() => graphEvents.withGraph(slug ? { graph: slug } : null, () => sessions.distillSession(scopedLearner, llmClient, config, sid, log)))
              .catch(e => log.warn(`[graphcorn] ws-close distill error: ${e.message}`))
              .finally(() => clearSessionRuntimeState(sid));
          } else {
            clearSessionRuntimeState(sid);
          }
        } catch (e) {
          log.warn(`[graphcorn] ws-close finalize failed: ${e.message}`);
        }
      }
    } catch (e) {
      api.getLogger().warn(`[graphcorn] wsClose hook failed: ${e.message}`);
    }
  });

  api.getLogger().info('Plugin ready (depends on session-graph) — ref nodes + /auth + /sessions + /api/spore-code alias + WS session:* + afterTurn + afterLearn + beforeMessage + shouldSkipRecall + isNodeManaged + afterToolExec(graph_update) + prompt sections registered.');
};

module.exports._test = {
  handleAuth,
  handleDeviceSession,
  handleLogout,
  inviteKeyMatches,
  validateDeviceToken,
  revokeDeviceToken,
  verifyWebappPassword,
  wantsPasswordAuth,
  authenticateAccountPassword,
};
