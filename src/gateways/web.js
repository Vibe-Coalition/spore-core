/**
 * web.js — Web Control Panel Gateway
 *
 * HTTP server, WebSocket control panel, REST API routes,
 * terminal/SSH handlers, and voice pipeline for the web UI.
 *
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const graphEvents = require('../graph/events');
const { WebSettingsService } = require('./web/settings-service');
const { createWebAuthPolicy } = require('./web/auth-policy');
const { matchProxyRoute, createApiProxyHandler } = require('./web/api-proxy');
const { createLoginRateLimiter } = require('./web/login-rate-limit');

function _redactSecrets(value) {
  let s = String(value ?? '');
  if (!s) return s;
  s = s.replace(/(sk-|sk-proj-)[A-Za-z0-9_-]{12,}/g, '$1[redacted]');
  s = s.replace(/\bspc_[A-Za-z0-9_-]{16,}\b/g, 'spc_[redacted]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9_.-]{16,}/gi, 'Bearer [redacted]');
  s = s.replace(/(password|pass|token|secret|api[_-]?key|authorization|inviteKey|invite_key)\s*[:=]\s*["']?[^"',\s}]{6,}/gi, '$1=[redacted]');
  return s;
}

function _cliForwardedToolTimeoutMs(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const requested = Number(toolInput?.timeout);
  if (name === 'exec' || name === 'run_tests') {
    if (toolInput?.background === true) return 180000;
    const requestedMs = Number.isFinite(requested) && requested > 0 ? requested : 600000;
    return Math.min(45 * 60 * 1000, Math.max(180000, requestedMs + 60000));
  }
  return 180000;
}

function _formatDurationMs(ms) {
  const secs = Math.max(1, Math.round(Number(ms || 0) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function _isSporeCodeSessionId(sessionId, userId = '') {
  const sid = String(sessionId || '');
  if (!sid || sid.startsWith('web:')) return false;
  if (sid.startsWith('cli:')) return true;
  // Older Spore Code builds used bare "user@project-..." ids before the
  // explicit cli: prefix. Keep that path, but never classify web:* as CLI.
  const user = String(userId || '').trim();
  return !!user && sid.startsWith(`${user}@`);
}

function _isCliChatSession(ws, sessionId) {
  return ws?._role === 'cli' && _isSporeCodeSessionId(sessionId, ws?._user || '');
}

function _clearCliPendingToolTimers(entry) {
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.ackTimeout) clearTimeout(entry.ackTimeout);
  if (entry.executionStartDelay) clearTimeout(entry.executionStartDelay);
  entry.timeout = null;
  entry.ackTimeout = null;
  entry.executionStartDelay = null;
}

function _startCliPendingToolTimer(ws, toolId, entry, reason = 'execution') {
  if (!ws || !toolId || !entry || entry.timeout) return false;
  const timeoutMs = Number(entry.timeoutMs) > 0 ? Number(entry.timeoutMs) : 180000;
  entry.startedAt = Date.now();
  entry.timeoutStartedReason = reason;
  entry.timeout = setTimeout(() => {
    ws._pendingTools?.delete(toolId);
    entry.reject?.(new Error(`Tool ${entry.name || toolId} timed out (${_formatDurationMs(timeoutMs)})`));
  }, timeoutMs);
  return true;
}

function _findCliPendingTool(ws, toolId, toolName = '') {
  if (!ws?._pendingTools) return { id: null, entry: null };
  if (toolId && ws._pendingTools.has(toolId)) return { id: toolId, entry: ws._pendingTools.get(toolId) };
  const wanted = String(toolName || '').trim();
  let fallback = null;
  for (const [id, entry] of ws._pendingTools) {
    if (!fallback) fallback = { id, entry };
    if (wanted && String(entry?.name || '') === wanted) return { id, entry };
  }
  return fallback || { id: null, entry: null };
}

function _isChatSubmitType(type) {
  return type === 'chat' || type === 'chat:message';
}

/** Pick the newer of two file paths (by mtime). Skips null/missing paths. */
function _newerFile(a, b) {
  const aOk = a && fs.existsSync(a);
  const bOk = b && fs.existsSync(b);
  if (aOk && bOk) {
    return fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b;
  }
  return aOk ? a : b;
}

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Compact theme table — kept in sync with THEMES in graph-viewer.html. Only the
// subset of vars needed by the login overlay is inlined; the viewer's JS applies
// the full set once `applyGraphTheme` runs post-auth.
// Two themes only — `dark` (Petri warm-earth baseline; vars are empty so the
// graph-viewer.html :root defaults take effect) and `light` (Petri warm-paper
// palette). The compact var set here is the subset used by the pre-auth
// login overlay; full-fat vars + node colors live in graph-viewer.html's
// THEMES object and apply post-auth via applyGraphTheme().
const _THEME_VARS = {
  dark: {},
  light: {
    '--bg': '#f3efe6', '--surface': '#fbf8f0', '--panel': '#ede7d8',
    '--border': '#e6e0d2',
    '--text': '#3c3a35', '--text-dim': '#9a948a', '--text-bright': '#1f1d1a',
    '--accent': '#c2542d', '--accent2': '#3e6b47', '--danger': '#b8341c',
  },
};

// Theme names: only 'light' and 'dark'. Anything else (including
// stored values from earlier multi-theme builds) falls back to 'dark'.
function _normalizeThemeName(name) {
  return name === 'light' ? 'light' : 'dark';
}

function _readServerTheme(dataDir) {
  // The login overlay reflects the OPERATOR's theme — never a webapp user's
  // pick — so guests don't impose their pastel obsession on everyone.
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
    let creatorUsernames = [];
    try {
      const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'webapp-users.json'), 'utf8'));
      creatorUsernames = users.filter(u => u?.role === 'creator').map(u => u.username);
    } catch { /* silent: malformed JSON → fallback */ }
    for (const u of creatorUsernames) {
      if (prefs[u]?.theme) return _normalizeThemeName(prefs[u].theme);
    }
    // No creator theme yet (fresh install pre-onboarding) → fall back to the
    // legacy _lastUsed marker so the operator's wizard pick still lands.
    if (prefs._lastUsed?.theme) return _normalizeThemeName(prefs._lastUsed.theme);
  } catch { /* silent: malformed JSON → fallback */ }
  return 'dark';
}

function _buildThemeInlineStyle(dataDir) {
  const name = _readServerTheme(dataDir);
  const vars = _THEME_VARS[name] || {};
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}

// Constant-time invite-key compare. Used by both self-register and
// the spore-code /auth handler (the plugin reads config.inviteKey from
// the host and calls this).
function _inviteKeyMatches(typed, stored) {
  if (!typed || !stored) return false;
  const a = Buffer.from(String(typed));
  const b = Buffer.from(String(stored));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function _isOnboardingNeeded(dataDir, config) {
  const prefsPath = path.join(dataDir, 'preferences.json');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }
  if (prefs.onboardingCompleted === true) return false;
  if (prefs.onboardingCompleted === false) return true;
  // No prefs file yet → wizard has never finished. Default to "needed"
  // and let /api/onboarding/complete be the SOLE path that flips the
  // bit to true.
  //
  // We removed the legacy auto-backfill heuristic that used to inspect
  // (any user account + any provider key + any model selection) and
  // declare onboarding "done" after a 5-minute grace period. That
  // heuristic locked operators OUT of their own wizard if they
  // paused mid-flow, because the wizard's per-step writes (webapp
  // user at step 4, provider keys at step 5) made the heuristic match
  // by minute 6. Now the wizard owns the entire lifecycle: nothing
  // outside `/api/onboarding/complete` is allowed to mark it done.
  return true;
}

function _writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function _lookupWebappUserRole(dataDir, username, fallback = 'webapp') {
  const user = String(username || '').trim();
  if (!user) return fallback;
  try {
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'webapp-users.json'), 'utf8'));
    const found = Array.isArray(users) ? users.find(u => u?.username === user) : null;
    const role = String(found?.role || '').toLowerCase();
    if (role === 'creator' || role === 'admin') return role;
    if (role === 'webapp') return 'webapp';
  } catch { /* silent: absent/malformed users file -> fallback */ }
  return fallback;
}

function _graphAuthIsCreator(authContext) {
  const role = String(authContext?.role || authContext?.type || '').toLowerCase();
  return authContext?.creator === true || role === 'creator' || role === 'admin';
}

function _safeGraphUserPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function _graphAccessValues(value, out = []) {
  if (value === undefined || value === null || value === false) return out;
  if (Array.isArray(value)) {
    for (const item of value) _graphAccessValues(item, out);
    return out;
  }
  if (value instanceof Set) {
    for (const item of value) _graphAccessValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['username', 'user', 'userId', 'id', 'name', 'slug', 'key', 'identityKey', 'projectKey']) {
      if (value[key] !== undefined) _graphAccessValues(value[key], out);
    }
    for (const [key, val] of Object.entries(value)) {
      if (val === true || val === 'read' || val === 'write' || val === 'admin') out.push(key);
      else if (Array.isArray(val) || (val && typeof val === 'object')) _graphAccessValues(val, out);
    }
    return out;
  }
  const s = String(value).trim();
  if (!s) return out;
  out.push(s);
  if (s.includes(',')) {
    for (const part of s.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function _graphAccessMatches(values, candidates) {
  const wanted = new Set((candidates || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return false;
  for (const value of values || []) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) continue;
    if (wanted.has(normalized) || normalized === '*' || normalized === 'all') return true;
  }
  return false;
}

function _projectUserFromIdentityKey(identityKey) {
  const s = String(identityKey || '');
  if (!s.startsWith('cwd:')) return null;
  const parts = s.slice(4).split(':');
  if (parts.length < 3) return null;
  const looksLikeNewWindowsKey = /^[a-z]$/i.test(parts[1]) && /^[\\/]/.test(parts[2] || '');
  return looksLikeNewWindowsKey ? null : parts[0];
}

function _webUserFromIdentityKey(identityKey) {
  const match = String(identityKey || '').match(/^web-user:(.+)$/i);
  return match ? match[1] : null;
}

function _graphProjectCandidates(graph) {
  return [
    graph?.slug,
    graph?.identityKey,
    graph?.projectKey,
    graph?.projectSlug,
    graph?.owner,
    graph?.createdFor,
    graph?.webappUser,
    graph?.username,
    graph?.userId,
    graph?.name,
    graph?.projectName,
    graph?.projectRoot,
    graph?.root,
    graph?.remote,
    graph?.projectRemote,
  ].filter(v => v !== undefined && v !== null && String(v).trim());
}

function _userRecordAllowsGraph(userRecord, graph) {
  if (!userRecord || !graph) return false;
  const candidates = _graphProjectCandidates(graph);
  for (const key of ['allowedGraphs', 'graphAccess', 'graphs', 'projectGraphs', 'projectSlugs', 'projectKeys', 'projects', 'collaborations']) {
    const value = userRecord[key];
    if (!value) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const candidate of candidates) {
        const grant = value[candidate];
        if (grant === true || grant === 'read' || grant === 'write' || grant === 'admin') return true;
        if (grant && typeof grant === 'object' && grant.enabled !== false && grant.access !== 'none') return true;
      }
    }
    if (_graphAccessMatches(_graphAccessValues(value), candidates)) return true;
  }
  return false;
}

function _graphMetadataAllowsUser(graph, username) {
  if (!graph || !username) return false;
  const userCandidates = [username, _safeGraphUserPart(username)].filter(Boolean);
  const values = [];
  for (const key of [
    'owner', 'createdFor', 'webappUser', 'username', 'userId',
    'allowedUsers', 'allowedWebUsers', 'collaborators', 'members', 'users', 'viewers',
  ]) {
    _graphAccessValues(graph[key], values);
  }
  const identityUser = _projectUserFromIdentityKey(graph.identityKey);
  if (identityUser) values.push(identityUser);
  const webIdentityUser = _webUserFromIdentityKey(graph.identityKey);
  if (webIdentityUser) values.push(webIdentityUser);
  return _graphAccessMatches(values, userCandidates);
}

function _isDefaultOrGeneralGraph(graph, registry) {
  if (!graph) return false;
  const mainSlug = registry?.getMainSlug?.();
  const generalSlug = registry?.getGeneralKnowledgeSlug?.();
  return graph.role === 'main'
    || graph.role === 'general_kb'
    || graph.slug === 'default'
    || (mainSlug && graph.slug === mainSlug)
    || graph.slug === 'spore-knowledge-base'
    || (generalSlug && graph.slug === generalSlug);
}

function _canGraphAuthViewGraph(graph, authContext, registry) {
  if (!graph) return false;
  if (_graphAuthIsCreator(authContext)) return true;
  if (_isDefaultOrGeneralGraph(graph, registry)) return true;
  if (graph.role !== 'project' && graph.role !== 'user') return false;
  const username = authContext?.username || authContext?.user || authContext?.userRecord?.username || null;
  return _userRecordAllowsGraph(authContext?.userRecord, graph) || _graphMetadataAllowsUser(graph, username);
}

function _graphAuthUsername(authContext) {
  return authContext?.username || authContext?.user || authContext?.userRecord?.username || null;
}

function _scopedUserGraphSlugForAuth(authContext, registry) {
  if (!registry || _graphAuthIsCreator(authContext)) return null;
  const role = String(authContext?.role || authContext?.type || '').toLowerCase();
  if (role !== 'webapp') return null;
  const username = _graphAuthUsername(authContext);
  if (!username) return null;
  const recordSlug = authContext?.userRecord?.userGraphSlug;
  if (recordSlug && registry.get?.(recordSlug) && _canGraphAuthViewGraph(registry.get(recordSlug), authContext, registry)) {
    return recordSlug;
  }
  try {
    if (typeof registry.ensureUserGraph === 'function') {
      return registry.ensureUserGraph(`web-user:${_safeGraphUserPart(username)}`, {
        name: `${username} Memory`,
        description: `Private web memory for ${username}`,
        source: 'webapp',
        createdBy: 'webapp',
        username,
        userId: username,
        webappUser: username,
        owner: username,
      });
    }
  } catch { /* fall through to metadata search */ }
  const graphs = typeof registry.list === 'function' ? registry.list() : Object.values(registry._registry || {});
  const found = graphs.find(g => g?.role === 'user' && _graphMetadataAllowsUser(g, username));
  return found?.slug || null;
}

function _shapeGraphForAuth(graph, authContext, registry, opts = {}) {
  const shaped = { ...(graph || {}) };
  const scopedGraphSlug = opts.scopedGraphSlug || _scopedUserGraphSlugForAuth(authContext, registry);
  const scopedActive = !!(scopedGraphSlug && shaped.slug === scopedGraphSlug);
  shaped.globalActive = shaped.active === true;
  if (scopedActive) {
    shaped.scopedActive = true;
    shaped.active = true;
    shaped.access = shaped.access || 'scoped';
  } else if (!_graphAuthIsCreator(authContext) && scopedGraphSlug && shaped.globalActive) {
    shaped.active = false;
  }
  if (!_graphAuthIsCreator(authContext)) {
    delete shaped.dbPath;
    shaped.readOnly = true;
    shaped.canManage = false;
    shaped.canActivate = false;
    shaped.inspectOnly = true;
    shaped.access = _canGraphAuthViewGraph(graph, authContext, registry) ? 'read' : 'none';
    if (scopedActive) {
      shaped.access = 'scoped';
      shaped.currentScope = true;
      shaped.readOnly = false;
      shaped.canEditNodes = true;
    }
  }
  return shaped;
}

const GRAPH_INTERNAL_NODE_IDS = ['spore-activity-log', 'spore-token-log'];
const GRAPH_OVERVIEW_NODE_LIMIT = 650;
const GRAPH_OVERVIEW_EDGE_LIMIT = 1200;
const GRAPH_SLICE_NODE_LIMIT = 450;
const GRAPH_SLICE_EDGE_LIMIT = 1200;
const GRAPH_WEBGL_NODE_LIMIT = 250000;
const GRAPH_WEBGL_EDGE_LIMIT = 1000000;
const GRAPH_AUTO_WEBGL_NODE_THRESHOLD = 500;
const GRAPH_SHARED_LAYOUT_VERSION = 'spore-centered-petri-v1';

function _graphIntParam(params, name, fallback, min, max) {
  const rawValue = params?.get?.(name);
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function _graphWantsFullDetails(params) {
  const raw = String(
    params?.get?.('details') ??
    params?.get?.('includeDetails') ??
    params?.get?.('content') ??
    ''
  ).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'full' || raw === 'details';
}

function _graphJsonExtra(value) {
  if (!value || value === '{}') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function _graphLayoutHash32(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _graphLayoutHashUnit(value, salt = 0) {
  return (_graphLayoutHash32(`${value}:${salt}`) >>> 0) / 4294967295;
}

function _graphLayoutGap(nodeCount) {
  if (nodeCount > 80000) return 6.5;
  if (nodeCount > 25000) return 7.5;
  if (nodeCount > 8000) return 9;
  if (nodeCount > 2000) return 13;
  if (nodeCount > 600) return 20;
  if (nodeCount > 150) return 30;
  return 58;
}

function _graphIsSporeCenterEntry(entry) {
  const id = String(entry?.id || '').toLowerCase();
  const type = String(entry?.type || '').toLowerCase();
  return type === 'self' || id === 'self' || id === 'spore' || id === 'spore-core' || id.includes('spore-self');
}

function _graphComputeSharedLayout(rows = []) {
  const entries = (rows || [])
    .filter(row => row?.id)
    .map(row => ({
      id: String(row.id),
      type: String(row.type || 'unknown'),
      cluster: row.cluster == null ? '' : String(row.cluster),
      hash: _graphLayoutHash32(row.id),
    }));
  const total = entries.length;
  const positions = new Map();
  if (!total) {
    return { positions, gap: 0, columns: 0, rows: 0 };
  }

  const centerIndex = entries.findIndex(_graphIsSporeCenterEntry);
  const center = centerIndex >= 0 ? entries.splice(centerIndex, 1)[0] : entries.shift();
  positions.set(center.id, { x: 0, y: 0 });

  entries.sort((a, b) => {
    if (a.hash !== b.hash) return a.hash - b.hash;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const typeCounts = new Map();
  for (const entry of entries) typeCounts.set(entry.type, (typeCounts.get(entry.type) || 0) + 1);
  const typeList = Array.from(typeCounts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([type]) => type);
  const typeIndex = new Map(typeList.map((type, index) => [type, index]));
  const gap = _graphLayoutGap(total);
  const centerClear = total > 2000 ? gap * 5.5 : (total > 150 ? gap * 4.2 : gap * 2.15);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let maxRadius = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const rank = index + 1;
    const typeSlot = typeIndex.get(entry.type) || 0;
    const typeBias = typeList.length > 1 ? (typeSlot / typeList.length) * Math.PI * 2 : 0;
    const clusterBias = entry.cluster ? (_graphLayoutHashUnit(entry.cluster, 2) - 0.5) * 0.62 : 0;
    const angle = (rank * goldenAngle * 0.68) + (typeBias * 0.32) + clusterBias + (_graphLayoutHashUnit(entry.id, 3) - 0.5) * 0.18;
    const radiusScale = 0.9 + _graphLayoutHashUnit(entry.type, 4) * 0.16;
    const radius = centerClear + Math.sqrt(rank - 0.35) * gap * radiusScale;
    const jitter = Math.min(gap * 0.16, 5.5);
    const jx = (_graphLayoutHashUnit(entry.id, 5) - 0.5) * jitter;
    const jy = (_graphLayoutHashUnit(entry.id, 6) - 0.5) * jitter;
    if (radius > maxRadius) maxRadius = radius;
    positions.set(entry.id, {
      x: Math.round((Math.cos(angle) * radius + jx) * 100) / 100,
      y: Math.round((Math.sin(angle) * radius + jy) * 100) / 100,
    });
  }

  return { positions, gap, columns: 0, rows: Math.max(1, Math.ceil(maxRadius / Math.max(1, gap))) };
}

function _graphApplySharedLayout(nodes, layout) {
  const positions = layout?.positions || layout;
  if (!positions?.size) return nodes || [];
  for (const node of nodes || []) {
    const point = positions.get(String(node?.id || ''));
    if (!point) continue;
    node.x = point.x;
    node.y = point.y;
  }
  return nodes || [];
}

function _graphVisibleLayoutRows(db) {
  try {
    return db.prepare(
      `SELECT
         n.id,
         COALESCE(n.type, 'unknown') AS type,
         gm.group_id AS cluster
       FROM nodes n
       LEFT JOIN (
         SELECT m.node_id, MIN(m.group_id) AS group_id
         FROM node_group_members m
         JOIN node_groups g ON g.id = m.group_id
         WHERE g.superseded_at IS NULL
         GROUP BY m.node_id
       ) gm ON gm.node_id = n.id
       WHERE ${_graphVisibleNodeWhere('n')}
       ORDER BY n.id ASC`
    ).all(...GRAPH_INTERNAL_NODE_IDS);
  } catch {
    return db.prepare(
      `SELECT
         n.id,
         COALESCE(n.type, 'unknown') AS type,
         NULL AS cluster
       FROM nodes n
       WHERE ${_graphVisibleNodeWhere('n')}
       ORDER BY n.id ASC`
    ).all(...GRAPH_INTERNAL_NODE_IDS);
  }
}

function _graphBuildVisibleLayout(db) {
  return _graphComputeSharedLayout(_graphVisibleLayoutRows(db));
}

function _graphLayoutMeta(layout) {
  return {
    layout: GRAPH_SHARED_LAYOUT_VERSION,
    layoutGap: layout?.gap || 0,
    layoutColumns: layout?.columns || 0,
    layoutRows: layout?.rows || 0,
  };
}

function _graphAspectKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _graphAttrKey(attr) {
  const content = typeof attr === 'string' ? attr : attr?.content;
  return String(content || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function _graphDedupeAspects(aspects = []) {
  const out = [];
  const byName = new Map();
  for (const aspect of aspects || []) {
    const key = _graphAspectKey(aspect?.name);
    if (!key) continue;
    let merged = byName.get(key);
    if (!merged) {
      merged = {
        ...aspect,
        name: String(aspect.name || '').trim(),
        weight: Number(aspect.weight) || 5,
        attributes: [],
        duplicateIds: [],
      };
      byName.set(key, merged);
      out.push(merged);
    } else {
      merged.weight = Math.max(Number(merged.weight) || 5, Number(aspect.weight) || 5);
    }
    if (aspect?.id != null && !merged.duplicateIds.includes(aspect.id)) merged.duplicateIds.push(aspect.id);
    const seenAttrs = merged._seenAttrs || (merged._seenAttrs = new Set());
    for (const attr of aspect?.attributes || []) {
      const attrKey = _graphAttrKey(attr);
      if (!attrKey || seenAttrs.has(attrKey)) continue;
      seenAttrs.add(attrKey);
      merged.attributes.push(attr);
    }
  }
  for (const aspect of out) {
    aspect.duplicateCount = aspect.duplicateIds.length;
    delete aspect._seenAttrs;
  }
  return out;
}

function _graphShapeNode(row, details = {}) {
  const aspects = _graphDedupeAspects(details.aspects || []);
  const attrCountFromAspects = () => aspects.reduce((sum, aspect) => sum + (Array.isArray(aspect.attributes) ? aspect.attributes.length : 0), 0);
  const aspectCount = Number(row.aspect_count ?? row.aspectCount ?? details.aspectCount ?? aspects.length) || 0;
  const attributeCount = Number(row.attribute_count ?? row.attributeCount ?? details.attributeCount ?? attrCountFromAspects()) || 0;
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    description: row.description || '',
    importance: row.importance,
    mentions: row.mentions || 0,
    created: row.created || null,
    updated: row.updated || null,
    aliases: details.aliases || [],
    aspects,
    aspectCount,
    attributeCount,
    ...(details.detailsLoaded ? { _detailsLoaded: true } : {}),
    extra: _graphJsonExtra(row.extra),
    degree: row.degree_score ?? row.degree ?? undefined,
  };
}

function _graphVisibleNodeWhere(alias = 'n') {
  return `${alias}.id NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})`;
}

function _graphVisibleCounts(db) {
  const nodeCount = db.prepare(`SELECT COUNT(*) AS c FROM nodes n WHERE ${_graphVisibleNodeWhere('n')}`).get(...GRAPH_INTERNAL_NODE_IDS)?.c || 0;
  const edgeCount = db.prepare(
    `SELECT COUNT(*) AS c FROM edges
     WHERE source NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})
       AND target NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})`
  ).get(...GRAPH_INTERNAL_NODE_IDS, ...GRAPH_INTERNAL_NODE_IDS)?.c || 0;
  return { nodeCount, edgeCount };
}

function _graphTypeCounts(db) {
  return db.prepare(
    `SELECT COALESCE(type, 'unknown') AS type, COUNT(*) AS count
     FROM nodes n
     WHERE ${_graphVisibleNodeWhere('n')}
     GROUP BY COALESCE(type, 'unknown')
     ORDER BY count DESC, type ASC`
  ).all(...GRAPH_INTERNAL_NODE_IDS);
}

function _graphAggregateTypeId(type) {
  return `type:${encodeURIComponent(String(type || 'unknown'))}`;
}

function _graphTypeFromAggregateId(id) {
  const raw = String(id || '');
  if (!raw.startsWith('type:')) return null;
  try {
    return decodeURIComponent(raw.slice(5)) || 'unknown';
  } catch {
    return raw.slice(5) || 'unknown';
  }
}

function _graphAggregateTypeEdges(db, limit) {
  const nodeTypes = new Map();
  const nodesStmt = db.prepare(
    `SELECT id, COALESCE(type, 'unknown') AS type
     FROM nodes n
     WHERE ${_graphVisibleNodeWhere('n')}`
  );
  for (const row of nodesStmt.iterate(...GRAPH_INTERNAL_NODE_IDS)) {
    nodeTypes.set(row.id, row.type || 'unknown');
  }

  const pairs = new Map();
  const internalEdges = new Map();
  let representedEdgeCount = 0;
  const edgeStmt = db.prepare(
    `SELECT source, target, type, weight
     FROM edges
     WHERE source NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})
       AND target NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})`
  );
  for (const edge of edgeStmt.iterate(...GRAPH_INTERNAL_NODE_IDS, ...GRAPH_INTERNAL_NODE_IDS)) {
    const sourceType = nodeTypes.get(edge.source);
    const targetType = nodeTypes.get(edge.target);
    if (!sourceType || !targetType) continue;
    representedEdgeCount++;
    if (sourceType === targetType) {
      internalEdges.set(sourceType, (internalEdges.get(sourceType) || 0) + 1);
      continue;
    }
    const key = `${sourceType}\u0000${targetType}`;
    let row = pairs.get(key);
    if (!row) {
      row = { source_type: sourceType, target_type: targetType, count: 0, total_weight: 0 };
      pairs.set(key, row);
    }
    row.count++;
    row.total_weight += Number(edge.weight) || 1;
  }

  const sortedRows = Array.from(pairs.values()).sort((a, b) =>
    (b.count - a.count) ||
    (b.total_weight - a.total_weight) ||
    String(a.source_type).localeCompare(String(b.source_type)) ||
    String(a.target_type).localeCompare(String(b.target_type))
  );
  const edgeLimit = Math.max(0, Number(limit) || sortedRows.length);
  return {
    edgeRows: sortedRows.slice(0, edgeLimit),
    internalEdges,
    representedEdgeCount,
    edgePairCount: sortedRows.length,
    truncated: sortedRows.length > edgeLimit,
  };
}

function _graphRowsByIds(db, ids) {
  const orderedIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!orderedIds.length) return [];
  const q = orderedIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM nodes WHERE id IN (${q})`).all(...orderedIds);
  const byId = new Map(rows.map(r => [r.id, r]));
  return orderedIds.map(id => byId.get(id)).filter(Boolean);
}

function _graphContentCountMap(db, ids = null) {
  const nodeIds = ids ? Array.from(new Set((ids || []).filter(Boolean))) : null;
  if (nodeIds && !nodeIds.length) return new Map();
  const where = nodeIds
    ? `a.node_id IN (${nodeIds.map(() => '?').join(',')})`
    : `a.node_id IN (SELECT n.id FROM nodes n WHERE ${_graphVisibleNodeWhere('n')})`;
  const params = nodeIds || GRAPH_INTERNAL_NODE_IDS;
  const rows = db.prepare(
    `SELECT
       a.node_id,
       COUNT(DISTINCT a.id) AS aspect_count,
       COUNT(attr.id) AS attribute_count
     FROM aspects a
     LEFT JOIN attributes attr ON attr.aspect_id = a.id
     WHERE ${where}
     GROUP BY a.node_id`
  ).all(...params);
  return new Map(rows.map(row => [row.node_id, {
    aspectCount: Number(row.aspect_count) || 0,
    attributeCount: Number(row.attribute_count) || 0,
  }]));
}

function _graphRowWithContentCounts(row, countMap) {
  if (!row) return row;
  const counts = countMap?.get?.(row.id) || {};
  return {
    ...row,
    aspect_count: counts.aspectCount || 0,
    attribute_count: counts.attributeCount || 0,
  };
}

function _graphCollapseVisualEdges(edges = []) {
  const byKey = new Map();
  for (const edge of edges || []) {
    const source = edge?.source;
    const target = edge?.target;
    if (!source || !target) continue;
    const type = edge.type || 'related';
    const key = `${source}\u0000${target}\u0000${type}`;
    let merged = byKey.get(key);
    if (!merged) {
      merged = {
        source,
        target,
        type,
        weight: 1,
        count: 0,
        totalWeight: 0,
      };
      byKey.set(key, merged);
    }
    const weight = Number(edge.weight) || 1;
    merged.weight = Math.max(merged.weight, weight);
    merged.count += Number(edge.count) || 1;
    merged.totalWeight += Number(edge.totalWeight) || weight;
  }
  return Array.from(byKey.values()).map(edge => ({
    source: edge.source,
    target: edge.target,
    type: edge.type,
    weight: edge.weight || 1,
    ...(edge.count > 1 ? {
      count: edge.count,
      representedCount: edge.count,
      totalWeight: edge.totalWeight,
    } : {}),
  }));
}

function _graphEdgesForNodeSet(db, ids, limit) {
  const nodeIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (nodeIds.length < 2) return [];
  const q = nodeIds.map(() => '?').join(',');
  const edges = db.prepare(
    `SELECT source, target, type, weight
     FROM edges
     WHERE source IN (${q}) AND target IN (${q})
     ORDER BY COALESCE(weight, 1) DESC, id DESC
     LIMIT ?`
  ).all(...nodeIds, ...nodeIds, limit)
    .map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight || 1 }));
  return _graphCollapseVisualEdges(edges);
}

function _graphBuildFullPayload(db, meta = {}) {
  const includeDetails = meta.includeDetails === true;
  let nodes = db.prepare(`SELECT * FROM nodes n WHERE ${_graphVisibleNodeWhere('n')}`).all(...GRAPH_INTERNAL_NODE_IDS);
  let edges = db.prepare(
    `SELECT source, target, type, weight FROM edges
     WHERE source NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})
       AND target NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})`
  ).all(...GRAPH_INTERNAL_NODE_IDS, ...GRAPH_INTERNAL_NODE_IDS);
  const visibleIds = nodes.map(n => n.id);
  const countMap = _graphContentCountMap(db);
  let visibleAspects = [];
  let visibleAttrs = [];
  let visibleAliases = [];
  const aspectsByNode = {};
  const aliasesByNode = {};

  if (includeDetails && visibleIds.length) {
    const visibleNodeSubquery = `SELECT n.id FROM nodes n WHERE ${_graphVisibleNodeWhere('n')}`;
    visibleAspects = db.prepare(`SELECT * FROM aspects WHERE node_id IN (${visibleNodeSubquery})`).all(...GRAPH_INTERNAL_NODE_IDS);
    visibleAliases = db.prepare(`SELECT * FROM aliases WHERE node_id IN (${visibleNodeSubquery})`).all(...GRAPH_INTERNAL_NODE_IDS);
    visibleAttrs = db.prepare(
      `SELECT * FROM attributes
       WHERE aspect_id IN (
         SELECT a.id FROM aspects a WHERE a.node_id IN (${visibleNodeSubquery})
       )`
    ).all(...GRAPH_INTERNAL_NODE_IDS);

    const attrsByAspect = {};
    for (const a of visibleAttrs) {
      (attrsByAspect[a.aspect_id] ||= []).push({
        id: a.id,
        content: a.content,
        importance: a.importance,
        eventDate: a.event_date || null,
        source: a.source || null,
        extracted_with: a.extracted_with || null,
      });
    }
    for (const a of visibleAspects) {
      (aspectsByNode[a.node_id] ||= []).push({
        id: a.id,
        name: a.name,
        weight: a.weight,
        attributes: attrsByAspect[a.id] || [],
      });
    }
    for (const a of visibleAliases) (aliasesByNode[a.node_id] ||= []).push(a.alias);
  }

  const layout = _graphBuildVisibleLayout(db);
  const shapedNodes = nodes.map(n => _graphShapeNode(_graphRowWithContentCounts(n, countMap), {
    aliases: aliasesByNode[n.id] || [],
    aspects: aspectsByNode[n.id] || [],
    detailsLoaded: includeDetails,
  }));
  _graphApplySharedLayout(shapedNodes, layout);
  const shapedEdges = _graphCollapseVisualEdges(edges);
  const counts = _graphVisibleCounts(db);

  return {
    ...(meta.graph ? { graph: meta.graph } : {}),
    nodes: shapedNodes,
    edges: shapedEdges,
    ...(includeDetails ? { aspects: visibleAspects, attributes: visibleAttrs, aliases: visibleAliases } : {}),
    meta: {
      ...counts,
      mode: 'full',
      contentMode: includeDetails ? 'full' : 'lean',
      detailsLoaded: includeDetails,
      displayedNodeCount: nodes.length,
      displayedEdgeCount: shapedEdges.length,
      representedEdgeCount: counts.edgeCount,
      dedupedEdgeCount: Math.max(0, counts.edgeCount - shapedEdges.length),
      truncated: false,
      ..._graphLayoutMeta(layout),
      ...(meta.extra || {}),
    },
  };
}

function _graphBuildOverviewPayload(db, opts = {}) {
  const edgeLimit = opts.edgeLimit || GRAPH_OVERVIEW_EDGE_LIMIT;
  const counts = _graphVisibleCounts(db);
  const typeCounts = _graphTypeCounts(db);
  const edgeSummary = _graphAggregateTypeEdges(db, edgeLimit);
  const internalEdges = edgeSummary.internalEdges;
  const nodes = typeCounts.map(row => {
    const type = row.type || 'unknown';
    const count = row.count || 0;
    return {
      id: _graphAggregateTypeId(type),
      label: `${type} (${count})`,
      type,
      description: `Type group containing ${count} ${type} node${count === 1 ? '' : 's'}.`,
      importance: Math.max(3, Math.min(10, 3 + Math.log10(count + 1) * 2)),
      mentions: count,
      aliases: [],
      aspects: [],
      extra: {
        aggregate: true,
        aggregateKind: 'type',
        type,
        memberCount: count,
        internalEdgeCount: internalEdges.get(type) || 0,
      },
    };
  });
  const layout = _graphComputeSharedLayout(nodes.map(node => ({
    id: node.id,
    type: node.type,
    cluster: node.type,
  })));
  _graphApplySharedLayout(nodes, layout);
  const edges = edgeSummary.edgeRows.map(row => ({
    source: _graphAggregateTypeId(row.source_type),
    target: _graphAggregateTypeId(row.target_type),
    type: 'aggregate_edges',
    weight: Math.max(1, Math.log1p(row.count || 1)),
    count: row.count || 0,
  }));
  return {
    ...(opts.graph ? { graph: opts.graph } : {}),
    nodes,
    edges,
    meta: {
      ...counts,
      mode: 'overview',
      overviewKind: 'type-aggregate',
      aggregated: true,
      representedNodeCount: counts.nodeCount,
      representedEdgeCount: counts.edgeCount,
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edges.length,
      truncated: false,
      ..._graphLayoutMeta(layout),
      nodeLimit: null,
      edgeLimit,
      typeCounts,
      aggregateEdgeLimit: edgeLimit,
      aggregateEdgePairCount: edgeSummary.edgePairCount,
      aggregateEdgesTruncated: edgeSummary.truncated,
      ...(opts.extra || {}),
    },
  };
}

function _graphBuildTypeSlicePayload(db, type, opts = {}) {
  const nodeLimit = opts.nodeLimit || GRAPH_SLICE_NODE_LIMIT;
  const edgeLimit = opts.edgeLimit || GRAPH_SLICE_EDGE_LIMIT;
  const normalizedType = type || 'unknown';
  const typeCount = db.prepare(
    `SELECT COUNT(*) AS c
     FROM nodes n
     WHERE ${_graphVisibleNodeWhere('n')}
       AND COALESCE(n.type, 'unknown') = ?`
  ).get(...GRAPH_INTERNAL_NODE_IDS, normalizedType)?.c || 0;
  const rows = db.prepare(
    `WITH degree AS (
       SELECT id, SUM(c) AS degree FROM (
         SELECT source AS id, COUNT(*) AS c FROM edges GROUP BY source
         UNION ALL
         SELECT target AS id, COUNT(*) AS c FROM edges GROUP BY target
       ) GROUP BY id
     )
     SELECT n.*, COALESCE(degree.degree, 0) AS degree_score
     FROM nodes n
     LEFT JOIN degree ON degree.id = n.id
     WHERE ${_graphVisibleNodeWhere('n')}
       AND COALESCE(n.type, 'unknown') = ?
     ORDER BY
       COALESCE(n.importance, 0) DESC,
       COALESCE(degree.degree, 0) DESC,
       COALESCE(n.mentions, 0) DESC,
       COALESCE(n.updated, n.created, '') DESC,
       n.id ASC
     LIMIT ?`
  ).all(...GRAPH_INTERNAL_NODE_IDS, normalizedType, nodeLimit);
  const nodeIds = rows.map(n => n.id);
  const edges = _graphEdgesForNodeSet(db, nodeIds, edgeLimit);
  const counts = _graphVisibleCounts(db);
  const layout = _graphBuildVisibleLayout(db);
  const contentCounts = _graphContentCountMap(db, nodeIds);
  const shapedNodes = rows.map(n => _graphShapeNode(_graphRowWithContentCounts(n, contentCounts)));
  _graphApplySharedLayout(shapedNodes, layout);
  return {
    ...(opts.graph ? { graph: opts.graph } : {}),
    nodes: shapedNodes,
    edges,
    meta: {
      ...counts,
      mode: 'slice',
      sliceKind: 'type',
      root: _graphAggregateTypeId(normalizedType),
      rootType: normalizedType,
      representedNodeCount: typeCount,
      displayedNodeCount: rows.length,
      displayedEdgeCount: edges.length,
      truncated: rows.length < typeCount || edges.length >= edgeLimit,
      ..._graphLayoutMeta(layout),
      nodeLimit,
      edgeLimit,
      typeCounts: _graphTypeCounts(db),
      ...(opts.extra || {}),
    },
  };
}

function _graphBuildWebglPayload(db, opts = {}) {
  const nodeLimit = opts.nodeLimit || GRAPH_WEBGL_NODE_LIMIT;
  const edgeLimit = opts.edgeLimit || GRAPH_WEBGL_EDGE_LIMIT;
  const counts = _graphVisibleCounts(db);
  let nodeRows;
  try {
    nodeRows = db.prepare(
      `SELECT
         n.id,
         n.label,
         COALESCE(n.type, 'unknown') AS type,
         COALESCE(n.importance, 5) AS importance,
         COALESCE(n.mentions, 0) AS mentions,
         gm.group_id AS cluster
       FROM nodes n
       LEFT JOIN (
         SELECT m.node_id, MIN(m.group_id) AS group_id
         FROM node_group_members m
         JOIN node_groups g ON g.id = m.group_id
         WHERE g.superseded_at IS NULL
         GROUP BY m.node_id
       ) gm ON gm.node_id = n.id
       WHERE ${_graphVisibleNodeWhere('n')}
       ORDER BY n.id ASC
       LIMIT ?`
    ).all(...GRAPH_INTERNAL_NODE_IDS, nodeLimit);
  } catch {
    nodeRows = db.prepare(
      `SELECT
         n.id,
         n.label,
         COALESCE(n.type, 'unknown') AS type,
         COALESCE(n.importance, 5) AS importance,
         COALESCE(n.mentions, 0) AS mentions,
         NULL AS cluster
       FROM nodes n
       WHERE ${_graphVisibleNodeWhere('n')}
       ORDER BY n.id ASC
       LIMIT ?`
    ).all(...GRAPH_INTERNAL_NODE_IDS, nodeLimit);
  }

  const nodeIndex = new Map();
  const layout = _graphComputeSharedLayout(nodeRows);
  const nodes = nodeRows.map((row, index) => {
    nodeIndex.set(row.id, index);
    const node = {
      id: row.id,
      label: row.label || row.id,
      type: row.type || 'unknown',
      importance: row.importance || 5,
      mentions: row.mentions || 0,
      cluster: row.cluster == null ? null : row.cluster,
    };
    const point = layout.positions.get(String(row.id));
    if (point) {
      node.x = point.x;
      node.y = point.y;
    }
    return node;
  });

  const edges = [];
  const edgeStmt = db.prepare(
    `SELECT source, target, type, weight
     FROM edges
     WHERE source NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})
       AND target NOT IN (${GRAPH_INTERNAL_NODE_IDS.map(() => '?').join(',')})`
  );
  for (const edge of edgeStmt.iterate(...GRAPH_INTERNAL_NODE_IDS, ...GRAPH_INTERNAL_NODE_IDS)) {
    const source = nodeIndex.get(edge.source);
    const target = nodeIndex.get(edge.target);
    if (source === undefined || target === undefined) continue;
    edges.push([source, target, Number(edge.weight) || 1, edge.type || 'linked']);
    if (edges.length >= edgeLimit) break;
  }

  return {
    ...(opts.graph ? { graph: opts.graph } : {}),
    nodes,
    edges,
    meta: {
      ...counts,
      mode: 'webgl',
      renderer: 'webgl',
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edges.length,
      representedNodeCount: counts.nodeCount,
      representedEdgeCount: counts.edgeCount,
      truncated: nodes.length < counts.nodeCount || edges.length < counts.edgeCount,
      ..._graphLayoutMeta(layout),
      nodeLimit,
      edgeLimit,
      typeCounts: _graphTypeCounts(db),
      ...(opts.extra || {}),
    },
  };
}

function _graphBuildSlicePayload(db, rootId, opts = {}) {
  const nodeLimit = opts.nodeLimit || GRAPH_SLICE_NODE_LIMIT;
  const edgeLimit = opts.edgeLimit || GRAPH_SLICE_EDGE_LIMIT;
  const aggregateType = _graphTypeFromAggregateId(rootId);
  if (aggregateType) return _graphBuildTypeSlicePayload(db, aggregateType, opts);
  const root = rootId ? db.prepare(`SELECT * FROM nodes n WHERE id = ? AND ${_graphVisibleNodeWhere('n')}`).get(rootId, ...GRAPH_INTERNAL_NODE_IDS) : null;
  if (!root) {
    return _graphBuildOverviewPayload(db, {
      ...opts,
      extra: { ...(opts.extra || {}), root: rootId || null, rootMissing: !!rootId },
    });
  }
  const incident = db.prepare(
    `SELECT source, target, type, weight
     FROM edges
     WHERE source = ? OR target = ?
     ORDER BY COALESCE(weight, 1) DESC, id DESC
     LIMIT ?`
  ).all(rootId, rootId, Math.max(edgeLimit, nodeLimit * 2));
  const ids = [rootId];
  for (const e of incident) {
    if (ids.length >= nodeLimit) break;
    const other = e.source === rootId ? e.target : e.source;
    if (other && !GRAPH_INTERNAL_NODE_IDS.includes(other) && !ids.includes(other)) ids.push(other);
  }
  const nodes = _graphRowsByIds(db, ids);
  const nodeIds = nodes.map(n => n.id);
  const edges = _graphEdgesForNodeSet(db, nodeIds, edgeLimit);
  const counts = _graphVisibleCounts(db);
  const layout = _graphBuildVisibleLayout(db);
  const contentCounts = _graphContentCountMap(db, nodeIds);
  const shapedNodes = nodes.map(n => _graphShapeNode(_graphRowWithContentCounts(n, contentCounts)));
  _graphApplySharedLayout(shapedNodes, layout);
  return {
    ...(opts.graph ? { graph: opts.graph } : {}),
    nodes: shapedNodes,
    edges,
    meta: {
      ...counts,
      mode: 'slice',
      root: rootId,
      displayedNodeCount: nodes.length,
      displayedEdgeCount: edges.length,
      truncated: nodes.length < counts.nodeCount || edges.length < counts.edgeCount,
      ..._graphLayoutMeta(layout),
      nodeLimit,
      edgeLimit,
      typeCounts: _graphTypeCounts(db),
      ...(opts.extra || {}),
    },
  };
}

function _graphBuildPayload(db, params, meta = {}) {
  const mode = String(params?.get?.('mode') || 'auto').toLowerCase();
  const includeDetails = _graphWantsFullDetails(params);
  if (mode === 'auto') {
    const counts = _graphVisibleCounts(db);
    const nodeLimit = _graphIntParam(params, 'nodeLimit', GRAPH_WEBGL_NODE_LIMIT, 1000, 500000);
    const edgeLimit = _graphIntParam(params, 'edgeLimit', GRAPH_WEBGL_EDGE_LIMIT, 1000, 2000000);
    const extra = {
      requestedMode: 'auto',
      autoRendererThreshold: GRAPH_AUTO_WEBGL_NODE_THRESHOLD,
    };
    if (counts.nodeCount > GRAPH_AUTO_WEBGL_NODE_THRESHOLD) {
      return _graphBuildWebglPayload(db, {
        graph: meta.graph,
        nodeLimit,
        edgeLimit,
        extra,
      });
    }
    return _graphBuildFullPayload(db, {
      graph: meta.graph,
      includeDetails,
      extra: { ...extra, renderer: 'svg' },
    });
  }
  if (mode === 'webgl') {
    return _graphBuildWebglPayload(db, {
      graph: meta.graph,
      nodeLimit: _graphIntParam(params, 'nodeLimit', GRAPH_WEBGL_NODE_LIMIT, 1000, 500000),
      edgeLimit: _graphIntParam(params, 'edgeLimit', GRAPH_WEBGL_EDGE_LIMIT, 1000, 2000000),
    });
  }
  if (mode === 'overview') {
    return _graphBuildOverviewPayload(db, {
      graph: meta.graph,
      nodeLimit: _graphIntParam(params, 'nodeLimit', GRAPH_OVERVIEW_NODE_LIMIT, 50, 1500),
      edgeLimit: _graphIntParam(params, 'edgeLimit', GRAPH_OVERVIEW_EDGE_LIMIT, 50, 4000),
    });
  }
  if (mode === 'slice') {
    return _graphBuildSlicePayload(db, String(params?.get?.('root') || '').trim(), {
      graph: meta.graph,
      nodeLimit: _graphIntParam(params, 'nodeLimit', GRAPH_SLICE_NODE_LIMIT, 25, 1200),
      edgeLimit: _graphIntParam(params, 'edgeLimit', GRAPH_SLICE_EDGE_LIMIT, 25, 4000),
    });
  }
  return _graphBuildFullPayload(db, { graph: meta.graph, includeDetails });
}

function _graphBuildNodeDetails(db, nodeId, meta = {}) {
  const node = db.prepare(`SELECT * FROM nodes n WHERE id = ? AND ${_graphVisibleNodeWhere('n')}`).get(nodeId, ...GRAPH_INTERNAL_NODE_IDS);
  if (!node) return null;
  const aliases = db.prepare('SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias').all(nodeId).map(a => a.alias);
  const aspects = db.prepare('SELECT * FROM aspects WHERE node_id = ? ORDER BY weight DESC, name ASC').all(nodeId);
  const attrs = aspects.length
    ? db.prepare(`SELECT * FROM attributes WHERE aspect_id IN (${aspects.map(() => '?').join(',')}) ORDER BY importance DESC, id ASC`).all(...aspects.map(a => a.id))
    : [];
  const attrsByAspect = {};
  for (const a of attrs) {
    (attrsByAspect[a.aspect_id] ||= []).push({
      id: a.id,
      content: a.content,
      importance: a.importance,
      eventDate: a.event_date || null,
      source: a.source || null,
      extracted_with: a.extracted_with || null,
    });
  }
  const edges = _graphCollapseVisualEdges(db.prepare(
    `SELECT source, target, type, weight
     FROM edges
     WHERE source = ? OR target = ?
     ORDER BY COALESCE(weight, 1) DESC, id DESC
     LIMIT 500`
  ).all(nodeId, nodeId).map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight || 1 })));
  const neighborIds = Array.from(new Set(edges.map(e => e.source === nodeId ? e.target : e.source).filter(id => id && !GRAPH_INTERNAL_NODE_IDS.includes(id)))).slice(0, 500);
  const neighborCounts = _graphContentCountMap(db, neighborIds);
  const neighbors = _graphRowsByIds(db, neighborIds).map(n => _graphShapeNode(_graphRowWithContentCounts(n, neighborCounts)));
  return {
    ...(meta.graph ? { graph: meta.graph } : {}),
    node: _graphShapeNode({
      ...node,
      aspect_count: aspects.length,
      attribute_count: attrs.length,
    }, {
      aliases,
      aspects: aspects.map(a => ({
        id: a.id,
        name: a.name,
        weight: a.weight,
        attributes: attrsByAspect[a.id] || [],
      })),
      detailsLoaded: true,
    }),
    edges,
    neighbors,
    meta: { mode: 'node', nodeId, neighborCount: neighbors.length, edgeCount: edges.length },
  };
}

function _graphSearchLikeTerm(query) {
  return `%${String(query || '').trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

function _graphSearchPrefixTerm(query) {
  return `${String(query || '').trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

function _graphSearchSnippet(text, query, max = 180) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const q = String(query || '').trim().toLowerCase();
  const idx = q ? raw.toLowerCase().indexOf(q) : -1;
  if (idx < 0 || raw.length <= max) return raw.slice(0, max);
  const start = Math.max(0, idx - 52);
  const end = Math.min(raw.length, start + max);
  return `${start > 0 ? '...' : ''}${raw.slice(start, end)}${end < raw.length ? '...' : ''}`;
}

function _graphSearchNodes(db, query, { limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const qLower = q.toLowerCase();
  const like = _graphSearchLikeTerm(q);
  const prefix = _graphSearchPrefixTerm(q);
  const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const rows = db.prepare(`
    SELECT n.*,
           CASE
             WHEN lower(n.id) = ? OR lower(n.label) = ? THEN 0
             WHEN lower(n.label) LIKE ? ESCAPE '\\' THEN 1
             WHEN lower(n.id) LIKE ? ESCAPE '\\' THEN 2
             WHEN lower(COALESCE(n.type, '')) LIKE ? ESCAPE '\\' THEN 3
             WHEN lower(COALESCE(n.description, '')) LIKE ? ESCAPE '\\' THEN 4
             ELSE 5
           END AS search_rank,
           (
             SELECT asp.name
               FROM aspects asp
               JOIN attributes a ON a.aspect_id = asp.id
              WHERE asp.node_id = n.id
                AND lower(a.content) LIKE ? ESCAPE '\\'
              ORDER BY a.importance DESC, a.id DESC
              LIMIT 1
           ) AS match_aspect,
           (
             SELECT a.content
               FROM aspects asp
               JOIN attributes a ON a.aspect_id = asp.id
              WHERE asp.node_id = n.id
                AND lower(a.content) LIKE ? ESCAPE '\\'
              ORDER BY a.importance DESC, a.id DESC
              LIMIT 1
           ) AS match_attr
      FROM nodes n
     WHERE ${_graphVisibleNodeWhere('n')}
       AND (
            lower(n.id) = ?
         OR lower(n.label) = ?
         OR lower(n.id) LIKE ? ESCAPE '\\'
         OR lower(n.label) LIKE ? ESCAPE '\\'
         OR lower(COALESCE(n.type, '')) LIKE ? ESCAPE '\\'
         OR lower(COALESCE(n.description, '')) LIKE ? ESCAPE '\\'
         OR EXISTS (
              SELECT 1
                FROM aspects asp
                JOIN attributes a ON a.aspect_id = asp.id
               WHERE asp.node_id = n.id
                 AND (
                      lower(asp.name) LIKE ? ESCAPE '\\'
                   OR lower(a.content) LIKE ? ESCAPE '\\'
                 )
            )
       )
     ORDER BY search_rank ASC, COALESCE(n.importance, 5) DESC, datetime(n.updated) DESC, n.id ASC
     LIMIT ?
  `).all(
    qLower, qLower, prefix, prefix, like, like,
    like, like,
    ...GRAPH_INTERNAL_NODE_IDS,
    qLower, qLower, like, like, like, like, like, like,
    max,
  );

  return rows.map(row => {
    const node = _graphShapeNode(row);
    let matched = 'node';
    let snippet = '';
    if (String(row.label || '').toLowerCase().includes(qLower)) {
      matched = 'label';
      snippet = _graphSearchSnippet(row.label, q);
    } else if (String(row.id || '').toLowerCase().includes(qLower)) {
      matched = 'id';
      snippet = _graphSearchSnippet(row.id, q);
    } else if (String(row.type || '').toLowerCase().includes(qLower)) {
      matched = 'type';
      snippet = row.type || '';
    } else if (String(row.description || '').toLowerCase().includes(qLower)) {
      matched = 'description';
      snippet = _graphSearchSnippet(row.description, q);
    } else if (row.match_attr) {
      matched = row.match_aspect ? `aspect:${row.match_aspect}` : 'attribute';
      snippet = _graphSearchSnippet(row.match_attr, q);
    }
    return {
      node,
      matched,
      snippet,
      score: Number(row.search_rank) || 0,
    };
  });
}

// ── Provider / model smoke-test helpers ──
function _readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 256 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Build an ephemeral config object suitable for createClientForModel from
// posted form values, so the test uses what the user just typed (not what's saved).
function _ephemeralConfig(formProviders = {}, appConfig = {}) {
  const cfg = { apiTimeoutMs: 240000 };
  const setIfPresent = (key, value) => {
    if (value === undefined || value === null) return;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === '__KEEP__') return;
    cfg[key] = trimmed;
  };

  setIfPresent('anthropicApiKey', formProviders.anthropic?.apiKey);
  setIfPresent('openaiApiKey', formProviders.openai?.apiKey);
  setIfPresent('openaiBaseUrl', formProviders.openai?.baseUrl);
  setIfPresent('openrouterApiKey', formProviders.openrouter?.apiKey);
  setIfPresent('openrouterBaseUrl', formProviders.openrouter?.baseUrl);
  setIfPresent('openrouterReferer', formProviders.openrouter?.referer);
  setIfPresent('geminiApiKey', formProviders.gemini?.apiKey);
  setIfPresent('zaiApiKey', formProviders.zai?.apiKey);
  setIfPresent('zaiBaseUrl', formProviders.zai?.baseUrl);

  const existingCustom = appConfig.customProviders || {};
  const cp = {};
  if (formProviders.local?.baseUrl || formProviders.local?.apiKey) {
    cp.local = {
      url: String(formProviders.local?.baseUrl || existingCustom.local?.url || appConfig.localModelBaseUrl || '').trim(),
      key: String(formProviders.local?.apiKey || existingCustom.local?.key || appConfig.localModelApiKey || '').trim(),
      authHeader: String(formProviders.local?.authHeader || existingCustom.local?.authHeader || appConfig.localModelAuthHeader || 'bearer').trim() || 'bearer',
    };
  }
  for (const p of (formProviders.custom || [])) {
    const name = String(p?.name || '').trim().toLowerCase();
    if (!name) continue;
    const existing = existingCustom[name] || {};
    const url = String(p?.url || existing.url || '').trim();
    if (!url) continue;
    const key = p?.key === '__KEEP__'
      ? (existing.key || '')
      : String(p?.key || existing.key || '').trim();
    cp[name] = {
      url,
      key,
      authHeader: String(p?.authHeader || existing.authHeader || 'bearer').trim() || 'bearer',
    };
  }
  if (Object.keys(cp).length) cfg.customProviders = { ...existingCustom, ...cp };

  const pluginOverrides = {};
  const pluginForms = formProviders.__plugins || {};
  for (const [pluginId, values] of Object.entries(pluginForms)) {
    if (!values || typeof values !== 'object') continue;
    const next = {};
    for (const [field, value] of Object.entries(values)) {
      if (field === 'models') continue;
      if (value === undefined || value === null) continue;
      const trimmed = String(value).trim();
      if (!trimmed || trimmed === '__KEEP__') continue;
      next[field] = trimmed;
    }
    if (Object.keys(next).length) {
      pluginOverrides[pluginId] = { ...(appConfig.plugins?.[pluginId] || {}), ...next };
    }
  }
  if (Object.keys(pluginOverrides).length) {
    cfg.plugins = { ...(appConfig.plugins || {}), ...pluginOverrides };
  }

  return cfg;
}

function _findProviderEntry(pluginManager, providerName) {
  const provider = String(providerName || '').trim().toLowerCase();
  if (!provider) return null;
  const entries = pluginManager?.getProviders?.() || [];
  return entries.find(p => String(p.name || '').toLowerCase() === provider)
    || entries.find(p => (p.prefixes || []).map(x => String(x).toLowerCase()).includes(provider))
    || null;
}

function _customProviderConfig(appConfig, providerName) {
  const provider = String(providerName || '').trim().toLowerCase();
  if (!provider) return null;
  const custom = appConfig?.customProviders?.[provider];
  if (custom?.url) return custom;
  if (provider === 'local') {
    const slot = appConfig?.plugins?.['local-oai-provider'] || {};
    const url = appConfig?.localModelBaseUrl || slot.baseUrl || '';
    if (!url) return null;
    return {
      url,
      key: appConfig?.localModelApiKey || slot.apiKey || '',
      authHeader: appConfig?.localModelAuthHeader || slot.authHeader || 'bearer',
    };
  }
  return null;
}

function _customProviderProbeArgs(providerName, appConfig, body = {}) {
  const provider = String(providerName || body.name || body.kind || '').trim().toLowerCase();
  const saved = _customProviderConfig(appConfig, provider) || {};
  return {
    kind: 'custom',
    name: provider,
    baseUrl: body.baseUrl || body.url || saved.url || '',
    apiKey: body.apiKey || body.key || saved.key || '',
    authHeader: body.authHeader || saved.authHeader || 'bearer',
  };
}

function _isCustomProviderEntry(entry, providerName, appConfig) {
  return entry?.name === 'custom' || !!_customProviderConfig(appConfig, providerName);
}

// Plugin-aware provider probe. The wizard's "test" button hits
// /api/providers/<name>/test → here. We delegate to the owning
// plugin's `probe` hook so each vendor decides whether to run a
// chat call (anthropic-provider) or a /models GET (openai-provider,
// gemini-provider, local-oai-provider, openrouter-provider). No
// vendor branches in core; if no plugin claims the name we return
// an actionable error.
async function _probeProvider(name, body, pluginManager) {
  const entry = _findProviderEntry(pluginManager, name);
  if (!entry?.probe) {
    return { ok: false, error: `No probe registered for provider '${name}'. Install the matching provider plugin and restart.` };
  }
  try {
    return await entry.probe(entry.name === 'custom' ? { ...(body || {}), kind: 'custom', name } : (body || {}));
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

// Generic OAI-compatible context-length resolver — reads vendor-shaped
// fields from a /models response entry. Used only by the no-plugin
// fallback path of _listModelsForProvider for unclaimed `kind` values.
// Vendor-specific enrichment lives in each provider plugin's listModels.
// Official OpenAI /v1/models does not expose context/max-output fields;
// custom OAI-compatible endpoints may.
function _resolveContextLength(rawModel) {
  if (!rawModel) return null;
  const fields = ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'max_position_embeddings', 'max_input_tokens'];
  for (const f of fields) {
    const v = Number(rawModel[f]);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  const tp = rawModel.top_provider;
  if (tp) {
    for (const f of fields) {
      const v = Number(tp[f]);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

// For every tier-routed model in `models`, if `modelLimits` doesn't already
// have a contextWindow entry, probe the relevant provider's /models endpoint
// and fill it in. Guarantees per-model ctx is captured even if the wizard UI
// didn't pre-fill correctly. Probes each provider at most once per save.
//
// `pluginManager` is optional — when provided, plugin-registered listModels
// (e.g. anthropic-provider's vendor-aware probe) is preferred over the
// in-tree _listModelsForProvider.
async function _enrichModelLimits(modelLimits, models, providers, pluginManager, appConfig = {}) {
  const out = { ...(modelLimits || {}) };
  const tierEntries = Object.values(models || {}).filter(t => t?.model);
  if (!tierEntries.length) return out;
  const probedProviders = new Map(); // providerName → cached models response
  const probeProvider = async (providerName) => {
    if (probedProviders.has(providerName)) return probedProviders.get(providerName);
    const p = providers || {};
    const customRow = (p.custom || []).find(x => x?.name === providerName);
    const entry = _findProviderEntry(pluginManager, providerName)
      || (customRow ? (pluginManager?.getProviders?.() || []).find(x => x.name === 'custom' || x.pluginId === 'local-oai-provider') : null);
    if (!entry?.listModels) { probedProviders.set(providerName, null); return null; }
    // Build the probe body from the wizard's posted form values so the
    // plugin can probe with the operator's pending key/baseUrl before
    // it's been persisted. Each plugin understands the shape it cares
    // about — extra fields are ignored.
    const slot = p[providerName] || {};
    const probeArgs = _isCustomProviderEntry(entry, providerName, appConfig)
      ? _customProviderProbeArgs(providerName, appConfig, {
          apiKey: customRow?.key || slot.apiKey,
          baseUrl: customRow?.url || slot.baseUrl,
          authHeader: customRow?.authHeader || slot.authHeader,
        })
      : {
          kind: providerName,
          apiKey: slot.apiKey || customRow?.key,
          baseUrl: slot.baseUrl || customRow?.url,
          authHeader: slot.authHeader || customRow?.authHeader,
        };
    const res = await entry.listModels(probeArgs).catch(() => null);
    probedProviders.set(providerName, res);
    return res;
  };

  for (const tier of tierEntries) {
    const provider = tier.provider || 'anthropic';
    const model = tier.model;
    const key = (provider && provider !== 'anthropic') ? `${provider}/${model}` : model;
    if (out[key]?.contextWindow > 0 && out[key]?.capabilities) continue;
    const probed = await probeProvider(provider);
    if (!probed?.ok) continue;
    // Fold in EVERY model with known meta so we have a ready cache for
    // future tier changes too — not just the active one. Each call
    // takes whichever fields the plugin populated (ctx + maxOutput +
    // capabilities) and never overwrites existing operator-provided
    // values.
    for (const m of (probed.models || [])) {
      if (!m?.id) continue;
      const k = (provider && provider !== 'anthropic') ? `${provider}/${m.id}` : m.id;
      const cur = out[k] || {};
      const next = { ...cur };
      if (!cur.contextWindow && m.contextLength) next.contextWindow = m.contextLength;
      if (!cur.maxTokens && m.maxOutput) next.maxTokens = m.maxOutput;
      if (!cur.capabilities && m.capabilities) next.capabilities = m.capabilities;
      if (Object.keys(next).length) out[k] = next;
    }
  }
  return out;
}

// Generic OAI-compatible /models probe. Used as the no-plugin fallback
// for the /api/providers/list-models endpoint when `kind` doesn't match
// a registered plugin (e.g. legacy custom-OAI tunnels via SPORE_PROVIDER_*
// during the pre-plugins boot window). All vendor-aware probing
// (Anthropic prefix tables, OpenAI / Gemini / OpenRouter rich
// metadata) lives in each plugin's listModels.
async function _listModelsForProvider({ baseUrl, apiKey, authHeader }) {
  if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const headers = {};
  if (apiKey) {
    if (authHeader === 'x-api-key') headers['x-api-key'] = apiKey;
    else if (authHeader === 'x-key') headers['x-key'] = apiKey;
    else headers['Authorization'] = `Bearer ${apiKey}`;
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    if (!d) return { ok: false, error: 'invalid JSON response' };
    const arr = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.models) ? d.models : null);
    if (!arr) return { ok: false, error: 'no `data` or `models` array in response' };
    const models = arr.map(m => {
      if (typeof m === 'string') return { id: m, contextLength: null };
      const id = m.id || m.name || '';
      if (!id) return null;
      return { id, contextLength: _resolveContextLength(m) };
    }).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

const _TIER_PROMPTS = {
  casual: { system: '', user: 'What is 2+2? Answer with just the number.', expectText: /\b4\b/ },
  normal: { system: '', user: 'Respond with EXACTLY this JSON and nothing else: {"ok":true}', expectJson: v => v?.ok === true },
  planner: { system: 'You are a planning assistant.', user: 'Plan a 3-step approach for: "Investigate and fix a unit test failure". Output a numbered list with 3 items only.', expectText: /3[\.\)]|three/i },
  subagent: { system: '', user: 'Respond with EXACTLY this JSON: {"task":"noted"}', expectJson: v => v?.task === 'noted' },
  learner: {
    system: 'You are a knowledge extraction system. Extract entities/facts/relationships from the given conversation as JSON.',
    user: 'Conversation:\nUser: I bought a red Tesla Model 3 last Tuesday at the Palo Alto showroom for $52k.\n\nReturn JSON of form {"entities":[{"id":"...","type":"...","label":"..."}]} with at least one entity.',
    expectJson: v => Array.isArray(v?.entities) && v.entities.length >= 1,
  },
  // Recall tier — drives graph/retrieval.js _llmDecomposeQuery + reranker.
  // Smoke test mirrors the actual decompose prompt: ask it to break a
  // question into sub-queries, expect JSON with a non-empty subQueries array.
  recall: {
    system: 'You decompose user questions into knowledge-graph search queries.',
    user: 'Decompose this question into 2-4 search queries for a memory graph. Return ONLY JSON of form {"subQueries":["q1","q2",...]}.\n\nQuestion: "What did Alice say about the dolphin trip last summer?"',
    expectJson: v => Array.isArray(v?.subQueries) && v.subQueries.length >= 1,
  },
};

async function _probeModelTier(tier, body, appConfig) {
  const { MultiProvider } = require('../providers');
  const { provider, model, providers } = body || {};
  if (!model) return { ok: false, error: 'missing model' };

  // Merge config with posted form values so the ephemeral client honors current keys
  const overrides = _ephemeralConfig(providers || {}, appConfig || {});
  const cfg = {
    ...(appConfig || {}),
    ...overrides,
    plugins: overrides.plugins || appConfig?.plugins,
    customProviders: overrides.customProviders || appConfig?.customProviders,
  };

  // Compose the effective model id (provider prefix + model).
  // The /api/settings API returns the model split into provider + model where
  // `model` can itself contain slashes (e.g. "/shared/home/.../GLM-5.1-FP8").
  // So "includes('/')" is NOT a safe proxy for "already prefixed". Prepend
  // whenever the model doesn't START with "${provider}/" (or the provider
  // isn't anthropic, which has no prefix).
  let effectiveModel = model;
  if (provider && provider !== 'anthropic' && !model.startsWith(provider + '/')) {
    effectiveModel = `${provider}/${model}`;
  }

  if (tier === 'imageVlm' || tier === 'videoVlm' || tier === 'audioVlm') {
    return await _probeVLMTier(tier, effectiveModel, cfg);
  }

  const spec = _TIER_PROMPTS[tier];
  if (!spec) return { ok: false, error: `unknown tier: ${tier}` };

  const t0 = Date.now();
  try {
    const client = new MultiProvider(cfg);
    const messages = [{ role: 'user', content: spec.user }];
    // Honor a per-model maxTokens override. Priority:
    //   1. body.maxTokens (what the operator just typed in the tier row,
    //      lets them test before saving)
    //   2. config.modelLimits[<ref>].maxTokens (saved value)
    //   3. 8K default — enough for reasoning models (Qwen/GLM/Kimi) to
    //      finish thinking and still produce a final-answer block.
    const limits = cfg?.modelLimits || {};
    const savedLimKey = limits[effectiveModel]
      ? effectiveModel
      : Object.keys(limits).find(k => k.endsWith('/' + effectiveModel)) ||
        Object.keys(limits).find(k => {
          const slash = k.indexOf('/');
          return slash > 0 && k.slice(slash + 1) === effectiveModel;
        }) || null;
    const savedLim = savedLimKey ? limits[savedLimKey] : null;
    const perModelMax =
      Number(body?.maxTokens) ||
      Number(savedLim?.maxTokens) ||
      0;
    let params = {
      model: effectiveModel,
      max_tokens: perModelMax > 0 ? perModelMax : 8192,
      messages,
      _usageMeta: { source: 'provider-test', route: `model-test:${tier}`, trigger: 'model-test' },
    };
    // Reasoning effort: prefer body override (live UI value), else saved.
    const effort = body?.reasoningEffort || savedLim?.reasoningEffort || null;
    if (effort && effort !== 'auto') {
      try {
        const { AgentLoop } = require('../agent/loop');
        params = AgentLoop.applyReasoningEffort(params, effectiveModel, effort);
      } catch (e) { console.warn('[web] applyReasoningEffort failed: ' + e.message); }
    }
    if (spec.system) params.system = spec.system;

    let text = '';
    let ttft = null;
    let reasoningOnly = false;
    // Prefer streaming so nginx tunnels don't 504 on slow models
    const stream = (typeof client.messages.stream === 'function') ? client.messages.stream(params) : null;
    const extractText = (blocks) => {
      const t = (blocks || []).find(b => b.type === 'text')?.text || '';
      if (t) return { text: t, reasoningOnly: false };
      // Reasoning-only fallback: if the model emitted only thinking blocks
      // (typical when max_tokens cut it off mid-reasoning), surface that so
      // the probe at least sees SOMETHING. Common on Qwen3/GLM-style models.
      const thinking = (blocks || []).find(b => b.type === 'thinking')?.thinking
                    || (blocks || []).find(b => b.type === 'thinking')?.text || '';
      if (thinking) return { text: thinking, reasoningOnly: true };
      return { text: '', reasoningOnly: false };
    };
    if (stream && typeof stream.on === 'function' && typeof stream.finalMessage === 'function') {
      stream.on('text', chunk => { if (ttft == null) ttft = Date.now() - t0; });
      const result = await stream.finalMessage();
      ({ text, reasoningOnly } = extractText(result?.content));
    } else {
      const r = await client.messages.create(params);
      ({ text, reasoningOnly } = extractText(r?.content));
    }

    // Check expectation
    let matched = true;
    if (spec.expectText) matched = spec.expectText.test(text);
    else if (spec.expectJson) {
      try {
        const m = text.match(/[\{\[][\s\S]*[\}\]]/);
        const j = JSON.parse((m ? m[0] : text).trim().replace(/^```json\s*|```\s*$/g, ''));
        matched = !!spec.expectJson(j);
      } catch { matched = false; }
    }
    return {
      ok: matched,
      latency_ms: Date.now() - t0,
      ttft_ms: ttft,
      model: effectiveModel,
      excerpt: text.slice(0, 200),
      reasoningOnly,
      error: matched ? undefined : (
        reasoningOnly
          ? `model returned only reasoning (no final answer) — likely cut off by max_tokens. Bump max_tokens or pick a non-reasoning model for the ${tier} tier.`
          : (text ? 'response did not match expected format' : 'model returned empty response')
      ),
    };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

async function _probeVLMTier(tier, effectiveModel, cfg) {
  const { MultiProvider } = require('../providers');
  const mapping = {
    imageVlm: { file: 'test-image.png', mime: 'image/png', prompt: 'What color is the main shape in this image? Answer with one word.' },
    videoVlm: { file: 'test-video.mp4', mime: 'video/mp4', prompt: 'Briefly describe what this video shows in one sentence.' },
    audioVlm: { file: 'test-audio.mp3', mime: 'audio/mp3', prompt: 'Briefly describe what you hear in one sentence.' },
  };
  const spec = mapping[tier];
  const filePath = path.join(__dirname, '..', 'static', 'test-assets', spec.file);
  let b64 = '';
  try { b64 = fs.readFileSync(filePath).toString('base64'); }
  catch (e) { return { ok: false, error: `test asset missing: ${spec.file}` }; }

  // Build content — use image block for imageVlm; for video/audio, Anthropic does not
  // support those content blocks directly, so fall back to a text-only smoke test that
  // states a file was sent (lets us at least verify connectivity on the routed model).
  let content;
  if (tier === 'imageVlm') {
    content = [
      { type: 'image', source: { type: 'base64', media_type: spec.mime, data: b64 } },
      { type: 'text', text: spec.prompt },
    ];
  } else {
    // video / audio — most providers don't accept raw media as a content block here.
    // Do a text-only reachability probe; real analysis happens via the analyze tool.
    content = spec.prompt + ' (Note: smoke test — this tier is used by the analyze_' + (tier === 'videoVlm' ? 'video' : 'audio') + ' tool.)';
  }

  const t0 = Date.now();
  try {
    const client = new MultiProvider(cfg);
    const params = {
      model: effectiveModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
      _usageMeta: { source: 'provider-test', route: `model-test:${tier}`, trigger: 'model-test' },
    };
    const r = await client.messages.create(params);
    const text = (r.content || []).find(b => b.type === 'text')?.text || '';
    return { ok: true, latency_ms: Date.now() - t0, model: effectiveModel, excerpt: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

class WebGateway {
  constructor(toolSystem) {
    this.tools = toolSystem;
    this.config = toolSystem.config;
    this.log = toolSystem.log;
    this.graph = toolSystem.graph;
    this.skills = toolSystem.skills;

    this._server = null;
    this._serverDir = null;
    this._serveMounts = new Map();
    this._serveMountsLoaded = false;
    this._lastServeMount = null;
    this._wss = null;
    this._sshManager = null;
    this._voicePipeline = null;
    this._webSessions = new Map();
    // Session client registry: sessionId -> Set<{ws, role:'origin'|'observer'}>
    this._sessionClients = new Map();
    this._settingsService = new WebSettingsService(this);
    this._manualSessionDistills = new Set();

    // Subscribe to settings changes so caches and downstream consumers
    // pick up new values without a restart. This replaces the manual
    // `this._voicePipeline = null` / `agent.client = null` lines in the
    // old _persistSettingsPatch body.
    this._wireSettingsSubscriptions();

    // Mirror once at construct time. Plugins register their settings
    // synchronously when the manager loads them, so by the time
    // WebGateway is built (after plugin load), the store has every
    // plugin key. The boot-time mirror in config.js runs BEFORE
    // plugins load, so it can't see plugin values — this catches up
    // legacy `this.config.plugins[id]` consumers (the providers tab
    // form-population path, model lookups, etc.).
    try { this._mirrorSettingsToLegacyConfig(); } catch (e) {
      this.log.warn(`[settings] initial mirror failed: ${e.message}`);
    }
  }

  _submitAgentTurn(opts, meta = {}) {
    const queue = this.tools?._jobQueue;
    if (queue?.submitAgentTurn) return queue.submitAgentTurn(opts, meta);
    return this.tools?._agent?.processMessage(opts);
  }

  _sporeCodeApiShim() {
    return {
      _appContext: { config: this.config, tools: this.tools },
      getHostConfig: () => this.config || {},
      getConfig: () => this.config?.plugins?.['spore-code'] || {},
      getLogger: () => this.log,
    };
  }

  _sporeCodeModule() {
    const candidates = [
      // Source checkout: src/gateways/web.js -> ../../plugins/spore-code
      path.join(__dirname, '..', '..', 'plugins', 'spore-code'),
      // Docker image: /app/gateways/web.js -> ../plugins/spore-code
      path.join(__dirname, '..', 'plugins', 'spore-code'),
      path.join(process.cwd(), 'plugins', 'spore-code'),
    ];
    for (const candidate of candidates) {
      try { return require(candidate); } catch (e) {
        if (e?.code !== 'MODULE_NOT_FOUND') throw e;
      }
    }
    throw new Error('Unable to resolve spore-code plugin module');
  }

  _sporeCodeBearerToken(req) {
    const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
    return String(authHeader).startsWith('Bearer ') ? String(authHeader).slice(7).trim() : null;
  }

  _sporeCodeDeviceAuthFromReq(req) {
    const token = this._sporeCodeBearerToken(req);
    if (!token) return null;
    try {
      const plugin = this._sporeCodeModule();
      const auth = plugin.validateDeviceToken?.(this._sporeCodeApiShim(), token);
      return auth?.ok ? { ...auth, token } : null;
    } catch (e) {
      this.log.warn(`[spore-code] device auth lookup failed: ${e.message}`);
      return null;
    }
  }

  _sporeCodeRoutingOverride(deviceId) {
    if (!deviceId) return null;
    try {
      const plugin = this._sporeCodeModule();
      return plugin.getDeviceRoutingOverride?.(this._sporeCodeApiShim(), deviceId) || null;
    } catch (e) {
      this.log.warn(`[spore-code] device routing lookup failed: ${e.message}`);
      return null;
    }
  }

  _loadSessionGraphSessionsLib() {
    const candidates = [
      path.join(__dirname, '..', 'plugins', 'session-graph', 'lib', 'sessions.js'),
      path.join(__dirname, '..', '..', 'plugins', 'session-graph', 'lib', 'sessions.js'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return require(candidate);
      } catch {}
    }
    return null;
  }

  _waitForLearnerDrain(learner, timeoutMs = 8000) {
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

  _pendingSessionIdsForGraphDb(db) {
    if (!db) return [];
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT n.id, n.extra,
               COALESCE((
                 SELECT a.content
                   FROM aspects asp
                   JOIN attributes a ON a.aspect_id = asp.id
                  WHERE asp.node_id = n.id
                    AND asp.name = 'lifecycle'
                    AND a.content LIKE 'turn_count:%'
                  ORDER BY a.id DESC
                  LIMIT 1
               ), 'turn_count: 0') AS turn_count,
               EXISTS(
                 SELECT 1 FROM aspects asp
                  WHERE asp.node_id = n.id AND asp.name = 'rounds'
               ) AS has_rounds
          FROM nodes n
         WHERE n.type = 'session'
      `).all();
    } catch {
      return [];
    }
    const out = [];
    for (const row of rows) {
      let extra = {};
      try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
      if (extra.distilled_at || extra.distilling || extra.archived_at) continue;
      const turns = Number(String(row.turn_count || '').match(/turn_count:\s*(\d+)/)?.[1] || 0);
      if (!row.has_rounds && turns <= 0) continue;
      const sid = extra.sessionId || String(row.id || '').replace(/^session-/, '');
      if (sid) out.push(String(sid));
    }
    return [...new Set(out)];
  }

  async _flushGraphSessionsBeforeDelete(slug) {
    const sessions = this._loadSessionGraphSessionsLib();
    const baseLearner = this.tools?.learner || this.tools?._agent?.learner || null;
    const llmClient = this.tools?.llmClient;
    if (!sessions || !baseLearner?.getGraphDb || !llmClient || !slug) return { flushed: 0, skipped: true };

    const db = baseLearner.getGraphDb(slug);
    if (!db) return { flushed: 0, skipped: true, reason: 'missing_graph_db' };
    const pending = this._pendingSessionIdsForGraphDb(db);
    if (!pending.length) return { flushed: 0 };

    const learner = Object.create(baseLearner);
    learner.db = db;
    learner._graphSlug = slug;
    learner._graphRegistry = baseLearner._graphRegistry || this.tools?._graphRegistry || learner._graphRegistry;

    this.log.info(`[multi-graph] Distilling ${pending.length} pending session(s) before deleting "${slug}"`);
    await this._waitForLearnerDrain(baseLearner);

    let flushed = 0;
    const errors = [];
    for (const sid of pending) {
      try {
        graphEvents.withGraph({ graph: slug }, () => sessions.finalizeSessionNode(learner, sid, { endedAt: new Date().toISOString() }));
        await graphEvents.withGraph({ graph: slug }, () => sessions.summarizeSessionNode(learner, llmClient, this.config, sid, this.log));
        await graphEvents.withGraph({ graph: slug }, () => sessions.distillSession(learner, llmClient, this.config, sid, this.log));
        flushed++;
      } catch (e) {
        errors.push(`${sid}: ${e.message}`);
        this.log.warn(`[multi-graph] pending session distill failed before deleting ${slug}: ${sid}: ${e.message}`);
      }
    }
    return { flushed, pending: pending.length, errors };
  }

  _sessionIdFromSessionNode(row) {
    if (!row?.id) return null;
    try {
      const extra = row.extra ? JSON.parse(row.extra) : {};
      if (extra?.sessionId) return String(extra.sessionId);
    } catch {}
    return String(row.id).replace(/^session-/, '');
  }

  _clearManualSessionDistillLock(db, row) {
    if (!db || !row?.id) return false;
    let extra = {};
    try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
    if (!extra.distilling || extra.distilled_at) return false;
    delete extra.distilling;
    extra.manual_distill_resume_at = new Date().toISOString();
    db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(extra), row.id);
    return true;
  }

  _queueManualSessionSummaryDistill({ db, graphSlug, nodeId, force = true }) {
    const sessions = this._loadSessionGraphSessionsLib();
    const baseLearner = this.tools?.learner || this.tools?._agent?.learner || null;
    const llmClient = this.tools?.llmClient;
    if (!sessions) return { ok: false, error: 'session-graph session library unavailable', status: 503 };
    if (!baseLearner || !llmClient) return { ok: false, error: 'learner or LLM client unavailable', status: 503 };
    if (!db) return { ok: false, error: 'graph database unavailable', status: 503 };

    const row = db.prepare('SELECT id, label, type, extra FROM nodes WHERE id = ?').get(nodeId);
    if (!row) return { ok: false, error: 'session node not found', status: 404 };
    if (String(row.type || '').toLowerCase() !== 'session') {
      return { ok: false, error: 'selected node is not a session node', status: 400 };
    }
    let extra = {};
    try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
    if (extra.distilled_at) {
      return { ok: true, queued: false, skipped: 'already-distilled', nodeId: row.id, distilledAt: extra.distilled_at };
    }

    const sessionId = this._sessionIdFromSessionNode(row);
    if (!sessionId) return { ok: false, error: 'could not resolve session id from node', status: 400 };

    const key = `${graphSlug || 'active'}:${row.id}`;
    if (this._manualSessionDistills.has(key)) {
      return { ok: true, queued: false, alreadyRunning: true, nodeId: row.id, sessionId };
    }

    const learner = Object.create(baseLearner);
    learner.db = db;
    if (graphSlug) learner._graphSlug = graphSlug;
    learner._graphRegistry = baseLearner._graphRegistry || this.tools?._graphRegistry || learner._graphRegistry;

    this._manualSessionDistills.add(key);
    const run = (async () => {
      let lockCleared = false;
      try {
        graphEvents.emit('change', { op: 'session:manual-distill-start', nodeId: row.id, graph: graphSlug || undefined, source: 'manual-session-distill' });
        await this._waitForLearnerDrain(baseLearner);
        graphEvents.withGraph(graphSlug ? { graph: graphSlug } : null, () => sessions.finalizeSessionNode(learner, sessionId, { endedAt: new Date().toISOString() }));
        await graphEvents.withGraph(graphSlug ? { graph: graphSlug } : null, () => sessions.summarizeSessionNode(learner, llmClient, this.config, sessionId, this.log));

        const latest = db.prepare('SELECT id, extra FROM nodes WHERE id = ?').get(row.id);
        if (force && latest) lockCleared = this._clearManualSessionDistillLock(db, latest);

        const result = await graphEvents.withGraph(graphSlug ? { graph: graphSlug } : null, () => sessions.distillSession(learner, llmClient, this.config, sessionId, this.log));
        graphEvents.emit('change', {
          op: 'session:manual-distill-done',
          nodeId: row.id,
          graph: graphSlug || undefined,
          lockCleared,
          result,
          source: 'manual-session-distill',
        });
      } catch (e) {
        this.log.warn(`[manual-session-distill] ${row.id} failed: ${e.message}`);
        graphEvents.emit('change', { op: 'session:manual-distill-done', nodeId: row.id, graph: graphSlug || undefined, error: e.message, source: 'manual-session-distill' });
      } finally {
        this._manualSessionDistills.delete(key);
      }
    })();
    run.catch(e => this.log.warn(`[manual-session-distill] ${row.id} unhandled failure: ${e.message}`));

    return { ok: true, queued: true, nodeId: row.id, sessionId, graph: graphSlug || null };
  }

  _decorateGraphEventForClient(evt = {}) {
    const out = { ...(evt || {}) };
    try {
      const registry = this.tools?._graphRegistry;
      let graph = out.graph || out.graphSlug || out.slug || null;
      if (!graph && Array.isArray(out.graphs) && out.graphs.length) {
        graph = out.graphs.filter(Boolean).map(String).join(', ');
      }
      // Only graph-domain events get an active-graph fallback. Transient
      // agent activity such as tool:call/read_file/exec is session-scoped,
      // not graph-scoped; labeling it as "default" makes it look like the
      // default graph is reading files or executing commands.
      const op = String(out.op || '');
      const graphDomainEvent = /^(graph|node|edge|aspect|attribute):/.test(op);
      if (!graph && graphDomainEvent && registry?.getActiveSlug) graph = registry.getActiveSlug();
      if (graph && !out.graph) out.graph = String(graph);
      if (out.graph && !out.graphName && registry?.get) {
        const single = String(out.graph).includes(',') ? null : String(out.graph);
        const meta = single ? registry.get(single) : null;
        if (meta?.name) out.graphName = meta.name;
      }
    } catch {}
    return out;
  }

  /**
   * Wire the settings store's reactive subscribers to the WebGateway's
   * caches. Fires on every applyPatch (via transport) and on plugin
   * config changes (which also flow through transport).
   *
   *   voice.*           → drop the voice pipeline so it rebuilds
   *   models.* | providers.*  → clear the LLM client cache, re-init agent
   *   sectionBudgets / totalPromptBudget → live-apply to GraphContext
   */
  _wireSettingsSubscriptions() {
    if (this._settingsSubsWired) return;
    const settings = require('../settings');

    // Voice — staleness fix. Discord/Telegram gateways own their own
    // pipeline instances and have their own subscribes; this one is
    // for the web-built pipeline used by /api/voice.
    settings.subscribe('voice.*', () => { this._voicePipeline = null; });

    // Models or providers changed — invalidate the LLM client cache and
    // ask the agent loop to re-init so it picks up new model refs.
    // ** = any depth; provider keys are two-deep (providers.openai.apiKey)
    // and plugin keys vary by plugin. We mirror BEFORE reinit so
    // agent.init() sees the post-patch values on this.config.* instead
    // of the stale pre-patch ones (subscribers fire mid-patch, before
    // the wrapper code mirrors).
    const mirrorThenReinit = () => {
      try { this._mirrorSettingsToLegacyConfig(); } catch (e) {
        this.log.warn(`[settings] mirror failed: ${e.message}`);
      }
      this._reinitAgent();
    };
    settings.subscribe('models.*', mirrorThenReinit);
    settings.subscribe('providers.**', mirrorThenReinit);
    settings.subscribe('plugins.**', mirrorThenReinit);

    // Live-apply prompt budgets to the running GraphContext.
    settings.subscribe('sectionBudgets', () => {
      const G = this.graph?.constructor;
      if (this.graph && G) this.graph._sectionBudgets = { ...G.SECTION_BUDGETS, ...(settings.get('sectionBudgets') || {}) };
    });
    settings.subscribe('totalPromptBudget', () => {
      const G = this.graph?.constructor;
      if (this.graph && G) this.graph._totalBudget = settings.get('totalPromptBudget') || G.TOTAL_BUDGET;
    });

    this._settingsSubsWired = true;
  }

  _reinitAgent() {
    try {
      this.tools?.llmClient?.clearCache?.();
      const agent = this.tools?._agent;
      if (agent) {
        agent.client = null;
        if (typeof agent.init === 'function') agent.init();
      }
    } catch (e) {
      this.log.warn(`[settings] agent re-init failed: ${e.message}`);
    }
  }

  _modelLibraryProviderStatus(providerName) {
    const provider = String(providerName || '').trim().toLowerCase();
    const mgr = this.tools?._pluginManager;
    const registered = mgr?.getProviders?.() || [];
    const entry = registered.find(p => (
      p.name === provider || (Array.isArray(p.prefixes) && p.prefixes.map(x => String(x).toLowerCase()).includes(provider))
    ));
    const custom = _customProviderConfig(this.config, provider);
    const configuredByHost = (
      (provider === 'anthropic' && !!this.config.anthropicApiKey) ||
      (provider === 'openai' && !!this.config.openaiApiKey) ||
      (provider === 'openrouter' && !!this.config.openrouterApiKey) ||
      (provider === 'gemini' && !!this.config.geminiApiKey) ||
      (provider === 'zai' && !!this.config.zaiApiKey) ||
      !!custom?.url
    );
    const configured = !!(entry?.configured || configuredByHost);
    return {
      registered: !!entry,
      configured,
      pluginId: entry?.pluginId || null,
      available: !!entry && configured,
    };
  }

  _visibleModelLibraryEntries(entries = [], opts = {}) {
    if (opts.includeUnavailable) return entries;
    const mgr = this.tools?._pluginManager;
    if (!mgr?.getProviders) return entries;
    return entries
      .map(e => ({ ...e, providerStatus: this._modelLibraryProviderStatus(e.provider) }))
      .filter(e => e.providerStatus.available);
  }

  // Wizard / settings persistence targets. We always write to the
  // Phase 2: settings.db is the canonical store. spore.json is migrated
  // on first boot then renamed; .env is read at boot for operator overrides
  // but never written. The path helpers are kept as harmless utilities so
  // any external tool referencing them still works.
  _settingsConfigPath() {
    const dataDir = this.config?.dataDir || process.env.SPORE_DATA_DIR;
    return dataDir ? path.join(dataDir, 'spore.json') : null;
  }

  _settingsEnvPath() {
    const dataDir = this.config?.dataDir || process.env.SPORE_DATA_DIR;
    return dataDir ? path.join(dataDir, '.env') : null;
  }

  // Wipes all user-data tables in the graph DB, then re-applies the
  // seeded reference nodes. Synchronous-ish — runs inside one BEGIN
  // / COMMIT on the live db handle. Always backs up first; backup
  // path is returned to the caller. Throws on any failure (the API
  // wrapper turns that into a 500 + ROLLBACK has already happened).
  //
  // Tables wiped: all tables that hold user-derived state (nodes,
  // aspects, attributes, edges, gaps, episodes, hints, derived facts,
  // reflections, audit/recycle data, FTS shadows). The schema stays —
  // only data is deleted. After wipe we re-apply
  // /app/reference-nodes.sql + every /app/migrate-ref-*.sql so the
  // ref-* nodes come back fresh per the seed contract.
  async _resetGraphToSeeds() {
    const db = this.graph?.db;
    if (!db) throw new Error('graph db not initialized');
    const dbPath = this.config.graphDbPath;
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error('graph db path missing on disk');

    // Backup first so the action is recoverable.
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '').slice(0, 19);
    const backup = dbPath + '.pre-reset.' + ts;
    fs.copyFileSync(dbPath, backup);

    const before = {
      nodes:    db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
      aspects:  db.prepare('SELECT COUNT(*) c FROM aspects').get().c,
      attrs:    db.prepare('SELECT COUNT(*) c FROM attributes').get().c,
      edges:    db.prepare('SELECT COUNT(*) c FROM edges').get().c,
      episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    };

    // Tables that hold user state. Order doesn't matter with FKs off
    // but we list children first as a sanity-check shape. Wrapped in
    // try so a missing table on an older schema doesn't abort the
    // whole reset — e.g. derived_facts didn't exist in early builds.
    //
    // plugin_installs is included so the manager re-runs each plugin's
    // install SQL after the wipe — without this, the install marker
    // stays put while the actual ref nodes are gone, leaving plugins
    // in an inconsistent "installed but missing" state.
    const userTables = [
      'edges', 'attribute_history', 'attributes', 'aspects', 'gaps',
      'hints', 'derived_facts', 'reflections', 'quality_audits',
      'recycle_bin', 'node_sources', 'edge_sources', 'aliases',
      'node_group_members', 'node_groups', 'episodes', 'meta',
      'plugin_installs',
      'nodes',
    ];
    const ftsTables = ['attr_fts', 'episodes_fts', 'hints_fts'];

    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN TRANSACTION');
    try {
      for (const t of userTables) {
        try { db.exec(`DELETE FROM ${t}`); } catch (e) { this.log.debug(`[reset-graph] skipping ${t}: ${e.message}`); }
      }
      // Rebuild FTS indexes — they're contentless tables linked to
      // their content tables; after we delete the content rows the
      // FTS shadow has stale index entries until we tell it to
      // rebuild.
      for (const fts of ftsTables) {
        try { db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`); } catch (e) { this.log.warn('[web] db.exec failed: ' + e.message); }
      }

      // Re-apply seeds in order:
      //   1. seed-graph.sql — agent self-node + identity / voice / rules
      //      AND the original ref-* nodes from the install era (FLUX,
      //      ElevenLabs, web architecture, etc.). Templated with the
      //      AGENT_ID / AGENT_NAME placeholders the same way
      //      seedGraph() does at first boot.
      //   2. migrate-ref-*.sql — newer ref nodes (ssh, tailscale,
      //      cluster, search-tools, email) + additive aspects on
      //      existing refs. All idempotent (WHERE NOT EXISTS guards)
      //      so re-running is safe.
      //
      // Notably we do NOT apply reference-nodes.sql here even though
      // it exists on disk. It's a near-duplicate of the ref-* sections
      // already inside seed-graph.sql; applying both creates duplicate
      // attributes (the INSERTs in those files lack OR IGNORE because
      // attributes have no unique constraint to defer to). The janitor
      // catches the dupes eventually but that's wasteful — better to
      // not create them in the first place. seed-graph.sql is the
      // canonical seed; reference-nodes.sql sits as a historical
      // alternate that no boot path actually reads.
      const appDir = path.resolve(__dirname, '..');
      const seedGraphPath = path.join(appDir, 'seed-graph.sql');
      if (fs.existsSync(seedGraphPath)) {
        const agentId = this.config.agentId || 'spore';
        const agentName = this.config.displayName ||
          agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        let sg = fs.readFileSync(seedGraphPath, 'utf8');
        sg = sg.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);
        db.exec(sg);
      } else {
        this.log.warn('[reset-graph] seed-graph.sql missing — agent self-node will not be restored');
      }
      for (const f of fs.readdirSync(appDir).filter(x => x.startsWith('migrate-ref-') && x.endsWith('.sql')).sort()) {
        const fp = path.join(appDir, f);
        if (fs.existsSync(fp)) db.exec(fs.readFileSync(fp, 'utf8'));
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys=ON');
      throw e;
    }
    db.exec('PRAGMA foreign_keys=ON');

    // Re-run each installed plugin's reference-node install SQL so
    // their nodes/aspects come back. The plugin_installs row was
    // wiped above, so the manager's run-once gate sees a fresh slate
    // and re-applies install.sql for every plugin that registered
    // reference nodes (spore-code, future ones). Runs OUTSIDE the
    // wipe transaction so each plugin's install can manage its own
    // BEGIN/COMMIT and a single failing plugin doesn't roll back
    // the rest of the reset.
    try {
      const mgr = this.tools?._pluginManager;
      if (mgr?._runReferenceNodeInstalls) mgr._runReferenceNodeInstalls();
    } catch (e) {
      this.log.warn(`[reset-graph] plugin ref-node reinstall failed: ${e.message}`);
    }

    const after = {
      nodes:    db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
      aspects:  db.prepare('SELECT COUNT(*) c FROM aspects').get().c,
      attrs:    db.prepare('SELECT COUNT(*) c FROM attributes').get().c,
      edges:    db.prepare('SELECT COUNT(*) c FROM edges').get().c,
      episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    };

    this.log.warn(`[reset-graph] graph reset complete; backup at ${backup}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    return { backup, before, after };
  }

  async _resetGeneralKnowledgeGraph(slug = 'spore-knowledge-base') {
    const registry = this.tools?._graphRegistry;
    if (!registry) throw new Error('multi-graph registry not initialized');
    const graph = registry.get(slug);
    if (!graph) throw new Error(`Graph "${slug}" not found`);
    if (graph.role !== 'general_kb') throw new Error('Only the General Knowledge Base can be reset here');

    const dbPath = registry.getDbPath(slug);
    if (!dbPath || !fs.existsSync(dbPath)) throw new Error('general knowledge graph db missing on disk');

    const { DatabaseSync } = require('node:sqlite');
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '').slice(0, 19);
    const backup = path.join(backupDir, `${slug}.pre-reset.${ts}.bak`);

    const learner = this.tools?.learner || this.tools?._agent?.learner || null;
    const cachedDb = learner?._graphDbs?.[slug] || null;
    const db = cachedDb || new DatabaseSync(dbPath);

    const count = (table) => {
      try { return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; } catch { return 0; }
    };
    const before = {
      nodes: count('nodes'),
      aspects: count('aspects'),
      attrs: count('attributes'),
      edges: count('edges'),
      episodes: count('episodes'),
    };

    try {
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    } catch {
      try { fs.copyFileSync(dbPath, backup); } catch (e) { throw new Error(`backup failed: ${e.message}`); }
    }

    const userTables = [
      'edges', 'attribute_history', 'attributes', 'aspects', 'gaps',
      'hints', 'derived_facts', 'reflections', 'quality_audits',
      'recycle_bin', 'node_sources', 'edge_sources', 'aliases',
      'node_group_members', 'node_groups', 'episodes', 'meta',
      'plugin_installs',
      'nodes',
    ];
    const ftsTables = ['attr_fts', 'episodes_fts', 'hints_fts'];

    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN TRANSACTION');
    try {
      for (const t of userTables) {
        try { db.exec(`DELETE FROM ${t}`); } catch (e) { this.log.debug(`[reset-general-kb] skipping ${t}: ${e.message}`); }
      }
      for (const fts of ftsTables) {
        try { db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`); } catch {}
      }

      const appDir = path.resolve(__dirname, '..');
      const seedGraphPath = path.join(appDir, 'seed-graph.sql');
      if (!fs.existsSync(seedGraphPath)) throw new Error('seed-graph.sql missing');
      const agentId = this.config.agentId || 'spore';
      const agentName = this.config.displayName ||
        agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      let sql = fs.readFileSync(seedGraphPath, 'utf8');
      sql = sql.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);
      db.exec(sql);

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys=ON');
      throw e;
    }
    db.exec('PRAGMA foreign_keys=ON');

    // General Knowledge owns plugin reference nodes. After a General KB
    // reset, wipe plugin_installs with the graph data and then let the
    // plugin manager re-apply the installed reference bundles here.
    try {
      const mgr = this.tools?._pluginManager;
      if (mgr?._runReferenceNodeInstalls) mgr._runReferenceNodeInstalls();
    } catch (e) {
      this.log.warn(`[reset-general-kb] plugin ref-node reinstall failed: ${e.message}`);
    }

    const after = {
      nodes: count('nodes'),
      aspects: count('aspects'),
      attrs: count('attributes'),
      edges: count('edges'),
      episodes: count('episodes'),
    };

    if (!cachedDb) {
      try { db.close(); } catch {}
    }
    registry.refreshStats(slug);
    this.log.warn(`[reset-general-kb] graph reset complete; backup at ${backup}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    return { backup, before, after, graph: registry.get(slug) };
  }

  async _resetCoreGraphsAndPruneExtras() {
    const registry = this.tools?._graphRegistry;
    if (!registry) {
      const fallback = await this._resetGraphToSeeds();
      return {
        mode: 'legacy',
        defaultGraph: fallback,
        generalGraph: null,
        prunedGraphs: [],
        beforeGraphs: [],
        afterGraphs: [],
      };
    }

    const generalSlug = registry.getGeneralKnowledgeSlug?.() || 'spore-knowledge-base';
    if (!registry.get(generalSlug) && registry.ensureSystemGraph) {
      registry.ensureSystemGraph({
        slug: generalSlug,
        name: 'General Knowledge Base',
        description: 'Protected reusable knowledge distilled from projects and sessions',
        role: 'general_kb',
      });
    }

    let defaultSlug = registry.get('default') ? 'default' : (registry.getMainSlug?.() || 'default');
    if (!registry.get(defaultSlug)) {
      defaultSlug = registry.create('Default', 'Initial knowledge graph', {
        slug: 'default',
        role: 'main',
        source: 'system',
        createdBy: 'system',
      });
    }

    const beforeGraphs = registry.list().map(g => ({
      slug: g.slug,
      name: g.name,
      role: g.role || null,
      active: !!g.active,
      nodeCount: g.nodeCount || 0,
    }));

    if (registry.getActiveSlug?.() !== defaultSlug) {
      this.tools?.switchGraph?.(defaultSlug);
      graphEvents.emit('change', { op: 'graph:switched', slug: defaultSlug, source: 'reset-core-graphs' });
    }

    const defaultGraph = await this._resetGraphToSeeds();
    const generalGraph = registry.get(generalSlug)
      ? await this._resetGeneralKnowledgeGraph(generalSlug)
      : null;

    const learner = this.tools?.learner || this.tools?._agent?.learner || null;
    const keep = new Set([defaultSlug, generalSlug].filter(Boolean));
    const prunedGraphs = [];
    const failedPrunes = [];

    for (const graph of registry.list()) {
      if (!graph?.slug || keep.has(graph.slug)) continue;
      try {
        learner?.closeGraphDb?.(graph.slug);
        if (registry.getActiveSlug?.() === graph.slug) {
          this.tools?.switchGraph?.(defaultSlug);
        }
        registry.delete(graph.slug, { allowProtected: true });
        prunedGraphs.push({
          slug: graph.slug,
          name: graph.name,
          role: graph.role || null,
          nodeCount: graph.nodeCount || 0,
        });
        graphEvents.emit('change', { op: 'graph:deleted', slug: graph.slug, graph: graph.slug, source: 'reset-core-graphs' });
      } catch (e) {
        failedPrunes.push({
          slug: graph.slug,
          name: graph.name,
          role: graph.role || null,
          error: e.message,
        });
      }
    }

    try { registry.refreshStats(defaultSlug); } catch {}
    try { if (registry.get(generalSlug)) registry.refreshStats(generalSlug); } catch {}

    const afterGraphs = registry.list().map(g => ({
      slug: g.slug,
      name: g.name,
      role: g.role || null,
      active: !!g.active,
      nodeCount: g.nodeCount || 0,
    }));

    if (failedPrunes.length) {
      const err = new Error(`Failed to prune ${failedPrunes.length} graph(s)`);
      err.details = { failedPrunes, defaultGraph, generalGraph, prunedGraphs, beforeGraphs, afterGraphs };
      throw err;
    }

    this.log.warn(`[reset-core-graphs] reset default=${defaultSlug} general=${generalSlug}; pruned=${prunedGraphs.length}; before=${beforeGraphs.length} after=${afterGraphs.length}`);
    graphEvents.emit('change', { op: 'graph:reset-core', slug: defaultSlug, generalSlug, source: 'reset-core-graphs' });
    return {
      mode: 'multi-graph-core',
      defaultSlug,
      generalSlug,
      defaultGraph,
      generalGraph,
      prunedGraphs,
      beforeGraphs,
      afterGraphs,
    };
  }

  _readSettingsConfigFile() {
    return this._settingsService.readSettingsConfigFile();
  }

  _writeSettingsConfigFile(nextConfig) {
    return this._settingsService.writeSettingsConfigFile(nextConfig);
  }

  _applyEnvUpdates(envUpdates = {}) {
    return this._settingsService.applyEnvUpdates(envUpdates);
  }

  _deriveDisplayName(agentId) {
    return this._settingsService.deriveDisplayName(agentId);
  }

  _normalizeSettingsModelRef(rawValue) {
    return this._settingsService.normalizeSettingsModelRef(rawValue);
  }

  _composeSettingsModelRef(value) {
    return this._settingsService.composeSettingsModelRef(value);
  }

  _currentCustomProviderNames() {
    return this._settingsService.currentCustomProviderNames();
  }

  _normalizeSettingsCustomProviders(rawProviders) {
    return this._settingsService.normalizeSettingsCustomProviders(rawProviders);
  }

  _normalizeBrowserBackendSetting(rawValue) {
    return this._settingsService.normalizeBrowserBackendSetting(rawValue);
  }

  _getSettingsState() {
    return this._settingsService.getSettingsState();
  }

  _buildPluginsSettingsBlock() {
    return this._settingsService.buildPluginsSettingsBlock();
  }

  _ensurePluginConfigPersister() {
    return this._settingsService.ensurePluginConfigPersister();
  }

  _persistSettingsPatch(body = {}, opts = {}) {
    return this._settingsService.persistSettingsPatch(body, opts);
  }

  _mirrorSettingsToLegacyConfig() {
    return this._settingsService.mirrorSettingsToLegacyConfig();
  }

  _applyOnboardingToGraph(db, payload = {}) {
    return this._settingsService.applyOnboardingToGraph(db, payload);
  }

  _currentSettingValue(key) {
    try {
      const settings = require('../settings');
      if (!settings.isBooted?.()) settings.boot({ dataDir: this.config.dataDir });
      const value = settings.get(key);
      if (value !== undefined) return value;
    } catch { /* settings store may be unavailable during early boot */ }
    return undefined;
  }

  _currentWebPort() {
    const raw = this._currentSettingValue('webPort') ?? this.config.webPort;
    const port = Number(raw);
    return Number.isFinite(port) && port > 0 ? port : null;
  }

  _currentPublicBaseUrl() {
    const publicUrl = this._currentSettingValue('publicUrl') ?? this.config.publicUrl;
    const normalized = String(publicUrl || '').trim().replace(/\/+$/, '');
    if (normalized) return normalized;

    const ingressDomain = this._currentSettingValue('ingressDomain') ?? this.config.ingressDomain;
    if (!ingressDomain) return null;
    const ingressPath = String(this._currentSettingValue('ingressPath') ?? this.config.ingressPath ?? '').replace(/\/$/, '');
    const ingressHttps = this._currentSettingValue('ingressHttps') ?? this.config.ingressHttps;
    const proto = ingressHttps ? 'https' : 'http';
    return `${proto}://${ingressDomain}${ingressPath}`;
  }

  _currentWebRootUrl() {
    const publicUrl = this._currentPublicBaseUrl();
    if (publicUrl) return publicUrl;
    return '';
  }

  _currentServeUrl() {
    const root = this._currentWebRootUrl();
    return root ? `${root}/serve` : '/serve';
  }

  _serveMountsPath() {
    return path.join(this.config.dataDir || process.cwd(), '.web-serve-mounts.json');
  }

  _safeServeMountName(value) {
    const raw = String(value || '').trim().toLowerCase();
    const safe = raw
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!safe || ['api', 'files', 'graph', 'login', 'serve', 'settings', 'static'].includes(safe)) return null;
    return safe;
  }

  _loadServeMounts() {
    if (this._serveMountsLoaded) return;
    this._serveMountsLoaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._serveMountsPath(), 'utf8'));
      const mounts = parsed && typeof parsed.mounts === 'object' ? parsed.mounts : {};
      for (const [name, record] of Object.entries(mounts)) {
        const safe = this._safeServeMountName(name);
        const dir = record?.dir ? this._normalizeServeDir(record.dir) : null;
        if (safe && dir) this._serveMounts.set(safe, { ...record, dir });
      }
      if (parsed?.lastMount && this._serveMounts.has(parsed.lastMount)) this._lastServeMount = parsed.lastMount;
    } catch { /* no persisted mounts yet */ }
  }

  _saveServeMounts() {
    try {
      const mounts = {};
      for (const [name, record] of this._serveMounts.entries()) mounts[name] = record;
      fs.writeFileSync(this._serveMountsPath(), JSON.stringify({
        lastMount: this._lastServeMount,
        mounts,
      }, null, 2) + '\n');
    } catch (e) {
      this.log.warn(`[web_serve] Could not persist serve mounts: ${e.message}`);
    }
  }

  _nextServeMountName(base = 'website') {
    this._loadServeMounts();
    const safeBase = this._safeServeMountName(base) || 'website';
    let i = 1;
    let candidate = `${safeBase}_${i}`;
    while (this._serveMounts.has(candidate)) {
      i += 1;
      candidate = `${safeBase}_${i}`;
    }
    return candidate;
  }

  _resolveServeMountName(input = {}, serveDir = '') {
    const requested = input.name || input.mount || input.slug || input.app || input.appName;
    const explicit = this._safeServeMountName(requested);
    if (explicit) return explicit;
    this._loadServeMounts();
    const resolvedDir = this._normalizeServeDir(serveDir);
    for (const [name, record] of this._serveMounts.entries()) {
      if (path.resolve(record.dir) === path.resolve(resolvedDir)) return name;
    }
    const baseName = this._safeServeMountName(path.basename(serveDir || ''));
    const base = baseName && baseName !== 'web' ? baseName : 'website';
    return this._nextServeMountName(base);
  }

  _registerServeMount(name, dir) {
    this._loadServeMounts();
    const safe = this._safeServeMountName(name);
    if (!safe) return null;
    const resolved = this._normalizeServeDir(dir);
    const now = new Date().toISOString();
    const prior = this._serveMounts.get(safe) || {};
    this._serveMounts.set(safe, {
      name: safe,
      dir: resolved,
      createdAt: prior.createdAt || now,
      updatedAt: now,
    });
    this._lastServeMount = safe;
    this._saveServeMounts();
    return safe;
  }

  _serveUrlForMount(name) {
    const safe = this._safeServeMountName(name);
    if (!safe) return null;
    const root = this._currentServeUrl();
    return `${root}/${safe}`;
  }

  _defaultServeMountName() {
    this._loadServeMounts();
    if (this._lastServeMount && this._serveMounts.has(this._lastServeMount)) return this._lastServeMount;
    const first = this._serveMounts.keys().next();
    return first.done ? null : first.value;
  }

  _defaultServeDir() {
    return path.join(this.config.workspacePath || process.cwd(), 'web');
  }

  _normalizeServeDir(dir) {
    const fallback = this._defaultServeDir();
    const resolved = path.resolve(dir || fallback);
    const appRoot = path.resolve(__dirname, '..');
    const workspaceRoot = path.resolve(this.config.workspacePath || process.cwd());
    if (workspaceRoot !== appRoot && (resolved === appRoot || resolved.startsWith(appRoot + path.sep))) {
      this.log.warn(`[web_serve] Refusing to serve app source path ${resolved}; using ${fallback}`);
      return fallback;
    }
    return resolved;
  }

  // ── Public API ──────────────────────────────────────────────────────

  get server() { return this._server; }
  get wss() { return this._wss; }

  handleAction(action, dir, opts = {}) {
    if (action === 'status') return this._status(opts);
    if (action === 'stop') return this._stop(opts);
    if (action === 'start') return this._start(dir, opts);
    if (action === 'backend') return this._startWithBackend(dir, opts);
    return { error: `Unknown action: ${action}` };
  }

  broadcast(msg) {
    if (!this._wss) return;
    const data = JSON.stringify(msg);
    const creatorOnly = msg.type && msg.type.startsWith('benchmark:');
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (creatorOnly && client._role !== 'admin' && client._role !== 'creator') continue;
      try { client.send(data); } catch (e) { this.log.warn('[web] client.send failed: ' + e.message); }
    }
  }

  // ── Session client registry (for observer mode) ─────────────────────

  _registerSessionClient(sessionId, ws, role = 'origin') {
    if (!this._sessionClients.has(sessionId)) {
      this._sessionClients.set(sessionId, new Set());
    }
    const set = this._sessionClients.get(sessionId);
    // Remove any existing entry for this ws OR same user+role (handles reconnect
    // where the old WebSocket hasn't fired 'close' yet — prevents ghost clients
    // that echo messages back to the reconnected client)
    const toRemove = [];
    for (const entry of set) {
      if (entry.ws === ws) { toRemove.push(entry); continue; }
      if (entry.role === role && entry.ws._user && entry.ws._user === ws._user) {
        toRemove.push(entry);
      }
    }
    for (const entry of toRemove) set.delete(entry);
    set.add({ ws, role });

    // Re-send orphaned tools from a previous CLI that disconnected mid-execution
    if (role === 'origin' && this._orphanedTools?.has(sessionId)) {
      const orphaned = this._orphanedTools.get(sessionId);
      this._orphanedTools.delete(sessionId);
      if (orphaned?.length) {
        this.log.info(`[ws] Re-sending ${orphaned.length} orphaned tool(s) to reconnected CLI for ${sessionId}`);
        if (!ws._pendingTools) ws._pendingTools = new Map();
        for (const tool of orphaned) {
          // The original tool:request data isn't saved (we only have the Promise),
          // so we can't re-send the exact request. Instead, reject the pending
          // promises with a retryable error — the agent loop will retry the tool.
          _clearCliPendingToolTimers(tool);
          tool.reject(new Error(`CLI reconnected — tool execution interrupted. Retry.`));
        }
      }
    }
  }

  _unregisterSessionClient(sessionId, ws) {
    const set = this._sessionClients.get(sessionId);
    if (!set) return;
    for (const entry of set) {
      if (entry.ws === ws) { set.delete(entry); break; }
    }
    if (set.size === 0) this._sessionClients.delete(sessionId);
  }

  /**
   * Forward a message to all OTHER clients in the same session as the sender.
   * Uses msg.sessionId if present (reliable), falls back to membership search.
   */
  _forwardToSessionPeers(ws, msg) {
    const targetSid = msg.sessionId;
    if (targetSid) {
      const clients = this._sessionClients.get(targetSid);
      if (clients) {
        const data = JSON.stringify(msg);
        let count = 0;
        for (const entry of clients) {
          if (entry.ws !== ws && entry.ws.readyState === 1) {
            try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
          }
        }
        return count;
      }
    }
    // Fallback: search all sessions for this ws
    for (const [sid, clients] of this._sessionClients) {
      let isMember = false;
      for (const entry of clients) { if (entry.ws === ws) { isMember = true; break; } }
      if (isMember) {
        const data = JSON.stringify(msg);
        let count = 0;
        for (const entry of clients) {
          if (entry.ws !== ws && entry.ws.readyState === 1) {
            try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
          }
        }
        return count;
      }
    }
    return 0;
  }

  /**
   * Broadcast a payload to every WS client that belongs to this agent-loop
   * session. Used by ask_user + plan-mode proposals so the picker card /
   * approve buttons reach the right operator's tabs only.
   *
   * Routing:
   *   'dm:<userId>'               — webapp DM: every web WS for the user
   *   'shared:dm:web:<userId>'    — same (multi-platform buildKey form)
   *   'channel:web:control-panel' — shared; route to every web creator
   *   '<mode>-<ts>-<rand>' (merge/link/child/wakeup/etc.) — route to operator
   *   acorn session ids           — route via _sessionClients (sessionId keyed)
   */
  _broadcastToSessionKey(sessionKey, payload) {
    if (!sessionKey) return 0;

    // Spore Code + shared-channel path: `_sessionClients` is keyed by the
    // client-provided sessionId (commonly "cli:user@project-..."). The agent
    // loop stores the same turn as "channel:<sessionId>". Older clients used a
    // bare key without the "cli:" prefix, so try all stable variants.
    const rawKey = String(sessionKey);
    const tryKeys = new Set([rawKey]);
    const channelMatch = rawKey.match(/^(?:(?:shared|private):)?channel:(.+)$/);
    if (channelMatch) {
      tryKeys.add(channelMatch[1]);
      const platformMatch = channelMatch[1].match(/^([a-z][a-z0-9_-]*):(.+)$/i);
      if (platformMatch && ['cli', 'web'].includes(platformMatch[1].toLowerCase())) {
        tryKeys.add(platformMatch[2]);
      }
    }
    const sessionPayload = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !payload.sessionId && channelMatch
      ? { ...payload, sessionId: channelMatch[1] }
      : payload;
    const data = JSON.stringify(sessionPayload);
    for (const tryKey of tryKeys) {
      const set = this._sessionClients?.get(tryKey);
      if (!set) continue;
      let count = 0;
      for (const entry of set) {
        if (entry.ws.readyState === 1) {
          try { entry.ws.send(data); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
        }
      }
      if (count) return count;
    }

    // DM path: resolve the userId from the key and match web app tabs for
    // that user. CLI sessions share the same authenticated user id, but they
    // have their own session channel and should not receive web DM wakeups.
    let targetUser = null;
    const dmMatch = rawKey.match(/^(?:(?:shared|private):)?dm:(.+)$/);
    if (dmMatch) {
      const rest = dmMatch[1];
      const platformMatch = rest.match(/^([a-z][a-z0-9_-]*):(.+)$/i);
      if (platformMatch) {
        if (platformMatch[1].toLowerCase() !== 'web') return 0;
        targetUser = platformMatch[2];
      } else {
        targetUser = rest;
      }
    } else if (/^(merge|link|child|wakeup)[-_]/.test(rawKey)) targetUser = 'operator';
    if (!targetUser) return 0;
    let count = 0;
    for (const wsClient of this._wss?.clients || []) {
      if (wsClient.readyState !== 1) continue;
      if (wsClient._role === 'cli') continue;
      if (wsClient._user === targetUser) {
        try { wsClient.send(data); count++; } catch (e) { this.log.warn('[web] wsClient.send failed: ' + e.message); }
      }
    }
    return count;
  }

  _broadcastBinaryToSessionKey(sessionKey, buffer) {
    if (!sessionKey || !buffer) return 0;

    const rawKey = String(sessionKey);
    const tryKeys = new Set([rawKey]);
    const channelMatch = rawKey.match(/^(?:(?:shared|private):)?channel:(.+)$/);
    if (channelMatch) {
      tryKeys.add(channelMatch[1]);
      const platformMatch = channelMatch[1].match(/^([a-z][a-z0-9_-]*):(.+)$/i);
      if (platformMatch && ['cli', 'web'].includes(platformMatch[1].toLowerCase())) {
        tryKeys.add(platformMatch[2]);
      }
    }
    for (const tryKey of tryKeys) {
      const set = this._sessionClients?.get(tryKey);
      if (!set) continue;
      let count = 0;
      for (const entry of set) {
        if (entry.ws.readyState === 1) {
          try { entry.ws.send(buffer); count++; } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
        }
      }
      if (count) return count;
    }

    let targetUser = null;
    const dmMatch = rawKey.match(/^(?:(?:shared|private):)?dm:(.+)$/);
    if (dmMatch) {
      const rest = dmMatch[1];
      const platformMatch = rest.match(/^([a-z][a-z0-9_-]*):(.+)$/i);
      if (platformMatch) {
        if (platformMatch[1].toLowerCase() !== 'web') return 0;
        targetUser = platformMatch[2];
      } else {
        targetUser = rest;
      }
    } else if (/^(merge|link|child|wakeup)[-_]/.test(rawKey)) targetUser = 'operator';
    if (!targetUser) return 0;
    let count = 0;
    for (const wsClient of this._wss?.clients || []) {
      if (wsClient.readyState !== 1) continue;
      if (wsClient._role === 'cli') continue;
      if (wsClient._user === targetUser) {
        try { wsClient.send(buffer); count++; } catch (e) { this.log.warn('[web] wsClient.send failed: ' + e.message); }
      }
    }
    return count;
  }

  _removeClientFromAllSessions(ws) {
    for (const [sessionId, set] of this._sessionClients) {
      for (const entry of set) {
        if (entry.ws === ws) { set.delete(entry); break; }
      }
      if (set.size === 0) this._sessionClients.delete(sessionId);
    }
  }

  _sendToSession(sessionId, payload) {
    const clients = this._sessionClients.get(sessionId);
    if (!clients || clients.size === 0) return;
    const sessionPayload = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !payload.sessionId
      ? { ...payload, sessionId }
      : payload;
    const data = JSON.stringify(sessionPayload);
    for (const { ws: c } of clients) {
      try { if (c.readyState === 1) c.send(data); } catch (e) { this.log.warn('[web] c.send failed: ' + e.message); }
    }
  }

  _getOriginClient(sessionId) {
    const clients = this._sessionClients.get(sessionId);
    if (!clients) return null;
    for (const entry of clients) {
      if (entry.role === 'origin') return entry.ws;
    }
    return null;
  }

  _sessionKeyClientMatches(ws, sessionKey, channelId = null) {
    if (!ws) return false;
    const keys = new Set();
    const add = (value) => {
      if (!value) return;
      const raw = String(value);
      keys.add(raw);
      const channelMatch = raw.match(/^(?:(?:shared|private):)?channel:(.+)$/);
      if (channelMatch) keys.add(channelMatch[1]);
    };
    add(sessionKey);
    add(channelId);
    if (channelId) add(`channel:${channelId}`);
    for (const key of keys) {
      const clients = this._sessionClients.get(key);
      if (!clients) continue;
      for (const entry of clients) if (entry.ws === ws) return true;
    }
    return false;
  }

  _askUserAnswerMatchesClient(ws, msg, pending) {
    if (!ws || !pending?.sessionKey) return false;
    const pendingKey = String(pending.sessionKey);
    const candidates = new Set();
    const add = (value) => {
      if (value === undefined || value === null || value === '') return;
      candidates.add(String(value));
    };
    add(msg?.sessionKey);
    add(msg?.sessionId);
    if (msg?.sessionId) add(`channel:${msg.sessionId}`);

    try {
      const userId = ws._user || 'operator';
      const isCli = _isCliChatSession(ws, msg?.sessionId);
      if (msg?.sessionId && this.tools?._sessions?.constructor?.buildKey) {
        add(this.tools._sessions.constructor.buildKey(
          isCli ? msg.sessionId : 'web:control-panel',
          !isCli,
          userId
        ));
      }
    } catch {}

    if (candidates.has(pendingKey)) return true;
    if (this._sessionKeyClientMatches(ws, pending.sessionKey, pending.channelId)) return true;

    if (!_isCliChatSession(ws, msg?.sessionId)) {
      const userId = ws._user || 'operator';
      if (pendingKey === `dm:${userId}` || pendingKey === `shared:dm:web:${userId}` || pendingKey === `private:dm:web:${userId}`) {
        return true;
      }
      if (/^(merge|link|child|wakeup)[-_]/.test(pendingKey) && userId === 'operator') {
        return true;
      }
    }

    return false;
  }

  broadcastBinary(buffer) {
    if (!this._wss) return;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try { client.send(buffer); } catch (e) { this.log.warn('[web] client.send failed: ' + e.message); }
    }
  }

  hasConnectedClients() {
    if (!this._wss) return false;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  _getActiveWebUser() {
    if (!this._wss) return 'operator';
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN && client._user) return client._user;
    }
    return 'operator';
  }

  // hasOperatorConnected — true when at least one connected WS client
  // has a creator/admin role (i.e. the actual instance owner viewing the
  // web panel). Used to gate proactive outreach: webapp guests and
  // acorn CLI sessions don't get unsolicited 'thinking out loud'
  // messages, only the operator does.
  hasOperatorConnected() {
    if (!this._wss) return false;
    const WebSocket = require('ws');
    for (const client of this._wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client._role === 'creator' || client._role === 'admin') return true;
    }
    return false;
  }

  getActiveChannelIds() {
    // Only return the web chat channel when an OPERATOR (creator/admin)
    // is currently viewing it. Without this, the proactive maintainer
    // would also fire when only a webapp guest or an acorn CLI client
    // is connected — which is wrong (proactive thoughts should only
    // ever surface to the instance owner).
    if (!this._wss || !this.hasOperatorConnected()) return [];
    return [{ id: 'web:control-panel', name: 'web chat' }];
  }

  /**
   * Returns active user sessions for use by the webapp_request tool.
   * Filters expired sessions and returns user → sessionId mapping.
   */
  getActiveUserSessions() {
    const results = [];
    const now = Date.now();
    for (const [sid, sess] of this._webSessions) {
      if (now - sess.created >= SESSION_TTL) continue;
      results.push({
        sessionId: sid,
        user: sess.user,
        type: sess.type,
        cookieName: sess.type === 'webapp' ? 'spore_webapp' : 'spore_session',
      });
    }
    return results;
  }

  /**
   * Find a valid session ID for a given username.
   * Prefers creator/admin sessions over webapp sessions.
   */
  getSessionForUser(username) {
    const now = Date.now();
    let best = null;
    const priority = { admin: 3, creator: 2, cli: 1, webapp: 0 };
    for (const [sid, sess] of this._webSessions) {
      if (now - sess.created >= SESSION_TTL) continue;
      if (sess.user !== username) continue;
      if (!best || (priority[sess.type] || 0) > (priority[best.type] || 0)) {
        best = { sessionId: sid, user: sess.user, type: sess.type, cookieName: sess.type === 'webapp' ? 'spore_webapp' : 'spore_session' };
      }
    }
    return best;
  }

  /** Returns info about the hosted webapp (if any) for prompt context. */
  getWebappStatus() {
    if (!this._server) return null;
    this._loadServeMounts();
    const port = this._currentWebPort();
    const publicUrl = this._currentPublicBaseUrl();
    const rootUrl = this._currentWebRootUrl();
    const mountName = this._defaultServeMountName();
    const serveUrl = this._serveUrlForMount(mountName);
    const hasBackend = !!this._backendChild;
    return {
      active: true,
      port,
      mount: mountName,
      url: serveUrl ? `${serveUrl}/` : null,
      serveUrl: serveUrl ? `${serveUrl}/` : null,
      rootUrl: rootUrl ? `${rootUrl}/` : '/',
      mounts: [...this._serveMounts.values()].map(m => ({ name: m.name, dir: m.dir, url: `${this._serveUrlForMount(m.name)}/` })),
      publicUrl,
      hasBackend,
      users: this.getActiveUserSessions().map(s => ({ user: s.user, type: s.type })),
    };
  }

  injectProactivePrompt(channelId, context, topic) {
    // Gate: ONLY fire when an operator (creator/admin) is viewing the
    // web panel. Webapp guests and acorn CLI sessions should never
    // see unsolicited proactive thoughts. This also stops the agent
    // from talking to itself when nobody's watching.
    if (!this._wss || !this.hasOperatorConnected()) {
      this.log.debug('[proactive:web] No operator connected, skipping');
      return;
    }

    const agent = this.tools?._agent;
    if (!agent) {
      this.log.debug('[proactive:web] Agent not available, skipping');
      return;
    }

    const prompt = `[proactive thought: ${context}${topic ? ` (topic: ${topic})` : ''}]`;
    const sessionId = channelId || 'web:control-panel';
    const activeUser = this._getActiveWebUser();

    if (!this._proactiveQueue) this._proactiveQueue = Promise.resolve();
    this._proactiveQueue = this._proactiveQueue.then(async () => {
      try {
        // Route every stream event to the target session ONLY, not to
        // every connected WS client. Previously the deltas were
        // broadcast() which leaked them into acorn (and any other
        // viewer of any session) — visible as a stray 'NO_REPLY'
        // bubble in the CLI even though the prompt was never posted
        // to the cli session.
        this._sendToSession(sessionId, { type: 'chat:start', sessionId });
        const result = await this._submitAgentTurn({
          content: prompt,
          channelId: sessionId,
          channelName: 'control-panel',
          userId: activeUser,
          userName: 'System',
          trigger: 'proactive',
          platform: 'web',
          isDm: true,
          suppressLearning: true,
          onTextDelta: (delta) => {
            this._sendToSession(sessionId, { type: 'chat:delta', text: delta });
          },
          onThinkingDelta: (delta) => {
            this._sendToSession(sessionId, { type: 'chat:thinking', text: delta });
          },
          onToolUse: (toolName, toolInput) => {
            this._sendToSession(sessionId, { type: 'chat:tool', tool: toolName, input: toolInput });
          },
          onStatus: (evt) => {
            try {
              if (evt.type?.startsWith('code:')) {
                this._sendToSession(sessionId, evt);
              } else {
                const { type: statusType, ...rest } = evt;
                this._sendToSession(sessionId, { type: 'chat:status', status: statusType, ...rest });
              }
            } catch (e) { this.log.warn('[web] startsWith failed: ' + e.message); }
          },
        }, {
          lane: 'deferred',
          priority: 55,
          route: 'web.proactive',
          allowInterjection: false,
        });

        const text = result?.text;
        if (!text || text.trim() === 'NO_REPLY' || text.includes('NO_REPLY')) {
          this._sendToSession(sessionId, { type: 'chat:done', text: '' });
          this.log.info('[proactive:web] Agent chose NO_REPLY');
          // Clean up: remove the synthetic prompt from the session DB
          // too, so a refresh doesn't replay [proactive thought: ...]
          // followed by an awkward NO_REPLY pair. The operator never
          // saw the conversation; pretend it didn't happen.
          try {
            const sk = this.tools?._sessions?.constructor?.buildKey?.(sessionId, true, activeUser);
            if (sk) {
              this.tools._sessions.removeLastUserMessage(sk);
              this.tools._sessions.removeLastAssistantNoReply?.(sk);
            }
          } catch (e) {
            this.log.debug(`[proactive:web] cleanup failed: ${e.message}`);
          }
        } else {
          this._sendToSession(sessionId, {
            type: 'chat:done',
            text,
            usage: result.usage,
            iterations: result.iterations,
            toolUsage: result.toolUsage,
            responseRepair: result.responseRepair || null,
          });
          this.log.info(`[proactive:web] Delivered proactive message (${(text || '').length} chars)`);

          try {
            const feed = require('../graph/feed');
            feed.log({
              channelName: 'web:proactive',
              userName: 'System',
              userMessage: prompt,
              myResponse: text,
              trigger: 'proactive',
              usage: result.usage,
              iterations: result.iterations,
            });
          } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
        }
      } catch (e) {
        this.log.warn(`[proactive:web] Failed: ${e.message}`);
        this._sendToSession(sessionId, { type: 'chat:done', text: '' });
      }
    }).catch(e => {
      this.log.warn(`[proactive:web] Queue error: ${e.message}`);
    });
  }

  async _isOAuthEnabled() {
    if (Date.now() - (this._oauthCheckedAt || 0) < 300_000) return this._oauthEnabled || false;
    if (!this.config.managerUrl) return false;
    try {
      const resp = await fetch(`${this.config.managerUrl}/api/auth/google/status`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      this._oauthEnabled = !!data.enabled;
    } catch {
      if (this._oauthEnabled === undefined) this._oauthEnabled = false;
    }
    this._oauthCheckedAt = Date.now();
    return this._oauthEnabled;
  }

  async handleHttp(req, res) {
    return false;
  }

  // ── Status / Stop ──────────────────────────────────────────────────

  _status(opts = {}) {
    this._loadServeMounts();
    const webPort = this._currentWebPort();
    const pub = this._currentPublicBaseUrl();
    const rootUrl = this._currentWebRootUrl();
    const mountName = this._safeServeMountName(opts.name || opts.mount || opts.slug) || this._defaultServeMountName();
    const serveUrl = this._serveUrlForMount(mountName);
    if (this._server) {
      const result = {
        running: true,
        port: webPort,
        dir: this._serverDir,
        mount: mountName,
        url: serveUrl ? `${serveUrl}/` : null,
        serveUrl: serveUrl ? `${serveUrl}/` : null,
        rootUrl: rootUrl ? `${rootUrl}/` : '/',
        graphEditor: rootUrl ? `${rootUrl}/graph` : '/graph',
        publicUrl: pub || null,
        mounts: [...this._serveMounts.values()].map(m => ({ name: m.name, dir: m.dir, url: `${this._serveUrlForMount(m.name)}/` })),
        note: serveUrl ? `Served app URL: ${serveUrl}/` : undefined,
      };
      if (this._backendChild) {
        result.backend = { running: true, port: this._backendPort, pid: this._backendChild.pid };
      }
      return result;
    }
    return { running: false, port: webPort || null, note: webPort ? 'Server is not running. Use action:start to launch it.' : 'No web port configured. Set SPORE_WEB_PORT and re-deploy.' };
  }

  _stop() {
    this._stopBackendProcess();
    try { fs.unlinkSync(path.join(this.config.dataDir, '.backend-config.json')); } catch { /* silent: best-effort cleanup */ }
    if (!this._server) return { stopped: false, note: 'Server was not running.' };
    if (this._wss) { this._wss.close(); this._wss = null; }
    this._server.close();
    this._server = null;
    this._serverDir = null;
    this.log.info('[web_serve] Server stopped');
    return { stopped: true };
  }

  // ── Backend Process Management ─────────────────────────────────────

  _stopBackendProcess() {
    if (this._backendChild) {
      try { process.kill(-this._backendChild.pid, 'SIGTERM'); } catch { /* silent: best-effort terminate */ }
      try { this._backendChild.kill('SIGTERM'); } catch (e) { this.log.warn('[web] this._backendChild.kill failed: ' + e.message); }
      this._backendChild = null;
      this._backendPort = null;
      this.log.info('[web_serve] Backend process killed');
    }
    // Also kill anything on the .app-port
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try {
      const port = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10);
      if (port > 0) this._killProcessOnPort(port);
      fs.unlinkSync(appPortFile);
    } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
  }

  _killProcessOnPort(port) {
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          const p = parseInt(pid.trim(), 10);
          if (p > 0 && p !== process.pid) {
            try { process.kill(p, 'SIGTERM'); } catch { /* silent: best-effort terminate */ }
          }
        }
      }
    } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
  }

  _allocateBackendPort() {
    const webPort = this._currentWebPort() || 18815;
    return webPort + 100;
  }

  _fetchVaultKeys() {
    const managerUrl = this.config.managerUrl || 'http://spore-manager:18900';
    const serviceKey = this.config.managerServiceKey || '';
    const agentId = this.config.agentId || 'unknown';
    const env = {};
    try {
      const { execSync } = require('child_process');
      const result = execSync(
        `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-SPORE-Id: ${agentId}" "${managerUrl}/api/vault/keys" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const rawKeys = JSON.parse(result).keys || [];
      const keyNames = rawKeys.map(k => typeof k === 'string' ? k : k.name).filter(Boolean);
      for (const keyName of keyNames) {
        try {
          const val = execSync(
            `curl -sf -H "X-Service-Key: ${serviceKey}" -H "X-SPORE-Id: ${agentId}" "${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}" 2>/dev/null`,
            { encoding: 'utf8', timeout: 5000 }
          );
          const parsed = JSON.parse(val);
          if (parsed.value) env[keyName] = parsed.value;
	        } catch (e) { this.log.warn('[web] execSync failed: ' + _redactSecrets(e.message)); }
	      }
	    } catch (e) {
	      this.log.warn(`[backend] Failed to fetch vault keys: ${_redactSecrets(e.message)}`);
	    }
    return env;
  }

  _startWithBackend(dir, { command, commandDir, name, mount, slug, app, appName } = {}) {
    if (!command) return { error: 'command is required for action:"backend". Provide the command to start your backend (e.g. "node server.js").' };

    // Start the web server for static files
    const serveDir = this._normalizeServeDir(dir);
    const startResult = this._start(serveDir, { name, mount, slug, app, appName });
    if (startResult.error) return startResult;

    const backendPort = this._allocateBackendPort();
    const workDir = commandDir || serveDir;

    // Kill any stale backend
    this._stopBackendProcess();
    this._killProcessOnPort(backendPort);

    // Write .app-port before spawning so the proxy is ready
    const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
    try { fs.writeFileSync(appPortFile, String(backendPort)); } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    // Auto-inject vault keys into the backend process env
    const vaultKeys = this._fetchVaultKeys();
    const vaultKeyNames = Object.keys(vaultKeys);

    // Build env: base process env + allocated port + vault keys
    const { spawn } = require('child_process');
    const SENSITIVE_RE = /KEY|TOKEN|SECRET|PASS|CREDENTIALS|AUTH/i;
    const baseEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!SENSITIVE_RE.test(k)) baseEnv[k] = v;
    }
    const env = {
      ...baseEnv,
      APP_PORT: String(backendPort),
      PORT: String(backendPort),
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...vaultKeys,
    };

    const child = spawn('sh', ['-c', command], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const childPid = child.pid;
    let lastStdout = '';
    let lastStderr = '';
	    child.stdout?.on('data', (d) => {
	      lastStdout = _redactSecrets(d.toString().slice(-500));
	      this.log.debug(`[backend:stdout] ${lastStdout.trim()}`);
	    });
	    child.stderr?.on('data', (d) => {
	      lastStderr = _redactSecrets(d.toString().slice(-500));
	      this.log.debug(`[backend:stderr] ${lastStderr.trim()}`);
    });

    child.on('exit', (code, signal) => {
      if (this._backendChild === child) {
        this.log.warn(`[backend] Process exited unexpectedly: code=${code} signal=${signal}`);
        this._backendChild = null;
        this._backendPort = null;
      }
    });

    child.unref();
    this._backendChild = child;
    this._backendPort = backendPort;

    // Register with global process tracker if available
    if (this._tools?._trackedPids) this._tools._trackedPids.add(child.pid);

    // Persist backend config so it auto-restores on container restart
    try {
      fs.writeFileSync(path.join(this.config.dataDir, '.backend-config.json'), JSON.stringify({
        dir: serveDir, command, commandDir: workDir,
      }));
    } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    const webPort = this._currentWebPort();
    const pubUrl = this._currentPublicBaseUrl();
    const displayUrl = startResult.serveUrl || startResult.url || (pubUrl ? `${pubUrl}/serve/${startResult.mount}/` : `/serve/${startResult.mount}/`);

	    this.log.info(`[backend] Started (pid=${childPid}, port=${backendPort}), ${vaultKeyNames.length} vault key(s) injected`);

    return {
      started: true,
      port: webPort,
      backendPort,
      pid: childPid,
      dir: serveDir,
      mount: startResult.mount || null,
      commandDir: workDir,
      command,
      url: displayUrl,
      serveUrl: displayUrl,
      rootUrl: startResult.rootUrl || (pubUrl ? `${pubUrl}/` : '/'),
      graphEditor: startResult.graphEditor || (pubUrl ? `${pubUrl}/graph` : '/graph'),
      publicUrl: pubUrl || null,
      mounts: startResult.mounts || [],
	      vaultKeysInjected: vaultKeyNames.map(() => '[redacted]'),
	      vaultKeysInjectedCount: vaultKeyNames.length,
      routing: {
        note: 'Traefik strips the path prefix before requests reach your server. Your backend sees paths relative to root.',
        externalBase: displayUrl,
        internalBackendPort: backendPort,
        frontendFetchPattern: `Your frontend HTML is served under ${displayUrl}. Use RELATIVE fetch paths: fetch('api/generate') or fetch('./api/generate'). The web server proxies /api/* to your backend. For non-/api/ routes, any path that doesn't match a static file is also proxied to the backend.`,
        backendRoutes: `Your backend receives requests with the prefix ALREADY STRIPPED. If your HTML is at ${displayUrl}, the backend sees app-relative paths. Match routes like: /api/endpoint or app-specific endpoints you link with relative URLs.`,
        vaultKeys: vaultKeyNames.length ? `These vault keys were auto-injected as env vars in your backend process: ${vaultKeyNames.join(', ')}. Access them with process.env.KEY_NAME — no need to use vault_get.` : 'No vault keys found. Add keys via the manager vault UI.',
      },
    };
  }

  // ── Start (HTTP server + all routes) ───────────────────────────────

  _start(dir, opts = {}) {
    const webPort = this._currentWebPort();
    if (!webPort) return { error: 'No web port configured. Set SPORE_WEB_PORT in .env and re-deploy the container.' };
    const serveDir_ = this._normalizeServeDir(dir);
    const mountName = this._resolveServeMountName(opts, serveDir_);
    if (this._server) {
      const mounted = this._registerServeMount(mountName, serveDir_);
      this.log.info(`[web_serve] Server already running; mounted ${serveDir_} at /serve/${mounted}/`);
      return {
        ...this._status({ name: mounted }),
        started: false,
        dir: serveDir_,
        mount: mounted,
        note: `Server already active — mounted app at ${this._serveUrlForMount(mounted)}/.`,
      };
    }

    const serveDir = serveDir_;
    try { fs.mkdirSync(serveDir, { recursive: true }); } catch (e) { this.log.warn('[web] fs.mkdirSync failed: ' + e.message); }

    const indexPath = path.join(serveDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const name = this.config.displayName || this.config.agentId || 'Spore Core';
      fs.writeFileSync(indexPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif}h1{font-size:2.5rem;opacity:.8}</style></head><body><h1>${name}</h1></body></html>`);
    }

    const MIME = {
      '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
      '.woff2': 'font/woff2', '.woff': 'font/woff',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.webp': 'image/webp', '.avif': 'image/avif',
      '.pdf': 'application/pdf',
      '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
    };

    function parseMultipart(buf, boundary, destDir, maxFileSize) {
      const sep = Buffer.from('--' + boundary);
      const saved = [];
      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const next = buf.indexOf(sep, start + sep.length);
        if (next === -1) break;
        const part = buf.slice(start + sep.length, next);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { pos = next; continue; }
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        if (!fnMatch) { pos = next; continue; }
        let fileName = fnMatch[1].replace(/[/\\]/g, '_').replace(/\.\./g, '');
        if (!fileName) { pos = next; continue; }
        let body = part.slice(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
          body = body.slice(0, body.length - 2);
        }
        if (body.length > maxFileSize) throw new Error(`File "${fileName}" exceeds size limit`);
        const dest = path.join(destDir, fileName);
        if (!dest.startsWith(destDir)) throw new Error('Invalid path');
        fs.writeFileSync(dest, body);
        saved.push(fileName);
        pos = next;
      }
      return saved;
    }

    const authUser = this.config.webAuthUser;
    const authPass = this.config.webAuthPass;
    const graphDb = this.graph?.db;

    const _sessions = this._webSessions;

    const LOGIN_MAX_ATTEMPTS = 5;
    const LOGIN_WINDOW_MS = 15 * 60 * 1000;
    const loginRateLimiter = createLoginRateLimiter({
      maxAttempts: LOGIN_MAX_ATTEMPTS,
      windowMs: LOGIN_WINDOW_MS,
    });

    const _clientIpForRateLimit = (req) => {
      const remote = req.socket.remoteAddress || 'unknown';
      const trustedProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || process.env.SPORE_TRUST_PROXY === 'true';
      return trustedProxy
        ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || remote)
        : remote;
    };

    const _checkLoginRate = (req) => {
      const ip = _clientIpForRateLimit(req);
      return !loginRateLimiter.isLimited(ip);
    };

    const _recordFailedLoginAttempt = (req) => {
      const ip = _clientIpForRateLimit(req);
      return loginRateLimiter.recordFailure(ip);
    };

    const _clearLoginAttempts = (req) => {
      loginRateLimiter.clear(_clientIpForRateLimit(req));
    };

    const _loginRateLimitHeaders = (req) => {
      const retryAfter = Math.ceil(loginRateLimiter.retryAfterMs(_clientIpForRateLimit(req)) / 1000);
      return retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {};
    };

    const _writeLoginRateLimited = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', ..._loginRateLimitHeaders(req) });
      res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
    };

    const _writeFailedLoginOrRateLimit = (req, res, status = 401, error = 'Invalid credentials') => {
      if (!_checkLoginRate(req)) {
        _writeLoginRateLimited(req, res);
        return;
      }
      _recordFailedLoginAttempt(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };

    const _closeSocketsForAuthSession = (sid, reason = 'session-ended') => {
      if (!sid || !this._wss) return 0;
      let closed = 0;
      for (const client of this._wss.clients || []) {
        if (client._role === 'cli') continue;
        if (client._sourceSession !== sid) continue;
        try {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'auth:error',
              error: 'Session ended. Please log in again.',
              code: reason,
            }));
          }
          client.close(4001, 'session ended');
          closed++;
        } catch (e) {
          this.log.warn('[web] Failed to close stale auth websocket: ' + e.message);
        }
      }
      return closed;
    };

    const _deleteAuthSession = (sid, reason = 'session-ended') => {
      if (!sid || !_sessions.has(sid)) return false;
      _sessions.delete(sid);
      _closeSocketsForAuthSession(sid, reason);
      return true;
    };

    const _sessionSweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, sess] of _sessions) {
        if (now - sess.created >= SESSION_TTL) _deleteAuthSession(sid, 'session-expired');
      }
      loginRateLimiter.sweep();
    }, 60 * 60 * 1000);
    _sessionSweepInterval.unref();

    const parseCookies = (req) => {
      const obj = {};
      (req.headers.cookie || '').split(';').forEach(c => {
        const [k, ...v] = c.trim().split('=');
        if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
      });
      return obj;
    };
    const isLocalRequest = (req) => {
      const addr = String(req.socket?.remoteAddress || '');
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    };

    const managerUrl = process.env.MANAGER_URL;
    const managerKey = process.env.MANAGER_SERVICE_KEY;
    const sporeId = this.config.agentId;
    const cookieSecureAttr = (req) => {
      if (process.env.SPORE_INSECURE_COOKIES === 'true') return '';
      if (process.env.SPORE_SECURE_COOKIES === 'true') return '; Secure';
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
      return (req.socket?.encrypted || forwardedProto === 'https') ? '; Secure' : '';
    };

    const tryManagerSSO = async (req, res, { webappOnly = false } = {}) => {
      if (!managerUrl || !managerKey) return false;
      const cookies = parseCookies(req);
      const mgrToken = cookies['manager_session'];
      if (!mgrToken) return false;
      try {
	        const payload = JSON.stringify({ token: mgrToken, sporeId, webappOnly });
	        const url = new URL(managerUrl + '/api/auth/verify-session');
	        const http_ = url.protocol === 'https:' ? require('https') : require('http');
        const result = await new Promise((resolve, reject) => {
          const r = http_.request({
            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-service-key': managerKey, 'Content-Length': Buffer.byteLength(payload) },
            timeout: 3000,
          }, (resp) => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
          });
          r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          r.end(payload);
        });
        if (result.ok && result.username) {
          const sid = crypto.randomBytes(32).toString('hex');
          if (webappOnly) {
            _sessions.set(sid, { type: 'webapp', created: Date.now(), user: result.username, viaSSO: true });
            const secure = cookieSecureAttr(req);
            res.setHeader('Set-Cookie', `spore_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
            return 'webapp';
          }
          const mgrRole = result.role === 'super' ? 'admin' : 'creator';
          _sessions.set(sid, { type: mgrRole, created: Date.now(), user: result.username, viaSSO: true });
          const secure = cookieSecureAttr(req);
          res.setHeader('Set-Cookie', `spore_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`);
          return mgrRole;
        }
      } catch (err) {
        this.log.warn(`[webapp-gate] SSO verify failed: ${err.message}`);
      }
      return false;
    };

    const WEBAPP_USERS_PATH = path.join(this.config.dataDir, 'webapp-users.json');
    const loadWebappUsers = () => {
      try { return JSON.parse(fs.readFileSync(WEBAPP_USERS_PATH, 'utf8')); } catch { return []; }
    };
    const ensureWebUserGraph = (username, meta = {}) => {
      const clean = String(username || '').trim();
      if (!clean) return null;
      const userPart = _safeGraphUserPart(clean);
      if (!userPart) return null;
      const registry = this.tools?._graphRegistry;
      if (!registry?.ensureUserGraph) return null;
      try {
        return registry.ensureUserGraph(`web-user:${userPart}`, {
          name: `${clean} Memory`,
          description: `Private web memory for ${clean}`,
          source: 'webapp',
          createdBy: 'webapp',
          owner: clean,
          createdFor: clean,
          webappUser: clean,
          username: clean,
          userId: clean,
          ...meta,
        });
      } catch (e) {
        this.log.warn?.(`[web] Failed to ensure user graph for ${clean}: ${e.message}`);
        return null;
      }
    };
    const ensureWebUserGraphForRecord = (record, meta = {}) => {
      if (!record?.username) return null;
      if ((record.role || 'webapp') !== 'webapp') return record.userGraphSlug || null;
      return ensureWebUserGraph(record.username, meta);
    };
    const ensureAndPersistWebUserGraph = (username, meta = {}) => {
      const users = loadWebappUsers();
      const idx = users.findIndex(u => u?.username === username);
      if (idx < 0 || (users[idx].role || 'webapp') !== 'webapp') return null;
      const slug = ensureWebUserGraphForRecord(users[idx], meta);
      if (slug && users[idx].userGraphSlug !== slug) {
        users[idx].userGraphSlug = slug;
        _writeJsonAtomic(WEBAPP_USERS_PATH, users);
      }
      return slug;
    };
    const verifyWebappPassword = (password, salt, storedHash) => {
      const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      if (computed.length !== storedHash.length) return false;
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
    };

    const checkWebappAuthSync = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['spore_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.type === 'creator' && Date.now() - sess.created < SESSION_TTL) return true;
      }
      const wsid = cookies['spore_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (sess.type === 'webapp' && Date.now() - sess.created < SESSION_TTL) return true;
        if (sess.type === 'webapp') _deleteAuthSession(wsid, 'session-expired');
      }
      return false;
    };

    const checkWebappAuth = async (req, res) => {
      if (checkWebappAuthSync(req)) return true;
      if (await tryManagerSSO(req, res)) return true;
      const wUsers = loadWebappUsers();
      const needsCreatorAuth = !!(managerUrl || (authUser && authPass));
      if (wUsers.length === 0 && !needsCreatorAuth) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return false;
    };

    const isAnyAuth = (req) => {
      const cookies = parseCookies(req);
      const csid = cookies['spore_session'];
      if (csid && _sessions.has(csid)) {
        const sess = _sessions.get(csid);
        if (sess.viaSSO && !cookies['manager_session']) { _deleteAuthSession(csid, 'sso-session-ended'); }
        else if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      const wsid = cookies['spore_webapp'];
      if (wsid && _sessions.has(wsid)) {
        const sess = _sessions.get(wsid);
        if (Date.now() - sess.created < SESSION_TTL) return sess.type;
      }
      return null;
    };


    const authPolicy = createWebAuthPolicy({
      managerKey,
      authUser,
      authPass,
      sessions: _sessions,
      sessionTtl: SESSION_TTL,
      loadWebappUsers,
      deps: { now: () => Date.now() },
    });
    const checkCreatorAuth = (req, res) => authPolicy.checkCreatorAuth(req, res);
    const checkCreatorAuthAsync = async (req, res) => {
      if (checkCreatorAuth(req, res)) return true;
      if (await tryManagerSSO(req, res)) return true;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Creator authentication required' }));
      return false;
    };
    const checkAuth = (req, res) => checkCreatorAuthAsync(req, res);
    const getSessionFromReq = req => authPolicy.getSessionFromReq(req);
    const authContextFromReq = req => authPolicy.authContextFromReq(req);

    const requireGraphApiAuth = async (req, res) => {
      let authContext = authContextFromReq(req);
      if (authContext) return authContext;
      const ssoRole = await tryManagerSSO(req, res).catch(() => false);
      if (ssoRole) {
        authContext = authContextFromReq(req);
        if (authContext) return authContext;
        return {
          type: ssoRole,
          role: ssoRole,
          user: null,
          username: null,
          creator: ssoRole === 'creator' || ssoRole === 'admin',
        };
      }
      const webappSsoRole = await tryManagerSSO(req, res, { webappOnly: true }).catch(() => false);
      if (webappSsoRole) {
        authContext = authContextFromReq(req);
        if (authContext) return authContext;
        return { type: 'webapp', role: 'webapp', user: null, username: null, creator: false };
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return null;
    };

    const server = http.createServer(async (req, res) => {
      const urlPath = req.url.split('?')[0];

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      if (req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      const origin = req.headers.origin || '';
      let isTrustedOrigin = false;
      try {
        if (origin) {
          const oh = new URL(origin).hostname;
          isTrustedOrigin = oh === 'localhost' || oh === '127.0.0.1' || oh === '::1';
        }
      } catch (e) { this.log.warn('[web] URL failed: ' + e.message); }
      const ingressDomain = this.config.ingressDomain;
      let matchesIngress = false;
      if (ingressDomain && origin) {
        try { matchesIngress = new URL(origin).hostname === ingressDomain; } catch (e) { this.log.warn('[web] URL failed: ' + e.message); }
      }
      const allowedOrigin = (isTrustedOrigin || matchesIngress) ? origin : '';
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // ── Creator auth endpoints (graph viewer SSO via manager) ──
      if (urlPath === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          try {
            const { username, password } = JSON.parse(body);
            const serviceKey = managerKey;
            let verified = false;
            let verifiedUser = username;

            if (managerUrl && serviceKey) {
              try {
                const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
                const payload = JSON.stringify({ username, password, sporeId });
                const result = await new Promise((resolve, reject) => {
                  const url = new URL(managerUrl + '/api/auth/verify-access');
                  const opts = {
                    method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
                    headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey, 'Content-Length': Buffer.byteLength(payload) },
                    timeout: 5000
                  };
                  const r = http_.request(opts, (resp) => {
                    let d = ''; resp.on('data', c => d += c);
                    resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(d) }); } catch { reject(new Error('Bad response')); } });
                  });
                  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
                  r.write(payload); r.end();
                });
                if (result.status === 200 && result.body.ok) {
                  verified = true;
                  verifiedUser = result.body.username || username;
                  req._mgrRole = result.body.role;
                } else {
                  _writeFailedLoginOrRateLimit(req, res, result.status || 401, result.body?.error || 'Invalid credentials'); return;
                }
              } catch (e) {
                this.log.warn('[web] Manager SSO unreachable, falling back to local auth:', e.message);
                // Prefer webapp-users.json local record (populated by the
                // onboarding wizard) when the manager is down.
                const wu = loadWebappUsers().find(u => u.username === username);
                if (wu && !wu.blocked && verifyWebappPassword(password, wu.salt, wu.hash)) {
                  verified = true;
                  verifiedUser = username;
                  if (wu.role === 'webapp') req._loginRoleHint = 'webapp';
                } else if (authUser && authPass && username === authUser && password === authPass) {
                  verified = true;
                } else {
                  _writeFailedLoginOrRateLimit(req, res); return;
                }
              }
            } else if (authUser && authPass && username === authUser && password === authPass) {
              verified = true;
            } else {
              // Local webapp-users.json (populated by the onboarding wizard or
              // self-registered via /api/webapp/users/self-register).
              const webappUsers = loadWebappUsers();
              const wu = webappUsers.find(u => u.username === username);
              if (wu && wu.blocked) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Your account has been blocked. Contact the operator.' })); return;
              }
              if (wu && verifyWebappPassword(password, wu.salt, wu.hash)) {
                verified = true;
                verifiedUser = username;
                // Honor stored role: creator → loginRole 'creator', webapp → 'webapp'.
                if (wu.role === 'webapp') req._loginRoleHint = 'webapp';
              } else if (authUser && authPass) {
                _writeFailedLoginOrRateLimit(req, res); return;
              } else if (webappUsers.length === 0) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Auth not configured' })); return;
              } else {
                _writeFailedLoginOrRateLimit(req, res); return;
              }
            }

            if (verified) {
              _clearLoginAttempts(req);
              const sid = crypto.randomBytes(32).toString('hex');
              let loginRole;
              if (req._loginRoleHint === 'webapp') loginRole = 'webapp';
              else loginRole = req._mgrRole === 'super' ? 'admin' : 'creator';
              const cookieName = loginRole === 'webapp' ? 'spore_webapp' : 'spore_session';
              const otherCookieName = cookieName === 'spore_session' ? 'spore_webapp' : 'spore_session';
              const priorCookies = parseCookies(req);
              for (const staleCookieName of [cookieName, otherCookieName]) {
                const staleSid = priorCookies[staleCookieName];
                if (staleSid) _deleteAuthSession(staleSid, 'session-replaced');
              }
              const userGraphSlug = loginRole === 'webapp'
                ? ensureAndPersistWebUserGraph(verifiedUser, { reason: 'auth-login' })
                : null;
              _sessions.set(sid, { user: verifiedUser, created: Date.now(), type: loginRole });
              const secure = cookieSecureAttr(req);
              // Webapp users haven't run the user wizard yet → flag it.
              let wizardNeeded = false;
              if (loginRole === 'webapp') {
                try {
                  const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
                  wizardNeeded = !prefs[verifiedUser]?.wizardCompleted;
                } catch { wizardNeeded = true; }
              }
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': [
                  `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
                  `${otherCookieName}=; Path=/; HttpOnly; Max-Age=0`,
                ],
              });
              res.end(JSON.stringify({ ok: true, user: verifiedUser, role: loginRole, wizardNeeded, userGraphSlug }));
            }
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/auth/logout' && req.method === 'POST') {
        const sid = getSessionFromReq(req);
        if (sid) _deleteAuthSession(sid, 'logout');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'spore_session=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/auth/check') {
        let valid = false;
        let role = null;
        let username = null;
        const cookies = parseCookies(req);
        const sid = cookies['spore_session'];
        const sess = sid && _sessions.get(sid);
        if (sess && (sess.type === 'creator' || sess.type === 'admin') && (Date.now() - sess.created < SESSION_TTL)) {
          valid = true;
          role = sess.type;
          username = sess.user || null;
        }
        if (!valid) {
          const wsid = cookies['spore_webapp'];
          const wsess = wsid && _sessions.get(wsid);
          if (wsess && wsess.type === 'webapp' && (Date.now() - wsess.created < SESSION_TTL)) {
            valid = true;
            role = 'webapp';
            username = wsess.user || null;
          }
        }
        if (!valid) {
          const ssoRole = await tryManagerSSO(req, res);
          if (ssoRole) { valid = true; role = ssoRole; }
        }
        const hasWebappUsers = loadWebappUsers().length > 0;
        const needsAuth = !!(managerUrl || (authUser && authPass) || hasWebappUsers);
        // wizardNeeded: true if the authenticated user hasn't completed the
        // per-user onboarding wizard yet. Drives the slim post-login wizard
        // that the SPA runs when a fresh webapp user first lands on /graph.
        let wizardNeeded = false;
        if (valid && username && (role === 'webapp' || role === 'creator')) {
          try {
            const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
            wizardNeeded = !prefs[username]?.wizardCompleted;
          } catch { wizardNeeded = role === 'webapp'; }
        }
        const userGraphSlug = valid && role === 'webapp' && username
          ? ensureAndPersistWebUserGraph(username, { reason: 'auth-check' })
          : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: valid, needsAuth, role, hasWebappUsers, username, wizardNeeded, userGraphSlug }));
        return;
      }

      // ── Webapp user auth endpoints ──
      if (urlPath === '/api/webapp/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const { username, password } = JSON.parse(body);
            const users = loadWebappUsers();
            if (users.length === 0) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, user: 'guest', noAuth: true })); return;
            }
            const user = users.find(u => u.username === username);
            if (user?.blocked) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Your account has been blocked. Contact the operator.' })); return;
            }
            if (!user || !verifyWebappPassword(password, user.salt, user.hash)) {
              _writeFailedLoginOrRateLimit(req, res); return;
            }
            _clearLoginAttempts(req);
            const sid = crypto.randomBytes(32).toString('hex');
            const role = user.role === 'creator' ? 'creator' : 'webapp';
            const cookieName = role === 'creator' ? 'spore_session' : 'spore_webapp';
            const otherCookieName = cookieName === 'spore_session' ? 'spore_webapp' : 'spore_session';
            const userGraphSlug = role === 'webapp'
              ? ensureAndPersistWebUserGraph(username, { reason: 'webapp-login' })
              : null;
            // Invalidate any lingering session under the other cookie so a user
            // logging in as webapp can't inherit a previous creator identity
            // (which would route chats into the wrong dm:<user> session and
            // show the other user's history).
            const otherCookies = parseCookies(req);
            for (const staleCookieName of [cookieName, otherCookieName]) {
              const staleSid = otherCookies[staleCookieName];
              if (staleSid) _deleteAuthSession(staleSid, 'session-replaced');
            }
            _sessions.set(sid, { user: username, created: Date.now(), type: role });
            const secure = cookieSecureAttr(req);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': [
                `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
                `${otherCookieName}=; Path=/; HttpOnly; Max-Age=0`,
              ],
            });
            res.end(JSON.stringify({ ok: true, user: username, role, userGraphSlug }));
          } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad request' })); }
        });
        return;
      }

      if (urlPath === '/api/webapp/logout' && req.method === 'POST') {
        const cookies = parseCookies(req);
        const wsid = cookies['spore_webapp'];
        if (wsid) _deleteAuthSession(wsid, 'logout');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'spore_webapp=; Path=/; HttpOnly; Max-Age=0',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/webapp/check') {
        const wUsers = loadWebappUsers();
        let authType = isAnyAuth(req);
        if (!authType && await tryManagerSSO(req, res)) authType = 'creator';
        const needsAuth = wUsers.length > 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: !!authType, needsAuth, userType: authType }));
        return;
      }

      // ── First-run onboarding ──
      // Plugin discovery for the wizard. Public, gated on whether the
      // operator has EXPLICITLY completed the wizard (prefs.onboardingCompletedAt
      // is set only by /api/onboarding/complete, not by the auto-backfill
      // heuristic in _isOnboardingNeeded). Without this distinction, the
      // auto-backfill flagging onboardingCompleted=true mid-wizard (the
      // moment the operator created their account + had a provider in env)
      // would 403 the live wizard out of its own data.
      if (urlPath === '/api/onboarding/plugins' && req.method === 'GET') {
        let explicitlyComplete = false;
        try {
          const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
          explicitlyComplete = !!prefs.onboardingCompletedAt;
        } catch { /* silent: missing/malformed → wizard still in progress */ }
        if (explicitlyComplete) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Onboarding already complete' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        const available = mgr.listAvailable?.() || [];
        const panes = mgr.getSettingsPanes?.() || [];
        const panesById = Object.fromEntries(panes.map(p => [p.pluginId, p]));
        // Provider plugins are tagged so the wizard's provider tile
        // picker (step 'pp') can build itself dynamically — no more
        // hardcoded OB_PROVIDERS / OB_PROVIDER_PLUGIN_MAP. The block
        // carries everything the wizard needs: provider name (which
        // becomes the tile id), label (display), defaultBaseUrl
        // (placeholder), capabilities (informational).
        const providers = mgr.getProviders?.() || [];
        const providerByPluginId = new Map();
        for (const pr of providers) providerByPluginId.set(pr.pluginId, pr);
        // Plugins preselected in the onboarding wizard. The operator
        // can still toggle off, but the defaults reflect "what most
        // people want": persistent agent memory, code support, local
        // semantic search, and a working browser tool. STT (whisper)
        // is dropped from recommended — it's a niche capability and
        // adds the model-download cost on first launch; operators
        // who want voice input can opt in. Browser-core + zendriver
        // are recommended together so the browser tool is wired and
        // routes to a stealth backend by default.
        const RECOMMENDED_ON = new Set([
          'session-graph', 'spore-code', 'embedder-gemma',
          'browser-core', 'zendriver', 'ssh-sidecar',
        ]);
        const enriched = available.map(p => {
          const pr = providerByPluginId.get(p.id);
          return {
            ...p,
            recommended: RECOMMENDED_ON.has(p.id),
            pane: panesById[p.id] || null,
            provider: pr ? {
              name: pr.name,
              label: pr.label || pr.name,
              defaultBaseUrl: pr.defaultBaseUrl || null,
              capabilities: pr.capabilities || {},
              modelsPlaceholder: pr.modelsPlaceholder || '',
            } : null,
          };
        });
        // Model tier list, registry-driven so adding a tier is a
        // one-line change in defs.core.js. The wizard groups by
        // tierKind ('main' = casual/normal/planner/etc.; 'vlm' =
        // imageVlm/videoVlm/audioVlm).
        const settings = require('../settings');
        const modelTiers = { main: [], vlm: [] };
        for (const def of settings.listByGroup('models')) {
          if (!def.scope.includes('wizard')) continue;
          const kind = def.tierKind || 'main';
          // Strip the 'models.' prefix so the wizard sees plain tier
          // ids ('casual', 'imageVlm', …) — matches the existing
          // payload shape (body.models[<tier>]).
          const id = def.key.replace(/^models\./, '');
          (modelTiers[kind] || (modelTiers[kind] = [])).push({
            id, label: def.label || id,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plugins: enriched, modelTiers }));
        return;
      }

      if (urlPath === '/api/onboarding/state' && req.method === 'GET') {
        const needed = _isOnboardingNeeded(this.config.dataDir, this.config);
        const hasWebappUsers = loadWebappUsers().length > 0;
        const s = this._getSettingsState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          needed,
          hasWebappUsers,
          currentState: {
            identity: s.identity,
            providers: {
              anthropic: { apiKeySet: s.providers.anthropic.apiKeySet },
              openai: { apiKeySet: s.providers.openai.apiKeySet, baseUrl: s.providers.openai.baseUrl },
              openrouter: { apiKeySet: s.providers.openrouter.apiKeySet, baseUrl: s.providers.openrouter.baseUrl },
              local: { apiKeySet: s.providers.local.apiKeySet, baseUrl: s.providers.local.baseUrl },
              custom: s.providers.custom.map(p => ({ name: p.name, url: p.url })),
            },
            models: s.models,
            embeddings: s.embeddings,
            voice: s.voice,
            webSearch: { searxngUrl: s.webSearch?.searxngUrl || '', braveApiKeySet: !!s.webSearch?.braveApiKeySet },
            browser: s.browser,
          },
        }));
        return;
      }

      if (urlPath === '/api/webapp/users' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const username = String(parsed.username || '').trim();
        const password = String(parsed.password || '');
        if (!username || username.length > 64) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Username must be 1–64 chars' })); return; }
        if (password.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Password must be at least 8 characters' })); return; }
        const existing = loadWebappUsers();
        const onboardingDone = !_isOnboardingNeeded(this.config.dataDir, this.config);
        const isAdmin = !!isAnyAuth(req);
        // Allow user creation when: onboarding still pending (zero users), OR caller is an admin.
        if (existing.length > 0 && onboardingDone && !isAdmin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User creation disabled post-setup' }));
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        // During onboarding, account creation is idempotent: the operator can
        // restart the wizard at any time and re-submit credentials. The user
        // list is reset to just this account. After onboarding completes,
        // duplicate usernames are rejected.
        let next;
        if (!onboardingDone) {
          next = [{ username, hash, salt, created: Date.now(), role: 'creator' }];
        } else {
          if (existing.some(u => u.username === username)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User already exists' })); return;
          }
          const userGraphSlug = ensureWebUserGraph(username, { reason: 'created-by-creator' });
          const record = { username, hash, salt, created: Date.now(), role: 'webapp' };
          if (userGraphSlug) record.userGraphSlug = userGraphSlug;
          next = existing.concat([record]);
        }
        _writeJsonAtomic(WEBAPP_USERS_PATH, next);
        const isFirstUser = !onboardingDone;
        const sid = crypto.randomBytes(32).toString('hex');
        const sessType = isFirstUser ? 'creator' : 'webapp';
        const cookieName = isFirstUser ? 'spore_session' : 'spore_webapp';
        const otherCookieName = cookieName === 'spore_session' ? 'spore_webapp' : 'spore_session';
        const otherCookies = parseCookies(req);
        const otherSid = otherCookies[otherCookieName];
        if (otherSid) _deleteAuthSession(otherSid, 'session-replaced');
        _sessions.set(sid, { user: username, created: Date.now(), type: sessType });
        const secure = cookieSecureAttr(req);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            `${otherCookieName}=; Path=/; HttpOnly; Max-Age=0`,
          ],
        });
        res.end(JSON.stringify({ ok: true, user: username, role: sessType, userGraphSlug: sessType === 'webapp' ? next.find(u => u.username === username)?.userGraphSlug || null : null }));
        return;
      }

      // Self-register: anyone with the SPORE invite key can create a
      // webapp user without operator intervention. Always issues a
      // 'webapp' role session (never creator). When config.inviteKey
      // is empty, self-register is disabled (503).
      if (urlPath === '/api/webapp/users/self-register' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const username = String(parsed.username || '').trim();
        const password = String(parsed.password || '');
        if (!this.config.inviteKey) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Self-registration is not enabled on this instance.' })); return;
        }
        // Accept inviteKey (direct field name) or teamKey (older login UI).
        const typedKey = String(parsed.inviteKey || parsed.teamKey || '').trim();
        if (!_inviteKeyMatches(typedKey, this.config.inviteKey)) {
          _writeFailedLoginOrRateLimit(req, res, 401, 'Invalid invite key'); return;
        }
        if (!username || username.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(username)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username must be 1\u201364 chars, alphanumeric/_.-' })); return;
        }
        if (password.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Password must be at least 8 characters' })); return;
        }
        const existing = loadWebappUsers();
        const dup = existing.find(u => u.username === username);
        if (dup?.blocked) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'That username is blocked.' })); return;
        }
        if (dup) {
          // If creds match the existing record (i.e. an interrupted self-reg
          // where the user is retrying with the same password) just hand them
          // a fresh session + wizard. If the password is wrong, 409.
          if (!verifyWebappPassword(password, dup.salt, dup.hash)) {
            _writeFailedLoginOrRateLimit(req, res, 409, 'Username already taken'); return;
          }
          _clearLoginAttempts(req);
          const sid = crypto.randomBytes(32).toString('hex');
          const otherCookies = parseCookies(req);
          if (otherCookies['spore_session']) _deleteAuthSession(otherCookies['spore_session'], 'session-replaced');
          const userGraphSlug = ensureAndPersistWebUserGraph(username, { reason: 'self-register-resume', selfRegistered: !!dup.selfRegistered });
          _sessions.set(sid, { user: username, created: Date.now(), type: 'webapp' });
          const secure = cookieSecureAttr(req);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [
              `spore_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
              `spore_session=; Path=/; HttpOnly; Max-Age=0`,
            ],
          });
          // Re-show wizard only if it wasn't already completed.
          let wizardNeeded = true;
          try {
            const prefs = JSON.parse(fs.readFileSync(path.join(this.config.dataDir, 'preferences.json'), 'utf8'));
            if (prefs[username]?.wizardCompleted) wizardNeeded = false;
          } catch { /* silent: malformed JSON → fallback */ }
          res.end(JSON.stringify({ ok: true, user: username, role: 'webapp', wizardNeeded, resumed: true, userGraphSlug }));
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        const userGraphSlug = ensureWebUserGraph(username, { reason: 'self-register', selfRegistered: true });
        const record = { username, hash, salt, created: Date.now(), role: 'webapp', selfRegistered: true };
        if (userGraphSlug) record.userGraphSlug = userGraphSlug;
        existing.push(record);
        _writeJsonAtomic(WEBAPP_USERS_PATH, existing);
        _clearLoginAttempts(req);
        const sid = crypto.randomBytes(32).toString('hex');
        const otherCookies = parseCookies(req);
        if (otherCookies['spore_session']) _deleteAuthSession(otherCookies['spore_session'], 'session-replaced');
        _sessions.set(sid, { user: username, created: Date.now(), type: 'webapp' });
        const secure = cookieSecureAttr(req);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            `spore_webapp=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            `spore_session=; Path=/; HttpOnly; Max-Age=0`,
          ],
        });
        res.end(JSON.stringify({ ok: true, user: username, role: 'webapp', wizardNeeded: true, userGraphSlug }));
        return;
      }

      // ── Admin user-management endpoints (creator-only) ──
      if (urlPath === '/api/webapp/users' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const users = loadWebappUsers().map(u => ({
          username: u.username,
          role: u.role || 'webapp',
          blocked: !!u.blocked,
          selfRegistered: !!u.selfRegistered,
          userGraphSlug: u.userGraphSlug || null,
          created: u.created || null,
          passwordUpdatedAt: u.passwordUpdatedAt || null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ users }));
        return;
      }

      if (urlPath.startsWith('/api/webapp/users/') && (req.method === 'PATCH' || req.method === 'DELETE')) {
        if (!(await checkAuth(req, res))) return;
        // Find requesting user (so we can prevent self-demotion / self-delete).
        const cookies = parseCookies(req);
        const sid = cookies['spore_session'];
        const sess = sid && _sessions.get(sid);
        const meUsername = sess?.user || null;
        const target = decodeURIComponent(urlPath.slice('/api/webapp/users/'.length));
        if (target === 'me') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Reserved' })); return; }
        if (target === meUsername) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'You can\u2019t modify your own account here.' })); return; }
        const users = loadWebappUsers();
        const idx = users.findIndex(u => u.username === target);
        if (idx < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No such user' })); return; }

        if (req.method === 'DELETE') {
          // Refuse to delete the last creator.
          if ((users[idx].role || 'webapp') === 'creator') {
            const creatorCount = users.filter(u => (u.role || 'webapp') === 'creator').length;
            if (creatorCount <= 1) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cannot delete the only creator account' })); return; }
          }
          users.splice(idx, 1);
          _writeJsonAtomic(WEBAPP_USERS_PATH, users);
          // Drop any active session for the deleted user.
          for (const [k, v] of _sessions) { if (v?.user === target) _deleteAuthSession(k, 'user-deleted'); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // PATCH: { role?: 'creator'|'webapp', blocked?: boolean }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const allowedRoles = ['creator', 'webapp'];
        if (Object.prototype.hasOwnProperty.call(parsed, 'role')) {
          if (!allowedRoles.includes(parsed.role)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'role must be creator or webapp' })); return; }
          // Refuse to demote the last creator.
          if ((users[idx].role || 'webapp') === 'creator' && parsed.role !== 'creator') {
            const creatorCount = users.filter(u => (u.role || 'webapp') === 'creator').length;
            if (creatorCount <= 1) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cannot demote the only creator account' })); return; }
          }
          users[idx].role = parsed.role;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, 'blocked')) {
          users[idx].blocked = !!parsed.blocked;
          if (users[idx].blocked) {
            for (const [k, v] of _sessions) { if (v?.user === target) _deleteAuthSession(k, 'user-blocked'); }
          }
        }
        const userGraphSlug = (users[idx].role || 'webapp') === 'webapp'
          ? ensureWebUserGraphForRecord(users[idx], { reason: 'user-admin-update' })
          : users[idx].userGraphSlug || null;
        if (userGraphSlug) users[idx].userGraphSlug = userGraphSlug;
        _writeJsonAtomic(WEBAPP_USERS_PATH, users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { username: users[idx].username, role: users[idx].role, blocked: !!users[idx].blocked, userGraphSlug: users[idx].userGraphSlug || null } }));
        return;
      }

      // Webapp user changes their own password (any-auth — uses session cookie to identify user)
      if (urlPath === '/api/webapp/users/me/password' && req.method === 'POST') {
        const sessType = isAnyAuth(req);
        if (!sessType) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Authentication required"}'); return; }
        const cookies = parseCookies(req);
        const sid = cookies['spore_session'] || cookies['spore_webapp'];
        const sess = sid && _sessions.get(sid);
        if (!sess?.user) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"No session user"}'); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }
        const currentPassword = String(parsed.currentPassword || '');
        const newPassword = String(parsed.newPassword || '');
        if (newPassword.length < 8) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'New password must be at least 8 characters' })); return; }
        const users = loadWebappUsers();
        const idx = users.findIndex(u => u.username === sess.user);
        if (idx < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"User record missing"}'); return; }
        if (!verifyWebappPassword(currentPassword, users[idx].salt, users[idx].hash)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Current password is incorrect' })); return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(newPassword, salt, 100000, 64, 'sha512').toString('hex');
        users[idx].salt = salt;
        users[idx].hash = hash;
        users[idx].passwordUpdatedAt = Date.now();
        _writeJsonAtomic(WEBAPP_USERS_PATH, users);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (urlPath === '/api/onboarding/complete' && req.method === 'POST') {
        // Read body up front — we may need parsed.account to create
        // the webapp user as part of "complete" (the wizard now defers
        // account creation to this endpoint instead of writing
        // mid-flow at step 4).
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) { req.destroy(); return; } }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Bad body"}'); return; }

        const cookies = parseCookies(req);
        const sid = cookies['spore_session'] || cookies['spore_webapp'];
        let sess = sid && _sessions.get(sid);
        // Outgoing Set-Cookie header (only set when we just bootstrapped
        // the operator's account here in this request).
        let pendingSetCookie = null;
        // Onboarding-flow recovery: container restarts during the wizard
        // wipe the in-memory _sessions map. The operator's cookie still
        // exists client-side but doesn't resolve. If we're still in the
        // onboarding window AND exactly one webapp user exists, trust
        // that user as the session.
        if (!sess && _isOnboardingNeeded(this.config.dataDir, this.config)) {
          try {
            const users = loadWebappUsers();
            if (users.length === 1) {
              sess = { user: users[0].username, created: Date.now(), type: 'creator' };
              this.log.info(`[onboarding] No live session; treating sole webapp user "${users[0].username}" as the onboarding operator`);
            }
          } catch { /* silent: no webapp-users.json yet → fall through */ }
        }

        // Bootstrap path: no session AND we're in the onboarding window
        // AND the wizard included {account: {username, password}}.
        // Creates (or, if onboarding is being re-done with the same
        // username, REPLACES) the operator account + session inline.
        //
        // Re-do semantics: previously this short-circuited when any
        // webapp users existed, which silently dropped the new
        // password the operator typed during the second onboarding
        // run. The wizard reported success but login still expected
        // the original password. The fix below upserts by username
        // when we're still in the onboarding window so re-running the
        // wizard rotates the password as expected.
        if (!sess && _isOnboardingNeeded(this.config.dataDir, this.config)
            && parsed.account && typeof parsed.account === 'object') {
          const username = String(parsed.account.username || '').trim();
          const password = String(parsed.account.password || '');
          if (!username || username.length > 64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'account.username must be 1–64 chars' }));
            return;
          }
          if (password.length < 8) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'account.password must be at least 8 characters' }));
            return;
          }
          const existing = loadWebappUsers();
          const conflictWithOther = existing.some(u => u.username !== username && u.role === 'creator');
          if (conflictWithOther) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Cannot re-onboard as "${username}" — a different creator account ("${existing.find(u => u.role === 'creator').username}") already exists. Delete it first or log in as that user.` }));
            return;
          }
          const salt = crypto.randomBytes(16).toString('hex');
          const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
          // Upsert: replace the existing record for this username
          // (preserves any non-creator users that may have
          // self-registered in the meantime).
          const filtered = existing.filter(u => u.username !== username);
          const createdAt = existing.find(u => u.username === username)?.created || Date.now();
          _writeJsonAtomic(WEBAPP_USERS_PATH, [
            ...filtered,
            { username, hash, salt, created: createdAt, role: 'creator' },
          ]);
          const newSid = crypto.randomBytes(32).toString('hex');
          _sessions.set(newSid, { user: username, created: Date.now(), type: 'creator' });
          const secure = cookieSecureAttr(req);
          pendingSetCookie = [
            `spore_session=${newSid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
            `spore_webapp=; Path=/; HttpOnly; Max-Age=0`,
          ];
          sess = _sessions.get(newSid);
          const action = existing.some(u => u.username === username) ? 'Reset password for' : 'Created';
          this.log.info(`[onboarding] ${action} operator account "${username}" inline at /api/onboarding/complete`);
        }

        if (!sess) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"No session — refresh the page and re-enter the wizard."}'); return; }
        try {
          // 0. Auto-fill any missing per-model ctx by probing the configured providers' /models endpoints.
          parsed.modelLimits = await _enrichModelLimits(parsed.modelLimits, parsed.models, parsed.providers, this.tools?._pluginManager, this.config);
          // 1. Persist settings through the existing pipeline
          const persistedSettings = this._persistSettingsPatch(parsed, { returnGeneratedSecrets: true });
          const newState = persistedSettings.settings || persistedSettings;
          const generatedSecrets = persistedSettings.generatedSecrets || {};
          // 1a. Provider plugin configs must land before the configured-provider
          // gate below, otherwise dynamic provider plugins fail the finish step
          // even though their keys are present in the same wizard payload.
          const pluginActions = parsed.pluginActions;
          const mgr = this.tools?._pluginManager;
          if (pluginActions && typeof pluginActions === 'object' && mgr) {
            const requestedEnabled = new Set(
              (Array.isArray(pluginActions.enabled) ? pluginActions.enabled : [])
                .concat(Object.keys(pluginActions.configs || {}))
                .filter(Boolean)
            );
            if (requestedEnabled.size > 0) {
              const pluginMetaById = new Map();
              for (const p of mgr.listAvailable?.() || []) if (p?.id) pluginMetaById.set(p.id, p);
              for (const p of mgr.listInstalled?.() || []) if (p?.id && !pluginMetaById.has(p.id)) pluginMetaById.set(p.id, p);
              const depsOf = (pluginId) => {
                const raw = pluginMetaById.get(pluginId)?.depends || pluginMetaById.get(pluginId)?.dependencies || [];
                return Array.isArray(raw) ? raw.filter(Boolean) : [];
              };
              const includeDeps = (pluginId, seen = new Set()) => {
                if (!pluginId || seen.has(pluginId)) return;
                seen.add(pluginId);
                for (const dep of depsOf(pluginId)) includeDeps(dep, seen);
                requestedEnabled.add(pluginId);
              };
              for (const pluginId of Array.from(requestedEnabled)) includeDeps(pluginId);
              const installDepth = (pluginId, seen = new Set()) => {
                if (seen.has(pluginId)) return 0;
                seen.add(pluginId);
                return 1 + Math.max(0, ...depsOf(pluginId).map(dep => installDepth(dep, seen)));
              };
              const sortedEnabledIds = Array.from(requestedEnabled).sort((a, b) => installDepth(a) - installDepth(b));
              for (const pluginId of sortedEnabledIds) {
                if (mgr.plugins?.has?.(pluginId)) continue;
                try {
                  await mgr.installPlugin({ id: pluginId });
                  this.log.info(`[onboarding] installed ${pluginId}`);
                } catch (e) {
                  throw new Error(`Plugin install (${pluginId}) failed: ${e.message}`);
                }
              }
            }
          }
          if (pluginActions && typeof pluginActions === 'object' && mgr) {
            const configs = pluginActions.configs || {};
            for (const [pluginId, partial] of Object.entries(configs)) {
              if (!partial || typeof partial !== 'object') continue;
              try { await mgr.persistPluginConfig(pluginId, partial); } catch (e) {
                this.log.warn(`[onboarding] plugin config (${pluginId}) failed: ${e.message}`);
              }
            }
          }
          // 1b. Belt-and-suspenders for the wizard's client-side finish
          // gate: refuse to complete onboarding unless at least one
          // provider plugin is registered AND configured. Runs AFTER
          // persistSettingsPatch so each plugin's isConfigured(config)
          // sees the freshly-saved keys/baseUrls. Without that ordering,
          // every wizard finish 400s because the gate runs against the
          // pre-save config and naturally finds no configured provider.
          const mgrCheck = this.tools?._pluginManager;
          if (mgrCheck && typeof mgrCheck.getProviders === 'function') {
            const providers = mgrCheck.getProviders().filter(p => p.configured);
            if (providers.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No provider plugin is registered + configured. Install at least one (anthropic-provider, openai-provider, openrouter-provider, local-oai-provider, gemini-provider) and configure its API key before completing onboarding.' }));
              return;
            }
          }
          // 1a. Plugin selections — wizard sends
          // `pluginActions: { enabled: [...], disabled: [...], configs: { id: {...} } }`.
          // Enabled ids are hot-installed above before provider validation.
          // For each disabled id: hot-uninstall (which also adds to
          // plugins-disabled.json so subsequent boots skip it). For each
          // config: persist into config.plugins[id].
          // The key is intentionally `pluginActions`, NOT `plugins` — the latter would land
          // in _persistSettingsPatch's body.plugins branch, which treats every top-level key
          // as a plugin id and writes `disabled` and `configs` as synthetic plugin slots.
          if (pluginActions && typeof pluginActions === 'object') {
            if (mgr) {
              const disabledIds = Array.isArray(pluginActions.disabled) ? pluginActions.disabled : [];
              // Refuse to uninstall any provider plugin whose provider
              // is configured in this same payload — the wizard's plugin
              // picker (step 'p') runs BEFORE the providers step, so
              // any provider plugin not pre-checked there ends up in
              // disabled[] even though the operator later configured
              // its API key. Without this guard the agent boots with
              // zero providers and silently refuses every chat.
              const protectedPluginIds = new Set();
              const pluginMetaById = new Map();
              for (const p of mgr.listAvailable?.() || []) if (p?.id) pluginMetaById.set(p.id, p);
              for (const p of mgr.listInstalled?.() || []) if (p?.id && !pluginMetaById.has(p.id)) pluginMetaById.set(p.id, p);
              const depsOf = (pluginId) => {
                const raw = pluginMetaById.get(pluginId)?.depends || pluginMetaById.get(pluginId)?.dependencies || [];
                return Array.isArray(raw) ? raw.filter(Boolean) : [];
              };
              const protectWithDeps = (pluginId, seen = new Set()) => {
                if (!pluginId || seen.has(pluginId)) return;
                seen.add(pluginId);
                protectedPluginIds.add(pluginId);
                for (const dep of depsOf(pluginId)) protectWithDeps(dep, seen);
              };
              const providerPluginByName = new Map();
              for (const provider of mgr.getProviders?.() || []) {
                if (provider?.name && provider?.pluginId) providerPluginByName.set(provider.name, provider.pluginId);
                for (const prefix of provider?.prefixes || []) {
                  if (prefix && provider?.pluginId) providerPluginByName.set(String(prefix).toLowerCase(), provider.pluginId);
                }
              }
              for (const pluginId of Object.keys(pluginActions.configs || {})) {
                protectWithDeps(pluginId);
              }
              for (const pluginId of pluginActions.enabled || []) {
                protectWithDeps(pluginId);
              }
              const providerKeys = parsed.providers || {};
              for (const provName of Object.keys(providerKeys)) {
                const v = providerKeys[provName];
                const hasConfig = Array.isArray(v)
                  ? v.some(entry => entry && (entry.apiKey || entry.key || entry.url || entry.baseUrl))
                  : !!(v && typeof v === 'object' && (v.apiKey || v.baseUrl));
                if (!hasConfig) continue;
                if (providerPluginByName.has(provName)) {
                  protectWithDeps(providerPluginByName.get(provName));
                }
                // Provider plugin convention: `<name>-provider` (e.g.
                // anthropic-provider, openai-provider, …). Local-OAI
                // is an exception (local-oai-provider).
                const candidates = [
                  `${provName}-provider`,
                  provName === 'local' ? 'local-oai-provider' : null,
                  provName === 'custom' ? 'local-oai-provider' : null,
                ].filter(Boolean);
                for (const id of candidates) protectWithDeps(id);
              }
              const disabledSet = new Set(disabledIds);
              const uninstallDepth = (pluginId, seen = new Set()) => {
                if (seen.has(pluginId)) return 0;
                seen.add(pluginId);
                let max = 0;
                for (const dep of depsOf(pluginId)) {
                  if (disabledSet.has(dep)) max = Math.max(max, uninstallDepth(dep, seen));
                }
                return max + 1;
              };
              const sortedDisabledIds = [...disabledIds].sort((a, b) => uninstallDepth(b) - uninstallDepth(a));
              for (const pluginId of sortedDisabledIds) {
                if (protectedPluginIds.has(pluginId)) {
                  this.log.info(`[onboarding] keeping ${pluginId} active — selected provider/plugin depends on it`);
                  continue;
                }
                try { await mgr.uninstallPlugin(pluginId); } catch (e) {
                  this.log.warn(`[onboarding] plugin uninstall (${pluginId}) failed: ${e.message}`);
                }
              }
            }
          }
          // 2. Theme preference — valid values + default come from the
          // settings registry's appearance.theme def. Adding a theme is
          // a one-line change in defs.core.js; no list to keep in sync.
          const PREFS_PATH = path.join(this.config.dataDir, 'preferences.json');
          const themeDef = require('../settings').getDef('appearance.theme');
          const VALID_THEMES = themeDef?.enum || ['dark'];
          let prefs = {};
          try { prefs = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }
          const theme = VALID_THEMES.includes(parsed.theme) ? parsed.theme : (themeDef?.default || 'dark');
          if (!prefs[sess.user]) prefs[sess.user] = {};
          prefs[sess.user].theme = theme;
          // The operator just completed the full wizard — that subsumes
          // the slim per-user wizard, so flag it done. Without this, the
          // creator user would land in startUserWizard("Set up your
          // account") on the very next page load, since /api/auth/check
          // reports wizardNeeded based on prefs[user].wizardCompleted.
          prefs[sess.user].wizardCompleted = true;
          prefs._lastUsed = { theme, ts: Date.now() };
          prefs.onboardingCompleted = true;
          prefs.onboardingCompletedAt = Date.now();
          _writeJsonAtomic(PREFS_PATH, prefs);
          // 3. Mirror choices into the active graph
          try {
            const graphDb = this.graph?.db;
            if (graphDb) this._applyOnboardingToGraph(graphDb, parsed);
          } catch (e) { this.log.warn(`[onboarding] graph sync skipped: ${e.message}`); }
          const headers = { 'Content-Type': 'application/json' };
          if (pendingSetCookie) headers['Set-Cookie'] = pendingSetCookie;
          res.writeHead(200, headers);
          res.end(JSON.stringify({
            ok: true,
            theme,
            account: pendingSetCookie ? { username: sess.user, role: sess.type } : undefined,
            secrets: Object.keys(generatedSecrets).length ? generatedSecrets : undefined,
          }));
        } catch (e) {
          // Surface per-key validation errors so the operator can see
          // which fields the transport rejected. PatchError attaches
          // `.errors`; plain errors fall through to the generic message.
          const details = Array.isArray(e?.errors) && e.errors.length
            ? ' :: ' + e.errors.map(x => `${x.key}=${x.error}`).join('; ')
            : '';
          this.log.warn(`[onboarding] complete failed: ${e.message}${details}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message + details, errors: e?.errors }));
        }
        return;
      }

      // /graph — serve without auth (HTML has its own login form)
      // /mobile — same, but serves mobile-viewer.html (mobile-first chrome,
      //           same JS modules, distinct route so desktop is untouched).
      if (urlPath === '/graph' || urlPath === '/graph/' ||
          urlPath === '/mobile' || urlPath === '/mobile/') {
        try {
          const isMobile = urlPath === '/mobile' || urlPath === '/mobile/';
          const filename = isMobile ? 'mobile-viewer.html' : 'graph-viewer.html';
          const localViewer = path.join(__dirname, '..', 'static', filename);
          const sharedStaticDir = process.env.SPORE_SHARED_STATIC || '/app/shared-static';
          const sharedViewer = path.join(sharedStaticDir, filename);
          const viewerPath = _newerFile(sharedViewer, localViewer);
          let html = fs.readFileSync(viewerPath, 'utf8');
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          if (fs.existsSync(brandPath)) {
            const inline = `<script>\n${fs.readFileSync(brandPath, 'utf8')}\n</script>`;
            html = html.replace(/<script src="brand\.js"><\/script>/, inline);
          }
          // Inject theme CSS vars into <html> so the login overlay is themed before JS runs
          html = html.replace(/<html\s+lang="en">/, `<html lang="en" style="${_buildThemeInlineStyle(this.config.dataDir)}">`);
          // Inject onboarding flag so the viewer knows to show the wizard before login
          const obFlag = `<script>window.__ONBOARDING__=${JSON.stringify({ needed: _isOnboardingNeeded(this.config.dataDir, this.config) })};</script>`;
          html = html.replace(/<\/head>/, obFlag + '</head>');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
          res.end(html);
        } catch { res.writeHead(500); res.end('Viewer not found.'); }
        return;
      }

      if (urlPath === '/' || urlPath === '/index.html') {
        const basePath = (this.config.ingressPath || '').replace(/\/$/, '');
        res.writeHead(302, { 'Location': basePath + '/graph' });
        res.end();
        return;
      }

      if (urlPath === '/brand.js') {
        try {
          const brandPath = path.join(__dirname, '..', 'static', 'brand.js');
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(fs.readFileSync(brandPath, 'utf8'));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // Self-hosted fonts (Petri direction). Avoids the external Google Fonts
      // dependency so the redesign actually paints when the user's browser
      // can't reach fonts.googleapis.com.
      if (urlPath.startsWith('/fonts/') && /^\/fonts\/[a-zA-Z0-9_.-]+\.woff2?$/.test(urlPath)) {
        try {
          const fontPath = path.join(__dirname, '..', 'static', urlPath);
          const ext = path.extname(fontPath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': ext === '.woff2' ? 'font/woff2' : 'font/woff',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(fs.readFileSync(fontPath));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // Frontend split — graph-viewer.html sources its CSS/JS from
      // /styles/*.css and /scripts/*.js. Files live under
      // src/static/{styles,scripts}/. Cache-busted via ?v=… query
      // params on the link tags so a redeploy invalidates client caches.
      if (urlPath.startsWith('/styles/') && /^\/styles\/[a-zA-Z0-9_.-]+\.css$/.test(urlPath)) {
        try {
          const filePath = path.join(__dirname, '..', 'static', urlPath);
          res.writeHead(200, {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(fs.readFileSync(filePath));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }
      if (urlPath.startsWith('/scripts/') && /^\/scripts\/[a-zA-Z0-9_.-]+\.js$/.test(urlPath)) {
        try {
          const filePath = path.join(__dirname, '..', 'static', urlPath);
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(fs.readFileSync(filePath));
        } catch { res.writeHead(404); res.end('Not found'); }
        return;
      }

      // ── Plugin path aliases (e.g. spore-code registers /api/acorn/* →
      // /api/plugins/spore-code/*) ──
      // Plugins call api.registerPathAlias('<prefix>', { cors, notFoundCode })
      // to claim a top-level URL space. Useful for legacy / external
      // wire-protocol clients that hardcode a particular URL contract.
      // When the plugin is uninstalled the alias disappears and the URL
      // 404s like any other unknown path. CORS pre-flight is handled
      // here for aliases that opt in.
      {
        const mgr = this.tools?._pluginManager;
        const alias = mgr?.resolvePathAlias?.(urlPath);
	          if (alias) {
	            if (alias.cors) {
	              if (allowedOrigin) {
	                res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
	                res.setHeader('Access-Control-Allow-Credentials', 'true');
	              }
	              res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	              res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (req.method === 'OPTIONS') {
              res.writeHead(204);
              res.end();
              return;
            }
          }
          const resolved = mgr.resolveWebRoute(req.method, alias.aliasPath);
          if (resolved) {
            // Mirror the auth model from the regular /api/plugins/<id>/...
            // dispatch site below: non-public routes require signed-in
            // user. Acorn-cli's /auth opts out via { public: true } so
            // unauthenticated Go binaries can post a key for a token.
            if (!resolved.public && !isAnyAuth(req)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Authentication required' }));
              return;
            }
            try {
              const query = (() => { try { return new URL(req.url, 'http://x').searchParams; } catch { return new URLSearchParams(); } })();
              const authCtx = authContextFromReq(req);
              await resolved.handler(req, res, {
                urlPath: alias.aliasPath,
                query,
                user: authCtx?.username || authCtx?.user || req._user || null,
                auth: authCtx || null,
              });
            } catch (e) {
              this.log.error(`[plugins] route ${resolved.pluginId}${alias.aliasPath} failed: ${e?.message}`);
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e?.message || 'plugin route failed' }));
              }
            }
            return;
          }
          // Alias matched but no specific route — return 404 with hint.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `No route registered for ${urlPath}`,
            plugin: alias.pluginId,
            ...(alias.notFoundCode ? { code: alias.notFoundCode } : {}),
          }));
          return;
        }
      }

      if (urlPath === '/api/ws-token') {
        const sid = getSessionFromReq(req);
        const sess = sid ? _sessions.get(sid) : null;
        if (sess && Date.now() - sess.created < SESSION_TTL && sess.user) {
          const ticket = crypto.randomBytes(16).toString('hex');
          _sessions.set(ticket, {
            user: sess.user,
            type: sess.type,
            created: Date.now(),
            expiresAt: Date.now() + 60 * 1000,
            singleUse: true,
            wsTicket: true,
            sourceSession: sid,
          });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ token: ticket }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: '' }));
        return;
      }

      if (urlPath === '/api/identity') {
        if (!isAnyAuth(req)) {
          if (!(await checkAuth(req, res))) return;
        }
        const displayName = this.config.displayName || this.config.agentId || 'spore';
        const names = [displayName.toLowerCase()];
        if (Array.isArray(this.config.nicknames)) {
          this.config.nicknames.forEach(n => { if (n && !names.includes(n.toLowerCase())) names.push(n.toLowerCase()); });
        }
        try {
          const db = this.graph?.db || graphDb;
          if (db) {
            const agentId = this.config.agentId || 'spore';
            try {
              const aliases = db.prepare("SELECT alias FROM aliases WHERE node_id = ?").all(agentId);
              aliases.forEach(a => { if (a.alias && !names.includes(a.alias.toLowerCase())) names.push(a.alias.toLowerCase()); });
            } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
          }
        } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        const pipeline = this._ensureVoicePipeline();
        const voiceEnabled = !!(pipeline);
        const sttEnabled = !!(pipeline?.stt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: displayName, names, voiceEnabled, sttEnabled }));
        return;
      }

      // ── Chatroom toggle API ──
      if (urlPath === '/api/chatroom/status' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        const connected = !!(gw && gw._ws && gw._ws.readyState === 1);
        const enabled = !gw?._closed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled, connected }));
        return;
      }

      if (urlPath === '/api/chatroom/toggle' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const gw = this.tools._chatroomGateway;
        if (!gw) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No chatroom gateway configured (MANAGER_URL not set)', enabled: false }));
          return;
        }
        const body = await new Promise((resolve) => {
          let d = '';
          req.on('data', c => { d += c; });
          req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        if (body.enabled === false) {
          gw.disconnect();
          this.log.info('[chatroom] Disconnected from chatroom (user toggle)');
        } else {
          gw._closed = false;
          gw.connect();
          this.log.info('[chatroom] Reconnecting to chatroom (user toggle)');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: !gw._closed }));
        return;
      }

      // Local cron / background-process notification hook. Public callers
      // still need creator auth; unauthenticated access is loopback-only so
      // container cron can `curl http://127.0.0.1:$SPORE_WEB_PORT/...`.
      if (urlPath === '/api/proactive/trigger' && req.method === 'POST') {
        if (!isLocalRequest(req) && !(await checkAuth(req, res))) return;
        const body = await _readJsonBody(req);
        const message = String(body.message || body.context || body.text || '').trim();
        const source = String(body.source || 'cron').trim().slice(0, 80) || 'cron';
        const mode = String(body.mode || 'notify').trim().toLowerCase();
        const explicitTarget = String(body.target || body.channelId || body.chatId || '').trim();
        const platform = String(body.platform || '').trim().toLowerCase();
        const channelId = explicitTarget || 'web:control-panel';
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }
        if (mode === 'agent') {
          const manager = this.tools?.platformManager || null;
          const parsed = manager?.parseTarget?.({ target: channelId, platform });
          if (parsed?.platform && parsed.platform !== 'web') {
            const gateway = manager.getGateway?.(parsed.platform);
            if (!gateway?.injectProactivePrompt) {
              res.writeHead(501, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: false,
                error: `Gateway ${parsed.platform} does not support proactive agent turns.`,
                mode: 'agent',
                channelId,
              }));
              return;
            }
            gateway.injectProactivePrompt(parsed.id, message, body.topic || source);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, mode: 'agent', channelId, platform: parsed.platform }));
            return;
          }
          this.injectProactivePrompt(channelId, message, body.topic || source);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode: 'agent', channelId }));
          return;
        }
        if (explicitTarget) {
          const manager = this.tools?.platformManager || null;
          const parsed = manager?.parseTarget?.({ target: channelId, platform });
          if (parsed?.platform && parsed.platform !== 'web') {
            const result = await manager.sendMessage({
              target: channelId,
              platform,
              content: message,
              notify: true,
              urgent: !!body.urgent,
            });
            res.writeHead(result?.error ? 502 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !result?.error, mode: 'notify', channelId, platform: parsed.platform, result }));
            return;
          }
        }
        const result = await this.tools._notifyUserTool({
          message,
          source,
          urgent: !!body.urgent,
        });
        res.writeHead(result?.error ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !result?.error, mode: 'notify', result }));
        return;
      }

      // LongMemEval benchmark routes moved to plugins/longmemeval — they
      // now serve at /api/plugins/longmemeval/{run,status,results,cancel}.

      // ── Multi-Graph Management API ──
      if (urlPath.startsWith('/api/graphs')) {
        const graphAuth = await requireGraphApiAuth(req, res);
        if (!graphAuth) return;
        req._graphApiAuthContext = graphAuth;
        await this._handleMultiGraphApi(req, res, urlPath, graphAuth);
        return;
      }

      // Enhanced Recall toggle
      if (urlPath === '/api/enhanced-recall') {
        if (!(await checkAuth(req, res))) return;
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enhancedRecall: !!this.config.enhancedRecall }));
          return;
        }
        if (req.method === 'PUT') {
          const body = await new Promise((resolve, reject) => {
            let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
          });
          this.config.enhancedRecall = !!body.enabled;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enhancedRecall: this.config.enhancedRecall }));
          return;
        }
      }

      if (urlPath === '/api/settings') {
        if (req.method === 'GET') {
          // Any authenticated session can open Settings, but only creator/admin
          // sessions receive server config. Webapp users get a safe personal-only
          // shell so secrets and plugin configs never leave the server.
          const authType = isAnyAuth(req) || (checkCreatorAuth(req, res) ? 'creator' : null);
          if (!authType) { res.writeHead(401); res.end('{"error":"Authentication required"}'); return; }
          const role = checkCreatorAuth(req, res) ? 'creator' : authType;
          const settings = this._settingsService.getSettingsResponse({ role });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(settings));
          return;
        }
        if (!(await checkAuth(req, res))) return;
        if (req.method === 'PATCH') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const parsed = body ? JSON.parse(body) : {};
            const patch = parsed.patch && typeof parsed.patch === 'object'
              ? parsed.patch
              : Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'actions'));
            const actions = parsed.actions && typeof parsed.actions === 'object' ? parsed.actions : {};
            const { result, settings, generatedSecrets } = this._settingsService.applyCanonicalPatch(patch, { actor: 'web', role: 'creator', actions });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, changed: result.changed, settings, secrets: Object.keys(generatedSecrets || {}).length ? generatedSecrets : undefined }));
          } catch (e) {
            const code = e?.statusCode || 400;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || 'invalid body', errors: e?.errors || undefined }));
          }
          return;
        }
        if (req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const parsed = body ? JSON.parse(body) : {};
            // Auto-fill missing per-model ctx by probing the configured providers' /models endpoints.
            parsed.modelLimits = await _enrichModelLimits(parsed.modelLimits, parsed.models, parsed.providers, this.tools?._pluginManager, this.config);
            const settings = this._persistSettingsPatch(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, settings }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || 'invalid body' }));
          }
          return;
        }
      }

	      if (urlPath === '/api/settings/invite-key/reveal' && req.method === 'POST') {
	        if (!(await checkAuth(req, res))) return;
	        const inviteKey = this.config.inviteKey || '';
	        this.log.warn('[security] Invite key revealed by creator/admin session');
	        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	        res.end(JSON.stringify({ ok: true, inviteKey, inviteKeySet: !!inviteKey }));
	        return;
	      }

      // ── Channel pairing API ──────────────────────────────────────
      // Browser Settings runs on the web gateway origin, while the
      // low-level pairing store is owned by the platform manager. Mirror
      // the pairing endpoints here so operators can approve/revoke channel
      // pairings from Settings without routing the action through the agent.
      if (urlPath.startsWith('/api/pairing/')) {
        if (!(await checkAuth(req, res))) return;
        const gatewayManager = this.tools?.platformManager;
        const pairing = gatewayManager?.pairing;
        const sendJson = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body, null, 2));
        };
        if (!pairing) {
          sendJson(503, { ok: false, error: 'Pairing store unavailable' });
          return;
        }
        try {
          if (urlPath === '/api/pairing/pending' && req.method === 'GET') {
            sendJson(200, pairing.listPending());
            return;
          }
          if (urlPath === '/api/pairing/approved' && req.method === 'GET') {
            sendJson(200, pairing.listApproved());
            return;
          }
          if (urlPath === '/api/pairing/approve' && req.method === 'POST') {
            const { channel, code, notify = true, message } = await _readJsonBody(req);
            const result = channel
              ? pairing.approveCodeForChannel(channel, code)
              : pairing.approveCode(code);
            if (!result) {
              sendJson(404, { ok: false, error: 'Code not found or expired' });
              return;
            }
            const out = { ok: true, ...result };
            if (notify !== false && result.channel === 'telegram') {
              try {
                const gw = gatewayManager?.getGateway?.('telegram');
                const text = message || 'Pairing approved. You can message me now.';
                if (gw?.sendMessage) {
                  const sent = await gw.sendMessage(result.id, text);
                  out.notification = sent?.error ? { ok: false, error: sent.error } : { ok: true };
                } else {
                  out.notification = { ok: false, error: 'Telegram gateway cannot send notifications right now.' };
                }
              } catch (e) {
                out.notification = { ok: false, error: e?.message || String(e) };
              }
            }
            sendJson(200, out);
            return;
          }
          if (urlPath === '/api/pairing/revoke' && req.method === 'POST') {
            const { channel, id } = await _readJsonBody(req);
            const ok = pairing.revokeApproved(channel, id);
            sendJson(200, { ok, channel, id });
            return;
          }
          sendJson(405, { ok: false, error: 'Unsupported pairing route or method' });
          return;
        } catch (e) {
          sendJson(400, { ok: false, error: e?.message || 'Pairing request failed' });
          return;
        }
      }

      // ── Reset core graphs (creator only, destructive) ─────────────
      // Multi-graph reset for "start fresh": keep only the default/main
      // graph and General Knowledge graph, reset both to seeds, and
      // delete every project/channel/user/custom graph. Each reset backs
      // up its DB first so the action is recoverable.
      //
      // Body: { confirm: "RESET" } — typed-string guard so a stray
      // POST can't trash the graph. Returns before/after counts +
      // backup path on success.
      if (urlPath === '/api/admin/reset-graph') {
        if (!(await checkAuth(req, res))) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        if (parsed.confirm !== 'RESET') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'confirm must be the literal string "RESET"' }));
          return;
        }
        try {
          const result = await this._resetCoreGraphsAndPruneExtras();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          this.log.error('[reset-graph] failed:', e?.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'reset failed', details: e?.details || null }));
        }
        return;
      }

      // Frontend asset registry — graph-viewer.html boot fetches this list
      // and inserts <script src=…> for each entry. No auth: graph-viewer.html
      // itself is served pre-auth (operator hasn't signed in yet at page-
      // load time), so its bootstrap dependencies must be too. Plugins
      // declare assets via api.registerFrontendAsset(filename); the manager
      // serves the file at /api/plugins/<id>/static/<filename>.
      if (urlPath === '/api/plugins/frontend-assets' && req.method === 'GET') {
        const mgr = this.tools?._pluginManager;
        const assets = mgr?.getFrontendAssets?.() || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ assets }));
        return;
      }

      // Plugin static file server: GET /api/plugins/<id>/static/<file>.
      // Only matches if the plugin has called registerFrontendAsset(<file>).
      // Path-traversal guarded — filename must be a single segment.
      if (urlPath.startsWith('/api/plugins/') && urlPath.includes('/static/')) {
        const m = urlPath.match(/^\/api\/plugins\/([a-zA-Z0-9_-]+)\/static\/([^\/?]+)$/);
        if (m) {
          const [, pluginId, filename] = m;
          const mgr = this.tools?._pluginManager;
          const assets = mgr?.getFrontendAssets?.() || [];
          const ok = assets.some(a => a.pluginId === pluginId && a.filename === filename);
          if (!ok) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Asset not registered' }));
            return;
          }
          const plugin = mgr?.plugins?.get?.(pluginId);
          if (!plugin?.path) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plugin path not found' }));
            return;
          }
          const filePath = path.join(plugin.path, 'static', filename);
          // Path traversal sanity: the resolved file must be inside the
          // plugin's static/ dir.
          const expectedRoot = path.join(plugin.path, 'static') + path.sep;
          const resolvedPath = path.resolve(filePath);
          if (!resolvedPath.startsWith(expectedRoot) && resolvedPath !== expectedRoot.slice(0, -1)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
          }
          if (!fs.existsSync(resolvedPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
          }
          const ext = path.extname(filename).toLowerCase();
          const mimeMap = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
          const mime = mimeMap[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
          fs.createReadStream(resolvedPath).pipe(res);
          return;
        }
      }

      // Plugins API — list / install / uninstall. Creator-only.
      // Install + uninstall are gated behind config.pluginsHotReload so
      // operators can explicitly disable runtime plugin lifecycle.
      // List is always available so the settings UI can show what's loaded.
      if (urlPath === '/api/plugins/list' && req.method === 'GET') {
        if (!(await checkAuth(req, res))) return;
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        const dirs = mgr.getDiscoveryDirs?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: !!this.config.pluginsEnabled,
          hotReload: !!this.config.pluginsHotReload,
          dirs: { bundled: dirs.bundled || null, user: dirs.user || null },
          installed: mgr.listInstalled(),
          available: mgr.listAvailable?.() || [],
        }));
        return;
      }

      if (urlPath === '/api/plugins/install' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Remove SPORE_PLUGINS_HOT_RELOAD=false or set it to true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        // Accept { id } (resolves against discovery dirs) or { path } (legacy).
        const arg = parsed.id ? { id: parsed.id } : (parsed.path ? { path: parsed.path } : null);
        if (!arg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id (preferred) or path is required' }));
          return;
        }
        try {
          const manifest = await mgr.installPlugin(arg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, manifest }));
        } catch (e) {
          this.log.error('[plugins:install] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'install failed' }));
        }
        return;
      }

      // Clone a plugin from a git repo into the user discovery dir.
      // Doesn't auto-install — caller follows up with /api/plugins/install
      // once they've reviewed the cloned manifest. This separation lets the
      // UI show "cloned, not yet installed" state.
      if (urlPath === '/api/plugins/clone' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Remove SPORE_PLUGINS_HOT_RELOAD=false or set it to true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr?.cloneFromGit) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* silent: malformed JSON → fallback */ }
        if (!parsed.repo || typeof parsed.repo !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'repo (git URL) is required' }));
          return;
        }
        try {
          const result = await mgr.cloneFromGit(parsed.repo, {
            name: parsed.name,
            ref: parsed.ref,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, manifest: result.manifest, path: result.path }));
        } catch (e) {
          this.log.error('[plugins:clone] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'clone failed' }));
        }
        return;
      }

      // Plugin-registered HTTP routes — namespaced under /api/plugins/<pluginId>/<route>.
      // Resolved AFTER the built-in /api/plugins/* endpoints (list/install/uninstall)
      // so plugins can't shadow them. Default auth model is "any signed-in user"
      // (matches graph endpoints), but plugins can opt out via
      // registerWebRoute(method, path, { public: true, handler }) for routes
      // that ARE the auth boundary (e.g. spore-code /auth issues Bearer tokens).
      if (urlPath.startsWith('/api/plugins/') && !urlPath.startsWith('/api/plugins/list') && !urlPath.startsWith('/api/plugins/install') && !urlPath.startsWith('/api/plugins/uninstall')) {
        const mgr = this.tools?._pluginManager;
        const resolved = mgr?.resolveWebRoute?.(req.method, urlPath);
        if (resolved) {
          if (!resolved.public && !isAnyAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
          }
          try {
            const query = (() => { try { return new URL(req.url, 'http://x').searchParams; } catch { return new URLSearchParams(); } })();
            const authCtx = authContextFromReq(req);
            await resolved.handler(req, res, {
              urlPath,
              query,
              user: authCtx?.username || authCtx?.user || req._user || null,
              auth: authCtx || null,
            });
          } catch (e) {
            this.log.error(`[plugins] route ${resolved.pluginId}${urlPath} failed: ${e?.message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message || 'plugin route failed' }));
            }
          }
          return;
        }
      }

      if (urlPath.startsWith('/api/plugins/uninstall/') && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        if (!this.config.pluginsHotReload) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hot install/uninstall disabled. Remove SPORE_PLUGINS_HOT_RELOAD=false or set it to true to enable.' }));
          return;
        }
        const mgr = this.tools?._pluginManager;
        if (!mgr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plugin manager unavailable' }));
          return;
        }
        const pluginId = decodeURIComponent(urlPath.slice('/api/plugins/uninstall/'.length));
        if (!/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid plugin id' }));
          return;
        }
        try {
          const result = await mgr.uninstallPlugin(pluginId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (e) {
          this.log.error('[plugins:uninstall] failed:', e?.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'uninstall failed' }));
        }
        return;
      }

      // Read-only probe endpoints accept any authenticated session (webapp or creator),
      // so the onboarding wizard can test provider keys / model tiers / web search with
      // only the webapp cookie it just obtained from /api/webapp/users.
      const isTestProbe =
        (urlPath.startsWith('/api/providers/') && urlPath.endsWith('/test')) ||
        (urlPath.startsWith('/api/models/') && urlPath.endsWith('/test')) ||
        urlPath === '/api/providers/list-models' ||
        urlPath === '/api/websearch/test';
      if (isTestProbe) {
        // Allow access either with any session, OR while the wizard is still
        // running (so a restart-orphaned cookie doesn't lock the operator out
        // of the populate / test buttons mid-setup).
        const onboardingNeeded = _isOnboardingNeeded(this.config.dataDir, this.config);
        if (!isAnyAuth(req) && !onboardingNeeded) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      // Graph endpoints accept any authenticated session — webapp users have
      // read/write to the graph + chat by design. Maintainer / providers /
      // models / websearch stay creator-only.
      if (urlPath.startsWith('/api/graph')) {
        const graphAuth = await requireGraphApiAuth(req, res);
        if (!graphAuth) return;
        req._graphApiAuthContext = graphAuth;
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      if (urlPath.startsWith('/api/tokens') || urlPath === '/api/activity-log' || urlPath.startsWith('/api/maintainer') || urlPath.startsWith('/api/janitor') || urlPath.startsWith('/api/backups') || urlPath.startsWith('/api/email') || urlPath.startsWith('/api/providers') || urlPath.startsWith('/api/models') || urlPath.startsWith('/api/websearch') || urlPath.startsWith('/api/benchmark') || urlPath.startsWith('/api/queue')) {
        // Wizard bootstrap: allow the wizard's read-only/test endpoints
        // through WITHOUT auth when no webapp users exist yet AND the
        // wizard hasn't completed. This lets us defer user-account
        // creation to /api/onboarding/complete (instead of forcing it
        // at step 4 just so subsequent calls pass the auth gate). Each
        // listed endpoint takes the credential it needs in the request
        // body — no privilege-escalation surface.
        const isWizardBootstrap = (
          (urlPath === '/api/providers/list-models' && req.method === 'POST') ||
          (urlPath.startsWith('/api/providers/') && urlPath.endsWith('/test') && req.method === 'POST') ||
          (urlPath.startsWith('/api/models/') && urlPath.endsWith('/test') && req.method === 'POST') ||
          (urlPath === '/api/websearch/test' && req.method === 'POST')
        );
        let allow = false;
        if (isWizardBootstrap) {
          try {
            const usersPath = path.join(this.config.dataDir, 'webapp-users.json');
            const noUsers = !fs.existsSync(usersPath) || JSON.parse(fs.readFileSync(usersPath, 'utf8')).length === 0;
            if (noUsers && _isOnboardingNeeded(this.config.dataDir, this.config)) allow = true;
          } catch { /* fall through to checkAuth */ }
        }
        if (!allow && urlPath.startsWith('/api/models/routing-presets')) {
          const cliDeviceAuth = this._sporeCodeDeviceAuthFromReq(req);
          if (cliDeviceAuth) {
            req._sporeCodeDeviceAuth = cliDeviceAuth;
            allow = true;
          }
        }
        if (!allow && !(await checkAuth(req, res))) return;
        const currentDb = this.graph?.db || graphDb;
        this._handleGraphApiOnWeb(req, res, urlPath, currentDb);
        return;
      }

      if (urlPath.startsWith('/files/')) {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const relPath = decodeURIComponent(urlPath.slice(7));
        const filePath = path.join(workspace, relPath);
        if (!filePath.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) { res.writeHead(404); res.end('Not a file'); return; }
          const ext = path.extname(filePath).toLowerCase();
          const params = new URL(req.url, 'http://x').searchParams;
          const contentType = MIME[ext] || 'application/octet-stream';
          const baseHeaders = {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'ETag': `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
            'Accept-Ranges': 'bytes',
          };
          if (params.get('download') === '1') {
            baseHeaders['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
          }
          const range = req.headers.range;
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m) {
              let start = m[1] ? parseInt(m[1], 10) : 0;
              let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
              if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
              }
              res.writeHead(206, {
                ...baseHeaders,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': end - start + 1,
              });
              fs.createReadStream(filePath, { start, end }).pipe(res);
              return;
            }
          }
          res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
          fs.createReadStream(filePath).pipe(res);
        } catch { res.writeHead(404); res.end('File not found'); }
        return;
      }

      if (urlPath === '/api/preferences') {
        const PREFS_PATH = path.join(this.config.dataDir, 'preferences.json');
        // Two-theme system: only `dark` and `light`. Stale stored values
        // are coerced to `dark` via _normalizeThemeName(). The PUT path
        // always stores the normalized name; GETs always return one of
        // {dark, light}.
        const loadPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; } };
        const authType = isAnyAuth(req);
        if (!authType) { if (!(await tryManagerSSO(req, res))) { res.writeHead(401); res.end('{}'); return; } }
        const cookies = parseCookies(req);
        let username = 'default';
        const sid = cookies['spore_session'];
        const sess = sid && _sessions.get(sid);
        // Sessions are stored with `user` (legacy code looked at `username`).
        if (sess?.user || sess?.username) username = sess.user || sess.username;
        else {
          const wsid = cookies['spore_webapp'];
          const wsess = wsid && _sessions.get(wsid);
          if (wsess?.user || wsess?.username) username = wsess.user || wsess.username;
        }
        if (req.method === 'GET') {
          const prefs = loadPrefs();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            theme: _normalizeThemeName(prefs[username]?.theme),
            displayName: prefs[username]?.displayName || '',
            username,
            tutorialSeen: prefs[username]?.tutorialSeen || {},
            tutorialVersion: prefs[username]?.tutorialVersion || {},
            tutorialSeenAt: prefs[username]?.tutorialSeenAt || null,
          }));
          return;
        }
        if (req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          try {
            const parsed = JSON.parse(body);
            const prefs = loadPrefs();
            if (!prefs[username]) prefs[username] = {};
            if (Object.prototype.hasOwnProperty.call(parsed, 'theme')) {
              // Coerce any incoming value (including legacy names) to one
              // of the two surviving themes via the shared normalizer.
              const safeTheme = _normalizeThemeName(parsed.theme);
              prefs[username].theme = safeTheme;
              // Only creator-tier sessions can update the global "last used"
              // marker that the login page falls back on.
              const sessRole = sess?.type || (sid && _sessions.get(sid)?.type);
              if (sessRole === 'creator' || sessRole === 'admin') {
                prefs._lastUsed = { theme: safeTheme, ts: Date.now() };
              }
            }
            if (Object.prototype.hasOwnProperty.call(parsed, 'displayName')) {
              const dn = String(parsed.displayName || '').trim().slice(0, 64);
              if (dn) prefs[username].displayName = dn;
              else delete prefs[username].displayName;
            }
            if (parsed.wizardCompleted === true) {
              prefs[username].wizardCompleted = true;
              prefs[username].wizardCompletedAt = Date.now();
            }
            if (parsed.tutorialSeen && typeof parsed.tutorialSeen === 'object') {
              const current = (prefs[username].tutorialSeen && typeof prefs[username].tutorialSeen === 'object')
                ? prefs[username].tutorialSeen
                : {};
              const allowedTourKeys = ['admin', 'user'];
              for (const key of allowedTourKeys) {
                if (Object.prototype.hasOwnProperty.call(parsed.tutorialSeen, key)) {
                  current[key] = parsed.tutorialSeen[key] === true;
                }
              }
              prefs[username].tutorialSeen = current;
              prefs[username].tutorialSeenAt = Date.now();
            }
            if (parsed.tutorialVersion && typeof parsed.tutorialVersion === 'object') {
              const current = (prefs[username].tutorialVersion && typeof prefs[username].tutorialVersion === 'object')
                ? prefs[username].tutorialVersion
                : {};
              const allowedTourKeys = ['admin', 'user'];
              for (const key of allowedTourKeys) {
                if (Object.prototype.hasOwnProperty.call(parsed.tutorialVersion, key)) {
                  const n = Number(parsed.tutorialVersion[key]);
                  if (Number.isFinite(n) && n > 0) current[key] = Math.floor(n);
                }
              }
              prefs[username].tutorialVersion = current;
            }
            fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              theme: prefs[username].theme,
              displayName: prefs[username].displayName || '',
              tutorialSeen: prefs[username].tutorialSeen || {},
              tutorialVersion: prefs[username].tutorialVersion || {},
            }));
          } catch { res.writeHead(400); res.end('{"error":"invalid body"}'); }
          return;
        }
      }

      if (urlPath === '/api/logs') {
        if (!(await checkAuth(req, res))) return;
        const maxLines = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('lines') || '500'), 2000);
        const logRing = this.log._ring || [];
        const output = logRing.slice(-maxLines).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(output || '[no log entries captured yet]');
        return;
      }

      if (urlPath === '/api/workspace') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          const entries = fs.readdirSync(target, { withFileTypes: true }).map(e => {
            const stat = (() => { try { return fs.statSync(path.join(target, e.name)); } catch { return null; } })();
            return { name: e.name, isDir: e.isDirectory(), size: stat?.size || 0, modified: stat?.mtime || null };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: subdir || '/', entries }));
        } catch { res.writeHead(404); res.end(JSON.stringify({ error: 'Directory not found' })); }
        return;
      }

      if (urlPath === '/api/workspace/mkdir' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const params = new URL(req.url, 'http://x').searchParams;
        const parentDir = params.get('path') || '';
        const folderName = params.get('name') || '';
        if (!folderName || folderName.includes('/') || folderName.includes('..')) {
          res.writeHead(400); res.end('Invalid folder name'); return;
        }
        const target = path.join(workspace, parentDir, folderName);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          fs.mkdirSync(target, { recursive: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to create directory: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/file' && req.method === 'DELETE') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end('Failed to delete: ' + e.message); }
        return;
      }

      if (urlPath === '/api/workspace/save' && req.method === 'PUT') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const filePath = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!filePath.startsWith(workspace) || filePath === workspace) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
        req.on('end', () => {
          try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, Buffer.concat(chunks));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) { res.writeHead(500); res.end('Save failed: ' + e.message); }
        });
        return;
      }

      if (urlPath === '/api/workspace/upload' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const destDir = path.join(workspace, new URL(req.url, 'http://x').searchParams.get('path') || '');
        if (!destDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_UPLOAD = 10 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const boundary = boundaryMatch[1].trim();
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_UPLOAD * 10) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const saved = parseMultipart(buf, boundary, destDir, MAX_UPLOAD);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Upload failed: ' + e.message); }
        });
        return;
      }

      // ── Workspace tree (recursive listing for sync diffing) ──
      if (urlPath === '/api/workspace/tree') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const subdir = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const target = path.join(workspace, subdir);
        if (!target.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const walkDir = (dir, prefix) => {
          const results = [];
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const rel = prefix ? `${prefix}/${e.name}` : e.name;
              const full = path.join(dir, e.name);
              try {
                const stat = fs.statSync(full);
                if (e.isDirectory()) {
                  results.push(...walkDir(full, rel));
                } else {
                  results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
                }
              } catch (e) { this.log.warn('[web] fs.statSync failed: ' + e.message); }
            }
          } catch (e) { this.log.warn('[web] fs.readdirSync failed: ' + e.message); }
          return results;
        };
        try {
          const files = walkDir(target, '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ root: subdir || '/', files }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        return;
      }

      // ── Batch upload (preserves relative paths for sync) ──
      if (urlPath === '/api/workspace/upload-batch' && req.method === 'POST') {
        if (!(await checkAuth(req, res))) return;
        const workspace = this.config.workspacePath || process.cwd();
        const basePath = new URL(req.url, 'http://x').searchParams.get('path') || '';
        const baseDir = path.join(workspace, basePath);
        if (!baseDir.startsWith(workspace)) { res.writeHead(403); res.end('Forbidden'); return; }
        const MAX_BATCH = 50 * 1024 * 1024;
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          res.writeHead(400); res.end('Expected multipart/form-data'); return;
        }
        const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
        if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
        const chunks = [];
        let totalSize = 0;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_BATCH) { req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const boundary = boundaryMatch[1].trim();
            const parts = buf.toString('binary').split('--' + boundary);
            const saved = [];
            for (const part of parts) {
              if (part === '--\r\n' || part === '--' || !part.trim()) continue;
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd === -1) continue;
              const headerStr = part.substring(0, headerEnd);
              const nameMatch = headerStr.match(/name="([^"]+)"/);
              const filenameMatch = headerStr.match(/filename="([^"]+)"/);
              if (!filenameMatch) continue;
              const relPath = nameMatch ? nameMatch[1] : filenameMatch[1];
              let body = part.substring(headerEnd + 4);
              if (body.endsWith('\r\n')) body = body.slice(0, -2);
              const dest = path.join(baseDir, relPath);
              if (!dest.startsWith(baseDir)) continue;
              const dir = path.dirname(dest);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(dest, Buffer.from(body, 'binary'));
              saved.push(relPath);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: saved }));
          } catch (e) { res.writeHead(500); res.end('Batch upload failed: ' + e.message); }
        });
        return;
      }

      // ── Remote (SSH/SFTP) file operations ──
      if (urlPath.startsWith('/api/remote/')) {
        if (!(await checkAuth(req, res))) return;
        const mgr = this._ensureSSHManager();
        if (!mgr) { res.writeHead(503); res.end(JSON.stringify({ error: 'SSH manager not available' })); return; }
        const params = new URL(req.url, 'http://x').searchParams;
        const hostId = params.get('host');
        if (!hostId) { res.writeHead(400); res.end(JSON.stringify({ error: 'host parameter required' })); return; }
        const remotePath = params.get('path') || '/';

        try {
          if (urlPath === '/api/remote/ls') {
            const entries = await mgr.sftpListDir(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: remotePath, entries }));
          } else if (urlPath === '/api/remote/read') {
            const data = await mgr.sftpReadFile(hostId, remotePath);
            const ext = path.extname(remotePath).toLowerCase();
            const MIME_MAP = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
            const headers = { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' };
            if (params.get('download') === '1') {
              headers['Content-Disposition'] = `attachment; filename="${path.basename(remotePath)}"`;
            }
            res.writeHead(200, headers);
            res.end(data);
          } else if (urlPath === '/api/remote/write' && req.method === 'POST') {
            const contentType = req.headers['content-type'] || '';
            if (contentType.includes('multipart/form-data')) {
              const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
              if (!boundaryMatch) { res.writeHead(400); res.end('Missing boundary'); return; }
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const buf = Buffer.concat(chunks);
                  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'sftp-upload-'));
                  const saved = parseMultipart(buf, boundaryMatch[1].trim(), tmpDir, 10 * 1024 * 1024);
                  for (const fileName of saved) {
                    const localPath = path.join(tmpDir, fileName);
                    const content = fs.readFileSync(localPath);
                    const destPath = remotePath.endsWith('/') ? remotePath + fileName : remotePath + '/' + fileName;
                    await mgr.sftpWriteFile(hostId, destPath, content);
                    fs.unlinkSync(localPath);
                  }
                  fs.rmdirSync(tmpDir, { recursive: true });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, files: saved }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            } else {
              const chunks = [];
              req.on('data', (c) => chunks.push(c));
              req.on('end', async () => {
                try {
                  const result = await mgr.sftpWriteFile(hostId, remotePath, Buffer.concat(chunks));
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ ok: true, ...result }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
              });
            }
          } else if (urlPath === '/api/remote/mkdir' && req.method === 'POST') {
            const name = params.get('name') || '';
            const target = remotePath.endsWith('/') ? remotePath + name : remotePath + '/' + name;
            await mgr.sftpMkdir(hostId, target);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else if (urlPath === '/api/remote/file' && req.method === 'DELETE') {
            await mgr.sftpDelete(hostId, remotePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown remote endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[remote-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Shared Skills API ──
      if (urlPath.startsWith('/api/skills')) {
        if (!(await checkAuth(req, res))) return;
        try {
          const params = new URL(req.url, 'http://x').searchParams;
          if (urlPath === '/api/skills' && req.method === 'GET') {
            const query = params.get('q') || '';
            const tags = params.get('tags') ? params.get('tags').split(',').map(t => t.trim()) : null;
            const result = this.skills.list(query || undefined, tags || undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/read' && req.method === 'GET') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.read(slug);
            if (result.error) { res.writeHead(404); res.end(JSON.stringify(result)); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/save' && req.method === 'POST') {
            const chunks = [];
            req.on('data', c => { chunks.push(c); });
            req.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const result = this.skills.write(body.slug, {
                  title: body.title, tags: body.tags, author: body.author || 'web-ui',
                  summary: body.summary, content: body.content, mode: body.mode || 'replace',
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
              } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
            });
          } else if (urlPath === '/api/skills/delete' && req.method === 'DELETE') {
            const slug = params.get('slug');
            if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'slug required' })); return; }
            const result = this.skills.remove(slug);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else if (urlPath === '/api/skills/rebuild' && req.method === 'POST') {
            const index = this.skills._rebuildIndex();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: index.length }));
          } else {
            res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown skills endpoint' }));
          }
        } catch (e) {
          this.log.warn(`[skills-api] ${urlPath} error: ${e.message}`);
          if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        }
        return;
      }

      // ── Secure API Key Proxy ──
      // Agents write /workspace/web/.api-proxy.json to define routes.
      // Frontend calls /api/proxy/<route> and the server injects env keys server-side.
      // Keys never reach the browser.
      if (urlPath.startsWith('/api/proxy/')) {
        const proxyRoute = urlPath.slice('/api/proxy/'.length);
        const proxyConfig = this._loadApiProxyConfig();
        const matched = proxyConfig && this._matchProxyRoute(proxyRoute, proxyConfig, req);
        if (matched) {
          await this._handleApiProxy(req, res, matched, proxyRoute);
          return;
        }
        if (proxyConfig) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No proxy route matched: ${proxyRoute}`, available: Object.keys(proxyConfig.routes || {}) }));
          return;
        }
      }

      // ── User App Proxy ──
      // If /workspace/.app-port exists, proxy unmatched /api/* requests to that port.
      // Accepts creator auth, webapp session, or manager SSO.
      if (urlPath.startsWith('/api/')) {
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const authType = isAnyAuth(req);
          if (!authType && !checkCreatorAuth(req, res) && !(await tryManagerSSO(req, res))) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required for app proxy' }));
            return;
          }
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'x-request-id', 'x-forwarded-for'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: appPort,
            path: req.url,
            method: req.method,
            headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', (e) => {
            this.log.warn(`[app-proxy] Proxy to :${appPort} failed: ${e.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'App backend unavailable' }));
            }
          });
          req.pipe(proxyReq);
          return;
        }
      }

      // ── /login: serve the standalone login page ──
      if (urlPath === '/login' || urlPath === '/login/') {
        try {
          const p = path.join(__dirname, '..', 'static', 'login.html');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
          });
          res.end(fs.readFileSync(p, 'utf8'));
        } catch { res.writeHead(404); res.end('Login page not found.'); }
        return;
      }


      // ── Static files: webapp auth / OAuth gate ──
      {
        const wUsers = loadWebappUsers();
        const oauthEnabled = await this._isOAuthEnabled();
        const requireAuth = wUsers.length > 0 || oauthEnabled;
        if (requireAuth && !isAnyAuth(req)) {
          const cookies = parseCookies(req);
          const hasMgr = !!cookies['manager_session'];
          this.log.info(`[webapp-gate] ${urlPath} — oauth=${oauthEnabled} hasMgrCookie=${hasMgr} wUsers=${wUsers.length}`);
          let ssoResult;
          if (oauthEnabled && (ssoResult = await tryManagerSSO(req, res, { webappOnly: true }))) {
            this.log.info(`[webapp-gate] OAuth SSO succeeded: ${ssoResult}`);
          }
          else if (!oauthEnabled && (ssoResult = await tryManagerSSO(req, res))) {
            this.log.info(`[webapp-gate] Creator SSO succeeded: ${ssoResult}`);
          }
          else if (oauthEnabled) {
            const proto = this.config.ingressHttps ? 'https' : 'http';
            const domain = this.config.ingressDomain;
            const iPath = (this.config.ingressPath || '').replace(/\/$/, '');
            const returnTo = domain ? `${proto}://${domain}${iPath}${urlPath}` : '';
            const managerUrl = returnTo ? `/manager/?returnTo=${encodeURIComponent(returnTo)}` : '/manager/';
            res.writeHead(302, { 'Location': managerUrl });
            res.end(); return;
          }
          else if (urlPath === '/' || urlPath === '/index.html') {
            const basePath = (this.config.ingressPath || '').replace(/\/$/, '');
            res.writeHead(302, { 'Location': basePath + '/login' });
            res.end(); return;
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
          }
        }
      }

      const serveReqPath = (() => {
        if (urlPath === '/serve') {
          const basePath = String(this._currentSettingValue('ingressPath') ?? this.config.ingressPath ?? '').replace(/\/$/, '');
          res.writeHead(302, { Location: `${basePath}/serve/` });
          res.end();
          return null;
        }
        if (urlPath.startsWith('/serve/')) {
          this._loadServeMounts();
          const rest = urlPath.slice('/serve/'.length);
          const parts = rest.split('/').filter(Boolean);
          const mount = this._safeServeMountName(parts.shift() || '');
          if (!mount) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Served app mount required',
              mounts: [...this._serveMounts.keys()],
            }));
            return null;
          }
          const mounted = this._serveMounts.get(mount);
          if (!mounted) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `Served app mount not found: ${mount}`,
              mounts: [...this._serveMounts.keys()],
            }));
            return null;
          }
          if (parts.length === 0 && !urlPath.endsWith('/')) {
            const basePath = String(this._currentSettingValue('ingressPath') ?? this.config.ingressPath ?? '').replace(/\/$/, '');
            res.writeHead(302, { Location: `${basePath}/serve/${mount}/` });
            res.end();
            return null;
          }
          return {
            dir: mounted.dir,
            path: `/${parts.join('/')}`,
          };
        }
        return { dir: serveDir, path: urlPath };
      })();
      if (serveReqPath == null) return;

      const activeServeDir = serveReqPath.dir || serveDir;
      let filePath = path.join(activeServeDir, serveReqPath.path || '/');

      if (!filePath.startsWith(activeServeDir)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch (e) { this.log.warn('[web] fs.statSync failed: ' + e.message); }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        // If a backend is running, proxy non-file requests to it (SPA routing, etc.)
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch {}
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== webPort) {
          const safeHeaders = { host: `127.0.0.1:${appPort}` };
          const allowProxyHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding', 'cookie'];
          for (const h of allowProxyHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: req.method, headers: safeHeaders,
          }, (proxyRes) => {
            const fwdHeaders = Object.assign({}, proxyRes.headers);
            delete fwdHeaders['access-control-allow-origin'];
            if (allowedOrigin) fwdHeaders['access-control-allow-origin'] = allowedOrigin;
            res.writeHead(proxyRes.statusCode, fwdHeaders);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', () => {
            if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end(`404 Not Found: ${req.url}`); }
          });
          req.pipe(proxyReq);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${req.url}`);
      }
    });

    const mounted = this._registerServeMount(mountName, serveDir);

    server.listen(webPort, '0.0.0.0', () => {
      const isWSL = (() => { try { return require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();
      const hostAddr = isWSL
        ? (require('child_process').execSync('hostname -I', { encoding: 'utf8' }).trim().split(/\s+/)[0] || 'localhost')
        : 'localhost';
      this.log.info(`[web_serve] Serving ${serveDir} on port ${webPort}`);
      this.log.info(`[web_serve] Mounted URL: http://${hostAddr}:${webPort}/serve/${mounted}/`);
    });

    server.on('error', (e) => {
      this.log.error(`[web_serve] Server error: ${e.message}`);
      this._server = null;
    });

    this._server = server;
    this._serverDir = serveDir;

    try { fs.writeFileSync(path.join(this.config.dataDir, '.web-serve-dir'), serveDir); } catch (e) { this.log.warn('[web] fs.writeFileSync failed: ' + e.message); }

    this._setupWebSocket(server, authUser, authPass);

    const pubUrl = this._currentPublicBaseUrl();
    const rootUrl = this._currentWebRootUrl();
    const serveUrl = this._serveUrlForMount(mounted);
    return {
      started: true,
      port: webPort,
      dir: serveDir,
      mount: mounted,
      url: serveUrl ? `${serveUrl}/` : null,
      serveUrl: serveUrl ? `${serveUrl}/` : null,
      rootUrl: rootUrl ? `${rootUrl}/` : '/',
      graphEditor: rootUrl ? `${rootUrl}/graph` : '/graph',
      publicUrl: pubUrl || null,
      mounts: [...this._serveMounts.values()].map(m => ({ name: m.name, dir: m.dir, url: `${this._serveUrlForMount(m.name)}/` })),
      note: serveUrl
        ? `Served app URL: ${serveUrl}/ — files written here are served immediately. Use this mounted URL when sharing the app.`
        : 'Files written to this directory are served immediately — no restart needed. Graph editor at /graph (auth required).',
    };
  }

  // ── Voice Pipeline ──────────────────────────────────────────────────

  _ensureVoicePipeline() {
    if (this._voicePipeline) return this._voicePipeline;
    if (!this.config.voice?.enabled) return null;
    try {
      const { VoicePipeline } = require('../voice');
      this._voicePipeline = new VoicePipeline(this.config, this.log, this.tools?._pluginManager);
      return this._voicePipeline.enabled ? this._voicePipeline : null;
    } catch (e) {
      this.log.warn(`[voice] Pipeline init failed: ${e.message}`);
      return null;
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────────

  _setupWebSocket(httpServer, authUser, authPass) {
    const WebSocket = require('ws');

    const wss = new WebSocket.Server({ noServer: true });
    this._wss = wss;

    const PING_INTERVAL = 15000;
    const pingTimer = setInterval(() => {
      for (const client of wss.clients) {
        if (client._missedPongs >= 2) {
          this.log.warn('[ws] Terminating unresponsive client (2 missed pongs)');
          client.terminate();
          continue;
        }
        client._missedPongs = (client._missedPongs || 0) + 1;
        try { client.ping(); } catch (e) { this.log.warn('[web] client.ping failed: ' + e.message); }
      }
    }, PING_INTERVAL);
	    wss.on('close', () => clearInterval(pingTimer));

	    const hasWebappUsers = () => {
	      try {
	        const p = path.join(this.config.dataDir, 'webapp-users.json');
	        return fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).length > 0;
	      } catch { return false; }
	    };
	    const authConfigured = () => !!(authUser && authPass) || !!(this.config.managerUrl && this.config.managerServiceKey) || hasWebappUsers();
	    const rejectUpgrade = (socket, code, message) => {
	      try {
	        socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	      } catch {}
	      socket.destroy();
	    };
	    const localHostnames = new Set(['localhost', '127.0.0.1', '::1']);
	    const originAllowed = (req) => {
	      const origin = req.headers.origin;
	      if (!origin) return true; // CLI/native clients do not send Origin.
	      try {
	        const o = new URL(origin);
	        const hostHeader = String(req.headers.host || '').split(':')[0];
	        if (localHostnames.has(o.hostname)) return true;
	        if (hostHeader && o.hostname === hostHeader) return true;
	        const pub = this._currentPublicBaseUrl?.();
	        if (pub && o.hostname === new URL(pub).hostname) return true;
	        if (this.config.ingressDomain && o.hostname === this.config.ingressDomain) return true;
	      } catch {}
	      return false;
	    };

	    httpServer.on('upgrade', (req, socket, head) => {
	      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/ws/app') {
        if (authUser && authPass) {
          const cookies = {};
          (req.headers.cookie || '').split(';').forEach(c => {
            const [k, ...v] = c.trim().split('=');
            if (k) cookies[k.trim()] = v.join('=');
          });
          const sid = cookies['spore_session'];
          const sess = sid && _sessions.get(sid);
          if (!sess || (sess.type !== 'creator' && sess.type !== 'admin') || Date.now() - sess.created >= SESSION_TTL) {
            socket.destroy(); return;
          }
        }
        const appPortFile = path.join(this.config.workspacePath || process.cwd(), '.app-port');
        const wPort = this.config.webPort;
        let appPort;
        try { appPort = parseInt(fs.readFileSync(appPortFile, 'utf8').trim(), 10); } catch (e) { this.log.warn('[web] parseInt failed: ' + e.message); }
        if (appPort && appPort > 0 && appPort < 65536 && appPort !== wPort) {
          const safeHeaders = {};
          const allowHeaders = ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
          for (const h of allowHeaders) { if (req.headers[h]) safeHeaders[h] = req.headers[h]; }
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: appPort, path: req.url,
            method: 'GET', headers: safeHeaders,
          });
          proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
              Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
              '\r\n\r\n');
            if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
            proxySocket.pipe(socket).pipe(proxySocket);
            proxySocket.on('error', () => socket.destroy());
            socket.on('error', () => proxySocket.destroy());
          });
          proxyReq.on('error', () => socket.destroy());
          proxyReq.end();
          return;
        }
        socket.destroy(); return;
      }

      if (url.pathname !== '/ws') { socket.destroy(); return; }
      if (!originAllowed(req)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }

      const webSessions = this._webSessions || new Map();
      const token = url.searchParams.get('token');
      let wsRole = null;
      let wsUser = null;
      let tokenSession = null;
      let sourceSessionId = null;
      if (token && webSessions.has(token)) {
        const sess = webSessions.get(token);
        const expiresAt = sess.expiresAt || (sess.created + SESSION_TTL);
        if (Date.now() < expiresAt) {
          wsRole = sess.type || null;
          wsUser = sess.user || null;
          tokenSession = sess;
          sourceSessionId = sess.sourceSession || (!sess.wsTicket ? token : null);
        } else {
          webSessions.delete(token);
          socket.destroy(); return;
        }
      } else if (authUser && authPass && token) {
        const decoded = Buffer.from(token, 'base64').toString();
        const [u, ...pParts] = decoded.split(':');
        if (u !== authUser || pParts.join(':') !== authPass) { socket.destroy(); return; }
        wsRole = 'creator';
      } else if (authUser && authPass) {
        socket.destroy(); return;
      } else if (token) {
        socket.destroy(); return;
      } else if (authConfigured()) {
        rejectUpgrade(socket, 401, 'Unauthorized'); return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._role = wsRole;
        ws._user = wsUser;
        ws._sessionToken = token || null;
        ws._authSessionToken = sourceSessionId || token || null;
        ws._sessionCookieName = wsRole === 'webapp' ? 'spore_webapp' : (wsRole ? 'spore_session' : null);
        ws._deviceId = tokenSession?.deviceId || null;
        ws._sourceSession = sourceSessionId;
        if (token && tokenSession?.singleUse) webSessions.delete(token);
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      const isCliClient = ws._role === 'cli';
      this.log.info(`[ws] Client connected: user=${ws._user || '(anon)'} role=${ws._role || '(none)'}${isCliClient ? ' [cli]' : ''}`);
      ws._missedPongs = 0;
      ws._pendingTools = new Map();
      ws.on('pong', () => { ws._missedPongs = 0; });

      // Capability advertisement. acorn checks this to decide whether to
      // send projectContext as a sibling field (new path — routed into
      // system prompt) or fall back to gluing GatherContext onto message
      // content (old path). Sent unconditionally for every client; non-
      // acorn clients ignore unknown frame types.
      try {
        ws.send(JSON.stringify({
          type: 'capabilities',
          projectContext: true,
          sporeVersion: 'v0.1.0',
          agentDisplayName: this.config.displayName || this.config.agentId || undefined,
        }));
      } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }

      // Acorn clients manage their own session history — don't send web panel history
      if (!isCliClient) {
        try {
          // CRITICAL: never serve DM history to an anonymous socket. Before
          // the user has authenticated, `ws._user` is null — falling back to
          // 'operator' here leaks the operator's entire chat history to any
          // unauthenticated visitor. Silently skip the history block instead;
          // the client will receive history once it reconnects with a valid
          // session token.
          if (this.tools._sessions && ws._user) {
            const sessionKey = this.tools._sessions.constructor.buildKey('web:control-panel', true, ws._user);
            this.log.info(`[ws] history-fetch user=${ws._user} → sessionKey=${sessionKey}`);
            const rows = this.tools._sessions.db.prepare(
              `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
            ).all(sessionKey);
            rows.reverse();
            const history = [];
            // Markers prefixing harness-injected user messages that the
            // operator should never see in the chat scrollback. When one
            // of these is found, ALSO skip the next assistant message \u2014
            // it's the agent's acknowledgement of the cancellation /
            // background task / interjection and reads as orphaned chatter
            // without the prompt that triggered it.
            const INTERNAL_PROMPT_PREFIXES = [
              '[BACKGROUND TASK',
              '[You were working on a task',  // stop / cancel
              '[INTERJECTION]',               // user mid-flight follow-up
              '[TASK COMPLETE',               // delegated-task finish
            ];
            let _swallowNextAssistant = false;
            for (const row of rows) {
              let text = row.content;
              try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                  text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                  if (!text) {
                    const toolResults = parsed.filter(b => b.type === 'tool_result');
                    if (toolResults.length) continue;
                    const toolUses = parsed.filter(b => b.type === 'tool_use');
                    if (toolUses.length) { text = toolUses.map(t => '\u2699 ' + t.name).join(', '); }
                  }
                }
              } catch { /* silent: malformed JSON → fallback */ }
              if (!text || !text.trim()) continue;
              const isInternalPrompt = INTERNAL_PROMPT_PREFIXES.some(p => text.startsWith(p));
              if (isInternalPrompt) {
                _swallowNextAssistant = true;
                continue;
              }
              const role = row.role === 'assistant' ? 'assistant' : row.role === 'notification' ? 'notification' : 'user';
              if (role === 'assistant' && _swallowNextAssistant) {
                _swallowNextAssistant = false;
                continue;
              }
              if (role !== 'assistant') _swallowNextAssistant = false;
              history.push({ role, text: text.substring(0, 2000), ts: row.created });
            }
            if (history.length) {
              ws.send(JSON.stringify({ type: 'chat:history', messages: history }));
            }
          }
        } catch (e) { this.log.warn('[ws] Failed to send chat history:', e.message); }

        // Tell reconnecting web clients if the agent is mid-turn so they restore busy state.
        // Skip anon sockets — they have no session of their own to be busy on,
        // and mapping them to operator would make every anonymous visitor
        // appear "busy" whenever the operator has a run going.
        if (ws._user) {
          try {
            const agent = this.tools._agent;
            const userId = ws._user;
            const activeKeys = agent ? [...agent.activeRuns] : [];
            this.log.info(`[ws] Connect: user=${userId}, activeRuns=${activeKeys.length > 0 ? activeKeys.join(',') : 'none'}`);
            if (agent && activeKeys.length > 0) {
              const myKey = `dm:${userId}`;
              const webBusy = activeKeys.includes(myKey);
              if (webBusy) {
                ws.send(JSON.stringify({ type: 'chat:busy' }));
                this.log.info(`[ws] Sent chat:busy to reconnecting client (own session ${myKey} active)`);
              }
            }
          } catch (e) { this.log.warn('[ws] Busy check failed:', e.message); }
        } else {
          this.log.info(`[ws] Connect: user=(anon), activeRuns=(skipped — not authenticated)`);
        }
      }

      // Graph events: web panel gets the full firehose (node/edge/tool
      // mutations) so the dock event log + viz can react in real time.
      // CLI clients (acorn) get the read-path events only — recall:*
      // and similar low-volume per-turn events — so the TUI activity
      // panel can show recall activity without being flooded by every
      // graph mutation the agent makes.
      const CLI_FORWARD_OPS = new Set(['recall:start', 'recall:decompose', 'recall:empty', 'recall:fail']);
      const onGraphEvent = (evt) => {
        if (isCliClient) {
          const op = String(evt?.op || '');
          if (!CLI_FORWARD_OPS.has(op)) return;
          if (!this._sessionKeyClientMatches(ws, evt?.sessionKey, evt?.channelId)) return;
        }
        const out = this._decorateGraphEventForClient(evt || {});
        try { ws.send(JSON.stringify({ type: 'graph:event', ...out })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
      };
      graphEvents.on('change', onGraphEvent);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const msgType = typeof msg.type === 'string' ? msg.type : '';
        if (msgType !== 'ping' && ws._role !== 'cli' && ws._sourceSession && authConfigured()) {
          const webSessions = this._webSessions || new Map();
          const sess = webSessions.get(ws._sourceSession);
          const expired = sess && Date.now() - sess.created >= SESSION_TTL;
          const mismatch = sess && (sess.user !== ws._user || sess.type !== ws._role);
          if (!sess || expired || mismatch) {
            if (expired) webSessions.delete(ws._sourceSession);
            this.log.warn(`[ws] closing stale web auth socket for user=${ws._user || '(unknown)'} reason=${!sess ? 'missing-session' : expired ? 'expired-session' : 'session-mismatch'}`);
            ws._user = null;
            ws._role = null;
            ws._sourceSession = null;
            try {
              ws.send(JSON.stringify({
                type: 'auth:error',
                error: 'Session expired — reload the page and log in again.',
                code: 'auth-required',
              }));
              ws.close(4001, 'session expired');
            } catch (e) { this.log.warn('[web] ws auth-expire send failed: ' + e.message); }
            return;
          }
        }
        const isAuthenticated = !!(ws._user || ws._role);
        const isCreatorWs = ws._role === 'creator' || ws._role === 'admin';
        const requireAuthenticated = () => {
          if (isAuthenticated || !authConfigured()) return true;
          try { ws.send(JSON.stringify({ type: 'auth:error', error: 'Authentication required', code: 'auth-required' })); } catch {}
          return false;
        };
        const requireCreatorWs = () => {
          if (isCreatorWs) return true;
          try { ws.send(JSON.stringify({ type: 'auth:error', error: 'Creator authentication required', code: 'creator-required' })); } catch {}
          return false;
        };
        if (msgType !== 'ping' && !requireAuthenticated()) return;
        if (msgType === 'code:save' && !requireCreatorWs()) return;
        if (msgType.startsWith('terminal:') && !requireCreatorWs()) return;
        if ((msgType === 'tool:ack' || msgType === 'tool:result' || msgType === 'tool:awaiting-approval' || msgType === 'tool:approval-resolved' || msgType === 'perm:current-mode') && ws._role !== 'cli') {
          try { ws.send(JSON.stringify({ type: 'auth:error', error: 'CLI role required', code: 'cli-required' })); } catch {}
          return;
        }

	        // Plugin WS dispatch — message types of the form `plugin:<pluginId>:<msgType>`
        // route to handlers registered via api.registerWsHandler. The pluginId
        // namespace prevents collisions with built-in types like 'chat:submit'.
        if (typeof msg.type === 'string' && msg.type.startsWith('plugin:')) {
	          const mgr = this.tools?._pluginManager;
	          const resolved = mgr?.resolveWsHandler?.(msg.type);
	          if (resolved) {
	            if (resolved.pluginId === 'spore-code' && ws._role !== 'cli') {
	              try { ws.send(JSON.stringify({ type: 'auth:error', error: 'CLI role required', code: 'cli-required' })); } catch {}
	              return;
	            }
	            try {
	              await resolved.handler(ws, msg, { user: ws._user, sessionId: msg.sessionId, log: this.log });
            } catch (e) {
              this.log.warn(`[plugins] WS handler ${msg.type} threw: ${e.message}`);
            }
            return;
          }
          // Fall through to default unknown-type handling if nothing matched.
        }

        // Plugin WS-frame dispatch — any namespaced frame (containing
        // a `:`) gets a chance to route to a plugin handler. The
        // `session:*` family was the original use case; new contracts
        // (`code_graph:summary`, `save_project_script:from_file`,
        // future plugin protocols) ride the same routing.
        // session:observe and session:unobserve still fall through to
        // the in-tree handlers when no plugin claims them, because
        // those handlers need the gateway-internal _sessionClients
        // fan-out map.
        if (typeof msg.type === 'string' && msg.type.includes(':') && msg.type !== 'tool:result' && msg.type !== 'tool:approval-resolved') {
	          const mgr = this.tools?._pluginManager;
	          const resolved = mgr?.resolveBareWsHandler?.(msg.type);
	          if (resolved) {
	            if (resolved.pluginId === 'spore-code' && ws._role !== 'cli') {
	              try { ws.send(JSON.stringify({ type: 'auth:error', error: 'CLI role required', code: 'cli-required' })); } catch {}
	              return;
	            }
	            try {
              await resolved.handler(ws, msg, { user: ws._user, sessionId: msg.sessionId, log: this.log });
            } catch (e) {
              this.log.warn(`[plugins] WS handler ${msg.type} (plugin:${resolved.pluginId}) threw: ${e.message}`);
            }
            return;
          }
          // Fall through — session:observe/unobserve and other in-tree
          // handlers below still need to run when no plugin claims them.
        }

        if (msg.type === 'ping') {
          ws._missedPongs = 0;
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
          return;
        }

        // Answer to an ask_user tool call — resolves the pending promise on
        // the tools side so the agent's tool_result returns cleanly.
        if (msg.type === 'ask_user_answer' && msg.qid && typeof msg.answer === 'string') {
          const pending = typeof this.tools.getPendingAskUser === 'function'
            ? this.tools.getPendingAskUser(msg.qid)
            : null;
          if (!pending || !this._askUserAnswerMatchesClient(ws, msg, pending)) {
            this.log.warn(`[ask_user] Rejected answer for qid=${msg.qid}: session mismatch or no pending question`);
            try {
              ws.send(JSON.stringify({
                type: 'ask_user_answer_ack',
                qid: msg.qid,
                ok: false,
                error: pending ? 'session-mismatch' : 'not-found',
              }));
            } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
            return;
          }
          const ok = this.tools.answerAskUser(msg.qid, msg.answer, pending.sessionKey);
          try { ws.send(JSON.stringify({ type: 'ask_user_answer_ack', qid: msg.qid, ok })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
          return;
        }

        if (msg.type === 'code:save') {
          try {
            const result = this.tools.executeTool('write_file', { path: msg.path, content: msg.content });
            // executeTool may be sync (write_file is sync) or async
            const handleResult = (r) => {
              if (r && r.error) {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: r.error }));
              } else {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, success: true, bytes: r?.bytes }));
                this.log.info(`[code-viewer] User saved ${msg.path} (${msg.content?.length || 0} chars)`);
              }
            };
            if (result && typeof result.then === 'function') {
              result.then(handleResult).catch(e => {
                ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
              });
            } else {
              handleResult(result);
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'code:saved', path: msg.path, error: e.message }));
          }
          return;
        }

        // ── Acorn: request history for a specific session ──
        if (msg.type === 'chat:history-request' && msg.sessionId) {
          try {
            if (this.tools._sessions) {
              const reqSessionId = msg.sessionId;
              const isCli = _isCliChatSession(ws, reqSessionId);
              const userId = ws._user || 'operator';
              // Use legacy buildKey format to match how processMessage stores messages
              const historyKey = isCli
                ? this.tools._sessions.constructor.buildKey(reqSessionId, false, userId)
                : this.tools._sessions.constructor.buildKey(reqSessionId, true, userId);
              const rows = this.tools._sessions.db.prepare(
                `SELECT role, content, created FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT 60`
              ).all(historyKey);
              rows.reverse();
              const history = [];
              for (const row of rows) {
                let text = row.content;
                try {
                  const parsed = JSON.parse(text);
                  if (Array.isArray(parsed)) {
                    text = parsed.filter(b => b.type === 'text').map(b => b.text).join('\n');
                    if (!text) continue;
                  }
                } catch { /* silent: malformed JSON → fallback */ }
                if (!text || !text.trim()) continue;
                const role = row.role === 'assistant' ? 'assistant' : 'user';
                history.push({ role, text: text.substring(0, 2000), ts: row.created });
              }
              ws.send(JSON.stringify({ type: 'chat:history', messages: history, sessionId: reqSessionId }));
              this.log.info(`[ws] History sent for ${reqSessionId}: ${history.length} messages`);
            }
          } catch (e) { this.log.warn('[ws] History request failed:', e.message); }
          return;
        }

        // ── Acorn: observe/unobserve session (companion app) ──
        if (msg.type === 'session:observe' && msg.sessionId) {
          const reqUser = ws._user || '';
          // Validate user owns this session
          if (!msg.sessionId.startsWith(`cli:${reqUser}@`)) {
            ws.send(JSON.stringify({ type: 'session:observe:error', error: 'Access denied' }));
            return;
          }
          this._registerSessionClient(msg.sessionId, ws, 'observer');
          const agent = this.tools._agent;
          const sessionKey = this.tools._sessions.constructor.buildKey(msg.sessionId, false, reqUser);
          const active = agent ? agent.activeRuns.has(sessionKey) : false;
          // Check if the CLI origin client is connected
          let cliConnected = false;
          const sessionClients = this._sessionClients.get(msg.sessionId);
          if (sessionClients) {
            for (const entry of sessionClients) {
              if (entry.ws !== ws && entry.ws.readyState === 1) { cliConnected = true; break; }
            }
          }
          ws.send(JSON.stringify({ type: 'session:observe:ok', sessionId: msg.sessionId, active, cliConnected }));
          // Ask the CLI for its current perm mode so the observer can sync
          const clients = this._sessionClients.get(msg.sessionId);
          if (clients) {
            for (const entry of clients) {
              if (entry.ws !== ws) {
                try { entry.ws.send(JSON.stringify({ type: 'perm:query', replyTo: msg.sessionId })); } catch (e) { this.log.warn('[web] entry.ws.send failed: ' + e.message); }
              }
            }
          }
          this.log.info(`[ws] ${reqUser} observing session ${msg.sessionId}`);
          return;
        }

        if (msg.type === 'session:unobserve' && msg.sessionId) {
          this._unregisterSessionClient(msg.sessionId, ws);
          this.log.info(`[ws] ${ws._user || '?'} stopped observing ${msg.sessionId}`);
          return;
        }

        // ── Acorn: CLI tells us it's waiting for user to approve a tool ──
        if (msg.type === 'tool:awaiting-approval') {
          const toolName = msg.name || msg.toolName || msg.tool_name || msg.tool || msg.action || 'unknown';
          const toolSummary = msg.summary || msg.description || msg.command || msg.input?.command || msg.input?.path || '';
          let toolId = msg.id || msg.toolId || msg.tool_id || null;
          const pendingTool = _findCliPendingTool(ws, toolId, toolName);
          if (pendingTool.entry) {
            toolId = pendingTool.id || toolId;
            pendingTool.entry.awaitingApproval = true;
            pendingTool.entry.approvalStartedAt = Date.now();
            if (pendingTool.entry.timeout) clearTimeout(pendingTool.entry.timeout);
            if (pendingTool.entry.executionStartDelay) clearTimeout(pendingTool.entry.executionStartDelay);
            pendingTool.entry.timeout = null;
            pendingTool.entry.executionStartDelay = null;
          }
          // Forward to all session observers so they can show [allow]/[deny]
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws && entry.role === 'origin') {
                this._sendToSession(sid, {
                  type: 'tool:awaiting-approval',
                  id: toolId,
                  name: toolName,
                  summary: toolSummary,
                  dangerous: !!msg.dangerous,
                });
                this.log.info(`[ws] Tool awaiting approval: ${toolName} (${toolSummary || 'no summary'}), timer paused`);
                break;
              }
            }
          }
          return;
        }

        // ── Acorn: any session client approves/denies a pending tool ──
        if (msg.type === 'tool:approve') {
          // Find a different client in the same session that has _pendingTools (the CLI)
          for (const [sid, clients] of this._sessionClients) {
            let isMember = false;
            let cliWs = null;
            for (const entry of clients) {
              if (entry.ws === ws) isMember = true;
              // The CLI is the one with pending tools (not the sender)
              if (entry.ws !== ws && entry.ws._pendingTools?.size > 0) cliWs = entry.ws;
            }
            if (isMember && cliWs) {
              try {
                cliWs.send(JSON.stringify({
                  type: 'tool:approval-resolved',
                  id: msg.id,
                  allowed: !!msg.allowed,
                }));
              } catch (e) { this.log.warn('[web] cliWs.send failed: ' + e.message); }
              this.log.info(`[ws] Remote ${msg.allowed ? 'approve' : 'deny'} for tool from ${ws._user}`);
              break;
            }
          }
          return;
        }

        // ── Acorn: plan decision (execute/revise/cancel) forwarded to other clients ──
        // ── Generic interactive state broadcast — forward to all other session clients ──
        // ── Forward plan:show-approval and interactive:resolved to other session clients ──
        if (msg.type === 'delegate:config' || msg.type === 'state:questions') {
          this._forwardToSessionPeers(ws, msg);
          return;
        }

        if (msg.type === 'plan:show-approval') {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] plan:show-approval forwarded from ${ws._user} to ${n} client(s)`);
          return;
        }

        if (msg.type === 'interactive:resolved') {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] interactive:resolved kind=${msg.kind} from ${ws._user} forwarded to ${n} client(s)`);
          return;
        }

        if (msg.type === 'plan:decision' || msg.type === 'plan:decided') {
          this._forwardToSessionPeers(ws, msg);
          if (msg.type === 'plan:decision') this.log.info(`[ws] Plan ${msg.action} from ${ws._user}`);
          return;
        }

        // ── Acorn: any session client toggles plan mode ──
        if (msg.type === 'plan:set-mode') {
          this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] Remote plan mode ${msg.enabled ? 'on' : 'off'} from ${ws._user}`);
          return;
        }

        // ── Acorn: CLI responds with its current perm mode ──
        if (msg.type === 'perm:current-mode' && msg.mode) {
          this._forwardToSessionPeers(ws, msg);
          return;
        }

        // ── Acorn: any session client changes CLI permission mode ──
        if (msg.type === 'perm:set-mode' && msg.mode) {
          const n = this._forwardToSessionPeers(ws, msg);
          this.log.info(`[ws] Remote perm mode change to ${msg.mode} from ${ws._user}, forwarded to ${n} client(s), sessionId=${msg.sessionId || 'none'}`);
          return;
        }

        // ── Acorn: tool result from CLI client ──
        // ── CLI acknowledges it received a tool:request ──
        if (msg.type === 'tool:ack' && msg.id) {
          const pending = ws._pendingTools?.get(msg.id);
          if (pending) {
            pending.acked = true;
            if (pending.ackTimeout) clearTimeout(pending.ackTimeout);
            pending.ackTimeout = null;
            if (!pending.awaitingApproval && !pending.timeout && !pending.executionStartDelay) {
              pending.executionStartDelay = setTimeout(() => {
                pending.executionStartDelay = null;
                if (!pending.awaitingApproval && ws._pendingTools?.get(msg.id) === pending) {
                  _startCliPendingToolTimer(ws, msg.id, pending, 'ack');
                }
              }, 1000);
            }
          }
          return;
        }

        if (msg.type === 'tool:approval-resolved') {
          const toolName = msg.name || msg.toolName || msg.tool_name || msg.tool || msg.action || '';
          let toolId = msg.id || msg.toolId || msg.tool_id || null;
          const pendingTool = _findCliPendingTool(ws, toolId, toolName);
          const pending = pendingTool.entry;
          if (pending) {
            toolId = pendingTool.id || toolId;
            pending.awaitingApproval = false;
            pending.approvedAt = Date.now();
            if (pending.executionStartDelay) clearTimeout(pending.executionStartDelay);
            pending.executionStartDelay = null;
            if (msg.allowed !== false) {
              _startCliPendingToolTimer(ws, toolId, pending, 'approval');
            }
          }
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws && entry.role === 'origin') {
                this._sendToSession(sid, {
                  type: 'tool:approval-resolved',
                  id: toolId,
                  name: toolName || pending?.name || 'unknown',
                  allowed: msg.allowed !== false,
                });
                break;
              }
            }
          }
          return;
        }

        if (msg.type === 'tool:result') {
          const pending = ws._pendingTools?.get(msg.id);
          if (pending) {
            _clearCliPendingToolTimers(pending);
            ws._pendingTools.delete(msg.id);
            pending.resolve(msg.result);
            // Notify observers the tool was resolved
            const denied = msg.result && msg.result.error && /denied|blocked/i.test(msg.result.error);
            // Find which session this ws belongs to, notify observers
            for (const [sid, clients] of this._sessionClients) {
              for (const entry of clients) {
                if (entry.ws === ws) {
                  this._sendToSession(sid, { type: 'tool:resolved', id: msg.id, denied: !!denied });
                  break;
                }
              }
            }
          }
          return;
        }

        if (msg.type === 'chat:stop') {
          if (this.tools._agent) {
            const userId = ws._user || 'operator';
            const sessionId = msg.sessionId || 'web:control-panel';
            const isCli = _isCliChatSession(ws, sessionId);
            const stopped = isCli
              ? this.tools._agent.abortSession(sessionId, false, userId)
              : this.tools._agent.abortSession('web:control-panel', true, userId);
            this.log.info(`[ws] Stop requested for ${userId} — ${stopped ? 'aborted' : 'no active run'}`);
            if (stopped) {
              try { ws.send(JSON.stringify({ type: 'chat:status', status: 'stopping' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              // Reject any pending tool Promises on the CLI's WebSocket so the
              // agent loop breaks out immediately instead of waiting 3 minutes
              const originWs = isCli ? this._getOriginClient(sessionId) : null;
              if (originWs && originWs._pendingTools?.size > 0) {
                for (const [toolId, entry] of originWs._pendingTools) {
                  _clearCliPendingToolTimers(entry);
                  entry.resolve({ error: 'Aborted by user.' });
                }
                originWs._pendingTools.clear();
                this.log.info(`[ws] Rejected pending tool(s) for abort`);
              }
            }
          }
          return;
        }

        if (msg.type === 'chat:clear') {
          if (this.tools._sessions) {
            const userId = ws._user || 'operator';
            const clearSessionId = msg.sessionId || 'web:control-panel';
            const isCli = _isCliChatSession(ws, clearSessionId);
            const clearKey = isCli
              ? this.tools._sessions.constructor.buildKey(clearSessionId, false, userId)
              : this.tools._sessions.constructor.buildKey('web:control-panel', true, userId);
            this.tools._sessions.clearSession(clearKey);
            ws.send(JSON.stringify({ type: 'chat:cleared' }));
            this.log.info(`[ws] Chat history cleared by ${userId}${isCli ? ` (cli: ${clearSessionId})` : ''}`);
          }
          return;
        }

        if (_isChatSubmitType(msg.type)) {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'chat:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = msg.sessionId || 'web:control-panel';
          const isCli = _isCliChatSession(ws, sessionId);
          // If auth is required (webapp users exist or manager URL is set), refuse
          // anonymous chat — otherwise every user's messages collapse into the same
          // 'dm:operator' session and the agent can't tell them apart.
          let hasWebappUsers = false;
          try {
            const wuPath = path.join(this.config.dataDir, 'webapp-users.json');
            hasWebappUsers = fs.existsSync(wuPath) && JSON.parse(fs.readFileSync(wuPath, 'utf8')).length > 0;
          } catch (e) { this.log.warn('[web] path.join failed: ' + e.message); }
          const requiresChatAuth = hasWebappUsers || !!this.config.managerUrl || !!(this.config.webAuthUser && this.config.webAuthPass);
          if (requiresChatAuth && !isCli && !ws._user) {
            this.log.warn(`[ws] chat refused — no authenticated user on this connection (token=${ws._sessionToken ? 'stale' : 'missing'})`);
            ws.send(JSON.stringify({ type: 'chat:error', error: 'Session expired — reload the page and log in again.', code: 'auth-required' }));
            return;
          }
          this.log.info(`[ws] chat from user=${ws._user || '(anon)'} role=${ws._role || '(none)'} displayName=${(msg.userName || '').slice(0, 40)} sessionId=${sessionId}`);

          const userId = ws._user || 'operator';
          const effectiveUserRole = isCli
            ? (ws._role || 'cli')
            : (ws._role === 'cli'
              ? _lookupWebappUserRole(this.config.dataDir, userId, 'webapp')
              : (ws._role || 'creator'));
          const activeSessionKey = this.tools._sessions?.constructor?.buildKey(
            isCli ? sessionId : 'web:control-panel',
            !isCli,
            userId
          );
          if (activeSessionKey && typeof this.tools.answerAskUserForSession === 'function') {
            const pendingAsk = this.tools.answerAskUserForSession(activeSessionKey, msg.content || '');
            if (pendingAsk?.ok) {
              const ack = { type: 'ask_user_answer_ack', qid: pendingAsk.qid, ok: true, answer: pendingAsk.answer };
              const status = { type: 'chat:status', status: 'ask_user_answered', qid: pendingAsk.qid, answer: pendingAsk.answer };
              if (isCli) {
                this._sendToSession(sessionId, ack);
                this._sendToSession(sessionId, status);
              } else {
                try { ws.send(JSON.stringify(ack)); ws.send(JSON.stringify(status)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              }
              this.log.info(`[ask_user] Answered pending question for ${activeSessionKey}: ${pendingAsk.answer}`);
              return;
            }
            if (pendingAsk?.pending) {
              const cancelled = typeof this.tools.cancelSessionAskUser === 'function'
                ? this.tools.cancelSessionAskUser(activeSessionKey)
                : [];
              const labels = (pendingAsk.options || []).map((o, i) => `${i + 1}. ${o.label}`).join(' | ');
              const status = {
                type: 'chat:status',
                status: 'ask_user_superseded',
                qid: pendingAsk.qid,
                mode: pendingAsk.mode || 'single',
                question: pendingAsk.question,
                message: 'Previous picker was cancelled; treating your message as the new instruction.',
              };
              if (isCli) this._sendToSession(sessionId, status);
              else { try { ws.send(JSON.stringify(status)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
              this.log.info(`[ask_user] Superseded ${cancelled.length || 0} pending question(s) for ${activeSessionKey}; routing unmatched chat as a new message${labels ? ` (${labels})` : ''}`);
            }
          }

          // Store the client's working directory (sent by Spore Code)
          if (msg.cwd && isCli) ws._cwd = msg.cwd;

          // Register this client for the session.
          // If the client is already an observer (companion app), keep that role —
          // don't promote to origin or it will evict the CLI's origin registration.
          if (isCli) {
            const existingClients = this._sessionClients.get(sessionId);
            let isObserver = false;
            if (existingClients) {
              for (const entry of existingClients) {
                if (entry.ws === ws && entry.role === 'observer') { isObserver = true; break; }
              }
            }
            if (!isObserver) {
              this._registerSessionClient(sessionId, ws, 'origin');
            }
            // Echo user message to all OTHER session clients so observers see it
            // Use displayText (clean user text) if available, not content (which includes context/delegation policy)
            const clients = this._sessionClients.get(sessionId);
            if (clients) {
              const echoPayload = JSON.stringify({
                type: 'chat:user-message',
                text: (msg.displayText || msg.content || '').substring(0, 2000),
                userName: ws._user || msg.userName || 'user',
                sessionId,
              });
              for (const { ws: c } of clients) {
                if (c !== ws && c.readyState === 1) {
                  try { c.send(echoPayload); } catch (e) { this.log.warn('[web] c.send failed: ' + e.message); }
                }
              }
            }
          }

          try {
            // Acorn fans out to all session clients (CLI + observer mobile apps).
            // Web users are isolated — chat:start only goes to the sending socket.
            if (!isCli) {
              try { ws.send(JSON.stringify({ type: 'chat:start', sessionId })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
            } else {
              this._sendToSession(sessionId, { type: 'chat:start', sessionId });
            }
            const images = Array.isArray(msg.images) ? msg.images.map(img => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.data },
            })) : undefined;
            const media = Array.isArray(msg.files) ? msg.files.flatMap(f => {
              const mediaType = String(f.mediaType || '').toLowerCase();
              if (mediaType.startsWith('audio/')) {
                return [{
                  type: 'audio',
                  source: {
                    type: 'base64',
                    media_type: f.mediaType || 'application/octet-stream',
                    data: f.data,
                    filename: f.name || 'audio-input',
                  },
                }];
              }
              if (mediaType.startsWith('video/')) {
                return [{
                  type: 'video',
                  source: {
                    type: 'base64',
                    media_type: f.mediaType || 'application/octet-stream',
                    data: f.data,
                    filename: f.name || 'video-input',
                  },
                }];
              }
              return [];
            }) : undefined;
            // Save non-image file attachments to disk
            let fileNote = '';
            if (Array.isArray(msg.files) && msg.files.length > 0) {
              const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
              try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { this.log.warn('[web] fs.mkdirSync failed: ' + e.message); }
              const savedFiles = [];
              for (const f of msg.files) {
                try {
                  const safeName = (f.name || `file-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                  const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
                  fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
                  savedFiles.push(filePath);
                  this.log.info(`[upload] Saved file to ${filePath}`);
                } catch (e) { this.log.warn(`[upload] Failed: ${e.message}`); }
              }
              if (savedFiles.length) fileNote = `\n[Attached files saved to disk: ${savedFiles.join(', ')}]`;
            }

            // For Acorn: find the origin CLI client for tool execution.
            // If an observer (mobile app) sends a message, tools still go to the CLI.
            const originWs = isCli ? (this._getOriginClient(sessionId) || ws) : null;
            const modelRoutingOverride = isCli ? this._sporeCodeRoutingOverride(ws._deviceId) : null;

            // Debug: log the projectContext.mode acorn sent so we can
            // tell whether "plan mode didn't behave as plan mode" is a
            // client-side bug (mode not sent) or server-side (mode
            // sent but prompt didn't activate).
            if (isCli) {
              const mode = msg.projectContext?.mode || '(none)';
              const hasPC = msg.projectContext ? 'yes' : 'no';
              this.log.info(`[cli-chat] sessionId=${sessionId} projectContext=${hasPC} mode=${mode} content=${JSON.stringify((msg.content || '').slice(0, 80))}`);
            }

            // Plan-mode reminder — when acorn signals plan mode via
            // projectContext.mode='plan', prepend a tiny inline marker
            // onto the user's message. The full PLAN_PREFIX block lives
            // in the system prompt (prompt-sections.js), but the model
            // pays much more attention to instructions adjacent to the
            // user's actual content. Python glued the entire 1KB prefix;
            // we keep that signal-strength advantage with ~150 bytes.
            // The marker also makes it impossible to miss in the
            // session log when debugging "did the agent know it was
            // in plan mode?".
            let userContent = msg.content + fileNote;
            if (isCli && msg.projectContext && msg.projectContext.mode === 'plan') {
              // Skip the inline marker for multi-stage workflow sentinels
              // ([RESEARCH], [REVIEW], [BUILD_PLAN]) — those messages carry
              // their own phase-specific intent and the system prompt for
              // that phase has the right instructions. Prepending the
              // generic "End with PLAN_READY" marker contradicts the
              // RESEARCH/ROUTER 2 prompts (which forbid PLAN_READY) and
              // the agent honors the user-message marker over the system
              // prompt — that's the bug that caused research turns to
              // emit a plan instead of RESEARCH_DONE.
              const trimmed = userContent.trimStart();
              const isStageSentinel = trimmed.startsWith('[RESEARCH]') || trimmed.startsWith('[RESEARCH ')
                                   || trimmed.startsWith('[REVIEW]')   || trimmed.startsWith('[REVIEW ')
                                   || trimmed.startsWith('[BUILD_PLAN]') || trimmed.startsWith('[BUILD_PLAN ');
              if (!isStageSentinel) {
                userContent = '[PLAN MODE — read your ## Plan Mode system prompt section. Do NOT call write_file/edit_file/exec. Follow the phase instructions there.]\n\n' + userContent;
              }
            }

            const agentOpts = {
              content: userContent,
              channelId: sessionId,
              channelName: isCli ? `cli:${ws._user}` : 'control-panel',
              // userId is server-trusted (from the authenticated WS session)
              // to prevent spoofing another user's conversation. The client's
              // msg.userId is ignored — only ws._user matters.
              userId,
              // userName is a display string only; client-chosen is fine.
              userName: msg.userName || ws._user || 'Operator',
              // Role comes from the WS session (server-trusted). The agent
              // uses this to decide what it will / won't agree to do for
              // non-creator users.
              userRole: effectiveUserRole,
              sessionToken: ws._authSessionToken || null,
              sessionCookieName: ws._sessionCookieName || null,
              deviceId: isCli ? (ws._deviceId || null) : null,
              modelRoutingOverride,
              trigger: 'dm',
              platform: isCli ? 'cli' : 'web',
              isDm: !isCli,
              clientCwd: ws._cwd || null,
              // projectContext is the structured project metadata acorn sends
              // on every chat:submit. The agent loop routes this into the
              // SYSTEM PROMPT instead of the user message — so the project
              // info doesn't accumulate in messages[] across turns. Old
              // acorn builds don't send this field; we just pass undefined
              // and the prompt builder skips the section.
              projectContext: msg.projectContext || null,
              images,
              media,
              onTextDelta: (delta) => {
                if (isCli) {
                  this._sendToSession(sessionId, { type: 'chat:delta', text: delta });
                } else {
                  try { ws.send(JSON.stringify({ type: 'chat:delta', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
                }
              },
              onThinkingDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'chat:thinking', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
              onToolUse: (toolName) => {
                if (isCli) {
                  this._sendToSession(sessionId, { type: 'chat:tool', tool: toolName });
                } else {
                  try { ws.send(JSON.stringify({ type: 'chat:tool', tool: toolName })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
                }
              },
              onStatus: (evt) => {
                try {
                  const payload = evt.type?.startsWith('code:') ? evt
                    : { type: 'chat:status', status: evt.type, ...Object.fromEntries(Object.entries(evt).filter(([k]) => k !== 'type')) };
                  if (isCli) {
                    this._sendToSession(sessionId, payload);
                  } else {
                    ws.send(JSON.stringify(payload));
                  }
                } catch (e) { this.log.warn('[web] startsWith failed: ' + e.message); }
              },
              // Acorn: forward tool calls to the origin CLI client for local execution.
              // tool:request only goes to origin client. Observers get tool:pending notification.
              onToolExecute: isCli ? async (toolName, toolInput, toolId) => {
                const requiresCliExecutor = !!this.tools?.isCliLocalTool?.(toolName);
                const forceServerExecutor = !!this.tools?.isCliServerTool?.(toolName);
                if (forceServerExecutor || !requiresCliExecutor) return null;

                // Notify observers that a tool is awaiting approval/execution
                const summary = toolName === 'exec' ? (toolInput?.command || '').substring(0, 120)
                  : toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file' ? (toolInput?.path || '')
                  : toolName === 'web_fetch' ? (toolInput?.url || '').substring(0, 100)
                  : JSON.stringify(toolInput || {}).substring(0, 80);
                this._sendToSession(sessionId, {
                  type: 'tool:pending', id: toolId, name: toolName, summary,
                });

                // Check if CLI is actually reachable before waiting
                if (!originWs || originWs.readyState !== 1) {
                  this.log.warn(`[ws] CLI disconnected for local tool ${toolName}`);
                  return {
                    error: `The ${toolName} tool must be handled by the connected Spore Code CLI executor for this project session.`,
                    blocked: true,
                    tool: toolName,
                    cliLocalOnly: true,
                  };
                }

                return new Promise((resolve, reject) => {
                  // Hard timeout is for actual execution, not time spent waiting
                  // for the operator to approve the CLI permission prompt.
                  // The timer starts after acks settle for no-approval tools, or
                  // fresh after tool:approval-resolved for approval-gated tools.
                  const timeoutMs = _cliForwardedToolTimeoutMs(toolName, toolInput);
                  const entry = {
                    resolve,
                    reject,
                    timeout: null,
                    ackTimeout: null,
                    executionStartDelay: null,
                    timeoutMs,
                    requestedAt: Date.now(),
                    startedAt: null,
                    name: toolName,
                    input: toolInput,
                    awaitingApproval: false,
                    approvedAt: null,
                    acked: false,
                  };
                  originWs._pendingTools.set(toolId, entry);
                  entry.ackTimeout = setTimeout(() => {
                    entry.ackTimeout = null;
                    if (!entry.acked && !entry.awaitingApproval && originWs._pendingTools?.get(toolId) === entry) {
                      _startCliPendingToolTimer(originWs, toolId, entry, 'ack-timeout');
                    }
                  }, 2000);
                  try {
                    originWs.send(JSON.stringify({ type: 'tool:request', id: toolId, name: toolName, input: toolInput }));
                  } catch (e) {
                    _clearCliPendingToolTimers(entry);
                    originWs._pendingTools.delete(toolId);
                    this.log.warn(`[ws] Failed to send tool:request to CLI: ${e.message}`);
                    if (requiresCliExecutor) {
                      resolve({
                        error: `The ${toolName} tool must be handled by the connected Spore Code CLI executor for this project session.`,
                        blocked: true,
                        tool: toolName,
                        cliLocalOnly: true,
                      });
                    } else {
                      resolve(null); // server-side tool fallback
                    }
                  }
                });
              } : undefined,
            };

            let result = await this._submitAgentTurn(agentOpts, {
              lane: 'interactive',
              priority: isCli ? 105 : 100,
              route: isCli ? 'cli.chat' : 'web.chat',
              allowInterjection: true,
            });

            if (result?.interjected) {
              this.log.info(`[ws] Interjection accepted for ${sessionId}`);
              const payload = { type: 'chat:status', status: 'interjected' };
              if (isCli) { this._sendToSession(sessionId, payload); }
              else { try { ws.send(JSON.stringify(payload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
              return;
            }

            // Handle interjection: session was busy, try to inject into running loop
            if (result.skipped) {
              const userId = ws._user || 'operator';
              const waitKey = this.tools._sessions.constructor.buildKey(
                isCli ? sessionId : 'web:control-panel', !isCli, userId
              );

              // Pass agentOpts so the loop can detect a mode toggle
              // (plan↔execute) carried by this message and rebuild the
              // system prompt before the next iteration.
              const injected = this.tools._agent.interject(waitKey, msg.content + fileNote, agentOpts);
              if (injected) {
                // Loop will pick it up on next iteration — notify client and return
                this.log.info(`[ws] Interjection accepted for ${sessionId}`);
                const payload = { type: 'chat:status', status: 'interjected' };
                if (isCli) { this._sendToSession(sessionId, payload); }
                else { try { ws.send(JSON.stringify(payload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                return; // Don't send chat:done — the running loop handles completion
              }

              // Injection failed (loop is aborting after Ctrl+C) — wait for release + retry
              this.log.info(`[ws] Interjection failed (aborting?), waiting for session release: ${sessionId}`);
              const statusPayload = { type: 'chat:status', status: 'waiting' };
              if (isCli) { this._sendToSession(sessionId, statusPayload); }
              else { try { ws.send(JSON.stringify(statusPayload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }

              try {
                await Promise.race([
                  this.tools._agent.waitForSession(waitKey),
                  new Promise((_, rej) => setTimeout(() => rej(new Error('Interjection wait timed out')), 15000)),
                ]);
                // Re-send chat:start for the retry
                if (isCli) { this._sendToSession(sessionId, { type: 'chat:start', sessionId }); }
                else { try { ws.send(JSON.stringify({ type: 'chat:start', sessionId })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                result = await this._submitAgentTurn(agentOpts, {
                  lane: 'interactive',
                  priority: isCli ? 105 : 100,
                  route: isCli ? 'cli.chat.retry' : 'web.chat.retry',
                  allowInterjection: false,
                });
              } catch (waitErr) {
                this.log.error(`[ws] Interjection wait failed: ${waitErr.message}`);
                const errPayload = { type: 'chat:error', error: 'Session busy — try again in a moment' };
                if (isCli) { this._sendToSession(sessionId, errPayload); }
                else { try { ws.send(JSON.stringify(errPayload)); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); } }
                return;
              }
            }

            // Send chat:done to all session clients (CLI + observers)
            const donePayload = {
              type: 'chat:done',
              text: result.text,
              usage: result.usage,
              iterations: result.iterations,
              toolUsage: result.toolUsage,
              responseRepair: result.responseRepair || null,
              hiddenWorkflowControl: result.hiddenWorkflowControl || null,
            };
            if (isCli) {
              this._sendToSession(sessionId, donePayload);
            } else {
              ws.send(JSON.stringify(donePayload));
            }
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:chat',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result.hiddenWorkflowControl ? `[workflow control: ${result.hiddenWorkflowControl}]` : result.text,
                trigger: 'dm',
                usage: result.usage,
                iterations: result.iterations,
              });
            } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          } catch (e) {
            const friendly = e.status === 529 || e.error?.type === 'overloaded_error' ? 'API is overloaded — try again in a moment'
              : e.status === 500 || e.error?.type === 'api_error' ? 'API server error — try again shortly'
                : e.status === 429 ? 'Rate limited — too many requests, wait a moment'
                  : (e.error?.error?.message || e.message || 'Unknown error').substring(0, 200);
            if (isCli) {
              this._sendToSession(sessionId, { type: 'chat:error', error: friendly });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', error: friendly }));
            }
          }
        } else if (msg.type === 'voice-chat') {
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          const sessionId = 'web:voice-call';
          try {
            ws.send(JSON.stringify({ type: 'voice:user-text', text: msg.content }));
            ws.send(JSON.stringify({ type: 'voice:thinking' }));
            const result = await this._submitAgentTurn({
              content: msg.content,
              channelId: sessionId, channelName: 'voice-call',
              userId: ws._user || 'operator',
              userName: msg.userName || ws._user || 'Operator',
              userRole: ws._role || 'creator',
              trigger: 'dm', platform: 'web', isDm: true,
              onTextDelta: (delta) => {
                try { ws.send(JSON.stringify({ type: 'voice:delta', text: delta })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
              onToolUse: (toolName) => {
                try { ws.send(JSON.stringify({ type: 'voice:tool', tool: toolName })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
              },
            }, {
              lane: 'interactive',
              priority: 100,
              route: 'web.voice',
              allowInterjection: true,
            });
            const resp = {
              type: 'voice:response', transcription: null, text: result?.text,
              usage: result?.usage, toolUsage: result?.toolUsage, iterations: result?.iterations,
            };
            const pipeline = this._ensureVoicePipeline();
            if (pipeline && result?.text && result.text.trim() !== 'NO_REPLY') {
              try {
                const ttsResult = await pipeline.synthesizeOnly(result.text);
                if (ttsResult.audio) {
                  resp.audio = ttsResult.audio.toString('base64');
                  resp.audioMime = 'audio/mp3';
                }
              } catch (e) { this.log.warn('[voice-chat] TTS failed:', e.message); }
            }
            ws.send(JSON.stringify(resp));
            try {
              const feed = require('../graph/feed');
              feed.log({
                channelName: 'web:voice',
                userName: msg.userName || 'Operator',
                userMessage: msg.content,
                myResponse: result?.text,
                trigger: 'voice',
                usage: result?.usage,
                iterations: result?.iterations,
              });
            } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured (need TTS/STT keys)' }));
            return;
          }
          if (!this.tools._agent) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Agent not available' }));
            return;
          }
          try {
            const audioData = Buffer.from(msg.audio, 'base64');
            const mime = msg.mimeType || 'audio/webm';
            ws.send(JSON.stringify({ type: 'voice:transcribing' }));

            if (msg.mode === 'call') {
              const sessionId = 'web:voice-call';
              const sttFirst = await pipeline.transcribeOnly(audioData, mime);
              if (sttFirst.error || !sttFirst.text?.trim()) {
                if (sttFirst.error) ws.send(JSON.stringify({ type: 'voice:error', error: sttFirst.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:user-text', text: sttFirst.text }));
              ws.send(JSON.stringify({ type: 'voice:thinking' }));
              const result = await pipeline.processFromText(sttFirst.text, this.tools._agent, {
                channelId: sessionId, channelName: 'voice-call',
                userId: msg.userId || ws._user || 'operator',
                userName: msg.userName || ws._user || 'Operator',
                userRole: ws._role || 'creator',
                trigger: 'dm', platform: 'web', isDm: true,
              });
              const resp = {
                type: 'voice:response', transcription: null, text: result.responseText,
                usage: result.usage, toolUsage: result.toolUsage, iterations: result.iterations,
              };
              if (result.audioBuffer) {
                resp.audio = result.audioBuffer.toString('base64');
                resp.audioMime = 'audio/mp3';
              }
              if (result.error) resp.error = result.error;
              ws.send(JSON.stringify(resp));
              try {
                const feed = require('../graph/feed');
                feed.log({
                  channelName: 'web:voice',
                  userName: msg.userName || 'Operator',
                  userMessage: sttFirst.text,
                  myResponse: result.responseText,
                  trigger: 'voice',
                  usage: result.usage,
                  iterations: result.iterations,
                });
              } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
            } else if (msg.mode === 'interrupt-check') {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              ws.send(JSON.stringify({ type: 'voice:interrupt-result', text: sttResult.text || '', error: sttResult.error }));
            } else {
              const sttResult = await pipeline.transcribeOnly(audioData, mime);
              if (sttResult.error) {
                ws.send(JSON.stringify({ type: 'voice:error', error: sttResult.error }));
                return;
              }
              ws.send(JSON.stringify({ type: 'voice:transcription', text: sttResult.text }));
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }
        } else if (msg.type === 'voice:tts') {
          const pipeline = this._ensureVoicePipeline();
          if (!pipeline) {
            ws.send(JSON.stringify({ type: 'voice:error', error: 'Voice pipeline not configured' }));
            return;
          }
          try {
            const result = await pipeline.synthesizeOnly(msg.text);
            if (result.error || !result.audio) {
              ws.send(JSON.stringify({ type: 'voice:error', error: result.error || 'TTS returned no audio' }));
              return;
            }
            ws.send(JSON.stringify({
              type: 'voice:audio',
              audio: result.audio.toString('base64'),
              audioMime: 'audio/mp3',
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'voice:error', error: e?.message || String(e) }));
          }

          // ── Terminal messages ──────────────────────────────────────────
        } else if (msg.type === 'terminal:open') {
          if (!ws._terminals) ws._terminals = new Map();
          this._handleTerminalOpen(ws, msg);
        } else if (msg.type === 'terminal:data') {
          this._handleTerminalData(ws, msg);
        } else if (msg.type === 'terminal:resize') {
          this._handleTerminalResize(ws, msg);
        } else if (msg.type === 'terminal:close') {
          this._handleTerminalClose(ws, msg);
        } else if (msg.type === 'terminal:hosts:list') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:hosts', hosts: [] })); return; }
          mgr.listHosts().then(hosts => ws.send(JSON.stringify({ type: 'terminal:hosts', hosts })));
        } else if (msg.type === 'terminal:hosts:save') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.saveHost(msg).then(result => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', ...result })))
            .catch(e => ws.send(JSON.stringify({ type: 'terminal:hosts:saved', error: e.message })));
        } else if (msg.type === 'terminal:hosts:delete') {
          const mgr = this._ensureSSHManager();
          if (mgr) mgr.deleteHost(msg.id).then(() => ws.send(JSON.stringify({ type: 'terminal:hosts:deleted', id: msg.id })));
        } else if (msg.type === 'terminal:hosts:test') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          mgr.testConnection(msg.id).then(r => {
            ws.send(JSON.stringify({ type: 'terminal:hosts:tested', id: msg.id, ...r }));
          });
        } else if (msg.type === 'terminal:keystore:status') {
          const mgr = this._ensureSSHManager();
          if (mgr?.waitForSidecarReady) await mgr.waitForSidecarReady(300);
          this._sendTerminalKeystoreStatus(ws, mgr);
        } else if (msg.type === 'terminal:keystore:unlock') {
          const mgr = this._ensureSSHManager();
          if (!mgr) { ws.send(JSON.stringify({ type: 'terminal:error', error: 'SSH manager not available' })); return; }
          try {
            if (mgr.waitForSidecarReady && await mgr.waitForSidecarReady(100)) {
              ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: true, mode: 'sidecar', sidecarReady: true }));
              this._sendTerminalKeystoreStatus(ws, mgr);
              return;
            }
            mgr.unlockKeystore(msg.passphrase);
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: true, mode: 'local' }));
            this._sendTerminalKeystoreStatus(ws, mgr);
          } catch (e) {
            ws.send(JSON.stringify({ type: 'terminal:keystore:unlocked', success: false, error: e.message }));
          }
        } else if (msg.type === 'terminal:keystore:lock') {
          const mgr = this._ensureSSHManager();
          if (mgr?.isSidecarReady?.()) {
            this._sendTerminalKeystoreStatus(ws, mgr);
            return;
          }
          if (mgr) mgr.lockKeystore();
          this._sendTerminalKeystoreStatus(ws, mgr);
        }
      });

      ws.on('close', () => {
        // If this CLI had pending tools, save them for re-send on reconnect
        if (ws._role === 'cli' && ws._pendingTools?.size > 0) {
          const pending = [];
          for (const [toolId, entry] of ws._pendingTools) {
            pending.push({ toolId, resolve: entry.resolve, reject: entry.reject, timeout: entry.timeout, ackTimeout: entry.ackTimeout, executionStartDelay: entry.executionStartDelay });
          }
          // Find which session this ws belongs to
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws === ws) {
                if (!this._orphanedTools) this._orphanedTools = new Map();
                const existing = this._orphanedTools.get(sid) || [];
                existing.push(...pending);
                this._orphanedTools.set(sid, existing);
                this.log.info(`[ws] CLI disconnected with ${pending.length} pending tool(s) for ${sid} — saved for reconnect`);
                break;
              }
            }
          }
        }

        // Plugin wsClose lifecycle hook — fires once per WS-close with
        // the set of session ids attached to this ws. Acorn-cli's
        // handler implements the ungraceful-close distillation chain
        // (finalize → summarize → distill) for `ws._role === 'cli'`
        // sessions; idempotent w.r.t. the graceful session:end path.
        // Other plugins can use this for any per-ws-close cleanup.
        if (this.tools?._pluginManager) {
          const sessionIds = new Set();
          const originSessionIds = new Set();
          const sessionRefs = [];
          for (const [sid, clients] of this._sessionClients) {
            for (const entry of clients) {
              if (entry.ws !== ws) continue;
              sessionIds.add(sid);
              sessionRefs.push({ sessionId: sid, role: entry.role || 'origin' });
              if ((entry.role || 'origin') === 'origin') originSessionIds.add(sid);
            }
          }
          for (const handler of this.tools._pluginManager.getLifecycleHooks?.('wsClose') || []) {
            try {
              handler({
                ws,
                sessionIds: [...sessionIds],
                originSessionIds: [...originSessionIds],
                sessionRefs,
                log: this.log,
              });
            } catch (e) { this.log.warn('[plugins] wsClose hook failed: ' + e.message); }
          }
        }

        this._removeClientFromAllSessions(ws);
        graphEvents.off('change', onGraphEvent);
        if (ws._terminals) {
          for (const [, sess] of ws._terminals) {
            if (sess.pty) { try { sess.pty.kill(); } catch (e) { this.log.warn('[web] sess.pty.kill failed: ' + e.message); } }
            if (sess.sshId) { try { this._sshManager?.close(sess.sshId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); } }
          }
          ws._terminals.clear();
        }
        this.log.info('[ws] Client disconnected from control panel');
      });
    });
  }

  // ── SSH Manager ─────────────────────────────────────────────────────

  _ensureSSHManager() {
    if (this._sshManager) return this._sshManager;
    if (this.tools?._sshManager) { this._sshManager = this.tools._sshManager; return this._sshManager; }
    try {
      const { SSHManager } = require('../tools/ssh-manager');
      this._sshManager = new SSHManager(this.config, this.log);
      return this._sshManager;
    } catch (e) {
      this.log.warn(`[ssh] SSHManager init failed: ${e.message}`);
      return null;
    }
  }

  _terminalKeystoreStatus(mgr) {
    const status = mgr?.getStatus?.() || {};
    const sidecarReady = status.sidecarReady === true && status.localMode !== true;
    return {
      type: 'terminal:keystore:status',
      mode: sidecarReady ? 'sidecar' : 'local',
      unlocked: sidecarReady ? true : !!(status.keystoreUnlocked ?? mgr?.keystoreUnlocked),
      source: sidecarReady ? 'ssh-sidecar' : (status.keystoreSource ?? mgr?.keystoreSource ?? null),
      sidecarEnabled: status.sidecarEnabled === true,
      sidecarReady,
      localMode: status.localMode !== false,
      socketPresent: status.socketPresent === true,
      socketPath: status.socketPath || null,
      hostCount: Number.isFinite(status.hostCount) ? status.hostCount : 0,
    };
  }

  _sendTerminalKeystoreStatus(ws, mgr) {
    ws.send(JSON.stringify(this._terminalKeystoreStatus(mgr)));
  }

  // ── Terminal Handlers ───────────────────────────────────────────────

  _handleTerminalOpen(ws, msg) {
    const hostId = msg.hostId;
    const paneId = msg.paneId || 'default';

    const existing = ws._terminals?.get(paneId);
    if (existing) {
      existing._cancelled = true;
      if (existing.pty) { try { existing.pty.kill(); } catch (e) { this.log.warn('[web] existing.pty.kill failed: ' + e.message); } }
      if (existing.sshId) { try { this._sshManager?.close(existing.sshId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); } }
      ws._terminals.delete(paneId);
    }

    if (!hostId || hostId === 'local') {
      try {
        const pty = require('node-pty');
        const shell = process.env.SHELL || '/bin/bash';
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;
        const term = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: this.config.workspacePath || process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color', HOME: process.env.HOME || process.cwd() },
        });

        ws._terminals.set(paneId, { pty: term, sshId: null });
        this.log.info(`[terminal] Local PTY opened: pane=${paneId} pid=${term.pid}`);
        const mgr = this._ensureSSHManager();
        mgr?.audit(`local_${term.pid}`, 'pty_opened', { shell, paneId });

        term.onData((data) => {
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        });

        term.onExit(({ exitCode }) => {
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: `Shell exited (code ${exitCode})` })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        });

        ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'local', pid: term.pid }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `Failed to open local terminal: ${e.message}` }));
      }
    } else {
      const mgr = this._ensureSSHManager();
      if (!mgr) {
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: 'SSH manager not available' }));
        return;
      }

      const placeholder = { pty: null, sshId: null, _cancelled: false };
      ws._terminals.set(paneId, placeholder);

      const result = mgr.connect(hostId, {
        onReady: (sessionId) => {
          if (placeholder._cancelled) {
            try { this._sshManager?.close(sessionId); } catch (e) { this.log.warn('[web] close failed: ' + e.message); }
            this.log.info(`[terminal] SSH session ${sessionId} arrived for replaced pane=${paneId}, closing orphan`);
            return;
          }
          placeholder.sshId = sessionId;
          ws.send(JSON.stringify({ type: 'terminal:opened', paneId, mode: 'ssh', sessionId, hostId }));
          this.log.info(`[terminal] SSH session opened: pane=${paneId} session=${sessionId}`);
        },
        onData: (data) => {
          if (placeholder._cancelled) return;
          try { ws.send(JSON.stringify({ type: 'terminal:data', paneId, data })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        },
        onClose: () => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          try { ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'SSH connection closed' })); } catch (e) { this.log.warn('[web] ws.send failed: ' + e.message); }
        },
        onError: (error) => {
          if (placeholder._cancelled) return;
          ws._terminals?.delete(paneId);
          ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: `SSH error: ${error}` }));
        },
      });

      if (result.error) {
        ws._terminals.delete(paneId);
        ws.send(JSON.stringify({ type: 'terminal:error', paneId, error: result.error }));
      }
    }
  }

  _handleTerminalData(ws, msg) {
    const paneId = msg.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.write(msg.data);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.write(sess.sshId, msg.data);
    }
  }

  _handleTerminalResize(ws, msg) {
    const paneId = msg.paneId || 'default';
    const cols = msg.cols || 80;
    const rows = msg.rows || 24;
    const sess = ws._terminals?.get(paneId);
    if (!sess) return;
    if (sess.pty) {
      sess.pty.resize(cols, rows);
    } else if (sess.sshId && this._sshManager) {
      this._sshManager.resize(sess.sshId, cols, rows);
    }
  }

  _handleTerminalClose(ws, msg) {
    const paneId = msg?.paneId || 'default';
    const sess = ws._terminals?.get(paneId);
    if (sess) {
      if (sess.pty) { try { sess.pty.kill(); } catch (e) { this.log.warn('[web] sess.pty.kill failed: ' + e.message); } }
      if (sess.sshId && this._sshManager) { this._sshManager.close(sess.sshId); }
      ws._terminals.delete(paneId);
    }
    ws.send(JSON.stringify({ type: 'terminal:closed', paneId, reason: 'Closed by user' }));
  }

  // ── Secure API Key Proxy ────────────────────────────────────────────

  _loadApiProxyConfig() {
    const workspace = this.config.workspacePath || process.cwd();
    const configPath = path.join(workspace, 'web', '.api-proxy.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.routes || typeof config.routes !== 'object') return null;
      return config;
    } catch { return null; }
  }

  _matchProxyRoute(proxyRoute, config, req) {
    return matchProxyRoute(proxyRoute, config, req);
  }

  async _fetchVaultKey(keyName) {
    const managerUrl = this.config.managerUrl;
    const serviceKey = this.config.managerServiceKey;
    if (!managerUrl || !serviceKey) return null;

    if (!this._vaultCache) this._vaultCache = new Map();
    const cached = this._vaultCache.get(keyName);
    if (cached && Date.now() - cached.ts < 300_000) return cached.value;

    try {
      const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
      const val = await new Promise((resolve) => {
        const req = http_.get(`${managerUrl}/api/vault/key?name=${encodeURIComponent(keyName)}`, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': this.config.agentId || 'unknown' },
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) { resolve(null); return; }
            try { resolve(JSON.parse(data).value || null); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (val) this._vaultCache.set(keyName, { value: val, ts: Date.now() });
      return val;
    } catch { return null; }
  }

  async _handleApiProxy(req, res, matched, proxyRoute) {
    const handler = createApiProxyHandler({
      fetchVaultKey: keyName => this._fetchVaultKey(keyName),
      log: this.log,
      redactSecrets: _redactSecrets,
      fetchImpl: fetch,
    });
    return handler(req, res, matched, proxyRoute);
  }

  // ── Graph API Handlers ──────────────────────────────────────────────

  async _handleMultiGraphApi(req, res, urlPath, authContext = { type: 'creator', role: 'creator', creator: true }) {
    const registry = this.tools._graphRegistry;
    if (!registry) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Multi-graph registry not available' }));
      return;
    }

    const jsonBody = () => new Promise((resolve, reject) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 65536) { req.destroy(); reject(new Error('Too large')); } });
      req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    const jsonRes = (data, status = 200) => {
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const canManageGraphs = _graphAuthIsCreator(authContext);
    const canViewGraph = (graph) => _canGraphAuthViewGraph(graph, authContext, registry);
    const scopedGraphSlug = _scopedUserGraphSlugForAuth(authContext, registry);
    const shapeGraph = (graph) => _shapeGraphForAuth(graph, authContext, registry, { scopedGraphSlug });
    const requireGraphManager = () => {
      if (canManageGraphs) return true;
      jsonRes({ error: 'Creator authentication required' }, 403);
      return false;
    };

    if (urlPath === '/api/graphs' && req.method === 'GET') {
      const graphs = registry.list()
        .filter(g => canViewGraph(g))
        .map(g => shapeGraph(g));
      return jsonRes({ graphs, readOnly: !canManageGraphs, scopedGraphSlug: scopedGraphSlug || null });
    }

    if (urlPath === '/api/graphs' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const { name, description } = await jsonBody();
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
          return jsonRes({ error: 'Name is required' }, 400);
        }
        const slug = registry.create(name.trim(), description || '');
        return jsonRes({ ok: true, slug, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (urlPath === '/api/graphs/search' && req.method === 'GET') {
      const query = new URL(req.url || '', 'http://localhost').searchParams;
      const q = String(query.get('q') || '').trim();
      const limit = Math.max(1, Math.min(100, Number(query.get('limit')) || 50));
      const perGraphLimit = Math.max(1, Math.min(30, Number(query.get('perGraphLimit')) || 12));
      if (q.length < 2) return jsonRes({ query: q, results: [], graphCount: 0, searchedGraphCount: 0 });

      const { DatabaseSync } = require('node:sqlite');
      const graphs = registry.list().filter(g => canViewGraph(g));
      const results = [];
      let searchedGraphCount = 0;
      for (const graph of graphs) {
        let graphDb = null;
        try {
          const dbPath = registry.getDbPath?.(graph.slug);
          if (!dbPath) continue;
          graphDb = new DatabaseSync(dbPath, { readOnly: true });
          searchedGraphCount++;
          const graphMeta = shapeGraph({
            ...registry.get(graph.slug),
            active: graph.slug === registry.getActiveSlug?.(),
            inspectOnly: registry.isActivationLocked?.(graph.slug) || false,
          });
          delete graphMeta.dbPath;
          const hits = _graphSearchNodes(graphDb, q, { limit: perGraphLimit });
          for (const hit of hits) {
            results.push({
              ...hit,
              graph: {
                slug: graphMeta.slug,
                name: graphMeta.name,
                role: graphMeta.role,
                active: graphMeta.active === true,
                inspectOnly: graphMeta.inspectOnly === true,
                readOnly: graphMeta.readOnly === true,
                currentScope: graphMeta.currentScope === true,
                scopedActive: graphMeta.scopedActive === true,
              },
            });
          }
        } catch (e) {
          this.log?.debug?.(`[graph-search] ${graph.slug} skipped: ${e.message}`);
        } finally {
          try { graphDb?.close(); } catch {}
        }
      }
      results.sort((a, b) =>
        (a.score - b.score) ||
        ((b.graph?.active === true) - (a.graph?.active === true)) ||
        String(a.graph?.name || a.graph?.slug || '').localeCompare(String(b.graph?.name || b.graph?.slug || '')) ||
        String(a.node?.label || a.node?.id || '').localeCompare(String(b.node?.label || b.node?.id || ''))
      );
      return jsonRes({
        query: q,
        results: results.slice(0, limit),
        graphCount: graphs.length,
        searchedGraphCount,
        limit,
      });
    }

    const match = urlPath.match(/^\/api\/graphs\/([a-z0-9-]+)(\/(.+))?$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const slug = match[1];
    const action = match[3] || null;

    if (action === 'activate' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const result = this.tools.switchGraph(slug);
        graphEvents.emit('change', { op: 'graph:switched', slug, source: 'multi-graph' });
        return jsonRes({ ok: true, ...result });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (action === 'maintenance' && req.method === 'GET') {
      if (!requireGraphManager()) return;
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      registry.refreshStats(slug);
      return jsonRes({
        graph: registry.get(slug),
        coordinator: this.tools?._graphMaintenance?.getStats?.() || null,
      });
    }

    if (action === 'maintenance/run' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const coordinator = this.tools?._graphMaintenance;
        if (!coordinator) return jsonRes({ error: 'graph maintenance coordinator not available' }, 503);
        const body = await jsonBody().catch(() => ({}));
        const payload = {
          slug,
          opts: {
            force: body.force !== false,
            includeActive: true,
            reason: body.reason || 'manual',
          },
        };
        const result = this.tools?._jobQueue?.submitWorkerJob
          ? await this.tools._jobQueue.submitWorkerJob('graphMaintenance.maintainGraph', payload, {
              lane: 'maintenance',
              priority: 35,
              route: 'graph.maintenance.manual',
              graph: slug,
            })
          : await coordinator.maintainGraph(slug, payload.opts);
        return jsonRes(result, result.ok ? 200 : 400);
      } catch (e) {
        return jsonRes({ error: e.message }, 500);
      }
    }

    if (action === 'research/status' && req.method === 'GET') {
      if (!requireGraphManager()) return;
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      if (g.role !== 'general_kb') return jsonRes({ error: 'Research status is only available for the General Knowledge Base' }, 400);
      const worker = this.tools?._generalKbResearch;
      if (!worker) return jsonRes({ error: 'general KB research worker not available' }, 503);
      return jsonRes({ graph: shapeGraph(g), research: worker.getStats?.() || null });
    }

    if (action === 'research/run' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const g = registry.get(slug);
        if (!g) return jsonRes({ error: 'Not found' }, 404);
        if (g.role !== 'general_kb') return jsonRes({ error: 'Research can only be run against the General Knowledge Base graph' }, 400);
        const worker = this.tools?._generalKbResearch;
        if (!worker) return jsonRes({ error: 'general KB research worker not available' }, 503);
        const body = await jsonBody().catch(() => ({}));
        const result = await worker.enqueue({
          slug,
          force: body.force !== false,
          batchSize: body.batchSize || null,
          reason: body.reason || 'manual',
        });
        return jsonRes(result, result?.ok ? 202 : (result?.skipped ? 200 : 400));
      } catch (e) {
        return jsonRes({ error: e.message }, 500);
      }
    }

    if (action === 'data' && req.method === 'GET') {
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      if (!canViewGraph(g)) return jsonRes({ error: 'Forbidden' }, 403);
      registry.refreshStats(slug);
      const dbPath = registry.getDbPath(slug);
      let graphDb = null;
      try {
        const { DatabaseSync } = require('node:sqlite');
        graphDb = new DatabaseSync(dbPath, { readOnly: true });
        const graphMeta = shapeGraph({
          ...registry.get(slug),
          active: slug === registry.getActiveSlug(),
          inspectOnly: registry.isActivationLocked?.(slug) || false,
        });
        const query = new URL(req.url || '', 'http://localhost').searchParams;
        return jsonRes(_graphBuildPayload(graphDb, query, { graph: graphMeta }));
      } catch (e) {
        return jsonRes({ error: e.message }, 500);
      } finally {
        try { graphDb?.close(); } catch {}
      }
    }

    if (action === 'duplicate' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const { name } = await jsonBody();
        if (!name) return jsonRes({ error: 'Name is required' }, 400);
        const newSlug = registry.duplicate(slug, name.trim());
        return jsonRes({ ok: true, slug: newSlug, graph: registry.get(newSlug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (action === 'reset' && req.method === 'POST') {
      if (!requireGraphManager()) return;
      try {
        const body = await jsonBody().catch(() => ({}));
        if (body.confirm !== 'RESET') return jsonRes({ error: 'Type RESET to confirm' }, 400);
        const result = await this._resetGeneralKnowledgeGraph(slug);
        graphEvents.emit('change', { op: 'graph:reset', slug, source: 'multi-graph' });
        return jsonRes({ ok: true, ...result });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'PUT') {
      if (!requireGraphManager()) return;
      try {
        const { name, description } = await jsonBody();
        if (name) registry.rename(slug, name.trim());
        if (description !== undefined) registry.describe(slug, description);
        return jsonRes({ ok: true, graph: registry.get(slug) });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'DELETE') {
      if (!requireGraphManager()) return;
      try {
        const learner = this.tools?.learner || this.tools?._agent?.learner || null;
        const sessionFlush = await this._flushGraphSessionsBeforeDelete(slug);
        learner?.closeGraphDb?.(slug);
        registry.delete(slug);
        graphEvents.emit('change', { op: 'graph:deleted', slug, graph: slug, source: 'multi-graph' });
        return jsonRes({ ok: true, sessionFlush });
      } catch (e) {
        return jsonRes({ error: e.message }, 400);
      }
    }

    if (!action && req.method === 'GET') {
      const g = registry.get(slug);
      if (!g) return jsonRes({ error: 'Not found' }, 404);
      if (!canViewGraph(g)) return jsonRes({ error: 'Forbidden' }, 403);
      registry.refreshStats(slug);
      return jsonRes({ graph: shapeGraph({ ...registry.get(slug), active: slug === registry.getActiveSlug() }) });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown multi-graph endpoint' }));
  }

  async _handleGraphApiOnWeb(req, res, urlPath, db) {
    if (!req._graphApiScopeApplied) {
      req._graphApiScopeApplied = true;
      let scopedDb = db;
      let graphSlug = null;
      const authContext = req._graphApiAuthContext || { type: 'creator', role: 'creator', creator: true };
      const registry = this.tools?._graphRegistry;
      const scopedDefaultSlug = _scopedUserGraphSlugForAuth(authContext, registry);
      try {
        const u = new URL(req.url || urlPath, 'http://localhost');
        graphSlug = String(u.searchParams.get('scopeGraph') || u.searchParams.get('graphSlug') || '').trim() || null;
      } catch {}
      if (!graphSlug && scopedDefaultSlug) graphSlug = scopedDefaultSlug;
      if (graphSlug) {
        try {
          const entry = registry?.get?.(graphSlug);
          if (!entry) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Graph "${graphSlug}" not found` }));
            return;
          }
          if (!_canGraphAuthViewGraph(entry, authContext, registry)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
          }
          const isScopedWriteGraph = !!(scopedDefaultSlug && graphSlug === scopedDefaultSlug && entry.role === 'user');
          if (!_graphAuthIsCreator(authContext) && req.method !== 'GET' && !isScopedWriteGraph) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Read-only graph access' }));
            return;
          }
          const activeSlug = registry.getActiveSlug?.();
          if (graphSlug !== activeSlug) {
            const learner = this.tools?.learner || this.tools?._agent?.learner || null;
            scopedDb = learner?.getGraphDb?.(graphSlug);
            if (!scopedDb) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Graph "${graphSlug}" database unavailable` }));
              return;
            }
          }
          req._graphApiSlug = graphSlug;
          req._graphApiGraphEntry = entry;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
      }
      return graphEvents.withGraph(graphSlug ? { graph: graphSlug } : null, () => this._handleGraphApiOnWeb(req, res, urlPath, scopedDb));
    }

    if (!db) { res.writeHead(503); res.end(JSON.stringify({ error: 'Graph database not available' })); return; }

    const MAX_BODY = 1024 * 256;
    const json = () => new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; if (b.length > MAX_BODY) { req.destroy(); reject(new Error('Request body too large')); } }); req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    const graphMetaForResponse = () => {
      const registry = this.tools?._graphRegistry;
      if (!registry) return null;
      const authContext = req._graphApiAuthContext || { type: 'creator', role: 'creator', creator: true };
      const scopedGraphSlug = _scopedUserGraphSlugForAuth(authContext, registry);
      const slug = req._graphApiSlug || scopedGraphSlug || registry.getActiveSlug?.();
      const entry = req._graphApiGraphEntry || (slug ? registry.get?.(slug) : null);
      if (!entry) return null;
      return _shapeGraphForAuth({
        ...entry,
        active: slug === registry.getActiveSlug?.(),
        inspectOnly: registry.isActivationLocked?.(entry) || false,
      }, authContext, registry, { scopedGraphSlug });
    };

    if (urlPath === '/api/graph' && req.method === 'GET') {
      try {
        const query = new URL(req.url || '', 'http://localhost').searchParams;
        const payload = _graphBuildPayload(db, query, { graph: graphMetaForResponse() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Token-reduction benchmark (admin/debug) ──
    // Compares graph-driven system-prompt size vs. a naïve baseline of
    // top-N attributes + episodes per fixed question. Useful to confirm
    // retrieval is actually saving tokens and to track regressions.
    if (urlPath === '/api/benchmark/run' && req.method === 'GET') {
      try {
        const { runBenchmark } = require('../tools/benchmark');
        const report = await runBenchmark(this.graph, this.log, {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report, null, 2));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Graph Overview (god nodes / surprising bridges / suggested questions) ──
    // Latest non-superseded payload computed by maintainer.runGraphOverview.
    // Read-only, intended for the graph viewer / debug UI.
    if (urlPath === '/api/graph-overview' && req.method === 'GET') {
      try {
        const row = db.prepare(
          `SELECT run_id, computed_at, payload FROM graph_overviews
           WHERE superseded_at IS NULL
           ORDER BY computed_at DESC LIMIT 1`
        ).get();
        if (!row) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ available: false, reason: 'No overview computed yet — maintainer hasn\'t run a community-detection cycle on this graph yet.' }));
          return;
        }
        let payload = null;
        try { payload = JSON.parse(row.payload); } catch { /* corrupted row */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          available: true,
          run_id: row.run_id,
          computed_at: row.computed_at,
          payload,
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Maintainer on-demand + status ──
    if (urlPath === '/api/maintainer/run' && req.method === 'POST') {
      try {
        const maintainer = this.tools?._maintainer;
        if (!maintainer) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'maintainer not available' }));
          return;
        }
        if (this._maintRunJob && this._maintRunJob.state === 'running') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'running', started: this._maintRunJob.started }));
          return;
        }
        this._maintRunJob = { state: 'running', started: Date.now(), error: null, result: null };
        Promise.resolve()
          .then(async () => {
            const result = { active: await maintainer.runMaintenance({ force: true }) };
            const distiller = this.tools?._channelDistiller;
            if (distiller?.run) {
              result.scopedDistill = await distiller.run({ force: true });
            }
            return result;
          })
          .then(r => { this._maintRunJob = { state: 'done', started: this._maintRunJob.started, completed: Date.now(), result: r }; })
          .catch(e => { this._maintRunJob = { state: 'error', started: this._maintRunJob.started, completed: Date.now(), error: e?.message || String(e) }; });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', started: this._maintRunJob.started }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/maintainer/status' && req.method === 'GET') {
      try {
        const maintainer = this.tools?._maintainer;
        const openGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='open'").get()?.c || 0;
        const dormantGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='dormant'").get()?.c || 0;
        const answeredGaps = db.prepare("SELECT COUNT(*) AS c FROM gaps WHERE status='answered'").get()?.c || 0;
        const reflections = db.prepare("SELECT COUNT(*) AS c FROM reflections").get()?.c || 0;
        let derived = 0;
        try { derived = db.prepare("SELECT COUNT(*) AS c FROM derived_facts WHERE invalidated_at IS NULL").get()?.c || 0; } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job: this._maintRunJob || { state: 'idle' },
          last_run_at: maintainer?._lastRunAt || null,
          running: !!maintainer?._running,
          model: maintainer?.model || null,
          stats: maintainer?.stats || {},
          graphMaintenance: this.tools?._graphMaintenance?.getStats?.() || null,
          generalKbResearch: this.tools?._generalKbResearch?.getStats?.() || null,
          counts: { openGaps, dormantGaps, answeredGaps, reflections, derivedFacts: derived },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Runtime queue status / control ──
    if (urlPath === '/api/queue/status' && req.method === 'GET') {
      try {
        const queue = this.tools?._jobQueue;
        if (!queue) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'runtime queue not available' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(queue.getStats()));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/queue/jobs' && req.method === 'GET') {
      try {
        const queue = this.tools?._jobQueue;
        if (!queue) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'runtime queue not available' })); return; }
        const queueParams = new URL(req.url, 'http://x').searchParams;
        const status = queueParams.get('status') || null;
        const limit = Number(queueParams.get('limit') || 100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobs: queue.listJobs({ status, limit }) }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const queueControlMatch = urlPath.match(/^\/api\/queue\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (queueControlMatch && req.method === 'POST') {
      try {
        const queue = this.tools?._jobQueue;
        if (!queue) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'runtime queue not available' })); return; }
        const id = decodeURIComponent(queueControlMatch[1]);
        const action = queueControlMatch[2];
        const out = action === 'cancel' ? queue.cancelJob(id, 'operator cancelled') : queue.retryJob(id);
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Janitor on-demand + status + recycling bin ──
    if (urlPath === '/api/janitor/run' && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        if (this._janitorRunJob && this._janitorRunJob.state === 'running') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'running', started: this._janitorRunJob.started }));
          return;
        }
        this._janitorRunJob = { state: 'running', started: Date.now(), error: null, result: null };
        const run = this.tools?._jobQueue?.submitWorkerJob
          ? this.tools._jobQueue.submitWorkerJob('janitor.run', { opts: { force: true } }, {
              lane: 'maintenance',
              priority: 30,
              route: 'janitor.manual',
            })
          : janitor.runJanitor({ force: true });
        Promise.resolve(run)
          .then(r => { this._janitorRunJob = { state: 'done', started: this._janitorRunJob.started, completed: Date.now(), result: r }; })
          .catch(e => { this._janitorRunJob = { state: 'error', started: this._janitorRunJob.started, completed: Date.now(), error: e?.message || String(e) }; });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: 'running', started: this._janitorRunJob.started }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/status' && req.method === 'GET') {
      try {
        const janitor = this.tools?._janitor;
        let binCount = 0;
        try { binCount = db.prepare('SELECT COUNT(*) AS c FROM recycle_bin').get()?.c || 0; } catch (e) { this.log.warn('[web] db.prepare failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job: this._janitorRunJob || { state: 'idle' },
          last_run_at: janitor?._lastRunAt || null,
          running: !!janitor?._running,
          model: janitor?.model || null,
          mode: this.config.janitorMode || 'moderate',
          interval_minutes: this.config.janitorIntervalMinutes || 360,
          recycle_bin_ttl_days: this.config.janitorRecycleBinTtlDays || 14,
          enabled: this.config.janitorEnabled !== false,
          stats: janitor?.stats || {},
          counts: { binItems: binCount },
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/recycle-bin' && req.method === 'GET') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const u = new URL(req.url, 'http://x');
        const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit') || '100', 10)));
        const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10));
        const out = janitor.listBin({ limit, offset });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/recycle-bin/empty' && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.emptyBin();
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const binRestoreMatch = urlPath.match(/^\/api\/janitor\/restore\/(\d+)$/);
    if (binRestoreMatch && req.method === 'POST') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.restoreItem(binRestoreMatch[1]);
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const binDeleteMatch = urlPath.match(/^\/api\/janitor\/recycle-bin\/(\d+)$/);
    if (binDeleteMatch && req.method === 'DELETE') {
      try {
        const janitor = this.tools?._janitor;
        if (!janitor) { res.writeHead(503); res.end(JSON.stringify({ error: 'janitor not available' })); return; }
        const out = janitor.deleteBinItem(binDeleteMatch[1]);
        res.writeHead(out.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/janitor/settings' && req.method === 'POST') {
      try {
        const body = await json();
        const mode = String(body.mode || '').toLowerCase();
        if (!['conservative', 'moderate', 'aggressive'].includes(mode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid mode' }));
          return;
        }
        this.config.janitorMode = mode;
        // Persist via _applyEnvUpdates if available
        try {
          if (typeof this._applyEnvUpdates === 'function') {
            this._applyEnvUpdates({ SPORE_JANITOR_MODE: mode });
          }
        } catch (e) { this.log.warn('[janitor-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Graph backup ──
    if (urlPath === '/api/backups' && req.method === 'GET') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(backup.listBackups({ all: true })));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/run' && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json().catch(() => ({}));
        const note = typeof body.note === 'string' ? body.note : null;
        const out = await (backup.runBackups ? backup.runBackups({ force: true, note }) : backup.runBackup({ force: true, note }));
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/status' && req.method === 'GET') {
      try {
        const backup = this.tools?._backup;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: this.config.graphBackupEnabled !== false,
          interval_minutes: this.config.graphBackupIntervalMinutes || 60,
          retention: this.config.graphBackupRetention || 20,
          on_change_only: this.config.graphBackupOnChangeOnly !== false,
          dir: backup?._backupDir?.() || null,
          stats: backup?.stats || {},
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/backups/settings' && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json();
        const changes = backup.applySettings({
          intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : undefined,
          retention: typeof body.retention === 'number' ? body.retention : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          onChangeOnly: typeof body.onChangeOnly === 'boolean' ? body.onChangeOnly : undefined,
        });
        try {
          if (typeof this._applyEnvUpdates === 'function') {
            const envUpd = {};
            if ('intervalMinutes' in changes) envUpd.SPORE_BACKUP_INTERVAL_MINUTES = String(changes.intervalMinutes);
            if ('retention' in changes) envUpd.SPORE_BACKUP_RETENTION = String(changes.retention);
            if ('enabled' in changes) envUpd.SPORE_BACKUP_ENABLED = changes.enabled ? 'true' : 'false';
            if ('onChangeOnly' in changes) envUpd.SPORE_BACKUP_ON_CHANGE_ONLY = changes.onChangeOnly ? 'true' : 'false';
            if (Object.keys(envUpd).length) this._applyEnvUpdates(envUpd);
          }
        } catch (e) { this.log.warn('[backup-settings] persist failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changes }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const restoreMatch = urlPath.match(/^\/api\/backups\/restore$/);
    if (restoreMatch && req.method === 'POST') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const body = await json();
        const filename = String(body.file || body.filename || '').trim();
        const slug = String(body.slug || body.graph || body.graphSlug || '').trim() || null;
        if (!filename) { res.writeHead(400); res.end(JSON.stringify({ error: 'file required' })); return; }
        const out = await backup.restoreBackup(filename, { slug });
        if (out.ok) graphEvents.emit('change', { op: 'graph:backup-restore', slug: out.slug || slug || null, source: 'backup' });
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Graph / settings / providers export + import ─────────────────
    if (urlPath.startsWith('/api/graph/export') && req.method === 'GET') {
      try {
        const { exportGraph, exportProviders, exportSettings, sanitizeGraphMeta } = require('../graph/export-import');
        const { DatabaseSync } = require('node:sqlite');
        const u = new URL(req.url, 'http://x');
        const wantGraph = u.searchParams.get('graph') !== '0';
        const wantProviders = u.searchParams.get('providers') === '1';
        const wantSettings = u.searchParams.get('settings') !== '0';
        const includeSecrets = u.searchParams.get('secrets') === '1';
        const graphScope = String(u.searchParams.get('graph_scope') || u.searchParams.get('scope') || 'current').toLowerCase();
        const selectedSlug = String(u.searchParams.get('graph_slug') || u.searchParams.get('slug') || '').trim();
        const authContext = req._graphApiAuthContext || { type: 'creator', role: 'creator', creator: true };
        const creatorExport = _graphAuthIsCreator(authContext);
        if ((wantProviders || wantSettings || graphScope === 'all') && !creatorExport) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Creator role required for settings/provider/all-graph export.' }));
          return;
        }
        const registry = this.tools?._graphRegistry || null;
        const activeSlug = registry?.getActiveSlug?.() || null;
        const currentSlug = req._graphApiSlug || activeSlug || null;
        const exportOneGraph = (slug, scopedDb = null) => {
          const entry = slug && registry?.get?.(slug) ? registry.get(slug) : (slug ? { slug, name: slug } : null);
          if (entry && !_canGraphAuthViewGraph(entry, authContext, registry)) {
            throw new Error(`Forbidden graph "${slug}"`);
          }
          const dbPath = slug && registry?.getDbPath?.(slug);
          let graphDb = scopedDb;
          let opened = null;
          try {
            if (!graphDb) {
              if (slug && slug === currentSlug) graphDb = db;
              else {
                if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`Graph DB missing for "${slug}"`);
                opened = new DatabaseSync(dbPath, { readOnly: true });
                graphDb = opened;
              }
            }
            return exportGraph(graphDb, { agentId: this.config.agentId || null, graphMeta: entry });
          } finally {
            try { opened?.close(); } catch {}
          }
        };

        const bundle = {
          version: 2,
          format: 'spore-export',
          exportedAt: new Date().toISOString(),
          sourceAgent: this.config.agentId ? { id: this.config.agentId, label: this.config.displayName || this.config.agentId } : null,
          includesSecrets: wantProviders && includeSecrets,
          graphScope: wantGraph ? graphScope : 'none',
          sections: [],
        };
        if (wantGraph) {
          if (graphScope === 'all') {
            if (!registry?.list) throw new Error('multi-graph registry unavailable');
            const graphs = registry.list();
            bundle.graphRegistry = {
              activeSlug,
              graphs: graphs.map(g => sanitizeGraphMeta(g)),
            };
            bundle.graphs = graphs.map(g => exportOneGraph(g.slug));
            bundle.sections.push('graphs');
          } else {
            const slug = graphScope === 'selected' ? selectedSlug : (selectedSlug || currentSlug);
            if (graphScope === 'selected' && !slug) throw new Error('graph_slug required for selected graph export');
            bundle.graph = slug ? exportOneGraph(slug, slug === currentSlug ? db : null) : exportGraph(db, { agentId: this.config.agentId || null });
            bundle.sections.push('graph');
          }
        }
        if (wantProviders) {
          bundle.providers = exportProviders(this.config, { includeSecrets });
          if (bundle.providers) bundle.sections.push('providers');
        }
        if (wantSettings) {
          bundle.settings = exportSettings(this.config);
          if (bundle.settings) bundle.sections.push('settings');
        }

        const scopeTag = wantGraph && graphScope === 'all' ? 'allgraphs' : (wantGraph && selectedSlug ? selectedSlug : 'bundle');
        const filename = `spore-export-${(this.config.agentId || 'agent').replace(/[^a-zA-Z0-9-]/g, '')}-${scopeTag.replace(/[^a-zA-Z0-9-]/g, '')}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.json`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(JSON.stringify(bundle, null, 2));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/import' && req.method === 'POST') {
      // Import is destructive (inserts nodes + edges into the live graph),
      // so gate to creator only — webapp users shouldn't be able to bulk
      // upload arbitrary knowledge.
      if (!_graphAuthIsCreator(req._graphApiAuthContext || null)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Import requires creator role.' }));
        return;
      }
      try {
        // Increase the body cap — exports can be multi-MB for large graphs
        const MAX_IMPORT = 50 * 1024 * 1024;
        const bodyRaw = await new Promise((resolve, reject) => {
          let b = ''; req.on('data', c => {
            b += c; if (b.length > MAX_IMPORT) { req.destroy(); reject(new Error('import too large (>50MB)')); }
          });
          req.on('end', () => resolve(b));
          req.on('error', reject);
        });
        let payload;
        try { payload = JSON.parse(bodyRaw); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
          return;
        }
        const { importGraph, planProviderImport, planSettingsImport } = require('../graph/export-import');
        const { DatabaseSync } = require('node:sqlite');
        const u = new URL(req.url, 'http://x');
        const applyGraph = u.searchParams.get('apply_graph') !== '0';
        const applyProviders = u.searchParams.get('apply_providers') === '1';
        const applySettings = u.searchParams.get('apply_settings') !== '0';
        const requestedTargetSlug = String(u.searchParams.get('graph_slug') || u.searchParams.get('target_slug') || '').trim();
        const registry = this.tools?._graphRegistry || null;
        const backup = this.tools?._backup || null;
        const activeSlug = registry?.getActiveSlug?.() || null;
        const currentSlug = req._graphApiSlug || activeSlug || null;

        // v2 bundle → has {graph, providers, settings}. v1 format / raw graph →
        // the graph IS the payload (backward compat).
        const isBundle = payload.format === 'spore-export';
        const graphPayload = isBundle ? payload.graph : payload;
        const graphPayloads = isBundle && Array.isArray(payload.graphs) ? payload.graphs : null;
        const providersSection = isBundle ? payload.providers : null;
        const settingsSection = isBundle ? payload.settings : null;

        const report = {
          graph: null,
          graphs: null,
          providers: null,
          settings: null,
        };

        const ensureImportTarget = (gp, fallbackSlug = null, { useRequestedTarget = true } = {}) => {
          const meta = gp?.graph || {};
          let slug = (useRequestedTarget ? requestedTargetSlug : '') || meta.slug || fallbackSlug || currentSlug;
          if (!slug && registry?.getActiveSlug) slug = registry.getActiveSlug();
          let graphDb = db;
          let opened = null;
          let dbPath = null;
          let created = false;

          if (registry && slug) {
            let entry = registry.get(slug);
            if (!entry) {
              const name = meta.name || slug;
              slug = registry.create(name, meta.description || '', {
                slug,
                role: meta.role || 'custom',
                protected: meta.protected === true,
                managed: meta.managed === true,
                activationLocked: meta.activationLocked === true,
                seedProfile: meta.seedProfile || (meta.role === 'project' ? 'project' : (meta.role === 'channel' ? 'channel' : 'standard')),
                identityKey: meta.identityKey || null,
                platform: meta.platform || null,
                externalUserId: meta.externalUserId || null,
                externalChannelId: meta.externalChannelId || null,
                source: meta.source || 'import',
                createdBy: meta.createdBy || 'import',
              });
              created = true;
              entry = registry.get(slug);
            }
            registry.applyImportedMetadata?.(slug, meta);
            dbPath = registry.getDbPath(slug);
            if (slug === currentSlug) {
              graphDb = db;
            } else {
              opened = new DatabaseSync(dbPath);
              graphDb = opened;
            }
          }

          return { slug, db: graphDb, opened, dbPath, created };
        };

        const importIntoTarget = async (gp, fallbackSlug = null, opts = {}) => {
          if (!gp || gp.format !== 'spore-graph-export') return { error: 'skipped — not a spore-graph-export payload' };
          const target = ensureImportTarget(gp, fallbackSlug, opts);
          try {
            try {
              if (backup?.runBackupForGraph && target.slug && target.dbPath) {
                await backup.runBackupForGraph({ slug: target.slug, dbPath: target.dbPath, force: true, note: 'pre-import' });
              } else if (backup) {
                await backup.runBackup({ force: true, note: 'pre-import' });
              }
            } catch (e) { this.log.warn('[import] pre-import backup failed: ' + e.message); }
            const result = importGraph(target.db, gp, { log: this.log });
            try { registry?.refreshStats?.(target.slug); } catch {}
            return { slug: target.slug, created: target.created, ...result };
          } finally {
            try { target.opened?.close(); } catch {}
          }
        };

        if (applyGraph && graphPayloads?.length) {
          report.graphs = await Promise.all(graphPayloads.map(gp => importIntoTarget(gp, gp?.graph?.slug || null, { useRequestedTarget: false })));
          report.graph = { importedGraphs: report.graphs.length };
        } else if (applyGraph && graphPayload) {
          report.graph = await importIntoTarget(graphPayload, requestedTargetSlug || currentSlug);
        }

        let providerTouched = false;
        let modelTouched = false;
        if (applyProviders && providersSection) {
          const plan = planProviderImport(providersSection, this.config);
          try {
            if (typeof this._applyEnvUpdates === 'function' && Object.keys(plan.envUpdates).length) {
              this._applyEnvUpdates(plan.envUpdates);
            }
            Object.assign(this.config, plan.configPatches);
            providerTouched = plan.applied.length > 0;
          } catch (e) {
            this.log.warn('[import] providers apply failed: ' + e.message);
          }
          report.providers = { applied: plan.applied, skipped: plan.skipped };
        }

        if (applySettings && settingsSection) {
          const plan = planSettingsImport(settingsSection);
          try {
            if (typeof this._applyEnvUpdates === 'function' && Object.keys(plan.envUpdates).length) {
              this._applyEnvUpdates(plan.envUpdates);
            }
            Object.assign(this.config, plan.configPatches);
            // If any model tier changed, the agent loop needs to rewire.
            for (const k of ['casualModel', 'normalModel', 'plannerModel', 'subagentModel', 'learnerModel', 'recallModel', 'imageVlmModel', 'videoVlmModel', 'audioVlmModel']) {
              if (plan.configPatches[k] != null) { modelTouched = true; break; }
            }
          } catch (e) {
            this.log.warn('[import] settings apply failed: ' + e.message);
          }
          report.settings = { applied: plan.applied };
        }

        // After applying env updates, reset the shared config cache so any
        // other component calling loadConfig() gets fresh values.
        try {
          const { resetConfigCache } = require('../config');
          if (typeof resetConfigCache === 'function') resetConfigCache();
        } catch (e) { this.log.warn('[web] require failed: ' + e.message); }

        // Resolve the top-level `model` pointer (used by detectBackend etc.)
        this.config.model = this.config.plannerModel || this.config.normalModel || this.config.casualModel || null;
        // _isOAuth is set by anthropic-provider's _detectOAuth.

        // If providers or model tiers changed, rebuild the agent's LLM client
        // so the next chat uses the new provider/model instead of the old one.
        if (providerTouched || modelTouched) {
          try {
            this.tools?.llmClient?.clearCache?.();
            const agent = this.tools?._agent;
            if (agent) {
              agent.client = null;
              if (typeof agent.init === 'function') agent.init();
            }
            report.reinitialized = true;
          } catch (e) {
            this.log.warn('[import] agent re-init failed: ' + e.message);
            report.reinitWarning = e.message;
          }
        }

        // Notify viewers to reload
        try {
          const graphEvents = require('../graph/events');
          graphEvents.emit('change', { op: 'graph:import', source: 'import', report });
        } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, report }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    const backupDelMatch = urlPath.match(/^\/api\/backups\/([^\/]+)$/);
    if (backupDelMatch && req.method === 'DELETE') {
      try {
        const backup = this.tools?._backup;
        if (!backup) { res.writeHead(503); res.end(JSON.stringify({ error: 'backup worker not available' })); return; }
        const u = new URL(req.url, 'http://x');
        const slug = String(u.searchParams.get('slug') || u.searchParams.get('graph') || '').trim() || null;
        const out = backup.deleteBackup(decodeURIComponent(backupDelMatch[1]), { slug });
        res.writeHead(out.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // /api/tailscale/{status,login,logout} moved to plugins/tailscale/.
    // Path-aliased: /api/tailscale/* rewrites to /api/plugins/tailscale/*
    // via the registerPathAlias hook. When the plugin is uninstalled
    // the alias disappears and these URLs 404.

    // /api/cluster/{settings,hosts,test-ssh,ssh-key,ssh-key/generate}
    // moved to plugins/compute-cluster/. Path-aliased: /api/cluster/*
    // rewrites to /api/plugins/compute-cluster/* via registerPathAlias.
    // Email settings + self-test live in plugins/email/ — see
    // registerWebRoute('/test').

    // ── Provider smoke tests ──
    if (urlPath.startsWith('/api/providers/') && urlPath.endsWith('/test') && req.method === 'POST') {
      const name = urlPath.slice('/api/providers/'.length, -'/test'.length);
      const body = await _readJsonBody(req);
      try {
        const result = await _probeProvider(name, body, this.tools?._pluginManager);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── List models from a provider's /models endpoint ──
    // Plugin-aware: if a provider plugin registered listModels under the
    // requested kind, prefer that — it can augment the vendor's response
    // with ctx/maxOutput when the provider exposes or safely enriches it.
    // Official OpenAI /v1/models doesn't expose ctx, so openai-provider
    // leaves it unknown instead of inventing a value. Falls back to core's _listModelsForProvider
    // for legacy custom-OAI probes (`kind: 'custom'`) and providers that
    // don't implement listModels.
    if (urlPath === '/api/providers/list-models' && req.method === 'POST') {
      let body = await _readJsonBody(req);
      try {
        if (body?.kind === 'custom' && body?.name) {
          const saved = _customProviderConfig(this.config, body.name);
          if (saved) {
            body = {
              ...body,
              baseUrl: body.baseUrl || body.url || saved.url || '',
              apiKey: body.apiKey || body.key || saved.key || '',
              authHeader: body.authHeader || saved.authHeader || 'bearer',
            };
          }
        }
        const mgr = this.tools?._pluginManager;
        const entry = _findProviderEntry(mgr, body.kind === 'custom' && body.name ? body.name : body.kind);
        let result;
        if (entry?.listModels) {
          const providerName = body.kind === 'custom' && body.name ? body.name : body.kind;
          result = await entry.listModels(_isCustomProviderEntry(entry, providerName, this.config)
            ? _customProviderProbeArgs(providerName, this.config, body)
            : body);
        } else {
          result = await _listModelsForProvider(body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Centralized model library ──
    // GET    /api/models/library              list all entries
    // POST   /api/models/library              add a single entry
    // PUT    /api/models/library/<id>         update fields (tracks user overrides)
    // DELETE /api/models/library/<id>         remove an entry
    // POST   /api/models/library/<id>/reset   reset to vendor defaults (re-probes /models)
    // POST   /api/models/library/discover     { provider } → returns suggested entries
    //                                         from the plugin's listModels (no DB writes)
    if (urlPath.startsWith('/api/models/library')) {
      // Auth already enforced by the dispatch site before delegating
      // to this method (see /api/* router above).
      const lib = require('../settings/model-library');
      const mgr = this.tools?._pluginManager;

      if (urlPath === '/api/models/library' && req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const includeUnavailable = query.get('all') === '1' || query.get('includeUnavailable') === 'true';
        const entries = this._visibleModelLibraryEntries(lib.list(), { includeUnavailable });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries }));
        return;
      }

      if (urlPath === '/api/models/library' && req.method === 'POST') {
        try {
          const body = await _readJsonBody(req);
          const out = lib.add(body, { upsert: !!body.upsert });
          res.writeHead(out.created ? 201 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (urlPath === '/api/models/library/discover' && req.method === 'POST') {
        // Run the provider plugin's listModels and return suggestions —
        // we never auto-insert; UI presents suggestions for opt-in.
        try {
          const body = await _readJsonBody(req);
          const provider = String(body.provider || '').trim().toLowerCase();
          if (!provider) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'provider required' }));
            return;
          }
          const entry = _findProviderEntry(mgr, provider);
          if (!entry?.listModels) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `provider ${provider} has no listModels probe` }));
            return;
          }
          // Probe credentials: pull from settings store (preferred) or
          // request body (when running from the wizard before save).
          const settings = require('../settings');
          const creds = body.credentials || {};
          const probeArgs = _isCustomProviderEntry(entry, provider, this.config)
            ? _customProviderProbeArgs(provider, this.config, creds)
            : {
                apiKey: creds.apiKey || settings.get(`providers.${provider}.apiKey`) || settings.get(`plugins.${provider}-provider.apiKey`),
                baseUrl: creds.baseUrl || settings.get(`providers.${provider}.baseUrl`) || settings.get(`plugins.${provider}-provider.baseUrl`),
                authHeader: creds.authHeader || settings.get(`providers.${provider}.authHeader`),
              };
          const probe = await entry.listModels(probeArgs);
          if (!probe?.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: probe?.error || 'discovery failed', suggestions: [] }));
            return;
          }
          // Build suggestion shape — mirror what add() expects so the
          // UI can POST suggestions back unchanged.
          const existingIds = new Set(lib.list({ provider }).map(e => e.id));
          const suggestions = (probe.models || []).map(m => {
            const id = lib.composeId(provider, m.id || m.modelId || m.name);
            return {
              id,
              provider,
              modelId: m.id || m.modelId || m.name,
              label: m.label || m.id || m.name,
              family: m.family || null,
              contextWindow: m.contextLength || m.contextWindow || null,
              maxOutput: m.maxOutput || null,
              capabilities: m.capabilities || (entry.capabilities || {}),
              source: 'auto',
              alreadyInLibrary: existingIds.has(id),
            };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, suggestions, provider }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // Per-id ops: PUT / DELETE / POST .../reset
      const idMatch = urlPath.match(/^\/api\/models\/library\/(.+?)(?:\/(reset))?$/);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const action = idMatch[2];
        if (action === 'reset' && req.method === 'POST') {
          try {
            const cur = lib.get(id);
            if (!cur) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
            const entry = _findProviderEntry(mgr, cur.provider);
            if (!entry?.listModels) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `provider ${cur.provider} has no listModels probe; cannot refresh` }));
              return;
            }
            const settings = require('../settings');
            const probe = await entry.listModels(_isCustomProviderEntry(entry, cur.provider, this.config)
              ? _customProviderProbeArgs(cur.provider, this.config)
              : {
                  apiKey: settings.get(`providers.${cur.provider}.apiKey`) || settings.get(`plugins.${cur.provider}-provider.apiKey`),
                  baseUrl: settings.get(`providers.${cur.provider}.baseUrl`) || settings.get(`plugins.${cur.provider}-provider.baseUrl`),
                });
            const match = (probe?.models || []).find(m => (m.id || m.modelId) === cur.modelId);
            if (!match) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'model no longer listed by vendor' }));
              return;
            }
            const fresh = {
              family: match.family || null,
              contextWindow: match.contextLength || match.contextWindow || null,
              maxOutput: match.maxOutput || null,
              capabilities: match.capabilities || (entry.capabilities || {}),
            };
            const out = lib.resetMetadata(id, fresh);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...out, fresh }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        if (req.method === 'PUT') {
          try {
            const body = await _readJsonBody(req);
            const out = lib.update(id, body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }
        if (req.method === 'DELETE') {
          const out = lib.remove(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // ── Routing presets ──
    // GET    /api/models/routing-presets           → list all presets
    // GET    /api/models/routing-presets/:name     → get preset by name
    // PUT    /api/models/routing-presets/:name     → save (upsert) preset
    // DELETE /api/models/routing-presets/:name     → delete preset
    // POST   /api/models/routing-presets/:name/apply → apply preset to live settings
    if (urlPath.startsWith('/api/models/routing-presets')) {
      const rp = require('../settings/routing-presets');
      const cliDeviceAuth = req._sporeCodeDeviceAuth || null;

      if (urlPath === '/api/models/routing-presets' && req.method === 'GET') {
        try {
          const presets = rp.list();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            presets,
            ...(cliDeviceAuth ? { current: cliDeviceAuth.routing || { scope: 'server', preset: null, config: null } } : {}),
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      const nameMatch = urlPath.match(/^\/api\/models\/routing-presets\/(.+)$/);
      if (nameMatch) {
        const name = decodeURIComponent(nameMatch[1]);

        if (req.method === 'GET') {
          try {
            const preset = rp.get(name);
            if (!preset) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...preset }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }

        if (req.method === 'PUT') {
          if (cliDeviceAuth) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Device tokens can apply presets to this device only; creator auth is required to save presets.' }));
            return;
          }
          try {
            const body = await _readJsonBody(req);
            if (!body.config) throw new Error('config is required');
            const out = rp.save(name, body.config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...out }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }

        if (req.method === 'DELETE') {
          if (cliDeviceAuth) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Device tokens can apply presets to this device only; creator auth is required to delete presets.' }));
            return;
          }
          try {
            const removed = rp.remove(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, removed }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
      }

      // POST /api/models/routing-presets/:name/apply → apply preset to live settings
        const applyMatch = urlPath.match(/^\/api\/models\/routing-presets\/([^\/]+)\/apply$/);
        if (applyMatch) {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return;
          }
          const applyName = decodeURIComponent(applyMatch[1]);
          try {
            const preset = rp.get(applyName);
            if (!preset) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'preset not found', name: applyName }));
              return;
            }
            const cfg = preset.config;
            if (cliDeviceAuth) {
              const plugin = this._sporeCodeModule();
              const out = plugin.setDeviceRoutingPreset?.(this._sporeCodeApiShim(), cliDeviceAuth.token, applyName, cfg);
              if (!out?.ok) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out || { ok: false, error: 'Invalid device token' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, applied: applyName, scope: 'device', current: out.routing }));
              return;
            }
            const patch = {};
            if (cfg.models) {
              for (const [tier, val] of Object.entries(cfg.models)) {
                const key = String(tier || '').replace(/^models\./, '').trim();
                if (!key) continue;
                if (val && val.provider && val.model) {
                  patch[`models.${key}`] = val.provider === 'anthropic'
                    ? String(val.model)
                    : `${val.provider}/${val.model}`;
                } else if (val) {
                  patch[`models.${key}`] = String(val);
                }
              }
            }
            if (cfg.modelLimits) {
              patch.modelLimits = cfg.modelLimits;
            }
            await this._settingsService.applyCanonicalPatch(patch);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, applied: applyName }));
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
            return;
          }
        }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // ── Model tier smoke tests ──
    if (urlPath.startsWith('/api/models/') && urlPath.endsWith('/test') && req.method === 'POST') {
      const tier = urlPath.slice('/api/models/'.length, -'/test'.length);
      const body = await _readJsonBody(req);
      try {
        const result = await _probeModelTier(tier, body, this.config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── Web search smoke test ──
    if (urlPath === '/api/websearch/test' && req.method === 'POST') {
      const body = await _readJsonBody(req);
      try {
        const { searchWeb } = require('../lib/web-search');
        const searxngUrl = String(body.searxngUrl || this.config.searxngUrl || '').trim();
        let searxngApiKey = String(body.searxngApiKey || '').trim();
        if (!searxngApiKey || searxngApiKey === '***hidden***') searxngApiKey = this.config.searxngApiKey || '';
        let braveApiKey = String(body.braveApiKey || '').trim();
        if (!braveApiKey || braveApiKey === '***hidden***') braveApiKey = this.config.braveApiKey || '';
        if (!searxngUrl && !braveApiKey) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No search provider configured' }));
          return;
        }
        const t0 = Date.now();
        const result = await searchWeb({ query: 'spore web search smoke test', count: 3, searxngUrl, searxngApiKey, braveApiKey, log: this.log });
        const latency = Date.now() - t0;
        if (result?.error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.error, latency_ms: latency }));
          return;
        }
        const results = Array.isArray(result?.results) ? result.results : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          provider: result?.provider || 'unknown',
          result_count: results.length,
          latency_ms: latency,
          excerpt: results[0]?.title || result?.note || '',
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/tokens/pricing' && req.method === 'GET') {
      try {
        const feed = require('../graph/feed');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pricing: this.config.tokenPricing || {}, effective: feed.readTokenPricing() }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/tokens/pricing' && req.method === 'PUT') {
      try {
        const body = await _readJsonBody(req);
        const pricing = body?.pricing;
        if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pricing object required' }));
          return;
        }
        const out = this._settingsService.applyCanonicalPatch({ tokenPricing: pricing }, { actor: 'tokens-dashboard' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pricing: out.settings?.tokenPricing || pricing }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/tokens' && req.method === 'GET') {
      try {
        const feed = require('../graph/feed');
        const summary = feed.readTokenSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary || { error: 'No token data yet' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/activity-log' && req.method === 'GET') {
      try {
        const feed = require('../graph/feed');
        const maxLines = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('lines') || '200', 10), 500);
        const entries = feed.readActivityLog(maxLines);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Plan-mode endpoints ──
    if (urlPath === '/api/plan/mode' && req.method === 'PUT') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const body = await _readJsonBody(req);
        const sessionKey = String(body.sessionKey || '').trim();
        const enabled = body.enabled === true;
        if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionKey required' })); return; }
        const sessions = this.tools._sessions;
        // Ensure the session row exists
        sessions.ensureSession(sessionKey);
        sessions.db.prepare('UPDATE sessions SET plan_mode=? WHERE key=?').run(enabled ? 1 : 0, sessionKey);
        try { this._broadcastToSessionKey(sessionKey, { type: 'plan_mode', enabled }); } catch (e) { this.log.warn('[web] this._broadcastToSessionKey failed: ' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, planMode: enabled }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if ((urlPath === '/api/plan/approve' || urlPath === '/api/plan/reject') && req.method === 'POST') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const body = await _readJsonBody(req);
        const sessionKey = String(body.sessionKey || '').trim();
        if (!sessionKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionKey required' })); return; }
        const fn = urlPath.endsWith('/approve') ? 'applyPlanProposals' : 'rejectPlanProposals';
        // Pass sessionKey explicitly — the approve/reject methods take it as
        // an argument and route internal dispatch through _executeToolDirect
        // which bypasses the plan-mode gate anyway.
        const out = await this.tools[fn](sessionKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out || { ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/plan/pending' && req.method === 'GET') {
      try {
        if (!isAnyAuth(req)) { res.writeHead(401); res.end(JSON.stringify({ error: 'auth required' })); return; }
        const sessionKey = new URL(req.url, 'http://x').searchParams.get('sessionKey') || '';
        const rows = this.tools.listPendingProposals(sessionKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proposals: rows }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Research selected nodes via the agent ──
    if (urlPath === '/api/graph/research' && req.method === 'POST') {
      try {
        const body = await _readJsonBody(req);
        const ids = Array.isArray(body.nodeIds) ? body.nodeIds.filter(x => typeof x === 'string').slice(0, 12) : [];
        if (!ids.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nodeIds (1-12) required' })); return; }
        const agent = this.tools?._agent;
        if (!agent || !agent.client) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Agent loop not initialised — finish onboarding first.' })); return; }

        // Build a focused brief per node so the agent has concrete context.
        const brief = ids.map(id => {
          const n = db.prepare('SELECT id, label, type, description FROM nodes WHERE id = ?').get(id);
          if (!n) return null;
          const aspects = db.prepare('SELECT id, name FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 6').all(id);
          const aspectLines = aspects.map(a => {
            const attrs = db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 4').all(a.id);
            return `  • ${a.name}: ${attrs.map(at => at.content).join(' | ').slice(0, 220)}`;
          }).join('\n');
          return `- **${n.label}** (\`${n.id}\`, type=${n.type})\n  ${n.description || '_(no description)_'}\n${aspectLines}`;
        }).filter(Boolean).join('\n\n');

        if (!brief) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No matching nodes found' })); return; }

        const scopedProjectArg = req._graphApiSlug ? ` Include \`project: "${req._graphApiSlug}"\` in every \`graph_update\` call so updates land in the graph currently open in the viewer.` : '';
        const prompt = [
          `Research request: bring the following node(s) up to date with the latest information from the web and your own knowledge.`,
          ``,
          brief,
          ``,
          `Steps:`,
          `1. Use **web_search** (and **web_fetch** when you need full article context) to find recent, authoritative info about each node.`,
          `2. Then use **graph_update** to record what you learned: add new attributes to existing aspects, create new aspects on the same node, or create entirely new connected nodes when something genuinely new comes up.${scopedProjectArg}`,
          `3. Do NOT delete anything that already exists. Be additive.`,
          `4. When you're done, post a short summary of what you changed.`,
        ].join('\n');

        const sessionKey = `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Fire and forget — the agent's graph_update calls will broadcast via
        // graphEvents and the viewer will pick them up over its existing WS.
        const researchRun = this._submitAgentTurn({
          content: prompt,
          channelId: sessionKey,
          channelName: 'research',
          sessionKey,
          userId: 'operator',
          userName: 'Operator',
          trigger: 'dm',
          platform: 'web',
          isDm: true,
        }, {
          lane: 'background',
          priority: 15,
          route: 'graph.research',
          graph: req._graphApiSlug || null,
          persistent: true,
          allowInterjection: false,
        });
        Promise.resolve(researchRun).catch(e => this.log.warn(`[research] agent run failed: ${e.message}`));

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionKey, nodeCount: ids.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Manually resume session summarize + distill ──
    if (urlPath === '/api/graph/session-distill' && req.method === 'POST') {
      try {
        const authContext = req._graphApiAuthContext || { type: 'creator', role: 'creator', creator: true };
        if (!_graphAuthIsCreator(authContext)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Creator access required' }));
          return;
        }
        const body = await _readJsonBody(req);
        const nodeId = String(body.nodeId || '').trim();
        if (!nodeId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'nodeId required' }));
          return;
        }
        const result = this._queueManualSessionSummaryDistill({
          db,
          graphSlug: req._graphApiSlug || null,
          nodeId,
          force: body.force !== false,
        });
        if (!result.ok) {
          res.writeHead(result.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error || 'manual session distill failed' }));
          return;
        }
        res.writeHead(result.queued ? 202 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/graph/merge' && req.method === 'POST') {
      try {
        const body = await _readJsonBody(req);
        const sourceId = String(body.sourceNodeId || '').trim();
        const targetId = String(body.targetNodeId || '').trim();
        const mode = String(body.mode || 'merge').toLowerCase();
        if (!sourceId || !targetId || sourceId === targetId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sourceNodeId + targetNodeId (different) required' }));
          return;
        }
        const src = db.prepare('SELECT id, label, type, description, importance FROM nodes WHERE id = ?').get(sourceId);
        const tgt = db.prepare('SELECT id, label, type, description, importance FROM nodes WHERE id = ?').get(targetId);
        if (!src || !tgt) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'one or both node ids not found' }));
          return;
        }

        // Fast path: 'child' creates a parent_of edge directly. The graph
        // viewer gives parent_of edges a short, high-strength link so the two
        // nodes visually stick together — that's the "stick under as child"
        // affordance.
        if (mode === 'child') {
          const edgeType = 'parent_of';
          // target → source direction (target becomes parent of source).
          const [s, t] = [targetId, sourceId];
          const dup = db.prepare('SELECT id FROM edges WHERE source=? AND target=? AND type=?').get(s, t, edgeType);
          if (!dup) {
            // User dragged target onto source in the viewer — explicit
            // human-asserted parent_of edge.
            db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?, ?, ?, 1.0, ?, 'extracted')")
              .run(s, t, edgeType, 'drop-menu');
          }
          try {
            const graphEvents = require('../graph/events');
            graphEvents.emit('change', { op: 'edge:create', edge: { source: s, target: t, type: edgeType }, source: 'drop-menu' });
          } catch (e) { this.log.warn('[web] require failed: ' + e.message); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode, edge: { source: s, target: t, type: edgeType }, created: !dup }));
          return;
        }

        // mode === 'merge' — hand off to the agent with a detailed brief.
        const agent = this.tools?._agent;
        if (!agent || !agent.client) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent loop not initialised — finish onboarding first.' }));
          return;
        }
        const briefFor = (n) => {
          const aspects = db.prepare('SELECT id, name, weight FROM aspects WHERE node_id = ? ORDER BY weight DESC LIMIT 12').all(n.id);
          const aspectLines = aspects.map(a => {
            const attrs = db.prepare('SELECT content FROM attributes WHERE aspect_id = ? ORDER BY importance DESC LIMIT 4').all(a.id);
            const attrText = attrs.map(at => at.content).join(' | ').slice(0, 300);
            return `    • ${a.name} (importance=${a.weight}): ${attrText || '_(no attrs)_'}`;
          }).join('\n');
          const outgoing = db.prepare('SELECT target, type FROM edges WHERE source = ? LIMIT 20').all(n.id);
          const incoming = db.prepare('SELECT source, type FROM edges WHERE target = ? LIMIT 20').all(n.id);
          const outLines = outgoing.map(e => `    ${e.type} → ${e.target}`).join('\n');
          const inLines = incoming.map(e => `    ${e.source} --${e.type}--> (this node)`).join('\n');
          const attrCount = db.prepare('SELECT COUNT(*) AS c FROM attributes a JOIN aspects s ON s.id=a.aspect_id WHERE s.node_id=?').get(n.id).c;
          return `- **${n.label}** (\`${n.id}\`, type=${n.type}, importance=${n.importance}, ${aspects.length} aspects / ${attrCount} attrs / ${outgoing.length + incoming.length} edges)\n  ${n.description || '_(no description)_'}\n  Aspects:\n${aspectLines || '    _(none)_'}\n  Outbound edges:\n${outLines || '    _(none)_'}\n  Inbound edges:\n${inLines || '    _(none)_'}`;
        };
        const scopedProjectArg = req._graphApiSlug ? ` Include \`project: "${req._graphApiSlug}"\` in every \`graph_update\` and \`graph_delete\` call so the edit lands in the graph currently open in the viewer.` : '';
        let prompt;
        if (mode === 'link') {
          prompt = [
            `The operator dragged node \`${sourceId}\` onto node \`${targetId}\` in the graph viewer and chose "Link with an edge". Decide whether these two nodes are actually related, and if so what the relationship is.`,
            ``,
            briefFor(src),
            ``,
            briefFor(tgt),
            ``,
            `**Procedure:**`,
            ``,
            `1. Judge the relationship from the content above. Ask: is there a real, specific connection between these two? Examples of real relationships: "uses", "knows", "created_by", "part_of", "depends_on", "located_in", "works_on", "mentions", "authored".`,
            ``,
            `2. If they ARE related, call \`graph_update\` on \`${sourceId}\` with its existing label and type, plus \`edges: [{ target: "${targetId}", type: "<your-chosen-relationship>" }]\`. Pick the tightest, most specific verb you can justify — don't fall back to \`related_to\` unless nothing else fits.${scopedProjectArg}`,
            ``,
            `3. If they are NOT meaningfully related, do not create any edge. Just reply with a short sentence explaining that.`,
            ``,
            `4. End with one line: either \`Linked ${sourceId} --<type>--> ${targetId}.\` or \`No meaningful link — <reason>.\``,
            ``,
            `Do not call \`graph_query\` — everything you need is above.`,
          ].join('\n');
        } else {
          // mode === 'merge' (default)
          prompt = [
            `The operator dragged node \`${sourceId}\` onto node \`${targetId}\` in the graph viewer. Merge them into one coherent node.`,
            ``,
            briefFor(src),
            ``,
            briefFor(tgt),
            ``,
            `**Procedure (do NOT skip steps):**`,
            ``,
            `1. **Pick a SURVIVOR and a LOSER.** The survivor should be whichever has richer content, more edges, higher importance, or a cleaner id. If equivalent, pick the shorter/cleaner id.`,
            ``,
            `2. **Call \`graph_update\` on the SURVIVOR**${scopedProjectArg} with:`,
            `   - Its existing \`label\` and \`type\` (required fields)`,
            `   - A merged \`description\` that incorporates any useful info from the loser`,
            `   - \`aspects\`: any aspects from the loser that add new facts. Skip aspects whose attributes already exist on the survivor (dedupe).`,
            `   - \`edges\`: for every edge where the LOSER is the source (outbound), add an equivalent edge \`{target, type}\` so it survives on the survivor. Skip duplicates.`,
            ``,
            `3. **For each inbound edge where the LOSER is the target** (listed above under "Inbound edges"), call \`graph_update\` on the OTHER end (the \`source\`) and add \`edges: [{target: "<survivor-id>", type: "<same-type>"}]\` so incoming connections re-home to the survivor.`,
            ``,
            `4. **Call \`graph_delete\` with \`{ nodeId: "<loser-id>"${req._graphApiSlug ? `, project: "${req._graphApiSlug}"` : ''} }\`** — this cascades the loser's aspects, attributes, and any remaining edges.`,
            ``,
            `5. **Reply with one line** like: \`Merged \\\`loser-id\\\` into \\\`survivor-id\\\` — kept N aspects, rehomed M edges.\``,
            ``,
            `Do not call \`graph_query\` — everything you need is above. Do not skip step 4 or the two nodes will remain duplicated in the graph.`,
          ].join('\n');
        }

        // Fresh ephemeral channel session per merge/link so this doesn't
        // ride on top of operator's DM history (which can run to hundreds of
        // messages and blow the upstream context → 504 from the LLM proxy).
        // The prompt is self-contained; it doesn't need any prior turns.
        const sessionKey = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const graphEditRun = this._submitAgentTurn({
          content: prompt,
          channelId: sessionKey,
          channelName: mode,
          sessionKey,
          userId: 'operator',
          userName: 'Operator',
          trigger: 'channel',
          platform: 'web',
          isDm: false,
        }, {
          lane: 'background',
          priority: 20,
          route: `graph.${mode}`,
          graph: req._graphApiSlug || null,
          persistent: true,
          allowInterjection: false,
        });
        Promise.resolve(graphEditRun).catch(e => this.log.warn(`[graph:${mode}] agent run failed: ${e.message}`));

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionKey, sourceId, targetId }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (urlPath.startsWith('/api/graph/node/') && req.method === 'GET') {
      const nodeId = decodeURIComponent(urlPath.split('/api/graph/node/')[1] || '');
      try {
        const payload = _graphBuildNodeDetails(db, nodeId, { graph: graphMetaForResponse() });
        if (!payload) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Node not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (urlPath === '/api/graph/node' && req.method === 'POST') {
      json().then(data => {
        const { id, label, type, description, importance } = data;
        if (!id || !label || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'id, label, type required' })); return; }
        const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
        if (existing) db.prepare(`UPDATE nodes SET label=?, type=?, description=?, importance=?, updated=datetime('now') WHERE id=?`).run(label, type, description || '', importance || 5, id);
        else db.prepare('INSERT INTO nodes (id, label, type, description, importance, provenance) VALUES (?,?,?,?,?,?)').run(id, label, type, description || '', importance || 5, 'self');
        graphEvents.emit('change', { op: existing ? 'node:update' : 'node:create', node: { id, label, type, description: description || '' }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, id }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/node/') && req.method === 'DELETE') {
      const nodeId = decodeURIComponent(urlPath.split('/api/graph/node/')[1]);
      try {
        const edges = db.prepare('SELECT source, target, type FROM edges WHERE source = ? OR target = ?').all(nodeId, nodeId);
        db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)').run(nodeId);
        db.prepare('DELETE FROM aspects WHERE node_id = ?').run(nodeId);
        db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(nodeId, nodeId);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        for (const e of edges) { graphEvents.emit('change', { op: 'edge:delete', edge: e, source: 'editor' }); }
        graphEvents.emit('change', { op: 'node:delete', nodeId, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath === '/api/graph/aspect' && req.method === 'POST') {
      json().then(data => {
        const { nodeId, name, weight, attributes } = data;
        if (!nodeId || !name) { res.writeHead(400); res.end(JSON.stringify({ error: 'nodeId, name required' })); return; }
        const existing = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=?').get(nodeId, name);
        if (existing) { db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(existing.id); db.prepare('DELETE FROM aspects WHERE id=?').run(existing.id); }
        db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?,?,?,?)').run(nodeId, name, weight || 5, 'graph-viewer');
        const aspectId = db.prepare('SELECT id FROM aspects WHERE node_id=? AND name=? ORDER BY id DESC LIMIT 1').get(nodeId, name).id;
        if (attributes?.length) { const stmt = db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?,?,?,?,?)'); for (const a of attributes) stmt.run(aspectId, typeof a === 'string' ? a : a.content, a.importance || 5, 'graph-viewer', 'graph-viewer'); }
        graphEvents.emit('change', { op: existing ? 'aspect:update' : 'aspect:create', nodeId, aspect: name, source: 'editor' });
        if (attributes?.length) graphEvents.emit('change', { op: 'attribute:create', nodeId, aspect: name, source: 'editor', detail: `${attributes.length} attribute(s)` });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, aspectId }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath.startsWith('/api/graph/aspect/') && req.method === 'DELETE') {
      const aspectId = parseInt(urlPath.split('/api/graph/aspect/')[1]);
      try {
        const asp = db.prepare('SELECT id, node_id, name FROM aspects WHERE id=?').get(aspectId);
        db.prepare('DELETE FROM attributes WHERE aspect_id=?').run(aspectId);
        db.prepare('DELETE FROM aspects WHERE id=?').run(aspectId);
        if (asp) graphEvents.emit('change', { op: 'aspect:delete', aspectId, nodeId: asp.node_id, aspect: asp.name, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'DELETE') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      try {
        const attr = db.prepare('SELECT a.id, asp.node_id, asp.name FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id WHERE a.id = ?').get(attrId);
        db.prepare('DELETE FROM attributes WHERE id = ?').run(attrId);
        if (attr) graphEvents.emit('change', { op: 'attribute:delete', attributeId: attrId, nodeId: attr.node_id, aspect: attr.name, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }
      catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (urlPath.startsWith('/api/graph/attribute/') && req.method === 'PUT') {
      const attrId = parseInt(urlPath.split('/api/graph/attribute/')[1]);
      json().then(data => {
        const { content, importance } = data;
        if (!content) { res.writeHead(400); res.end(JSON.stringify({ error: 'content required' })); return; }
        const attr = db.prepare('SELECT a.id, asp.node_id, asp.name FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id WHERE a.id = ?').get(attrId);
        db.prepare('UPDATE attributes SET content = ?, importance = ? WHERE id = ?').run(content, importance || 5, attrId);
        if (attr) graphEvents.emit('change', { op: 'attribute:update', attributeId: attrId, nodeId: attr.node_id, aspect: attr.name, content, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'POST') {
      json().then(data => {
        const { source, target, type, weight, confidence } = data;
        if (!source || !target || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'source, target, type required' })); return; }
        const existing = db.prepare('SELECT rowid FROM edges WHERE source=? AND target=? AND type=?').get(source, target, type);
        // User-edited edges are 'extracted' by default — operator is
        // asserting the relationship directly. Caller may override.
        const conf = (typeof confidence === 'string' && ['extracted','inferred','ambiguous'].includes(confidence.toLowerCase()))
          ? confidence.toLowerCase()
          : 'extracted';
        if (existing) db.prepare('UPDATE edges SET weight=?, confidence=? WHERE source=? AND target=? AND type=?').run(weight || 1, conf, source, target, type);
        else db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with, confidence) VALUES (?,?,?,?, 'editor', ?)").run(source, target, type, weight || 1, conf);
        graphEvents.emit('change', { op: existing ? 'edge:update' : 'edge:create', edge: { source, target, type, confidence: conf }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    if (urlPath === '/api/graph/edge' && req.method === 'DELETE') {
      json().then(data => {
        const { source, target, type } = data;
        db.prepare('DELETE FROM edges WHERE source=? AND target=? AND type=?').run(source, target, type);
        graphEvents.emit('change', { op: 'edge:delete', edge: { source, target, type }, source: 'editor' });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }));
      }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  }
}

module.exports = {
  WebGateway,
  _test: {
    _isChatSubmitType,
    _clearCliPendingToolTimers,
    _startCliPendingToolTimer,
    _findCliPendingTool,
  },
};
