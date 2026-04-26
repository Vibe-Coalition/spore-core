-- acorn-cli plugin install SQL.
-- Bundles ref-acorn-context (with all aspects), ref-acorn-personas patches,
-- ref-acorn-tool-usage patches, ref-acorn-tooling-questions patches, and
-- the graphcorn-discovery aspect (per the user's design call: graphcorn is
-- part of acorn, not a separate plugin).
--
-- 1) Backfill: legacy installs created these rows with extracted_with='seed'
--    via the in-tree migrate-ref-acorn-* + migrate-ref-graphcorn-discovery
--    SQL files. Retag everything tied to ref-acorn-context (and the
--    referenced edges) so future uninstall finds them.
-- 2) Idempotent insert (WHERE NOT EXISTS / INSERT OR IGNORE) of the node +
--    all aspects + attributes + edges with extracted_with='{{plugin_id}}'.

-- ── Self-sufficient node + base aspects ───────────────────────────
-- Originally these came from src/seed-graph.sql:455-471 (and the edge at
-- :541). They're INSERT OR IGNORE so they no-op on a fresh install where
-- seed-graph.sql already ran with extracted_with='seed'; the UPDATE
-- retags below then take ownership. On a reinstall after a clean
-- uninstall (where the seed rows were also deleted), these recreate the
-- node so the migrate-ref-* INSERT INTO aspects don't fail FK.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-acorn-context', 'Acorn Client Context', 'reference',
  'How Acorn sessions map to a scoped project on the user''s machine and how to work within that client-side environment.',
  8, '{{plugin_id}}');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'scope', 9, '{{plugin_id}}');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope'),
         'Acorn sessions are bound to a specific project CWD on the user''s machine. Stay inside that project unless the user explicitly redirects you.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='scope')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope') AND content LIKE 'Acorn sessions are bound%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope'),
         'File reads, writes, edits, and execs are sandboxed to that client project path. Paths outside the assigned project are rejected.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='scope')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope') AND content LIKE 'File reads, writes%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope'),
         'Do NOT use /workspace or other container-local paths for Acorn project work. Those are server-side paths, not the user''s repo.',
         10, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='scope')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope') AND content LIKE 'Do NOT use /workspace%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope'),
         'When you mention files back to the user, use the client project path from the Acorn context or tool results, not a container path.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='scope')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='scope') AND content LIKE 'When you mention files%');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'workflow', 8, '{{plugin_id}}');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow'),
         'Acorn CLI and Acorn Companion connect to the same server runtime, but each session preserves its own project scope and local-machine context.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow') AND content LIKE 'Acorn CLI and Acorn Companion%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow'),
         'Use the normal coding tools inside that provided project scope. Keep replies concise and execution-focused.',
         8, 'seed', '{{plugin_id}}'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-acorn-context' AND name='workflow') AND content LIKE 'Use the normal coding tools%');

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-acorn-context', 'documents', 0.8, '{{plugin_id}}');

-- ── Backfill legacy seed-tagged rows ──────────────────────────────
UPDATE nodes
   SET extracted_with = '{{plugin_id}}'
 WHERE id = 'ref-acorn-context'
   AND extracted_with = 'seed';

UPDATE aspects
   SET extracted_with = '{{plugin_id}}'
 WHERE node_id = 'ref-acorn-context'
   AND extracted_with = 'seed';

UPDATE attributes
   SET extracted_with = '{{plugin_id}}'
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context')
   AND extracted_with = 'seed';

UPDATE edges
   SET extracted_with = '{{plugin_id}}'
 WHERE (source = 'ref-acorn-context' OR target = 'ref-acorn-context')
   AND extracted_with = 'seed';

-- ────────────────────────────────────────────────────────────────────
-- The 5 in-tree SQL files concatenated and retagged below. Original
-- semantics preserved: every INSERT remains idempotent via WHERE NOT
-- EXISTS or INSERT OR IGNORE; the only change is extracted_with's value.
-- ────────────────────────────────────────────────────────────────────


-- ── from migrate-ref-acorn-context.sql ──────────────────────────────────────
-- Refresh ref-acorn-context to reflect the projectContext refactor,
-- the /scope opt-out, the structured plan/execute mode, the QUESTIONS:
-- protocol, and client-side tool routing.
--
-- Idempotent: aspects/attributes are guarded by WHERE NOT EXISTS;
-- the existing "Paths outside the assigned project are rejected"
-- attribute is replaced with a /scope-aware version via UPDATE.
-- Re-running the file is a no-op after first apply.

