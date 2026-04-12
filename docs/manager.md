# Anima Manager

The Anima Manager is the central control panel for your fleet of agents. It provides a visual dashboard to create, monitor, configure, and manage all your Anima instances from one place — including provider setup, ingress routing, and real-time health monitoring. It runs as a Docker container behind Traefik at `/manager/`.

---

## Setup

```bash
chmod +x setup-manager.sh
./setup-manager.sh
```

The script:
1. Prompts for a username, password, and Traefik domain/HTTPS settings
2. Writes `manager/.env`
3. Creates the `anima-web` Docker network if needed
4. Starts the manager container

After setup the manager is available at `https://<your-domain>/animas` (or `http://localhost:18900` directly).

---

## Features

### Dashboard

The home screen shows all anima instances as cards with:
- Display name and agent ID
- Live health status (green dot = up, red = down)
- Platform badges: Discord, Telegram, Voice, Web

Click any card to open the detail view.

### Detail View — Tabs

Each anima has six configuration tabs:

| Tab | Contents |
|---|---|
| **Identity** | Display name, nicknames, model, learner/subagent models |
| **API Keys** | Discord token, Anthropic key, Telegram token, Brave, Gemini |
| **Voice** | Voice enabled toggle, STT key, TTS provider, voice IDs |
| **Web / Ingress** | Web port, health port, Traefik ingress settings |
| **Permissions** | Auth credentials, host path access, source editability |
| **Tokens** | Token usage dashboard (see below) |

Changes are saved to the agent's `.env`. Restart the container to apply.

### Token Usage Dashboard

The Tokens tab shows a full breakdown of Claude API token consumption:

- **Summary cards** — Today, 7 days, 30 days, All time (tokens, calls, iterations, estimated cost)
- **30-day bar chart** — daily token volume, hover for details
- **Dimension breakdowns** — usage by channel, trigger type, and platform

Cost estimates use `$3/M input · $15/M output` by default (Sonnet pricing).

### Create Anima

Click **+ New Anima** on the dashboard to create a new instance. The manager:
1. Generates an agent ID from the display name
2. Copies the base `src/` as the starting point
3. Creates `data/`, `workspace/`, `anima.json`, `.env`, `docker-compose.yml`
4. Pre-populates blank API key fields from shared defaults

### Delete Anima

Click **Delete** on the detail header. Requires two confirmations. This permanently removes the agent's directory and all data.

### Shared Defaults

Click **⚙ Defaults** in the top bar to open the global defaults panel. Keys set here are automatically applied when creating a new anima with a blank field. Defaults never override keys that are already set on individual animas.

Defaults you can set:
- Anthropic API key, default model
- Brave, Gemini, Replicate, OpenAI API keys
- Deepgram and ElevenLabs keys
- Default TTS provider and Edge voice

---

## Security

The manager uses a hardened Node.js HTTP server:

- **Session authentication** — bcrypt-hashed credentials, secure `HttpOnly` cookies
- **CSRF protection** — per-session token required on all mutating requests
- **Rate limiting** — login attempts are throttled to prevent brute force
- **Input validation** — all env keys are checked against an allowlist; values are length- and character-limited
- **No shell injection** — Docker restart uses `execSync` with a fixed command, not user input
- **Strict file access** — only reads/writes paths under `animas/` using `path.resolve` + prefix checks

See [security.md](security.md) for the full model.

---

## Configuration (`manager/.env`)

| Variable | Description | Default |
|---|---|---|
| `MANAGER_USER` | Login username | `admin` |
| `MANAGER_PASS` | Login password (plaintext, hashed at start) | required |
| `MANAGER_PORT` | Port the server listens on | `18900` |
| `MANAGER_DOMAIN` | Traefik domain | — |
| `MANAGER_ENTRYPOINT` | Traefik entrypoint | `websecure` |
| `MANAGER_CERTRESOLVER` | Traefik cert resolver name | `myresolver` |
| `MANAGER_DOCKER` | `true` to enable container restart via API | `false` |

---

## Accessing Without Traefik

The manager listens on `MANAGER_PORT` (default `18900`). If you are not using Traefik you can access it directly:

```
http://<server-ip>:18900
```

For production, we recommend running Traefik with TLS. The manager's Traefik labels route `/animas` to the container and strip the path prefix automatically.

---

## Troubleshooting

**Cannot log in:**
- Check `MANAGER_USER` and `MANAGER_PASS` in `manager/.env`
- Verify the container is running: `docker ps | grep anima-manager`

**API keys not saving:**
- Only keys in the allowlist are saved — check `ALLOWED_ENV_KEYS` in `manager/server.js` if you need to add a custom key
- The container must have write access to `animas/<id>/.env`

**Health status always "down":**
- The manager tries to reach each agent at `http://<container-name>:<ANIMA_HEALTH_PORT>/health`
- Ensure all containers are on the same `anima-web` Docker network
- Confirm `ANIMA_HEALTH_PORT` in the agent's `.env` matches what is exposed in its `docker-compose.yml`
