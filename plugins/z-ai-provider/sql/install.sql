DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'ZAI_API_KEY%';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'ZAI_API_KEY — Z.ai cloud (GLM-4.6 / GLM-Z1 / charglm; OpenAI-compatible)', 7, 'seed', 'z-ai-provider'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys');
