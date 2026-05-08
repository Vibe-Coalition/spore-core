# Knowledge Graph

Spore stores long-term memory in SQLite knowledge graphs. A graph contains
typed nodes, aspects, attributes, aliases, edges, episodes, reflections, gaps,
and derived facts. The web UI renders these databases as an inspectable graph
and the agent uses scoped recall from them on each turn.

## Graph Types

| Graph | Purpose | Typical writer | Typical readers |
|---|---|---|---|
| `default` | instance/default graph | default web/operator sessions | default sessions |
| `spore-knowledge-base` | protected reusable shared knowledge | distillers, plugin reference nodes, research workers | most scoped sessions |
| `user-*` | private webapp user graph | that webapp user | that user and allowed operators |
| `project-*` | Spore Code project graph | code sessions for the project | collaborators on the same project |
| `channel-*` | channel/person graph | Telegram, Slack, Discord, and similar channels | that channel/person session |

General Knowledge is the cross-scope library. It should contain reusable lessons,
plugin reference nodes, framework/tool knowledge, and stable shared facts. It
should not become a dumping ground for private chat, project secrets, channel
noise, or one user's recurring tasks.

## Scope Resolution

Every session should have an explicit memory scope:

- **Web/operator default session:** writes the selected/default graph.
- **Webapp user session:** writes that user's graph and can read default/general
  sources allowed by policy.
- **Spore Code session:** writes the project graph and reads project plus
  General Knowledge.
- **Channel session:** writes the channel/person graph and reads that graph plus
  General Knowledge.
- **Plugin install/uninstall:** installs reference nodes into General Knowledge.
- **Proactive/wakeup turns:** use the graph and session that created the wakeup.

When a user switches graphs outside the graph view, subsequent chat and graph
operations should still use the newly selected graph.

## Core Schema

The schema is intentionally simple and inspectable:

| Table | Purpose |
|---|---|
| `nodes` | primary entities with `id`, `label`, `type`, `description`, importance, provenance, timestamps, and JSON `extra` |
| `aspects` | named groups on a node such as `identity`, `rules`, `gotchas`, `capabilities`, or `project_notes` |
| `attributes` | individual facts inside aspects, with importance, source, timestamps, and optional source episode metadata |
| `edges` | directed typed relationships between nodes |
| `aliases` | alternate labels for search and fuzzy lookup |
| `episodes` | transcript snippets and conversation evidence |
| `gaps` | open questions for maintenance/research |
| `reflections` | maintainer or model-generated observations |
| `derived_facts` | inferred facts with confidence and provenance |
| `attribute_history` | change history for attributes |

Migrations may add supporting tables or columns. Treat the database API and
graph modules as the source of truth, not this list alone.

## Learning And Distillation

Spore learns in stages:

1. The active turn is stored in session history.
2. The learner extracts candidate facts and relationships.
3. Writes go to the current session's scoped graph.
4. Session and channel distillers periodically summarize longer arcs.
5. Reusable lessons can be promoted into General Knowledge.
6. Temporary or low-value session artifacts are pruned by maintenance.

Project sessions often distill when the session ends. Channel sessions may not
have a natural end, so the channel distiller uses idle/periodic thresholds to
summarize progress and promote useful shared knowledge without carrying every
message forever.

## General Knowledge

General Knowledge is available to scoped sessions as a reusable reference layer.
Examples of good General Knowledge entries:

- how a library behaved in a prior project,
- a framework gotcha that applies across projects,
- plugin tool capabilities and setup notes,
- stable operator-level preferences that are intentionally shared,
- implementation lessons from benchmarks.

Examples that should stay scoped:

- a person's private reminders or recurring jobs,
- channel-specific social context,
- project secrets or local hostnames,
- transient task chatter,
- benchmark actor identities.

## Plugin Reference Nodes

Bundled and installed plugins can ship reference-node SQL. The plugin manager
installs those nodes into General Knowledge and removes stale copies from other
graphs. Reference-node SQL should tag rows with `extracted_with =
'{{plugin_id}}'` so install/uninstall cleanup can identify ownership.

This keeps capability descriptions reusable without polluting `default`.

## Retrieval

Recall can combine:

- full-text search over nodes, aliases, aspects, attributes, and episodes,
- optional embeddings,
- graph walks from matched nodes,
- recency and importance boosts,
- scoped graph merging.

Enhanced recall can use a model tier to decompose a user message into multiple
search queries. That should improve retrieval, but it is not a substitute for
correct graph scoping.

## Graph Viewer

The web graph UI supports:

- graph switching,
- node search and type filtering,
- node details with aspects, attributes, and edges,
- direct edits for supported graph records,
- graph export/import and backups,
- SVG rendering for smaller visible sets,
- WebGL rendering for larger visible sets,
- optional renderer performance metrics.

The renderer is an interface detail. The backing graph may contain far more
nodes than are comfortable to show at once, so search, filtering, culling, and
structured focus views matter.

## Export, Import, And Backups

Graph export/import operates on graph databases rather than on one old global
memory file. Operators should be clear about which graph they are exporting or
restoring.

The global reset action should preserve only the default and General Knowledge
graphs, reset both, and remove all other graph databases. Individual graph reset
actions apply only to the selected graph.

Backups are controlled by backup settings and normally stored under `/data`.
Back up `/data` before destructive maintenance.

## Operational Checks

When changing graph behavior, verify:

- code sessions do not read unrelated project/channel/user graphs,
- channel wakeups return to the originating channel graph and session,
- learners write to the scoped graph,
- distillers promote only reusable knowledge into General Knowledge,
- plugin reference nodes install into General Knowledge,
- graph switching updates chat/session operations, not only the graph view,
- webapp users can see their graph, default/general knowledge where allowed, and
  projects they collaborate on.
