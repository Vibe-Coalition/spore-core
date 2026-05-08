# Architecture

Spore Core is a single-process Node.js runtime packaged as a Docker image. It
hosts the web control panel, channel gateways, model routing, tool execution,
plugin lifecycle, background workers, and SQLite-backed memory.

The runtime is intentionally explicit: most state lives in `/data`, user work
lives in `/workspace`, and durable agent knowledge lives in named SQLite graph
databases.

## Runtime Shape

```text
browser / mobile / channel / Spore Code
        |
        v
src/gateways/web.js and plugin gateways
        |
        v
runtime job queue -> agent loop -> model provider -> tool system
        |              |              |             |
        |              |              |             v
        |              |              |        local tools, SSH,
        |              |              |        browser, plugin tools
        |              |              v
        |              |        provider plugins
        |              v
        |        prompt + scoped recall
        v
sessions, graph memory, settings, workers, logs
```

The most useful entry points are:

| Area | Source |
|---|---|
| Boot sequence | `src/app.js` |
| Web UI, HTTP API, websocket sessions | `src/gateways/web.js` |
| Agent loop and compaction | `src/agent/loop.js` |
| Tools | `src/tools/tools.js`, `src/tools/builtin-registry.js` |
| Settings | `src/settings/defs.core.js` |
| Graph registry and scoping | `src/graph/multi.js`, `src/graph/scopes.js` |
| Plugins | `src/plugins/manager.js`, `src/plugins/api.js` |
| Workers | `src/workers/` |

## Boot Flow

`src/app.js` wires the process in this order:

1. Load config from environment, `/data/.env`, `/data/spore.json`, and defaults.
2. Initialize observability, settings, sessions, runtime queues, and the graph
   registry.
3. Ensure the default graph and General Knowledge graph exist.
4. Load enabled plugins and let them register settings, routes, providers,
   tools, prompt sections, lifecycle hooks, gateways, static assets, and
   reference nodes.
5. Build the tool system and model provider registry.
6. Start the agent loop, learner, janitor, graph maintenance, channel distiller,
   backup worker, and optional plugin workers.
7. Start the web gateway and health endpoint.

First-run onboarding persists operator settings into `/data`; a normal restart
should not require bind-mounted application config.

## Message Lifecycle

All inbound work follows the same broad path:

1. **Gateway normalization.** Web, mobile, Spore Code, Telegram, Slack, Discord,
   and plugin gateways normalize messages into a session key, user identity,
   platform/channel metadata, attachments, and streaming callbacks.
2. **Scope resolution.** The gateway and graph scope code decide which graph the
   session writes to and which read scopes are available. For example, Spore
   Code writes to a project graph and can read that graph plus General
   Knowledge.
3. **Queue placement.** User-facing turns enter interactive or channel lanes so
   learner and maintenance jobs cannot starve them.
4. **Recall.** The runtime retrieves relevant graph nodes, recent episodes,
   scoped memories, prompt sections, plugin context, tool descriptions, and
   runtime facts.
5. **Prompt assembly.** `GraphContext` builds a system prompt from identity,
   rules, scoped memory, tool catalog, plugin sections, runtime state, and
   channel/project/user context.
6. **Model call.** `MultiProvider` routes to the configured provider and model
   tier.
7. **Tool loop.** Tool calls are validated against the session's catalog,
   executed, streamed to clients, and fed back to the model until the turn
   completes or hits runtime limits.
8. **Persistence.** The session transcript, tool events, usage, and graph events
   are stored.
9. **Learning.** Async jobs summarize, extract, distill, and promote knowledge
   according to the session's graph scope.

## Model Routing

Spore uses model tiers rather than one hardcoded model:

| Tier | Typical use |
|---|---|
| `casual` | Short conversational replies |
| `normal` | Standard tool-using turns |
| `planner` | Planning, hard reasoning, summarization, evaluation |
| `subagent` | Delegated work |
| `learner` | Extraction, distillation, maintenance |
| `recall` | Query decomposition for enhanced recall |
| `imageVlm`, `videoVlm`, `audioVlm` | Media understanding |

Providers are contributed by core and plugins. Bundled provider plugins include
Anthropic, OpenAI, OpenRouter, Gemini, Z.ai, and local OpenAI-compatible
endpoints.

Spore Code can inherit server routing or receive a device-local routing
override. That override should affect only that client device, not global web or
channel routing.

