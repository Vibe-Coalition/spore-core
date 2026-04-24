-- graphcorn: add discovery_workflow aspect to ref-acorn-context covering
-- when/how to call note_discovery vs graph_update and how the session
-- node anchors knowledge written during a conversation. Idempotent —
-- WHERE NOT EXISTS guards on the aspect + each attribute.

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'discovery_workflow', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'graphcorn — every acorn launch creates a `session-<id>` node at connect time (BEFORE the first chat:submit) with edges to the `project-<userId-cwdHash>` node. All knowledge captured during the conversation anchors here: learner-extracted entities get a `discovered_in` edge automatically; agent-written discoveries (via note_discovery / graph_update) get a `recorded_in` edge.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'graphcorn — every acorn launch%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'When you learn something durable during an acorn session — a config that worked, a tool quirk, a fix for a tricky failure, a port number, a CLI flag — call `note_discovery({text: "...", kind: "fact|gotcha|workflow|config|failure_fix"})`. The wrapper creates a properly-structured `discovery` node and links it to the session AND project nodes for free. Casual save, lower friction than graph_update.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'When you learn something durable during an acorn session%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Use `graph_update` directly (not note_discovery) when you need full schema control — a non-default node type (project, person, system), multiple aspects with different importances, explicit `relates_to` edges to specific other nodes. note_discovery is the casual save; graph_update is the structured save. Both link properly to the session if called inside an acorn turn.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'Use `graph_update` directly%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Don''t wait for the learner. The learner runs after every assistant turn and extracts what its heuristics rank as important, but it doesn''t know which facts mattered TO YOU. If you noticed that the React Native bundler defaults to port 8081 and that surprised you, save it explicitly — don''t hope the learner picks it up. Cost is negligible (one INSERT + 2-3 edges); benefit is a deterministic, durable record.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-acorn-context' AND asp.name = 'discovery_workflow' AND a.content LIKE 'Don''t wait for the learner%');
