# graphcorn — progress report

Branch: `graphcorn-server` (SPORE) + `graphcorn` (acorn-cli, yumlevi/acorn-cli)
Session window: 2026-04-24
Live on: sporebfl (sporetest still on stale code by design)

## What graphcorn is

A session-aware extension of SPORE's knowledge graph designed for the
acorn coding agent. Each acorn launch gets its own session node anchor;
everything the agent learns or creates during the session is bound to
it, and a session-end distillation picks winners to promote into
permanent cross-session memory.

The original 7-phase plan lived at
`/root/.claude/plans/ok-so-we-need-squishy-horizon.md`. All phases
shipped, plus a long tail of fixes for the rough edges that surfaced
during live use.

## What landed

### Phase 1–7 (the original plan)

- **Session node + lifecycle frames** — `session:start` / `session:end`
  WebSocket frames, `graph/sessions.js` upsert/finalize/bumpTurnCount,
  edges to project node both ways. (`b33ca5f`)
- **Auto-link learner-extracted nodes** — every entity the learner
  extracts during a session gets a `discovered_in` edge to the session
  node. Fed `opts.sessionId` through from `loop.js` →
  `learner._writeToGraph`.
- **`note_discovery` tool** — agent-facing wrapper over `graph_update`
  that auto-creates a `discovery-<slug>-<hash>` node with the right
  edges to session + project + relatedTo. Idempotent on re-noting.
- **Stronger prompt guidance** — Session block in the runtime section
  for acorn turns, ref-node updates, plan-mode integration.
- **Round checkpoints** — every finished turn writes `turn N | user
  "..." | tools: ... | files: ... | exec[N, M failed]: ... | reply:
  "..."` onto the session node's `rounds` aspect (capped at 50).
- **Failure capture** — server-side ring buffer detects exec
  failure→fix pairs across rounds and synthesizes
  `note_discovery({kind: "failure_fix"})`.
- **Session-end summary** — Path B (small-LLM recap) using rounds +
  full episode text as input. Agent-driven Path A deferred.

### Distillation pipeline (born-temp + session-end picker)

- **All session nodes born temp + sessionId-tagged** — session itself,
  project node (when freshly created), every learner / note_discovery /
  graph_update write inside an acorn ctx. (`56a608f`, `c2ae77e`)
- **`distillSession`** runs on `session:end` AND `ws.on('close')`,
  idempotent via `extra.distilled_at`. Pulls every session-temp +
  rounds + summary, asks a small LLM to:
  - **promote** keepers (clears temp flag, sets `distilled_from`)
  - **createNodes** new permanent nodes for tools/frameworks/libraries
    used during the session
  - **appendNotes** session-specific lessons onto existing permanent
    nodes' `gotchas` aspects
  - **drop** the rest into `recycle_bin` with a 7-day retention
- **Streaming LLM calls** so distill + summary don't trip nginx's 60s
  idle timeout on slow reasoning models. (`4a1e3d2`)
- **Identity guard** — person/project nodes never get soft-deleted
  even if the LLM tries. (`cfd9fc5`, `7e1a75d`)
- **FK-off rename** — node-id renames (e.g. `project-yam-678596fc` →
  `acorn-companion`) wrap the four UPDATE statements in
  `PRAGMA foreign_keys=OFF/ON`. `defer_foreign_keys` proved
  insufficient under concurrent learner writes. (`cfd9fc5`)
- **Built-in-tools rejection** — distill never creates nodes for
  SPORE's own tools (`exec`, `read_file`, etc.) which would just be
  graph noise. (`5fdf71e`)
- **Empty/malformed LLM response** doesn't strand temps — proceeds
  with the soft-delete sweep using empty promote/create/append lists.
  (`a1e3b4f`)
- **Post-distill race guard** — once a session is distilled, late-
  arriving learner / note_discovery / graph_update writes don't tag
  with the closed sessionId (orphan prevention). (`a1e3b4f`)

### Acorn-side prompt + tool guidance

- **Web search ref node** (`ref-web-search`) + cross-reference
  attribute on `ref-acorn-context.client_routing`. (`91f27c6`)
- **Research-and-record loop** — graph_query first, then web_search
  if the graph has nothing, then graph_update to save the lesson.
  (`5513829`)
- **3-strikes web_search rule** — if the same exec class fails twice,
  the third action MUST be web_search. (`15a2924`)
