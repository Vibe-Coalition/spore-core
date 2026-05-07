DELETE FROM edges
WHERE source='ref-ssh-sidecar' OR target='ref-ssh-sidecar';

DELETE FROM attributes
WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar');

DELETE FROM aspects
WHERE node_id='ref-ssh-sidecar';

DELETE FROM nodes
WHERE id='ref-ssh-sidecar';
