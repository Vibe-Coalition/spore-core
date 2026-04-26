-- graphcorn-discovery plugin uninstall SQL.
-- Auto-cascade would also work (DELETE FROM attributes/aspects WHERE
-- extracted_with = '{{plugin_id}}'), but we ship explicit teardown so
-- the SQL stays self-documenting and an operator reading it can see
-- exactly what gets removed.

DELETE FROM attributes
 WHERE aspect_id IN (
         SELECT id FROM aspects
          WHERE node_id = 'ref-acorn-context' AND name = 'discovery_workflow'
       )
   AND extracted_with = '{{plugin_id}}';

DELETE FROM aspects
 WHERE node_id = 'ref-acorn-context'
   AND name = 'discovery_workflow'
   AND extracted_with = '{{plugin_id}}';
