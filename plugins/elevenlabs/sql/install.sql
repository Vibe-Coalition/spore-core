-- ElevenLabs plugin install — agent-facing reference docs about the
-- ElevenLabs API. Without these the agent has no built-in knowledge
-- of how to call the SFX or voice-listing endpoints (the TTS path
-- itself goes through the plugin's TTS provider).

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-elevenlabs-api', 'ElevenLabs TTS & Sound Effects', 'reference',
  'ElevenLabs API for text-to-speech and sound effect generation. Voice replies route through the elevenlabs TTS provider automatically; this node documents the raw API for direct calls (e.g. listing voices or generating SFX).', 7, 'elevenlabs');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-elevenlabs-api', 'essentials', 9, 'elevenlabs');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-elevenlabs-api' AND name='essentials'), v.content, v.imp, 'seed', 'elevenlabs'
  FROM (
    SELECT 'Auth header: xi-api-key: YOUR_XI_API_KEY' AS content, 9 AS imp UNION ALL
    SELECT 'TTS: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id} — returns audio bytes directly (no polling)', 9 UNION ALL
    SELECT 'SFX: POST https://api.elevenlabs.io/v1/sound-generation with {text, duration_seconds} — returns audio directly', 8 UNION ALL
    SELECT 'Best model: eleven_multilingual_v2', 8 UNION ALL
    SELECT 'List voices: GET https://api.elevenlabs.io/v1/voices', 7 UNION ALL
    SELECT 'Voice settings: stability (0.3-0.5), similarity_boost (0.7-0.9), style (0.5-0.7), use_speaker_boost: true', 7
  ) AS v;

-- Append our key to the central ref-api-keys catalog.
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT
  (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys'),
  'XI_API_KEY — ElevenLabs TTS and sound effects', 8, 'seed', 'elevenlabs'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND NOT EXISTS (
    SELECT 1 FROM attributes
    WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
      AND content LIKE 'XI_API_KEY%'
  );

-- `spore documents ref-elevenlabs-api` edge — moved out of seed-graph.sql
-- so a fresh DB doesn't FK-fail when this plugin isn't installed.
-- Uninstall sweep on edges.extracted_with handles cleanup.
INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
  VALUES ('spore', 'ref-elevenlabs-api', 'documents', 0.8, 'elevenlabs');
