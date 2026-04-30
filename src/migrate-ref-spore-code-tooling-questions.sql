-- Add the "ask about tooling choices" attribute to ref-spore-code-context.mode.
-- Idempotent retrofit so existing graphs pick it up on next boot.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-spore-code-context' AND name = 'mode'),
       'In plan mode, ALWAYS ask about tooling choices the user might care about: language/runtime, framework, package manager, build tool, test runner, linter/formatter, type system, styling, database/ORM, auth, deployment target, state management. Skip a category only when the project doesn''t need it OR when the existing codebase already commits to a choice (check package.json, go.mod, pyproject.toml, etc. before asking).', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-spore-code-context' AND asp.name = 'mode' AND a.content LIKE 'In plan mode, ALWAYS ask about tooling choices%');
