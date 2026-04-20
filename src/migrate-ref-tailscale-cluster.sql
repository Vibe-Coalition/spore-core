-- Idempotent migration: add ref-tailscale + ref-compute-cluster reference nodes.
-- Safe to re-run: guards every aspect + attribute insert with WHERE NOT EXISTS.
-- Deliberately verbose so old installs and fresh installs both land cleanly.

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
         'Tailscale is a mesh WireGuard VPN. Joining the tailnet gives this container private routing to every other member — compute nodes, operator workstations, other Spore agents.',
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


-- ═══════════════════════════════════════════════════════════════
-- NODE: Compute Cluster (SLURM) — enhanced with concrete workflows
-- ═══════════════════════════════════════════════════════════════
INSERT OR IGNORE INTO nodes (id, label, type, description, importance, extracted_with)
VALUES ('ref-compute-cluster', 'Compute Cluster (SLURM)', 'reference',
  'The operator runs a SLURM cluster (CPU + GPU nodes) reachable only over tailscale. The agent SSHs to the configured login host and submits jobs via sbatch / srun. Long-running work MUST survive SSH disconnects — use sbatch (SLURM owns the job) or tmux (SSH owns the shell).', 10, 'seed');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'overview', 10, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview'),
         'Access path: tailscale connected → SSH to the login host as config.clusterUsername → submit jobs (sbatch) or open interactive allocations (srun). Never log in directly to a compute node except when debugging a known running job.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview') AND content LIKE 'Access path: tailscale connected%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview'),
         'Two disconnect-survival mechanisms in the agent''s toolbelt: (1) SLURM — sbatch jobs run under the scheduler, SSH drops do not affect them; (2) tmux — via remote_exec tmux_session:"name", the shell on the login node survives SSH drops. Know which one applies to your task.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='overview') AND content LIKE 'Two disconnect-survival mechanisms%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'settings_source', 9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source'),
         'Cluster username, login host, default SLURM partition, and tmux session prefix live in Settings → Compute Cluster. Read at runtime as config.clusterUsername, config.clusterLoginHost, config.clusterDefaultPartition, config.clusterTmuxPrefix.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source') AND content LIKE 'Cluster username, login host%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source'),
         'Before any cluster work, verify those settings are populated. If empty, tell the operator to fill them in — do not guess.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='settings_source') AND content LIKE 'Before any cluster work%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'workflow_sbatch', 10, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch'),
         'PATTERN — training / long batch job (hours to days, hands-off): write an sbatch script on the login node, submit, poll status. sbatch jobs run under the scheduler; SSH drops never kill them. No tmux wrapper needed for the sbatch call itself.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch') AND content LIKE 'PATTERN — training%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch'),
         'Minimal script shape: `#!/bin/bash` + `#SBATCH --partition=<p> --gres=gpu:1 --time=8:00:00 --output=/home/$USER/logs/%j.out --error=/home/$USER/logs/%j.err` + module loads + `python train.py`. Keep one job script per task so log files are easy to trace.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch') AND content LIKE 'Minimal script shape%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch'),
         'Submit: `remote_exec { host:"cluster-login", command:"sbatch train.sh" }` → returns `Submitted batch job <id>`. Monitor: `squeue -u $USER -j <id>`. Detail: `scontrol show job <id>`. Post-mortem: `sacct -j <id> --format=JobID,State,ExitCode,Elapsed,MaxRSS`.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch') AND content LIKE 'Submit: `remote_exec%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch'),
         'Follow logs live from SPORE: `remote_exec { host:"cluster-login", tmux_session:"tail-<jobid>", command:"tail -f /home/$USER/logs/<jobid>.out" }`. The `tail -f` stays alive inside tmux; call remote_tail later to see the latest lines. Kill when done: remote_tmux_kill.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch') AND content LIKE 'Follow logs live%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch'),
         'Cancel: `scancel <id>` (your jobs only unless admin). Re-queue a failed job: edit the script, `sbatch` again — do not resurrect the old job id.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_sbatch') AND content LIKE 'Cancel: `scancel%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'workflow_srun_interactive', 10, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive'),
         'PATTERN — interactive debugging on a compute node (minutes to hours, hands-on): srun stays in the foreground and dies if its shell dies, so you MUST wrap it in tmux on the login node. That way the SLURM allocation and the REPL survive SSH drops.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive') AND content LIKE 'PATTERN — interactive debugging%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive'),
         'Open: `remote_exec { host:"cluster-login", tmux_session:"gpu-dev", wait:false, command:"srun --partition=gpu --gres=gpu:1 --pty bash" }`. Returns immediately with the session name. Reattach to see the prompt: `remote_tail { tmux_session:"gpu-dev" }`.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive') AND content LIKE 'Open: `remote_exec%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive'),
         'Run commands inside the allocation: there''s no great way to pipe individual commands into a pty inside a running tmux. Usually you open srun interactively once, then do the work yourself. For programmatic compute, prefer workflow_oneshot_srun or workflow_sbatch.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive') AND content LIKE 'Run commands inside the allocation%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive'),
         'When done: `remote_tmux_kill { tmux_session:"gpu-dev" }` — kills the tmux session AND releases the SLURM allocation at the same time (since srun was its only child).',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_srun_interactive') AND content LIKE 'When done: `remote_tmux_kill%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'workflow_oneshot_srun', 10, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun'),
         'PATTERN — run one command on a compute node and get its output back (short to medium, scripted). srun with an explicit command (no --pty). Wrap in tmux so SSH drops do not kill it.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun') AND content LIKE 'PATTERN — run one command%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun'),
         'Example: `remote_exec { host:"cluster-login", tmux_session:"nvsmi-once", command:"srun --partition=gpu --gres=gpu:1 nvidia-smi" }`. Blocks until srun exits, captures the output, returns it. No --pty.',
         10, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun') AND content LIKE 'Example: `remote_exec%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun'),
         'For anything that may run longer than the remote_exec timeout, pass wait:false and come back with remote_tail later. The tmux session persists.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_oneshot_srun') AND content LIKE 'For anything that may run longer%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'workflow_direct_node', 9, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node'),
         'PATTERN — run on a specific compute node without SLURM queueing (e.g. a long-lived inference server, quick debug attach to an already-running job). SSH from login → that node, wrapped in tmux ON the login node so the chain survives disconnects.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node') AND content LIKE 'PATTERN — run on a specific%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node'),
         'Find the node a job is running on: `squeue -j <id> -o %N` → e.g. `gpu-node-07`. Then: `remote_exec { host:"cluster-login", tmux_session:"serve-node07", wait:false, command:"ssh gpu-node-07 \"cd /scratch/$USER/proj && python serve.py\"" }`. Tmux lives on the login node; the inner ssh runs on the compute node.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node') AND content LIKE 'Find the node a job%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node'),
         'Caveat: jobs started this way are NOT tracked by SLURM — they can be killed by the scheduler if it allocates the same node to someone else. Only use outside SLURM when you own the node or for very short debug sessions.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_direct_node') AND content LIKE 'Caveat: jobs started%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'workflow_data_transfer', 8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer'),
         'rsync over the tailnet: `rsync -avz --progress src/ user@login.tailnet.ts.net:/scratch/$USER/proj/`. For large transfers, wrap in tmux: `remote_exec { host:"cluster-login", tmux_session:"rsync-dataset", wait:false, command:"rsync -avz ..." }`. Monitor with remote_tail.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer') AND content LIKE 'rsync over the tailnet%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer'),
         'Pull checkpoints back: reverse the direction. SFTP via remote_read_file / remote_write_file is fine for small files (under 10MB each).',
         7, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='workflow_data_transfer') AND content LIKE 'Pull checkpoints back%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'gpu_vs_cpu', 8, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu'),
         'GPU jobs require `--gres=gpu:1` (or higher) plus a GPU-capable partition. The operator''s default partition is in settings (config.clusterDefaultPartition).',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu') AND content LIKE 'GPU jobs require%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu'),
         'If the operator does not specify, ask which partition and whether GPU is needed before submitting — wrong partition = instant rejection or quota waste.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='gpu_vs_cpu') AND content LIKE 'If the operator does not specify%');

INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'data_paths', 7, 'seed'
  WHERE NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='data_paths');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='data_paths'),
         'Placeholder — cluster storage paths (scratch, shared, home) are not pre-seeded. When the operator tells you where things live, record the facts on this aspect so future sessions find them fast.',
         7, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-compute-cluster' AND name='data_paths')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-compute-cluster' AND name='data_paths') AND content LIKE 'Placeholder —%');


-- ═══════════════════════════════════════════════════════════════
-- tmux_persistence aspect on ref-ssh-remote
-- ═══════════════════════════════════════════════════════════════
INSERT INTO aspects (node_id, name, weight, extracted_with)
  SELECT 'ref-ssh-remote', 'tmux_persistence', 9, 'seed'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='ref-ssh-remote')
    AND NOT EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence');

INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence'),
         'remote_exec supports tmux_session:"<name>" — runs the command inside a named tmux session on the remote host so SSH drops do not kill it. Essential for cluster jobs and long-running remote scripts.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence') AND content LIKE 'remote_exec supports tmux_session%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence'),
         'Companion tools: remote_tail { host, tmux_session, lines } captures current pane output; remote_tmux_kill { host, tmux_session } stops the session.',
         9, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence') AND content LIKE 'Companion tools: remote_tail%');
