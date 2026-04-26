-- Deepgram plugin install — appends DEEPGRAM_API_KEY to the central
-- ref-api-keys catalog so the agent's "available APIs" list stays
-- accurate when this plugin is installed. No dedicated reference node
-- — Deepgram's API is simple enough that the agent can use it via
-- the SDK without bespoke docs.

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'DEEPGRAM_API_KEY — Deepgram speech-to-text', 7, 'seed', 'deepgram'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND NOT EXISTS (
    SELECT 1 FROM attributes
    WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
      AND content LIKE 'DEEPGRAM_API_KEY%'
  );
