-- gemini-embedder install — owns ONLY the spore.capabilities entry.
-- The GEMINI_API_KEY ref-api-keys catalog row moved to gemini-provider
-- (which owns the actual key now); this plugin reads through that.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can semantically search the graph (Gemini embeddings).';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities'),
  'Can semantically search the graph (Gemini embeddings).', 7, 'seed', 'gemini-embedder'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='spore' AND name='capabilities');
