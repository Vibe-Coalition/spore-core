-- embedder-gemma install — appends "Can semantically search the graph
-- (local EmbeddingGemma, no API key)." to the spore.capabilities aspect
-- so the agent's self-description reflects what's wired up. No
-- ref-api-keys catalog entry — this embedder needs no key.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can semantically search the graph (local EmbeddingGemma, no API key).';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities'),
  'Can semantically search the graph (local EmbeddingGemma, no API key).', 7, 'seed', 'embedder-gemma'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='spore' AND name='capabilities');
