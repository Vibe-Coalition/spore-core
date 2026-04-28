-- Adopt the GEMINI_API_KEY catalog entry. Previously owned by
-- gemini-embedder (which used to be the sole consumer of the key);
-- now gemini-provider owns it and gemini-embedder reads through.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'GEMINI_API_KEY%';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'GEMINI_API_KEY — Google Gemini (chat + embeddings; shared by gemini-provider and gemini-embedder)', 7, 'seed', 'gemini-provider'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys');
