DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-elevenlabs-api');
DELETE FROM aspects WHERE node_id = 'ref-elevenlabs-api';
DELETE FROM edges WHERE source = 'ref-elevenlabs-api' OR target = 'ref-elevenlabs-api';
DELETE FROM nodes WHERE id = 'ref-elevenlabs-api';

-- Remove our entry from the central ref-api-keys catalog.
DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'XI_API_KEY%';
