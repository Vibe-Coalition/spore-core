# Spore Core — Deployment

Spore Core ships as a single Docker image. The official image is built by
GitHub Actions on every push to `main` and on tagged releases (see
`.github/workflows/docker-publish.yml`) and published to GitHub Container
Registry.

```
ghcr.io/yumlevi/spore:latest          # bleeding edge (main branch)
ghcr.io/yumlevi/spore:v0.3.0          # specific version
ghcr.io/yumlevi/spore:sha-<short>     # specific commit
```

Multi-arch builds: `linux/amd64` + `linux/arm64`.

---

## Quickstart — Docker run

```bash
docker run -d --name spore --restart unless-stopped \
  -p 18803:18803 -p 127.0.0.1:18790:18790 \
  -v spore-data:/data \
  -v spore-workspace:/workspace \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/yumlevi/spore:latest
```

Open <http://localhost:18803> and you should land on the canvas.

---

## Production — Docker Compose

The recommended setup. Pulls the official image, mounts named volumes,
sets resource limits + `no-new-privileges`.

```bash
cp deploy/.env.prod.example deploy/.env.prod
# edit deploy/.env.prod — at minimum set ANTHROPIC_API_KEY (or another
# model provider). Tweak ports / display name / image tag as needed.

docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
```

Tail logs: `docker compose -f deploy/docker-compose.prod.yml logs -f`.

To pin a specific release, set `SPORE_IMAGE_TAG=v0.3.0` in `.env.prod`.
To use a private registry, set `SPORE_IMAGE=registry.example.com/spore-core`.

---

## Multi-spore (Manager) deployments

For running several agents on one box with a shared Manager UI, see the
`spores/` agent-directory convention in the main README. Each agent gets
its own `data/` + `workspace/` + `spore.json` and binds different ports.

---

## Building locally

If you're hacking on Spore Core itself:

```bash
# Build only
./deploy/build-push.sh

# Build and push to your own registry
./deploy/build-push.sh ghcr.io/<your-user>/spore-core
```

The script tags `spore-core:latest`, `spore-core:<version>`, and
`spore-core:<git-sha>`. Build context is the repo root; the Dockerfile
lives at `src/Dockerfile`.

---

## Releasing a new official version

1. Bump `version` in `src/package.json`.
2. Tag the release: `git tag v0.3.1 && git push origin v0.3.1`.
3. The GitHub Actions workflow builds + pushes
   `ghcr.io/<owner>/<repo>:v0.3.1`, `:0.3`, `:0`, and `:latest` automatically.

To trigger an ad-hoc rebuild without a tag, run the workflow from the
Actions tab → *Build and publish official Docker image* → *Run workflow*.

**One-time setup (per repo):** Settings → Actions → General → *Workflow
permissions* → enable **Read and write permissions**. This lets the
workflow push to ghcr.io with the auto-issued `GITHUB_TOKEN` — no extra
secrets needed.

---

## Environment variables (the essentials)

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Or `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` — at least one provider. | (none) |
| `AGENT_ID` | Unique id for this agent's graph + node label. | `spore` |
| `SPORE_DISPLAY_NAME` | Human-readable name. | (from `AGENT_ID`) |
| `SPORE_WEB_PORT` | HTTP port for the web canvas. | `18803` |
| `SPORE_HEALTH_PORT` | HTTP port for `/health` + metrics. | `18790` |
| `GRAPH_DB_PATH` | Knowledge graph SQLite location inside the container. | `/data/graph.db` |
| `SESSION_DB_PATH` | Sessions SQLite location. | `/data/sessions.db` |
| `SPORE_WORKSPACE_PATH` | Writable workspace mount. | `/workspace` |
| `SPORE_WEB_AUTH_USER` / `SPORE_WEB_AUTH_PASS` | HTTP basic auth on the canvas. | (open) |

Optional gateway tokens auto-enable when set:
`DISCORD_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.

Plugin keys are owned by their respective plugins (read in their own
`index.js`). Set them in the env and the corresponding plugin (if
installed) will pick them up: `XI_API_KEY` (elevenlabs),
`DEEPGRAM_API_KEY` (deepgram), `BFL_API_KEY` (flux).

See `deploy/.env.prod.example` for the full reference.
