DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'ANTHROPIC_API_KEY%';
