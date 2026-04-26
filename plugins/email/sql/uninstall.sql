-- email plugin uninstall SQL.
--
-- Removes ref-email and everything anchored to it.
-- Order matters because edges.source/target reference nodes.id but have
-- no ON DELETE CASCADE: any leftover edge referencing the node would
-- block the node DELETE with a FOREIGN KEY constraint failure.
--
-- We delete edges referencing this plugin's node REGARDLESS of who tagged
-- them (maintainer, user activity, other plugins). They'd dangle anyway
-- when the node is gone.

DELETE FROM edges
 WHERE source = 'ref-email' OR target = 'ref-email';

DELETE FROM attributes
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-email')
   AND extracted_with = '{{plugin_id}}';

DELETE FROM aspects
 WHERE node_id = 'ref-email'
   AND extracted_with = '{{plugin_id}}';

DELETE FROM nodes
 WHERE id = 'ref-email'
   AND extracted_with = '{{plugin_id}}';
