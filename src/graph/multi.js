/**
 * multi.js — Multi-Graph Registry & Switching
 *
 * Manages multiple knowledge graphs per spore.
 * Each graph is a separate SQLite DB in /data/graphs/.
 * A registry file tracks metadata; an _active pointer selects the live graph.
 *
 * On first boot, migrates the legacy single graph.db into the registry.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const GRAPHS_DIR_NAME = 'graphs';
const REGISTRY_FILE = '_registry.json';
const ACTIVE_FILE = '_active';
const GENERAL_KB_SLUG = 'spore-knowledge-base';
const PROJECT_REF_SOURCE = 'project-graph-seed';
const CHANNEL_REF_SOURCE = 'channel-graph-seed';

const PROJECT_REF_NODES = [
  {
    id: 'ref-project-scope',
    label: 'Project Scope',
    description: 'Rules for working inside this Spore Code project graph.',
    aspects: {
      scope: [
        'This graph is scoped to one user project identity. Treat it as local project memory, not the user/global graph.',
        'Stay inside the projectContext.cwd unless the user explicitly expands scope.',
        'Use client-side project paths from tool results and projectContext, not server/container paths.',
        'Container paths such as /app, /data, /workspace, and /mnt are Spore Core paths, not the user project. Do not use them for project file work.',
      ],
      workflow: [
        'Prefer project tools and code-index queries before broad filesystem scans.',
        'Use plan mode for non-trivial changes, then execute only after approval.',
      ],
    },
  },
  {
    id: 'ref-project-memory',
    label: 'Project Memory Workflow',
    description: 'How durable project discoveries are recorded and distilled.',
    aspects: {
      memory: [
        'Use note_discovery for durable project-specific facts, fixes, working commands, and gotchas.',
        'Session-born nodes are temporary until session-end distillation promotes durable project knowledge.',
        'Reusable lessons may be sanitized into the protected general knowledge base; project-specific details stay here.',
      ],
      cleanup: [
        'Session nodes are archived after distillation; permanent project nodes carry the useful memory forward.',
        'Scratch helpers belong on the project node, not in the general knowledge base.',
      ],
    },
  },
  {
    id: 'ref-project-code-index',
    label: 'Code Index Cache',
    description: 'How to use and maintain the project code graph summary.',
    aspects: {
      code_graph: [
        'The project node may contain a code_graph aspect with indexed files, symbols, clusters, hot paths, and tech stack.',
        'A code_graph summary is a structural index, not proof that a prior assistant turn read or explained the codebase.',
        'If the cached code_graph is missing or stale, run architecture/code-index tools once and update_code_graph_summary immediately.',
        'Do not let generic cleanup delete code_graph, manifest, dependencies, configuration, or recent project activity aspects.',
      ],
    },
  },
  {
    id: 'ref-project-recall',
    label: 'Scoped Recall',
    description: 'How recall should combine project, reusable, and user memory.',
    aspects: {
      recall: [
        'Project memory is the primary truth for this project session.',
        'General knowledge base memory is reusable engineering guidance and may apply by analogy.',
        'Main graph memory is for user identity, preferences, and global settings, not project implementation details.',
        'A fresh project graph plus General Knowledge Base means the project has no prior local memory, but reusable lessons may still apply.',
      ],
    },
  },
  {
    id: 'ref-project-runtime',
    label: 'Spore Code Runtime Access',
    description: 'How to reason about tools in a Spore Code project session.',
    aspects: {
      access: [
        'In Spore Code sessions, file and shell tools are routed to the user machine for the current project. Behave like a coding agent with local access, not a remote chatbot.',
        'When the user asks about local state, run the relevant tool and answer from the actual result.',
        'Do not claim a tool, browser, shell, or file access is unavailable if it is listed in the current tool catalog.',
      ],
      results: [
        'Tool results are the source of truth. If a command output is empty, echoed, truncated, or clearly not the expected command result, treat that as inconclusive and verify another way.',
        'Never say a server is running, a process is killed, or a file changed unless the tool result proves it.',
        'Use small tool batches and keep the user informed after writes or long commands. Avoid hiding many mutating actions in one oversized turn.',
      ],
    },
  },
  {
    id: 'ref-project-shell',
    label: 'Shell And Quoting',
    description: 'Cross-platform command execution rules for project sessions.',
    aspects: {
      shell: [
        'Check the platform from Project Context before using shell syntax. Windows command lines, PowerShell, and POSIX shells do not share quoting, pipes, or built-ins.',
        'Prefer native tools such as read_file, write_file, grep, and glob over shell pipelines when they avoid quoting or platform issues.',
        'If PowerShell command text is echoed back instead of executed, the quoting failed. Do not treat the echoed command as a successful result.',
      ],
      fallback: [
        'After two failed shell attempts of the same kind, switch approach: use a script file, Node/Python helper, native tool, or web lookup before trying another variant.',
        'For Windows paths, prefer tool path fields or script files over deeply nested quoted one-liners.',
      ],
    },
  },
  {
    id: 'ref-project-processes',
    label: 'Processes And Dev Servers',
    description: 'How to start, inspect, and stop long-running project processes.',
    aspects: {
      background: [
        'Long-running dev servers should run in the background when the tool supports it. Capture the background id and log path.',
        'Use background log inspection or process/port checks to verify readiness before reporting that a server is ready.',
      ],
      stop_verify: [
        'When asked to stop servers, stop the relevant processes and then verify with a separate process or port check.',
        'An empty or echoed verification command is not proof. Report uncertainty and retry with a more reliable check.',
      ],
    },
  },
  {
    id: 'ref-project-helper-scripts',
    label: 'Helper Script Memory',
    description: 'How reusable project helper scripts are saved and reused.',
    aspects: {
      scripts: [
        'The graph is the source of truth for helper scripts. Discover existing helpers with list_project_scripts before writing a new one.',
        'Fetch saved helpers with get_project_script; the CLI rehydrates them under .spore-code/scratch when needed.',
        'After running a helper, call record_script_outcome so reliable helpers rise and broken helpers can be pruned.',
      ],
      save: [
        'Save durable helpers with save_project_script, especially LAN IP detection, QR generation, log parsers, and build wrappers.',
        'Do not save secrets in helper script bodies. The script guard may reject secret-like bodies unless explicitly forced after verification.',
      ],
    },
  },
  {
    id: 'ref-project-listing-output',
    label: 'Project Listing And Output Filtering',
    description: 'How to inspect project structure without flooding the user.',
    aspects: {
      listing: [
        'Use the Project Tree, glob, grep, and targeted read_file for project inspection. Do not use recursive exec find, ls -laR, or tree on dependency-heavy repos.',
        'If a structural code index exists, prefer search_symbols, trace_calls, get_snippet, impact, and architecture over broad grep/read_file loops.',
      ],
      filtering: [
        'Filter dependency, build, cache, and editor directories from replies even if a tool returned them.',
        'Suppress .git, node_modules, .venv, venv, __pycache__, dist, build, target, .next, .cache, .spore-code, vendor, coverage, and editor cache directories unless the user specifically asks for them.',
      ],
    },
  },
  {
    id: 'ref-project-plan-execute',
    label: 'Plan And Execute Flow',
    description: 'How plan mode and execute mode should behave in project sessions.',
    aspects: {
      plan: [
        'Plan mode is for read-only research, codebase inspection, questions, and a concrete plan ending with PLAN_READY.',
        'Ask material tooling or scope questions when answers would change the implementation path. Do not ask trivia that the codebase already answers.',
      ],
      execute: [
        'Execute mode means the user approved the plan. Create task rows first, update progress before and after each step, and run verification tasks before declaring completion.',
        'Do not mutate files or start processes during plan mode. Do not skip task progress during execute mode.',
      ],
    },
  },
  {
    id: 'ref-project-verification',
    label: 'Verification Discipline',
    description: 'Rules for proving project work actually succeeded.',
    aspects: {
      proof: [
        'Claim success only after a tool result proves the expected state: command exit code, file content, process list, port check, test output, or explicit API response.',
        'If a verification command itself failed or returned suspect output, say verification failed or is inconclusive rather than claiming success.',
      ],
      implementation: [
        'For code changes, verify that the implementation is substantive, wired to callers/routes/exports, and covered by the planned checks.',
        'When a code index exists, use verify_implementation for created or modified symbols before declaring the implementation complete.',
      ],
    },
  },
];

const CHANNEL_REF_NODES = [
  {
    id: 'ref-channel-scope',
    label: 'Channel Scope',
    description: 'Rules for working inside this per-person channel graph.',
    aspects: {
      scope: [
        'This graph is scoped to one external channel identity, usually one person in one chat platform.',
        'Treat this graph as the primary memory for this channel relationship, not as global user or project memory.',
        'Do not leak one channel user\'s preferences, schedules, reports, or private facts into another channel user\'s graph.',
        'Only write to the main graph when the user explicitly says a fact or preference should apply globally.',
      ],
      privacy: [
        'Channel-specific tasks, report schedules, notification preferences, recurring workflows, and conversation history belong here.',
        'Facts about other people should be stored only when they are necessary context for this channel user.',
      ],
    },
  },
  {
    id: 'ref-channel-mode',
    label: 'Channel Operating Mode',
    description: 'What the agent can do when operating through this channel.',
    aspects: {
      capabilities: [
        'Use normal replies for clarification in non-modal chat channels; do not rely on web-only approval UI.',
        'Use message_send for proactive follow-ups, scheduled reports, reminders, and cross-channel messages when a target is known.',
        'Use schedule_wakeup or task tools for recurring work such as daily reports, check-ins, monitoring, and follow-up prompts.',
        'Keep channel replies concise unless the user asks for detailed output.',
      ],
      boundaries: [
        'Do not assume this channel user has access to web or CLI-only state.',
        'Do not expose private details from other channel graphs or project graphs unless the operator explicitly asks and policy allows it.',
      ],
    },
  },
  {
    id: 'ref-channel-memory',
    label: 'Channel Memory Workflow',
    description: 'How durable channel discoveries are recorded and promoted.',
    aspects: {
      memory: [
        'Store durable channel-specific facts here: report formats, cadence, timezone, allowed topics, notification style, and outstanding commitments.',
        'Store recurring jobs as channel-scoped commitments with enough detail to run without rereading unrelated history.',
        'General reusable lessons may be sanitized into the protected general knowledge base; person-specific details stay here.',
      ],
      cleanup: [
        'Keep short-lived chatter out of permanent memory unless it affects future behavior for this channel user.',
        'Prefer updating existing channel nodes over creating many near-duplicate reminders or preference nodes.',
      ],
    },
  },
  {
    id: 'ref-channel-recall',
    label: 'Scoped Channel Recall',
    description: 'How recall combines channel, reusable, and global memory.',
    aspects: {
      recall: [
        'Channel memory is the primary truth for this chat relationship.',
        'General knowledge base memory is reusable guidance and may apply by analogy.',
        'Main graph memory is for agent identity, global operator preferences, and system settings; avoid free-text recall over it for channel-person details.',
        'Project graphs are not active in channel mode unless a CLI/project context is explicitly supplied.',
      ],
    },
  },
];

function _hashKey(value) {
  return require('crypto').createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function _projectUserFromIdentityKey(identityKey) {
  const match = String(identityKey || '').match(/^cwd:([^:]+):/i);
  return match ? match[1] : null;
}

function _accessList(...values) {
  const out = [];
  const push = (value) => {
    if (value === undefined || value === null || value === false) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (value instanceof Set) {
      for (const item of value) push(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['username', 'user', 'userId', 'id', 'name']) push(value[key]);
      return;
    }
    const s = String(value).trim();
    if (s && !out.some(existing => existing.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const value of values) push(value);
  return out;
}

class GraphRegistry {
  constructor(dataDir, config, log) {
    this.dataDir = dataDir; // e.g. /data
    this.graphsDir = path.join(dataDir, GRAPHS_DIR_NAME);
    this.registryPath = path.join(this.graphsDir, REGISTRY_FILE);
    this.activePath = path.join(this.graphsDir, ACTIVE_FILE);
    this.config = config;
    this.log = log;
    this._registry = {};
  }

  /**
   * Initialize the registry, migrating legacy graph.db if needed.
   * Returns the active graph's DB path.
   */
  init() {
    fs.mkdirSync(this.graphsDir, { recursive: true });

    if (fs.existsSync(this.registryPath)) {
      try {
        this._registry = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      } catch {
        this._registry = {};
      }
    }

    // Migrate legacy graph.db on first run
    if (Object.keys(this._registry).length === 0) {
      this._migrateLegacy();
    }

    this._normalizeRegistry();

    const activeSlug = this.getActiveSlug();
    const activeEntry = activeSlug ? this._registry[activeSlug] : null;
    if (!activeSlug || !activeEntry || this.isActivationLocked(activeEntry)) {
      const mainSlug = Object.values(this._registry).find(g => g.role === 'main' && !this.isActivationLocked(g))?.slug;
      const first = mainSlug || Object.values(this._registry).find(g => !this.isActivationLocked(g))?.slug;
      if (first) {
        this.setActive(first);
      } else {
        // No graphs at all — create a default
        const slug = this.create('Default', 'Initial knowledge graph');
        this.setActive(slug);
      }
    }

    this.ensureSystemGraph({
      slug: GENERAL_KB_SLUG,
      name: 'General Knowledge Base',
      description: 'Protected reusable knowledge distilled from projects and sessions',
      role: 'general_kb',
    });

    return this.getActiveDbPath();
  }

  _normalizeRegistry() {
    let changed = false;
    for (const [slug, graph] of Object.entries(this._registry)) {
      if (!graph.slug) { graph.slug = slug; changed = true; }
      if (!graph.role) {
        graph.role = slug === 'default' ? 'main' : 'custom';
        changed = true;
      }
      if (graph.protected === undefined) {
        graph.protected = false;
        changed = true;
      }
      if (!graph.source) {
        graph.source = graph.role === 'main' ? 'system' : 'user';
        changed = true;
      }
      if (graph.role === 'project') {
        if (graph.managed !== true) { graph.managed = true; changed = true; }
        if (graph.activationLocked !== true) { graph.activationLocked = true; changed = true; }
        if (graph.seedProfile !== 'project') { graph.seedProfile = 'project'; changed = true; }
        if (this._applyProjectAccessMeta(graph, {})) changed = true;
        try {
          const dbPath = this.getDbPath(slug);
          if (dbPath && fs.existsSync(dbPath) && this._applyProjectSeedProfile(slug)) changed = true;
          this.refreshStats(slug);
        } catch (e) {
          this.log?.warn?.(`[multi-graph] project seed normalize failed for ${slug}: ${e.message}`);
        }
      }
      if (graph.role === 'channel') {
        if (graph.managed !== true) { graph.managed = true; changed = true; }
        if (graph.activationLocked !== true) { graph.activationLocked = true; changed = true; }
        if (graph.seedProfile !== 'channel') { graph.seedProfile = 'channel'; changed = true; }
        try {
          const dbPath = this.getDbPath(slug);
          if (dbPath && fs.existsSync(dbPath) && this._applyChannelSeedProfile(slug)) changed = true;
          this.refreshStats(slug);
        } catch (e) {
          this.log?.warn?.(`[multi-graph] channel seed normalize failed for ${slug}: ${e.message}`);
        }
      }
      if (graph.role === 'general_kb') {
        if (graph.managed !== true) { graph.managed = true; changed = true; }
        if (graph.activationLocked !== true) { graph.activationLocked = true; changed = true; }
        try { this.refreshStats(slug); } catch {}
      }
    }
    if (changed) this._save();
  }

  _migrateLegacy() {
    const legacyPath = path.join(this.dataDir, 'graph.db');
    const legacyWal = legacyPath + '-wal';
    const legacyShm = legacyPath + '-shm';

    if (fs.existsSync(legacyPath)) {
      const slug = 'default';
      const destPath = path.join(this.graphsDir, `${slug}.db`);

      // Copy (not move) so the legacy path still works until config is updated
      fs.copyFileSync(legacyPath, destPath);
      if (fs.existsSync(legacyWal)) fs.copyFileSync(legacyWal, destPath + '-wal');
      if (fs.existsSync(legacyShm)) fs.copyFileSync(legacyShm, destPath + '-shm');

      let nodeCount = 0;
      try {
        const db = new DatabaseSync(destPath);
        nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
        db.close();
      } catch { /* silent: best-effort close */ }

      this._registry[slug] = {
        slug,
        name: 'Default',
        description: 'Migrated from original graph.db',
        role: 'main',
        protected: false,
        source: 'system',
        created: new Date().toISOString(),
        nodeCount,
      };
      this._save();
      this.setActive(slug);
      this.log.info(`[multi-graph] Migrated legacy graph.db → graphs/default.db (${nodeCount} nodes)`);
    }
  }

  _save() {
    fs.writeFileSync(this.registryPath, JSON.stringify(this._registry, null, 2));
  }

  /** List all graphs with metadata. */
  list() {
    for (const slug of Object.keys(this._registry)) this.refreshStats(slug);
    const activeSlug = this.getActiveSlug();
    return Object.values(this._registry).map(g => ({
      ...g,
      active: g.slug === activeSlug,
      inspectOnly: this.isActivationLocked(g),
      dbPath: path.join(this.graphsDir, `${g.slug}.db`),
    }));
  }

  /** Get a single graph entry. */
  get(slug) {
    return this._registry[slug] || null;
  }

  /** Get the absolute DB path for a graph slug. */
  getDbPath(slug) {
    if (!this._registry[slug]) return null;
    return path.join(this.graphsDir, `${slug}.db`);
  }

  getMainSlug() {
    const activeSlug = this.getActiveSlug();
    const main = Object.values(this._registry).find(g => g.role === 'main');
    return main?.slug || activeSlug || 'default';
  }

  getGeneralKnowledgeSlug() {
    return GENERAL_KB_SLUG;
  }

  /** Get the active graph slug. */
  getActiveSlug() {
    try {
      return fs.readFileSync(this.activePath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /** Get the active graph's DB file path. */
  getActiveDbPath() {
    const slug = this.getActiveSlug();
    if (!slug) return null;
    return path.join(this.graphsDir, `${slug}.db`);
  }

  /** Set the active graph. */
  setActive(slug, opts = {}) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    if (this._registry[slug].protected && opts.allowProtected !== true) {
      throw new Error(`Graph "${slug}" is protected and cannot be activated as the normal chat graph`);
    }
    if (this.isActivationLocked(this._registry[slug]) && opts.allowLocked !== true) {
      throw new Error(`Graph "${slug}" is a managed memory scope and is inspect-only`);
    }
    fs.writeFileSync(this.activePath, slug);
  }

  isActivationLocked(graphOrSlug) {
    const graph = typeof graphOrSlug === 'string' ? this._registry[graphOrSlug] : graphOrSlug;
    if (!graph) return false;
    return graph.activationLocked === true || graph.role === 'project' || graph.role === 'channel' || (graph.protected === true && graph.role !== 'main');
  }

  /**
   * Create a new graph, seeded with the standard seed-graph.sql.
   * Returns the slug.
   */
  create(name, description, opts = {}) {
    const slug = opts.slug ? this._slugify(opts.slug) : this._slugify(name);
    if (this._registry[slug]) throw new Error(`Graph "${slug}" already exists`);

    const dbPath = path.join(this.graphsDir, `${slug}.db`);

    // Seed with standard schema + agent identity
    const seedPath = path.join(__dirname, '..', 'seed-graph.sql');
    if (fs.existsSync(seedPath)) {
      let sql = fs.readFileSync(seedPath, 'utf8');
      const agentId = this.config.agentId || 'spore';
      const agentName = this.config.displayName || agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      sql = sql.replace(/AGENT_ID/g, agentId).replace(/AGENT_NAME/g, agentName);
      const db = new DatabaseSync(dbPath);
      db.exec(sql);
      if (opts.seedProfile === 'project' || opts.role === 'project') {
        this._applyProjectSeedProfile(slug, db);
      } else if (opts.seedProfile === 'channel' || opts.role === 'channel') {
        this._applyChannelSeedProfile(slug, db);
      }
      db.close();
    } else {
      new DatabaseSync(dbPath).close();
    }

    let nodeCount = 0;
    try {
      const db = new DatabaseSync(dbPath);
      nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      db.close();
    } catch { /* silent: best-effort close */ }

    this._registry[slug] = {
      slug,
      name,
      description: description || '',
      role: opts.role || 'custom',
      protected: opts.protected === true,
      managed: opts.managed === true || opts.role === 'project' || opts.role === 'channel',
      activationLocked: opts.activationLocked === true || opts.role === 'project' || opts.role === 'channel',
      seedProfile: opts.seedProfile || (opts.role === 'project' ? 'project' : (opts.role === 'channel' ? 'channel' : 'standard')),
      identityKey: opts.identityKey || null,
      platform: opts.platform || null,
      externalUserId: opts.externalUserId || null,
      externalChannelId: opts.externalChannelId || null,
      source: opts.source || 'user',
      createdBy: opts.createdBy || null,
      created: new Date().toISOString(),
      nodeCount,
    };
    this._save();
    this.log.info(`[multi-graph] Created graph "${name}" (${slug}) with ${nodeCount} seed nodes`);
    return slug;
  }

  ensureSystemGraph(opts = {}) {
    const slug = this._slugify(opts.slug || opts.name || GENERAL_KB_SLUG);
    if (this._registry[slug]) {
      const g = this._registry[slug];
      let changed = false;
      for (const [k, v] of Object.entries({
        name: opts.name || g.name,
        description: opts.description ?? g.description,
        role: opts.role || g.role || 'system',
        protected: true,
        managed: true,
        activationLocked: true,
        source: 'system',
      })) {
        if (g[k] !== v) { g[k] = v; changed = true; }
      }
      if (changed) this._save();
      return slug;
    }
    return this.create(opts.name || slug, opts.description || '', {
      slug,
      role: opts.role || 'system',
      protected: true,
      managed: true,
      activationLocked: true,
      source: 'system',
      createdBy: 'system',
      identityKey: opts.identityKey || slug,
    });
  }

  findByIdentityKey(identityKey, role = null) {
    if (!identityKey) return null;
    return Object.values(this._registry).find(g =>
      g.identityKey === identityKey && (!role || g.role === role)
    ) || null;
  }

  _applyProjectAccessMeta(graph, meta = {}) {
    if (!graph || graph.role !== 'project') return false;
    let changed = false;
    const identityUser = _projectUserFromIdentityKey(graph.identityKey);
    const owner = meta.owner || meta.userId || identityUser || null;
    if (owner && !graph.owner) {
      graph.owner = owner;
      changed = true;
    }
    const collaborators = _accessList(
      graph.collaborators,
      graph.members,
      graph.allowedUsers,
      graph.allowedWebUsers,
      owner,
      identityUser,
      meta.userId,
      meta.username,
      meta.collaborators,
      meta.members,
      meta.allowedUsers,
      meta.allowedWebUsers,
    );
    if (collaborators.length) {
      const current = JSON.stringify(graph.collaborators || []);
      const next = JSON.stringify(collaborators);
      if (current !== next) {
        graph.collaborators = collaborators;
        changed = true;
      }
    }
    for (const [key, value] of Object.entries({
      projectKey: meta.projectKey,
      projectRoot: meta.projectRoot || meta.root,
      projectRemote: meta.projectRemote || meta.remote,
    })) {
      if (value && graph[key] !== value) {
        graph[key] = value;
        changed = true;
      }
    }
    return changed;
  }

  ensureProjectGraph(identityKey, meta = {}) {
    if (!identityKey) throw new Error('identityKey is required');
    const existing = this.findByIdentityKey(identityKey, 'project');
    if (existing) {
      existing.managed = true;
      existing.activationLocked = true;
      existing.seedProfile = 'project';
      if (meta.name && existing.name !== meta.name) existing.name = meta.name;
      if (meta.description && existing.description !== meta.description) existing.description = meta.description;
      this._applyProjectAccessMeta(existing, meta);
      this._applyProjectSeedProfile(existing.slug);
      this.refreshStats(existing.slug);
      this._save();
      return existing.slug;
    }
    const slug = `project-${_hashKey(identityKey)}`;
    if (this._registry[slug]) {
      if (this._applyProjectAccessMeta(this._registry[slug], meta)) this._save();
      return slug;
    }
    const createdSlug = this.create(meta.name || 'Project Memory', meta.description || identityKey, {
      slug,
      role: 'project',
      protected: false,
      managed: true,
      activationLocked: true,
      seedProfile: 'project',
      source: meta.source || 'spore-code',
      createdBy: meta.createdBy || 'spore-code',
      identityKey,
    });
    if (this._applyProjectAccessMeta(this._registry[createdSlug], meta)) this._save();
    return createdSlug;
  }

  ensureChannelGraph(identityKey, meta = {}) {
    if (!identityKey) throw new Error('identityKey is required');
    const existing = this.findByIdentityKey(identityKey, 'channel');
    if (existing) {
      existing.managed = true;
      existing.activationLocked = true;
      existing.seedProfile = 'channel';
      if (meta.name && existing.name !== meta.name) existing.name = meta.name;
      if (meta.description && existing.description !== meta.description) existing.description = meta.description;
      if (meta.platform && existing.platform !== meta.platform) existing.platform = meta.platform;
      if (meta.externalUserId && existing.externalUserId !== meta.externalUserId) existing.externalUserId = meta.externalUserId;
      if (meta.externalChannelId && existing.externalChannelId !== meta.externalChannelId) existing.externalChannelId = meta.externalChannelId;
      this._applyChannelSeedProfile(existing.slug);
      this.refreshStats(existing.slug);
      this._save();
      return existing.slug;
    }
    const slug = `channel-${_hashKey(identityKey)}`;
    if (this._registry[slug]) return slug;
    return this.create(meta.name || 'Channel Memory', meta.description || identityKey, {
      slug,
      role: 'channel',
      protected: false,
      managed: true,
      activationLocked: true,
      seedProfile: 'channel',
      source: meta.source || 'channel',
      createdBy: meta.createdBy || meta.platform || 'channel',
      identityKey,
      platform: meta.platform || null,
      externalUserId: meta.externalUserId || null,
      externalChannelId: meta.externalChannelId || null,
    });
  }

  markChannelGraphActivity(slug, meta = {}) {
    const graph = this._registry[slug];
    if (!graph || graph.role !== 'channel') return false;
    const now = meta.at || new Date().toISOString();
    graph.lastActivityAt = now;
    if (!graph.distillDirty) graph.distillDirtySince = now;
    graph.distillDirty = true;
    if (meta.reason) graph.distillReason = meta.reason;
    if (meta.platform) graph.platform = meta.platform;
    if (meta.externalUserId) graph.externalUserId = meta.externalUserId;
    if (meta.externalChannelId) graph.externalChannelId = meta.externalChannelId;
    this._save();
    return true;
  }

  recordChannelGraphDistill(slug, meta = {}) {
    const graph = this._registry[slug];
    if (!graph || graph.role !== 'channel') return false;
    const now = meta.at || new Date().toISOString();
    graph.lastDistillAttemptAt = now;
    graph.lastDistillStatus = meta.success === false ? 'error' : 'ok';
    graph.lastDistillPromoted = Number.isFinite(meta.promoted) ? meta.promoted : 0;
    graph.lastDistillCandidates = Number.isFinite(meta.candidates) ? meta.candidates : 0;
    if (meta.error) {
      graph.lastDistillError = String(meta.error).slice(0, 500);
      graph.lastDistillErrorAt = now;
    } else {
      delete graph.lastDistillError;
      delete graph.lastDistillErrorAt;
    }
    if (meta.success !== false) {
      graph.distillDirty = false;
      delete graph.distillDirtySince;
      delete graph.distillReason;
      graph.lastDistilledAt = now;
    }
    this.refreshStats(slug);
    this._save();
    return true;
  }

  /**
   * Duplicate an existing graph under a new name.
   * Returns the new slug.
   */
  duplicate(sourceSlug, newName) {
    if (!this._registry[sourceSlug]) throw new Error(`Source graph "${sourceSlug}" not found`);
    const newSlug = this._slugify(newName);
    if (this._registry[newSlug]) throw new Error(`Graph "${newSlug}" already exists`);

    const srcPath = path.join(this.graphsDir, `${sourceSlug}.db`);
    const destPath = path.join(this.graphsDir, `${newSlug}.db`);
    fs.copyFileSync(srcPath, destPath);

    let nodeCount = 0;
    try {
      const db = new DatabaseSync(destPath);
      nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      db.close();
    } catch { /* silent: best-effort close */ }

    this._registry[newSlug] = {
      slug: newSlug,
      name: newName,
      description: `Duplicated from "${this._registry[sourceSlug].name}"`,
      created: new Date().toISOString(),
      nodeCount,
    };
    this._save();
    this.log.info(`[multi-graph] Duplicated ${sourceSlug} → ${newSlug} (${nodeCount} nodes)`);
    return newSlug;
  }

  /** Delete a graph. Cannot delete the active graph. */
  delete(slug) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    if (slug === this.getActiveSlug()) throw new Error('Cannot delete the active graph. Switch to another graph first.');
    if (this._registry[slug].protected) throw new Error(`Cannot delete protected graph "${slug}"`);

    const dbPath = path.join(this.graphsDir, `${slug}.db`);
    try { fs.unlinkSync(dbPath); } catch { /* silent: best-effort cleanup */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* silent: best-effort cleanup */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* silent: best-effort cleanup */ }

    delete this._registry[slug];
    this._save();
    this.log.info(`[multi-graph] Deleted graph "${slug}"`);
  }

  /** Rename a graph. */
  rename(slug, newName) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    if (this._registry[slug].protected) throw new Error(`Cannot rename protected graph "${slug}"`);
    this._registry[slug].name = newName;
    this._save();
  }

  /** Update description. */
  describe(slug, description) {
    if (!this._registry[slug]) throw new Error(`Graph "${slug}" not found`);
    if (this._registry[slug].protected) throw new Error(`Cannot edit protected graph "${slug}"`);
    this._registry[slug].description = description;
    this._save();
  }

  applyImportedMetadata(slug, meta = {}) {
    const graph = this._registry[slug];
    if (!graph || !meta || typeof meta !== 'object') return false;
    const allowed = [
      'name', 'description', 'role', 'protected', 'managed', 'activationLocked',
      'seedProfile', 'identityKey', 'platform', 'externalUserId', 'externalChannelId',
      'source', 'createdBy', 'owner', 'collaborators', 'allowedUsers', 'allowedWebUsers',
      'projectKey', 'projectRoot', 'projectRemote',
    ];
    let changed = false;
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
      const value = meta[key];
      if (value === undefined) continue;
      const next = Array.isArray(value) ? [...value] : value;
      if (JSON.stringify(graph[key]) !== JSON.stringify(next)) {
        graph[key] = next;
        changed = true;
      }
    }
    if (graph.role === 'project') {
      if (this._applyProjectAccessMeta(graph, meta)) changed = true;
    }
    if (changed) {
      this.refreshStats(slug);
      this._save();
    }
    return changed;
  }

  recordMaintenanceStart(slug, meta = {}) {
    const graph = this._registry[slug];
    if (!graph) return false;
    const now = meta.at || new Date().toISOString();
    graph.maintenanceStatus = 'running';
    graph.maintenanceStartedAt = now;
    graph.maintenanceReason = meta.reason || 'scheduled';
    delete graph.maintenanceError;
    this._save();
    return true;
  }

  recordMaintenanceResult(slug, meta = {}) {
    const graph = this._registry[slug];
    if (!graph) return false;
    const now = meta.at || new Date().toISOString();
    graph.lastMaintainedAt = now;
    graph.maintenanceStatus = meta.success === false ? 'error' : 'ok';
    graph.maintenanceDurationMs = Number.isFinite(meta.durationMs) ? meta.durationMs : null;
    graph.maintenanceSummary = meta.summary || null;
    if (meta.error) graph.maintenanceError = String(meta.error).slice(0, 500);
    else delete graph.maintenanceError;
    if (meta.embedded) graph.lastEmbeddedAt = now;
    if (meta.clustered) graph.lastClusteredAt = now;
    if (meta.overviewed) graph.lastOverviewAt = now;
    if (meta.backedUp) graph.lastBackedUpAt = now;
    if (meta.communityState) graph.communityState = meta.communityState;
    if (meta.embeddingBacklog !== undefined) graph.embeddingBacklog = meta.embeddingBacklog;
    this.refreshStats(slug);
    this._save();
    return true;
  }

  /** Refresh node count for a graph from its DB. */
  refreshStats(slug) {
    if (!this._registry[slug]) return;
    const dbPath = path.join(this.graphsDir, `${slug}.db`);
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      const graph = this._registry[slug];
      graph.nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
      graph.edgeCount = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
      try {
        graph.embeddingBacklog = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE embedding IS NULL OR embedding = ''").get()?.c || 0;
      } catch {}
      try {
        graph.communityCount = db.prepare("SELECT COUNT(*) AS c FROM node_groups WHERE superseded_at IS NULL").get()?.c || 0;
        const last = db.prepare("SELECT MAX(created) AS t FROM node_groups WHERE superseded_at IS NULL").get()?.t || null;
        if (last) graph.lastClusteredAt = last;
        graph.communityState = graph.communityCount > 0
          ? 'ready'
          : ((graph.nodeCount >= 20 && graph.edgeCount >= 10) ? 'unclustered' : 'too_small');
      } catch {
        graph.communityCount = 0;
        graph.communityState = graph.nodeCount >= 20 && graph.edgeCount >= 10 ? 'unclustered' : 'too_small';
      }
      try {
        const overview = db.prepare("SELECT MAX(computed_at) AS t FROM graph_overviews WHERE superseded_at IS NULL").get()?.t || null;
        if (overview) graph.lastOverviewAt = overview;
      } catch {}
      this._save();
    } catch { /* silent: best-effort close */ }
    finally {
      try { db?.close(); } catch {}
    }
  }

  _applyProjectSeedProfile(slug, existingDb = null) {
    const dbPath = this.getDbPath(slug) || path.join(this.graphsDir, `${slug}.db`);
    const db = existingDb || new DatabaseSync(dbPath);
    let changed = false;
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const genericRefs = db.prepare("SELECT id FROM nodes WHERE type = 'reference' AND id LIKE 'ref-%' AND extracted_with != ?").all(PROJECT_REF_SOURCE);
      if (genericRefs.length) {
        const ids = genericRefs.map(r => r.id);
        const q = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM edges WHERE source IN (${q}) OR target IN (${q})`).run(...ids, ...ids);
        try { db.prepare(`DELETE FROM aliases WHERE node_id IN (${q})`).run(...ids); } catch {}
        db.prepare(`DELETE FROM nodes WHERE id IN (${q})`).run(...ids);
        changed = true;
      }

      for (const ref of PROJECT_REF_NODES) {
        const existed = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(ref.id);
        db.prepare(
          'INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with) VALUES (?, ?, ?, ?, 8, ?)'
        ).run(ref.id, ref.label, 'reference', ref.description, PROJECT_REF_SOURCE);
        if (!existed) changed = true;
        for (const [aspectName, attrs] of Object.entries(ref.aspects || {})) {
          let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(ref.id, aspectName);
          if (!asp) {
            db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 8, ?)').run(ref.id, aspectName, PROJECT_REF_SOURCE);
            asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
            changed = true;
          }
          for (const content of attrs || []) {
            const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
            if (!dup) {
              db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, ?, ?)')
                .run(asp.id, content, PROJECT_REF_SOURCE, PROJECT_REF_SOURCE);
              changed = true;
            }
          }
        }
        const edge = db.prepare("SELECT 1 FROM edges WHERE source = 'spore' AND target = ? AND type = 'documents'").get(ref.id);
        if (!edge) {
          try {
            db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with) VALUES ('spore', ?, 'documents', 0.8, ?)").run(ref.id, PROJECT_REF_SOURCE);
            changed = true;
          } catch {}
        }
      }
    } finally {
      if (!existingDb) {
        try { db.close(); } catch {}
      }
    }
    return changed;
  }

  _applyChannelSeedProfile(slug, existingDb = null) {
    const dbPath = this.getDbPath(slug) || path.join(this.graphsDir, `${slug}.db`);
    const db = existingDb || new DatabaseSync(dbPath);
    let changed = false;
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const genericRefs = db.prepare("SELECT id FROM nodes WHERE type = 'reference' AND id LIKE 'ref-%' AND extracted_with != ?").all(CHANNEL_REF_SOURCE);
      if (genericRefs.length) {
        const ids = genericRefs.map(r => r.id);
        const q = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM edges WHERE source IN (${q}) OR target IN (${q})`).run(...ids, ...ids);
        try { db.prepare(`DELETE FROM aliases WHERE node_id IN (${q})`).run(...ids); } catch {}
        db.prepare(`DELETE FROM nodes WHERE id IN (${q})`).run(...ids);
        changed = true;
      }

      for (const ref of CHANNEL_REF_NODES) {
        const existed = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(ref.id);
        db.prepare(
          'INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with) VALUES (?, ?, ?, ?, 8, ?)'
        ).run(ref.id, ref.label, 'reference', ref.description, CHANNEL_REF_SOURCE);
        if (!existed) changed = true;
        for (const [aspectName, attrs] of Object.entries(ref.aspects || {})) {
          let asp = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(ref.id, aspectName);
          if (!asp) {
            db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 8, ?)').run(ref.id, aspectName, CHANNEL_REF_SOURCE);
            asp = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
            changed = true;
          }
          for (const content of attrs || []) {
            const dup = db.prepare('SELECT 1 FROM attributes WHERE aspect_id = ? AND content = ?').get(asp.id, content);
            if (!dup) {
              db.prepare('INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES (?, ?, 8, ?, ?)')
                .run(asp.id, content, CHANNEL_REF_SOURCE, CHANNEL_REF_SOURCE);
              changed = true;
            }
          }
        }
        const edge = db.prepare("SELECT 1 FROM edges WHERE source = 'spore' AND target = ? AND type = 'documents'").get(ref.id);
        if (!edge) {
          try {
            db.prepare("INSERT INTO edges (source, target, type, weight, extracted_with) VALUES ('spore', ?, 'documents', 0.8, ?)").run(ref.id, CHANNEL_REF_SOURCE);
            changed = true;
          } catch {}
        }
      }
    } finally {
      if (!existingDb) {
        try { db.close(); } catch {}
      }
    }
    return changed;
  }

  _slugify(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 48) || 'graph';
  }
}

module.exports = { GraphRegistry, GENERAL_KB_SLUG };
