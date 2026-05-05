-- Idempotently add cron proactive-notification guidance to installs that
-- predate /api/proactive/trigger. Re-running is a no-op.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-cron-runtime', 'Cron & Startup Tasks', 'reference',
  'How scheduled jobs and persistent background tasks work inside the container runtime.', 8, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
SELECT 'ref-cron-runtime', 'cron', 9, 'seed'
WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id = 'ref-cron-runtime' AND name = 'cron');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-cron-runtime' AND name = 'cron' ORDER BY id LIMIT 1),
       'Cron and background jobs can notify the operator by POSTing JSON to http://127.0.0.1:${SPORE_WEB_PORT:-18803}/api/proactive/trigger with {"source":"cron","message":"..."}. Loopback calls are accepted without auth; external callers must pass normal web auth.', 9, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-cron-runtime'
    AND asp.name = 'cron'
    AND a.content LIKE 'Cron and background jobs can notify the operator by POSTing JSON%'
);

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id = 'ref-cron-runtime' AND name = 'cron' ORDER BY id LIMIT 1),
       'Use proactive trigger mode:"agent" only when the notification should start an agent turn. Omit mode, or set mode:"notify", for cheap operator notifications.', 7, 'seed', 'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM attributes a JOIN aspects asp ON asp.id = a.aspect_id
  WHERE asp.node_id = 'ref-cron-runtime'
    AND asp.name = 'cron'
    AND a.content LIKE 'Use proactive trigger mode:%'
);

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-cron-runtime', 'documents', 0.8, 'seed');
