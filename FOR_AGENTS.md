# For AI Coding Assistants

This repository is Spore Core, the server/runtime for a persistent AI agent. It
is not just a web app: it owns graph memory, websocket sessions, channel
gateways, plugins, tools, workers, model routing, and deployment packaging.

## First Principles

- Read the relevant code before changing behavior. Many features are routed
  through plugins or lifecycle hooks rather than obvious top-level files.
- Do not use stale `*.bak*` files as source of truth.
- Do not treat `spores/` runtime data as source code. It contains local
  instances, databases, generated data, and operator state.
- Prefer focused tests over broad guesses. The test suite has targeted coverage
  for auth, queueing, scoped memory, plugins, browser routing, settings, and
  Spore Code.
- Never hard-code private paths, hostnames, usernames, tokens, or local runtime
  assumptions into docs or source.

## High-Value Source Files

- `src/app.js`: boot sequence and component wiring.
- `src/gateways/web.js`: web UI, HTTP API, websocket sessions, auth, graph API.
- `src/tools/tools.js` and `src/tools/builtin-registry.js`: built-in tool
  catalog and implementations.
- `src/agent/loop.js`: agent loop, prompt assembly, tool execution, learning
  kickoff, compaction, interjection.
- `src/graph/multi.js` and `src/graph/scopes.js`: multi-graph registry and
  memory scope resolution.
- `src/settings/defs.core.js`: canonical core settings and env vars.
- `src/plugins/manager.js` and `src/plugins/api.js`: plugin lifecycle and API.
- `plugins/*/spore.plugin.json`: bundled plugin metadata.

## Memory Scoping Rules

Spore has multiple graph types:

- `default` is the main graph.
- `spore-knowledge-base` is the protected shared reusable knowledge graph.
- `project-*` graphs are for Spore Code project memory.
- `channel-*` graphs are for channel/person memory.
- `user-*` graphs are for webapp user memory.

When changing recall, learning, distillation, proactive thoughts, plugins, or
session routing, verify the graph target. The expected pattern is:

- Code sessions write project memory and read project plus General Knowledge.
- Channel sessions write channel/person memory and read channel plus General
  Knowledge.
- Plugin reference nodes install into General Knowledge.
- Reusable distilled lessons can move to General Knowledge; scoped details stay
  scoped.

## Tool Catalog Boundaries

Tool availability is context-sensitive. CLI/Spore Code sessions must not see
tools that belong to web-only surfaces, global webapp sessions, or server-only
operator workflows. Plan mode also hides mutating execution tools.

Check `getToolDefinitions`, `TOOLS_EXCLUDED_FROM_CLI`, plugin `available`
callbacks, and tests under `tests/tools/` when editing tool exposure.

## Common Test Commands

```bash
node --test tests/tools/ask-user.test.js
node --test tests/graph/scoped-memory.test.js
node --test tests/runtime/job-queue.test.js
node --test tests/plugins/channel-routing.test.js
node --test tests/settings/registry.test.js
node --check src/gateways/web.js
git diff --check
```

Use the smallest relevant set first. Add or update focused tests when changing a
boundary or public behavior.

## Documentation Work

When updating docs, use the current codebase as the source of truth. In
particular:

- Plugin lists come from `plugins/*/spore.plugin.json`.
- Settings come from `src/settings/defs.core.js` plus plugin settings.
- API paths come from `src/gateways/web.js` and plugin route registration.
- Tool lists come from `src/tools/builtin-registry.js` and plugin tool
  registrations.
- Behavior claims should be backed by tests or source inspection.

## What Not To Do

- Do not reset, prune, delete, or migrate live data unless the user explicitly
  asks for that operation.
- Do not restart or hotpatch containers for docs-only work.
- Do not install plugins or dependencies just to inspect manifests.
- Do not add broad prompt text to hide capabilities that should be removed from
  the actual tool catalog.
- Do not rely on model reasoning to enforce privacy or graph isolation when code
  can enforce it.
