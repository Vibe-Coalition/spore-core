# Anima Deployment Guide

Deploy autonomous Anima agents anywhere — from a local machine to a multi-agent Kubernetes cluster. Each deployment includes the Manager UI for visual fleet management and Traefik for unified routing.

## Deployment Options

| Method | Best for | Complexity |
|--------|----------|------------|
| Docker Compose (dev) | Local development, single machine | Low |
| Docker Compose (prod) | Single server production | Medium |
| Fly.io | Quick cloud deploy, small teams | Low |
| Railway | One-click cloud deploy | Low |
| Kubernetes (Helm) | Production at scale, multi-agent | High |

---

## 1. Docker Compose (Development)

The default setup using `new-agent.sh`:

```bash
cd /path/to/anima
./new-agent.sh
```

This creates a per-agent directory under `animas/` with its own `docker-compose.yml`.

## 2. Docker Compose (Production)

Hardened compose with named volumes, resource limits, security options, and internal networking.

```bash
# Build images first
docker compose -f docker-compose.yml --profile build build

# Create .env.prod with your secrets
cp deploy/.env.prod.example deploy/.env.prod
# Edit deploy/.env.prod with your API keys

# Deploy
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
```

### Key differences from dev:
- Health port bound to `127.0.0.1` (not exposed externally)
- Named Docker volumes instead of bind mounts
- Resource limits enforced
- `no-new-privileges` security option
- Internal network for manager-agent communication
- Manager health check as agent dependency

## 3. Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Set secrets
fly secrets set ANTHROPIC_API_KEY=sk-ant-... DISCORD_TOKEN=...

# Create volumes
fly volumes create anima_data --size 1 --region iad

# Deploy
cd deploy/fly
./deploy.sh my-agent
```

See `deploy/fly/fly.toml` for the full configuration.

## 4. Railway

1. Fork the repo to your GitHub
2. Create a new Railway project from the repo
3. Set environment variables in the Railway dashboard
4. Add a persistent volume mounted at `/data`
5. Deploy

See `deploy/railway/README.md` for detailed instructions.

## 5. Kubernetes (Helm)

```bash
# Build and push images to your registry
./deploy/build-push.sh ghcr.io/Klace

# Install the chart
helm install anima deploy/helm/anima \
  --set image.repository=ghcr.io/Klace/anima \
  --set managerImage.repository=ghcr.io/Klace/anima-manager \
  --set agent.agentId=sophia \
  --set agent.displayName=Sophia \
  --set agent.discord.enabled=true

# Set secrets separately
kubectl create secret generic anima-secrets \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=DISCORD_TOKEN=... \
  --from-literal=MANAGER_SERVICE_KEY=$(openssl rand -hex 32)
```

### Multi-agent deployment

```bash
helm install anima deploy/helm/anima \
  --set agent.agentId=sophia \
  --set agents[0].agentId=harry-the-alien \
  --set agents[0].displayName="Harry The Alien" \
  --set agents[0].discord.enabled=true
```

### Key architecture decisions:
- **StatefulSet** per agent (SQLite requires exclusive file access)
- **PVC per agent** for data/ and workspace/
- **NetworkPolicy** restricts inter-pod traffic to manager <-> agents only
- Health port at `0.0.0.0` for kubelet probes (security via NetworkPolicy)

---

## Building Images

```bash
# Local build only
./deploy/build-push.sh

# Build and push to registry
./deploy/build-push.sh ghcr.io/Klace
```

Images are tagged with `:latest`, `:VERSION`, and `:GIT_SHA`.

---

## Environment Variables Reference

### Required
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `DISCORD_TOKEN` | Discord bot token (if using Discord) |

### Security
| Variable | Description | Default |
|----------|-------------|---------|
| `MANAGER_SERVICE_KEY` | Shared secret for inter-agent auth | (none) |
| `HEALTH_BIND_ADDR` | Health server bind address | `127.0.0.1` |
| `ANIMA_DISCORD_ADMINS` | Comma-separated user/role IDs for admin commands | (none) |

### Agent Config
| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_ID` | Unique agent identifier | `anima` |
| `ANIMA_DISPLAY_NAME` | Human-readable name | (from agent ID) |
| `ANIMA_MODEL` | Main LLM model | `claude-sonnet-4-6` |
| `ANIMA_LEARNER_MODEL` | Learner model | `claude-haiku-4-5` |
| `ANIMA_PLUGINS_DIR` | Path to plugins directory | `/workspace/plugins` |

### Storage
| Variable | Description | Default |
|----------|-------------|---------|
| `GRAPH_DB_PATH` | Path to knowledge graph SQLite | `/data/graph.db` |
| `SESSION_DB_PATH` | Path to sessions SQLite | `/data/sessions.db` |
| `ANIMA_WORKSPACE_PATH` | Agent workspace directory | `/workspace` |
