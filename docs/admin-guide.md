# Admin Guide

This guide covers deployment, configuration, and operational management of Anima agents. Each agent is an autonomous system with its own identity, knowledge graph, and platform connections — managed centrally through the Manager UI or individually via configuration files.

---

## Deployment Overview

Each Anima runs as a Docker Compose stack with two containers:

| Container | Purpose | Network |
|---|---|---|
| `<agent-id>` | Main agent (web UI, chat, gateways, tools) | Full network access |
| `<agent-id>-ssh-sidecar` | SSH credential isolation | `network_mode: none` |

Both containers share a data volume (`./data`) and a Unix socket volume for IPC.

---

## Creating a New Agent

```bash
./new-agent.sh
```

The interactive wizard covers:
- Agent name and display name
- Personality and nicknames
- Platform tokens (Discord, Telegram, Slack)
- DM access policy (open, pairing, allowlist)
- Voice pipeline (STT + TTS providers)
- Web port and Traefik ingress
- Source editability and host filesystem access

Each agent gets its own directory under `animas/<agent-id>/` with a complete source copy, data directory, workspace, and environment file.

### Cloning an Existing Agent

```bash
./new-agent.sh new-name --from existing-name
```

This copies the source, config, and identity from an existing agent.

---

## Reconfiguring an Agent

```bash
./configure-anima.sh
```

Select an agent from the list to modify its `.env`, `anima.json`, or Docker Compose configuration. Changes take effect after a restart.

---

## Directory Structure (Per Agent)

```
animas/<agent-id>/
├── src/                    Agent's source code (bind-mounted to /app)
├── data/                   Persistent data
│   ├── graph.db            Knowledge graph (SQLite)
│   ├── sessions.db         Chat session history
│   ├── ssh-hosts.json      Encrypted SSH host configs
│   └── terminal-audit.log  Terminal session audit log
├── workspace/              Scratch space + web files
│   ├── web/                Files served by web_serve tool
│   └── plugins/            Plugin directory
├── .env                    Secrets and per-agent config
├── anima.json              Identity, personality, channel policies
├── brand.json              Visual branding (colors, logo)
└── docker-compose.yml      Container orchestration
```

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |

### Agent Identity

| Variable | Description | Default |
|---|---|---|
| `AGENT_ID` | Root identity node ID | `anima` |
| `ANIMA_MODEL` | Claude model for main inference | `claude-sonnet-4-6` |
| `ANIMA_DISPLAY_NAME` | How the agent introduces itself | from `anima.json` |
| `ANIMA_LEARNER_MODEL` | Model for fact extraction | `claude-haiku-4-5` |
| `ANIMA_SUBAGENT_MODEL` | Model for background tasks | main model |

### Web & Security

| Variable | Description |
|---|---|
| `ANIMA_WEB_PORT` | HTTP server port |
| `ANIMA_WEB_AUTH_USER` | Basic auth username for web panel |
| `ANIMA_WEB_AUTH_PASS` | Basic auth password (also encrypts SSH keys) |
| `ANIMA_HEALTH_PORT` | Health check port (bind to localhost only) |

### Platforms

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack App-Level token (`xapp-...`) |

### AI Services

| Variable | Description |
|---|---|
| `BRAVE_API_KEY` | Web search |
| `GEMINI_API_KEY` | Semantic embeddings |
| `REPLICATE_API_TOKEN` | Image generation (FLUX, SD, etc.) |
| `OPENAI_API_KEY` | Whisper STT / OpenAI TTS |

### Voice

| Variable | Description | Default |
|---|---|---|
| `DEEPGRAM_API_KEY` | Deepgram STT | — |
| `XI_API_KEY` | ElevenLabs TTS | — |
| `ANIMA_TTS_PROVIDER` | `elevenlabs`, `openai`, `edge`, or auto | auto |
| `ANIMA_TTS_VOICE` | ElevenLabs voice ID | — |
| `ANIMA_TTS_EDGE_VOICE` | Edge TTS voice name | `en-US-AriaNeural` |

### Ingress (Traefik)

| Variable | Description |
|---|---|
| `ANIMA_INGRESS_MODE` | `traefik` or unset |
| `ANIMA_INGRESS_DOMAIN` | Domain for Traefik routing |
| `ANIMA_INGRESS_PATH` | URL path prefix |
| `ANIMA_INGRESS_HTTPS` | `true` to enable Let's Encrypt TLS |

### Permissions

| Variable | Description | Default |
|---|---|---|
| `ANIMA_SRC_EDITABLE` | Agent can modify its own source | `false` |
| `ANIMA_PERSONALITY_EDITABLE` | Agent can edit `anima.json` | `false` |
| `ANIMA_HOST_READ_PATHS` | Comma-separated host paths (read-only) | — |

### Behaviour

