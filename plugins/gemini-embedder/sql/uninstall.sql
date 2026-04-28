-- gemini-embedder uninstall — sweeps only the capability line. The
-- GEMINI_API_KEY catalog row is owned by gemini-provider; uninstalling
-- the embedder leaves the provider's key entry in place.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can semantically search the graph (Gemini embeddings).';
