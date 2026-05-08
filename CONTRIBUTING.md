# Contributing to Spore Core

Spore Core is a Node.js runtime packaged as a Docker image. It uses SQLite for
settings, sessions, runtime jobs, and knowledge graphs. Most extension points
are plugins.

## Development Setup

Install Node.js 22 or use the Docker image. From the repository root:

```bash
npm --prefix src install
npm --prefix src test
```

Build the image:

```bash
docker build -t spore:latest -f src/Dockerfile .
```

The root `docker-compose.yml` is a build helper for the shared image:

```bash
docker compose --profile build build
```

Run a local container with `/data` and `/workspace` volumes as shown in the
README.

## Repository Layout

- `src/app.js`: bootstraps config, graphs, sessions, tools, agent, workers,
  plugins, gateways, and health.
- `src/gateways/`: web, channel, pairing, privacy, and gateway manager code.
- `src/agent/`: session manager and agent loop.
- `src/tools/`: built-in tool registry, tool implementations, package vetting,
  SSH manager, skills, and benchmark graph seeding.
- `src/graph/`: graph context, multi-graph registry, scopes, export/import,
  retrieval, events, and General Knowledge helpers.
- `src/settings/`: canonical settings registry, loader, store, validators, and
  model routing presets.
- `src/workers/`: learner, maintainer, janitor, backup, channel distiller,
  graph maintenance, overview, and General Knowledge research workers.
- `src/runtime/`: persistent runtime job queue.
- `plugins/`: bundled plugin packages.
- `tests/`: focused Node test suite.

## Making Changes

- Keep changes scoped to the behavior requested.
- Prefer existing local patterns over new abstractions.
- Add tests when changing auth, routing, graph scope, tool exposure, plugin
  lifecycle, queue semantics, settings, backups, or public APIs.
- Update docs when changing operator-visible behavior.
- Avoid editing runtime instance data under `spores/`.

## Plugins

Plugins are loaded from bundled and user plugin directories when enabled. A
plugin can register tools, gateways, provider prefixes, settings, prompt
sections, HTTP routes, static assets, lifecycle hooks, middleware, and reference
nodes.

Plugin reference-node install SQL must tag rows with `extracted_with =
'{{plugin_id}}'`. The plugin manager installs those nodes into General
Knowledge and cleans stale copies from other graphs.

## Tests

Run focused tests while developing:

```bash
node --test tests/settings/registry.test.js
node --test tests/tools/plugin-execution-boundary.test.js
node --test tests/graph/scoped-memory.test.js
node --test tests/runtime/job-queue.test.js
```

Before handing off a change:

```bash
node --check path/to/changed.js
node --test path/to/relevant.test.js
git diff --check
```

For docs-only changes, run a stale-language sweep and link/path sanity check.

## Docker Changes

If `src/Dockerfile`, entrypoint scripts, cron wrappers, system packages, or
bundled plugin layers change, rebuild the image:

```bash
docker build -t spore:latest -f src/Dockerfile .
```

Do not restart live containers unless the user asks for deployment or hotpatch.

## Security Considerations

Spore can execute tools, load unsandboxed plugins, store secrets, proxy webapp
requests, and connect to private networks. Security-sensitive changes need
tests and docs. Pay special attention to:

- web auth and websocket auth,
- webapp user isolation,
- CLI session and local tool boundaries,
- browser preview routing,
- graph scope reads/writes,
- plugin install/uninstall and reference-node routing,
- SSH key storage and sidecar fallback,
- settings secret redaction.