| Variable | Description | Default |
|---|---|---|
| `ANIMA_HEARTBEAT_MINUTES` | Periodic reflection interval | `120` |
| `ANIMA_DEBOUNCE_MS` | Message debounce for batch replies | `800` |
| `ANIMA_CONTEXT_WINDOW` | Max context window tokens | `200000` |
| `ANIMA_MAX_TOKENS` | Max output tokens per turn | `8192` |
| `ANIMA_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

---

## SSH Sidecar

The SSH sidecar is a separate container that provides credential isolation for SSH keys. It is automatically included in new agents created with `new-agent.sh`.

### How It Works

1. The sidecar starts first and listens on a Unix domain socket
2. The main Anima container connects to the socket on startup
3. All SSH operations (save key, connect, disconnect) are RPC calls over the socket
4. The sidecar decrypts keys internally and manages `ssh2` connections
5. Only terminal I/O data crosses the socket — never raw keys

### Configuration

The sidecar uses these environment variables (set automatically in `docker-compose.yml`):

| Variable | Description |
|---|---|
| `SIDECAR_PASSPHRASE` | Encryption key (defaults to `ANIMA_WEB_AUTH_PASS`) |
| `SIDECAR_SOCKET` | Unix socket path (default: `/run/ssh-sidecar/sidecar.sock`) |
| `SIDECAR_STORE` | Key store file (default: `/data/ssh-hosts.json`) |

### Adding to Existing Agents

For agents created before the sidecar was available, add the sidecar service to their `docker-compose.yml`:

```yaml
services:
  anima:
    # ... existing config ...
    volumes:
      - ssh-sidecar-sock:/run/ssh-sidecar:ro  # add this
    depends_on:
      ssh-sidecar:
        condition: service_started

  ssh-sidecar:
    image: anima-ssh-sidecar:latest
    container_name: <agent-id>-ssh-sidecar
    restart: unless-stopped
    network_mode: "none"
    security_opt:
      - no-new-privileges:true
    environment:
      - SIDECAR_PASSPHRASE=${ANIMA_WEB_AUTH_PASS:-changeme}
    volumes:
      - ssh-sidecar-sock:/run/ssh-sidecar
      - ./data:/data
    deploy:
      resources:
        limits:
          memory: 64M

volumes:
  ssh-sidecar-sock:
```

Then rebuild: `docker compose up -d --build`

### Without the Sidecar

If you don't need SSH or prefer the simpler setup, the terminal still works — `ssh-manager.js` falls back to in-process encrypted key storage. Local shell (PTY) always works regardless of sidecar status.

---

## Anima Manager

The manager web UI (`setup-manager.sh`) provides a dashboard for all agents:

- **Dashboard** — health status, resource usage, grouped by owner
- **Configuration** — edit `.env`, `anima.json`, platform tokens
- **Token usage** — 30-day usage chart, cost estimates, channel breakdowns
- **User management** — create accounts, assign roles (super users only)
- **Agent creation/deletion** — from the UI

### User Roles

| Role | Access |
|---|---|
| **super** | All agents, user management, shared defaults |
| **user** | Only agents where `ANIMA_OWNER` matches their username |

---

## Common Operations

### Restart an Agent

```bash
cd animas/<agent-id> && docker compose restart
```

### Rebuild After Source Changes

```bash
cd animas/<agent-id> && docker compose up -d --build -V
```

The `-V` flag recreates anonymous volumes (important when `package.json` dependencies change).

### View Logs

```bash
docker logs -f <agent-id>
docker logs -f <agent-id>-ssh-sidecar
```

### Backup an Agent

```bash
cp -r animas/<agent-id>/data /backups/<agent-id>-$(date +%Y%m%d)
```

The critical files are `graph.db` (knowledge), `sessions.db` (chat history), and `.env` (secrets).

### Update All Agents (Shared Source)

For agents using shared source (non-editable, bind-mounted from `../../src/`):

```bash
# Pull latest code
git pull

# Rebuild base image
docker build -t anima:latest src/

# Restart all agents
for d in animas/*/; do (cd "$d" && docker compose restart); done
```

For agents with `SRC_EDITABLE=true` (own source copy), update their `src/` individually or rebuild with `docker compose up -d --build -V`.

---

## Troubleshooting

### Agent won't start

Check logs: `docker logs <agent-id>`. Common issues:
- Missing `ANTHROPIC_API_KEY`
- Port conflict (another agent on the same `ANIMA_HEALTH_PORT`)
- Invalid `anima.json` syntax

### SSH terminal shows "Permission denied"

The shell runs as user `anima` (UID 2000). Ensure `/workspace` is writable:
```bash
docker exec <agent-id> ls -la /workspace
```

### SSH sidecar not connecting

Check sidecar logs: `docker logs <agent-id>-ssh-sidecar`. Verify the socket volume:
```bash
docker exec <agent-id> ls -la /run/ssh-sidecar/
```

### Knowledge graph seems stale

The maintainer runs on a schedule (default: every 30 minutes after boot). To trigger manually, ask the agent: "please run your maintenance cycle."

### Voice not working

1. Check `DEEPGRAM_API_KEY` is set in `.env`
2. Check logs for `[voice] Pipeline ready`
3. Edge TTS (free) should always work as fallback — verify with `ANIMA_TTS_PROVIDER=edge`
