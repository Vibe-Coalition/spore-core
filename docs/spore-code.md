# Spore Code

Spore Code is the CLI/client integration for coding sessions. It connects to
Spore Core over HTTP/websocket, executes local client tools on the user's
machine, and scopes memory to a project graph.

## Responsibilities

Spore Core provides:

- authentication endpoints,
- websocket session handling,
- project graph resolution,
- prompt sections for project context and plan mode,
- server-side graph/session persistence,
- model routing,
- benchmark and evaluation hooks.

The Spore Code client provides:

- local command/file execution on the user's machine,
- project identity and workspace metadata,
- plan/execute UI,
- question picker UI for `ask_user`,
- update/release handling,
- local routing overrides when configured.

## Project Graphs

Each project should resolve to a stable `project-*` graph. Reopening the same
project should reuse the existing project graph instead of creating a duplicate.
Authorized collaborators on the same project can benefit from project memory and
General Knowledge.

Project sessions should not read unrelated project, channel, or user graphs.

## Shared Knowledge

Spore Code sessions read:

- the project graph,
- General Knowledge,
- current session history,
- code index and client-provided project context.

Reusable lessons discovered in a project can be distilled into General Knowledge
after the session settles. A later project session should recall those lessons
before rediscovering the same library behavior from scratch.

## Tool Catalog

The CLI catalog is intentionally different from the web catalog.

Expected boundaries:

- local code tools run through the connected client,
- browser and webapp request tools are not exposed,
- cron is not exposed,
- server-only operator tools are not exposed,
- plan mode avoids mutating tools until execution starts.

Do not solve exposure problems by adding prompt text that says "do not use this"
while still leaving the tool visible. Remove or gate the tool.

## Planning And Questions

Plan mode should ask only blocking questions. If the user already clarified the
requirement, the agent should revise the plan rather than forcing a bad picker.

`ask_user` is currently a structured single-choice picker in web and Spore Code
sessions. Other channel types should ask questions in normal text.

## Model Routing

By default, Spore Code inherits server-defined routing and presets. A client can
apply a device-local routing override for its own default model selection. That
override should not mutate server-wide routing or other users' devices.

## Context And Compaction

Long coding sessions can grow quickly. Compaction should summarize older
messages while preserving:

- current task,
- files changed,
- commands run,
- blockers,
- user instructions,
- graph/session scope,
- pending tool or question state.

Clients can display context/compaction status when the server emits it.

## Benchmarks

The Spore Code Benchmark plugin runs simulated coding sessions against cloned
repositories. It can test:

- implementation quality,
- multi-turn user simulation,
- cross-session memory reuse,
- multi-user project handoff,
- leakage between graphs/sessions,
- setup/toolchain behavior,
- final transcript summaries.

Benchmark actor data should stay out of default memory unless the scenario
explicitly targets default.

## Troubleshooting

If a session creates a duplicate project graph, inspect project identity keys and
graph registry lookup.

If the agent mentions unrelated server capabilities, inspect prompt sections,
General Knowledge recall results, and the CLI tool catalog.

If local tools fail because the agent thinks it is in a container, inspect the
client/server execution contract and prompt context.

If the agent stops mid-edit, inspect execute budget, compaction, tool result
size, and whether the client disconnected/reconnected during the turn.