- **Load relevant gotchas at session start** — when project mentions
  expo/react-native/etc., graph_query each before first action.
- **Scratch scripts in `.acorn/scratch/`** — short directive points
  agents at the project node's `scratch_helpers` aspect (graph-native
  discovery, not always-on context). (`bf67d7d`, `f2f1af4`)
- **Poll-avoidance directive** — "if delegated tasks are running and
  no other work, END YOUR TURN." (`d6c1aa4`)

### Quality + observability

- **Trailing-4k learner cap** — long acorn turns no longer feed 60k+
  chars to the per-turn extraction LLM. (`c2ae77e`)
- **Wider id normalization** — `_normalizeNodeId` keeps `:`, `@`, `_`,
  `.` so acorn session nodes + discovery ids stay reachable from
  `graph_delete` / `graph_update`. (`a39180c`)
- **`graph_delete` distilled-knowledge guard** — refuses to delete
  nodes with `extra.distilled_at` without `force: true`. Stops the
  agent from accidentally nuking the `expo` node during cleanup.
  (`cfd9fc5`)
- **Event-bus emissions** — `session:summarize-start/done`,
  `session:distill-start/done`, `learner:start/queue/skip/done`,
  per-mutation `node:create/update/delete` + `attribute:create` +
  `edge:create`. UI viewer + transcript see graphcorn work in real
  time. (`9831303`, `4bb81a6`)
- **Round + summary truncation caps** — bumped reply preview 300→800,
  exec list 3→6, per-exec 100→200, episode body 2.4k→6k, total
  episode block 24k→60k. (`ac19e0c`)
- **`files: none` bug** fixed — `toolLog` stores stringified JSON;
  checkpoint code wasn't parsing it before reading `.path`. (`ac19e0c`)

### Plan-mode + UX polish (separate plan, same session window)

- **PHASE 6 VERIFICATION** — every plan must end with a `## Verification`
  section listing 2–5 runnable checks. (`d6c1aa4`)
- **Execution checklist** — at execute-time, agent's first tool calls
  must be `task_create` per plan step + per verification check.
  Status transitions `pending → in_progress → done`/`error` via
  `task_progress`. (`d6c1aa4`)
- **`task_create` / `task_progress` broadcasts** — emit `task:create`
  / `task:update` frames with `{id, subject, status, sessionKey, ...}`
  so clients can render a checklist. (`d6c1aa4`)
- **`task_status` polling-detection** — counts consecutive calls per
  session, escalates to a `_warning` field telling the agent to STOP
  POLLING from the 2nd call onward. (`d6c1aa4`)

### acorn-cli (graphcorn branch, v0.2.1-graphcorn)

GitHub release: https://github.com/yumlevi/acorn-cli/releases/tag/v0.2.1-graphcorn

- **Subagent panel progress** — handler now consumes the full set of
  `subagent:*` progress verbs (iter, iter_done, tool_call, tool_start,
  tool_progress, heartbeat, thinking, thinking_start, text). Status
  line shows `iter 3/40 │ exec(npm install) │ 12s` while running,
  `24 iters │ 14 tools │ 14s` when done.
- **Subagent panel auto-clear** — `pruneSubagents()` reaps terminal
  rows >5s old on next `chat:start`; `m.subagents = nil` when empty.
- **Plan-tasks panel** — new side panel `renderPlanTasksPanel` that
  catches `task:create` / `task:update` frames; same shape +
  auto-clear as subagent panel.
- **Question JSON modal without chat leak** — `appendDelta` watches
  for `\nQUESTIONS:` marker; once detected, subsequent deltas route
  into `msg.QuestionsBuf` instead of visible `msg.Text`. Parser
  reads from buffer; on parse failure flushes back into Text as a
  safety net.

### Critical fixes

- **CLI delegate_task wake-up** (`3c66193`) — `_deliverTaskResult`
  was only handling `platform === 'web'`; CLI fell through to a
  non-existent `platformManager.getGateway('cli')` and silently
  dropped. Subagent results never woke the main acorn agent.
  Broadened the web branch to handle both — same WebSocket
  broadcast mechanism with adjusted `channelName` / `platform` /
  `isDm`. Snapshots projectContext onto the task entry so the
  wake-up turn has the correct cwd/tools/tree.

## Files of record

