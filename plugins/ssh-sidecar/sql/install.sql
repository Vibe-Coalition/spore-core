-- ssh-sidecar plugin install — agent-facing reference docs for the
-- optional SSH credential-isolation sidecar. Runtime status is exposed in
-- Settings; these nodes describe the operational model.

INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-ssh-sidecar', 'SSH Sidecar', 'reference',
  'Optional plugin-owned sidecar service that stores SSH credentials and opens remote SSH sessions outside the main Spore Core process.',
  7, '{{plugin_id}}');

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-ssh-sidecar', 'runtime_model', 9, '{{plugin_id}}');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='runtime_model'), c, i, 'plugin', '{{plugin_id}}'
FROM (
  SELECT 'The sidecar is optional. When the ssh-sidecar plugin is installed and /run/ssh-sidecar/sidecar.sock is available, SSHManager delegates saved-host operations and interactive SSH sessions over a Unix socket.' AS c, 9 AS i
  UNION ALL SELECT 'If the sidecar plugin is uninstalled or the socket is missing, SSHManager falls back to local encrypted storage in the main process. That preserves functionality but not process isolation for decrypted key material.', 9
  UNION ALL SELECT 'The sidecar owns saved-host CRUD, interactive SSH sessions, remote_exec, and SFTP read/write/list/delete operations. SSH tunnels still require local fallback because the forwarded local port must live in the main container.', 8
  UNION ALL SELECT 'The sidecar also owns credential profiles. A profile can back multiple saved hosts, so plugins such as compute-cluster can generate one cluster key and attach it to primary/additional login hosts without copying decrypted private key material through the main app.', 9
  UNION ALL SELECT 'When a saved host is a Tailscale peer, use the sidecar-backed remote tools with the saved host ID. Do not use tailscale ssh for that host: Tailscale SSH is a different ACL/control-plane auth path and can fail with host-key/control-plane errors even while sidecar OpenSSH works.', 9
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='runtime_model')
    AND extracted_with='{{plugin_id}}'
);

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-ssh-sidecar', 'deployment', 8, '{{plugin_id}}');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='deployment'), c, i, 'plugin', '{{plugin_id}}'
FROM (
  SELECT 'Build image: docker build -t spore-ssh-sidecar:latest plugins/ssh-sidecar/sidecar. Start the compose profile only for instances that need SSH key process isolation.' AS c, 8 AS i
  UNION ALL SELECT 'Set SPORE_SSH_SIDECAR_PASSPHRASE to a long random secret. The plugin deliberately does not reuse the web-login password as the sidecar encryption secret.', 9
  UNION ALL SELECT 'Set SPORE_SSH_SIDECAR_ALLOWED_HOSTS to a comma-separated allowlist when possible. Use exact hostnames or suffixes like .example.internal; default * allows any SSH host.', 8
  UNION ALL SELECT 'The compose template runs the sidecar in the app container network namespace so SSH sessions can use Tailscale userspace SOCKS at 127.0.0.1:1055 without exposing that proxy on the Docker network.', 8
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='deployment')
    AND extracted_with='{{plugin_id}}'
);

INSERT OR IGNORE INTO aspects (node_id, name, weight, extracted_with)
VALUES ('ref-ssh-sidecar', 'security_model', 8, '{{plugin_id}}');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='security_model'), c, i, 'plugin', '{{plugin_id}}'
FROM (
  SELECT 'The sidecar has no inbound ports and does not mount app source. It needs outbound network access to open SSH connections, so host firewalling or SIDECAR_ALLOWED_HOSTS should constrain where it can connect.' AS c, 9 AS i
  UNION ALL SELECT 'The Unix socket is the trust boundary. Any process that can write to it can ask the sidecar to connect to a stored host, but cannot read raw decrypted private keys through the RPC API.', 8
)
WHERE NOT EXISTS (
  SELECT 1 FROM attributes
  WHERE aspect_id = (SELECT id FROM aspects WHERE node_id='ref-ssh-sidecar' AND name='security_model')
    AND extracted_with='{{plugin_id}}'
);

INSERT OR IGNORE INTO edges (source, target, type, weight, extracted_with)
VALUES ('spore', 'ref-ssh-sidecar', 'documents', 0.5, '{{plugin_id}}');
