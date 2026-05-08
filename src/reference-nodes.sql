-- Reference Knowledge Nodes
-- Injected into every agent's graph so critical operational info
-- is immediately available without skill lookups.
--
-- Uses INSERT OR IGNORE so it's safe to run multiple times.


-- ═══════════════════════════════════════════════════════════════
-- NODE: API Keys & Environment
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-api-keys', 'API Keys & Environment', 'reference',
  'How to access API keys, env vars, and filesystem paths inside the container.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'access_patterns', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'API keys live in the secure vault on the manager — encrypted at rest, never in plain .env files', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use env_manage action:"vault_list" to see available keys. Use web_fetch with credential:"KEY_NAME" for authenticated API calls (key injected server-side, never exposed)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For scripts needing a raw key: env_manage action:"vault_get" key="X" — writes to a temp file that auto-deletes in 5 minutes', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'web_serve action:"backend" auto-injects ALL vault keys as env vars in your backend process — no vault_get needed for backends', 9, 'seed', 'seed');

-- Core keys only. Plugin-installed providers (FLUX, ElevenLabs,
-- Deepgram, etc.) append their own *_API_KEY rows to this aspect via
-- their plugin install.sql so the catalog grows with the install set.
INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'available_keys', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'OPENAI_API_KEY — OpenAI', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SEARXNG_URL — Primary web search (self-hosted metasearch). Set to base URL, e.g. http://searxng:8080', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'BRAVE_API_KEY — Fallback web search. Used when SearXNG is unset or returns nothing.', 6, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'filesystem_paths', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '/workspace/ — persistent writable workspace (scripts, files, projects)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/workspace/web/ — publicly served at your web URL', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/data/ — config and databases (.env lives here)', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/app/ — Spore Core runtime (mostly read-only)', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Never log or print full API key values', 9, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Local Search Tools (grep + glob)
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-search-tools', 'Local Search Tools (grep + glob)', 'reference',
  'Native grep and glob tools for code search — preferred over exec+grep/find.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-search-tools', 'when_to_use', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'PREFER grep over exec+grep/awk/sed for any code search — returns structured {file, line, text} hits, no shell quoting pitfalls', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'PREFER glob over exec+find/ls for filename lookups — returns paths relative to the search root', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For Spore Code (CLI) sessions both tools execute on the user''s machine via the CLI; for web/telegram/etc. they run server-side over /workspace', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-search-tools', 'caps_and_filters', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'grep result cap: 200 hits, line text truncated at 200 chars. If truncated, narrow the pattern or set a glob.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'glob result cap: 500 paths. Tighten the pattern or use a deeper path if hit.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Both tools auto-skip noise dirs: .git, node_modules, dist, build, __pycache__, .venv, venv, target, .next, .cache. Hidden dirs (any starting with .) are also skipped.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'grep: pattern uses RE2 syntax (no lookahead/backrefs). glob param filters which filenames are scanned (e.g. glob:"*.go"). -i:true for case-insensitive.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-search-tools', 'workflow_pattern', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Start broad (e.g. "late|delay(ed)?"), look at the {file, line, text} hits, then refine with a glob filter or tighter pattern instead of paginating.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Pair with read_file: grep to find the relevant file:line, then read_file with offset/limit to inspect surrounding context.', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Web Search & Fetch (web_search + web_fetch)
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-web-search', 'Web Search & Fetch (web_search + web_fetch)', 'reference',
  'Live-web information retrieval — web_search returns ranked results, web_fetch reads a specific URL. Routes through SearXNG (primary) with Brave fallback.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'when_to_use', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'USE web_search whenever the answer depends on current information — library versions, framework docs, API changes, recent events, error messages you have not seen before, "what is the latest", "what does X do", "is X deprecated". Your training data is stale; the web is not.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'USE web_fetch when you ALREADY have a URL (returned by web_search, mentioned by the user, or referenced from a file you read) and you want the page content. Do NOT web_search for a URL you already know — just web_fetch it.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SKIP web_search for facts that are stable and inside your training (basic syntax, well-known algorithms, math). Burning a tool call on those is wasteful.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SKIP web_search inside a `delegate_task({persona: "researcher", ...})` — the researcher persona has only web_search + web_fetch; if you are the researcher you should use them, but if you are the orchestrator, delegate parallel research instead of serial searches yourself.', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'workflow_pattern', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Standard pattern: `web_search` broad → look at the top 5-10 results → pick 1-3 most authoritative URLs → `web_fetch` each. Don''t fetch all 10; pick the official docs / primary sources.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Always include the current year in queries about recent topics ("expo router 2026", "React Native 0.76 breaking changes"). Without a year, search engines often return stale results from prior years that look authoritative but aren''t.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use site: filters for known trustworthy domains: `site:docs.expo.dev`, `site:github.com`, `site:stackoverflow.com`. Filters out SEO-spam blog posts that copy real docs out-of-date.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For error messages, search the EXACT error string in quotes — `"TypeError: Cannot read properties of undefined" expo router`. The quotes pin the search to actual occurrences.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Authenticated APIs: `web_fetch({url: "...", credential: "BRAVE_API_KEY", method: "POST", body: {...}})` injects the vault key server-side without exposing it. The credential parameter is the vault key NAME (see ref-api-keys for the catalog).', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'output_format', 7, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'web_search returns a list of {title, url, snippet} objects. Snippets are usually 1-2 sentences — use them to decide which URLs to fetch, not as the answer itself. Result count is capped (typically 10).', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'web_fetch returns the page content, capped at 30,000 chars. For longer pages, fetch a more specific URL (anchor / sub-page) rather than asking the same URL repeatedly. PDFs, JSON, and HTML are all supported.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When citing a fact you got from the web, always include the source URL in your reply so the user can verify. Format: "Per <url>: <fact>" — keeps you honest and the user able to double-check.', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'backend', 6, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Primary backend: SearXNG self-hosted metasearch (set via SEARXNG_URL env). Fallback: Brave Search API (BRAVE_API_KEY). If web_search returns nothing useful, that''s usually a real "no good results" signal — not a backend problem. Log lines tell which backend served the query.', 7, 'seed', 'seed');


