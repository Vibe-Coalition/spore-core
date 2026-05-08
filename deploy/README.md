# Spore Core Deployment

This directory contains production deployment helpers. The main supported path
is a Docker image with persistent `/data` and `/workspace` volumes.

## Production Compose

Create `deploy/.env.prod` from your deployment values, then run:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
```

The compose file pulls:

```text
ghcr.io/yumlevi/spore:latest
```

Override with:

```text
SPORE_IMAGE=your-registry/spore
SPORE_IMAGE_TAG=your-tag
```

## Required State

Back up these volumes:

- `/data`: settings, users, graph DBs, sessions DB, runtime jobs, backups,
  plugin state, Tailscale state, SSH sidecar state.
- `/workspace`: webapp workspace, uploaded/generated files, user plugins if
  configured there.

The first-run wizard persists settings into `/data`; you do not need to bind
mount `/app/spore.json` or `/app/.env`.

## Ports

- `SPORE_WEB_PORT`, default `18803`: web UI, HTTP API, websocket sessions.
- `SPORE_HEALTH_PORT`, default `18790`: health endpoint.

The production compose binds health to `127.0.0.1` by default:

```yaml
127.0.0.1:${SPORE_HEALTH_PORT:-18790}:${SPORE_HEALTH_PORT:-18790}
```

Expose the health port publicly only if your infrastructure requires it.

## Environment Essentials

Common env vars:

```text
SPORE_AGENT_ID=spore
SPORE_DISPLAY_NAME=Spore
SPORE_WEB_PORT=18803
SPORE_HEALTH_PORT=18790
SPORE_DATA_DIR=/data
SPORE_WORKSPACE_PATH=/workspace
GRAPH_DB_PATH=/data/graph.db
SESSION_DB_PATH=/data/sessions.db
SETTINGS_DB_PATH=/data/settings.db
SPORE_PLUGINS_ENABLED=true
```

Provider and channel keys can be supplied by env or entered in the wizard:

```text
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=
TELEGRAM_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
DISCORD_TOKEN=
```

## Building Locally

```bash
docker build -t spore:latest -f src/Dockerfile .
```

The root `docker-compose.yml` can also build the image:

```bash
docker compose --profile build build
```

## Running With Docker Run

```bash
docker run -d --name spore --restart unless-stopped \
  -p 18803:18803 \
  -p 127.0.0.1:18790:18790 \
  -v spore-data:/data \
  -v spore-workspace:/workspace \
  -e SPORE_WEB_PORT=18803 \
  -e SPORE_HEALTH_PORT=18790 \
  -e SPORE_DATA_DIR=/data \
  -e SPORE_WORKSPACE_PATH=/workspace \
  -e GRAPH_DB_PATH=/data/graph.db \
  -e SESSION_DB_PATH=/data/sessions.db \
  -e SETTINGS_DB_PATH=/data/settings.db \
  -e SPORE_PLUGINS_ENABLED=true \
  spore:latest
```

## Health Check

```bash
curl -fsS http://127.0.0.1:18790/health
```

Healthy output includes connected graph/session state, learner state, model, and
uptime.

## Optional Services

- **Tailscale:** installed in the image and managed by the Tailscale plugin when
  enabled/configured.
- **SSH sidecar:** optional credential isolation boundary; core falls back to
  encrypted local storage if unavailable.
- **Manager mesh:** set `MANAGER_URL` and `MANAGER_SERVICE_KEY` for manager
  integration.

## Updating

1. Pull or build the desired image.
2. Stop and rename the old container for rollback.
3. Start the new container with the same `/data` and `/workspace` volumes.
4. Wait for health to report `ok`.
5. Remove the rollback container after verification.

Do not delete `/data` unless you intentionally want to reset the instance.
