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

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'available_keys', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'BFL_API_KEY — FLUX image generation (api.bfl.ai)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'XI_API_KEY — ElevenLabs TTS and sound effects', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'DEEPGRAM_API_KEY — Deepgram speech-to-text', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'OPENAI_API_KEY — OpenAI', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SEARXNG_URL — Primary web search (self-hosted metasearch). Set to base URL, e.g. http://searxng:8080', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'BRAVE_API_KEY — Fallback web search. Used when SearXNG is unset or returns nothing.', 6, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'filesystem_paths', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '/workspace/ — persistent writable workspace (scripts, files, projects)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/workspace/web/ — publicly served at your web URL', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/data/ — config and databases (.env lives here)', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/app/ — SPORE runtime (mostly read-only)', 7, 'seed', 'seed'),
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
  ((SELECT MAX(id) FROM aspects), 'For acorn (CLI) sessions both tools execute on the user''s machine via the CLI; for web/telegram/etc. they run server-side over /workspace', 7, 'seed', 'seed');

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
  ((SELECT MAX(id) FROM aspects), 'Authenticated APIs: `web_fetch({url: "...", credential: "BFL_API_KEY", method: "POST", body: {...}})` injects the vault key server-side without exposing it. The credential parameter is the vault key NAME (see ref-api-keys for the catalog).', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'output_format', 7, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'web_search returns a list of {title, url, snippet} objects. Snippets are usually 1-2 sentences — use them to decide which URLs to fetch, not as the answer itself. Result count is capped (typically 10).', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'web_fetch returns the page content, capped at 30,000 chars. For longer pages, fetch a more specific URL (anchor / sub-page) rather than asking the same URL repeatedly. PDFs, JSON, and HTML are all supported.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When citing a fact you got from the web, always include the source URL in your reply so the user can verify. Format: "Per <url>: <fact>" — keeps you honest and the user able to double-check.', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-web-search', 'backend', 6, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Primary backend: SearXNG self-hosted metasearch (set via SEARXNG_URL env). Fallback: Brave Search API (BRAVE_API_KEY). If web_search returns nothing useful, that''s usually a real "no good results" signal — not a backend problem. Log lines tell which backend served the query.', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: FLUX Image Generation
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-bfl-api', 'FLUX Image Generation', 'reference',
  'FLUX API for image generation and editing (api.bfl.ai).', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'essentials', 10, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Domain: api.bfl.ai — NOT api.bfl.ml (that hangs)', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Auth header: X-Key: YOUR_BFL_API_KEY (not Bearer)', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Default model: flux-2-pro-preview (use for everything unless told otherwise)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Other models: flux-kontext-pro, flux-kontext-max, flux-pro-1.1, flux-2-pro', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Submit: POST https://api.bfl.ai/v1/{model} with JSON body', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Response has polling_url — ALWAYS use it (may point to regional node like api.us2.bfl.ai)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Poll the polling_url with X-Key header until status="Ready"', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Image URL at result.sample — NOT result.url or result.image_url', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Signed URLs expire ~1hr — download or display promptly', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'parameters', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Required: prompt (string)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Optional: width, height, output_format ("jpeg" or "png"), seed', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Image editing: add input_image param (URL, raw base64, or data URI all work)', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Edit prompts: describe what CHANGED, not the full scene ("She is now holding X" not "A woman standing...")', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Typical generation: 5-15 seconds. Poll every 3s, timeout at 60s.', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'display_rule', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Always show generated images inline in chat: ![description](result.sample URL)', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Do NOT just report a file path — the user wants to SEE the image', 9, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: ElevenLabs TTS & Sound Effects
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-elevenlabs-api', 'ElevenLabs TTS & Sound Effects', 'reference',
  'ElevenLabs API for text-to-speech and sound effect generation.', 7, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-elevenlabs-api', 'essentials', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Auth header: xi-api-key: YOUR_XI_API_KEY', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'TTS: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id} — returns audio bytes directly (no polling)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SFX: POST https://api.elevenlabs.io/v1/sound-generation with {text, duration_seconds} — returns audio directly', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Best model: eleven_multilingual_v2', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'List voices: GET https://api.elevenlabs.io/v1/voices', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Voice settings: stability (0.3-0.5 for narration), similarity_boost (0.7-0.9), style (0.5-0.7), use_speaker_boost: true', 7, 'seed', 'seed');


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
  ((SELECT MAX(id) FROM aspects), 'Images in /workspace/web/ are served at your public URL — reference them by URL not file path', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Do NOT use message_send with filePath for web UI — that only works on Discord/Telegram', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Browser Automation
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-browser-automation', 'Browser Automation (Zendriver Default)', 'reference',
  'How to use the built-in browser tool. Zendriver is the default backend; Playwright remains available as an explicit opt-in backend.', 7, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-browser-automation', 'setup', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Zendriver is installed in the image and is the default backend for the built-in browser tool.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Launch the browser tool without specifying a backend to get Zendriver by default.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Playwright/Chromium remain available as an explicit opt-in backend when needed.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'The browser tool persists across calls, streams the preview panel, and browser.screenshot now returns a real filePath you can send back to the user.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-browser-automation', 'usage', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use browser action="launch" url="..." to start a persistent Zendriver session.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Actions: launch, navigate, click, type, scroll, screenshot, evaluate, close, status.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Set backend="playwright" only when you explicitly need the Playwright path.', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Acorn Client Context
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-acorn-context', 'Acorn Client Context', 'reference',
  'How Acorn sessions map to a scoped project on the user''s machine and how to work within that client-side environment.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'scope', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Acorn sessions are bound to a specific project CWD on the user''s machine. Stay inside that project unless the user explicitly redirects you.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'File reads, writes, edits, and execs are sandboxed to projectContext.cwd by default (scope=strict). When the user wants you to touch paths outside cwd (shared dotfiles, sibling repo, home dir), tell them to run /scope expanded — that lifts the cwd containment AND clears this sandbox warning from your prompt.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Do NOT use /workspace or other container-local paths for Acorn project work. Those are server-side paths, not the user''s repo.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When you mention files back to the user, use the client project path from the Acorn context or tool results, not a container path.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'workflow', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Acorn CLI and Acorn Companion connect to the same server runtime, but each session preserves its own project scope and local-machine context.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use the normal coding tools inside that provided project scope. Keep replies concise and execution-focused.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'project_context', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Acorn sends a structured projectContext object on every chat turn — fields: cwd, project, mode, scope, gitBranch, gitHash, projectType, acornMd, tree, tools, OS, Arch. Routed into the system prompt''s Project Context section, NOT into messages[]. Don''t expect to find it in conversation history.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'projectContext.acornMd is the full ACORN.md from the user''s project (capped at 4KB). Read it for project-specific conventions, available scripts, naming patterns. If it''s missing, suggest /init to scaffold one.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'projectContext.tools lists detected build/runtime tools (e.g. ["go", "node", "git"]). Use these as a hint for which language ecosystem you''re in, but verify by reading actual project files before assuming.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Per-(user, cwd) project nodes persist in the graph across sessions. Use graph_query to recall prior decisions, conventions, and discoveries from past acorn sessions in the same project.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'mode', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'projectContext.mode is "plan" or "execute". In plan mode you MUST NOT call mutating tools (write_file, edit_file, exec, graph_update, etc.) — only read/search/query. Output the plan as prose and end with PLAN_READY on its own line; the user gets an approval modal.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Plan mode requires asking clarifying questions when material ambiguity exists. Emit them in the QUESTIONS: protocol — see the system prompt''s Plan Mode section for the exact format. JSON-fenced and prose forms are both accepted by the parser.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'On execute turns the plan-mode rules are gone and the full mutating toolset (write_file, edit_file, exec, etc.) is available. The acorn UI flips to execute mode automatically when the user approves the plan.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For non-trivial plans, delegate parallel research with delegate_task({persona: "researcher", task: "..."}). The researcher persona has only web_search + web_fetch and returns a structured Findings/Caveats/Recommendation summary. Fan out 1-3 researchers per plan, wait for results, splice findings into the plan. Codebase reading stays in your own turns — sub-agents have no CLI bridge to the user''s files.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'In plan mode, ALWAYS ask about tooling choices the user might care about: language/runtime, framework, package manager, build tool, test runner, linter/formatter, type system, styling, database/ORM, auth, deployment target, state management. Skip a category only when the project doesn''t need it OR when the existing codebase already commits to a choice (check package.json, go.mod, pyproject.toml, etc. before asking).', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-acorn-context', 'client_routing', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'For Acorn sessions, file ops (read_file, write_file, edit_file, exec, grep, glob) are FORWARDED to the user''s machine and executed by the CLI in-process. The "result" you see is what actually ran on their disk.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'If the CLI disconnects mid-tool, the call falls back to the SPORE container — which means it would run against /workspace, NOT the user''s project. Watch for tool errors that mention container paths instead of project paths and pause to reconnect.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use grep/glob (native tools) instead of exec+grep/find for code search — structured results, no shell quoting issues. See ref-search-tools for caps and patterns.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When the user asks about local state — "is the dev server up", "what''s in this file", "why is X slow", "did the build finish", "is port N open" — RUN THE TOOLS (exec, read_file, grep) and answer with the actual result. Do NOT respond like a remote chatbot ("I can''t see your machine, here''s how you could check"). For acorn sessions you ARE on the user''s box; behave like it.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For project-wide listings, NEVER use exec ls -laR / exec find / exec tree — they walk node_modules and hit the 3-minute tool timeout. Use the glob tool (auto-skips noise dirs, capped at 500 paths) or read the Project Tree from the system prompt.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'When showing exec output / describing a project, FILTER noise dirs from your reply even if the tool returned them. Suppress: .git, node_modules, .venv, venv, __pycache__, dist, build, target, .next, .cache, .acorn, vendor, .gradle, .mvn, .pytest_cache, .mypy_cache, .ruff_cache, .turbo, .nuxt, .svelte-kit, .terraform, .idea, .vscode, *.egg-info, coverage, .nyc_output, .DS_Store. The user does not want to see node_modules in chat.', 9, 'seed', 'seed'),
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
  ((SELECT MAX(id) FROM aspects), 'Use absolute paths and redirect output in cron entries because jobs run non-interactively.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-cron-runtime', 'startup_tasks', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Use startup_tasks for long-running collectors, watchers, and servers that must survive container restarts.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use cron for scheduled triggers; use startup_tasks for persistent daemons. They solve different problems.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'startup_tasks stores its registry in /data/.startup-tasks.json and replays it after boot.', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Cross-Agent Messaging
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-cross-agent-messaging', 'Cross-Agent Messaging', 'reference',
  'Reliable messaging between agent instances using graph inbox nodes instead of ephemeral spore_message.', 7, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-cross-agent-messaging', 'pattern', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'spore_message is sync and ephemeral — if target is busy/offline, message vanishes', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Better: use a {name}-inbox node in each agent''s graph as a persistent message queue', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Message format: sender|ISO-timestamp|content|ack:bool|relayed:bool', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Send: graph_update target-inbox with new message attribute', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Receive: check your own inbox node at conversation start, mark ack:true when read', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Messages persist until explicitly deleted — works whether recipient is active or idle', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Token Efficiency
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-token-efficiency', 'Token Efficiency', 'reference',
  'Rules for keeping token usage low and being cost-effective.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-token-efficiency', 'rules', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Read a skill ONCE, cache the key facts in your graph, never re-fetch', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Don''t re-read files you just wrote', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Keep responses concise — long explanations burn output tokens for you and input tokens next turn', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use delegate_task for heavy work — runs in separate context', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Cache operational knowledge in your graph — don''t rely on re-fetching the same info every session', 9, 'seed', 'seed');


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
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-bfl-api', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-bfl-api');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-elevenlabs-api', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-elevenlabs-api');
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
  SELECT 'spore', 'ref-acorn-context', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-acorn-context');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-cross-agent-messaging', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-cross-agent-messaging');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-token-efficiency', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-token-efficiency');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-cron-runtime', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-cron-runtime');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-ssh-remote', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-ssh-remote');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Tailscale (private-tailnet access)
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-tailscale', 'Tailscale', 'reference',
  'Private-tailnet access from inside this container via the tailscaled daemon (userspace mode). Lets the agent reach the operators compute cluster and any other private peers without public IPs.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tailscale', 'overview', 10, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Tailscale runs a mesh WireGuard VPN; joining the tailnet gives this container private routing to every other member (compute nodes, operator workstations, etc.).', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'tailscaled runs in userspace-networking mode — no NET_ADMIN cap or /dev/net/tun required. State persists at /data/tailscale/ so login survives restart.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'SOCKS5 + HTTP proxy exposed on localhost:1055 for tools that need to tunnel through tailnet (rarely needed — direct dialing by hostname just works once connected).', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tailscale', 'connection_flow', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Login is interactive SSO via the Settings → Compute Cluster section in the web panel. Clicking "Log in to Tailscale" spawns `tailscale up` and surfaces the login URL; the operator opens it, signs in, done.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Once logged in, the daemon auto-reconnects on every container restart without human intervention.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'If the agent sees "not logged in" / "NeedsLogin", tell the operator to visit Settings → Compute Cluster and click Log in — do not try to start login yourself, the URL must be surfaced in the UI.', 9, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tailscale', 'cli_usage', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Socket path: /data/tailscale/ts.sock — always pass it when invoking the CLI: `tailscale --socket /data/tailscale/ts.sock <cmd>`.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '`tailscale --socket /data/tailscale/ts.sock status --json` → full peer list + your tailnet IP. Also available as GET /api/tailscale/status.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '`tailscale ssh user@peer` — shells into a tailnet peer without managing host keys (Tailscale SSH handles auth). Prefer this over raw ssh when peer is tailnet-only.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '`tailscale ip -4 <peer>` → tailnet IPv4 of a peer; `tailscale ping <peer>` → verify reachability and whether traffic is direct vs DERP-relayed.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tailscale', 'naming', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'MagicDNS format: <short-host>.<tailnet-name>.ts.net — the short hostname alone also works from tailnet members.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'This container registers as `${tailscaleHostname}` (default `spore-<agentId>`, set via Settings → Compute Cluster or SPORE_TAILSCALE_HOSTNAME env).', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-tailscale', 'troubleshooting', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '"NeedsLogin" / auth key expired → operator re-logs in via Settings → Compute Cluster. Do not prompt them with a raw URL; use the UI.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Peer offline → the peer itself has to be online and logged into the same tailnet; check `tailscale status` there.', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Socket permission errors → `/data/tailscale/ts.sock` must be owned by spore; entrypoint chowns it at boot. If it fails, restart the container.', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Compute cluster (SLURM, accessed over tailscale)
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-compute-cluster', 'Compute Cluster (SLURM)', 'reference',
  'The operator runs a private SLURM cluster (CPU + GPU nodes) reachable only over tailscale. The agent SSHs to the configured login host and submits jobs via sbatch / srun.', 10, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'overview', 10, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Cluster has CPU and GPU partitions managed by SLURM. Access path: tailscale connected → SSH to the login node using the configured cluster username → submit jobs from there.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'This container already has slurm-client binaries (sbatch/srun/squeue/scontrol/sinfo/sacct) for reference/man pages, but actual submissions go through SSH on the login node.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'settings_source', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Cluster username, login host, default SLURM partition, and tmux session prefix are all configured in the web panel: Settings → Compute Cluster. They read at runtime as config.clusterUsername, config.clusterLoginHost, config.clusterDefaultPartition, config.clusterTmuxPrefix.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Before any cluster work, check those settings are populated; if empty, tell the operator to fill them in — do not guess.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'The login host is a tailnet MagicDNS name (e.g. "login.<tailnet>.ts.net" or just "login"); it only resolves when tailscale is connected.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'access_flow', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Step 1: verify tailscale is connected (GET /api/tailscale/status backend=Running). Step 2: add the login host as an SSH host (terminal tab → Manage Hosts) using the cluster username and the users SSH key. Step 3: use remote_exec to run slurm commands from the login node.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For quick sanity checks, POST /api/cluster/test-ssh runs `hostname && which sbatch && sinfo --version` to confirm the full path is up.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'slurm_commands', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Submit a batch job: `sbatch script.sh` — returns Submitted batch job <id>. Job runs async on a cluster node.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Interactive run on a GPU node: `srun --partition=<partition> --gres=gpu:1 --pty bash`. For non-interactive: drop --pty and pass the command.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Inspect queue: `squeue -u <user>` (yours) or `squeue` (everyone). Job detail: `scontrol show job <id>`. Partition/node view: `sinfo -N` or `sinfo -s`.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Post-mortem: `sacct -j <id> --format=JobID,State,ExitCode,Elapsed,MaxRSS` — shows exit state, resources used. Use -l for full detail.', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Cancel a job: `scancel <id>`. Only your own jobs unless you have admin perms.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'job_persistence', 10, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'HARD RULE: every remote_exec that may run longer than ~30s MUST pass tmux_session: "<name>". This starts the command in a named tmux session on the remote host so a dropped SSH connection does not kill it.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Re-read progress with remote_tail {host, tmux_session}. Stop with remote_tmux_kill {host, tmux_session}. Session names are auto-prefixed with config.clusterTmuxPrefix (default "spore") so cleanup by prefix is safe.', 10, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Set wait:false when submitting a background job (long builds, training runs): remote_exec returns immediately with the session name, and you come back to check status later via remote_tail.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'For SLURM jobs specifically: the sbatch submission itself is fast (<1s) and does not need tmux. But running sbatch + tailing logs, or srun inline, DOES need tmux.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'gpu_vs_cpu', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'GPU jobs require `--gres=gpu:1` (or higher) plus a GPU-capable partition. The operators default partition is in settings (config.clusterDefaultPartition).', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'If the operator does not specify, ask which partition and whether GPU is needed before submitting — wrong partition = instant rejection or waste of quota.', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-compute-cluster', 'data_paths', 7, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Placeholder: cluster-specific storage paths (scratch, shared, home) are not seeded — the learner fills these in by observing the operator. When you learn the scratch/shared paths, record them on this aspect so future sessions find them quickly.', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- EXTEND ref-ssh-remote with tmux persistence guidance
-- ═══════════════════════════════════════════════════════════════

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-ssh-remote', 'tmux_persistence', 9, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'remote_exec supports tmux_session: "<name>" — runs the command inside a named tmux session on the remote host so SSH drops do not kill it. Essential for cluster jobs and long builds.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Companion tools: remote_tail {host, tmux_session, lines} reads current pane output; remote_tmux_kill {host, tmux_session} stops the session.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Session names are auto-prefixed with the cluster tmux prefix (default "spore-"). You do not need to include the prefix yourself — just pass a descriptive tag like "build-x" or "train-ep12".', 8, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- EDGES: Connect new reference nodes to spore system node
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-tailscale', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-tailscale');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-compute-cluster', 'documents', 0.9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-compute-cluster');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'ref-tailscale', 'depends_on', 0.9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='ref-compute-cluster' AND target='ref-tailscale');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'ref-ssh-remote', 'depends_on', 0.9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='ref-compute-cluster' AND target='ref-ssh-remote');
