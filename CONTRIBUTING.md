# Contributing to Anima

Anima is a visual agentic system — autonomous AI agents with observable knowledge graph memory. Contributions across the stack are welcome: the core agent runtime, visual graph interface, Manager UI, deployment tooling, and documentation.

## Development setup

```bash
git clone https://github.com/Klace/Anima-AI.git && cd Anima-AI
chmod +x install.sh new-agent.sh setup-manager.sh setup-traefik.sh configure-anima.sh
./install.sh        # sets up Traefik, Manager, and the base Docker image
```

You need Docker installed. `install.sh` handles Docker installation on Ubuntu/Debian if needed.

### Running a development agent

```bash
cd animas/<agent-id>
docker compose up -d --build -V   # build + start
docker logs -f <agent-id>         # watch logs
```

Source code lives in `src/`. Agents with `ANIMA_SRC_EDITABLE=false` (default) bind-mount from `../../src/` — editing `src/` and restarting the container picks up changes immediately. Agents with `ANIMA_SRC_EDITABLE=true` have their own `src/` copy under `animas/<agent-id>/src/`.

### Running tests

```bash
cd src && node test.js
```

Tests validate the graph context engine, session manager, and prompt building without requiring API keys or Docker.

## Repository layout

```
src/                  Core application (Docker build context)
  app.js              Boot sequence — wires everything together
  config.js           Env/file config loader with defaults
  agent/
    loop.js           Core agentic loop (message → context → LLM → tools → respond)
    sessions.js       Session management, compaction, idle timeouts
  graph/
    context.js        Builds system prompt from SQLite knowledge graph
    retrieval.js      Hybrid search: FTS5, vector, temporal, graph walk
    embedder.js       Gemini embedding integration
    feed.js           Activity feed for recent changes
    multi.js          Multi-graph registry (multiple knowledge bases per agent)
  workers/
    learner.js        Extracts facts from conversations → graph
    maintainer.js     Gap detection, reflections, stale checks, sparse connect
    proactive.js      Heartbeat-triggered outreach to channels
  tools/
    tools.js          Tool definitions (exec, file I/O, web, graph, SSH, etc.)
    ssh-manager.js    SSH connections, keystore, SFTP, tunneling
  gateways/
    manager.js        Multi-gateway orchestrator
    discord.js        Discord adapter
    telegram.js       Telegram adapter
    slack.js          Slack Socket Mode adapter
    web.js            Web panel (HTTP + WebSocket + terminal + voice)
    privacy.js        Per-channel/platform privacy policies
    pairing.js        Cross-platform identity pairing
  voice/
    pipeline.js       STT → LLM → TTS orchestration
    stt.js            Deepgram / OpenAI Whisper
    tts.js            ElevenLabs / OpenAI / Edge TTS
  plugins/
    manager.js        Plugin lifecycle, loading, shutdown
    openclaw-adapter.js  OpenClaw compatibility layer
  providers/
    index.js          MultiProvider — routes to Anthropic, Gemini, OpenRouter, local
  static/
    graph-viewer.html Web panel UI (graph viz, chat, terminal, file browser)

sidecar/              SSH credential isolation (separate container, no network)
manager/              Multi-user admin dashboard
animas/               Per-agent instances (gitignored except .template/)
docs/                 Extended documentation
deploy/               Cloud deployment configs (Fly, Railway, prod compose)
```

## How it works (message flow)

See [docs/architecture.md](docs/architecture.md) for the full trace.

Short version:

1. **Gateway** receives a message (Discord, Telegram, Slack, or WebSocket)
2. **GatewayManager** normalizes it into a common format and calls `AgentLoop.processMessage()`
3. **AgentLoop** builds context from the **GraphContext** engine (identity, rules, relevant knowledge, episodes)
4. **MultiProvider** sends the prompt + conversation history to the LLM
5. LLM responds with text and/or **tool calls** — the loop iterates until no more tool calls
6. **Learner** asynchronously extracts new knowledge from the exchange into the graph
7. Response is sent back through the originating gateway

## Code style

- **No framework** — the codebase is vanilla Node.js with CommonJS modules. No TypeScript, no Babel, no bundler.
- **SQLite everywhere** — `node:sqlite` (built-in since Node 22) for the graph and session databases.
- **Comments**: only where the code can't speak for itself. No narration ("// import module"), no changelogs in comments. Explain *why*, not *what*.
- **Error handling**: catch and log at boundaries; let errors propagate within modules.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes, `UPPER_SNAKE` for constants.

## Making changes

1. Edit files in `src/`
2. Restart the agent: `cd animas/<agent-id> && docker compose restart`
3. For dependency changes: `docker compose up -d --build -V` (the `-V` flag recreates volumes)

### If you change the Dockerfile

```bash
docker build -t anima:latest src/
# Then restart agents
for d in animas/*/; do (cd "$d" && docker compose up -d --build -V); done
```

### If you change the sidecar

```bash
docker build -t anima-ssh-sidecar:latest sidecar/
for d in animas/*/; do (cd "$d" && docker compose restart); done
```

## Security considerations

- Never commit `.env` files, API keys, or credentials
- The `exec` tool has a `dangerousPatterns` blocklist in `tools.js` — extend it if you add new risky commands
- Sub-agents get a restricted tool set (no `env_manage`, `remote_exec`, or `remote_write_file`)
- Containers run as unprivileged user (UID 2000) with `no-new-privileges`
- SSH keys are encrypted at rest and isolated in a network-less sidecar

See [docs/security.md](docs/security.md) for the full threat model.
