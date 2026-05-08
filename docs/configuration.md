# Configuration

Spore configuration is layered. Environment variables and first-run onboarding
seed the instance; the settings registry then persists runtime-editable values
under `/data`.

## Configuration Sources

Highest priority first:

1. process environment,
2. `/data/.env`,
3. `/data/spore.json`,
4. settings stored in `/data/settings.db`,
5. source defaults in `src/config.js` and `src/settings/defs.core.js`.

The first-run wizard writes to `/data` so container image updates do not require
editing files in `/app`.

## Core Paths

| Setting/env | Purpose | Typical Docker value |
|---|---|---|
| `SPORE_DATA_DIR` | persistent runtime data | `/data` |
| `SPORE_WORKSPACE_PATH` | user workspace | `/workspace` |
| `GRAPH_DB_PATH` | default graph DB path | `/data/graph.db` |
| `SESSION_DB_PATH` | session DB path | `/data/sessions.db` |
| `SETTINGS_DB_PATH` | settings DB path | `/data/settings.db` |
| `SPORE_WEB_PORT` | web UI/API/websocket port | `18803` |
| `SPORE_HEALTH_PORT` | health endpoint port | `18790` |
| `AGENT_ID` | stable instance/agent id | `spore` |
| `SPORE_DISPLAY_NAME` | UI/display name | operator choice |

Back up `/data` and `/workspace` before destructive maintenance.

## Settings Groups

The core settings registry covers:

- paths and identity,
- model routing and model library,
- provider credentials,
- embedders and enhanced recall,
- web search,
- voice,
- proactive behavior,
- channels and privacy,
- runtime queue and agent effort,
- session context and compaction,
- learning, maintenance, janitor, and General Knowledge research,
- backups and graph export/import,
- cluster, Tailscale, SSH, and host paths,
- web UI, browser backend, logs, and appearance,
- plugin installation and plugin-specific settings.

Plugin settings are registered by each plugin and may appear or disappear when a
plugin is installed or removed.

## Model Routing

Spore routes work by tier:

| Tier | Used for |
|---|---|
| casual | light replies |
| normal | standard tool turns |
| planner | planning, hard reasoning, summaries, evaluation |
| subagent | delegated work |
| learner | extraction and distillation |
| recall | recall query decomposition |
| image/video/audio VLM | media analysis |

Routing presets live in settings and can be changed from the web UI. Users may
switch presets when allowed. Spore Code can inherit server routing or use a
device-local default override; that override should not mutate the server-wide
default preset.

## Providers

Bundled provider plugins:

- Anthropic,
- OpenAI,
- OpenRouter,
- Google Gemini,
- Z.ai,
- custom OpenAI-compatible endpoints.

Provider plugins own their credentials and model-prefix routing. If a provider
plugin is uninstalled, its models should disappear from routing choices.

## Embeddings And Recall

Embeddings can come from:

- local Gemma embedding through Transformers.js,
- Gemini embeddings through the Gemini provider key.

Enhanced recall can use a model to split a user request into multiple graph
search queries. Enable it only when the additional recall quality is worth the
extra model call.

## Channels

Channel settings control Telegram, Slack, Discord, pairing, mention policies,
DM/group behavior, chunking, and privacy. Channel sessions must retain their
originating platform/channel/user graph scope for replies, wakeups, and
learning.

See [Channels](channels.md).

## Backups

Backup settings control whether graph backups run, how often they run,
retention count, backup directory, and whether unchanged graphs are skipped.

Backups are graph-aware. Exporting or importing should make clear which graph is
affected.

## Runtime Queue

`runtimeQueueEnabled` and `runtimeQueueLaneLimits` control central scheduling.
The defaults keep interactive, channel, deferred, learner, maintenance, and
background lanes separate. Increase lane limits carefully; too much learner or
benchmark concurrency can starve user-facing sessions.

## Theme And UI

Appearance settings include dark/light theme and graph performance metric
visibility. Light theme should use the orange accent consistently across
settings, dock menus, logs, and graph selectors.

## Secrets

Secrets should be entered through onboarding/settings or environment variables.
UI reads should redact them. Do not put provider keys, channel tokens, invite
keys, SSH keys, or service credentials into graph nodes or docs.
