-- Idempotently add general tool-workflow reference knowledge that used to
-- live in the always-included prompt. Re-running is a no-op.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('knowledge-graph', 'Knowledge Graph', 'system',
  'SQLite knowledge graph. Nodes, aspects, attributes, edges. Persists across restarts and grows with every conversation.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'knowledge-graph', 'how_it_works', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'knowledge-graph' AND name = 'how_it_works');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'knowledge-graph' AND name = 'how_it_works' ORDER BY id LIMIT 1),
       'A separate protected General Knowledge Base graph exists at slug spore-knowledge-base. Query it with graph_query({ graph: "spore-knowledge-base", mode: "overview", limit: 20, offset: 0 }) for reusable tool, workflow, provider, plugin, UI, and app-behavior knowledge.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'knowledge-graph' AND asp.name = 'how_it_works' AND a.content LIKE 'A separate protected General Knowledge Base graph exists at slug spore-knowledge-base%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'knowledge-graph' AND name = 'how_it_works' ORDER BY id LIMIT 1),
       'Use graph_query({ mode: "graphs" }) to list available graph scopes. Do not inspect /data/graphs or _registry.json with shell commands for normal graph discovery.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'knowledge-graph' AND asp.name = 'how_it_works' AND a.content LIKE 'Use graph_query({ mode: "graphs" }) to list available graph scopes%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'knowledge-graph' AND name = 'how_it_works' ORDER BY id LIMIT 1),
       'When the user asks about shared graph knowledge, reusable lessons, or graph-distilled skills, inspect the General Knowledge Base directly. Use graph_query({ graph: "spore-knowledge-base", type: "skill" }) for stored skill nodes, or graph_query({ graph: "spore-knowledge-base", query: "skill" }) for broader skill-related matches. Do not describe the General Knowledge Base as empty if overview/type results returned nodes.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'knowledge-graph' AND asp.name = 'how_it_works' AND a.content LIKE 'When the user asks about shared graph knowledge, reusable lessons, or graph-distilled skills%'
);

-- The old ref-cross-agent-messaging node described a graph-inbox protocol
-- that no longer exists as a first-class messaging system. The old
-- ref-token-efficiency node was generic tool hygiene that belongs here.
DELETE FROM edges
 WHERE source IN ('ref-cross-agent-messaging', 'ref-token-efficiency')
    OR target IN ('ref-cross-agent-messaging', 'ref-token-efficiency');
DELETE FROM attributes
 WHERE aspect_id IN (
   SELECT id FROM aspects
    WHERE node_id IN ('ref-cross-agent-messaging', 'ref-token-efficiency')
 );
DELETE FROM aspects WHERE node_id IN ('ref-cross-agent-messaging', 'ref-token-efficiency');
DELETE FROM aliases WHERE node_id IN ('ref-cross-agent-messaging', 'ref-token-efficiency');
DELETE FROM nodes WHERE id IN ('ref-cross-agent-messaging', 'ref-token-efficiency');

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-tool-workflows', 'Tool Workflows', 'reference',
  'Operational patterns for choosing tools, asking the operator, waiting, tracking work, and avoiding waste.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-tool-workflows', 'tool_selection', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection' ORDER BY id LIMIT 1),
       'Use edit_file for modifications to existing files; use write_file only for brand-new files. Rewriting whole files wastes time and risks losing unrelated edits.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'tool_selection' AND a.content LIKE 'Use edit_file for modifications%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection' ORDER BY id LIMIT 1),
       'Use exec only for scripts, package commands, git, or shell commands with no dedicated tool. Prefer native read_file/grep/glob/web_fetch/graph tools when they exist.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'tool_selection' AND a.content LIKE 'Use exec only for scripts%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection' ORDER BY id LIMIT 1),
       'Use startup_tasks for long-running processes that must survive restarts; use cron for scheduled triggers. Do not use raw nohup for persistent services.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'tool_selection' AND a.content LIKE 'Use startup_tasks for long-running processes%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'tool_selection' ORDER BY id LIMIT 1),
       'Use graph_update for deliberate corrections or explicit knowledge persistence. Learning already happens automatically, so do not duplicate every ordinary conversation turn.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'tool_selection' AND a.content LIKE 'Use graph_update for deliberate corrections%'
);

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-tool-workflows', 'efficiency', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
       'Plan → execute → verify. Pick the most likely path, try it, and fall back only on failure.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'efficiency' AND a.content LIKE 'Plan → execute → verify%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
       'Sequential by default. Parallelize only when results are truly independent and all branches are needed; do not shotgun tool calls.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'efficiency' AND a.content LIKE 'Sequential by default%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
       'Check before installing: `which <cmd>` or `pip list | grep <pkg>`. Never install the same package multiple ways in parallel.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'efficiency' AND a.content LIKE 'Check before installing:%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
       'Each tool call costs tokens and time. Fewer targeted calls beat many speculative calls.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'efficiency' AND a.content LIKE 'Each tool call costs tokens%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'efficiency' ORDER BY id LIMIT 1),
       'Keep tool use lean: do not re-read files or docs you just used, do not refetch stable facts, and delegate genuinely heavy independent work.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'efficiency' AND a.content LIKE 'Keep tool use lean:%'
);

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-tool-workflows', 'asking_waiting_tracking', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking');

