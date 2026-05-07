/**
 * context.js — Graph Context Engine (Facade)
 * 
 * Builds the system prompt from the SQLite knowledge graph.
 * 
 * Architecture:
 *   Agent node → identity, voice, rules
 *   Channel nodes → channel-specific rules
 *   Person nodes → who's talking, relationship context
 *   Rule nodes → hard rules, anti-patterns
 *   Edge traversal → related context
 * 
 * Retrieval (search, ranking, graph walk) → ./retrieval.js
 * Prompt section builders (_build*Section)  → ./prompt-sections.js
 */

const { DatabaseSync } = require('node:sqlite');
const graphEvents = require('./events');
const { classifyQueryType, QUERY_TYPE_PARAMS } = require('./retrieval');

// `_looksLikeCodingTurn` + the recall-skip heuristic moved to
// plugins/spore-code/. The plugin registers a `shouldSkipRecall`
// lifecycle hook that buildSystemPromptAsync calls before kicking off
// the (expensive) Enhanced Recall pipeline. Core is acorn-blind here.

class GraphContext {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.db = null;
    this._stmts = {};
    this._cache = {};
    this._cacheTimestamp = 0;
    this._graphMtime = 0;
    this._staticPromptCache = null;
    this._sharedGraphs = [];
    this._sharedGraphsLastCheck = 0;

