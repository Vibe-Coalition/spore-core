DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'ANTHROPIC_API_KEY%';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'ANTHROPIC_API_KEY — Anthropic Claude (Opus / Sonnet / Haiku, vision-capable)', 9, 'seed', 'anthropic-provider'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys');