UPDATE attributes
SET content = 'ask_user is available in web and Spore Code CLI sessions when the operator must pick between 2-5 concrete options; it opens a picker/modal and returns the selected label. In non-modal channels, ask the question in normal reply text instead.'
WHERE content = 'ask_user is for web sessions when the operator must pick between concrete options. CLI sessions do not support ask_user; put a QUESTIONS: block in the reply instead.';

UPDATE attributes
SET content = 'CLI QUESTIONS protocol is for plan-mode prose interviews, not the ask_user tool: single-select uses `[opt1 / opt2]`, multi-select uses `{opt1 / opt2}`, and open-ended questions omit brackets. The user answer arrives as a follow-up message.'
WHERE content = 'CLI QUESTIONS protocol: single-select uses `[opt1 / opt2]`, multi-select uses `{opt1 / opt2}`, and open-ended questions omit brackets. The user answer arrives as a follow-up message.';

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'ask_user is available in web and Spore Code CLI sessions when the operator must pick between 2-5 concrete options; it opens a picker/modal and returns the selected label. In non-modal channels, ask the question in normal reply text instead.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'ask_user is available in web and Spore Code CLI sessions%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'CLI QUESTIONS protocol is for plan-mode prose interviews, not the ask_user tool: single-select uses `[opt1 / opt2]`, multi-select uses `{opt1 / opt2}`, and open-ended questions omit brackets. The user answer arrives as a follow-up message.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'CLI QUESTIONS protocol is for plan-mode prose interviews%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'Use schedule_wakeup for known waits such as deploy settling, job start delays, or rate-limit cooldowns. It releases the session and re-enters later instead of sleeping in a loop.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'Use schedule_wakeup for known waits%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'Never poll delegated tasks with task_status + sleep. If delegated tasks are running and no other work remains, end the turn; task_complete re-enters automatically.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'Never poll delegated tasks%'
);

UPDATE attributes
SET content = 'Use delegate_task for sub-agent work, spore_message for a configured multi-spore mesh, and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.'
WHERE content = 'Use delegate_task for sub-agent work and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.';

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'Use delegate_task for sub-agent work, spore_message for a configured multi-spore mesh, and message_send for real channel delivery; do not create graph-inbox nodes as a messaging protocol.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'Use delegate_task for sub-agent work%do not create graph-inbox nodes%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'Use task_create/task_progress/task_list for jobs spanning more than one back-and-forth. Tasks survive restarts and blockers hide dependent tasks until resolved.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'Use task_create/task_progress/task_list%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-tool-workflows' AND name = 'asking_waiting_tracking' ORDER BY id LIMIT 1),
       'Use log_watch for continuous local log visibility while a process runs; use tight regex because every match becomes an interjection.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-tool-workflows' AND asp.name = 'asking_waiting_tracking' AND a.content LIKE 'Use log_watch for continuous local log visibility%'
);

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-tool-workflows', 'documents', 0.8, 'seed');
