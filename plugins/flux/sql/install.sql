-- FLUX plugin install — registers the ref-bfl-api reference node so the
-- agent has authoritative docs about FLUX (endpoint, auth, models,
-- polling, display rules). All rows tagged with extracted_with='flux'
-- so uninstall.sql can sweep them by tag.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-bfl-api', 'FLUX Image Generation', 'reference',
  'FLUX API for image generation and editing (api.bfl.ai). Use the generate_image tool — it wraps submit + polling for you.', 9, 'flux');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'essentials', 10, 'flux');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-bfl-api' AND name='essentials'), v.content, v.imp, 'seed', 'flux'
  FROM (
    SELECT 'PREFER the generate_image tool — it handles the submit + poll loop. Only use raw web_fetch if you need a feature the tool doesn''t expose.' AS content, 10 AS imp UNION ALL
    SELECT 'Domain: api.bfl.ai — NOT api.bfl.ml (that hangs)', 10 UNION ALL
    SELECT 'Auth header: X-Key: YOUR_BFL_API_KEY (not Bearer)', 10 UNION ALL
    SELECT 'Default model: flux-2-pro-preview (use for everything unless told otherwise)', 9 UNION ALL
    SELECT 'Other models: flux-kontext-pro, flux-kontext-max, flux-pro-1.1, flux-2-pro', 7 UNION ALL
    SELECT 'Submit: POST https://api.bfl.ai/v1/{model} with JSON body', 9 UNION ALL
    SELECT 'Response has polling_url — ALWAYS use it (may point to regional node like api.us2.bfl.ai)', 9 UNION ALL
    SELECT 'Poll the polling_url with X-Key header until status="Ready"', 9 UNION ALL
    SELECT 'Image URL at result.sample — NOT result.url or result.image_url', 9 UNION ALL
    SELECT 'Signed URLs expire ~1hr — download or display promptly', 8
  ) AS v;

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'parameters', 8, 'flux');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-bfl-api' AND name='parameters'), v.content, v.imp, 'seed', 'flux'
  FROM (
    SELECT 'Required: prompt (string)' AS content, 9 AS imp UNION ALL
    SELECT 'Optional: width, height, output_format ("jpeg" or "png"), seed', 8 UNION ALL
    SELECT 'Image editing: add input_image param (URL, raw base64, or data URI all work)', 8 UNION ALL
    SELECT 'Edit prompts: describe what CHANGED, not the full scene', 8 UNION ALL
    SELECT 'Typical generation: 5-15 seconds. Poll every 3s, timeout at 60s.', 7
  ) AS v;

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with) VALUES ('ref-bfl-api', 'display_rule', 9, 'flux');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-bfl-api' AND name='display_rule'), v.content, v.imp, 'seed', 'flux'
  FROM (
    SELECT 'Always show generated images inline in chat: ![description](url)' AS content, 10 AS imp UNION ALL
    SELECT 'Do NOT just report a file path — the user wants to SEE the image', 9
  ) AS v;
