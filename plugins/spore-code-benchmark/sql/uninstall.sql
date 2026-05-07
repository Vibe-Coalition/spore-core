DELETE FROM edges
WHERE source='ref-spore-code-benchmark' OR target='ref-spore-code-benchmark';

DELETE FROM attributes
WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id='ref-spore-code-benchmark');

DELETE FROM aspects
WHERE node_id='ref-spore-code-benchmark';

DELETE FROM nodes
WHERE id='ref-spore-code-benchmark';
