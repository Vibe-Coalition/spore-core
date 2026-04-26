-- acorn-cli plugin uninstall SQL.
--
-- Removes ref-acorn-context and everything anchored to it.
-- Order matters because edges.source/target reference nodes.id but have
-- no ON DELETE CASCADE: any leftover edge referencing the node would
-- block the node DELETE with a FOREIGN KEY constraint failure.
--
-- We delete edges referencing this plugin's node REGARDLESS of who tagged
-- them. Edges from other plugins / the maintainer / user activity that
-- pointed at our node would otherwise dangle when the node is gone, so
-- removing them is correct.

DELETE FROM edges
 WHERE source = 'ref-acorn-context' OR target = 'ref-acorn-context';

DELETE FROM attributes
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context')
   AND extracted_with = '{{plugin_id}}';

DELETE FROM aspects
 WHERE node_id = 'ref-acorn-context'
   AND extracted_with = '{{plugin_id}}';

DELETE FROM nodes
 WHERE id = 'ref-acorn-context'
   AND extracted_with = '{{plugin_id}}';
