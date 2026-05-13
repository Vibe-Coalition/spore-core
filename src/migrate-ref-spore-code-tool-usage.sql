-- Three new attributes on ref-spore-code-context.client_routing covering:
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
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'client_routing'),
       'When the user asks about local state — "is the dev server up", "what''s in this file", "why is X slow", "did the build finish", "is port N open" — RUN THE TOOLS (exec, read_file, grep) and answer with the actual result. Do NOT respond like a remote chatbot ("I can''t see your machine, here''s how you could check"). For Spore Code sessions you ARE on the user''s box; behave like it.', 10, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'client_routing' AND a.content LIKE 'When the user asks about local state%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'client_routing'),
       'For project-wide listings, NEVER use exec ls -laR / exec find / exec tree — they walk node_modules and hit the 3-minute tool timeout. Use the glob tool (auto-skips noise dirs, capped at 500 paths) or read the Project Tree from the system prompt.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'client_routing' AND a.content LIKE 'For project-wide listings, NEVER use exec ls%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'client_routing'),
       'When showing exec output / describing a project, FILTER noise dirs from your reply even if the tool returned them. Suppress: .git, node_modules, .venv, venv, __pycache__, dist, build, target, .next, .cache, .spore-code, vendor, .gradle, .mvn, .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .nuxt, .svelte-kit, .terraform, .idea, .vscode, *.egg-info, coverage, .nyc_output, .DS_Store. The user does not want to see node_modules in chat.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'client_routing' AND a.content LIKE 'When showing exec output / describing a project, FILTER noise dirs%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'client_routing'),
       'If a package install or credential operation is blocked by a tool, do not route around it with curl/manual package downloads, alternate package managers, vendored code, or expect/pexpect/sshpass password scripts. Stop, report the exact blocker, and ask for a safer package, key-based credential setup, sidecar/saved-host config, or manual operator action.', 10, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'client_routing' AND a.content LIKE 'If a package install or credential operation is blocked by a tool%');
