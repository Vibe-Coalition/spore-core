-- spore-code-benchmark plugin install — agent-facing reference docs.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, mentions, extracted_with, extracted_at)
VALUES (
  'ref-spore-code-benchmark',
  'Spore Code Benchmark',
  'reference',
  'Live multi-repository coding benchmark for Spore Code sessions.',
  7,
  1,
  '{{plugin_id}}',
  strftime('%s','now')
);

INSERT OR IGNORE INTO aspects (node_id, name, importance, source)
VALUES ('ref-spore-code-benchmark', 'purpose', 8, '{{plugin_id}}');

INSERT OR IGNORE INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-spore-code-benchmark' AND name='purpose'),
       'This plugin runs coding benchmark scenarios by cloning public repositories into disposable workspaces, simulating Spore Code CLI websocket sessions, executing local tools through a repo-root sandbox, waiting for post-session memory settle, and saving a report with transcripts, tool calls, verification output, heuristic scores, planner experience summaries, optional LLM judge results, and cross-session leakage scans.',
       8,
       'plugin',
       '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-spore-code-benchmark' AND name='purpose')
    AND content LIKE 'This plugin runs coding benchmark scenarios%'
);

INSERT OR IGNORE INTO aspects (node_id, name, importance, source)
VALUES ('ref-spore-code-benchmark', 'operator_usage', 7, '{{plugin_id}}');

INSERT OR IGNORE INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-spore-code-benchmark' AND name='operator_usage'),
       'Operators can start it from Settings -> Plugins -> Spore Code Benchmark or call /api/plugins/spore-code-benchmark/run. Useful options include maxScenarios, scenarioIds, parallel, dryRun, runVerification, judge, judgeModel, refreshRepos, and includeDiff.',
       7,
       'plugin',
       '{{plugin_id}}'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-spore-code-benchmark' AND name='operator_usage')
    AND content LIKE 'Operators can start it from Settings%'
);

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-spore-code-benchmark', 'documents', 0.5, '{{plugin_id}}');
