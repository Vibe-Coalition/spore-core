-- graphcorn-discovery plugin install SQL.
--
-- 1) Backfill: legacy installs created this aspect+attributes with
--    extracted_with='seed' via the in-tree migrate-ref-graphcorn-discovery.sql.
--    Retag those rows to '{{plugin_id}}' so future uninstall actually finds them.
-- 2) Idempotent insert (WHERE NOT EXISTS) of the aspect + 4 attributes.
--    The {{plugin_id}} token is substituted by the plugin manager so this
--    file remains plugin-id agnostic.

-- ── Backfill legacy seed-tagged rows ──────────────────────────────
UPDATE aspects
   SET extracted_with = '{{plugin_id}}'
 WHERE node_id = 'ref-acorn-context'
   AND name = 'discovery_workflow'
   AND extracted_with = 'seed';

UPDATE attributes
   SET extracted_with = '{{plugin_id}}'
 WHERE aspect_id IN (
         SELECT id FROM aspects
          WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'
       )
   AND extracted_with = 'seed';

-- ── Aspect ────────────────────────────────────────────────────────
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-acorn-context', 'discovery_workflow', 9, '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM aspects
   WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'
);

-- ── Attributes ────────────────────────────────────────────────────
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'graphcorn — every acorn launch creates a `session-<id>` node at connect time (BEFORE the first chat:submit) with edges to the `project-<userId-cwdHash>` node. All knowledge captured during the conversation anchors here: learner-extracted entities get a `discovered_in` edge automatically; agent-written discoveries (via note_discovery / graph_update) get a `recorded_in` edge.',
       9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-acorn-context'
     AND asp.name = 'discovery_workflow'
     AND a.content LIKE 'graphcorn — every acorn launch%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'When you learn something durable during an acorn session — a config that worked, a tool quirk, a fix for a tricky failure, a port number, a CLI flag — call `note_discovery({text: "...", kind: "fact|gotcha|workflow|config|failure_fix"})`. The wrapper creates a properly-structured `discovery` node and links it to the session AND project nodes for free. Casual save, lower friction than graph_update.',
       9, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-acorn-context'
     AND asp.name = 'discovery_workflow'
     AND a.content LIKE 'When you learn something durable during an acorn session%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Use `graph_update` directly (not note_discovery) when you need full schema control — a non-default node type (project, person, system), multiple aspects with different importances, explicit `relates_to` edges to specific other nodes. note_discovery is the casual save; graph_update is the structured save. Both link properly to the session if called inside an acorn turn.',
       8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-acorn-context'
     AND asp.name = 'discovery_workflow'
     AND a.content LIKE 'Use `graph_update` directly%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'),
       'Don''t wait for the learner. The learner runs after every assistant turn and extracts what its heuristics rank as important, but it doesn''t know which facts mattered TO YOU. If you noticed that the React Native bundler defaults to port 8081 and that surprised you, save it explicitly — don''t hope the learner picks it up. Cost is negligible (one INSERT + 2-3 edges); benefit is a deterministic, durable record.',
       8, 'seed', '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-acorn-context'
     AND asp.name = 'discovery_workflow'
     AND a.content LIKE 'Don''t wait for the learner%'
);
