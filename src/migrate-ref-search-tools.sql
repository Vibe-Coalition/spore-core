-- Idempotently add the Local Search Tools (grep + glob) reference node
-- onto installs that predate it. Re-running this migration is a no-op:
-- the node insert uses INSERT OR IGNORE, and each aspect/attribute is
-- guarded by WHERE NOT EXISTS so duplicates can't accumulate.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-search-tools', 'Local Search Tools (grep + glob)', 'reference',
  'Native grep and glob tools for code search — preferred over exec+grep/find.', 8, 'seed');

-- Aspect: when_to_use
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-search-tools', 'when_to_use', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'when_to_use');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'when_to_use'),
       'PREFER grep over exec+grep/awk/sed for any code search — returns structured {file, line, text} hits, no shell quoting pitfalls', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'when_to_use' AND a.content LIKE 'PREFER grep over exec%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'when_to_use'),
       'PREFER glob over exec+find/ls for filename lookups — returns paths relative to the search root', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'when_to_use' AND a.content LIKE 'PREFER glob over exec%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'when_to_use'),
       'For Spore Code (CLI) sessions both tools execute on the user''s machine via the CLI; for web/telegram/etc. they run server-side over /workspace', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'when_to_use' AND a.content LIKE 'For Spore Code (CLI) sessions%');

-- Aspect: caps_and_filters
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-search-tools', 'caps_and_filters', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'caps_and_filters');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'caps_and_filters'),
       'grep result cap: 200 hits, line text truncated at 200 chars. If truncated, narrow the pattern or set a glob.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'caps_and_filters' AND a.content LIKE 'grep result cap%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'caps_and_filters'),
       'glob result cap: 500 paths. Tighten the pattern or use a deeper path if hit.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'caps_and_filters' AND a.content LIKE 'glob result cap%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'caps_and_filters'),
       'Both tools auto-skip noise dirs: .git, node_modules, dist, build, __pycache__, .venv, venv, target, .next, .cache. Hidden dirs (any starting with .) are also skipped.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'caps_and_filters' AND a.content LIKE 'Both tools auto-skip%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'caps_and_filters'),
       'grep: pattern uses RE2 syntax (no lookahead/backrefs). glob param filters which filenames are scanned (e.g. glob:"*.go"). -i:true for case-insensitive.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'caps_and_filters' AND a.content LIKE 'grep: pattern uses RE2%');

-- Aspect: workflow_pattern
INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-search-tools', 'workflow_pattern', 8, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'workflow_pattern');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'workflow_pattern'),
       'Start broad (e.g. "late|delay(ed)?"), look at the {file, line, text} hits, then refine with a glob filter or tighter pattern instead of paginating.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Start broad%');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-search-tools' AND name = 'workflow_pattern'),
       'Pair with read_file: grep to find the relevant file:line, then read_file with offset/limit to inspect surrounding context.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-search-tools' AND asp.name = 'workflow_pattern' AND a.content LIKE 'Pair with read_file%');