    // Per-instance budgets — start from the static class defaults and
    // overlay any operator overrides from config (spore.json:
    // sectionBudgets / totalPromptBudget, or env vars
    // SPORE_SECTION_BUDGETS / SPORE_TOTAL_BUDGET). Lets each instance
    // tune section caps without editing source. Unknown keys in
    // config.sectionBudgets are ignored to avoid silently growing the
    // budget map with typos.
    this._sectionBudgets = { ...GraphContext.SECTION_BUDGETS };
    const overrides = (config && config.sectionBudgets) || {};
    const adjusted = [];
    for (const [k, v] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(GraphContext.SECTION_BUDGETS, k)) {
        if (this.log) this.log.warn(`[context] sectionBudgets: ignoring unknown key "${k}" — known: ${Object.keys(GraphContext.SECTION_BUDGETS).join(', ')}`);
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        if (this.log) this.log.warn(`[context] sectionBudgets["${k}"]: ignoring non-positive value ${v}`);
        continue;
      }
      this._sectionBudgets[k] = Math.floor(n);
      adjusted.push(`${k}=${this._sectionBudgets[k]}`);
    }
    this._totalBudget = (config && Number.isFinite(Number(config.totalPromptBudget)) && Number(config.totalPromptBudget) > 0)
      ? Math.floor(Number(config.totalPromptBudget))
      : GraphContext.TOTAL_BUDGET;
    if (adjusted.length || this._totalBudget !== GraphContext.TOTAL_BUDGET) {
      const totalNote = this._totalBudget !== GraphContext.TOTAL_BUDGET ? ` total=${this._totalBudget}` : '';
      if (this.log) this.log.info(`[context] budget overrides: ${adjusted.join(', ') || '(none per-section)'}${totalNote}`);
    }
  }

  static SECTION_BUDGETS = {
    persona: 400,
    identity: 1000,
    voice: 400,
    rules: 800,
    selfknowledge: 600,
    channel: 400,
    person: 600,
    relevant: 4000,
    anti: 200,
    feed: 600,
    tooling: 800,
    behavior: 400,
    // runtime carries _buildRuntimeSection — project context, sandbox
    // rules, plan-mode block (with PHASE 1-5 + QUESTIONS protocol +
    // tooling-question list + RULES), and assorted server hints. The
    // plan-mode block alone is ~1400 tokens; the old 500-token cap
    // silently truncated the END of the section, dropping RULES and
    // any newly-added guidance (researcher delegation, tooling
    // questions). 3000 fits the full block with headroom for future
    // additions. Non-plan-mode turns use a much shorter runtime so
    // the bigger budget only takes effect when the section needs it.
    runtime: 3000,
    reflections: 500,
    derived: 800,
    gaps: 300,
    // plugin section carries both Project Context and Plan Mode for the
    // spore-code plugin. Plan Mode alone is ~2500 tokens (PHASES 1-6 +
    // QUESTIONS protocol + tooling-question list + RULES + execution
    // checklist), Project Context can be 2000-3000 tokens (cwd, tree,
    // tools list, ACORN.md, project_memory_summary). Combined ~5000.
    // The old 2000 cap silently truncated the END of the combined text,
    // dropping Plan Mode's `## Plan Mode` header and `RULES` block —
    // confirmed via `[plan-mode] system prompt MISSING markers:
    // planHeader, rulesHeader` warnings on every plan-mode turn. Same
    // failure mode (and same fix) as the runtime budget bump from 500
    // to 3000 above.
    plugin: 6000,
    episodes: 8000,
    // overview: Graph Overview section (god nodes / surprising bridges /
    // suggested questions, computed by maintainer.runGraphOverview). Sits
    // between selfknowledge and reflections. Drop early under context
    // pressure — it's a navigation aid, not load-bearing context.
    overview: 400,
    // hyperedges: top recent / highest-weight n-ary relationships. Drops
    // very early — group facts are nice-to-have, not load-bearing.
    hyperedges: 250,
  };
  static TOTAL_BUDGET = 40000;
  static DROP_ORDER = ['gaps', 'anti', 'overview', 'hyperedges', 'selfknowledge', 'plugin', 'feed', 'tooling', 'runtime', 'reflections', 'derived', 'episodes'];

  static PROMPT_MODES = {
    full: ['persona', 'identity', 'voice', 'rules', 'selfknowledge', 'overview', 'plugin', 'channel', 'person', 'relevant', 'episodes', 'hyperedges', 'anti', 'feed', 'tooling', 'behavior', 'reflections', 'gaps', 'runtime', 'cluster'],
    chat: ['persona', 'identity', 'voice', 'rules', 'selfknowledge', 'overview', 'plugin', 'channel', 'person', 'episodes', 'tooling', 'behavior', 'cluster'],
    recall: ['persona', 'identity', 'overview', 'relevant', 'episodes', 'derived', 'hyperedges', 'reflections', 'person'],
    minimal: ['identity', 'rules', 'tooling', 'runtime', 'cluster'],
    none: ['identity'],
  };

  /**
   * Initialize the graph database connection (read-only)
   */
  init() {
    try {
      this.db = new DatabaseSync(this.config.graphDbPath);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('PRAGMA foreign_keys=ON');
      this.log.info(`Graph context engine connected to ${this.config.graphDbPath}`);

      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS hints (
          id INTEGER PRIMARY KEY,
          attribute_id INTEGER,
          node_id TEXT,
          hint TEXT
        )`);
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS hints_fts USING fts5(hint, content=hints, content_rowid=id)`);
      } catch (e) {
        this.log.warn?.('Hints table init:', e.message);
      }

      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS attr_fts USING fts5(content, tokenize='porter unicode61')`);
        const attrFtsCount = this.db.prepare('SELECT count(*) as c FROM attr_fts').get().c;
        if (attrFtsCount === 0) {
          const attrs = this.db.prepare('SELECT a.rowid, a.content FROM attributes a WHERE a.content IS NOT NULL AND typeof(a.content) = \'text\'').all();
          if (attrs.length > 0) {
            const insert = this.db.prepare('INSERT INTO attr_fts(rowid, content) VALUES (?, ?)');
            let indexed = 0;
            for (const a of attrs) {
              try { insert.run(Number(a.rowid), String(a.content)); indexed++; } catch (_) {
                this.log.warn('[context] insert.run failed: ' + _.message);
              }
            }
            this.log.info?.(`[graph] attr_fts indexed ${indexed}/${attrs.length} attributes`);
          }
        }
      } catch (e) {
        this.log.warn?.('attr_fts init:', e.message);
      }

      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY,
          session_id TEXT,
          turn_idx INTEGER,
          content TEXT NOT NULL,
          observed_at TEXT,
          embedding TEXT,
          user_id TEXT,
          user_name TEXT,
          created TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_observed ON episodes(observed_at)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id)');
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(content, tokenize='porter unicode61')`);
      } catch (e) {
        this.log.warn?.('Episodes table init:', e.message);
      }

      // Provenance: link attributes back to their source episode + track update history
      try {
        const cols = this.db.prepare("PRAGMA table_info(attributes)").all().map(c => c.name);
        if (!cols.includes('source_episode_id')) {
          this.db.exec('ALTER TABLE attributes ADD COLUMN source_episode_id INTEGER');
        }
        if (!cols.includes('updated_at')) {
          this.db.exec('ALTER TABLE attributes ADD COLUMN updated_at DATETIME');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS attribute_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          attribute_id INTEGER REFERENCES attributes(id) ON DELETE CASCADE,
          old_content TEXT NOT NULL,
          new_content TEXT NOT NULL,
          changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          source_episode_id INTEGER REFERENCES episodes(id)
        )`);
      } catch (e) {
        this.log.warn?.('Provenance migration:', e.message);
      }

      // Per-turn learner dedup. SHA256 over (userMessage \0 assistantResponse).
      // Skips redundant LLM extraction calls when the same exchange replays.
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS learner_processed (
          content_hash TEXT PRIMARY KEY,
          episode_id INTEGER,
          processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_learner_processed_at ON learner_processed(processed_at)');
      } catch (e) {
        this.log.warn?.('learner_processed init:', e.message);
      }

      // Maintainer-computed graph overview (god nodes, bridges, suggested
      // questions). One current row at a time; payload is JSON.
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS graph_overviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          payload TEXT NOT NULL,
          superseded_at DATETIME
        )`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_graph_overviews_active ON graph_overviews(superseded_at, computed_at)');
      } catch (e) {
        this.log.warn?.('graph_overviews init:', e.message);
      }

      // Hyperedges: n-ary relationships across 3+ nodes that don't
      // decompose naturally into binary edges (group meetings, shared
      // concepts, multi-party agreements). Members carry optional roles.
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS hyperedges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT,
          type TEXT NOT NULL,
          confidence TEXT,
          weight REAL DEFAULT 1.0,
          extracted_with TEXT,
          extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS hyperedge_members (
          hyperedge_id INTEGER REFERENCES hyperedges(id) ON DELETE CASCADE,
          node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          role TEXT,
          PRIMARY KEY (hyperedge_id, node_id)
        )`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_hyp_members_node ON hyperedge_members(node_id)');
      } catch (e) {
        this.log.warn?.('hyperedges init:', e.message);
      }

      // Themes / semantic groupings produced by the maintainer's categorization step
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS node_groups (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id       TEXT NOT NULL,
          name         TEXT NOT NULL,
          description  TEXT,
          member_count INTEGER DEFAULT 0,
          created      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          model        TEXT,
          superseded_at TIMESTAMP
        )`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_node_groups_active ON node_groups(superseded_at, run_id)`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS node_group_members (
          group_id   INTEGER NOT NULL,
          node_id    TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          PRIMARY KEY (group_id, node_id),
          FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE,
          FOREIGN KEY (node_id)  REFERENCES nodes(id)        ON DELETE CASCADE
        )`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ngm_node ON node_group_members(node_id)`);
      } catch (e) {
        this.log.warn?.('node_groups init:', e.message);
      }

      const count = this.db.prepare('SELECT count(*) as c FROM nodes').get().c;
      this.log.info(`Graph has ${count} nodes`);

      this._refreshSharedGraphs();

      return true;
    } catch (e) {
      this.log.error('Failed to connect to graph database:', e.message);
      return false;
    }
  }

  /**
   * Refresh shared project graph attachments. Re-reads the registry file
   * and ATTACHes/DETACHes databases as memberships change.
   * Also detects file replacements (different inode) and re-attaches.
   * Called on init and periodically (every 30s) during prompt builds.
   */
  _refreshSharedGraphs() {
    const now = Date.now();
    if (now - this._sharedGraphsLastCheck < 30_000) return;
    this._sharedGraphsLastCheck = now;

    const fs = require('fs');
    const path = require('path');
    const sharedDir = this.config.sharedGraphsDir;
    const registryPath = path.join(sharedDir, '_projects.json');

    let projects = {};
    if (fs.existsSync(registryPath)) {
      try { projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
      catch { return; }
    }

    const animaId = this.config.agentId;
    const currentBySlug = new Map(this._sharedGraphs.map(s => [s.slug, s]));
    const wantedSlugs = new Set();

    for (const [slug, proj] of Object.entries(projects)) {
      if (proj.members && proj.members.includes(animaId)) wantedSlugs.add(slug);
    }

    // Detach removed projects
    for (const sg of [...this._sharedGraphs]) {
      if (!wantedSlugs.has(sg.slug)) {
        try { this.db.exec(`DETACH DATABASE ${sg.alias}`); } catch (e) { this.log.warn('[context] db.exec failed: ' + e.message); }
        this._sharedGraphs = this._sharedGraphs.filter(s => s.slug !== sg.slug);
        this.log.info(`[shared-graph] Detached project "${sg.slug}"`);
      }
    }

    // Attach new projects + re-attach if the DB file was replaced on disk
    for (const slug of wantedSlugs) {
      const proj = projects[slug];
      const dbFile = path.join(sharedDir, proj.dbFile || `${slug}.db`);
      if (!fs.existsSync(dbFile)) {
        this.log.warn?.(`[shared-graph] DB missing for project "${slug}": ${dbFile}`);
        continue;
      }

      const stat = fs.statSync(dbFile);
      const diskIno = stat.ino;
      const existing = currentBySlug.get(slug);

      if (existing) {
        if (existing._ino === diskIno) continue;
        // File was replaced — detach stale handle and re-attach below
        try { this.db.exec(`DETACH DATABASE ${existing.alias}`); } catch (e) { this.log.warn('[context] db.exec failed: ' + e.message); }
        this._sharedGraphs = this._sharedGraphs.filter(s => s.slug !== slug);
        this.log.info(`[shared-graph] File replaced for "${slug}" (ino ${existing._ino} → ${diskIno}), re-attaching`);
      }

      const alias = `proj_${slug.replace(/[^a-z0-9_]/g, '_')}`;
      try {
        this.db.exec(`ATTACH DATABASE '${dbFile}' AS ${alias}`);
        this._sharedGraphs.push({ slug, alias, name: proj.name || slug, dbFile, _ino: diskIno });
        this.log.info(`[shared-graph] Attached project "${slug}" as ${alias}`);
      } catch (e) {
        this.log.warn?.(`[shared-graph] Failed to attach "${slug}": ${e.message}`);
      }
    }
  }

  /**
   * Get a prepared statement (cached)
   */
  stmt(name, sql) {
    if (!this._stmts[name]) {
      this._stmts[name] = this.db.prepare(sql);
    }
    return this._stmts[name];
  }

  // ── Token Budget Helpers ──────────────────────────────────────────────────

  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  _truncateToTokenBudget(text, maxTokens) {
    if (!text || maxTokens <= 0) return text;
    const currentTokens = this._estimateTokens(text);
    if (currentTokens <= maxTokens) return text;

    const targetChars = (maxTokens - 15) * 4;
    if (targetChars <= 0) return '... [truncated for budget]';

    let cutPoint = targetChars;
    const searchStart = Math.max(0, targetChars - 200);
    const searchRegion = text.slice(searchStart, targetChars);

    const lastNewline = searchRegion.lastIndexOf('\n');
    if (lastNewline !== -1) {
      cutPoint = searchStart + lastNewline;
    } else {
      const lastSentence = Math.max(
        searchRegion.lastIndexOf('. '),
        searchRegion.lastIndexOf('! '),
        searchRegion.lastIndexOf('? ')
      );
      if (lastSentence !== -1) {
        cutPoint = searchStart + lastSentence + 1;
      }
    }

    return text.slice(0, cutPoint).trimEnd() + '\n... [truncated for budget]';
  }

  // ── System Prompt Building ──────────────────────────────────────────────

  static STATIC_KEYS = new Set([
    'persona', 'identity', 'voice', 'rules', 'selfknowledge',
    'anti', 'tooling', 'reflections', 'gaps', 'plugin',
  ]);

  buildStaticPrompt(mode = 'full', opts = {}) {
    this._refreshCacheIfNeeded();
    const B = this._sectionBudgets;
    const orderedKeys = GraphContext.PROMPT_MODES[mode] || GraphContext.PROMPT_MODES.full;

    const cacheKey = mode;
    if (this._staticPromptCache && this._staticPromptCache.mtime === this._graphMtime && this._staticPromptCache.mode === cacheKey) {
      const cachedText = this._staticPromptCache.text;
      // Plugin sections compute fresh per call (not cached) — opts-conditional
      // content (e.g. acorn plugin's Project Context block gated on
      // opts.platform === 'cli') is reflected on every build.
      const pluginExt = this._buildPluginPromptSections(mode, opts);
      return pluginExt ? `${cachedText}\n\n${pluginExt}` : cachedText;
    }

    const sectionBuilders = {
      persona: () => this._truncateToTokenBudget(this._getCachedSection('persona', () => this._buildPersonaFraming()), B.persona),
      identity: () => this._truncateToTokenBudget(this._getCachedSection('identity', () => this._buildIdentitySection()), B.identity),
      voice: () => this._truncateToTokenBudget(this._getCachedSection('voice', () => this._buildVoiceSection()), B.voice),
      rules: () => this._truncateToTokenBudget(this._getCachedSection('rules', () => this._buildRulesSection()), B.rules),
      selfknowledge: () => this._truncateToTokenBudget(this._getCachedSection('selfknowledge', () => this._buildSelfKnowledgeSection()), B.selfknowledge),
      anti: () => this._truncateToTokenBudget(this._getCachedSection('anti', () => this._buildAntiPatternsSection()), B.anti),
      tooling: () => this._truncateToTokenBudget(this._buildToolingSection(), B.tooling),
      reflections: () => this._truncateToTokenBudget(this._buildReflectionsSection({ userId: opts.userId, projectContext: opts.projectContext }), B.reflections),
      gaps: () => this._truncateToTokenBudget(this._buildGapsSection({ userId: opts.userId, projectContext: opts.projectContext }), B.gaps),
      plugin: () => this._truncateToTokenBudget(this._buildPluginSection(), B.plugin),
    };

    const sections = orderedKeys
      .filter(key => GraphContext.STATIC_KEYS.has(key) && sectionBuilders[key])
      .map(key => sectionBuilders[key]())
      .filter(Boolean);
    const text = sections.join('\n\n');
    this._staticPromptCache = { mtime: this._graphMtime, text, mode: cacheKey };
    this.log.debug(`[context] Static prompt cached — mode=${mode} (${this._estimateTokens(text)} tok)`);

    // Plugin-contributed prompt sections: rendered fresh per call so hot
    // install/uninstall is reflected on the next build without invalidating
    // the static-prompt cache for built-in content. opts is forwarded so
    // plugin renderFns can branch on platform / projectContext / sessionId.
    const pluginExt = this._buildPluginPromptSections(mode, opts);
    return pluginExt ? `${text}\n\n${pluginExt}` : text;
  }

  buildDynamicContext(opts = {}) {
    this._refreshCacheIfNeeded();
    const B = this._sectionBudgets;
    const allowed = opts.promptMode ? (GraphContext.PROMPT_MODES[opts.promptMode] || GraphContext.PROMPT_MODES.full) : null;
    const inc = (key) => !allowed || allowed.includes(key);
    const parts = [
      inc('channel') ? this._truncateToTokenBudget(this._buildChannelSection(opts.channelId, opts.channelName), B.channel) : null,
      inc('person') && opts.userName ? this._truncateToTokenBudget(this._buildPersonSection(opts.userId, opts.userName, opts), B.person) : null,
      inc('relevant') && opts.messageContent ? this._truncateToTokenBudget(this._buildRelevantContext(opts.messageContent, { _precomputedResults: opts._precomputedResults, _referenceDate: opts._referenceDate, userId: opts.userId, projectContext: opts.projectContext }), B.relevant) : null,
      inc('episodes') && opts.messageContent ? this._truncateToTokenBudget(this._buildEpisodesSection(opts.messageContent, undefined, { userId: opts.userId, projectContext: opts.projectContext }), B.episodes) : null,
      inc('feed') ? this._truncateToTokenBudget(this._buildCrossSessionSection(opts), B.feed) : null,
      inc('behavior') ? this._truncateToTokenBudget(this._buildConversationBehavior(opts), B.behavior) : null,
      inc('runtime') ? this._truncateToTokenBudget(this._buildRuntimeSection(opts), B.runtime) : null,
      inc('cluster') ? this._buildClusterAccessSection(opts) : null,
    ].filter(Boolean);
    return parts.join('\n\n');
  }

  _buildProjectOperatingReferences(graph, scope) {
    if (!graph?.db) return null;
    const refConfig = scope?.role === 'project'
      ? {
          like: 'ref-project-%',
          heading: `### Project Operating References (${scope.slug})`,
          note: '_Stable project-session rules loaded from the project graph seed nodes._',
        }
      : (scope?.role === 'channel'
        ? {
            like: 'ref-channel-%',
            heading: `### Channel Operating References (${scope.slug})`,
            note: '_Stable channel-mode rules loaded from the channel graph seed nodes._',
          }
        : (scope?.role === 'user'
          ? {
              like: 'ref-user-%',
              heading: `### Web User Operating References (${scope.slug})`,
              note: '_Stable web-user rules loaded from the user graph seed nodes._',
            }
          : null));
    if (!refConfig) return null;
    try {
      const rows = graph.db.prepare(`
        SELECT *
          FROM nodes
         WHERE type = 'reference'
           AND id LIKE ?
         ORDER BY importance DESC, id ASC
         LIMIT 20
      `).all(refConfig.like);
      if (!rows.length) return null;

      const refs = rows.map(r => graph._hydrateNode(r)).filter(Boolean);
      if (!refs.length) return null;

      const lines = [
        refConfig.heading,
        refConfig.note,
      ];
      for (const ref of refs) {
        const desc = ref.description ? `: ${ref.description}` : '';
        lines.push(`- **${ref.label}**${desc}`);
        for (const asp of (ref.aspects || []).slice(0, 4)) {
          const attrs = (asp.attributes || [])
            .map(a => String(a.content || '').trim())
            .filter(Boolean)
            .slice(0, 3);
          if (attrs.length) lines.push(`  - ${asp.name}: ${attrs.join(' ')}`);
        }
      }
      return lines.join('\n');
    } catch (e) {
      this.log.warn(`[graph] scoped operating refs failed for ${scope?.slug || 'unknown'}: ${e.message}`);
      return null;
    }
  }

  async _buildScopedRecallBundle(opts = {}) {
    const env = opts.memoryEnvelope;
    const scopes = Array.isArray(env?.readScopes) ? env.readScopes.filter(s => s?.dbPath) : [];
    if (!opts.messageContent || scopes.length === 0) return null;

    const { classifyQueryType, QUERY_TYPE_PARAMS } = require('./retrieval');
    const queryType = opts._queryType || classifyQueryType(opts.messageContent);
    const qp = opts._queryParams || QUERY_TYPE_PARAMS[queryType] || QUERY_TYPE_PARAMS.specific;
    const queries = [opts.messageContent];
    const eventGraphs = scopes.map(s => s.slug).filter(Boolean);
    const eventScope = eventGraphs.length ? { graphs: eventGraphs } : {};

    if (this.config.enhancedRecall && opts._llmClient) {
      try {
        this.log.info(`[graph] Scoped Enhanced Recall (${env.mode || 'unknown'}): decomposing "${opts.messageContent.slice(0, 80)}..."`);
        try { graphEvents.emit('change', { op: 'recall:start', source: 'scoped-recall', detail: `${env.mode || 'scoped'} · "${opts.messageContent.slice(0, 50)}"`, ...eventScope }); } catch {}
        const decomposed = await this._llmDecomposeQuery(opts._llmClient, opts.messageContent);
        for (const q of decomposed?.subQueries || []) {
          if (q && typeof q === 'string' && !queries.includes(q)) queries.push(q);
        }
        if (queries.length > 1) {
          try { graphEvents.emit('change', { op: 'recall:decompose', source: 'scoped-recall', detail: `${queries.length - 1} sub-queries`, ...eventScope }); } catch {}
        }
      } catch (e) {
        this.log.warn(`[graph] Scoped Enhanced Recall decomposition failed: ${e.message}`);
        try { graphEvents.emit('change', { op: 'recall:fail', source: 'scoped-recall', detail: (e.message || '').slice(0, 80), ...eventScope }); } catch {}
      }
    }

    const headingByRole = {
      project: 'Project Memory',
      general_kb: 'Reusable Engineering Memory',
      main: 'User/System Preferences',
      channel: 'Channel/Thread Memory',
      user: 'Web User Memory',
    };
    const sections = ['## Scoped Recall Bundle', '_Memory is separated by origin. Treat project, channel, or web user memory as local truth for this session; reusable engineering memory as patterns that may apply; user/system preferences as operator preference/config._'];
    const accessed = [];

    for (const scope of scopes) {
      let graph = this;
      let closeWhenDone = false;
      try {
        if (scope.dbPath !== this.config.graphDbPath) {
          graph = new this.constructor({ ...this.config, graphDbPath: scope.dbPath }, this.log);
          graph._pluginManager = this._pluginManager;
          if (!graph.init()) continue;
          closeWhenDone = true;
        }

        const operatingRefs = this._buildProjectOperatingReferences(graph, scope);
        if (operatingRefs) sections.push(`\n${operatingRefs}`);

        const found = new Map();
        const perQueryLimit = Math.max(4, Math.min(12, Number(scope.budget) || 10));
        const search = scope.role === 'main'
          ? graph.hybridSearchSelf.bind(graph)
          : graph.hybridSearch.bind(graph);
        for (const q of queries) {
          const rows = await search(q, perQueryLimit).catch(() => []);
          for (const n of rows || []) {
            if (!found.has(n.id)) found.set(n.id, n);
          }
        }
        const results = Array.from(found.values())
          .sort((a, b) => (b._hybridScore || 0) - (a._hybridScore || 0))
          .slice(0, Math.max(6, Number(scope.budget) || 10));

        let text = null;
        if (results.length) {
          text = graph._buildRelevantContext(opts.messageContent, {
            _precomputedResults: results,
            _referenceDate: opts._referenceDate,
            _queryType: queryType,
            _queryParams: qp,
            userId: opts.userId,
            userName: opts.userName,
            projectContext: null,
          });
        }
        const episodes = graph._buildEpisodesSection(opts.messageContent, qp, {
          userId: opts.userId,
          userName: opts.userName,
          projectContext: null,
        });

        if (text || episodes) {
          const title = headingByRole[scope.role] || scope.label || scope.slug;
          sections.push(`\n### ${title} (${scope.slug})`);
          if (text) sections.push(text.replace(/^## Relevant Context \(from graph\)\n?/, '').trim());
          if (episodes) sections.push(episodes.trim());
          accessed.push(...results.map(n => n.id));
        }
      } catch (e) {
        this.log.warn(`[graph] scoped recall failed for ${scope.slug}: ${e.message}`);
      } finally {
        if (closeWhenDone) {
          try { graph.db?.close(); } catch {}
        }
      }
    }

    if (accessed.length) {
      try { graphEvents.emit('change', { op: 'node:accessed', nodeIds: accessed, source: 'scoped-recall', ...eventScope }); } catch {}
    }
    return sections.length > 2 ? sections.join('\n') : null;
  }

  async buildSystemPromptAsync(opts = {}) {
    this._refreshSharedGraphs();
    if (opts.messageContent) {
      const queryType = classifyQueryType(opts.messageContent);
      const qp = QUERY_TYPE_PARAMS[queryType] || QUERY_TYPE_PARAMS.specific;
      opts._queryType = queryType;
      opts._queryParams = qp;

      // Plugin lifecycle hook: shouldSkipRecall — gives plugins a
      // chance to short-circuit the (expensive) Enhanced Recall
      // pipeline. This check must run before scoped project recall too;
      // otherwise capability questions such as "which tools do you have"
      // can pull stale tool lore from the project graph instead of relying
      // on the runtime tool contract.
      const mgr = this._pluginManager;
      if (mgr) {
        const hooks = mgr.getLifecycleHooks?.('shouldSkipRecall') || [];
        for (const h of hooks) {
          let skip = false;
          try { skip = !!h({ opts, queryType, log: this.log }); } catch (e) { this.log.warn('[graph] shouldSkipRecall hook failed: ' + e.message); }
          if (skip) {
            this.log.info(`[graph] Recall skipped by plugin: "${(opts.messageContent || '').slice(0, 80)}..."`);
            if (opts.memoryEnvelope?.readScopes?.length) opts._skipDefaultRecallSections = true;
            return this.buildSystemPrompt(opts);
          }
        }
      }

      if (opts.memoryEnvelope?.readScopes?.length) {
        opts._scopedRecallBundle = await this._buildScopedRecallBundle(opts);
        opts._skipDefaultRecallSections = true;
        return this.buildSystemPrompt(opts);
      }

      try {
        if (this.config.enhancedRecall && opts._llmClient) {
          this.log.info(`[graph] Enhanced Recall (${queryType}): decomposing query "${opts.messageContent.slice(0, 80)}..."`);
          try { graphEvents.emit('change', { op: 'recall:start', source: 'recall', detail: `${queryType} · "${opts.messageContent.slice(0, 50)}"` }); } catch {}
          try {
            const decomposed = await this._llmDecomposeQuery(opts._llmClient, opts.messageContent);
            if (decomposed && decomposed.subQueries?.length > 0) {
              this.log.info(`[graph] Enhanced Recall: ${decomposed.subQueries.length} sub-queries: ${JSON.stringify(decomposed.subQueries)}`);
              try { graphEvents.emit('change', { op: 'recall:decompose', source: 'recall', detail: `${decomposed.subQueries.length} sub-queries` }); } catch {}
              const allResults = new Map();

              const mainSearchLimit = queryType === 'aggregation' ? 25 : 15;
              const mainResults = await this.hybridSearchSelf(opts.messageContent, mainSearchLimit);
              for (const n of mainResults) allResults.set(n.id, n);

              const subSearchLimit = queryType === 'aggregation' ? 15 : 10;
              const subSearches = decomposed.subQueries.map(sq =>
                this.hybridSearchSelf(sq, subSearchLimit).catch(() => [])
              );
              const subResults = await Promise.all(subSearches);
              for (const batch of subResults) {
                for (const n of batch) {
                  if (!allResults.has(n.id)) allResults.set(n.id, n);
                }
              }

              let hintHits = 0;
              let attrFtsHits = 0;
              const allSearchQueries = [opts.messageContent, ...decomposed.subQueries];
              for (const sq of allSearchQueries) {
                try {
                  const hintIds = this._searchHints(sq, 5);
                  hintHits += hintIds.length;
                  for (const nid of hintIds) {
                    if (!allResults.has(nid)) {
                      const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
                      if (row) allResults.set(nid, this._hydrateNode(row));
                    }
                  }
                } catch (e) {
                  this.log.warn(`[graph] Enhanced Recall: hints search failed for "${sq}": ${e.message}`);
                }
                try {
                  const attrNodeIds = this._searchAttributesFTS(sq, 5);
                  attrFtsHits += attrNodeIds.length;
                  for (const nid of attrNodeIds) {
                    if (!allResults.has(nid)) {
                      const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
                      if (row) allResults.set(nid, this._hydrateNode(row));
                    }
                  }
                } catch (e) { this.log.warn('[context] _searchAttributesFTS failed: ' + e.message); }
              }

              const temporal = this._detectTemporalQuery(opts.messageContent);
              let temporalHits = 0;
              if (temporal) {
                try {
                  const dateProxIds = this._searchByDateProximity(temporal.dates, 8);
                  temporalHits = dateProxIds.length;
                  for (const nid of dateProxIds) {
                    if (!allResults.has(nid)) {
                      const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
                      if (row) allResults.set(nid, this._hydrateNode(row));
                    }
                  }
                  if (temporal.dates.length > 0) {
                    const targetMs = temporal.dates.map(d => new Date(d).getTime()).filter(t => !isNaN(t));
                    if (targetMs.length > 0) {
                      for (const node of allResults.values()) {
                        if (!node.aspects) continue;
                        let bestProximity = Infinity;
                        for (const asp of node.aspects) {
                          for (const attr of (asp.attributes || [])) {
                            if (attr.eventDate) {
                              const attrMs = new Date(attr.eventDate).getTime();
                              if (!isNaN(attrMs)) {
                                for (const tMs of targetMs) {
                                  bestProximity = Math.min(bestProximity, Math.abs(attrMs - tMs));
                                }
                              }
                            }
                          }
                        }
                        if (bestProximity < Infinity) {
                          const daysDiff = bestProximity / 86400000;
                          const temporalBoost = 0.10 * Math.exp(-(daysDiff * daysDiff) / (2 * 20 * 20));
                          node._hybridScore = (node._hybridScore || 0) + temporalBoost;
                        }
                      }
                    }
                  }
                } catch (te) {
                  this.log.debug?.(`[graph] Temporal scoring: ${te.message}`);
                }
              }

              let walkHits = 0;
              try {
                const walkResults = this._graphWalk(new Set(allResults.keys()), 2, 10);
                for (const { id, depth } of walkResults) {
                  if (!allResults.has(id)) {
                    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
                    if (row) {
                      const node = this._hydrateNode(row);
                      node._hybridScore = depth === 1 ? 0.30 : 0.15;
                      allResults.set(id, node);
                      walkHits++;
                    }
                  }
                }
              } catch (we) {
                this.log.debug?.(`[graph] Graph walk: ${we.message}`);
              }

              let sqlSweepHits = 0;
              if (queryType === 'aggregation') {
                const agentId = this.config.agentId || 'spore';
                try {
                  const { SEARCH_STOPWORDS } = require('./retrieval');
                  const queryTerms = opts.messageContent.toLowerCase()
                    .split(/\s+/)
                    .filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w));
                  if (queryTerms.length > 0) {
                    const likeClauses = queryTerms.map(t => `(n.label LIKE '%' || ? || '%' OR n.description LIKE '%' || ? || '%')`).join(' OR ');
                    const params = queryTerms.flatMap(t => [t, t]);
                    const rows = this.db.prepare(`
                      SELECT DISTINCT n.* FROM nodes n
                      WHERE (${likeClauses})
                        AND n.id != ?
                      ORDER BY n.importance DESC
                      LIMIT 30
                    `).all(...params, agentId);
                    for (const row of rows) {
                      if (!allResults.has(row.id)) {
                        const node = this._hydrateNode(row);
                        node._hybridScore = 0.25;
                        allResults.set(row.id, node);
                        sqlSweepHits++;
                      }
                    }
                    const attrLikeClauses = queryTerms.map(t => `attr.content LIKE '%' || ? || '%'`).join(' OR ');
                    const attrParams = [...queryTerms];
                    const attrRows = this.db.prepare(`
                      SELECT DISTINCT n.* FROM nodes n
                      JOIN aspects a ON a.node_id = n.id
                      JOIN attributes attr ON attr.aspect_id = a.id
                      WHERE (${attrLikeClauses})
                        AND n.id != ?
                      ORDER BY n.importance DESC
                      LIMIT 30
                    `).all(...attrParams, agentId);
                    for (const row of attrRows) {
                      if (!allResults.has(row.id)) {
                        const node = this._hydrateNode(row);
                        node._hybridScore = 0.20;
                        allResults.set(row.id, node);
                        sqlSweepHits++;
                      }
                    }
                  }

                  const edgeRows = this.db.prepare(`
                    SELECT DISTINCT n.* FROM edges e
                    JOIN nodes n ON n.id = CASE WHEN e.source = ? THEN e.target ELSE e.source END
                    WHERE (e.source = ? OR e.target = ?)
                    ORDER BY n.importance DESC
                    LIMIT 150
                  `).all(agentId, agentId, agentId);
                  for (const row of edgeRows) {
                    if (!allResults.has(row.id)) {
                      const node = this._hydrateNode(row);
                      node._hybridScore = 0.15;
                      allResults.set(row.id, node);
                      sqlSweepHits++;
                    }
                  }

                  if (!allResults.has(agentId)) {
                    const userNode = this._hydrateNode(
                      this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(agentId)
                    );
                    if (userNode) {
                      userNode._hybridScore = 0.50;
                      userNode._isUserPersonNode = true;
                      allResults.set(agentId, userNode);
                      sqlSweepHits++;
                    }
                  } else {
                    const existing = allResults.get(agentId);
                    if (existing) existing._isUserPersonNode = true;
                  }

                  if (sqlSweepHits > 0) {
                    this.log.info(`[graph] Enhanced Recall: SQL + edge sweep added ${sqlSweepHits} nodes for aggregation query`);
                  }
                } catch (se) {
                  this.log.debug?.(`[graph] SQL sweep: ${se.message}`);
                }
              }

              this.log.info(`[graph] Enhanced Recall: ${allResults.size} total nodes (main=${mainResults.length}, hints=${hintHits}, attrFts=${attrFtsHits}${temporalHits ? ', temporal=' + temporalHits : ''}${walkHits ? ', walk=' + walkHits : ''}${sqlSweepHits ? ', sqlSweep=' + sqlSweepHits : ''})`);

              const allArr = Array.from(allResults.values());
              allArr.sort((a, b) => (b._hybridScore || 0) - (a._hybridScore || 0));
              const topScore = allArr[0]?._hybridScore || 0;
              const scoreCutoff = topScore * 0.35;
              const scoreCount = allArr.filter(n => (n._hybridScore || 0) >= scoreCutoff).length;
              const maxCap = qp.maxResults;
              const dynamicCap = Math.min(Math.max(scoreCount, 12), maxCap);
              if (allArr.length > dynamicCap) {
                opts._precomputedResults = allArr.slice(0, dynamicCap);
                this.log.info(`[graph] Enhanced Recall: capped ${allArr.length} -> ${dynamicCap} results (${queryType}, top=${topScore.toFixed(3)}, cutoff=${allArr[dynamicCap - 1]?._hybridScore?.toFixed(3)})`);
              } else {
                opts._precomputedResults = allArr;
                this.log.info(`[graph] Enhanced Recall: using all ${allArr.length} results (${queryType})`);
              }
            } else {
              this.log.info('[graph] Enhanced Recall: decomposition returned no sub-queries, using standard search');
              try { graphEvents.emit('change', { op: 'recall:empty', source: 'recall', detail: 'no sub-queries — fell back to standard search' }); } catch {}
              opts._precomputedResults = await this.hybridSearchSelf(opts.messageContent, 20);
            }
          } catch (e) {
            this.log.warn(`[graph] Enhanced Recall: decomposition failed (${e.message}), falling back to standard search`);
            try { graphEvents.emit('change', { op: 'recall:fail', source: 'recall', detail: (e.message || '').slice(0, 80) }); } catch {}
            opts._precomputedResults = await this.hybridSearchSelf(opts.messageContent, 20);
          }
        } else {
          const results = await this.hybridSearchSelf(opts.messageContent, 20);
          opts._precomputedResults = results;
        }

        if (opts.promptMode === 'recall' && opts._llmClient && opts._precomputedResults.length > 5) {
          try {
            const before = opts._precomputedResults.length;
            opts._precomputedResults = await this._rerankWithLLM(opts._llmClient, opts.messageContent, opts._precomputedResults);
            this.log.info(`[graph] Re-ranker: reordered ${before} candidates`);
          } catch (e) {
            this.log.warn(`[graph] Re-ranker failed: ${e.message}`);
          }
        }

        if (opts._precomputedResults?.length) {
          try {
            graphEvents.emit('change', {
              op: 'node:accessed',
              nodeIds: opts._precomputedResults.map(n => n.id),
              source: 'retrieval',
            });
          } catch (e) { this.log.warn('[context] graphEvents.emit failed: ' + e.message); }
        }
      } catch (e) {
        this.log.warn(`[graph] buildSystemPromptAsync search phase error: ${e.message}`);
      }
    }
    return this.buildSystemPrompt(opts);
  }

  buildSystemPrompt(opts = {}) {
    const mode = opts.promptMode || 'full';

    if (mode === 'none') {
      const agentNode = this.getNode(this.config.agentId || 'spore');
      return agentNode ? `You are ${agentNode.label}.` : 'You are an AI agent.';
    }

    this._refreshSharedGraphs();
    this._refreshCacheIfNeeded();
    const B = { ...this._sectionBudgets };
    const allowedKeys = new Set(GraphContext.PROMPT_MODES[mode] || GraphContext.PROMPT_MODES.full);

    if (mode === 'recall') {
      const qp = opts._queryParams || QUERY_TYPE_PARAMS.specific;
      B.relevant = qp.relevantBudget;
      B.episodes = qp.episodeBudget;
      B.persona = 100;
    }

    const sectionMap = {
      persona: allowedKeys.has('persona') ? this._truncateToTokenBudget(
        this._getCachedSection('persona', () => this._buildPersonaFraming()), B.persona) : null,
      identity: allowedKeys.has('identity') ? this._truncateToTokenBudget(
        this._getCachedSection('identity', () => this._buildIdentitySection()), B.identity) : null,
      voice: allowedKeys.has('voice') ? this._truncateToTokenBudget(
        this._getCachedSection('voice', () => this._buildVoiceSection()), B.voice) : null,
      rules: allowedKeys.has('rules') ? this._truncateToTokenBudget(
        this._getCachedSection('rules', () => this._buildRulesSection()), B.rules) : null,
      selfknowledge: allowedKeys.has('selfknowledge') ? this._truncateToTokenBudget(
        this._getCachedSection('selfknowledge', () => this._buildSelfKnowledgeSection()), B.selfknowledge) : null,
      channel: allowedKeys.has('channel') ? this._truncateToTokenBudget(
        this._buildChannelSection(opts.channelId, opts.channelName), B.channel) : null,
      person: allowedKeys.has('person') && opts.userName ? this._truncateToTokenBudget(
        this._buildPersonSection(opts.userId, opts.userName, opts), B.person) : null,
      relevant: allowedKeys.has('relevant') && opts.messageContent ? this._truncateToTokenBudget(
        this._buildRelevantContext(opts.messageContent, { _precomputedResults: opts._precomputedResults, _referenceDate: opts._referenceDate, _queryType: opts._queryType, _queryParams: opts._queryParams, userId: opts.userId, projectContext: opts.projectContext }), B.relevant) : null,
      anti: allowedKeys.has('anti') ? this._truncateToTokenBudget(
        this._getCachedSection('anti', () => this._buildAntiPatternsSection()), B.anti) : null,
      feed: allowedKeys.has('feed') ? this._truncateToTokenBudget(
        this._buildCrossSessionSection(opts), B.feed) : null,
      tooling: allowedKeys.has('tooling') ? this._truncateToTokenBudget(
        this._buildToolingSection(), B.tooling) : null,
      behavior: allowedKeys.has('behavior') ? this._truncateToTokenBudget(
        this._buildConversationBehavior(opts), B.behavior) : null,
      runtime: allowedKeys.has('runtime') ? this._truncateToTokenBudget(
        this._buildRuntimeSection(opts), B.runtime) : null,
      cluster: allowedKeys.has('cluster') ? this._buildClusterAccessSection(opts) : null,
      overview: allowedKeys.has('overview') ? this._truncateToTokenBudget(
        this._buildOverviewSection({ userId: opts.userId, projectContext: opts.projectContext }), B.overview) : null,
      hyperedges: allowedKeys.has('hyperedges') ? this._truncateToTokenBudget(
        this._buildHyperedgesSection({ userId: opts.userId, projectContext: opts.projectContext }), B.hyperedges) : null,
      reflections: allowedKeys.has('reflections') ? this._truncateToTokenBudget(
        this._buildReflectionsSection({ userId: opts.userId, projectContext: opts.projectContext }), B.reflections) : null,
      derived: allowedKeys.has('derived') ? this._truncateToTokenBudget(
        this._buildDerivedFactsSection(opts.messageContent, { userId: opts.userId, projectContext: opts.projectContext }), B.derived) : null,
      gaps: allowedKeys.has('gaps') ? this._truncateToTokenBudget(
        this._buildGapsSection({ userId: opts.userId, projectContext: opts.projectContext }), B.gaps) : null,
      plugin: allowedKeys.has('plugin') ? this._truncateToTokenBudget(
        this._buildPluginSection(), B.plugin) : null,
      episodes: allowedKeys.has('episodes') && opts.messageContent ? this._truncateToTokenBudget(
        this._buildEpisodesSection(opts.messageContent, opts._queryParams, { userId: opts.userId, projectContext: opts.projectContext }), B.episodes) : null,
    };

    if (opts._skipDefaultRecallSections) {
      sectionMap.relevant = null;
      sectionMap.episodes = null;
      sectionMap.derived = null;
      sectionMap.reflections = null;
      sectionMap.overview = null;
      sectionMap.hyperedges = null;
      sectionMap.gaps = null;
      if (opts.memoryEnvelope?.mode === 'codebase-session' || (opts.platform === 'cli' && opts.projectContext?.cwd)) {
        sectionMap.selfknowledge = null;
        sectionMap.feed = null;
      }
    }

    const orderedKeys = GraphContext.PROMPT_MODES[mode] || GraphContext.PROMPT_MODES.full;

    const totalBudget = (mode === 'recall' && opts._queryParams)
      ? Math.max(this._totalBudget, opts._queryParams.relevantBudget + opts._queryParams.episodeBudget + 1000)
      : this._totalBudget;

    let totalTokens = orderedKeys.reduce((sum, k) => sum + this._estimateTokens(sectionMap[k]), 0);

    if (totalTokens > totalBudget) {
      const dropOrder = GraphContext.DROP_ORDER;
      for (const key of dropOrder) {
        if (totalTokens <= totalBudget) break;
        if (sectionMap[key]) {
          totalTokens -= this._estimateTokens(sectionMap[key]);
          sectionMap[key] = null;
          this.log.debug(`[context] Dropped ${key} section for budget (total: ${totalTokens})`);
        }
      }
    }

    const staticSections = orderedKeys
      .filter(k => GraphContext.STATIC_KEYS.has(k) && sectionMap[k])
      .map(k => sectionMap[k]);
    const dynamicSections = orderedKeys
      .filter(k => !GraphContext.STATIC_KEYS.has(k) && sectionMap[k])
      .map(k => sectionMap[k]);

    // Plugin-contributed prompt sections (registerPromptSection). These are
    // computed fresh per call — not part of any cache — so install/uninstall
    // and per-turn opts changes are reflected immediately. Distinct from
    // _buildPluginSection above (legacy context-engine surface) which lives
    // in the orderedKeys section map. Appended after dynamic so plugin
    // content doesn't get truncated by the section-budget pass.
    const pluginExt = this._buildPluginPromptSections(mode, opts);

    return [...staticSections, opts._scopedRecallBundle || null, ...dynamicSections, pluginExt].filter(Boolean).join('\n\n');
  }

  // ── Cache Management ──────────────────────────────────────────────────────

  _refreshCacheIfNeeded() {
    try {
      const fs = require('fs');
      const stat = fs.statSync(this.config.graphDbPath);
      const mtime = stat.mtimeMs;
      if (mtime !== this._graphMtime) {
        this._cache = {};
        this._graphMtime = mtime;
        this.log.debug('[context] Cache invalidated — graph modified');
      }
    } catch (e) { this.log.warn('[context] require failed: ' + e.message); }
  }

  _getCachedSection(key, buildFn) {
    if (this._cache[key] !== undefined) return this._cache[key];
    const result = buildFn();
    this._cache[key] = result;
    return result;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._stmts = {};
      this.log.info('Graph context engine closed');
    }
  }
}

// Apply retrieval and prompt-section methods to the prototype
const { applyRetrievalMixin } = require('./retrieval');
const { applyPromptSectionsMixin } = require('./prompt-sections');
applyRetrievalMixin(GraphContext);
applyPromptSectionsMixin(GraphContext);

module.exports = { GraphContext };
