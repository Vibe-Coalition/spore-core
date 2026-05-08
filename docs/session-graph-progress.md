# Session Graph Progress Notes

This file records the current session-graph behavior that grew out of earlier
project-memory work. It is intentionally operational rather than historical:
use the source files below as truth when implementation details change.

## Current Purpose

Session graph features let Spore Code and channel sessions create a temporary
work trail, then summarize and distill durable lessons into the right memory
scope.

Goals:

- keep project and channel context useful across sessions,
- avoid leaking private/scoped details into default memory,
- promote reusable lessons into General Knowledge,
- expose session summaries and distillation status in the UI,
- recover from disconnected clients by finalizing session work server-side.

## Source Files

| Path | Role |
|---|---|
| `src/graph/sessions.js` | session node lifecycle, summarize, distill |
| `src/graph/projects.js` | project graph identity and project nodes |
| `src/graph/scopes.js` | read/write graph scope rules |
| `src/graph/multi.js` | graph registry and database handles |
| `src/graph/prompt-sections.js` | prompt sections for scoped sessions |
| `src/agent/loop.js` | turn checkpoints, context capture, learner kickoff |
| `src/workers/learner.js` | scoped extraction writes |
| `src/workers/channel-distiller.js` | periodic channel distillation |
| `src/tools/tools.js` | graph/session/task tools |
| `src/gateways/web.js` | websocket session frames and UI routes |

## Session Lifecycle

Expected behavior:

1. Session starts with a stable session key and graph scope.
2. A session node records rounds, tool summaries, files touched, failures, and
   useful discoveries.
3. Learner writes go to the scoped graph.
4. Session summary can run automatically or from a session-node context menu.
5. Distillation promotes reusable knowledge to General Knowledge and leaves
   scoped details in the project/channel/user graph.
6. Late learner jobs should not write to the wrong graph after a session closes
   or reconnects.

## Project Sessions

Project graph identity should be stable. If the same project is opened again,
Spore should resolve back to the existing `project-*` graph instead of creating
duplicates. Another authorized collaborator on the same project should benefit
from prior distilled project knowledge and any reusable General Knowledge.

Project memory should not expose the full capability set of the Spore server.
The CLI prompt and tool catalog should describe only the capabilities actually
available to that coding session.

## Channel Sessions

Channel sessions often never have a natural end. The channel distiller uses idle
and periodic thresholds to summarize progress and promote reusable facts.

Recurring wakeups created from a channel must preserve:

- originating platform,
- channel/chat ID,
- user/person binding,
- session key,
- graph scope.

That prevents scheduled messages from landing in a web or CLI session.

## Manual Summary And Distill

The graph UI can expose summary/distill actions on session nodes. Manual actions
should use the same code path as normal lifecycle finalization:

- same graph scope,
- same distillation prompt,
- same idempotency protections,
- same event logging,
- same General Knowledge promotion rules.

## Verification Checklist

When changing session graph behavior, verify:

- reconnecting a client does not duplicate project graphs,
- a fresh project session recalls relevant General Knowledge,
- learners write to the scoped graph,
- benchmark actors do not appear in default unless the test explicitly targets
  default,
- channel wakeups return to the originating channel,
- manual session summary/distill buttons register and produce events,
- closing or restarting during distillation does not strand jobs without a
  retry path.
