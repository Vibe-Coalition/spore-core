-- compute-cluster plugin uninstall — sweep ref-compute-cluster + its
-- aspects + attributes. Cluster config slots in spore.json
-- (clusterUsername / clusterLoginHost / clusterTmuxPrefix /
-- clusterHosts) are intentionally NOT deleted — they're regular host
-- config and the operator may want them preserved for re-install.

DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-compute-cluster');
DELETE FROM aspects WHERE node_id = 'ref-compute-cluster';
DELETE FROM edges WHERE source = 'ref-compute-cluster' OR target = 'ref-compute-cluster';
DELETE FROM nodes WHERE id = 'ref-compute-cluster';