-- ref-bfl-api (FLUX) lives in plugins/flux/sql/install.sql.
-- ref-elevenlabs-api lives in plugins/elevenlabs/sql/install.sql.
-- Both are seeded only when the corresponding plugin is installed,
-- and swept on uninstall via extracted_with tag.


-- ═══════════════════════════════════════════════════════════════
-- NODE: Web Server & Routing
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-web-architecture', 'Web Server & Routing', 'reference',
  'How the built-in web server works, port rules, routing, and the user-app proxy.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-architecture', 'routing', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Request flow: Browser -> Traefik (strips /spores/{id} prefix) -> container port (SPORE_WEB_PORT, typically 18800)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Route priority: /graph -> /api/* system routes -> user app proxy -> static files from /workspace/web/', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'web_serve tool serves static files from /workspace/web/ — files written there are live immediately', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/graph is the control panel — served automatically by the built-in server', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-architecture', 'user_app_proxy', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use web_serve action:"backend" command:"node server.js" — it allocates a port, injects vault keys, proxies routes, and persists across restarts automatically', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'The web gateway proxies /api/* and any non-file routes to your backend automatically', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Backend gets APP_PORT and PORT env vars — listen on that port, not a hardcoded one', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Frontend MUST use relative fetch paths: fetch(''api/endpoint'') with credentials:''include''. NEVER use absolute paths like fetch(''/api/endpoint'') — Traefik prefix stripping makes them fail', 10, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-architecture', 'critical_rules', 10, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'NEVER run Express or any server on the SPORE_WEB_PORT — it replaces the built-in server and breaks /graph and all system routes', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use a DIFFERENT port for custom backends (3001, 3002, etc.) and set /workspace/.app-port', 9, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Displaying Images in Chat
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-image-display', 'Displaying Images in Chat', 'reference',
  'How to render images inline in the web control panel.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-image-display', 'how_to', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use standard markdown: ![description](https://image-url.com/image.png)', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'The control panel renders markdown images inline — marked + DOMPurify with img allowed', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Bare URLs are also auto-detected and rendered, but markdown syntax is cleaner', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'In web chat, reply with `/workspace/<file>` paths for images, video, audio, or files; the UI rewrites them to the current origin and renders/links them inline.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Prefer `/workspace/<filename>` in web chat. Use absolute URLs only when sharing a link meant to be opened outside the current chat.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'User uploads are saved under `/workspace/uploads`; analyze_media can auto-detect image/audio/video when the user means an uploaded attachment.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/workspace/web/ is for standalone hosted files/pages; outside web chat, use the public URL for those files.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Do NOT use message_send with filePath for web UI — that only works on Discord/Telegram', 8, 'seed', 'seed');


-- ref-browser-automation now lives in the browser-core plugin
-- (plugins/browser-core/sql/install.sql); it's installed on plugin
-- load and removed on uninstall. Backend-specific aspects (zendriver
-- stealth, playwright debugging) come from the corresponding backend
-- plugins. So uninstalling a backend cleanly drops just its docs.


-- ═══════════════════════════════════════════════════════════════
-- NODE: Spore Code Client Context
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-spore-code-context', 'Spore Code Client Context', 'reference',
  'How Spore Code sessions map to a scoped project on the user''s machine and how to work within that client-side environment.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-spore-code-context', 'scope', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Spore Code sessions are bound to a specific project CWD on the user''s machine. Stay inside that project unless the user explicitly redirects you.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'File reads, writes, edits, and execs are sandboxed to projectContext.cwd by default (scope=strict). When the user wants you to touch paths outside cwd (shared dotfiles, sibling repo, home dir), tell them to run /scope expanded — that lifts the cwd containment AND clears this sandbox warning from your prompt.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Do NOT use /workspace or other container-local paths for Spore Code project work. Those are server-side paths, not the user''s repo.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When you mention files back to the user, use the client project path from the Spore Code context or tool results, not a container path.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-spore-code-context', 'workflow', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Spore Code and Spore Go connect to the same server runtime, but each session preserves its own project scope and local-machine context.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use the normal coding tools inside that provided project scope. Keep replies concise and execution-focused.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-spore-code-context', 'project_context', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Spore Code sends a structured projectContext object on every chat turn — fields: cwd, project, mode, scope, gitBranch, gitHash, projectType, sporeMd, tree, tools, OS, Arch. Routed into the system prompt''s Project Context section, NOT into messages[]. Don''t expect to find it in conversation history.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'projectContext.sporeMd is the full SPORE.md from the user''s project (capped at 4KB). Read it for project-specific conventions, available scripts, naming patterns. If it''s missing, suggest /init to scaffold one.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'projectContext.tools lists detected build/runtime tools (e.g. ["go", "node", "git"]). Use these as a hint for which language ecosystem you''re in, but verify by reading actual project files before assuming.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Per-(user, cwd) project nodes persist in the graph across sessions. Use graph_query to recall prior decisions, conventions, and discoveries from past Spore Code sessions in the same project.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-spore-code-context', 'mode', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'projectContext.mode is "plan" or "execute". In plan mode you MUST NOT call mutating tools (write_file, edit_file, exec, graph_update, etc.) — only read/search/query. Output the plan as prose and end with PLAN_READY on its own line; the user gets an approval modal.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Plan mode requires asking clarifying questions when material ambiguity exists. Emit them in the QUESTIONS: protocol, not ask_user; JSON-fenced and prose forms are both accepted by the parser. If the user already gave free-form feedback, incorporate it directly.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'On execute turns the plan-mode rules are gone and the full mutating toolset (write_file, edit_file, exec, etc.) is available. The Spore Code UI flips to execute mode automatically when the user approves the plan.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For non-trivial plans, delegate parallel research with delegate_task({persona: "researcher", task: "..."}). The researcher persona has only web_search + web_fetch and returns a structured Findings/Caveats/Recommendation summary. Fan out 1-3 researchers per plan, wait for results, splice findings into the plan. Codebase reading stays in your own turns — sub-agents have no CLI bridge to the user''s files.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'In plan mode, ALWAYS ask about tooling choices the user might care about: language/runtime, framework, package manager, build tool, test runner, linter/formatter, type system, styling, database/ORM, auth, deployment target, state management. Skip a category only when the project doesn''t need it OR when the existing codebase already commits to a choice (check package.json, go.mod, pyproject.toml, etc. before asking).', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-spore-code-context', 'client_routing', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'For Spore Code sessions, file ops (read_file, write_file, edit_file, exec, grep, glob) are FORWARDED to the user''s machine and executed by the CLI in-process. The "result" you see is what actually ran on their disk.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'If the CLI disconnects mid-tool, the call falls back to the Spore Core container — which means it would run against /workspace, NOT the user''s project. Watch for tool errors that mention container paths instead of project paths and pause to reconnect.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use grep/glob (native tools) instead of exec+grep/find for code search — structured results, no shell quoting issues. See ref-search-tools for caps and patterns.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When the user asks about local state — "is the dev server up", "what''s in this file", "why is X slow", "did the build finish", "is port N open" — RUN THE TOOLS (exec, read_file, grep) and answer with the actual result. Do NOT respond like a remote chatbot ("I can''t see your machine, here''s how you could check"). For Spore Code sessions you ARE on the user''s box; behave like it.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For project-wide listings, NEVER use exec ls -laR / exec find / exec tree — they walk node_modules and hit the 3-minute tool timeout. Use the glob tool (auto-skips noise dirs, capped at 500 paths) or read the Project Tree from the system prompt.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When showing exec output / describing a project, FILTER noise dirs from your reply even if the tool returned them. Suppress: .git, node_modules, .venv, venv, __pycache__, dist, build, target, .next, .cache, .spore-code, vendor, .gradle, .mvn, .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .nuxt, .svelte-kit, .terraform, .idea, .vscode, *.egg-info, coverage, .nyc_output, .DS_Store. The user does not want to see node_modules in chat.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For things you CAN''T learn from the user''s machine — current library versions, framework docs, error messages you''ve never seen, "is X deprecated", recent breaking changes — use `web_search` (then `web_fetch` the best 1-3 results). Don''t guess from training data; the web is more current. See ref-web-search for caps + workflow patterns.', 9, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Cron & Startup Tasks
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-cron-runtime', 'Cron & Startup Tasks', 'reference',
  'How scheduled jobs and persistent background tasks work inside the container runtime.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-cron-runtime', 'cron', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use plain cron to ensure the daemon is running and crontab to manage jobs.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'NEVER use /etc/init.d/cron start, service cron start, or /usr/sbin/cron directly. Those bypass the wrapper and can fail with pidfile permission errors.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Crontabs persist under /workspace/.crontabs and are restored automatically when the container boots.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Cron starts automatically on boot unless SPORE_ENABLE_CRON=false.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use absolute paths and redirect output in cron entries because jobs run non-interactively.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Cron and background jobs can notify the operator by POSTing JSON to http://127.0.0.1:${SPORE_WEB_PORT:-18803}/api/proactive/trigger with {"source":"cron","message":"..."}. Loopback calls are accepted without auth; external callers must pass normal web auth.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use proactive trigger mode:"agent" only when the notification should start an agent turn. Omit mode, or set mode:"notify", for cheap operator notifications.', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-cron-runtime', 'startup_tasks', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use startup_tasks for long-running collectors, watchers, and servers that must survive container restarts.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use cron for scheduled triggers; use startup_tasks for persistent daemons. They solve different problems.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'startup_tasks stores its registry in /data/.startup-tasks.json and replays it after boot.', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Tool Workflows
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-tool-workflows', 'Tool Workflows', 'reference',
  'Operational patterns for choosing tools, asking the operator, waiting, tracking work, and avoiding waste.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tool-workflows', 'tool_selection', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use edit_file for modifications to existing files; use write_file only for brand-new files. Rewriting whole files wastes time and risks losing unrelated edits.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use exec only for scripts, package commands, git, or shell commands with no dedicated tool. Prefer native read_file/grep/glob/web_fetch/graph tools when they exist.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use startup_tasks for long-running processes that must survive restarts; use cron for scheduled triggers. Do not use raw nohup for persistent services.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'In the web panel, read_file/write_file/edit_file automatically create code-viewer tabs; use file tools normally and do not build a custom viewer.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use graph_update for deliberate corrections or explicit knowledge persistence. Learning already happens automatically, so do not duplicate every ordinary conversation turn.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tool-workflows', 'efficiency', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Plan → execute → verify. Pick the most likely path, try it, and fall back only on failure.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Sequential by default. Parallelize only when results are truly independent and all branches are needed; do not shotgun tool calls.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Check before installing: `which <cmd>` or `pip list | grep <pkg>`. Never install the same package multiple ways in parallel.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Each tool call costs tokens and time. Fewer targeted calls beat many speculative calls.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Keep tool use lean: do not re-read files or docs you just used, do not refetch stable facts, and delegate genuinely heavy independent work.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tool-workflows', 'asking_waiting_tracking', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'ask_user is available in web and Spore Code CLI sessions for one blocking modal question: type="single" returns one selected label, type="multi" returns selected labels, and type="open" returns short free text. Use normal reply text for broad interviews or non-modal channels.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'CLI QUESTIONS protocol is for Spore Code plan-mode interviews, not the ask_user tool: single-select uses `[opt1 / opt2]`, multi-select uses `{opt1 / opt2}`, and open-ended questions omit brackets. The user answer arrives as a follow-up message. Free-form plan feedback should be incorporated directly, not forced into a picker.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use schedule_wakeup for known waits such as deploy settling, job start delays, or rate-limit cooldowns. It releases the session and re-enters later instead of sleeping in a loop.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Never poll delegated tasks with task_status + sleep. If delegated tasks are running and no other work remains, end the turn; task_complete re-enters automatically.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use delegate_task for sub-agent work, spore_message for a configured multi-spore mesh, and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use task_create/task_progress/task_list for jobs spanning more than one back-and-forth. Tasks survive restarts and blockers hide dependent tasks until resolved.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use log_watch for continuous local log visibility while a process runs; use tight regex because every match becomes an interjection.', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: SSH & Remote Access
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-ssh-remote', 'SSH & Remote Access', 'reference',
  'SSH remote execution, file transfer, and port tunneling capabilities.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'capability_overview', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'You have full SSH capabilities: remote command execution, SFTP file read/write, and port tunneling', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Tools: remote_exec, remote_read_file, remote_write_file, ssh_tunnel — these appear once SSH hosts are configured', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SSH hosts are added by the user in the control panel terminal tab (Manage Hosts button)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'If a user asks about SSH and no hosts are configured yet, tell them to add a host via the terminal tab in the control panel', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'remote_exec_usage', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'remote_exec: run shell commands on remote hosts — takes host ID, command, optional workdir and timeout', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Returns stdout, stderr, and exit code — same ergonomics as the local exec tool', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Default timeout 30s, max 120s — use delegate_task for long-running remote jobs', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'sftp_usage', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'remote_read_file: read remote files via SFTP — supports offset/limit for partial reads', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'remote_write_file: create or overwrite remote files via SFTP — supports append mode', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Max write size: 10MB per operation', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'tunnel_usage', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'ssh_tunnel: forward remote ports to local — enables access to remote services (Jupyter, TensorBoard, inference servers)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Actions: create (new tunnel), close (by local port), list (show active tunnels)', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Local ports auto-assigned in range 19000-19999 unless specified', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Max 5 active tunnels per agent — tunnels auto-close when SSH connection drops', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Tunneled services accessible via the web proxy at /ws/app or via .app-port for HTTP backends', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'security', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'SSH private keys are encrypted at rest (AES-256-GCM) — the keystore must be unlocked before adding or using hosts', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For password-auth users: keystore auto-unlocks from the login password. For OAuth users: a keystore passphrase must be entered in the terminal tab (held in memory only, never stored)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Tunnels are restricted to remoteHost=localhost only — no pivoting to internal networks', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Never log, print, or share SSH private keys or passphrases', 10, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- EDGES: Connect reference nodes to spore system node
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-api-keys', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-api-keys');
-- spore -> ref-bfl-api edge lives in plugins/flux/sql/install.sql.
-- spore -> ref-elevenlabs-api edge lives in plugins/elevenlabs/sql/install.sql.
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-web-architecture', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-web-architecture');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-image-display', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-image-display');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-browser-automation', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-browser-automation');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-spore-code-context', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-spore-code-context');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-tool-workflows', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-tool-workflows');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-cron-runtime', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-cron-runtime');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-ssh-remote', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-ssh-remote');