-- 1. Patch the misleading "rejected" attribute on the existing scope aspect.
UPDATE attributes
   SET content = 'File reads, writes, edits, and execs are sandboxed to projectContext.cwd by default (scope=strict). When the user wants you to touch paths outside cwd (shared dotfiles, sibling repo, home dir), tell them to run /scope expanded — that lifts the cwd containment AND clears this sandbox warning from your prompt.',
       updated_at = CURRENT_TIMESTAMP
 WHERE id IN (
   SELECT a.id FROM attributes a
     JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'scope'
     AND a.content = 'File reads, writes, edits, and execs are sandboxed to that client project path. Paths outside the assigned project are rejected.'
 );

-- 2. Aspect: project_context (structured field shape)
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'project_context', 9, '{{plugin_id}}'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'Acorn sends a structured projectContext object on every chat turn — fields: cwd, project, mode, scope, gitBranch, gitHash, projectType, acornMd, tree, tools, OS, Arch. Routed into the system prompt''s Project Context section, NOT into messages[]. Don''t expect to find it in conversation history.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'Acorn sends a structured projectContext%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'projectContext.acornMd is the full ACORN.md from the user''s project (capped at 4KB). Read it for project-specific conventions, available scripts, naming patterns. If it''s missing, suggest /init to scaffold one.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'projectContext.acornMd%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'projectContext.tools lists detected build/runtime tools (e.g. ["go", "node", "git"]). Use these as a hint for which language ecosystem you''re in, but verify by reading actual project files before assuming.', 7, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'projectContext.tools%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'Per-(user, cwd) project nodes persist in the graph across sessions. Use graph_query to recall prior decisions, conventions, and discoveries from past acorn sessions in the same project.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'Per-(user, cwd) project nodes%');

-- 3. Aspect: mode (plan vs execute, QUESTIONS protocol, PLAN_READY marker)
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'mode', 9, '{{plugin_id}}'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'projectContext.mode is "plan" or "execute". In plan mode you MUST NOT call mutating tools (write_file, edit_file, exec, graph_update, etc.) — only read/search/query. Output the plan as prose and end with PLAN_READY on its own line; the user gets an approval modal.', 10, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'projectContext.mode is%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'Plan mode requires asking clarifying questions when material ambiguity exists. Emit them in the QUESTIONS: protocol — see the system prompt''s Plan Mode section for the exact format. JSON-fenced and prose forms are both accepted by the parser.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'Plan mode requires asking%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'On execute turns the plan-mode rules are gone and the full mutating toolset (write_file, edit_file, exec, etc.) is available. The acorn UI flips to execute mode automatically when the user approves the plan.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'On execute turns%');

-- 4. Aspect: client_routing (file ops forwarded to CLI, fallback semantics)
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'client_routing', 8, '{{plugin_id}}'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'For Acorn sessions, file ops (read_file, write_file, edit_file, exec, grep, glob) are FORWARDED to the user''s machine and executed by the CLI in-process. The "result" you see is what actually ran on their disk.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'For Acorn sessions, file ops%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'If the CLI disconnects mid-tool, the call falls back to the SPORE container — which means it would run against /workspace, NOT the user''s project. Watch for tool errors that mention container paths instead of project paths and pause to reconnect.', 7, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'If the CLI disconnects%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'Use grep/glob (native tools) instead of exec+grep/find for code search — structured results, no shell quoting issues. See ref-search-tools for caps and patterns.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'Use grep/glob%');

-- ── from migrate-ref-acorn-personas.sql ──────────────────────────────────────
-- Add the agentic-planning persona attribute to ref-acorn-context.mode
-- so the agent's graph_query for "plan mode" surfaces the delegate_task
-- pattern. Idempotent: WHERE NOT EXISTS guards re-running.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'For non-trivial plans, delegate parallel research with delegate_task({persona: "researcher", task: "..."}). The researcher persona has only web_search + web_fetch and returns a structured Findings/Caveats/Recommendation summary. Fan out 1-3 researchers per plan, wait for results, splice findings into the plan. Codebase reading stays in your own turns — sub-agents have no CLI bridge to the user''s files.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'For non-trivial plans, delegate parallel research%');

