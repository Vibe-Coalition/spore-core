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
  ((SELECT MAX(id) FROM aspects), 'GEMINI_API_KEY — Google Gemini', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'BRAVE_API_KEY — Brave Search', 7, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-api-keys', 'filesystem_paths', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), '/workspace/ — persistent writable workspace (scripts, files, projects)', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/workspace/web/ — publicly served at your web URL', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/data/ — config and databases (.env lives here)', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), '/app/ — Anima runtime (mostly read-only)', 7, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Never log or print full API key values', 9, 'seed', 'seed');


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
  ((SELECT MAX(id) FROM aspects), 'Request flow: Browser -> Traefik (strips /animas/{id} prefix) -> container port (ANIMA_WEB_PORT, typically 18800)', 9, 'seed', 'seed'),
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
  ((SELECT MAX(id) FROM aspects), 'NEVER run Express or any server on the ANIMA_WEB_PORT — it replaces the built-in server and breaks /graph and all system routes', 10, 'seed', 'seed'),
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
-- NODE: Playwright & Browser
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-playwright', 'Playwright Browser Setup', 'reference',
  'How to use Playwright/Chromium for browser automation and the live browser panel.', 7, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-playwright', 'setup', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Playwright + Chromium are pre-installed. npm install will FAIL (outbound blocked). Use symlink instead.', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Symlink: ln -sf /workspace/.venv/lib/python3.11/site-packages/playwright/driver/package /app/node_modules/playwright-core', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Chromium binary: /workspace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Set PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Run Node scripts from /app directory (that''s where the symlink lives)', 8, 'seed', 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-playwright', 'usage', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'Built-in browser tool works after symlink: browser action="launch" url="..." — streams live to control panel', 9, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Actions: launch, navigate, click, type, scroll, screenshot', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Always use --no-sandbox --disable-dev-shm-usage flags', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Use wait_until="domcontentloaded" — networkidle often times out', 8, 'seed', 'seed'),
  ((SELECT MAX(id) FROM aspects), 'Python: PLAYWRIGHT_BROWSERS_PATH=... /workspace/.venv/bin/python3 script.py', 7, 'seed', 'seed');


-- ═══════════════════════════════════════════════════════════════
-- NODE: Cross-Agent Messaging
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-cross-agent-messaging', 'Cross-Agent Messaging', 'reference',
  'Reliable messaging between Animas using graph inbox nodes instead of ephemeral anima_message.', 7, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-cross-agent-messaging', 'pattern', 8, 'seed');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with) VALUES
  ((SELECT MAX(id) FROM aspects), 'anima_message is sync and ephemeral — if target is busy/offline, message vanishes', 8, 'seed', 'seed'),
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
-- EDGES: Connect reference nodes to anima system node
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-api-keys', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-api-keys');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-bfl-api', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-bfl-api');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-elevenlabs-api', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-elevenlabs-api');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-web-architecture', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-web-architecture');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-image-display', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-image-display');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-playwright', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-playwright');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-cross-agent-messaging', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-cross-agent-messaging');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-token-efficiency', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-token-efficiency');
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  SELECT 'anima', 'ref-ssh-remote', 'documents', 0.8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source='anima' AND target='ref-ssh-remote');
