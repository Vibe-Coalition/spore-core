-- Clarify that hosted user apps have a mounted serve endpoint. The
-- historical wording said "web URL", which made agents hand users the bare
-- Spore root/server IP instead of the served-app mount returned by web_serve.

UPDATE attributes
   SET content = '/workspace/web/<app-name>/ — served at the mounted app URL /serve/<app-name>/',
       updated_at = CURRENT_TIMESTAMP
 WHERE content = '/workspace/web/ — publicly served at your web URL'
    OR content = '/workspace/web/ — mounted at the served-app URL (/serve/ by default)';

UPDATE attributes
   SET content = 'Route priority: /graph -> /api/* system routes -> user app proxy -> mounted served-app static files from /workspace/web/<app-name>/',
       updated_at = CURRENT_TIMESTAMP
 WHERE content = 'Route priority: /graph -> /api/* system routes -> user app proxy -> static files from /workspace/web/'
    OR content = 'Route priority: /graph -> /api/* system routes -> user app proxy -> mounted served-app static files from /workspace/web/';

UPDATE attributes
   SET content = 'web_serve tool serves static files from /workspace/web/<app-name>/ at the mounted endpoint returned as url/serveUrl (/serve/<app-name>/) — files written there are live immediately',
       updated_at = CURRENT_TIMESTAMP
 WHERE content = 'web_serve tool serves static files from /workspace/web/ — files written there are live immediately'
    OR content = 'web_serve tool serves static files from /workspace/web/ at the mounted app endpoint returned as url/serveUrl (usually /serve/) — files written there are live immediately';

UPDATE attributes
   SET content = '/workspace/web/<app-name>/ is for standalone hosted files/pages; outside web chat, use the mounted served-app URL returned by web_serve (/serve/<app-name>/), not the bare Spore root/server IP.',
       updated_at = CURRENT_TIMESTAMP
 WHERE content = '/workspace/web/ is for standalone hosted files/pages; outside web chat, use the public URL for those files.'
    OR content = '/workspace/web/ is for standalone hosted files/pages; outside web chat, use the mounted served-app URL returned by web_serve (usually /serve/), not the bare Spore root/server IP.'
    OR content LIKE 'Images in /workspace/web/ are served at your public URL%';