-- ── from migrate-ref-acorn-tool-usage.sql ──────────────────────────────────────
-- Three new attributes on ref-acorn-context.client_routing covering:
--   - "use the tools, you're on the user's machine" (counters the
--      remote-chatbot default, captured failure 2026-04-24)
--   - "no exec find / exec ls -laR" (3-min timeout on node-modules-heavy
--      projects, user-reported)
--   - "filter noise dirs from your output even if a tool returned them"
--
-- These also live in the runtime prompt block (prompt-sections.js), but
-- duplicating them here means: (a) they survive a graph reset, (b) they
-- surface when the agent does a graph_query for "how do I describe this
-- project" or "is the dev server up". Idempotent — guarded by content
-- LIKE checks.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'When the user asks about local state — "is the dev server up", "what''s in this file", "why is X slow", "did the build finish", "is port N open" — RUN THE TOOLS (exec, read_file, grep) and answer with the actual result. Do NOT respond like a remote chatbot ("I can''t see your machine, here''s how you could check"). For acorn sessions you ARE on the user''s box; behave like it.', 10, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'When the user asks about local state%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'For project-wide listings, NEVER use exec ls -laR / exec find / exec tree — they walk node_modules and hit the 3-minute tool timeout. Use the glob tool (auto-skips noise dirs, capped at 500 paths) or read the Project Tree from the system prompt.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'For project-wide listings, NEVER use exec ls%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'When showing exec output / describing a project, FILTER noise dirs from your reply even if the tool returned them. Suppress: .git, node_modules, .venv, venv, __pycache__, dist, build, target, .next, .cache, .acorn, vendor, .gradle, .mvn, .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .nuxt, .svelte-kit, .terraform, .idea, .vscode, *.egg-info, coverage, .nyc_output, .DS_Store. The user does not want to see node_modules in chat.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'When showing exec output / describing a project, FILTER noise dirs%');

-- ── from migrate-ref-acorn-tooling-questions.sql ──────────────────────────────────────
-- Add the "ask about tooling choices" attribute to ref-acorn-context.mode.
-- Idempotent retrofit so existing graphs pick it up on next boot.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'In plan mode, ALWAYS ask about tooling choices the user might care about: language/runtime, framework, package manager, build tool, test runner, linter/formatter, type system, styling, database/ORM, auth, deployment target, state management. Skip a category only when the project doesn''t need it OR when the existing codebase already commits to a choice (check package.json, go.mod, pyproject.toml, etc. before asking).', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'In plan mode, ALWAYS ask about tooling choices%');

-- ── from migrate-ref-graphcorn-discovery.sql ──────────────────────────────────────
-- graphcorn: add discovery_workflow aspect to ref-acorn-context covering
-- when/how to call note_discovery vs graph_update and how the session
-- node anchors knowledge written during a conversation. Idempotent —
-- WHERE NOT EXISTS guards on the aspect + each attribute.

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'discovery_workflow', 9, '{{plugin_id}}'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'graphcorn — every acorn launch creates a `session-<id>` node at connect time (BEFORE the first chat:submit) with edges to the `project-<userId-cwdHash>` node. All knowledge captured during the conversation anchors here: learner-extracted entities get a `discovered_in` edge automatically; agent-written discoveries (via note_discovery / graph_update) get a `recorded_in` edge.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'graphcorn — every acorn launch%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'When you learn something durable during an acorn session — a config that worked, a tool quirk, a fix for a tricky failure, a port number, a CLI flag — call `note_discovery({text: "...", kind: "fact|gotcha|workflow|config|failure_fix"})`. The wrapper creates a properly-structured `discovery` node and links it to the session AND project nodes for free. Casual save, lower friction than graph_update.', 9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'When you learn something durable during an acorn session%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Use `graph_update` directly (not note_discovery) when you need full schema control — a non-default node type (project, person, system), multiple aspects with different importances, explicit `relates_to` edges to specific other nodes. note_discovery is the casual save; graph_update is the structured save. Both link properly to the session if called inside an acorn turn.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'Use `graph_update` directly%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Don''t wait for the learner. The learner runs after every assistant turn and extracts what its heuristics rank as important, but it doesn''t know which facts mattered TO YOU. If you noticed that the React Native bundler defaults to port 8081 and that surprised you, save it explicitly — don''t hope the learner picks it up. Cost is negligible (one INSERT + 2-3 edges); benefit is a deterministic, durable record.', 8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'Don''t wait for the learner%');
