# User Guide

The Anima web panel is a live window into your agent's mind. It lets you observe the knowledge graph evolving in real time, chat with the agent, browse its workspace, and connect to remote systems — all from a single visual interface.

---

## Web Panel Layout

The web panel has three panes:

| Pane | Position | Purpose |
|---|---|---|
| **Node/Files/Logs** | Left | Browse graph nodes, workspace files, and agent logs |
| **Graph Canvas** | Center | Interactive knowledge graph visualization + terminal |
| **Chat** | Right | Converse with the agent, attach files, use voice |

Panes are resizable by dragging the borders between them. The chat and node panels can be toggled via the **chat** and **nodes**/**files**/**logs** buttons in the top toolbar.

---

## Chat

Type a message in the text box at the bottom-right and click **send** (or press Enter). The agent streams its response in real-time.

### Attachments

Click **attach** to upload images, audio, or video. Files are sent as base64 alongside the message. The agent can view images and process audio.

### Voice

- **mic** — record and send a voice message. Transcribed via Deepgram STT, processed by the agent, and returned as text.
- **call** — start a live voice call. Audio streams continuously with interrupt detection and TTS responses.

Voice requires Deepgram STT configured in the agent's `.env`. TTS falls back to free Edge TTS if no paid provider is set.

### Session Management

- **clear** — wipe the current chat session. Does not affect the knowledge graph.
- **stop** — interrupt the agent mid-response.

---

## Knowledge Graph

The center canvas shows a force-directed graph of all nodes and their relationships. Nodes are color-coded by type (person, tool, concept, project, etc.).

### Navigation

- **Scroll** to zoom in/out
- **Drag** the background to pan
- **Click** a node to select it and view details in the left panel
- **center** button resets zoom to fit all nodes

### Filtering

- Use the **type dropdown** to filter by node type
- Use the **search bar** to find nodes by name

### Creating Nodes

Click **+ node** in the toolbar to create a new node manually. The agent also creates nodes automatically through conversation learning.

---

## Node Details Panel

When you select a node, the left panel shows:

- **Node header** — name, type, creation date
- **Aspects** — grouped facets (identity, voice, constraints, etc.)
- **Attributes** — individual facts within each aspect, with importance scores and timestamps
- **Edges** — relationships to other nodes (click to navigate)

You can edit attributes and aspects directly in this panel.

---

## File Browser

Click **files** in the toolbar to browse the agent's `/workspace` directory. You can:

- Navigate directories
- View file contents
- The agent can create and edit files here via tools

---

## Logs

Click **logs** to view real-time agent logs. Useful for debugging tool calls, learner extraction, and gateway events.

---

## Interactive Terminal

Click the **terminal** button at the bottom-left of the graph canvas to open an interactive terminal.

### Local Shell

The default mode opens a bash shell inside the agent's container at `/workspace`. Useful for inspecting files, running scripts, or debugging.

### Remote SSH

To connect to external servers:

1. Click **hosts** in the terminal header
2. Fill in hostname, port, username
3. Paste an SSH private key (PEM format) or enter a password
4. Click **Save**, then **Test** to verify connectivity
5. Select the host from the dropdown and click **connect**

**Key security:**
- SSH keys are encrypted with AES-256-GCM before storage
- Keys are never sent back to the browser after saving
- When the SSH sidecar is deployed, keys are isolated in a separate process with no network access

### Terminal Controls

- **Resize** — drag the top edge of the terminal pane up/down
- **close** — disconnect and hide the terminal
- **connect** — reconnect to the selected host

---

## Subagent Activity

When the agent delegates a background task (via `delegate_task`), a subagent activity bar appears above the terminal showing:

- Current subagent status (thinking, tool use, text output)
- Real-time streaming of subagent reasoning

---

## LongMemEval Benchmark

From the gear menu (top-right of canvas), select **LongMemEval** to run the memory benchmark:

1. Choose variant (Oracle, Small, Medium)
2. Select question types to evaluate
3. Choose learner and answering models
4. Click **Start**

Results show accuracy breakdown by question type with comparisons to published baselines.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Enter | Send message |
| Shift+Enter | New line in message |
| Escape | Close modals |

---

## Tips

- The agent learns from every conversation. Ask it to remember facts and it will store them in the knowledge graph.
- Use `graph_query` in conversation to ask the agent to search its own memory.
- The agent can serve web pages from `/workspace/web/` — ask it to build you a dashboard.
- Background tasks (`delegate_task`) are great for long research or code generation tasks that would otherwise block the conversation.
