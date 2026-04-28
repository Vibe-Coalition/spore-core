-- FLUX plugin uninstall — sweep the ref-bfl-api node, its aspects,
-- and their attributes. The plugin manager's _executeUninstallFor
-- runs this AND additionally drops any rows still tagged
-- extracted_with='flux' as a defense-in-depth pass.

DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-bfl-api');
DELETE FROM aspects WHERE node_id = 'ref-bfl-api';
DELETE FROM edges WHERE source = 'ref-bfl-api' OR target = 'ref-bfl-api';
DELETE FROM nodes WHERE id = 'ref-bfl-api';

-- Remove our entry from the central ref-api-keys catalog. Match by
-- content prefix so legacy 'seed'-tagged rows from old installs also
-- get cleaned up.
DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-api-keys' AND name='available_keys')
  AND content LIKE 'BFL_API_KEY%';

-- Remove our capability entry from the spore node. Exact-content match
-- so a future plugin's similarly-worded line wouldn't be dragged out
-- alongside ours.
DELETE FROM attributes
WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='spore' AND name='capabilities')
  AND content = 'Can generate images using Flux.';
