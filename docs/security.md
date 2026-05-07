# Security

This document describes the security model for Anima and the decisions behind key design choices.

---

## Threat Model

Anima is designed to be deployed on a public-facing server running one or more agent instances behind a reverse proxy (Traefik). The primary threats are:

1. **Unauthorised access to agent web interfaces** (graph viewer, API, files)
2. **Unauthorised access to the Anima Manager**
3. **Prompt injection or tool abuse via untrusted users**
4. **Agent reading or writing sensitive host files**
5. **Information leakage from health endpoints**

---

## Health Endpoint

Each agent exposes a health endpoint on `ANIMA_HEALTH_PORT`. This port should **never** be exposed to the public internet.

- Only `/health` is served — it returns a JSON status object with no sensitive data
- The graph API, token API, and all other endpoints are served separately on `ANIMA_WEB_PORT`
- The host-side port binding in `docker-compose.yml` binds to `127.0.0.1` to prevent external access:

```yaml
ports:
  - "127.0.0.1:18790:18790"
```

---

## Web Interface

The agent's web interface (graph viewer, graph API, token API) lives on `ANIMA_WEB_PORT` and is protected by HTTP Basic Auth:

```bash
ANIMA_WEB_AUTH_USER=alice
ANIMA_WEB_AUTH_PASS=strong-password-here
```

When deployed behind Traefik with `ANIMA_INGRESS_HTTPS=true`, traffic is encrypted end-to-end. The Traefik middleware applies the Basic Auth before any request reaches the container.

The `graph-viewer.html` constructs all API URLs relative to the page's own `window.location` to avoid embedding credentials in HTML.

---

## Anima Manager

The manager (`/animas`) is secured with multiple layers:

### Authentication
- Session-based: `bcryptjs`-hashed password checked at login
- Sessions stored in-memory with `crypto.randomBytes(32)` session IDs
- Secure `HttpOnly`, `SameSite=Strict` cookies
- Sessions expire after 8 hours of inactivity

### CSRF Protection
- Every session gets a `crypto.randomBytes(16)` CSRF token
- All mutating requests (`POST`, `PUT`, `DELETE`) must include `X-CSRF-Token`
- 403 returned on mismatch

### Rate Limiting
- Login endpoint: maximum 10 attempts per IP per 15 minutes
- Returns `429 Too Many Requests` when exceeded

### Input Validation
- All environment key names are checked against an explicit allowlist (`ALLOWED_ENV_KEYS`)
- Values are validated: string type, max 2048 chars, no newlines or null bytes
- File paths are resolved with `path.resolve` and checked against the `animas/` prefix before any read or write

### Docker Operations
- Container restarts require `MANAGER_DOCKER=true` and a Docker socket mount
- The restart command is hardcoded — no user input is passed to the shell

---

## Agent File Access

By default agents can only read and write files inside their `workspace/` directory.

- `ANIMA_SRC_EDITABLE=true` allows the agent to modify its own source code — **use only for trusted deployments**
- `ANIMA_PERSONALITY_EDITABLE=true` allows the agent to modify its own `anima.json` identity — generally safe for self-evolving agents
- `ANIMA_HOST_READ_PATHS` mounts additional host directories read-only — restricted by the `_safePath` check in `tools.js`

The `_safePath` function in `tools.js` resolves all paths with `path.resolve` and rejects any path that is not a prefix-match under an approved directory.

---

## Plugin System

The plugin loader (`src/plugins/manager.js`) `require()`s plugin entry points directly — there is **no sandbox**. A loaded plugin runs as full-privilege Node code in the same process as the agent, can read any environment variable, can modify the agent's runtime, and can call out over the network.

For that reason plugins are **opt-in and operator-managed**:

- **Disabled by default.** `SPORE_PLUGINS_ENABLED` must be explicitly set to `true` to enable plugin loading.
- **Default directory is `<repo>/shared/plugins/`**, not the agent's workspace. This is intentional: the workspace is writable by the agent's own `write_file` and `exec` tools, so a prompt-injection or compromised model run could otherwise drop a plugin and gain remote code execution at the next boot.
- **Workspace overlap is refused.** If `SPORE_PLUGINS_DIR` is set to a path inside `SPORE_WORKSPACE_PATH`, `loadAll` logs an error and skips loading rather than running plugins from agent-writable storage.
- **No signature, hash, or manifest allowlist.** Plugins are trusted on the basis of where they live on disk. Treat the plugins directory the same way you treat the agent's `.env` — any user who can write to it can execute arbitrary code in the agent process.

If you don't need plugins, leave `SPORE_PLUGINS_ENABLED` unset. If you do, point `SPORE_PLUGINS_DIR` at an operator-owned directory and review every plugin you put there.

---

## Discord / Telegram Tokens

Bot tokens are stored only in the agent's `.env` file and mounted as environment variables into the container. They are never logged, never returned by the health endpoint, and never exposed via the graph API.

