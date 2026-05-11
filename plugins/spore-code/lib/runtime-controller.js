'use strict';

const { coreRequire } = require('../../core-require');
const { projectIdentityFromContext } = coreRequire('graph/scopes');

function normalizeToolList(list) {
  if (!Array.isArray(list)) return null;
  const names = list.map(x => String(x || '').trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function withLearnerDb(learner, db, graphSlug = null) {
  if (!learner || !db) return learner;
  const scoped = Object.create(learner);
  scoped.db = db;
  if (graphSlug) scoped._graphSlug = graphSlug;
  return scoped;
}

class SporeCodeRuntimeController {
  constructor() {
    this.sessionGraphSlugs = new Map();
    this.sessionProjectKeys = new Map();
    this.sessionClientTools = new Map();
    this.sessionClientVersions = new Map();
  }

  clearSessionRuntimeState(sessionId) {
    const key = String(sessionId);
    this.sessionGraphSlugs.delete(key);
    this.sessionProjectKeys.delete(key);
    this.sessionClientTools.delete(key);
    this.sessionClientVersions.delete(key);
  }

  clientToolsForCtx(ctx) {
    return normalizeToolList(ctx?.clientTools)
      || normalizeToolList(ctx?.projectContext?.localTools)
      || (ctx?.channelId ? this.sessionClientTools.get(String(ctx.channelId)) : null)
      || null;
  }

  clientToolAvailable(toolName, opts = {}) {
    return (ctx = {}) => {
      if (ctx.platform !== 'cli') return false;
      const pc = ctx.projectContext || {};
      if (!pc.cwd && !pc.clientCwd) return false;
      const tools = this.clientToolsForCtx(ctx);
      if (!tools) return opts.legacyTools?.has?.(toolName) || false;
      return tools.has(toolName);
    };
  }

  clientToolMeta(toolName, opts = {}) {
    return {
      platforms: ['cli'],
      requiresProjectContext: true,
      requiresClientTool: toolName,
      available: this.clientToolAvailable(toolName, opts),
    };
  }

  projectGraphForContext(api, userId, pc = {}) {
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
      skipLocationMatch: identity.basis === 'explicit',
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

  scopedLearnerForTurn(api, opts) {
    const slug = opts?.memoryEnvelope?.writeScopes?.projectSlug || opts?.memoryEnvelope?.projectSlug || null;
    const learner = api._appContext?.learner;
    if (!slug || !learner?.getGraphDb) return learner;
    const db = learner.getGraphDb(slug);
    return db ? withLearnerDb(learner, db, slug) : learner;
  }

  scopedSessionMemory(api, ws, msg = {}) {
    const ctx = api._appContext;
    const baseLearner = ctx?.tools?.learner || ctx?.learner;
    const sessionId = msg.sessionId != null ? String(msg.sessionId) : null;
    const userId = ws?._user || msg.userName || 'anon';
    const pc = { ...(msg.projectContext || {}), cwd: msg.cwd || msg.projectContext?.cwd };
    let slug = sessionId ? this.sessionGraphSlugs.get(sessionId) : null;
    let projectIdentityKey = sessionId ? this.sessionProjectKeys.get(sessionId) : null;

    if (!slug && pc.cwd) {
      const scoped = this.projectGraphForContext(api, userId, pc);
      if (scoped?.slug) {
        slug = scoped.slug;
        projectIdentityKey = scoped.identityKey;
        if (sessionId) this.rememberSessionGraph(sessionId, slug, projectIdentityKey);
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

  rememberSessionGraph(sessionId, slug, projectIdentityKey) {
    if (!sessionId || !slug) return;
    const key = String(sessionId);
    this.sessionGraphSlugs.set(key, slug);
    if (projectIdentityKey) this.sessionProjectKeys.set(key, projectIdentityKey);
  }

  rememberSessionClient(sessionId, { localTools, clientVersion } = {}) {
    if (!sessionId) return;
    const key = String(sessionId);
    const tools = normalizeToolList(localTools);
    if (tools) this.sessionClientTools.set(key, tools);
    if (clientVersion) this.sessionClientVersions.set(key, String(clientVersion));
  }

  graphSlugForSession(sessionId) {
    return sessionId ? this.sessionGraphSlugs.get(String(sessionId)) : null;
  }

  projectKeyForSession(sessionId) {
    return sessionId ? this.sessionProjectKeys.get(String(sessionId)) : null;
  }
}

module.exports = {
  SporeCodeRuntimeController,
  normalizeToolList,
  withLearnerDb,
};
