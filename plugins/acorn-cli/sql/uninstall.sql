-- acorn-cli plugin uninstall SQL.
--
-- Removes ref-acorn-context and everything anchored to it. The CASCADE
-- on aspects.node_id → nodes.id (and attributes.aspect_id → aspects.id)
-- handles the descendants when we delete the node, but we go bottom-up
-- explicitly so the operator reading this file can see exactly what
-- gets removed and so we only touch plugin-tagged rows. Edges don't
-- cascade, so we delete those by extracted_with.

DELETE FROM edges
 WHERE (source = 'ref-acorn-context' OR target = 'ref-acorn-context')
   AND extracted_with = '{{plugin_id}}';

DELETE FROM attributes
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-acorn-context')
   AND extracted_with = '{{plugin_id}}';

DELETE FROM aspects
 WHERE node_id = 'ref-acorn-context'
   AND extracted_with = '{{plugin_id}}';

DELETE FROM nodes
 WHERE id = 'ref-acorn-context'
   AND extracted_with = '{{plugin_id}}';