## Runtime Queue

The runtime queue prevents background work from blocking people. Lanes include:

| Lane | Purpose |
|---|---|
| `interactive` | Web, mobile, Spore Code, and other direct user turns |
| `channel` | Telegram, Slack, Discord, and similar channel traffic |
| `deferred` | Wakeups and scheduled follow-up turns |
| `learner` | post-turn extraction and distillation |
| `maintenance` | graph upkeep, backups, janitor, research |
| `background` | lower-priority plugin or benchmark work |

Lane limits are configured by `runtimeQueueLaneLimits`. User-facing work should
always remain higher priority than learners, maintenance, benchmarks, and other
async jobs.

## Persistence

Important persisted state:

| Path | Contents |
|---|---|
| `/data/settings.db` | settings registry values, secrets, plugin settings |
| `/data/graph.db` | legacy/default graph location |
| `/data/graphs/*.db` | multi-graph databases |
| `/data/sessions.db` | session transcripts and history |
| `/data/runtime*.db` | runtime jobs and queue state |
| `/data/backups` or configured backup dir | graph backups |
| `/data/tailscale` | Tailscale state |
| `/data/ssh-*` | SSH sidecar or fallback state |
| `/workspace` | user-visible workspace and generated files |

Do not treat `spores/` or `/data` contents as source code. They are runtime
state.

## Graph Scopes

Spore's memory is intentionally not one global bag:

| Graph type | Role |
|---|---|
| `default` | main/default graph for the instance |
| `spore-knowledge-base` | protected shared reusable knowledge |
| `user-*` | private webapp user memory |
| `project-*` | Spore Code project memory |
| `channel-*` | channel/person memory |

Sessions write to their scoped graph. Reusable, non-private lessons can be
distilled into General Knowledge. Plugin reference nodes install into General
Knowledge so project and channel sessions can benefit without polluting the
default graph.

See [Knowledge Graph](graph.md).

## Plugins

Plugins are first-class extensions. A plugin can contribute:

- settings definitions and onboarding fields,
- provider prefixes,
- tools and availability rules,
- gateway implementations,
- HTTP routes and static UI assets,
- prompt sections,
- lifecycle hooks and workers,
- reference nodes.

Plugins run as trusted Node.js code inside the Spore process. They are not
sandboxed. Install only plugins you trust and keep plugin directories outside
agent-writable workspace paths.

See [Plugins](plugins.md).

## Web Gateway

`src/gateways/web.js` serves:

- first-run onboarding,
- login/logout and webapp user auth,
- the main web UI and graph UI,
- websocket chat/session events,
- graph CRUD, export/import, research, merge, and backups,
- settings, provider, routing preset, and plugin APIs,
- pairing approval for channel users,
- logs, uploads, workspace file tree, skills, terminal, remote access, and
  benchmark endpoints.

This file is large because it owns the operator-facing application boundary.
When changing web behavior, add targeted tests around auth, websocket routing,
graph selection, or settings persistence.

## Tool Boundaries

Tool catalogs are context-sensitive. A web session, Spore Code session, channel
session, plan-mode turn, and subagent should not necessarily see the same tools.

Examples:

- Browser automation is scoped to the user/session/channel that requested it and
  is not exposed to the CLI catalog.
- Cron guidance is not exposed to CLI sessions.
- Webapp request tools are not exposed to Spore Code.
- Plan mode prefers non-mutating planning tools until the user explicitly starts
  execution.
- Subagents receive a restricted catalog.

Capability boundaries should be enforced in code, not hidden by extra prompt
text.

## Background Workers

Spore runs several async workers:

- learner extraction after turns,
- session summary and distillation,
- channel graph distillation for long-lived channel conversations,
- graph maintenance and sparse connection,
- General Knowledge research,
- graph backups,
- janitor cleanup,
- token/activity logging,
- plugin-specific workers.

Background work must preserve graph scope and must not write private user,
channel, or project facts into the default graph by accident.

## Design Rules

- Prefer graph-scope enforcement in code over model instructions.
- Keep user-facing turns higher priority than learners and maintenance.
- Keep plugin state and runtime data outside source-controlled docs/code.
- Add focused tests when changing auth, graph scope, queueing, tool exposure,
  plugin reference nodes, browser routing, or session lifecycle.
- Treat all installed plugins, saved credentials, browser sessions, and shell
  tools as privileged surfaces.