The Anima Manager masks sensitive keys in API responses: only the first 6 and last 4 characters are shown in the UI, and values are never stored in manager memory.

---

## CORS

The graph API uses a `Referer`-based CORS check. In production, `Access-Control-Allow-Origin` is set to the agent's own domain, not `*`. If the `Referer` header is absent or does not match, the request is rejected.

---

## SSH Terminal & Credential Isolation

The web panel includes an interactive terminal with local PTY and remote SSH support. SSH private keys require special handling because they grant persistent access to remote systems.

### Encryption at Rest

SSH keys and passwords are encrypted with AES-256-GCM before being written to disk. Local fallback mode stores them in `/data/ssh-hosts.json` and derives the key from `SPORE_WEB_AUTH_PASS` when available, or from an operator-entered keystore passphrase. Sidecar mode stores them in the sidecar data mount and derives the key from `SPORE_SSH_SIDECAR_PASSPHRASE`. Without the relevant passphrase, the stored file is cryptographically opaque.

Sidecar mode also supports credential profiles. A plugin can generate a key inside the sidecar, attach that profile to multiple hosts, and expose only public key metadata to the main app. The compute-cluster plugin uses this for its `cluster-default` profile so the agent never needs an explicit keystore unlock and cannot retrieve the private key through any supported RPC.

### Credential Isolation Sidecar

To reduce key exposure if the main Spore process is compromised, the optional `ssh-sidecar` plugin can run saved-host operations, interactive SSH sessions, remote exec, and SFTP operations in a **separate sidecar container**:

```
┌──────────────────────────┐          ┌────────────────────────┐
│   Spore Core Container   │          │   SSH Sidecar          │
│                          │          │                        │
│   ssh-manager.js         │  Unix    │   ssh-sidecar.js       │
│   (thin RPC client)     ◄──Socket──►   (key store + ssh2)   │
│                          │          │                        │
│   Sees: terminal I/O     │          │   Sees: decrypted keys │
│   Never: raw keys        │          │   Network: outbound SSH│
└──────────────────────────┘          └────────────────────────┘
```

**Sidecar properties:**
- No inbound ports; communicates only through the shared Unix socket
- Outbound network is required to open SSH connections. Restrict it with `SPORE_SSH_SIDECAR_ALLOWED_HOSTS` and host firewall/container-network policy where possible
- Communicates only via a Unix domain socket at `/run/ssh-sidecar/sidecar.sock`
- The socket is mounted read-only into the main container
- The supported RPC API does not return private key material. A compromised main process can still ask the sidecar to use or mutate credentials while the socket is mounted, so treat socket access as privileged.
- Runs as unprivileged `spore` user (UID 2000)
- Runs with `no-new-privileges`, `cap_drop: ALL`, read-only root filesystem, and a dedicated sidecar data mount in the compose template
- Memory-limited to 64MB
- The sidecar passphrase is separate from web login: set `SPORE_SSH_SIDECAR_PASSPHRASE`

**Threat model for SSH keys:**

| Threat | Mitigation |
|---|---|
| Attacker reads the SSH host store from disk | Keys are AES-256-GCM encrypted; useless without the local keystore passphrase or `SPORE_SSH_SIDECAR_PASSPHRASE` |
| Attacker gets RCE in the main Spore process | In sidecar mode they cannot read raw saved-host keys through supported APIs, but they can issue allowed RPCs over the Unix socket while it is mounted |
| Attacker gets RCE in the sidecar | They can access decrypted keys in memory and use the sidecar's outbound network path. Mitigate with host allowlists, no inbound ports, no app-source mount, and firewall egress controls |
| Attacker intercepts the Unix socket | Socket has `0660` permissions owned by `spore:spore`. Requires container-level access which implies RCE already |
| Sidecar passphrase is weak | Sidecar-encrypted host data is only as strong as `SPORE_SSH_SIDECAR_PASSPHRASE`; use a long random secret |

### Fallback Mode

If the sidecar plugin is uninstalled or `/run/ssh-sidecar/sidecar.sock` is unavailable, `ssh-manager.js` falls back to in-process mode where keys are encrypted/decrypted locally. This provides encryption at rest but not process isolation. The sidecar is strongly recommended for deployments where saved SSH keys grant access to production systems.

### Audit Logging

All terminal sessions (local and SSH) are logged to `/data/terminal-audit.log` with timestamps, session IDs, and connection metadata. Terminal I/O content is not logged by default.

---

## Exec Tool Hardening

The `exec` tool in `tools.js` blocks dangerous shell commands via a `dangerousPatterns` regex list. Blocked categories include:

- Destructive file operations (`rm -rf /`, `mkfs`, `dd`)
- Privilege escalation (`sudo` except `apt-get`/`apt`/`dpkg`, `doas`, `pkexec`)
- Environment exfiltration (`printenv`, `/proc/*/environ`, `env`, `declare -x`)
- Cloud metadata probing (`curl 169.254.*`, metadata endpoints)
- Network/namespace manipulation (`iptables`, `nsenter`, `unshare`, `mount`)
- Sensitive file access (`/etc/shadow`, `/etc/passwd`)

