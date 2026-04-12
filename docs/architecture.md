# Architecture

Anima is a visual agentic system: autonomous AI agents whose entire cognitive state — identity, knowledge, relationships, and learned behaviors — is observable through an interactive knowledge graph. This document traces how a message flows through the system, from platform arrival to response delivery, and how the visual layer makes every decision inspectable.

## System overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Docker Container: <agent-id>                                    │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Discord  │  │ Telegram │  │  Slack   │  │   Web    │       │
│  │ Gateway  │  │ Gateway  │  │ Gateway  │  │ Gateway  │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       │              │              │              │             │
│       └──────────────┴──────┬───────┴──────────────┘             │
│                             │                                    │
│                    ┌────────▼────────┐                           │
│                    │ GatewayManager  │                           │
│                    │ (normalize msg) │                           │
│                    └────────┬────────┘                           │
│                             │                                    │
│              ┌──────────────▼──────────────┐                    │
│              │        AgentLoop            │                    │
│              │                             │                    │
│              │  1. Load/create session     │                    │
│              │  2. Build system prompt     │◄──── GraphContext  │
│              │  3. Call LLM               │◄──── MultiProvider │
│              │  4. Execute tool calls     │◄──── ToolSystem    │
│              │  5. Loop until done        │                    │
│              │  6. Stream response back   │                    │
│              └──────────────┬──────────────┘                    │
│                             │                                    │
│              ┌──────────────▼──────────────┐                    │
│              │     Background Workers      │                    │
│              │  Learner: extract facts     │                    │
│              │  Maintainer: graph health   │                    │
│              └─────────────────────────────┘                    │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │   graph.db   │   │ sessions.db  │   │   /workspace │       │
│  │ (knowledge)  │   │  (history)   │   │   (files)    │       │
│  └──────────────┘   └──────────────┘   └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
         │ Unix socket
         ▼
