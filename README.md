# Spore Core

Spore Core is the runtime for autonomous AI agents — each one a single process with its own persistent knowledge graph, tool surface, and conversation history across Discord, Telegram, Slack, and a built-in web UI. Memory lives in the graph, not in static prompts; it grows over time and the agent learns from every conversation.

Spore Core is the centerpiece of the **Spore** family:

| Product | What it is | Repo |
|---|---|---|
| **Spore Core** | The runtime + graph + web UI (this repo) | `yumlevi/spore` |
| **Spore Code** | Go CLI binary that pairs a project on your machine to a Spore Core agent for coding sessions | `yumlevi/spore-code` |
| **Spore Go** | React Native mobile companion to follow / drive Spore Code sessions on the go | `yumlevi/spore-go` |

The three connect to the same server and share the same graph; sessions stay scoped to their project / device.

## What it does

- **Visual knowledge graph** — every fact, person, concept, rule, and project the agent encounters becomes a node in a live graph you can navigate, search, and edit through the web UI. It's the agent's memory, exposed.
- **Background workers** — a learner extracts new facts after each turn, a maintainer fills knowledge gaps and writes reflections, a janitor prunes drift, a backup worker snapshots the graph on a schedule. Agents improve without being asked.
- **Multi-platform** — Discord, Telegram (text + voice), Slack (Socket Mode), and a built-in web panel with the graph viewer, file browser, an interactive xterm.js terminal, and a chat surface that mirrors the same agent everywhere.
- **Hybrid retrieval** — embedding similarity (Gemma / Gemini) + FTS5 full-text + temporal proximity + multi-hop graph walks + raw conversation excerpts. Whatever the question shape, the recall pipeline picks an appropriate tier.
- **Tool use + delegation** — `read_file`, `write_file`, `edit_file`, `exec`, `grep`, `glob`, `web_search`, `web_fetch`, `analyze_image/video/audio`, `delegate_task` (sub-agents), graph CRUD, cross-platform `message_send`, `schedule_wakeup`, and a managed browser session for click/type/scroll automation.
- **Voice pipeline** — Deepgram or local Whisper STT, ElevenLabs / OpenAI / Edge TTS, live voice calls with interrupt detection.
- **SSH terminal** — embedded xterm.js with a local PTY and remote-host SSH. Keys encrypted at rest (AES-256-GCM, PBKDF2) and isolated in a network-less sidecar container.
- **Plugin system** — providers, embedders, tools, prompt sections, lifecycle hooks, settings panes — all extensible. 17 plugins ship in the image (see below).

## Quick start

```bash
# Clone + build the image (build context is the repo root)
git clone https://github.com/yumlevi/spore.git && cd spore
docker build -t spore:latest -f src/Dockerfile .

# Create an instance dir with config
mkdir -p animas/myagent/{data,workspace}
cp .env.example animas/myagent/.env
# edit animas/myagent/.env — set SPORE_WEB_PORT, SPORE_HEALTH_PORT, providers, ports, etc.

# Run
docker run -d --name myagent --restart unless-stopped \
  --env-file ./animas/myagent/.env \
  -p 18803:18803 -p 18794:18794 \
  -v $PWD/animas/myagent/data:/data \
  -v $PWD/animas/myagent/workspace:/workspace \
  -v $PWD/animas/myagent/.env:/app/.env \
  -v $PWD/animas/myagent/.env:/data/.env \
  spore:latest

# First-run setup happens in the browser at http://localhost:18803
# (theme → user account → plugins → providers → tier routing → done)
```

`docker compose build` from the repo root works too; it uses `docker-compose.yml` which targets `src/Dockerfile` with the right context.

