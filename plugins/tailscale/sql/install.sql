-- Tailscale plugin install — agent-facing reference docs about the
-- tailscaled CLI, the SSO login flow, and the routing model. Without
-- the plugin installed, the agent has no built-in knowledge of how
-- to query the daemon. Idempotent — every insert guarded by
-- WHERE NOT EXISTS so re-running across schema-version bumps doesn't
-- duplicate rows.

-- ═══════════════════════════════════════════════════════════════
-- NODE: Tailscale
-- ═══════════════════════════════════════════════════════════════
INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-tailscale', 'Tailscale', 'reference',
  'Private tailnet access from inside this container via the tailscaled daemon (userspace mode). Lets the agent reach the operator''s compute cluster and other private peers without exposing public IPs.', 9, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-tailscale', 'overview', 10, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='overview');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview'),
         'Tailscale is a mesh WireGuard VPN. Joining the tailnet gives this container private routing to every other member — compute nodes, operator workstations, other Spore Core agents.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview') AND content LIKE 'Tailscale is a mesh WireGuard VPN%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview'),
         'tailscaled runs in userspace-networking mode — no NET_ADMIN cap or /dev/net/tun required. State persists at /data/tailscale/ so login survives container restarts.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview') AND content LIKE 'tailscaled runs in userspace-networking mode%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview'),
         'Enabled per deployment via SPORE_TAILSCALE_ENABLED=true. If disabled, /data/tailscale/ does not exist and tailscaled is not running — enable it in the container env and restart.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='overview') AND content LIKE 'Enabled per deployment via SPORE_TAILSCALE_ENABLED%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-tailscale', 'connection_flow', 9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow'),
         'Login is interactive SSO via Settings → Compute Cluster → "Log in to Tailscale". The button spawns `tailscale up` on the server, captures the login URL, and surfaces it to the operator. They open it, complete SSO, done.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow') AND content LIKE 'Login is interactive SSO%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow'),
         'Once logged in, the daemon auto-reconnects on every container restart without human intervention. State lives in /data/tailscale/state.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow') AND content LIKE 'Once logged in%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow'),
         'If the agent sees "not logged in" / "NeedsLogin", tell the operator to visit Settings → Compute Cluster and click Log in. Do NOT try to start login yourself — the URL has to land in the UI.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='connection_flow') AND content LIKE 'If the agent sees "not logged in"%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-tailscale', 'cli_usage', 9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage'),
         'Socket path: /data/tailscale/ts.sock — always pass it: `tailscale --socket /data/tailscale/ts.sock <cmd>`.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage') AND content LIKE 'Socket path: /data/tailscale%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage'),
         '`tailscale --socket /data/tailscale/ts.sock status --json` → full peer list + your tailnet IP. Same data is available at GET /api/tailscale/status.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage') AND content LIKE '%status --json%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage'),
         '`tailscale ssh user@peer` shells into a tailnet peer without managing host keys (Tailscale SSH handles auth). Prefer this over raw ssh when the target is tailnet-only.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage') AND content LIKE '%tailscale ssh user@peer%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage'),
         '`tailscale ip -4 <peer>` → tailnet IPv4 of a peer; `tailscale ping <peer>` verifies reachability and whether traffic is direct vs DERP-relayed.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-tailscale' AND name='cli_usage') AND content LIKE '%tailscale ip -4%');


