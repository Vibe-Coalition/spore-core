-- local-oai-provider install — appends a capability line so the
-- agent's self-description reflects that it can talk to any
-- OpenAI-compatible LLM. Sweep-then-insert absorbs any legacy
-- 'seed'-tagged copy from older builds.

DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can run any OpenAI-compatible LLM (vLLM, LM Studio, Ollama, custom endpoints).';
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities'),
  'Can run any OpenAI-compatible LLM (vLLM, LM Studio, Ollama, custom endpoints).', 9, 'seed', 'local-oai-provider'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='spore' AND name='capabilities');