### Sub-Agent Tool Restriction

Sub-agents spawned via the `delegate_task` tool receive a restricted tool set. The following tools are **excluded** from sub-agents to limit prompt-injection blast radius:

- `env_manage` — prevents secret exfiltration
- `remote_exec` — prevents SSH command execution on remote hosts
- `remote_read_file` / `remote_write_file` — prevents SSH file operations

Sub-agents that need API keys should receive them in the task context from the parent agent.

### Secret Redaction

The `env_manage` tool's `get_raw` action does not return secret values directly to the LLM. Instead, it writes the value to a temporary file (`/tmp/.env-KEY-TIMESTAMP`, mode 0600) with a 5-minute auto-deletion timer, and returns the file path. This prevents secrets from appearing in conversation history or logs.

---

## Package Install Vetting

All package install commands (`npm install`, `pip install`, `yarn add`, `pnpm add`, `gem install`, `cargo install`) are intercepted and vetted against live registries **before execution**. This defends against supply-chain attacks, typosquatting, and recently compromised packages (e.g., the LiteLLM incident).

### What Gets Checked

| Check | npm | pip | Risk Level |
|---|---|---|---|
| **Known vulnerabilities** — npm bulk advisory API, OSV.dev | ✓ | ✓ | Block (critical/high) or Warn |
| **Package age** — packages created < 7 days ago | ✓ | ✓ | Block |
| **Version freshness** — specific version published < 3 days ago | ✓ | ✓ | Block |
| **Typosquatting** — Levenshtein distance ≤ 1 from popular packages, common naming tricks (`nodeaxios`, `requestslib`, `expresss`) | ✓ | ✓ | Block |
| **Install scripts** — `preinstall`/`postinstall` hooks | ✓ | — | Warn |
| **Single-version packages** — only 1 version ever published | ✓ | ✓ | Warn |
| **No maintainers** — zero listed maintainers | ✓ | ✓ | Warn |
| **Yanked versions** — version removed by maintainer | — | ✓ | Block |
| **Deprecated packages** | ✓ | — | Warn |
| **Source-only installs** — no wheel available, runs setup.py | — | ✓ | Warn |

### Risk Levels

- **Block** — install is refused. The agent is told to ask the user for approval. The user receives a message with the specific findings.
- **Warn** — install proceeds, but the user receives a warning message listing the findings.
- **OK** — silent pass, no notification.

### Fail-Open Design

If the package registry is unreachable (network error, timeout), the install is allowed with a warning rather than blocking all installs. This prevents registry outages from breaking legitimate work.

### Implementation

The vetting logic lives in `src/tools/package-vet.js` and is called from `_execTool` in `src/tools/tools.js` before the command is passed to the shell. The parser handles version specifiers (`lodash@4.17.21`, `requests==2.31.0`), scoped packages (`@anthropic-ai/sdk`), extras (`package[extra]`), and flags are correctly skipped. `pip install -r requirements.txt` is not vetted (file-based installs cannot be statically parsed).

### Example

```
User: "install the expresss package"
Agent runs: npm install expresss

🛡️ Package install blocked
🚫 BLOCKED packages:
  • expresss (npm): Only 1 version ever published; Possible typosquat of "express" (distance: 1)
```

---

## Container Privilege Model

All agent containers run as unprivileged user `anima` (UID/GID 2000) via `setpriv` in the entrypoint. The `no-new-privileges` security option is enforced.

Package installation is supported via a restricted `sudoers` policy: the `anima` user can run `apt-get`, `apt`, and `dpkg` as root — no other commands.

---

## Recommendations

1. **Never expose `ANIMA_HEALTH_PORT` externally.** It is for container health checks only.
2. **Use HTTPS in production.** Run `setup-traefik.sh` and set `ANIMA_INGRESS_HTTPS=true`.
3. **Set strong passwords** for `ANIMA_WEB_AUTH_PASS` and the manager credentials (minimum 12 characters, mixed case + numbers).
4. **Do not enable `ANIMA_SRC_EDITABLE`** unless you fully trust the agent and its users.
5. **Rotate API keys regularly**, especially if you share them across many animas.
6. **Keep the manager on a non-default port** and behind Traefik — do not bind `18900` to `0.0.0.0` on a public server.
7. **Deploy the `ssh-sidecar` plugin profile** when storing production SSH keys. Do not rely on fallback mode for production SSH credentials.
8. **Use SSH key authentication** over passwords when possible. Keys can be rotated and revoked independently.
9. **Review the audit log** (`/data/terminal-audit.log`) periodically for unexpected SSH connections.
10. **Do not bypass package vetting.** If a package is blocked, investigate the findings before overriding. Typosquat and supply-chain attacks are the most common vector for agent-driven compromise.

---

## Reporting Issues

If you discover a security vulnerability, please open a private issue or contact the maintainer directly rather than publishing it publicly.
