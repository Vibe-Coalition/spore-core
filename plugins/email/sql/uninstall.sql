-- email plugin uninstall SQL.
-- Removes the ref-email node + all its descendants. The aspects/attributes
-- cascade through the FK ON DELETE CASCADE, so deleting the node alone is
-- sufficient — but we explicitly delete plugin-tagged rows in dependency
-- order for clarity and to handle the edge (which doesn't cascade from
-- the source node).

DELETE FROM edges
 WHERE target = 'ref-email'
   AND extracted_with = '{{plugin_id}}';

DELETE FROM attributes
 WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-email')
   AND extracted_with = '{{plugin_id}}';

DELETE FROM aspects
 WHERE node_id = 'ref-email'
   AND extracted_with = '{{plugin_id}}';

DELETE FROM nodes
 WHERE id = 'ref-email'
   AND extracted_with = '{{plugin_id}}';
