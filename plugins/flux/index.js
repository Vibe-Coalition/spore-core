// flux plugin — FLUX image generation via api.bfl.ai.
//
// Two surfaces:
//   1. Reference node `ref-bfl-api` so the agent has authoritative
//      docs (model list, polling rules, display rules) when reasoning
//      about image generation.
//   2. `generate_image` tool that wraps the submit + poll loop into
//      one call. Returns a result.sample URL the agent can drop into
//      a markdown image. ~5–60s blocking call (the poll loop is
//      server-side so the operator just sees a single tool-call hop).

const flux = require('./lib/flux-api');

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    // v3 adds the "Can generate images using Flux." entry on the spore
    // node's capabilities aspect. The seed graph used to ship that
    // line hard-coded; bumping triggers uninstall+install on existing
    // installs so the seed-tagged row gets swept and re-inserted
    // tagged 'flux' (clean uninstall going forward). v2 did the same
    // dance for the ref-api-keys catalog (BFL_API_KEY entry).
    // v4 adds the spore→ref-bfl-api `documents` edge that used to live
    // in seed-graph.sql. Bump triggers uninstall+reinstall on existing
    // installs so the edge gets re-tagged 'flux' for clean uninstall.
    schemaVersion: 4,
  });

  api.registerTool('generate_image', {
    namespaced: false,
    description:
      'Generate an image with FLUX (api.bfl.ai). Wraps submit + poll-until-Ready in a single call so you do NOT need to write a polling loop. ' +
      'Returns { url, model, prompt, ms, id } where url is the result.sample (signed, ~1hr expiry — display promptly with ![alt](url)). ' +
      'Default model: flux-2-pro-preview. For image editing, pass input_image (URL, raw base64, or data URI). ' +
      'Typical generation: 5-15 seconds; this tool will poll for up to 60s before giving up. ' +
      'Use this LIBERALLY whenever the user asks for an image, a visual, or to edit/remix one. Always show the generated image inline.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Required. The image prompt. For edits, describe what CHANGED rather than the full scene.',
        },
        model: {
          type: 'string',
          description: 'Optional. Default flux-2-pro-preview. Allowed: flux-2-pro-preview, flux-kontext-pro, flux-kontext-max, flux-pro-1.1, flux-2-pro.',
        },
        width:  { type: 'number', description: 'Optional output width. Defaults to model preset.' },
        height: { type: 'number', description: 'Optional output height. Defaults to model preset.' },
        output_format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Optional. jpeg or png. Defaults to jpeg.',
        },
        seed: { type: 'number', description: 'Optional. Pin a seed for reproducibility.' },
        input_image: {
          type: 'string',
          description: 'Optional. For image editing: a URL, raw base64, or data URI of the source image. Pair with an edit-style prompt.',
        },
      },
      required: ['prompt'],
    },
    execute: async (input) => {
      const config = api._appContext?.config || {};
      try {
        const result = await flux.generate(config, input);
        api.getLogger().info(`generate_image: ${result.model} (${result.ms}ms) → ${result.url}`);
        return { ok: true, ...result };
      } catch (e) {
        api.getLogger().warn(`generate_image failed: ${e.message}`);
        return { error: e.message };
      }
    },
  });

  api.getLogger().info('Plugin ready — generate_image tool + ref-bfl-api node registered.');
};
