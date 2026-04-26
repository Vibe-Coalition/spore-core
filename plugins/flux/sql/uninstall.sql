-- FLUX plugin uninstall — sweep the ref-bfl-api node, its aspects,
-- and their attributes. The plugin manager's _executeUninstallFor
-- runs this AND additionally drops any rows still tagged
-- extracted_with='flux' as a defense-in-depth pass.

DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-bfl-api');
DELETE FROM aspects WHERE node_id = 'ref-bfl-api';
DELETE FROM edges WHERE source = 'ref-bfl-api' OR target = 'ref-bfl-api';
DELETE FROM nodes WHERE id = 'ref-bfl-api';
