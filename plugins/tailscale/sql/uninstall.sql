-- Tailscale plugin uninstall — sweep ref-tailscale + its aspects + attrs.
-- ref-compute-cluster stays in core (managed by migrate-ref-tailscale-cluster.sql).

DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = 'ref-tailscale');
DELETE FROM aspects WHERE node_id = 'ref-tailscale';
DELETE FROM edges WHERE source = 'ref-tailscale' OR target = 'ref-tailscale';
DELETE FROM nodes WHERE id = 'ref-tailscale';