┌─────────────────────────┐
│ SSH Sidecar Container   │
│ network_mode: none      │
│ Decrypts keys, manages  │
│ ssh2 connections        │
└─────────────────────────┘
```

## Message lifecycle

### 1. Gateway receives a message

Each platform gateway listens for incoming messages on its native protocol:

- **Discord**: `discord.js` client events (`messageCreate`, `interactionCreate`)
- **Telegram**: Long-polling via `node-telegram-bot-api`
- **Slack**: WebSocket via `@slack/bolt` Socket Mode
- **Web**: WebSocket connection to the built-in web panel

The gateway normalizes the message into a common format:

```js
{
  content: "What's the weather like?",
  channelId: "discord:123456789",
  channelName: "general",
  userId: "user:987654321",
  userName: "Alice",
  isDm: false,
  platform: "discord",
  onText: (chunk) => { /* stream partial text back */ },
  onComplete: (result) => { /* final response */ },
}
```

### 2. Session management

`SessionManager` maintains conversation history per channel (or per-user for DMs). Sessions are keyed by `channelId + isDm + userId` and stored in `sessions.db`.

Sessions auto-compact when they exceed `compactTokenThreshold` — the LLM summarizes older messages and the session is trimmed to `compactKeepTail` recent messages plus the summary.

Sessions expire after `sessionIdleTimeoutMinutes` of inactivity and reset daily at `sessionDailyResetHour`.

### 3. System prompt assembly (GraphContext)

The system prompt is not a static file — it's assembled dynamically from the knowledge graph on every turn. `GraphContext.buildPrompt()` constructs sections in this order:

| Section | Source | Purpose |
|---------|--------|---------|
| `persona` | Agent node description | Core personality |
| `identity` | Agent node attributes | Name, background, traits |
| `voice` | Agent "voice" aspect | Speaking style, tone rules |
| `rules` | Rule nodes + "rules" aspects | Hard behavioral constraints |
| `selfknowledge` | Agent self-knowledge aspects | What the agent knows about itself |
| `plugin` | Plugin-injected context | External system context |
| `channel` | Channel node attributes | Per-channel rules and context |
| `person` | Person nodes for current user | Relationship, preferences, history |
| `relevant` | Retrieval results | Knowledge relevant to the current message |
| `episodes` | Episode FTS search | Raw conversation excerpts from past sessions |
| `anti` | Anti-pattern nodes | Things the agent should avoid |
| `feed` | Recent graph activity | What changed recently in the knowledge base |
| `tooling` | Tool capability nodes | Available tools and their descriptions |
| `behavior` | Behavioral tuning | Response length, formatting preferences |
| `reflections` | Maintainer reflections | Self-generated insights |
| `gaps` | Open knowledge gaps | Things the agent wants to learn |
| `runtime` | Boot-time config | Web URLs, platform status, current time |

Each section has a token budget. If the total exceeds `TOTAL_BUDGET` (12,000 tokens), sections are dropped in priority order (`gaps` first, then `anti`, `reflections`, etc.).

### 4. Retrieval

When a message arrives, `retrieval.js` searches for relevant knowledge using multiple strategies in parallel:

1. **FTS5 full-text search** on node descriptions and attribute content
2. **Vector similarity** using Gemini embeddings (if `GEMINI_API_KEY` is set)
3. **Temporal proximity** — recent nodes are boosted
4. **Graph walk** — follow edges from matched nodes to discover related context
5. **Episode search** — FTS on raw conversation transcripts

Results are ranked by a weighted score combining relevance, importance, recency, and graph centrality.

### 5. LLM call (MultiProvider)

`MultiProvider` routes requests to the appropriate backend based on model name prefix:

| Prefix | Backend | Key |
|--------|---------|-----|
| `claude-*` | Anthropic | `ANTHROPIC_API_KEY` |
| `gemini/*` | Google Gemini | `GEMINI_API_KEY` |
| `openrouter/*` | OpenRouter | `OPENROUTER_API_KEY` |
| `local/*` | Ollama / LM Studio / vLLM | `LOCAL_MODEL_API_KEY` |

The agent uses a tiered model system:

- **Casual** (`casualModel`): Quick responses, low-stakes conversations
- **Normal** (`normalModel`): Standard conversations and tool use
- **Planner** (`plannerModel`): Complex multi-step tasks, sub-agent orchestration

The loop escalates from casual to planner based on message complexity and tool usage.

### 6. Tool execution loop

When the LLM returns tool calls, `ToolSystem` executes them and feeds results back. The loop continues until the LLM responds with text only (no more tool calls) or a safety limit is reached.

Available tools:

| Tool | Purpose |
|------|---------|
| `exec` | Shell command execution (with `dangerousPatterns` blocklist) |
| `read_file` / `write_file` / `edit_file` | File operations within workspace |
| `web_search` / `web_fetch` | Internet access (Brave Search API) |
| `web_serve` | Start/stop a static file server |
| `browser` | Playwright browser automation (if installed) |
| `graph_query` / `graph_update` / `graph_delete` | Direct knowledge graph manipulation |
| `message_send` | Cross-platform messaging |
| `env_manage` | Environment variable access (redacted — writes to temp file) |
| `remote_exec` / `remote_read_file` / `remote_write_file` | SSH operations via sidecar |
| `ssh_tunnel` | SSH port forwarding |
| `save_tool` | Create persistent custom tools |
| `skill_lookup` / `skill_update` | Skill system for reusable knowledge |
| `delegate_task` | Spawn background sub-agents for parallel work |

Sub-agents get a restricted tool set (no `env_manage`, `remote_exec`, `remote_write_file`) to limit blast radius from prompt injection.

### 7. Learning (async)

After the agent responds, the `Learner` runs asynchronously:

1. Builds a compact summary of what the graph already knows
2. Sends the user+assistant exchange to a fast model (Haiku) with a structured extraction prompt
3. Model returns JSON: new entities, facts, relationships, and temporal markers
4. Diffs against existing graph to avoid duplicates
5. Writes genuinely new knowledge to `graph.db`
6. Triggers embedding generation for new/updated nodes

### 8. Maintenance (periodic)

The `Maintainer` runs on a heartbeat timer (default: every 2 hours, first run 30 minutes after boot):

1. **Gap detection** — find high-importance nodes with low attribute density
2. **Gap filling** — use graph context + web search + LLM to fill gaps
3. **Reflections** — generate insights on recently active or unreflected nodes
4. **Stale check** — flag data that's past its type-specific decay window
5. **Sparse connect** — find orphan nodes and connect them to related nodes

## Key design decisions

**Why SQLite, not Postgres/Mongo?** Each agent is a single-user system. SQLite gives zero-config persistence, atomic transactions, and the full database travels as a single file for backup/restore. The `node:sqlite` module (built into Node 22+) means no native addon compilation.

**Why dynamic prompts from a graph?** Static system prompts can't grow. The graph lets the agent accumulate knowledge over months of conversation and surface only what's relevant per-turn, staying within context window limits.

**Why a sidecar for SSH?** Process isolation. Even if an attacker gets RCE in the main container, they can't extract SSH private keys — those only exist decrypted in the sidecar's memory, and the sidecar has no network access to exfiltrate them.

**Why CommonJS?** Pragmatic choice. The codebase predates widespread ESM adoption in the Node ecosystem, and several dependencies (`discord.js`, `node:sqlite`) work fine with `require()`. No build step means less tooling to maintain.