INSERT INTO attributes (aspect_id, content, importance, source, extracted_with)
  SELECT (SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence'),
         'Session names auto-prefix with config.clusterTmuxPrefix (default "spore-"). Pass a short descriptive tag like "build-x" or "train-ep12" — the prefix is applied for you.',
         8, 'seed', 'seed'
  WHERE EXISTS (SELECT 1 FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence')
    AND NOT EXISTS (SELECT 1 FROM attributes WHERE aspect_id=(SELECT id FROM aspects WHERE node_id='ref-ssh-remote' AND name='tmux_persistence') AND content LIKE 'Session names auto-prefix%');


-- ═══════════════════════════════════════════════════════════════
-- Edges: connect new refs into the graph
-- ═══════════════════════════════════════════════════════════════
INSERT INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-tailscale', 'documents', 0.8, 'seed'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='spore')
    AND EXISTS (SELECT 1 FROM nodes WHERE id='ref-tailscale')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-tailscale' AND type='documents');

INSERT INTO edges (source, target, type, weight, extracted_with)
  SELECT 'spore', 'ref-compute-cluster', 'documents', 0.9, 'seed'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='spore')
    AND EXISTS (SELECT 1 FROM nodes WHERE id='ref-compute-cluster')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE source='spore' AND target='ref-compute-cluster' AND type='documents');

INSERT INTO edges (source, target, type, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'ref-tailscale', 'depends_on', 0.9, 'seed'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='ref-compute-cluster')
    AND EXISTS (SELECT 1 FROM nodes WHERE id='ref-tailscale')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE source='ref-compute-cluster' AND target='ref-tailscale' AND type='depends_on');

INSERT INTO edges (source, target, type, weight, extracted_with)
  SELECT 'ref-compute-cluster', 'ref-ssh-remote', 'depends_on', 0.9, 'seed'
  WHERE EXISTS (SELECT 1 FROM nodes WHERE id='ref-compute-cluster')
    AND EXISTS (SELECT 1 FROM nodes WHERE id='ref-ssh-remote')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE source='ref-compute-cluster' AND target='ref-ssh-remote' AND type='depends_on');
