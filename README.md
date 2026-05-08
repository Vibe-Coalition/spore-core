<p align="center">
  <img src="assets/spore-logo.svg" alt="Spore logo" width="96" height="96"><br>
  <strong>Spore Core</strong><br>
  A personal agent runtime for people building tools with tools.
</p>

<p align="center">
  <a href="https://github.com/Vibe-Coalition"><img alt="Vibe Coalition" src="https://img.shields.io/badge/Vibe%20Coalition-Spore%20Core-ff7a1a?style=for-the-badge"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-in%20active%20development-2f855a?style=for-the-badge">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-2563eb?style=for-the-badge">
  <img alt="Vibe code welcome" src="https://img.shields.io/badge/vibe%20code-welcome-7c3aed?style=for-the-badge">
</p>

# Spore Core

Spore Core is a persistent AI agent runtime. It combines a web control panel,
channel gateways, long-term graph memory, local and remote tools, model routing,
and a plugin system into one containerized service.

Spore Core is a fork and continuation of Kyle Lacey's Anima project, released
under the Vibe Coalition organization. It is a passion project, still very much
being built in public: practical, experimental, sometimes sharp-edged, and aimed
at making an agent that can actually live alongside your work without turning
every conversation into one giant polluted memory pile.

The runtime is designed for three main workflows:

- **Operate a personal or team agent** from the web UI, Telegram, Slack, Discord,
  or Spore Code.
- **Retain useful context** in scoped knowledge graphs without letting every
  project, person, or channel pollute every other conversation.
- **Extend the agent** with providers, tools, gateways, reference nodes, and UI
  settings through plugins.

## Project Spirit

Spore is for people who want an agent that can do real work, remember the right
things, forget the wrong things, and be shaped by the people using it. The code
is evolving quickly, so expect rough edges and moving parts.

Contributions are welcome. Small fixes, docs improvements, plugin experiments,
benchmarks, design polish, and "vibe coded" prototypes are all fair game as long
as they are useful, reviewable, and honest about what was tested. Discord is
available for project chat and coordination; a public invite link will be added
here once it is finalized.

## Quick Start

Build the image from this repository:

```bash
docker build -t spore:latest -f src/Dockerfile .
```

Run a local instance:

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

Open `http://localhost:18803` and finish the first-run wizard. The wizard creates
the first operator account, stores settings in `/data`, and lets you choose
plugins, providers, model routing, and theme.

For production compose usage, see [deploy/README.md](deploy/README.md).

## What Is Included

- **Web control panel:** chat, settings, onboarding, logs, graph viewer, file
  browser, plugin management, backups, benchmarks, pairing, and model routing.
- **Multi-graph memory:** default, General Knowledge, user, project, and channel
  graphs with scoped read/write behavior.
- **Agent loop:** dynamic prompt assembly, graph recall, tool execution,
  compaction, task tracking, wakeups, and async learning.
- **Runtime queue:** priority lanes for interactive turns, channel turns,
  deferred wakeups, learner jobs, maintenance, and background work.
- **Tools:** shell/file/git helpers, graph query/update/delete, web search/fetch,
  media analysis, ask_user, wakeups, tasks, log watches, SSH, web serving, and
  plugin tools.
- **Channels:** Telegram, Slack, Discord, web chat, and Spore Code sessions.
- **Plugins:** bundled providers, browser backends, voice providers, email,
  Tailscale, SSH sidecar, cron guidance, benchmarks, and session-graph features.

## Memory Model

Spore uses SQLite-backed knowledge graphs:

- `default`: the main operator/system graph.
- `spore-knowledge-base`: protected shared reusable knowledge.
- `user-*`: private webapp user memory.
- `project-*`: Spore Code project memory shared by collaborators on the same
  project identity.
- `channel-*`: person or channel memory for Telegram, Slack, Discord, and other
  non-web/CLI channel sessions.

Project and channel graphs can read from General Knowledge. Durable reusable
lessons are distilled back into General Knowledge; private or project-specific
details stay scoped.

See [docs/graph.md](docs/graph.md) for the full model.

## Bundled Plugins

Plugins are loaded from `plugins/` when `SPORE_PLUGINS_ENABLED=true`. Bundled
plugins currently cover:

- Model providers: Anthropic, OpenAI, OpenRouter, Gemini, Z.ai, local/custom
  OpenAI-compatible endpoints.
- Embedders: local Gemma and Gemini embedding.
- Browser automation: browser-core with Zendriver and Playwright backends.
- Channels: Telegram, Slack, Discord.
- Voice and media: Deepgram, Whisper, ElevenLabs, FLUX.
- Operations: Tailscale, SSH sidecar, compute cluster, cron guidance, email.
- Memory and evaluation: session-graph, LongMemEval, Spore Code benchmark.

Plugin reference nodes are installed into the General Knowledge graph, not the
default graph. See [docs/plugins.md](docs/plugins.md).

## Spore Code

Spore Code is the CLI/client integration for coding sessions. It authenticates
to Spore Core, opens websocket-backed sessions, forwards local tool execution to
the user's machine, and scopes memory to project graphs. Plan mode and execute
mode expose different tool catalogs.

See [docs/spore-code.md](docs/spore-code.md).

## Repository Layout

```text
src/                 Core runtime, web gateway, tools, graph, settings, workers
plugins/             Bundled plugin packages
docs/                Operator and developer documentation
deploy/              Production compose and deployment helpers
tests/               Node test suite
shared/              Shared graph/skill examples
spores/              Local runtime instances and data; do not treat as source
```

## Development

Useful commands:

```bash
npm --prefix src test
node --test tests/tools/ask-user.test.js
docker build -t spore:latest -f src/Dockerfile .
```

The root `docker-compose.yml` only builds the shared image. Runtime containers
are normally started with `docker run`, production compose, or the local spore
instance scripts used by this deployment.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [User Guide](docs/user-guide.md)
- [Architecture](docs/architecture.md)
- [Knowledge Graph](docs/graph.md)
- [Configuration](docs/configuration.md)
- [Plugins](docs/plugins.md)
- [Channels](docs/channels.md)
- [Spore Code](docs/spore-code.md)
- [Tools](docs/tools.md)
- [Session Graph Progress Notes](docs/session-graph-progress.md)
- [Voice](docs/voice.md)
- [Security](docs/security.md)
- [Deployment](deploy/README.md)

## Security Notes

Spore can run shell commands, store credentials, connect to private networks,
and load unsandboxed plugins. Treat the web UI and plugin directory as privileged
operator surfaces. Bind the health endpoint to localhost when public access is
not required, protect the web UI, and only install plugins you trust.

See [docs/security.md](docs/security.md).

## License

See [LICENSE](LICENSE).

## Credits

Spore Core builds on Kyle Lacey's Anima project and carries that lineage forward
inside Vibe Coalition. Thank you to everyone experimenting, filing issues,
opening PRs, and pushing the project into weirder and more useful territory.
