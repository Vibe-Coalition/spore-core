# Anima

Autonomous AI agents that observe, learn, and act. Each Anima runs as a persistent process with its own identity, visual knowledge graph, and conversation history across Discord, Telegram, Slack, and a built-in web interface.

## What it does

- **Visual observation** — a real-time knowledge graph visualises everything the agent knows: people, concepts, rules, and relationships. The graph is the agent's living memory, searchable and editable through an interactive canvas.
- **Agentic autonomy** — background workers continuously learn from conversations, fill knowledge gaps, generate reflections, and reach out proactively. Agents improve without being asked.
- **Multi-platform** — Discord, Telegram (text + voice), Slack (Socket Mode), and a built-in web panel with graph visualization, file browser, and interactive terminal.
- **Rich retrieval** — hybrid keyword/vector search (Gemini embeddings), FTS5 full-text, temporal proximity scoring, multi-hop graph walks, and raw conversation excerpt fallback.
- **Tool use + delegation** — shell exec, file I/O, web search/fetch, cross-platform messaging, graph queries, and async background sub-agents.
- **Voice pipeline** — Deepgram STT, ElevenLabs/OpenAI/Edge TTS, live voice calls with interrupt detection.
- **SSH terminal** — xterm.js in the web panel with local PTY and remote SSH. Keys encrypted at rest (AES-256-GCM) and isolated in a network-less sidecar container.
- **Plugin system** — extend context, tools, gateways, and middleware. OpenClaw-compatible.

## Quick start

### VPS (Ubuntu/Debian)

```bash
git clone https://github.com/Klace/Anima-AI.git && cd Anima-AI
chmod +x install.sh new-agent.sh setup-manager.sh setup-traefik.sh configure-anima.sh
./install.sh
```

### Local machine (macOS / Linux / WSL)

```bash
git clone https://github.com/Klace/Anima-AI.git && cd Anima-AI
chmod +x install.sh new-agent.sh setup-manager.sh setup-traefik.sh configure-anima.sh
./install.sh              # auto-detects local vs. server
# or
./install.sh --quick      # fastest path — sensible defaults, minimal prompts
```

Requires [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on macOS/Windows). The installer auto-detects your OS, sets up Traefik as the reverse proxy, and offers to install Docker and Node.js if missing.

### No Docker? No problem.

```bash
./install.sh --bare --quick     # just Node.js, no Docker needed
cd animas/anima && ./run.sh     # start your agent
```

Requires [Node.js 22+](https://nodejs.org/). Everything runs as a single process — no containers, no compose.

| Flag | Effect |
|------|--------|
| `--quick` | Minimal prompts — uses sensible defaults for personality, permissions, etc. |
| `--bare` | No Docker — installs npm deps and runs Node.js directly (implies local) |

```bash
./configure-anima.sh                  # reconfigure an existing agent
```

After installation, open the Manager UI in your browser to create agents, configure providers, and manage your fleet.

## Architecture

```
Platforms (Discord/Telegram/Slack/Web)
  │
  ▼
GatewayManager ─── VoicePipeline (STT → LLM → TTS)
  │
  ▼
AgentLoop ──── PluginManager
  │
  ▼
GraphContext ←→ graph.db (SQLite)
  │               ├── nodes, edges, attributes
  │               ├── episodes (raw conversation FTS)
  │               └── embeddings (vector search)
  │
SessionManager ←→ sessions.db
  │
ToolSystem ←→ SSH Sidecar (Unix socket, no network)
  │
Learner + Maintainer (background workers)
```

Each agent runs as a Docker container behind Traefik. The visual knowledge graph in the web panel provides a live window into the agent's understanding — you can see nodes form, relationships shift, and memories evolve as the agent converses.

## Minimum configuration

Set these in the agent's `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...   # required (unless using openrouter/ or gemini/ models)
GEMINI_API_KEY=...              # recommended — enables semantic vector search
```

Platform gateways auto-enable when their tokens are set — all are optional:

| Gateway | Token(s) needed |
|---------|----------------|
| Discord | `DISCORD_TOKEN` |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| Web panel | `ANIMA_WEB_PORT` + `ANIMA_WEB_AUTH_PASS` |

An agent with no platform tokens still works via the invoke API. See [.env.example](.env.example) for all available variables.

Full configuration reference: [docs/admin-guide.md](docs/admin-guide.md)

## Repository structure

```
src/                  Core application
  agent/              Inference loop, session management
  graph/              Context engine, embeddings, activity feed
  workers/            Learner (fact extraction), Maintainer (graph health)
  tools/              Tool definitions, SSH manager, web panel WS handlers
  gateways/           Discord, Telegram, Slack adapters + privacy/pairing
  voice/              STT/TTS pipeline
  plugins/            Plugin lifecycle, OpenClaw adapter
  static/             Web panel (graph-viewer.html)
  benchmark/          Memory retrieval benchmarks

sidecar/              SSH credential isolation (separate container, no network)
manager/              Multi-user admin dashboard
animas/               Per-agent instances (gitignored)
docs/                 Extended documentation
```

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System architecture, message flow, design decisions |
| [docs/admin-guide.md](docs/admin-guide.md) | Deployment, env vars reference, sidecar setup, troubleshooting |
| [docs/user-guide.md](docs/user-guide.md) | Web panel, SSH terminal, voice, chat features |
| [docs/security.md](docs/security.md) | Auth model, key encryption, sidecar architecture, threat model |
| [docs/graph.md](docs/graph.md) | Knowledge graph schema reference |
| [docs/manager.md](docs/manager.md) | Admin dashboard setup and user management |
| [docs/voice.md](docs/voice.md) | Voice pipeline configuration |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, repo layout, code style, how to make changes |

## Security overview

- Containers run as unprivileged user (UID 2000), `no-new-privileges` enforced
- Web panel behind HTTP Basic Auth; manager uses session auth with CSRF + rate limiting
- SSH keys encrypted at rest (AES-256-GCM, PBKDF2) and isolated in a sidecar with zero network access
- `exec` tool blocks dangerous patterns; source editing disabled by default
- All host ports bind to `127.0.0.1`; Traefik handles public routing

Full details: [docs/security.md](docs/security.md)

## License

MIT
