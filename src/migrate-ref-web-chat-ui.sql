-- Idempotently add web-chat media and built-in panel behavior docs to
-- reference nodes. Re-running is a no-op.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-image-display', 'Displaying Images in Chat', 'reference',
  'How to render images and media inline in the web control panel.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-image-display', 'how_to', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-image-display' AND name = 'how_to');

UPDATE attributes
   SET content = '/workspace/web/ is for standalone hosted files/pages; outside web chat, use the public URL for those files.',
       updated_at = CURRENT_TIMESTAMP
 WHERE id IN (
   SELECT a.id FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
   WHERE asp.node_id = 'ref-image-display'
     AND a.content LIKE 'Images in /workspace/web/ are served at your public URL%'
 );

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-image-display' AND name = 'how_to' ORDER BY id LIMIT 1),
       'In web chat, reply with `/workspace/<file>` paths for images, video, audio, or files; the UI rewrites them to the current origin and renders/links them inline.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-image-display' AND a.content LIKE 'In web chat, reply with `/workspace/<file>` paths%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-image-display' AND name = 'how_to' ORDER BY id LIMIT 1),
       'Prefer `/workspace/<filename>` in web chat. Use absolute URLs only when sharing a link meant to be opened outside the current chat.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-image-display' AND a.content LIKE 'Prefer `/workspace/<filename>` in web chat%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-image-display' AND name = 'how_to' ORDER BY id LIMIT 1),
       'User uploads are saved under `/workspace/uploads`; analyze_media can auto-detect image/audio/video when the user means an uploaded attachment.', 8, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-image-display' AND a.content LIKE 'User uploads are saved under `/workspace/uploads`%'
);

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-code-viewer', 'Code Viewer Panel', 'reference',
  'A built-in floating panel in the web control panel that automatically displays code when read_file, write_file, or edit_file are used.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-code-viewer', 'how_it_works', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-code-viewer' AND name = 'how_it_works');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-code-viewer' AND name = 'how_it_works' ORDER BY id LIMIT 1),
       'The user controls code-viewer mode in the web panel: Auto, On request, or Off. The agent should use file tools normally and not build a custom code viewer.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-code-viewer' AND a.content LIKE 'The user controls code-viewer mode%'
);

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-image-display', 'documents', 0.8, 'seed');

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-code-viewer', 'documents', 0.8, 'seed');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-browser-automation' AND name = 'usage' ORDER BY id LIMIT 1),
       'In the web panel, browser sessions stream live preview automatically. browser({action:"screenshot"}) also saves a JPG and returns filePath; in web chat, reply with that `/workspace/...` path so it renders inline.', 8, 'seed', 'browser-core'
WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-browser-automation' AND name = 'usage')
  AND NOT EXISTS (
    SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
    WHERE asp.node_id = 'ref-browser-automation'
      AND a.content LIKE 'In the web panel, browser sessions stream live preview automatically%'
  );
