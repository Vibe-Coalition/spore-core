// session-graph plugin — generic primitives for tracking long
// conversations as graph nodes. Other plugins (acorn-cli, future
// CLI / web / Discord trackers) declare this as a dependency and:
//   • require('../session-graph/lib/sessions')   — upsert / finalize /
//                                                  bumpTurn / summarize / distill
//   • require('../session-graph/lib/projects')   — upsert / get /
//                                                  noteProjectInteraction
//   • require('../session-graph/lib/heuristics') — looksLikeCodingTurn
//   • require('../session-graph/lib/checkpoints')— captureFailureFix /
//                                                  recordRoundCheckpoint
//   • require('../session-graph/lib/discovery')  — noteDiscovery
//
// This plugin's index.js itself only registers the `note_discovery`
// tool (generic enough that any session-aware plugin can use it).
// Everything else is exposed as plain require()-able modules — no
// special inter-plugin RPC API needed.

const { noteDiscovery } = require('./lib/discovery');

module.exports = function register(api) {
  // note_discovery tool — bare name (namespaced:false) preserves the
  // public contract for the agent. The generic ctx-driven gate (sessionId
  // = ctx.channelId when ctx.platform === 'cli') means this works for any
  // CLI-class session, not just acorn-cli.
  api.registerTool('note_discovery', {
    namespaced: false,
    description:
      'Persist a durable discovery to the knowledge graph and link it to the current session AND project. ' +
      'WHEN TO USE — any time a non-trivial fact or fix surfaces during a coding session: ' +
      '"this expo dev server defaults to 8081", "the python venv is at .venv/dev not .venv", ' +
      '"vault keys are read by the bun process via env, not the python wrapper". ' +
      'Avoids losing operator-supplied context to chat history when this conversation ages out. ' +
      'AUTOMATIC: outside a session, this tool stores the discovery as a permanent global node.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The discovery itself, written as a complete sentence. Keep under 500 chars.',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'gotcha', 'workflow', 'config', 'failure_fix'],
          description: 'Discovery flavor. Defaults to "fact".',
        },
        label: {
          type: 'string',
          description: 'Optional short label for the node id; auto-derived from text if omitted.',
        },
        relatedTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: existing node ids this discovery relates to. Adds `relates_to` edges.',
        },
      },
      required: ['text'],
    },
    execute: (input, ctx) => noteDiscovery(api, input, ctx),
  });

  api.getLogger().info('Plugin ready — note_discovery tool registered. Lib modules (sessions, projects, heuristics, checkpoints, discovery) available via require for dependent plugins.');
};
