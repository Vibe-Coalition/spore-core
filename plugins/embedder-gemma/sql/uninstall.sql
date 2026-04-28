-- embedder-gemma uninstall — sweep the capability line.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can semantically search the graph (local EmbeddingGemma, no API key).';
