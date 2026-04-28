-- openai-provider install — adopts the OPENAI_API_KEY catalog entry
-- (was 'seed'-tagged; this plugin owns it now). Re-tagging means the
-- uninstall sweep cleanly removes the catalog row when the operator
-- uninstalls OpenAI.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'OPENAI_API_KEY%';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'OPENAI_API_KEY — OpenAI (GPT models, chat + embeddings)', 7, 'seed', 'openai-provider'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys');
