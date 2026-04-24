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
SELECT 'ref-acorn-context', 'project_context', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'Acorn sends a structured projectContext object on every chat turn — fields: cwd, project, mode, scope, gitBranch, gitHash, projectType, acornMd, tree, tools, OS, Arch. Routed into the system prompt''s Project Context section, NOT into messages[]. Don''t expect to find it in conversation history.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'Acorn sends a structured projectContext%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'projectContext.acornMd is the full ACORN.md from the user''s project (capped at 4KB). Read it for project-specific conventions, available scripts, naming patterns. If it''s missing, suggest /init to scaffold one.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'projectContext.acornMd%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'projectContext.tools lists detected build/runtime tools (e.g. ["go", "node", "git"]). Use these as a hint for which language ecosystem you''re in, but verify by reading actual project files before assuming.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'projectContext.tools%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'project_context'),
       'Per-(user, cwd) project nodes persist in the graph across sessions. Use graph_query to recall prior decisions, conventions, and discoveries from past acorn sessions in the same project.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'project_context' AND a.content LIKE 'Per-(user, cwd) project nodes%');

-- 3. Aspect: mode (plan vs execute, QUESTIONS protocol, PLAN_READY marker)
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'mode', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'projectContext.mode is "plan" or "execute". In plan mode you MUST NOT call mutating tools (write_file, edit_file, exec, graph_update, etc.) — only read/search/query. Output the plan as prose and end with PLAN_READY on its own line; the user gets an approval modal.', 10, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'projectContext.mode is%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'Plan mode requires asking clarifying questions when material ambiguity exists. Emit them in the QUESTIONS: protocol — see the system prompt''s Plan Mode section for the exact format. JSON-fenced and prose forms are both accepted by the parser.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'Plan mode requires asking%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'mode'),
       'On execute turns the plan-mode rules are gone and the full mutating toolset (write_file, edit_file, exec, etc.) is available. The acorn UI flips to execute mode automatically when the user approves the plan.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'mode' AND a.content LIKE 'On execute turns%');

-- 4. Aspect: client_routing (file ops forwarded to CLI, fallback semantics)
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'client_routing', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'For Acorn sessions, file ops (read_file, write_file, edit_file, exec, grep, glob) are FORWARDED to the user''s machine and executed by the CLI in-process. The "result" you see is what actually ran on their disk.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'For Acorn sessions, file ops%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'If the CLI disconnects mid-tool, the call falls back to the SPORE container — which means it would run against /workspace, NOT the user''s project. Watch for tool errors that mention container paths instead of project paths and pause to reconnect.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'If the CLI disconnects%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'client_routing'),
       'Use grep/glob (native tools) instead of exec+grep/find for code search — structured results, no shell quoting issues. See ref-search-tools for caps and patterns.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'client_routing' AND a.content LIKE 'Use grep/glob%');
