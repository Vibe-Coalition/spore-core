# Plugins

Plugins extend Spore without putting every integration in core. They can add
providers, tools, gateways, settings, routes, static assets, prompt sections,
workers, lifecycle hooks, browser backends, and reference nodes.

Plugins run as trusted Node.js code in the main process. There is no sandbox.

## Loading

Plugins are loaded from bundled and configured plugin directories when plugin
loading is enabled. Each plugin has a `spore.plugin.json` manifest and usually an
`index.js` entry point.

Do not place plugin directories inside agent-writable workspace paths. A plugin
directory is equivalent to executable application code.

## Manifest And API

Common plugin responsibilities:

- declare id, display name, description, category, and dependencies,
- register settings and settings UI,
- register tools with availability callbacks,
- register provider model prefixes,
- register browser backends,
- register gateways,
- register HTTP routes/static assets,
- register prompt sections,
- install/uninstall reference-node SQL,
- start/stop lifecycle workers.

The host API lives in `src/plugins/api.js`; lifecycle orchestration lives in
`src/plugins/manager.js`.

## Reference Nodes

Plugins can ship SQL reference nodes that teach the agent how to use a tool or
integration. These nodes install into General Knowledge, not the default graph.

Reference-node SQL should tag records with:

```sql
extracted_with='{{plugin_id}}'
```

That lets uninstall cleanup remove plugin-owned rows and lets the plugin manager
repair old copies that landed in the wrong graph.

## Bundled Plugins

| Plugin | Category | Purpose |
|---|---|---|
| `anthropic-provider` | model provider | Claude models |
| `openai-provider` | model provider | OpenAI Responses models |
| `openrouter-provider` | model provider | OpenRouter models |
| `gemini-provider` | model provider | Gemini chat and multimodal models |
| `z-ai-provider` | model provider | Z.ai/GLM models |
| `local-oai-provider` | model provider | custom OpenAI-compatible endpoints |
| `embedder-gemma` | embedding | local Gemma embeddings |
| `gemini-embedder` | embedding | Gemini embeddings |
| `browser-core` | browser | owns the `browser` tool |
| `zendriver` | browser backend | stealth CDP backend |
| `playwright` | browser backend | Playwright Chromium backend |
| `telegram` | channel | Telegram bot gateway |
| `slack` | channel | Slack Socket Mode gateway |
| `discord` | channel | Discord bot gateway |
| `deepgram` | voice | Deepgram STT |
| `whisper` | voice | OpenAI/browser Whisper STT |
| `elevenlabs` | voice | ElevenLabs TTS |
| `flux` | media | FLUX image generation |
| `email` | communication | SMTP/IMAP tools |
| `tailscale` | networking | Tailscale status/login/settings |
| `ssh-sidecar` | remote access | optional SSH credential isolation |
| `compute-cluster` | remote access | SLURM/tailnet cluster integration |
| `cron` | operations | agent-facing cron guidance, hidden from CLI |
| `session-graph` | memory | session nodes, summaries, distillation primitives |
| `spore-code` | client | Spore Code protocol, project context, plan mode |
| `spore-code-benchmark` | evaluation | coding benchmark runner |
| `longmemeval` | evaluation | long-memory benchmark |

## Installation And Removal

Installing a plugin can:

- add settings,
- add routes or static UI,
- expose new tools,
- add provider models,
- start background services,
- install reference nodes into General Knowledge.

Uninstalling should:

- remove its tools/routes/provider entries,
- stop plugin workers,
- remove plugin-owned reference nodes,
- preserve user data unless the plugin explicitly owns disposable state.

## Tool Availability

Plugin tools should define where they are valid. Examples:

- `browser` is web/channel scoped and hidden from CLI sessions.
- `cron` is hidden from CLI sessions.
- Spore Code tools require a connected Spore Code client.
- Channel tools should preserve platform/channel/user origin.

Add tests when changing tool availability.

## Plugin Development Checklist

- Add `spore.plugin.json`.
- Keep dependencies in the plugin when possible.
- Register settings through the plugin API.
- Gate tools by session/channel/platform.
- Write reference-node SQL for agent-facing capability docs.
- Make install/uninstall idempotent.
- Add focused tests for routing, settings, and cleanup.
- Avoid hardcoded hostnames, usernames, paths, or private credentials.