| Path | Role |
|---|---|
| `src/graph/sessions.js` | session node lifecycle + distillSession + summarizeSessionNode + distill prompt |
| `src/graph/projects.js` | sessionId tag on freshly-created project nodes |
| `src/graph/prompt-sections.js` | Session block, plan-mode prompt (PHASE 1-6 + Execution Checklist), poll-avoidance directive, scratch directive, web-search guidance |
| `src/agent/loop.js` | round checkpoint, failure capture, sessionId thread-through, projectContext capture |
| `src/workers/learner.js` | sessionId tagging, identity guard, post-distill race guard, lifecycle events, trailing-cap |
| `src/tools/tools.js` | note_discovery, task_status hardening, task_create/progress broadcasts, _deliverTaskResult CLI fix, _currentProjectContext capture |
| `src/gateways/web.js` | session:start/end frame routes, ws.on('close') distill chain |
| `src/reference-nodes.sql` | ref-web-search node |
| `src/migrate-ref-web-search.sql` | idempotent retrofit for existing graphs |
| `src/app.js` | wire migrations |

acorn-cli (graphcorn branch):

| Path | Role |
|---|---|
| `go/cmd/acorn/main.go` | version |
| `go/internal/conn/ws.go` | session:start frame on connect |
| `go/internal/proto/messages.go` | SessionStart / SessionEnd frame types |
| `go/internal/app/model.go` | SessionEnd on quit, chatMsg.QuestionsBuf for JSON modal |
| `go/internal/app/sidepanels.go` | rich subagent progress, planTaskPanel, prune-on-chat-start |
| `go/internal/app/update.go` | task:* + subagent:* frame routing, post-stream questions parse |
| `go/internal/app/view.go` | three-panel layout (plan tasks / subagent / code) |
| `go/internal/app/updater.go` | /update install pre / fuzzy / list (from earlier work) |

## Known issues / parked items

- **Upstream model hangs**: GLM-5.1 and Kimi K2.6 occasionally stall
  with the HTTP connection open but zero bytes arriving (zero
  thinking tokens, zero deltas). Recovery is `docker restart sporebfl`.
  Not a SPORE bug; provider hiccup. Unresolved upstream-side.
- **TUI collapse for poll spam** (Phase 2 of the UX plan) deferred —
  the prompt + tool-side warning together appeared sufficient to
  prevent the loops in practice. If polling reappears, add the
  collapse renderer.
- **Optional plan-accept modal verification preview** (Phase 5
  optional) deferred — the verification section already shows in the
  plan body the user reviews.

## Verification surface

For a fresh acorn session:

1. Session node created at connect (id = `session-<sessionId>`,
   ttl=temp, sessionId=self).
2. Round breadcrumbs accumulate on the `rounds` aspect with full
   user/tool/exec/reply context.
3. `learner:start` / `learner:done` events visible per turn.
4. On disconnect (graceful or ungraceful):
   - Summary written (550-1200+ chars typical).
   - Distill runs once (idempotency-guarded), promotes session-temps
     into permanent framework / library / discovery nodes, soft-
     deletes losers to recycle_bin (7-day).
   - Project-node `scratch_helpers` aspect grows when `.acorn/scratch/*`
     files were written.
5. Next session in same project picks up framework gotchas via
   `graph_query` at start (load-gotchas directive).
6. Delegated tasks complete → main agent gets re-entered with a
   `task_complete` trigger summarizing findings, no manual poke
   required.

## Branches

- SPORE: `graphcorn-server` on `yumlevi/spore` — 25+ commits ahead of
  `acorn-server-side`. Mainline stays untouched until merge decision.
- acorn-cli: `graphcorn` on `yumlevi/acorn-cli` — 2 commits ahead of
  `main`. Released as `v0.2.0-graphcorn` and `v0.2.1-graphcorn`
  (pre-releases).

## Restorability

- All SPORE-side edits hot-deployed; `.bak.<ts>` snapshots kept
  alongside in the containers.
- `/api/admin/reset-graph` re-seeds with `seed-graph.sql` +
  `migrate-ref-*.sql` so a poisoned graph can be rebuilt cleanly.
- Session nodes are temp by design — graph naturally sheds the
  experimental cruft via the existing 48h janitor if graphcorn is
  abandoned.
- Reverting graphcorn means `git revert` the diff against
  `acorn-server-side` and `main`; no destructive migrations to roll
  back.
