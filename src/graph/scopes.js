'use strict';

const crypto = require('crypto');
const path = require('path');

function normalizeGitRemote(remote) {
  if (!remote || typeof remote !== 'string') return null;
  let s = remote.trim();
  if (!s) return null;
  s = s.replace(/^git@([^:]+):/, 'https://$1/');
  s = s.replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

function _safePart(value, fallback = 'project') {
  const s = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function _hash(value, len = 12) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

function normalizeProjectRoot(root) {
  const raw = String(root || '').trim();
  if (!raw) return '';
  let s = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  s = s.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  return s;
}

function projectIdentityFromContext(userId, pc = {}) {
  if (!pc || typeof pc !== 'object') return null;
  const remote = normalizeGitRemote(
    pc.gitRemote || pc.remoteUrl || pc.originUrl || pc.origin || pc.git?.remote || pc.git?.origin
  );
  const root = pc.gitRoot || pc.repoRoot || pc.root || pc.workspaceRoot || pc.cwd || '';
  const normalizedRoot = normalizeProjectRoot(root);
  if (remote) {
    return {
      key: `git:${remote}`,
      label: pc.project || path.basename(root || remote) || 'Project',
      basis: 'git-remote',
      remote,
      root,
    };
  }
  const machine = pc.machineId || pc.hostname || pc.host || 'unknown-machine';
  const cwd = pc.cwd || root;
  if (!cwd) return null;
  return {
    key: `cwd:${_safePart(machine, 'unknown-machine')}:${normalizedRoot || normalizeProjectRoot(cwd)}`,
    label: pc.project || path.basename(cwd) || 'Project',
    basis: 'cwd',
    remote: null,
    root: cwd,
  };
}

function channelIdentityFromContext(opts = {}) {
  const platform = String(opts.platform || '').trim().toLowerCase();
  if (!platform || platform === 'web' || platform === 'cli') return null;
  const userId = opts.userId != null ? String(opts.userId).trim() : '';
  const channelId = opts.channelId != null ? String(opts.channelId).trim() : '';
  const userName = String(opts.userName || '').trim();
  const channelName = String(opts.channelName || '').trim();
  const isDm = opts.isDm !== false;

  if (isDm && userId) {
    return {
      key: `channel-person:${platform}:${userId}`,
      label: userName || `${platform} user ${userId}`,
      basis: 'person',
      platform,
      userId,
      channelId: channelId || userId,
      description: `${platform} channel memory for ${userName || userId}`,
    };
  }

  if (channelId) {
    return {
      key: `channel-thread:${platform}:${channelId}`,
      label: channelName || `${platform} channel ${channelId}`,
      basis: 'channel',
      platform,
      userId: userId || null,
      channelId,
      description: `${platform} channel memory for ${channelName || channelId}`,
    };
  }

  return null;
}

function webUserIdentityFromContext(opts = {}) {
  const platform = String(opts.platform || '').trim().toLowerCase();
  const role = String(opts.userRole || opts.role || '').trim().toLowerCase();
  if (platform !== 'web' || role !== 'webapp') return null;
  const rawUser = opts.userId != null ? String(opts.userId).trim() : String(opts.userName || '').trim();
  if (!rawUser || /^operator$/i.test(rawUser) || /^guest$/i.test(rawUser)) return null;
  const userPart = _safePart(rawUser, 'user');
  const label = String(opts.userName || rawUser).trim() || rawUser;
  return {
    key: `web-user:${userPart}`,
    label,
    basis: 'web-user',
    username: rawUser,
    description: `Private web memory for ${label}`,
  };
}

function looksReusableTechnicalQuery(text) {
  const t = String(text || '');
  return /\b(code|repo|project|react|vite|next|node|docker|plugin|api|css|ui|bug|error|stack|library|framework|build|test|deploy|database|schema|migration|provider|model|tool|browser|playwright|zendriver|settings|wizard)\b/i.test(t);
}

function _scope(registry, slug, role, label, budget = 10) {
  if (!registry || !slug || !registry.get(slug)) return null;
  return {
    slug,
    role: role || registry.get(slug)?.role || 'custom',
    label: label || registry.get(slug)?.name || slug,
    dbPath: registry.getDbPath(slug),
    budget,
  };
}

function _dedupeScopes(scopes) {
  const out = [];
  const seen = new Set();
  for (const s of scopes) {
    if (!s || !s.slug || seen.has(s.slug)) continue;
    seen.add(s.slug);
    out.push(s);
  }
  return out;
}

function resolveDefaultMemoryEnvelope({ opts = {}, registry, log } = {}) {
  if (!registry) return null;
  if (opts.memoryEnvelope && typeof opts.memoryEnvelope === 'object') {
    const base = opts.memoryEnvelope;
    const activeSlug = base.activeSlug || registry.getActiveSlug?.();
    const mainSlug = registry.getMainSlug?.();
    const generalSlug = registry.getGeneralKnowledgeSlug?.();
    const primarySlug = base.primarySlug || base.writeScopes?.defaultSlug || activeSlug || mainSlug;
    const readScopes = _dedupeScopes((base.readScopes || []).map(s => {
      if (!s?.slug || !registry.get(s.slug)) return null;
      const graph = registry.get(s.slug);
      return {
        ...s,
        role: s.role || graph.role || 'custom',
        label: s.label || graph.name || s.slug,
        dbPath: s.dbPath || registry.getDbPath(s.slug),
      };
    }));
    if (!readScopes.length && primarySlug) {
      readScopes.push(_scope(registry, primarySlug, registry.get(primarySlug)?.role, registry.get(primarySlug)?.name, 14));
    }
    const envelope = {
      version: base.version || 1,
      source: base.source || opts.platform || 'custom',
      mode: base.mode || 'scoped',
      activeSlug,
      primarySlug,
      projectSlug: base.projectSlug || null,
      projectKey: base.projectKey || null,
      channelSlug: base.channelSlug || null,
      channelKey: base.channelKey || null,
      userSlug: base.userSlug || null,
      userKey: base.userKey || null,
      readScopes,
      writeScopes: {
        defaultSlug: primarySlug || mainSlug,
        personalSlug: mainSlug,
        userSlug: base.userSlug || base.writeScopes?.userSlug || null,
        generalKbSlug: generalSlug,
        ...(base.writeScopes || {}),
      },
    };
    log?.debug?.(`[memory] envelope override ${envelope.mode}: reads=${envelope.readScopes.map(s => s.slug).join(',')} write=${envelope.writeScopes.defaultSlug}`);
    return envelope;
  }
  const activeSlug = registry.getActiveSlug();
  const active = registry.get(activeSlug);
  const mainSlug = registry.getMainSlug();
  const generalSlug = registry.getGeneralKnowledgeSlug();
  const mainScope = _scope(registry, mainSlug, 'main', 'User/System Preferences', 8);
  const generalScope = _scope(registry, generalSlug, 'general_kb', 'Reusable Engineering Memory', 8);
  const platform = String(opts.platform || '').trim().toLowerCase();
  const role = String(opts.userRole || opts.role || '').trim().toLowerCase();
  const isCliProjectSession = !!(
    opts.projectContext?.cwd
    && (platform === 'cli' || role === 'cli' || opts.projectContext?.source === 'spore-code')
  );

  let mode = 'normal-chat';
  let primarySlug = active?.protected ? mainSlug : activeSlug;
  let projectSlug = null;
  let projectKey = null;
  let channelSlug = null;
  let channelKey = null;
  let userSlug = null;
  let userKey = null;
  const readScopes = [];

  if (isCliProjectSession) {
    const identity = projectIdentityFromContext(opts.userId || opts.userName, opts.projectContext);
    if (identity) {
      projectKey = identity.key;
      projectSlug = registry.ensureProjectGraph(identity.key, {
        name: identity.label,
        description: `${identity.basis} project memory${identity.remote ? ` for ${identity.remote}` : ` for ${identity.root}`}`,
        source: 'spore-code',
        createdBy: 'spore-code',
        userId: opts.userId || opts.userName || 'anon',
        projectKey: identity.key,
        projectRoot: identity.root,
        projectRemote: identity.remote,
      });
      registry.markProjectGraphActivity?.(projectSlug, {
        reason: 'codebase-turn',
        userId: opts.userId || opts.userName || 'anon',
        username: opts.userName || opts.userId || 'anon',
        projectRoot: identity.root,
        projectRemote: identity.remote,
      });
      mode = 'codebase-session';
      primarySlug = projectSlug;
      readScopes.push(_scope(registry, projectSlug, 'project', 'Project Memory', 18));
      readScopes.push(generalScope);
      // Main graph identity/preferences are already injected by the normal
      // persona/person sections. Do not run free-text recall over the main
      // graph for code sessions: it contains global activity logs and older
      // project snippets that can make a fresh project graph sound like it
      // has already read the codebase.
    }
  }

  if (readScopes.length === 0) {
    const identity = webUserIdentityFromContext(opts);
    if (identity) {
      userKey = identity.key;
      userSlug = registry.ensureUserGraph(identity.key, {
        name: `${identity.label} Memory`,
        description: identity.description,
        source: 'webapp',
        createdBy: 'webapp',
        username: identity.username,
        userId: identity.username,
        webappUser: identity.username,
        owner: identity.username,
      });
      registry.markUserGraphActivity?.(userSlug, {
        reason: 'web-user-turn',
        username: identity.username,
        userId: identity.username,
      });
      mode = 'web-user-session';
      primarySlug = userSlug;
      readScopes.push(_scope(registry, userSlug, 'user', 'User Memory', 18));
      readScopes.push(_scope(registry, mainSlug, 'main', 'Default Knowledge', 6));
      readScopes.push(generalScope);
    }
  }

  if (readScopes.length === 0) {
    const identity = channelIdentityFromContext(opts);
    if (identity) {
      channelKey = identity.key;
      channelSlug = registry.ensureChannelGraph(identity.key, {
        name: identity.label,
        description: identity.description,
        source: identity.platform,
        createdBy: identity.platform,
        platform: identity.platform,
        externalUserId: identity.userId,
        externalChannelId: identity.channelId,
      });
      registry.markChannelGraphActivity?.(channelSlug, {
        reason: 'channel-turn',
        platform: identity.platform,
        externalUserId: identity.userId,
        externalChannelId: identity.channelId,
      });
      mode = identity.basis === 'person' ? 'channel-person-session' : 'channel-thread-session';
      primarySlug = channelSlug;
      readScopes.push(_scope(registry, channelSlug, 'channel', 'Channel Memory', 18));
      readScopes.push(_scope(registry, generalSlug, 'general_kb', 'Reusable Engineering Memory', looksReusableTechnicalQuery(opts.content || opts.messageContent) ? 8 : 4));
    }
  }

  if (readScopes.length === 0) {
    readScopes.push(_scope(registry, primarySlug || mainSlug, active?.role || 'custom', 'Active Graph', 14));
    if (mainSlug !== primarySlug) readScopes.push(mainScope);
    readScopes.push(_scope(registry, generalSlug, 'general_kb', 'Reusable Engineering Memory', looksReusableTechnicalQuery(opts.content || opts.messageContent) ? 8 : 4));
  }

  const envelope = {
    version: 1,
    source: opts.platform || 'web',
    mode,
    activeSlug,
    primarySlug,
    projectSlug,
    projectKey,
    channelSlug,
    channelKey,
    userSlug,
    userKey,
    readScopes: _dedupeScopes(readScopes),
    writeScopes: {
      defaultSlug: primarySlug || mainSlug,
      personalSlug: mainSlug,
      projectSlug,
      channelSlug,
      userSlug,
      generalKbSlug: generalSlug,
    },
  };
  log?.debug?.(`[memory] envelope ${mode}: reads=${envelope.readScopes.map(s => s.slug).join(',')} write=${envelope.writeScopes.defaultSlug}`);
  return envelope;
}

function mergeMemoryEnvelope(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const merged = {
    ...(base || {}),
    ...patch,
    writeScopes: { ...(base?.writeScopes || {}), ...(patch.writeScopes || {}) },
  };
  merged.readScopes = _dedupeScopes([...(patch.readScopes || []), ...((patch.replaceReadScopes ? [] : base?.readScopes) || [])]);
  return merged;
}

module.exports = {
  normalizeGitRemote,
  normalizeProjectRoot,
  projectIdentityFromContext,
  channelIdentityFromContext,
  webUserIdentityFromContext,
  looksReusableTechnicalQuery,
  resolveDefaultMemoryEnvelope,
  mergeMemoryEnvelope,
};
