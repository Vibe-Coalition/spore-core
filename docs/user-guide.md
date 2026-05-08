# User Guide

The Spore web app is the control surface for chat, graph memory, settings,
plugins, channels, files, logs, benchmarks, and operator maintenance.

## First Run

Open the web port, usually:

```text
http://localhost:18803
```

The first-run wizard creates the first operator account, configures providers,
chooses bundled plugins, sets model routing, and writes settings under `/data`.
After onboarding, the app creates the base graph set and starts normal runtime
workers.

Normal users who self-register receive their own user graph. Operators can still
access the broader admin surfaces.

## Main Areas

The app contains:

- chat and session controls,
- knowledge graph view,
- graph switcher in the bottom dock,
- settings and plugin management,
- logs and activity,
- workspace files and uploads,
- terminal/remote access when enabled,
- channel pairing,
- graph export/import/backups,
- benchmark plugins.

The UI supports dark and light themes. Light theme uses the orange accent; dark
theme uses the darker Spore palette.

## Chat

Use chat to talk to the current session. The active graph/session matters: a web
user graph, default graph, project graph, or channel graph can all produce
different context.

Common controls:

- send a message,
- stop/interrupt a running turn,
- view activity and tool calls,
- attach supported files,
- answer `ask_user` prompts.

`ask_user` currently supports structured single-choice selections in web and
Spore Code sessions. If you type a normal clarification while a question is
pending, the app should not silently discard it.

## Knowledge Graph

The graph view shows nodes, relationships, aspects, and attributes for the
selected graph.

Useful actions:

- switch graphs from the dock,
- search nodes,
- filter by type,
- select a node to view aspects and edges,
- right-click supported session nodes for summary/distill actions,
- export or import graph data,
- reset an individual graph when appropriate.

The General Knowledge graph should stay pinned and easy to reach because many
scoped sessions read from it.

## Graph Rendering

Spore uses renderer switching so large graphs remain usable:

- SVG mode for smaller visible sets and detailed interaction,
- WebGL mode for larger visible sets,
- focus/structure views for node neighborhoods,
- optional performance metrics in Settings under Spore Core.

When performance metrics are disabled, the graph should not show the renderer
status line under the node/edge/type counts.

## Settings

Settings are searchable. Search should be case-insensitive and forgiving: a
query like `sear` should match `SearXNG`.

Important sections:

- Spore identity and paths,
- model providers and routing presets,
- web search,
- graph and memory,
- sessions and context,
- channels and pairing,
- plugins,
- backups,
- Tailscale, SSH, and remote access,
- logs and appearance.

Some plugin settings save immediately because they control runtime sidecars or
external login flows. The central Save button applies standard settings changes.

## Plugins

Plugins can add providers, tools, gateways, settings, UI panels, routes, prompt
sections, workers, and reference nodes. Bundled plugins include model providers,
Telegram/Slack/Discord, browser backends, voice providers, Tailscale, SSH
sidecar, cron guidance, email, LongMemEval, and Spore Code Benchmark.

Plugin reference nodes install into General Knowledge so they are visible to
scoped sessions without being written into the default graph.

## Channels

Telegram, Slack, and Discord use channel plugins. Pairing requests can be
approved from channel settings when supported. A channel session should write to
its channel/person graph and send replies back to the same originating channel.

Recurring wakeups created from a channel should also return to that channel, not
to an unrelated web or CLI session.

## Spore Code

Spore Code sessions are coding sessions tied to a project graph. The server
should route the session back to the existing project graph when the same project
identity reconnects, including when another authorized collaborator works on the
same project later.

Spore Code executes local tools on the user's machine/client context, not as a
generic webapp session. Tool catalogs are intentionally different from the web
app.

## Backups, Export, And Reset

Back up `/data` before destructive operations. The backup/export UI is graph
aware:

- individual graph reset affects the selected graph,
- global reset removes all graphs except default and General Knowledge, then
  resets those two,
- export/import should make clear which graph is being handled.

## Troubleshooting

If a channel reply appears in the web app instead of the channel, check the
wakeup/session origin and channel graph binding.

If graph switches do not affect chat, verify that the active session graph was
updated and not only the graph view.

If buttons become hard to click, inspect overlays, active dock backgrounds, and
submenus. Invisible elements should not sit over the dock.

If login reports too many attempts after a valid login or stale connection,
check websocket auth cleanup and login rate-limit reset behavior.

If the agent appears to know unrelated project or server capabilities, inspect
the prompt sections, scoped recall results, plugin reference nodes, and tool
catalog exposed to that session.