Requires [Docker](https://docs.docker.com/get-docker/), Node 22 image base. The first launch shows an in-browser onboarding wizard — no install scripts, no manager UI to wire up. Provider keys you enter there persist into the bind-mounted `.env` and survive container rebuilds.

## Bundled plugins

Every plugin below ships in the image. Operators toggle them in **Settings → Plugins** (or via `SPORE_PLUGINS_ENABLED` + per-plugin disable list).

| Plugin | What it does |
|---|---|
| `anthropic-provider` | Claude Opus / Sonnet / Haiku (4.x family). Owns `@anthropic-ai/sdk`. |
| `openai-provider` | OpenAI chat completions. Also serves the whisper plugin's server-side STT. |
| `openrouter-provider` | OpenRouter (sk-or-…). |
| `gemini-provider` | Gemini multimodal (vision, audio, video). |
| `z-ai-provider` | Z.ai (GLM-4.6, GLM-Z1, charglm). |
| `local-oai-provider` | Any OpenAI-compatible endpoint (vLLM / LM Studio / Ollama / llama.cpp). |
| `embedder-gemma` | Local Gemma-300M embeddings via `@huggingface/transformers`. No API key. |
| `gemini-embedder` | Gemini embeddings — shares the GEMINI_API_KEY with `gemini-provider`. |
| `whisper` | Whisper-tiny browser STT + OpenAI server-side STT fallback. |
| `deepgram` | Deepgram cloud STT — fast, multilingual. |
| `elevenlabs` | ElevenLabs TTS + sound effects. |
| `flux` | FLUX image generation via `api.bfl.ai`. |
| `email` | SMTP/IMAP via Nodemailer + ImapFlow. |
| `tailscale` | Tailscale userspace networking. Mesh routing to other Spore Core agents and operator workstations. |
| `compute-cluster` | SLURM cluster access (sbatch / squeue / live tail). |
| `session-graph` | Generic session/project node primitives. Foundation for code-session plugins. |
| `spore-code` | Pairs CLI sessions (`spore` Go binary) into project-scoped agent contexts; powers `/api/spore-code/auth` + `/sessions`. |

Plugins declare config schemas with `envFallback`, so wizard-saved values survive container rebuilds — keys persist in `.env` (bind-mounted) and the Settings UI surfaces them on every boot.

## Web fetch / extraction

`web_fetch` runs `@teng-lin/agent-fetch` as the primary path:

- **Mozilla Readability** (strict + relaxed)
- **Text-density / CETD** for layouts Readability over-trims
- **JSON-LD** schema.org parser
- **`__NEXT_DATA__` / `__NUXT_DATA__`** for SPA frameworks
- **React Server Components** payload parser (Next.js App Router — react.dev, MS Learn, etc.)
- **WordPress REST API** (`/wp-json/wp/v2/`) — picks up ~40 % of the web for free
- **CSS selectors** as fallback for unusual layouts
- Plus its own Chrome TLS fingerprinting via `httpcloak`

Strategies run in parallel and the result with the most substantive content wins. The result includes the matched `extractedFrom` so the agent (and you) can see which path solved each fetch. If the package fails to load for any reason, the tool falls back to `curl_cffi` (Python helper) → raw Node HTTP — no extraction degradation, just slower fingerprinting.

## Architecture

```
Platforms (Discord/Telegram/Slack/Web/Spore Code)
  │
  ▼
GatewayManager ─── VoicePipeline (STT → LLM → TTS)
  │
  ▼
AgentLoop ──── PluginManager ──── 17 bundled + user plugins
  │
  ▼
GraphContext ←→ graph.db (SQLite + WAL)
  │               ├── nodes, edges, attributes, aspects
  │               ├── episodes (raw conversation FTS5)
  │               └── embeddings (vector search)
  │
SessionManager ←→ sessions.db
  │
ToolSystem ←→ SSH Sidecar (Unix socket, no network)
  │
Learner + Maintainer + Janitor + Backup + Proactive (workers)
```

Each instance runs as a single Docker container with its own bind-mounted `data/` (graph + session DBs + backups) and `workspace/` (writable scratch). Provider keys live in `.env` (also bind-mounted). Spore Core itself is unsandboxed inside the container; the SSH credential store is the one piece pushed out to a sidecar with no network access at all.

Platform gateways auto-enable when their tokens are set:

| Gateway | Token(s) needed |
|---|---|
| Discord | `DISCORD_TOKEN` |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| Web panel | `SPORE_WEB_PORT` (+ `SPORE_INVITE_KEY` if you want self-register) |

An agent with no platform tokens still works via the web panel + Spore Code CLI. See [.env.example](.env.example) for the full list.

## Repository structure

```
src/                  Core application
  agent/              Inference loop, session management, tool dispatch
  graph/              Context engine, embeddings, retrieval, activity feed
  workers/            Learner / Maintainer / Janitor / Backup / Proactive
  tools/              Tool definitions, SSH manager, web/curl fetch helpers
  gateways/           Discord, Telegram, Slack, Web (HTTP + WS)
  voice/              STT/TTS pipeline + voice-call orchestrator
  plugins/            Plugin manager core (api.js, manager.js, openclaw-adapter.js)
  static/             graph-viewer.html + mobile-viewer.html + login.html + scripts/

plugins/              17 bundled plugin packages (provider, tool, embedder, …)
sidecar/              SSH credential isolation (separate container, no network)
docs/                 Extended documentation
animas/               Per-instance config + data (gitignored)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System architecture, message flow, design decisions |
| [docs/user-guide.md](docs/user-guide.md) | Web panel, SSH terminal, voice, chat features |
| [docs/security.md](docs/security.md) | Auth model, key encryption, sidecar architecture, threat model |
| [docs/graph.md](docs/graph.md) | Knowledge graph schema reference |
| [docs/voice.md](docs/voice.md) | Voice pipeline configuration |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, repo layout, code style |
| [FOR_AGENTS.md](FOR_AGENTS.md) | Notes for AI agents working in this codebase |

## Security overview

- Containers run as unprivileged user (UID 2000), `no-new-privileges` enforced
- Web panel uses session cookies (HttpOnly + SameSite=Lax); webapp self-register gated behind a host-level `SPORE_INVITE_KEY`
- SSH keys encrypted at rest (AES-256-GCM, PBKDF2) and isolated in a sidecar with zero network access
- `exec` tool blocks dangerous patterns; source editing disabled by default
- All host ports bind to `127.0.0.1` by convention; reverse-proxy publicly with whatever you already run

Full details: [docs/security.md](docs/security.md)

## License

MIT
