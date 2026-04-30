// session-graph plugin — generic primitives for tracking long
// conversations as graph nodes. Other plugins (acorn-cli, future
// CLI / web / Discord trackers) declare this as a dependency and:
//   • require('../session-graph/lib/sessions')   — upsert / finalize /
//                                                  bumpTurn / summarize / distill
//   • require('../session-graph/lib/projects')   — upsert / get /
//                                                  noteProjectInteraction
//   • require('../session-graph/lib/heuristics') — looksLikeCodingTurn
//   • require('../session-graph/lib/checkpoints')— captureFailureFix /
//                                                  recordRoundCheckpoint
//   • require('../session-graph/lib/discovery')  — noteDiscovery
//
// This plugin's index.js itself only registers the `note_discovery`
// tool (generic enough that any session-aware plugin can use it).
// Everything else is exposed as plain require()-able modules — no
// special inter-plugin RPC API needed.

const { noteDiscovery } = require('./lib/discovery');
const scripts = require('./lib/scripts');
const projectsLib = require('./lib/projects');
const decisions = require('./lib/decisions');

module.exports = function register(api) {
  // note_discovery tool — bare name (namespaced:false) preserves the
  // public contract for the agent. The generic ctx-driven gate (sessionId
  // = ctx.channelId when ctx.platform === 'cli') means this works for any
  // CLI-class session, not just acorn-cli.
  api.registerTool('note_discovery', {
    namespaced: false,
    description:
      'Persist a durable discovery to the knowledge graph and link it to the current session AND project. ' +
      'WHEN TO USE — any time a non-trivial fact or fix surfaces during a coding session: ' +
      '"this expo dev server defaults to 8081", "the python venv is at .venv/dev not .venv", ' +
      '"vault keys are read by the bun process via env, not the python wrapper". ' +
      'Avoids losing operator-supplied context to chat history when this conversation ages out. ' +
      'AUTOMATIC: outside a session, this tool stores the discovery as a permanent global node.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The discovery itself, written as a complete sentence. Keep under 500 chars.',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'gotcha', 'workflow', 'config', 'failure_fix'],
          description: 'Discovery flavor. Defaults to "fact".',
        },
        label: {
          type: 'string',
          description: 'Optional short label for the node id; auto-derived from text if omitted.',
        },
        relatedTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: existing node ids this discovery relates to. Adds `relates_to` edges.',
        },
      },
      required: ['text'],
    },
    execute: (input, ctx) => noteDiscovery(api, input, ctx),
  });

  // Project-scoped script primitives. These tools materialize agent-
  // written reusable helpers as dedicated `script:<projectId>:<name>`
  // graph nodes (one per script, edged from the project node) plus a
  // lightweight `scripts_index` aspect on the project node so
  // list_project_scripts is cheap. Bodies stored plaintext for v1; the
  // SECRET_PATTERNS guard rejects bodies matching common credential
  // shapes unless force:true. See lib/scripts.js for details.
  //
  // All four tools resolve projectId from ctx.userId + ctx.projectContext.cwd
  // (same convention as note_discovery / projects.js). Outside an
  // acorn ctx they no-op with a clear error rather than guessing.

  function ctxProjectId(ctx) {
    if (ctx?.platform !== 'cli') return null;
    const cwd = ctx?.projectContext?.cwd || ctx?.projectContext?.clientCwd;
    if (!cwd) return null;
    const userId = ctx?.userId || ctx?.userName || 'anon';
    return scripts.projectNodeId(userId, cwd);
  }

  api.registerTool('save_project_script', {
    namespaced: false,
    description:
      'Save a reusable helper script to the current project so the next session can pick it up. ' +
      'Creates a dedicated `script:<projectId>:<name>` graph node with body + meta + stats aspects, ' +
      'and a lightweight summary entry on the project node\'s `scripts_index` aspect. ' +
      'Bodies are scanned for common credential shapes (sk-, ghp_, AWS keys, password=, etc.) and rejected unless `force:true`. ' +
      'On success returns a `materializePath` (default `.spore-code/scratch/<name>.<ext>`) the CLI can use to write the body to disk for immediate exec — the graph stays the source of truth.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Unique name within the project. Lowercased + dashed for the node id.' },
        description: { type: 'string', description: 'One-line agent-facing summary. Shown by list_project_scripts.' },
        language:    { type: 'string', description: 'js | ts | py | sh | go | rs | rb. Drives the materialize file extension.' },
        body:        { type: 'string', description: 'Full source. Capped at 64KB. Plaintext at rest in v1.' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional. e.g. ["build", "gh", "test"].' },
        requires:    { type: 'array', items: { type: 'string' }, description: 'Optional CLI deps the script needs to run (e.g. ["gh", "jq"]).' },
        force:       { type: 'boolean', description: 'Bypass the secret-pattern guard. Use only if the regex flagged a false positive.' },
      },
      required: ['name', 'body'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context — save_project_script only works inside a Spore Code session' };
      const learner = api._appContext?.learner;
      return scripts.upsertScriptNode(learner, {
        projectId,
        sessionId: ctx?.channelId || null,
        name: input.name,
        description: input.description,
        language: input.language,
        body: input.body,
        tags: input.tags,
        requires: input.requires,
        force: input.force === true,
      });
    },
  });

  api.registerTool('list_project_scripts', {
    namespaced: false,
    description:
      'List the helper scripts saved for the current project. Returns name + description + language + tags + counters for each entry — body NOT included. ' +
      'Cheap: reads only the project node\'s `scripts_index` aspect, never the dedicated script: nodes. Call this at session start in plan mode to discover what prior sessions already wrote so you can re-use rather than re-derive.',
    inputSchema: {
      type: 'object',
      properties: {
        tag:      { type: 'string', description: 'Optional. Filter to entries containing this tag.' },
        language: { type: 'string', description: 'Optional. Filter to entries of one language.' },
      },
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      const list = scripts.listScriptsIndex(learner, projectId, {
        tag: input?.tag,
        language: input?.language,
      });
      return { ok: true, count: list.length, scripts: list };
    },
  });

  api.registerTool('get_project_script', {
    namespaced: false,
    description:
      'Fetch the full body + meta + stats for one script saved on the current project. Returns `materializePath` so the CLI can write the body to .spore-code/scratch/<name>.<ext> if it\'s not already there (handles the "fresh laptop" case automatically).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Script name. Match is exact (lowercased + dashed).' },
      },
      required: ['name'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      return scripts.getScriptNode(learner, projectId, input.name);
    },
  });

  api.registerTool('update_code_graph_summary', {
    namespaced: false,
    description:
      'Mirror a structural code-index summary (clusters, tech stack, entry points, hot paths, stats) into the current project node\'s `code_graph` aspect. ' +
      'Call this AFTER running the local `architecture` tool — pass its result through. The summary survives across sessions and shows up in the Spore Core graph viewer alongside other project memory. ' +
      'Authoritative symbol/CALLS data stays in the client-side .spore-code/index.db; this is the cheap, persistable summary.',
    inputSchema: {
      type: 'object',
      properties: {
        index_head:   { type: 'string', description: 'Git short-sha at index time (from architecture.index_head).' },
        stats:        { type: 'object', description: '{files, symbols, functions, methods, classes, calls} from architecture.stats.' },
        tech_stack:   { type: 'array', description: 'Language breakdown — array of {language, files, symbols}.' },
        entry_points: { type: 'array', description: 'Array of {qname, name, file, line, kind, language}; cap at 10.' },
        clusters:     { type: 'array', description: 'Top-level dir clusters — array of {name, path, files, symbols, dominant_lang}; cap at 30.' },
        hot_paths:    { type: 'array', description: 'Top callers — array of {qname, name, file, line, callers, language}; cap at 20.' },
        notes:        { type: 'array', items: { type: 'string' }, description: 'Coverage notes from architecture.notes.' },
      },
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context — update_code_graph_summary only works inside a Spore Code session' };
      const learner = api._appContext?.learner;
      const userId = ctx?.userId || ctx?.userName || 'anon';
      const cwd = ctx?.projectContext?.cwd || ctx?.projectContext?.clientCwd;
      if (!cwd) return { ok: false, error: 'no cwd in projectContext' };
      return projectsLib.upsertProjectCodeGraph(learner, userId, cwd, input || {});
    },
  });

  api.registerTool('record_script_outcome', {
    namespaced: false,
    description:
      'Bump success_count or fail_count on a saved project script + its index summary. Call this after exec\'ing the script body so the maintainer/janitor can later prune always-failing or never-used helpers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Script name.' },
        ok:   { type: 'boolean', description: 'true → bump success_count, false → bump fail_count.' },
      },
      required: ['name', 'ok'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      return scripts.recordScriptOutcome(learner, projectId, input.name, input.ok === true);
    },
  });

  // ── Decisions (ADR-style) ─────────────────────────────────────────
  // Records non-trivial architectural choices the agent and operator
  // make over the lifetime of a project. Same dedicated-node pattern
  // as scripts: `decision:<projectId>:<id>` carries body + meta;
  // `decisions_index` aspect on the project node carries one one-line
  // summary entry per ADR. status enum: proposed | accepted |
  // rejected | superseded | deprecated.

  api.registerTool('decisions_new', {
    namespaced: false,
    description:
      'Record a new architectural decision (ADR) on the current project. Saves the full body to a dedicated `decision:<projectId>:<id>` node and a summary entry on the project\'s `decisions_index` aspect. ' +
      'WHEN to call: when a non-obvious tradeoff is made — language choice, framework, data model shape, deployment target, library replacement, etc. ' +
      'Default status is "proposed"; the operator marks it "accepted" or "rejected" later. ' +
      'Decisions are intentionally NOT born temp — they survive session-end distillation, since they record explicit choices that should outlive the session.',
    inputSchema: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: 'Optional short id (e.g. "0042" or "auth-rewrite"); defaults to a slug of the title.' },
        title:  { type: 'string', description: 'One-line summary of the decision.' },
        body:   { type: 'string', description: 'Full ADR text — context, options considered, consequences. Markdown supported.' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'], description: 'Default: proposed.' },
        author: { type: 'string', description: 'Optional — defaults to the session userId.' },
      },
      required: ['title', 'body'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context — decisions_new only works inside a Spore Code session' };
      const learner = api._appContext?.learner;
      const author = input?.author || ctx?.userName || ctx?.userId || null;
      return decisions.newDecision(learner, {
        projectId,
        sessionId: ctx?.channelId || null,
        id:    input.id,
        title: input.title,
        body:  input.body,
        status: input.status,
        author,
      });
    },
  });

  api.registerTool('decisions_list', {
    namespaced: false,
    description:
      'List the architectural decisions recorded on the current project. Returns id + title + status + created_at for each — body NOT included. ' +
      'Cheap: reads only the `decisions_index` aspect, never the dedicated decision: nodes. Call this in plan mode to surface ADR constraints — accepted decisions are non-negotiable; the plan must respect them.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'], description: 'Optional filter.' },
      },
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      const list = decisions.listDecisions(learner, projectId, { status: input?.status });
      return { ok: true, count: list.length, decisions: list };
    },
  });

  api.registerTool('decisions_get', {
    namespaced: false,
    description:
      'Fetch the full body + meta of one decision recorded on the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Decision id (matches what decisions_list returned).' },
      },
      required: ['id'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      return decisions.getDecision(learner, projectId, input.id);
    },
  });

  api.registerTool('decisions_update', {
    namespaced: false,
    description:
      'Update an existing decision — change its status (e.g. "proposed" → "accepted"), rewrite the body, or fix the title. ' +
      'Use this when the operator marks an ADR accepted, supersedes one, or revises the rationale. The created_at is preserved; updated_at refreshes.',
    inputSchema: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: 'Decision id.' },
        status: { type: 'string', enum: ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'] },
        body:   { type: 'string' },
        title:  { type: 'string' },
      },
      required: ['id'],
    },
    execute: (input, ctx) => {
      const projectId = ctxProjectId(ctx);
      if (!projectId) return { ok: false, error: 'no project context' };
      const learner = api._appContext?.learner;
      return decisions.updateDecision(learner, {
        projectId,
        id:     input.id,
        status: input.status,
        body:   input.body,
        title:  input.title,
      });
    },
  });

  api.getLogger().info('Plugin ready — note_discovery + save/list/get_project_script + record_script_outcome + update_code_graph_summary + decisions_new/list/get/update tools registered. Lib modules (sessions, projects, heuristics, checkpoints, discovery, scripts, decisions) available via require for dependent plugins.');
};
