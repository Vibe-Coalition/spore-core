DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can run any OpenAI-compatible LLM (vLLM, LM Studio, Ollama, custom endpoints).';
