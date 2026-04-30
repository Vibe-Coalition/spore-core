/**
 * tools.js — Tool System
 * 
 * Defines and executes tools that Claude can call.
 * Each tool has a definition (for the API) and an executor function.
 */

const { exec: execCb } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(execCb);
const https = require('https');
const http = require('http');

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });
const fs = require('fs');
const path = require('path');
const { embedNodeAsync } = require('../graph');
const graphEvents = require('../graph/events');
const { effortDefaults } = require('../agent/effort');
const SkillsManager = require('./skills');
const { parseInstallCommand, vetPackages, RISK_LEVEL } = require('./package-vet');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// Per-tool-call async context. Replaces any notion of a "global current
// session" — carries sessionKey + userId + channelId + platform through the
// async callstack. Each executeTool invocation wraps its handler in
// `_execContext.run(ctx, () => ...)` so concurrent sessions never step on
// each other.
const _execContext = new AsyncLocalStorage();

// Tools that mutate persistent state. Plan-mode gates these through a
// proposal queue instead of executing directly. Read-only tools (queries,
// fetches, list operations) never appear here so planning runs unimpeded.
const MUTATING_TOOLS = new Set([
  'graph_update', 'graph_delete',
  'web_serve', 'exec', 'remote_exec',
  'write_file', 'edit_file', 'remote_write_file',
  'email_send', 'message_send', 'message_edit', 'message_react',
  'notify_user', 'env_manage', 'save_tool',
]);

// Tools that are meaningless for cli (acorn) sessions and should NOT be
// advertised to the model when platform === 'cli'. Stripping them from the
// catalog reclaims ~1800 tokens per prompt and prevents the agent from
// reaching for tools it can't usefully invoke (web_serve is refused locally
// by the Go binary; anima_*/spore_message target the multi-agent mesh;
// remote_*/ssh_tunnel are for sidecar-machine flows; browser is a
// container-side puppeteer; message_* are Discord/Telegram surfaces
// distinct from the cli TUI; env_manage / startup_tasks / data_poller /
// list_custom_tools are SPORE-server admin). Keep graph_*, query_about,
// delegate_task, task_*, schedule_*, web_search, web_fetch, ask_user,
// notify_user, save_tool, sleep, skill_*, session_*, log_watch_*, plus
// every plugin-contributed tool — those all work cleanly from a cli turn.
const TOOLS_EXCLUDED_FROM_CLI = new Set([
  'web_serve', 'browser',
  'message_send', 'message_react', 'message_edit', 'message_read',
  'env_manage',
  'remote_exec', 'remote_tail', 'remote_tmux_kill',
  'remote_read_file', 'remote_write_file', 'ssh_tunnel',
  'startup_tasks', 'data_poller',
  'anima_list', 'spore_message', 'anima_graph', 'anima_manage',
  'list_custom_tools',
]);

class ToolSystem {
  constructor(config, logger, discordClient, graphContext, llmClient) {
    this.config = config;
    this.log = logger;
    this.discord = discordClient;
    this.graph = graphContext;
    this.llmClient = llmClient;
    this.learner = null;
    this.platformManager = null;
    this.skills = new SkillsManager(logger, config.sharedSkillsDir);
    this.gateway = null;

    // Credential guard mode for write tools — 'block' (default) | 'warn' | 'off'
    const rawGuard = (config.credentialGuard || 'block').toLowerCase();
    this._credentialGuardMode = ['block', 'warn', 'off'].includes(rawGuard) ? rawGuard : 'block';

    // Global process tracker — caps total child processes to prevent fork bombs
    this._trackedPids = new Set();
    this._maxChildProcesses = config.maxChildProcesses || 32;

    this.dangerousPatterns = [
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/(\s|$)/, // rm -rf / (any flag combo with 'r' targeting /)
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\*/, // rm -rf /*
      /\bsudo\s+(?!apt-get\b|apt\b|dpkg\b)\S/,  // sudo anything except apt-get/apt/dpkg
      /\bdoas\b/,                 // doas (sudo alternative)
      /\bpkexec\b/,              // polkit exec as root
      /\bchmod\s+[0-7]*7[0-7]{0,2}\b/, // world-writable (any x7x or xx7)
      /\bdd\s+if=/,               // dd if=
      /\bmkfs\b/,                 // mkfs
      /\bshutdown\b/,             // shutdown
      /\breboot\b/,               // reboot
      />\s*\/dev\/[shv]d[a-z]/,   // write to disk devices
      />\s*\/dev\/nvme/,          // write to NVMe devices
      /\bprintenv\b/,             // printenv leaks secrets
      /\bcat\s+\/proc\/.*environ/,// /proc/*/environ leaks secrets
      /\/proc\/\S*\/environ/,     // any process environ
      /^\s*env\s*$/,              // bare 'env' dumps all secrets
      /\benv\s+-/,               // env with flags
      /os\.environ/,              // python environ access
      /\bexport\b.*=.*KEY/i,     // export KEY= patterns
      /\bset\b\s*$/,             // bare 'set' dumps env in bash
      /\bcompgen\b/,             // bash completion can enumerate env
      /\bdeclare\s+-x/,          // declare -x exports all env
      /\/etc\/shadow/,           // password file
      /\/etc\/passwd/,           // user enumeration
      /\bcurl\b.*169\.254/,      // cloud metadata IP
      /\bwget\b.*169\.254/,      // cloud metadata IP via wget
      /\bcurl\b.*metadata/i,     // cloud metadata endpoint probing
      /\biptables\b/,            // firewall manipulation
      /\bnftables\b/,            // firewall manipulation
      /\bnsenter\b/,             // namespace escape
      /\bunshare\b/,             // namespace manipulation
      /\bchroot\b/,              // change root
      /\bchattr\b.*\+i/,         // make files immutable
      /:\(\)\s*\{.*;\s*\}\s*;/,  // fork bomb :() { :|:& }; :
      /\bfork\s*\(/,             // fork() calls
      /while\s+true.*do.*&.*done/, // while true; do cmd & done
      /for\s+.*;\s*do.*&.*done/, // for loop backgrounding
    ];
  }

  /**
   * Reap dead PIDs from the tracker and return the count of still-alive processes.
   */
  _reapProcesses() {
    for (const pid of this._trackedPids) {
      try {
        process.kill(pid, 0); // signal 0 = existence check, doesn't kill
      } catch {
        this._trackedPids.delete(pid);
      }
    }
    return this._trackedPids.size;
  }

  /**
   * Track a child process PID. Returns false if the process cap is exceeded.
   */
  _trackProcess(pid) {
    const alive = this._reapProcesses();
    if (alive >= this._maxChildProcesses) {
      this.log.error(`[proc-guard] Process cap reached (${alive}/${this._maxChildProcesses}) — refusing to spawn pid ${pid}`);
      try { process.kill(pid, 'SIGKILL'); } catch (e) { this.log.warn('[tools] process.kill failed: ' + e.message); }
      return false;
    }
    this._trackedPids.add(pid);
    return true;
  }

  /**
   * Kill all tracked child processes (cleanup on shutdown or emergency).
   */
  _killAllTracked() {
    for (const pid of this._trackedPids) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { this.log.warn('[tools] process.kill failed: ' + e.message); }
    }
    setTimeout(() => {
      for (const pid of this._trackedPids) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { this.log.warn('[tools] process.kill failed: ' + e.message); }
      }
      this._trackedPids.clear();
    }, 3000);
  }

  _currentConversationTarget() {
    // Prefer AsyncLocalStorage (per-session, race-safe) over the
    // singleton legacy globals so concurrent sessions don't cross-route
    // each other's messages.
    const ctx = this._ctx?.() || {};
    const channelId = ctx.channelId ?? this._currentChannelId;
    if (!channelId) return null;
    const raw = String(channelId);
    if (/^[a-z]+:/i.test(raw)) return raw;
    const platform = String(ctx.platform ?? this._currentPlatform ?? 'discord').toLowerCase();
    return `${platform}:${raw}`;
  }

  _resolveMessageTargetInput(input = {}) {
    return input.target || input.channelId || this._currentConversationTarget() || null;
  }

  _resolveMessageTargetMeta(input = {}) {
    const target = this._resolveMessageTargetInput(input);
    const ctx = this._ctx?.() || {};
    let platform = String(input.platform || ctx.platform || this._currentPlatform || 'discord').toLowerCase();
    if (this.platformManager) {
      const parsed = this.platformManager.parseTarget({ target, platform });
      return { target, platform: parsed.platform, id: parsed.id };
    }
    const match = /^([^:]+):(.+)$/.exec(String(target || ''));
    if (match) {
      platform = match[1].toLowerCase() === 'tg' ? 'telegram' : match[1].toLowerCase();
      return { target, platform, id: match[2] };
    }
    return { target, platform, id: target };
  }

  /**
   * Get tool definitions for the Anthropic API.
   *
   * When the active session is Spore Code (platform='cli'), the catalog is
   * filtered through TOOLS_EXCLUDED_FROM_CLI so the model only sees tools
   * it can actually use on the user's machine + via SPORE. Significantly
   * shrinks the prompt and stops the agent from reaching for things like
   * web_serve (refused locally) or anima_* (multi-agent mesh).
   *
   * Platform resolution order (most → least specific):
   *   1. explicit `opts.platform` arg — caller knows the session
   *   2. AsyncLocalStorage `_execContext.getStore().platform` — when called
   *      from inside an executeTool() wrap
   *   3. `this._currentPlatform` — legacy global, best-effort fallback that
   *      can race when concurrent sessions of different platforms run
   *      together (e.g. web + cli at once). DO NOT rely on this fallback
   *      for new code; the explicit-arg or AsyncLocalStorage paths are
   *      session-safe.
   */
  getToolDefinitions(opts = {}) {
    const all = [
      {
        name: 'exec',
        description: 'Execute a shell command. ONLY for running scripts, installing packages, git, or commands with no dedicated tool. Do NOT use exec for reading files (use read_file), writing files (use write_file), or searching file contents (use read_file). Using grep/sed/cat via exec wastes iterations when read_file/write_file exist.',
        input_schema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute',
            },
            workdir: {
              type: 'string',
              description: 'Working directory (defaults to /home/ubuntu)',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default 30000)',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'message_send',
        description: 'Send a message to a chat target. Supports Discord and Telegram. If `target`/`channelId` is omitted, the current conversation is used. For cross-chat sends, use `target` like `discord:123` or `telegram:456`. For backward compatibility, `channelId` also works.',
        input_schema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'Platform target, e.g. discord:1234567890, telegram:-100123456',
            },
            channelId: {
              type: 'string',
              description: 'Legacy target field; treated the same as `target`',
            },
            content: {
              type: 'string',
              description: 'Message content to send (can be empty string if only sending a file)',
            },
            filePath: {
              type: 'string',
              description: 'Absolute path to a file to attach (e.g. /app/starburst.mp4)',
            },
          },
          required: [],
        },
      },
      {
        name: 'message_react',
        description: 'React to a message with an emoji when supported by the target platform. If `target`/`channelId` is omitted, the current conversation is used. For cross-chat actions, use `target` like `discord:123` or `telegram:456`. Legacy `channelId` also works.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Platform target, e.g. discord:1234567890, telegram:-100123456' },
            channelId: { type: 'string', description: 'Legacy target field; treated the same as `target`' },
            messageId: { type: 'string', description: 'Platform message ID to react to' },
            emoji: { type: 'string', description: 'Emoji to react with (Unicode emoji like 👍 or custom emoji name)' },
          },
          required: ['messageId', 'emoji'],
        },
      },
      {
        name: 'message_edit',
        description: 'Edit a message you previously sent when supported by the platform. If `target`/`channelId` is omitted, the current conversation is used. For cross-chat edits, use `target` like `discord:123` or `telegram:456`. Legacy `channelId` also works.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Platform target, e.g. discord:1234567890 or telegram:-100123456' },
            channelId: { type: 'string', description: 'Legacy target field; treated the same as `target`' },
            messageId: { type: 'string', description: 'Message ID to edit' },
            content: { type: 'string', description: 'New message content' },
          },
          required: ['messageId', 'content'],
        },
      },
      {
        name: 'message_read',
        description: 'Read recent messages from a chat target. If `target`/`channelId` is omitted, the current conversation is used. Discord reads live platform history; Telegram reads recent in-memory history seen by the agent.',
        input_schema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'Platform target, e.g. discord:1234567890, telegram:-100123456',
            },
            channelId: {
              type: 'string',
              description: 'Legacy target field; treated the same as `target`',
            },
            limit: {
              type: 'number',
              description: 'Number of messages to read (default 10, max 50)',
            },
          },
          required: [],
        },
      },
      {
        name: 'graph_query',
        description: 'Query the knowledge graph. Search for nodes by label, ID, or content. Use to look up information about people, projects, channels, rules, etc. When a shared project graph is available, use the "project" parameter to search that graph instead of the local one.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query — matches against node labels, descriptions, IDs, and aliases',
            },
            nodeId: {
              type: 'string',
              description: 'Get a specific node by exact ID',
            },
            type: {
              type: 'string',
              description: 'Filter by node type (person, channel, rule, concept, project, etc.)',
            },
            project: {
              type: 'string',
              description: 'Shared project slug to query (e.g. "research-alpha"). Omit for local graph.',
            },
          },
        },
      },
      {
        name: 'query_about',
        description: 'Ask a natural language question about any entity in your knowledge graph and get a synthesized, reasoned answer. Uses all stored facts, relationships, derived conclusions, reflections, and episodes to produce a comprehensive response. Use this when you need deep insight about a person, project, or concept — especially for questions like "What does X care about?", "What\'s the relationship between X and Y?", or "What patterns do you notice about X?".',
        input_schema: {
          type: 'object',
          properties: {
            entity: {
              type: 'string',
              description: 'Entity name or ID to reason about (e.g. "kyle", "spore-project")',
            },
            question: {
              type: 'string',
              description: 'Natural language question about the entity (e.g. "What are their main interests?", "How has their mood changed recently?")',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'graph_update',
        description: 'Update or create a node in the knowledge graph. Can also add aspects (facets) with attributes (facts) and edges (relationships). Use to persist learned information. IMPORTANT: Always use graph_query first to check if a node already exists before creating a new one — duplicate nodes fragment knowledge.\n\n' +
          '**Use `temp: true` aggressively for task-scoped scratch nodes** — error logs, crawl dumps, debug traces, intermediate batch outputs, diagnostic captures, one-off project scaffolds, anything you\'d want to reference for the next 10 minutes but never again. The graph auto-cleans them after 48h of inactivity. This is CHEAP — don\'t hoard everything in the permanent graph out of fear of losing it. A graph packed with stale "crawl-run-3-errors" nodes is worse than one that forgot them.\n\n' +
          'Concrete cases where temp: true is correct:\n' +
          '- Logging errors/failures from a single task run → `temp: true`\n' +
          '- Capturing a batch of crawled URLs/items that you\'ll process once → `temp: true`\n' +
          '- Recording a temporary port-forward, tunnel config, or session token → `temp: true`\n' +
          '- Holding intermediate data between tool calls during one task → `temp: true`\n' +
          '- Scratch todo lists / working outlines you\'ll throw away once done → `temp: true`\n\n' +
          'Pass `temp: false` to promote a previously-temp node you now want to keep. Omit `temp` to leave lifetime unchanged.' +
          (this.config.personalityEditable ? '' : ' Note: personality aspects (identity, voice, rules) on your own node are read-only.'),
        input_schema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Node ID (lowercase, hyphenated)' },
            label: { type: 'string', description: 'Human-readable label' },
            type: { type: 'string', description: 'Node type (person, concept, project, etc.)' },
            description: { type: 'string', description: 'Node description text' },
            temp: { type: 'boolean', description: 'true = ephemeral scratch node (auto-purges after ~48h); false = promote to permanent; omitted = leave lifetime unchanged.' },
            aspects: {
              type: 'array',
              description: 'Aspects (facets) to add to the node',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Aspect name (e.g. preferences, skills)' },
                  attributes: { type: 'array', items: { type: 'string' }, description: 'Facts within this aspect' },
                  importance: { type: 'number', description: '1-10 importance' },
                },
                required: ['name'],
              },
            },
            edges: {
              type: 'array',
              description: 'Relationships to other nodes',
              items: {
                type: 'object',
                properties: {
                  target: { type: 'string', description: 'Target node ID' },
                  type: { type: 'string', description: 'Relationship type (knows, uses, created, etc.)' },
                },
                required: ['target', 'type'],
              },
            },
            project: {
              type: 'string',
              description: 'Shared project slug to write to (e.g. "research-alpha"). Omit for local graph.',
            },
          },
          required: ['nodeId', 'label', 'type'],
        },
      },
      // note_discovery moved to plugins/spore-code/ in phase 2.3c-2.
      {
        name: 'graph_delete',
        description: 'Delete a node, aspect, attribute, or edge from the knowledge graph. The deletion is reflected in real-time on the graph viewer.',
        input_schema: {
          type: 'object',
          properties: {
            nodeId: { type: 'string', description: 'Delete an entire node and its aspects/attributes/edges' },
            aspectId: { type: 'number', description: 'Delete a specific aspect by ID (and its attributes)' },
            attributeId: { type: 'number', description: 'Delete a specific attribute by ID' },
            edge: {
              type: 'object',
              description: 'Delete an edge',
              properties: {
                source: { type: 'string' },
                target: { type: 'string' },
                type: { type: 'string' },
              },
            },
            project: {
              type: 'string',
              description: 'Shared project slug to delete from (e.g. "research-alpha"). Omit for local graph.',
            },
          },
        },
      },
      {
        name: 'delegate_task',
        description: 'Start a background sub-agent to perform a task asynchronously. Returns a taskId immediately. IMPORTANT: The result will be delivered to this channel AUTOMATICALLY when the task finishes — you do NOT need to call task_status or wait. Reply to the user with a brief acknowledgment and END YOUR TURN. You remain free to handle other messages while the task runs. The sub-agent has full file/web/graph access by default; pass persona to scope it to a focused role. Users can redirect a running task with task_update, check progress with task_status, or stop it with task_cancel. BEST PRACTICE: Give the sub-agent a clear, specific task description with the approach to take — not a vague goal. A focused plan reduces wasted tool calls.',
        input_schema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Clear description of the task to delegate' },
            context: { type: 'string', description: 'Any context the sub-agent needs' },
            persona: { type: 'string', enum: ['researcher'], description: 'Optional focused role. "researcher" = web_search + web_fetch only, returns a structured findings summary with citations. Cannot modify state. PREFERRED in plan mode for parallel web investigations (libraries, frameworks, best practices, current docs). Omit for general-purpose sub-agents with full tool access.' },
            model: { type: 'string', description: 'Model override (defaults to subagentModel or main model)' },
            timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default 1200, max 1800)' },
            maxIterations: { type: 'number', description: 'Max iterations/tool-call rounds (default 100, max 200). Increase for complex multi-step tasks.' },
            tools: { type: 'boolean', description: 'Give subagent access to tools (default true)' },
          },
          required: ['task'],
        },
      },
      {
        name: 'task_status',
        description: 'Quick non-blocking check on a background task. ONLY use this if the user explicitly asks "where are we on that task?" or similar. **DO NOT POLL.** Task results are delivered AUTOMATICALLY as a new user message when complete (via task_complete trigger). If you have delegated tasks running and no other work, END YOUR TURN — do not call task_status + sleep in a loop. This tool exists solely to answer the operator\'s direct "how\'s it going" questions.',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID returned by delegate_task' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'task_cancel',
        description: 'Cancel a running background task. Use when the user asks to stop/cancel/abort a task.',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to cancel' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'task_update',
        description: 'Send new instructions to a running background task. The sub-agent will see the message on its next iteration and adjust accordingly. Use when the user wants to change direction, add requirements, or give feedback mid-task.',
        input_schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'Task ID to update' },
            message: { type: 'string', description: 'New instructions or feedback for the sub-agent' },
          },
          required: ['taskId', 'message'],
        },
      },
      {
        name: 'schedule_wakeup',
        description: 'Defer a follow-up by asking the harness to re-enter this session with your chosen prompt after N seconds. Use when you need to check back on something after a known wait (a deploy finishing, a SLURM job starting, a rate-limit resetting). Releases this session immediately — do NOT loop with `sleep`. Minimum 60s, maximum 3600s.',
        input_schema: {
          type: 'object',
          properties: {
            delaySeconds: { type: 'integer', minimum: 60, maximum: 3600, description: 'Seconds from now to fire' },
            prompt: { type: 'string', description: 'What next-turn-you should see as the user message when it wakes' },
            reason: { type: 'string', description: 'Short label for logs and list display' },
          },
          required: ['delaySeconds', 'prompt'],
        },
      },
      {
        name: 'list_wakeups',
        description: 'List pending wakeups for this session.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'cancel_wakeup',
        description: 'Cancel a pending wakeup by id.',
        input_schema: {
          type: 'object',
          properties: { wakeupId: { type: 'integer' } },
          required: ['wakeupId'],
        },
      },
      {
        name: 'task_create',
        description: 'Create a persistent task in the shared task list. Use for work that spans more than one back-and-forth, especially multi-step plans where you want to track progress across sessions. Tasks persist across restarts; the operator can come back later and you still know where you left off. Use blockedBy to express dependencies.',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Short title (1 line)' },
            description: { type: 'string', description: 'Full details of what needs doing' },
            blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that must be done first' },
            priority: { type: 'integer', description: '1 (urgent) to 5 (someday); default 3' },
            id: { type: 'string', description: 'Optional explicit id (slug). Auto-generated if omitted.' },
          },
          required: ['subject'],
        },
      },
      {
        name: 'task_progress',
        description: 'Update a task in the persistent list: change status, record result, add a progress note, adjust blocked_by or priority. Use as you finish each step.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'cancelled', 'error'] },
            result: { type: 'string', description: 'Final result / summary when marking done' },
            note: { type: 'string', description: 'Appends a comment to the task timeline' },
            blockedBy: { type: 'array', items: { type: 'string' } },
            priority: { type: 'integer' },
          },
          required: ['id'],
        },
      },
      {
        name: 'task_list',
        description: 'List tasks with optional status filter. sessionScope: "session" (this session only, default), "owned" (any task you own), "all" (creator only).',
        input_schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status, or omit for "not done and not cancelled"' },
            sessionScope: { type: 'string', enum: ['session', 'owned', 'all'] },
            limit: { type: 'integer', description: 'Max rows (default 50)' },
          },
        },
      },
      {
        name: 'task_get',
        description: 'Read a single task with all its comments.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      {
        name: 'log_watch',
        description: 'Monitor a log file or command output and inject matching lines into this session as they arrive. Use when you need to watch a running job (training loss, deploy log, job startup). Matching lines arrive as interjections mid-turn. Burst-coalesced to avoid noise. Prefer this over calling `remote_tail` repeatedly — it is continuous.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Local absolute path, or ssh://host/absolute/path' },
            match: { type: 'string', description: 'Regex (ripgrep -E syntax). Keep it tight — matches become interjections.' },
            tag: { type: 'string', description: 'Short label shown in injected messages' },
            maxMatches: { type: 'integer', description: 'Auto-stop after N matches (default 200)' },
            idleKillMs: { type: 'integer', description: 'Kill if no matches in this long (default 300000)' },
            timeoutMs: { type: 'integer', description: 'Hard kill after this (default 3600000)' },
          },
          required: ['path', 'match'],
        },
      },
      {
        name: 'log_watch_list',
        description: 'List active log watches for this session.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'log_watch_stop',
        description: 'Stop a specific log watch by id.',
        input_schema: {
          type: 'object',
          properties: { watchId: { type: 'string' } },
          required: ['watchId'],
        },
      },
      {
        name: 'ask_user',
        description: 'Pause and ask the operator a structured multi-choice question. The chat shows a picker card with 2–5 options; the operator clicks one and the answer flows back to you as this tool\'s result. Use only when you genuinely need a decision you cannot infer from context (merge survivor, provider selection). Do NOT use for rhetorical questions or information-gathering.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short button text (1-5 words)' },
                  description: { type: 'string', description: 'Explanation of what choosing this means' },
                },
                required: ['label'],
              },
              minItems: 2,
              maxItems: 5,
            },
            timeoutMs: { type: 'integer', description: 'Give up after this long (default 300000 / 5 min)' },
          },
          required: ['question', 'options'],
        },
      },
      {
        name: 'web_search',
        description: `Search the web for real-time information. IMPORTANT: Today is ${new Date().toISOString().slice(0, 10)} (year ${new Date().getFullYear()}). Your training data may be outdated — ALWAYS use web_search for questions about current events, recent releases, benchmarks, pricing, model comparisons, or anything where recency matters. Include the current year (${new Date().getFullYear()}) in queries when searching for recent information. Do NOT rely on pre-trained knowledge for factual claims about technology, products, or events from the past 12 months.`,
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: `Search query. Include the year ${new Date().getFullYear()} when searching for recent/current information.` },
            count: { type: 'number', description: 'Number of results (default 5, max 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description: 'Fetch a URL and extract its text content. Returns the page title and readable text. Use to read articles, documentation, web pages, or API responses. Prefer fetching primary sources (official docs, research papers, release blogs) over secondary summaries. For API calls requiring authentication, use the `credential` parameter with the vault key name (e.g. "REPLICATE_API_TOKEN") — the request is proxied through the manager which injects the key securely, so you never need to handle raw API keys.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            maxLength: { type: 'number', description: 'Max characters to return (default 8000)' },
            credential: { type: 'string', description: 'Vault key name for authenticated API calls (e.g. "REPLICATE_API_TOKEN"). The request is routed through the secure manager proxy which injects the key.' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET). Required for API calls.' },
            body: { type: 'object', description: 'Request body for POST/PUT/PATCH requests. Sent as JSON.' },
            headers: { type: 'object', description: 'Additional headers to include in the request.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'read_file',
        description: `Read a file. PREFERRED over exec+grep/cat/sed for all file reading. Returns full text content. Supports offset/limit for large files. Always use this instead of exec to inspect code or configs.${this.config.hostReadPaths?.length ? ' Host filesystem is mounted read-only at /host/ — e.g. /host/home/ubuntu/myfile.txt reads from the host.' : ''}${this.config.extraPaths?.length ? ` Additional accessible paths: ${this.config.extraPaths.join(', ')}` : ''}`,
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Absolute path to the file${this.config.hostReadPaths?.length ? '. Use /host/<path> to read host files, e.g. /host/home/ubuntu/some/file.txt' : ''}` },
            offset: { type: 'number', description: 'Line number to start reading from (0-based)' },
            limit: { type: 'number', description: 'Max number of lines to read' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: `Write a NEW file or FULLY replace a small file. Creates parent directories if needed. WARNING: For modifying existing files, use edit_file instead — it is faster, safer, and preserves unchanged code. Only use write_file when creating a file from scratch or the entire file content needs to change.${this.config.srcEditable ? ' Source editing is enabled: /app/ files are writable and changes persist to the host src/ directory across restarts.' : ' Cannot write to /app/ framework files.'}`,
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to write to' },
            content: { type: 'string', description: 'Content to write' },
            append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit_file',
        description: `Find and replace text in an existing file. This is the PREFERRED tool for modifying files — much faster and safer than write_file because it only changes what needs to change. Always use this instead of write_file when updating existing code. Provide enough surrounding context in old_text to uniquely match the target.${this.config.srcEditable ? ' Source editing is enabled: /app/ edits persist to the host.' : ' Cannot edit /app/ framework files.'}`,
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file' },
            old_text: { type: 'string', description: 'Exact text to find (must be unique in the file). Include surrounding lines for uniqueness.' },
            new_text: { type: 'string', description: 'Replacement text' },
            all: { type: 'boolean', description: 'Replace all occurrences (default false, replaces first only)' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
      {
        name: 'grep',
        description: `Recursively search files for lines matching a regex. Returns structured {file, line, text} hits — far cheaper and faster than chaining exec+grep/cat. Skips noise dirs (.git, node_modules, dist, build, .venv, target, .next, .cache, __pycache__) automatically. Capped at 200 hits, line text truncated to 200 chars. PREFERRED over exec for any code-search task.`,
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern (RE2 syntax — no lookahead/backrefs). Start broad ("late|delay(ed)?") and tighten if too noisy.' },
            path: { type: 'string', description: 'Directory to search (default: current workspace).' },
            glob: { type: 'string', description: 'Filename glob to limit which files are scanned, e.g. "*.go", "*.ts".' },
            '-i': { type: 'boolean', description: 'Case-insensitive match.' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'glob',
        description: `List files matching a filename glob under a directory. Returns up to 500 paths relative to the search root, skipping noise dirs (.git, node_modules, etc.). PREFERRED over exec+find/ls for file-name lookups.`,
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Filename glob (e.g. "*.md", "Test*.tsx"). Matches against the file basename.' },
            path: { type: 'string', description: 'Directory to search (default: current workspace).' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'session_status',
        description: 'Get current session information: message count, uptime, active sessions, learner stats, model info.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'sessions_list',
        description: 'List all active conversation sessions with their message counts and last activity.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'env_manage',
        description: 'Manage environment variables and the secure credential vault. Local env vars live in .env; shared API keys live in the manager vault (encrypted, never stored locally). Use action "vault_list" to see vault keys, "vault_get" to retrieve a vault key to a temp file. PREFERRED: use web_fetch with `credential` parameter for API calls — it routes through the vault proxy without exposing keys. For local env, use "list"/"get"/"set"/"delete" as before.',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'get_raw', 'set', 'delete', 'vault_list', 'vault_get'], description: 'list: show local env vars (masked). get: get a local key (masked). get_raw: get local key to temp file. set: set a local key. delete: remove a local key. vault_list: list keys in the secure manager vault. vault_get: fetch a vault key to a temp file (auto-deleted in 5 min).' },
            key: { type: 'string', description: 'Environment variable or vault key name (for get/set/delete/vault_get)' },
            value: { type: 'string', description: 'Value to set (for set action)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'web_serve',
        description: (() => {
          const d = this.config.ingressDomain;
          const p = (this.config.ingressPath || '').replace(/\/$/, '');
          const pr = this.config.ingressHttps ? 'https' : 'http';
          const pub = d ? `${pr}://${d}${p}` : null;
          return `Start, stop, or check your web server. ${pub ? `Public URL: ${pub}/` : `Internal port: ${this.config.webPort || '<SPORE_WEB_PORT>'}.`}

For apps with a backend API, use action:"backend" — it:
- Starts the web server for static files from the directory
- Launches your backend process with APP_PORT env var
- AUTO-INJECTS all vault keys as env vars (process.env.REPLICATE_API_TOKEN etc.) — no vault_get needed
- Proxies /api/* and any non-file routes to your backend automatically
- Manages process lifecycle (kills stale, restarts clean)
- PERSISTS across container restarts — backend auto-restores on boot with fresh vault keys

CRITICAL ROUTING: Traefik strips the path prefix (${p || '/spores/<name>'}) before requests reach your server. Your backend receives paths relative to root.
CRITICAL FRONTEND: Your frontend MUST use relative fetch paths — fetch('api/endpoint') or fetch('./api/endpoint') with credentials:'include'. NEVER use absolute paths like fetch('/api/endpoint') — they bypass the proxy entirely.`;
        })(),
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'stop', 'status', 'backend'], description: 'start = serve static files, stop = stop server, status = check, backend = start server + launch backend (managed, vault keys auto-injected)' },
            dir: { type: 'string', description: 'Directory to serve (default: /workspace/web). Created automatically if missing.' },
            command: { type: 'string', description: 'Backend command (e.g. "node server.js"). Only for action:"backend". Gets APP_PORT + all vault keys as env vars.' },
            command_dir: { type: 'string', description: 'Working directory for backend command (default: same as dir).' },
          },
          required: ['action'],
        },
      },
      {
        name: 'browser',
        description: `Control a persistent Chromium browser for web scraping, testing, form automation, or visual verification. Backends: zendriver (continuous frame preview via repeated screenshots) and playwright (live screencast preview). Default backend follows this instance's browser setting (${this.config.browserBackend || 'zendriver'}) unless another backend is already active. Actions: launch (opens browser, optionally with a URL), navigate (go to URL), click (CSS selector), type (fill input), screenshot (high-quality capture that also saves a JPG and returns filePath for message_send), scroll (up/down), evaluate (run JS), close (stop browser), status (inspect current backend/session). The browser persists across tool calls — launch once, then navigate/interact as needed.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['launch', 'navigate', 'click', 'type', 'screenshot', 'scroll', 'evaluate', 'close', 'status'], description: 'Browser action to perform' },
            backend: { type: 'string', enum: ['playwright', 'zendriver'], description: 'Browser backend to use. If omitted, the instance default is used unless another backend is already active.' },
            url: { type: 'string', description: 'URL to open (for launch/navigate)' },
            selector: { type: 'string', description: 'CSS selector (for click/type)' },
            text: { type: 'string', description: 'Text to type (for type action)' },
            direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down)' },
            amount: { type: 'number', description: 'Scroll pixels (default: 500)' },
            expression: { type: 'string', description: 'JavaScript expression to evaluate in page context' },
            width: { type: 'number', description: 'Viewport width (default: 1280, for launch only)' },
            height: { type: 'number', description: 'Viewport height (default: 720, for launch only)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'analyze_media',
        description: 'Generic media analysis tool. Prefer `analyze_media` for uploaded attachments because it auto-detects image/video/audio from the file path or latest upload, then uses the matching dedicated VLM tier internally. Use `kind` only to force a modality when the file extension is ambiguous (for example .webm). You still write the final answer yourself.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional absolute path or basename of an uploaded media file. If omitted, the latest uploaded attachment is used.' },
            prompt: { type: 'string', description: 'What to analyze. Defaults to a concise modality-specific analysis prompt.' },
            kind: { type: 'string', enum: ['auto', 'image', 'video', 'audio'], description: 'Optional media type override. Defaults to auto-detect.' },
            maxTokens: { type: 'number', description: 'Optional output cap for the VLM subcall (default 1200, max 4000).' },
          },
          required: [],
        },
      },
      {
        name: 'analyze_image',
        description: 'Use the dedicated IMAGE_VLM model to inspect an image file and return an internal analysis. Use this on uploaded images saved in /workspace/uploads when you want a specialized multimodal subcall. `path` may be omitted to use the latest uploaded image. You still write the final answer yourself.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional absolute path or basename of an image file (for example from /workspace/uploads/...). If omitted, the latest uploaded image is used.' },
            prompt: { type: 'string', description: 'What to look for in the image. Defaults to a general descriptive analysis.' },
            maxTokens: { type: 'number', description: 'Optional output cap for the VLM subcall (default 1200, max 4000).' },
          },
          required: [],
        },
      },
      {
        name: 'analyze_video',
        description: 'Use the dedicated VIDEO_VLM model to inspect a video file and return an internal analysis. Use this on uploaded videos saved in /workspace/uploads when you want a specialized multimodal subcall. `path` may be omitted to use the latest uploaded video. You still write the final answer yourself.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional absolute path or basename of a video file (for example from /workspace/uploads/...). If omitted, the latest uploaded video is used.' },
            prompt: { type: 'string', description: 'What to analyze in the video. Defaults to a general scene/event summary.' },
            maxTokens: { type: 'number', description: 'Optional output cap for the VLM subcall (default 1200, max 4000).' },
          },
          required: [],
        },
      },
      {
        name: 'analyze_audio',
        description: 'Use the dedicated AUDIO_VLM model to inspect an audio file and return an internal analysis. Use this on uploaded audio saved in /workspace/uploads when you want a specialized multimodal subcall. `path` may be omitted to use the latest uploaded audio file. You still write the final answer yourself.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional absolute path or basename of an audio file (for example from /workspace/uploads/...). If omitted, the latest uploaded audio file is used.' },
            prompt: { type: 'string', description: 'What to extract from the audio. Defaults to transcription plus salient analysis.' },
            maxTokens: { type: 'number', description: 'Optional output cap for the VLM subcall (default 1200, max 4000).' },
          },
          required: [],
        },
      },
      {
        name: 'save_tool',
        description: 'Create and register a new tool as a script. Saves to workspace/tools/, registers in TOOLS_REGISTRY.json, and creates a graph node (type: "tool") so tools are visible in the knowledge graph and discoverable by other agents.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name (lowercase-hyphenated, e.g. "weather-lookup")' },
            description: { type: 'string', description: 'What this tool does' },
            script: { type: 'string', description: 'The script content (Node.js or bash). Will be saved as a file.' },
            language: { type: 'string', description: 'Script language: "node", "python", or "bash" (default "node")' },
            usage: { type: 'string', description: 'Example invocation via exec' },
          },
          required: ['name', 'description', 'script'],
        },
      },
      {
        name: 'sleep',
        description: 'Pause execution for a specified duration. Use when waiting for a background process, after starting a long-running command, or to yield the current turn and show progress to the user before continuing. Returns after the delay.',
        input_schema: {
          type: 'object',
          properties: {
            seconds: { type: 'number', description: 'Duration to sleep in seconds (1-60, default 5)' },
            reason: { type: 'string', description: 'Why you are sleeping (shown to user as status)' },
          },
        },
      },
      {
        name: 'notify_user',
        description: 'Send a notification to YOUR user across all active channels (web panel, Discord, Telegram). Use this when another spore asks you to relay a message, when you have an important update to deliver proactively, or when a background process produces a result the user should see immediately. The message is delivered as-is — write it as you want the user to read it.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message to deliver to the user' },
            source: { type: 'string', description: 'Who/what originated this notification (e.g. "from Ada", "background task", "system alert")' },
            urgent: { type: 'boolean', description: 'If true, tries harder to reach the user (e.g. DM on Discord). Default false.' },
          },
          required: ['message'],
        },
      },
      ...this._getCustomToolDefinitions(),
      ...this._getWebappRequestDefinitions(),

      ...(this._pluginManager ? this._pluginManager.getToolDefinitions() : []),

      ...this._getCommunicationToolDefinitions(),
      ...(this.config.superAgent ? this._getSuperAgentToolDefinitions() : []),
      ...this._getRemoteToolDefinitions(),
      ...this._getSkillToolDefinitions(),
    ];
    const platform = opts.platform
      || _execContext.getStore()?.platform
      || this._currentPlatform;
    if (platform === 'cli') {
      return all.filter(t => !TOOLS_EXCLUDED_FROM_CLI.has(t.name));
    }
    return all;
  }

_getRemoteToolDefinitions() {
    const mgr = this._ensureSSHManager();
    if (!mgr || !mgr.hosts || mgr.hosts.length === 0) return [];
    const hostList = mgr.hosts.map(h => `${h.id} (${h.name || h.hostname})`).join(', ');
    return [
      {
        name: 'remote_exec',
        description: `Execute a command on a remote SSH host. Available hosts: ${hostList}. Returns stdout, stderr, and exit code.

For long-running jobs (SLURM submissions, training runs, anything over ~30s) pass a tmux_session name — the command runs inside a named tmux session on the remote host and survives SSH disconnects. Re-read output later with remote_tail; kill with remote_tmux_kill. Session names are auto-prefixed with "${this.config.clusterTmuxPrefix || 'spore'}-" so cleanup is safe.

Set wait:false when you've submitted a long background job and just want to return the session name immediately.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: `Host ID — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            command: { type: 'string', description: 'Shell command to execute' },
            workdir: { type: 'string', description: 'Remote working directory (optional)' },
            timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
            tmux_session: { type: 'string', description: 'Optional named tmux session on the remote host. Required for any command that may run longer than the timeout. The prefix is auto-applied.' },
            wait: { type: 'boolean', description: 'Only with tmux_session: wait for the command to finish (default true). false = return immediately with session name for later remote_tail.' },
          },
          required: ['host', 'command'],
        },
      },
      {
        name: 'remote_tail',
        description: `Read current output from a named tmux session on a remote host. Use this to check progress of long-running jobs started with remote_exec + tmux_session. Available hosts: ${hostList}.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: `Host ID — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            tmux_session: { type: 'string', description: 'Session name (prefix auto-applied if missing).' },
            lines: { type: 'number', description: 'Number of lines of scrollback to capture (default 200, max 2000).' },
          },
          required: ['host', 'tmux_session'],
        },
      },
      {
        name: 'remote_tmux_kill',
        description: `Kill a named tmux session on a remote host (and the process running inside). Available hosts: ${hostList}.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: `Host ID — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            tmux_session: { type: 'string', description: 'Session name (prefix auto-applied if missing).' },
          },
          required: ['host', 'tmux_session'],
        },
      },
      {
        name: 'remote_read_file',
        description: `Read a file from a remote SSH host via SFTP. Available hosts: ${hostList}. Supports offset/limit for partial reads.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: `Host ID — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            path: { type: 'string', description: 'Absolute path on the remote host' },
            offset: { type: 'number', description: 'Line offset (0-based, optional)' },
            limit: { type: 'number', description: 'Max lines to return (optional)' },
          },
          required: ['host', 'path'],
        },
      },
      {
        name: 'remote_write_file',
        description: `Write/create a file on a remote SSH host via SFTP. Available hosts: ${hostList}.`,
        input_schema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: `Host ID — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            path: { type: 'string', description: 'Absolute path on the remote host' },
            content: { type: 'string', description: 'File content to write' },
            append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
          },
          required: ['host', 'path', 'content'],
        },
      },
      {
        name: 'ssh_tunnel',
        description: `Create or manage SSH port tunnels. Forwards a remote port to localhost so you can access remote services (TensorBoard, Jupyter, inference servers) through the web proxy. Available hosts: ${hostList}.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'close', 'list'], description: 'create = new tunnel, close = tear down by localPort, list = show active tunnels' },
            host: { type: 'string', description: `Host ID for create — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            remoteHost: { type: 'string', description: 'Remote hostname to forward to (default: localhost)' },
            remotePort: { type: 'number', description: 'Remote port to forward (required for create)' },
            localPort: { type: 'number', description: 'Local port 19000-19999 (auto-assigned if omitted)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'startup_tasks',
        description: 'Manage persistent background tasks that automatically restart when the container reboots. Use this for long-running processes like collectors, watchers, servers, or any nohup/background job that should survive restarts. Tasks are stored in /data/.startup-tasks.json and executed after the app boots. For cron-based scheduling inside this container, use plain `cron` plus `crontab` — do not use `/etc/init.d/cron start`, `service cron start`, or `/usr/sbin/cron` directly.',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'list', 'run'], description: 'add = register a new startup task, remove = delete by name, list = show all tasks, run = manually execute a task now' },
            name: { type: 'string', description: 'Unique name for this task (for add/remove/run). Use descriptive kebab-case like "timelapse-collector" or "dashboard-server".' },
            command: { type: 'string', description: 'Shell command to run (for add). Runs in background with nohup-like behavior. Use full paths.' },
            working_directory: { type: 'string', description: 'Working directory for the command (default: /workspace)' },
            delay_seconds: { type: 'number', description: 'Seconds to wait after boot before starting this task (default: 15). Use higher values for tasks that depend on external services.' },
            env: { type: 'object', description: 'Extra environment variables for this task (key-value pairs). Note: system env vars are inherited.' },
          },
          required: ['action'],
        },
      },
      {
        name: 'data_poller',
        description: `Start/stop/list background data pollers. Pollers periodically run predefined read-only commands on SSH hosts and write JSON results for dashboards. Commands are from a fixed template registry (not user-composable). Available hosts: ${hostList}. Templates: ${(() => { try { return require('./data-poller').DataPoller.prototype ? Object.keys(require('./data-poller').TEMPLATES).join(', ') : 'none'; } catch { return 'none'; } })()}.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'stop', 'list', 'templates'], description: 'start = begin polling, stop = stop a poller, list = show active pollers, templates = show available templates' },
            host: { type: 'string', description: `Host ID (for start) — one of: ${mgr.hosts.map(h => h.id).join(', ')}` },
            template: { type: 'string', description: 'Predefined command template ID (for start)' },
            interval: { type: 'number', description: 'Poll interval in seconds (minimum 60, default 120)' },
            pollerId: { type: 'string', description: 'Poller ID (for stop)' },
          },
          required: ['action'],
        },
      },
    ];
  }

  _getSkillToolDefinitions() {
    if (!this.skills.available) return [];
    const catalog = this.skills.list();
    const skillList = catalog.skills?.length
      ? catalog.skills.map(s => `${s.slug} (${s.title})`).join(', ')
      : 'none yet';
    return [
      {
        name: 'skill_lookup',
        description: `Search or read from the shared Spore Core skills library. Skills are reusable knowledge contributed by any agent. Current skills: ${skillList}. Use action "list" to browse, "search" to filter, "read" to get full content.`,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'search', 'read'], description: 'list = browse all, search = filter by query/tags, read = get full skill content' },
            slug: { type: 'string', description: 'Skill slug to read (required for action "read")' },
            query: { type: 'string', description: 'Search query for title/summary/tags (for action "search")' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (for action "search")' },
          },
          required: ['action'],
        },
      },
      {
        name: 'skill_update',
        description: 'Create or update a skill in the shared Spore Core skills library. Use this to share knowledge you\'ve figured out (API patterns, workflows, solutions) so other agents don\'t have to rediscover it. Write clear, actionable content — include code examples, exact parameters, and gotchas.',
        input_schema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'URL-safe identifier (lowercase, hyphens). e.g. "replicate-image-gen"' },
            title: { type: 'string', description: 'Human-readable title' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Categorization tags e.g. ["api", "image-generation", "replicate"]' },
            summary: { type: 'string', description: 'One-line summary of what this skill covers' },
            content: { type: 'string', description: 'Full skill content in markdown. Include code examples, parameters, error handling, and tips.' },
            mode: { type: 'string', enum: ['replace', 'append'], description: 'replace = overwrite content (default), append = add to existing' },
          },
          required: ['slug', 'content'],
        },
      },
    ];
  }

  _getWebappRequestDefinitions() {
    if (!this.gateway?._server) return [];
    return [{
      name: 'webapp_request',
      description: 'Make an HTTP request to your own hosted webapp. Use this to test endpoints, fetch data, or interact with the backend you launched via web_serve. Requests are authenticated with the active user\'s session cookie so the backend sees the same auth context as if the user made the request in their browser.',
      input_schema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
          path: { type: 'string', description: 'Request path (e.g. "/api/portfolio", "/api/health"). Must start with /' },
          body: { type: 'object', description: 'JSON request body (for POST/PUT/PATCH)' },
          headers: { type: 'object', description: 'Additional request headers (optional)' },
          as_user: { type: 'string', description: 'Username to act as (defaults to the user you are talking to). Must be a currently logged-in user.' },
        },
        required: ['method', 'path'],
      },
    }];
  }

  getChatToolDefinitions() {
    const chatTools = ['message_send', 'message_read', 'graph_query', 'query_about', 'graph_update', 'graph_delete', 'task_status', 'web_search', 'web_fetch'];
    const all = this.getToolDefinitions();
    return all.filter(t => chatTools.includes(t.name));
  }

  _getCommunicationToolDefinitions() {
    if (!this.config.managerUrl) return [];
    return [
      {
        name: 'anima_list',
        description: 'List all spore instances on this server with their status and model. Use to discover who else is around before messaging.',
        input_schema: {
          type: 'object',
          properties: {
            includeHealth: { type: 'boolean', description: 'Fetch live health status for each spore (slightly slower). Default true.' },
          },
        },
      },
      {
        name: 'spore_message',
        description: 'Send a message to another spore and get its response. The target spore processes it through its full agent loop with its own personality, tools, and knowledge graph. Use for asking questions, collaborating on tasks, or just chatting with other animas. To relay a message to another spore\'s user, be explicit: "Please tell your user [message]" — the target spore will use notify_user to deliver it.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target spore ID (e.g. "ada", "bob-the-builder")' },
            message: { type: 'string', description: 'The message to send' },
            context: { type: 'string', description: 'Optional context to include' },
            timeout: { type: 'number', description: 'Timeout in seconds (default 120, max 300)' },
          },
          required: ['target', 'message'],
        },
      },
    ];
  }

  _getSuperAgentToolDefinitions() {
    return [
      {
        name: 'anima_graph',
        description: 'Read or write to another spore\'s knowledge graph. Requires super agent privileges. Use "read" to search/query nodes, or "write" to add/update nodes, aspects, attributes, and edges.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target spore ID' },
            mode: { type: 'string', description: '"read" or "write"', enum: ['read', 'write'] },
            query: { type: 'string', description: '(read) Search query for nodes' },
            nodeId: { type: 'string', description: '(read) Get specific node by ID, (write) Node ID to create/update' },
            type: { type: 'string', description: '(read) Filter by node type, (write) Node type for new node' },
            label: { type: 'string', description: '(write) Node label' },
            description: { type: 'string', description: '(write) Node description' },
            aspects: {
              type: 'array',
              description: '(write) Aspects with attributes to add',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  attributes: { type: 'array', items: { type: 'string' } },
                  importance: { type: 'number' },
                },
                required: ['name'],
              },
            },
            edges: {
              type: 'array',
              description: '(write) Edges to add',
              items: {
                type: 'object',
                properties: {
                  target: { type: 'string' },
                  type: { type: 'string' },
                },
                required: ['target', 'type'],
              },
            },
          },
          required: ['target', 'mode'],
        },
      },
      {
        name: 'anima_manage',
        description: 'Administrative control over another spore. Requires super agent privileges. Can restart, update environment variables, update config, or check token usage and logs.',
        input_schema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target spore ID' },
            action: { type: 'string', description: 'Action to perform', enum: ['restart', 'update_env', 'update_config', 'tokens', 'health', 'logs'] },
            env: { type: 'object', description: '(update_env) Key-value pairs to set' },
            config: { type: 'object', description: '(update_config) Config fields to set' },
            rebuild: { type: 'boolean', description: '(restart) Whether to rebuild the image. Default true.' },
          },
          required: ['target', 'action'],
        },
      },
    ];
  }

  /**
   * Execute a tool call
   * 
   * @param {string} name - Tool name
   * @param {Object} input - Tool input parameters
   * @returns {Promise<Object>} Tool result
   */
  async executeTool(name, input, ctx = null) {
    const normalizedName = name === 'graph'
      ? 'graph_update'
      : name === 'analyze'
        ? 'analyze_media'
        : name;
    // Run the handler inside an AsyncLocalStorage context. If the caller
    // didn't pass ctx (plugin path, legacy callers), fall back to the
    // `_sessionContexts` map + `_lastSessionKey` hint so tools still behave.
    const resolvedCtx = ctx || _execContext.getStore() || this._resolveFallbackCtx();
    return await _execContext.run(resolvedCtx || {}, async () => {
      const sessionKey = resolvedCtx?.sessionKey || null;
      const platform = resolvedCtx?.platform;
      // Plan-mode gate only applies to web sessions. Spore Code has its own
      // PLAN_READY/plan:decided prose-based plan-approval flow (see
      // spore-code internal plan handlers + plan_approval). Routing Spore Code's
      // tool calls through the queue would break that flow by swallowing the
      // tool calls the agent would otherwise execute under acorn's plan mode.
      if (sessionKey && MUTATING_TOOLS.has(normalizedName) && platform !== 'cli') {
        try {
          const row = this._sessions?.db?.prepare('SELECT plan_mode FROM sessions WHERE key=?').get(sessionKey);
          if (row?.plan_mode === 1) {
            return this._queuePlanProposal(sessionKey, normalizedName, input);
          }
        } catch (e) { this.log.warn('[tools] prepare failed: ' + e.message); }
      }
      return await this._executeToolDirect(normalizedName, input);
    });
  }

  _resolveFallbackCtx() {
    // Best-effort context when the caller didn't supply one. Prefers the
    // last session the loop touched; otherwise the most-recently-created
    // session_context. Returns null if neither exists — tools that need it
    // will then bail with 'No active session'.
    if (this._sessionContexts && this._sessionContexts.size === 1) {
      const [[key, ctx]] = this._sessionContexts;
      return { sessionKey: key, ...ctx };
    }
    return null;
  }

  // Tools that previously read `this._ctxSessionKey()` now go through this.
  _ctx() { return _execContext.getStore() || {}; }
  _ctxSessionKey() { return _execContext.getStore()?.sessionKey || null; }

  async _executeToolDirect(normalizedName, input) {
    this.log.debug(`Executing tool: ${normalizedName}`, JSON.stringify(input).substring(0, 200));
    // Abort guard: refuse destructive tools if the user already hit stop.
    const DESTRUCTIVE = new Set(['write_file', 'edit_file', 'exec', 'save_tool', 'web_serve']);
    if (DESTRUCTIVE.has(normalizedName) && this._abortSignal?.aborted) {
      return { error: 'Aborted by user — tool execution skipped.' };
    }
    try {
      switch (normalizedName) {
        case 'exec':
          return await this._execTool(input);
        case 'message_send':
          return await this._messageSendTool(input);
        case 'message_react':
          return await this._messageReactTool(input);
        case 'message_edit':
          return await this._messageEditTool(input);
        case 'message_read':
          return await this._messageReadTool(input);
        case 'graph_query':
          return await this._graphQueryTool(input);
        case 'query_about':
          return await this._queryAboutTool(input);
        case 'graph_update':
          return this._graphUpdateTool(input);
        // note_discovery → falls through to plugin dispatch (spore-code).
        case 'graph_delete':
          return this._graphDeleteTool(input);
        case 'delegate_task':
          return await this._delegateTask(input);
        case 'task_status':
          return await this._taskStatusTool(input);
        case 'task_cancel':
          return this._taskCancelTool(input);
        case 'task_update':
          return this._taskUpdateTool(input);
        case 'web_search':
          return await this._webSearchTool(input);
        case 'web_fetch':
          return await this._webFetchTool(input);
        case 'read_file':
          return this._readFileTool(input);
        case 'write_file':
          return this._writeFileTool(input);
        case 'edit_file':
          return this._editFileTool(input);
        case 'grep':
          return this._grepTool(input);
        case 'glob':
          return this._globTool(input);
        case 'session_status':
          return this._sessionStatusTool();
        case 'sessions_list':
          return this._sessionsListTool();
        case 'env_manage':
          return await this._envManageTool(input);
        case 'web_serve':
          return this._webServeTool(input);
        case 'browser':
          return await this._browserTool(input);
        case 'analyze_media':
          return await this._analyzeTool(input);
        case 'analyze_image':
          return await this._analyzeMediaTool('image', input);
        case 'analyze_video':
          return await this._analyzeMediaTool('video', input);
        case 'analyze_audio':
          return await this._analyzeMediaTool('audio', input);
        case 'save_tool':
          return this._saveToolTool(input);
        case 'list_custom_tools':
          return this._listCustomTools();
        case 'sleep': {
          const secs = Math.max(1, Math.min(input.seconds || 5, 60));
          const reason = input.reason || 'waiting';
          await new Promise(r => setTimeout(r, secs * 1000));
          return { slept: secs, reason };
        }
        case 'notify_user':
          return await this._notifyUserTool(input);

        // Self-scheduling
        case 'schedule_wakeup':
          return this._scheduleWakeupTool(input);
        case 'list_wakeups':
          return this._listWakeupsTool(input);
        case 'cancel_wakeup':
          return this._cancelWakeupTool(input);

        // Persistent task list
        case 'task_create':
          return this._tasklistCreateTool(input);
        case 'task_progress':
          return this._tasklistProgressTool(input);
        case 'task_list':
          return this._tasklistListTool(input);
        case 'task_get':
          return this._tasklistGetTool(input);

        // Log monitoring
        case 'log_watch':
          return await this._logWatchTool(input);
        case 'log_watch_list':
          return this._logWatchListTool();
        case 'log_watch_stop':
          return this._logWatchStopTool(input);

        // Structured question to the operator
        case 'ask_user':
          return await this._askUserTool(input);

        case 'anima_list':
          return await this._animaListTool(input);
        case 'spore_message':
          return await this._animaMessageTool(input);
        case 'anima_graph':
          return await this._animaGraphTool(input);
        case 'anima_manage':
          return await this._animaManageTool(input);

        case 'remote_exec':
          return await this._remoteExecTool(input);
        case 'remote_tail':
          return await this._remoteTailTool(input);
        case 'remote_tmux_kill':
          return await this._remoteTmuxKillTool(input);
        case 'remote_read_file':
          return await this._remoteReadFileTool(input);
        case 'remote_write_file':
          return await this._remoteWriteFileTool(input);
        case 'ssh_tunnel':
          return await this._sshTunnelTool(input);
        case 'startup_tasks':
          return this._startupTasksTool(input);
        case 'data_poller':
          return await this._dataPollerTool(input);
        case 'webapp_request':
          return await this._webappRequestTool(input);

        case 'skill_lookup':
          return this._skillLookupTool(input);
        case 'skill_update':
          return this._skillUpdateTool(input);

        default: {
          if (this._pluginManager) {
            // Plugin tools and middleware get the full per-session tool context
            // so they can read platform / sessionToken / projectContext / userId
            // without falling back to the host's _current* legacy fields.
            //
            // sessionKey lives in the AsyncLocalStorage set by the outer
            // executeTool() — the bare local variable is only in scope
            // there. Pull it via _ctx() so this fallback works regardless
            // of the call path.
            const ctx0 = this._ctx();
            const sessionKey = ctx0?.sessionKey || null;
            const sessionCtx = (sessionKey && this._sessionContexts?.get(sessionKey)) || {};
            const pluginResult = await this._pluginManager.executePluginTool(normalizedName, input, {
              sessionKey,
              trigger:        sessionCtx.trigger        ?? this._currentTrigger ?? null,
              channelId:      sessionCtx.channelId      ?? this._currentChannelId ?? null,
              platform:       sessionCtx.platform       ?? this._currentPlatform ?? null,
              userId:         sessionCtx.userId         ?? this._currentUserId ?? null,
              userName:       sessionCtx.userName       ?? this._currentUserName ?? null,
              userRole:       sessionCtx.userRole       ?? this._currentUserRole ?? null,
              userMessage:    sessionCtx.userMessage    ?? this._currentUserMessage ?? null,
              sessionToken:   sessionCtx.sessionToken   ?? this._currentSessionToken ?? null,
              projectContext: sessionCtx.projectContext ?? this._currentProjectContext ?? null,
              abortSignal:    sessionCtx.abortSignal    ?? this._abortSignal ?? null,
            });
            if (pluginResult !== null) return pluginResult;
          }
          return { error: `Unknown tool: ${normalizedName}` };
        }
      }
    } catch (e) {
      this.log.error(`Tool ${normalizedName} failed:`, e.message);
      return { error: e.message };
    }
  }

  /**
   * Execute a shell command
   */
  async _execTool(input) {
    const { command, workdir, timeout = 30000 } = input;
    const effectiveTimeout = Math.min(timeout, 600000);

    // Check for dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(command)) {
        return { error: `Blocked: command matches dangerous pattern (${pattern.source})` };
      }
    }

    // Package install vetting — check registries before allowing installs
    const parsedPkgs = parseInstallCommand(command);
    if (parsedPkgs && parsedPkgs.length > 0) {
      try {
        const vetResult = await vetPackages(parsedPkgs);
        if (!vetResult.allowed) {
          const blockedNames = vetResult.results.filter(r => r.risk === RISK_LEVEL.BLOCK).map(r => r.name);
          this.log.warn(`[package-vet] BLOCKED install: ${blockedNames.join(', ')}`);
          {
            const ctx = this._ctx?.() || {};
            const channelId = ctx.channelId ?? this._currentChannelId;
            const platform = ctx.platform ?? this._currentPlatform ?? 'discord';
            if (this._agent && channelId) {
              try {
                const gateway = this.platformManager?.getGateway(platform);
                if (gateway?.sendMessage) {
                  gateway.sendMessage(channelId,
                    `🛡️ **Package install blocked**\n${vetResult.summary}`);
                }
              } catch (e) { this.log.warn('[tools] getGateway failed: ' + e.message); }
            }
          }
          return {
            error: `Package install blocked by security vetting:\n${vetResult.summary}\nIf you believe this is safe, ask the user for approval.`,
            vetResults: vetResult.results,
          };
        }
        if (vetResult.warned > 0) {
          this.log.warn(`[package-vet] Install warnings: ${vetResult.summary}`);
          const ctx = this._ctx?.() || {};
          const channelId = ctx.channelId ?? this._currentChannelId;
          const platform = ctx.platform ?? this._currentPlatform ?? 'discord';
          if (this._agent && channelId) {
            try {
              const gateway = this.platformManager?.getGateway(platform);
              if (gateway?.sendMessage) {
                gateway.sendMessage(channelId,
                  `⚠️ **Package install warning**\n${vetResult.summary}\nProceeding anyway.`);
              }
            } catch (e) { this.log.warn('[tools] getGateway failed: ' + e.message); }
          }
        }
      } catch (vetErr) {
        this.log.warn(`[package-vet] Vetting failed, allowing install: ${vetErr.message}`);
      }
    }

    // Block exec from modifying framework files during lull/background triggers
    const frameworkWritePattern = /(?:sed\s+-i|tee|cp\s|mv\s|>\s*|>>|node\s+-e.*writeFile|echo\s.*>).*\/app\/(?:agent|discord|context|tools|config|sessions|learner|feed|gateway|maintainer|embedder|spore)\.(js|json)/;
    if (frameworkWritePattern.test(command)) {
      const trigger = this._ctx?.()?.trigger ?? this._currentTrigger;
      if (!trigger || trigger === 'lull') {
        return { error: `Blocked: cannot modify framework files via exec during a ${trigger || 'background'} trigger. Only allowed when a user directly asks. Prefer edit_file for framework changes.` };
      }
    }

    const defaultWorkdir = this.config.workspacePath || process.cwd();

    // Sanitized env: child processes get PATH, caches, and language dirs
    // but never API keys or tokens.
    const SENSITIVE_PATTERN = /KEY|TOKEN|SECRET|PASS|CREDENTIALS|AUTH/i;
    const SAFE_OVERRIDES = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'NODE_ENV', 'TMPDIR', 'WORKSPACE'];
    const safeEnv = {
      HOME: process.env.HOME || '/home/spore',
      PATH: process.env.PATH,
      TERM: 'xterm',
      LANG: process.env.LANG || 'en_US.UTF-8',
      NODE_ENV: process.env.NODE_ENV || 'production',
      WORKSPACE: this.config.workspacePath || process.cwd(),
      USER: process.env.USER || 'spore',
      TMPDIR: '/tmp',
    };
    for (const [k, v] of Object.entries(process.env)) {
      if (SAFE_OVERRIDES.includes(k) || safeEnv[k]) continue;
      if (SENSITIVE_PATTERN.test(k)) continue;
      safeEnv[k] = v;
    }

    const abortSignal = this._abortSignal;

    // Check process cap before spawning
    const alive = this._reapProcesses();
    if (alive >= this._maxChildProcesses) {
      return { error: `Process limit reached (${alive}/${this._maxChildProcesses} alive). Wait for running commands to finish or stop background processes before running more.` };
    }

    try {
      const result = await new Promise((resolve, reject) => {
        const child = execCb(command, {
          cwd: workdir || defaultWorkdir,
          timeout: effectiveTimeout,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          env: safeEnv,
        }, (err, stdout, stderr) => {
          this._trackedPids.delete(child.pid);
          if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
          else resolve({ stdout, stderr });
        });

        this._trackedPids.add(child.pid);

        if (abortSignal) {
          if (abortSignal.aborted) {
            try { child.kill('SIGTERM'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); }
            this._trackedPids.delete(child.pid);
            reject(new Error('Aborted by user.'));
            return;
          }
          const onAbort = () => {
            try { child.kill('SIGTERM'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); } }, 2000);
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });
          child.on('exit', () => abortSignal.removeEventListener('abort', onAbort));
        }
      });

      const output = (result.stdout || '') + (result.stderr ? '\n[stderr] ' + result.stderr : '');
      const truncated = output.length > 10000
        ? output.substring(0, 10000) + '\n... [truncated]'
        : output;

      const aptMatch = command.match(/(?:apt-get|apt)\s+install\s+(?:-[yq]+\s+)*(?:--no-install-recommends\s+)?(.+)/);
      if (aptMatch) {
        try {
          const pkgs = aptMatch[1].replace(/\s+/g, '\n').split('\n').filter(p => p && !p.startsWith('-'));
          const manifest = path.join(this.config.workspacePath || process.cwd(), '.apt-packages');
          const existing = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean) : [];
          const merged = [...new Set([...existing, ...pkgs])];
          fs.writeFileSync(manifest, merged.join('\n') + '\n');
        } catch (e) { this.log.warn('[tools] replace failed: ' + e.message); }
      }

      return { output: truncated };
    } catch (e) {
      if (abortSignal?.aborted) return { error: 'Aborted by user.' };
      if (e.killed) return { error: `Command timed out after ${timeout}ms` };

      const stderr = e.stderr?.toString() || '';
      const stdout = e.stdout?.toString() || '';
      return {
        error: `Exit code ${e.code || e.status || 1}`,
        stderr: stderr.substring(0, 2000),
        stdout: stdout.substring(0, 2000),
      };
    }
  }

  /**
   * Send a message to a Discord channel
   */
  async _messageSendTool(input) {
    const { content, filePath } = input;
    const targetMeta = this._resolveMessageTargetMeta(input);
    const resolvedTarget = targetMeta.target;
    const hasExplicitTarget = Boolean(input.target || input.channelId);

    if (targetMeta.platform === 'web' && !hasExplicitTarget) {
      const fileHint = filePath
        ? ` Reply in normal assistant text with this path so the web UI can render it inline: ${filePath}`
        : ' Reply in normal assistant text instead of using message_send.';
      return {
        error: `Web chat does not use message_send for the current conversation.${fileHint}`,
        filePath: filePath || null,
        suggested_reply: filePath || content || '',
      };
    }

    if (this.platformManager) {
      const result = await this.platformManager.sendMessage({ target: resolvedTarget, content, filePath, platform: targetMeta.platform });
      if (!result?.error) return result;
      if (targetMeta.platform !== 'discord') return result;
    }

    if (!this.discord) {
      return { error: 'No messaging gateway available' };
    }

    try {
      const legacyChannelId = targetMeta.id;
      if (!legacyChannelId) return { error: 'No target specified and no current conversation available' };
      const channel = await this.discord.channels.fetch(legacyChannelId);
      if (!channel) return { error: `Channel ${legacyChannelId} not found` };

      // If a file is attached, send it with the message
      if (filePath) {
        const path = require('path');
        if (!require('fs').existsSync(filePath)) {
          return { error: `File not found: ${filePath}` };
        }
        const sendOpts = { files: [{ attachment: filePath, name: path.basename(filePath) }] };
        if (content) sendOpts.content = content;
        const msg = await channel.send(sendOpts);
        return { sent: 1, messages: [{ messageId: msg.id, channelId: msg.channelId }] };
      }

      // Chunk long messages (text only)
      const chunks = this._chunkMessage(content || '');
      const results = [];

      for (const chunk of chunks) {
        const msg = await channel.send(chunk);
        results.push({ messageId: msg.id, channelId: msg.channelId });
      }

      return { sent: results.length, messages: results };
    } catch (e) {
      return { error: `Failed to send: ${e.message}` };
    }
  }

  _chunkMessage(text, maxLen = 2000) {
    if (!text || text.length <= maxLen) return [text || ''];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(' ', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).replace(/^\n/, '');
    }
    return chunks;
  }

  /**
   * Deliver a notification to the user across all active gateways.
   * Works from any context: invoke, proactive, DM, or channel.
   */
  async _notifyUserTool(input) {
    const { message, source, urgent } = input;
    if (!message) return { error: 'message is required' };

    const agentName = this.config.displayName || this.config.agentId || 'Spore Core';
    const prefix = source ? `[${source}] ` : '';
    const fullMessage = `${prefix}${message}`;
    const delivered = [];

    // 1. Web panel — broadcast a notification via WebSocket
    if (this.gateway?.broadcast) {
      try {
        this.gateway.broadcast({
          type: 'notification',
          from: agentName,
          source: source || null,
          message,
          urgent: !!urgent,
          timestamp: new Date().toISOString(),
        });
        delivered.push('web-panel');
      } catch (e) {
        this.log.warn(`[notify_user] Web broadcast failed: ${e.message}`);
      }
    }

    // 2. Discord — send to the most recently active DM channel, or first known channel
    if (this.platformManager) {
      const discord = this.platformManager.getGateway('discord');
      if (discord?.client) {
        try {
          const channels = discord.getActiveChannelIds();
          const dmChannel = channels.find(c => {
            const ch = discord.client.channels.cache.get(c.id);
            return ch?.isDMBased?.();
          });
          const target = dmChannel || channels[0];
          if (target) {
            await discord.sendMessage(target.id, fullMessage);
            delivered.push(`discord:${target.id}`);
          }
        } catch (e) {
          this.log.warn(`[notify_user] Discord delivery failed: ${e.message}`);
        }
      }

      // 3. Telegram — send to first approved chat
      const telegram = this.platformManager.getGateway('telegram');
      if (telegram) {
        try {
          const approved = this.platformManager.pairing?.listApproved?.('telegram') || [];
          if (approved.length > 0) {
            await telegram.sendMessage(approved[0], fullMessage);
            delivered.push(`telegram:${approved[0]}`);
          }
        } catch (e) {
          this.log.warn(`[notify_user] Telegram delivery failed: ${e.message}`);
        }
      }

      // 4. Slack — send to first known channel
      const slack = this.platformManager.getGateway('slack');
      if (slack?.getActiveChannelIds) {
        try {
          const channels = slack.getActiveChannelIds();
          if (channels.length > 0) {
            await slack.sendMessage(channels[0].id, fullMessage);
            delivered.push(`slack:${channels[0].id}`);
          }
        } catch (e) {
          this.log.warn(`[notify_user] Slack delivery failed: ${e.message}`);
        }
      }
    }

    if (delivered.length === 0) {
      return { error: 'No delivery channels available — no connected web panel, Discord, Telegram, or Slack channels found.' };
    }

    // Persist to web session history so notifications survive page refresh
    if (this._sessions) {
      try {
        const sessionKey = this._sessions.constructor.buildKey('web:control-panel', true, 'operator');
        const notifText = `[NOTIFICATION${source ? ` from ${source}` : ''}] ${message}`;
        this._sessions.addMessage(sessionKey, 'notification', notifText);
      } catch (e) {
        this.log.warn(`[notify_user] Failed to persist notification to session: ${e.message}`);
      }
    }

    this.log.info(`[notify_user] Delivered to ${delivered.length} channel(s): ${delivered.join(', ')}`);
    return { delivered, channels: delivered.length };
  }

  /**
   * React to a message with an emoji
   */
  async _messageReactTool(input) {
    const { messageId, emoji } = input;
    const targetMeta = this._resolveMessageTargetMeta(input);
    if (this.platformManager) {
      const result = await this.platformManager.reactToMessage({ target: targetMeta.target, messageId, emoji, platform: targetMeta.platform });
      if (!result?.error) return result;
      if (targetMeta.platform !== 'discord') return result;
    }
    if (!this.discordGateway) return { error: 'Discord gateway not available' };
    if (!targetMeta.id) return { error: 'No target specified and no current conversation available' };
    return await this.discordGateway.reactToMessage(targetMeta.id, messageId, emoji);
  }

  /**
   * Edit a previously sent message
   */
  async _messageEditTool(input) {
    const { messageId, content } = input;
    const targetMeta = this._resolveMessageTargetMeta(input);
    if (this.platformManager) {
      const result = await this.platformManager.editMessage({ target: targetMeta.target, messageId, content, platform: targetMeta.platform });
      if (!result?.error) return result;
      if (targetMeta.platform !== 'discord') return result;
    }
    if (!this.discordGateway) return { error: 'Discord gateway not available' };
    if (!targetMeta.id) return { error: 'No target specified and no current conversation available' };
    return await this.discordGateway.editMessage(targetMeta.id, messageId, content);
  }

  /**
   * Read messages from a Discord channel
   */
  async _messageReadTool(input) {
    const { limit = 10 } = input;
    const targetMeta = this._resolveMessageTargetMeta(input);

    if (this.platformManager) {
      const result = await this.platformManager.readMessages({ target: targetMeta.target, limit, platform: targetMeta.platform });
      if (!result?.error) return result;
      if (targetMeta.platform !== 'discord') return result;
    }

    if (!this.discord) {
      return { error: 'No messaging gateway available' };
    }

    try {
      const legacyChannelId = targetMeta.id;
      if (!legacyChannelId) return { error: 'No target specified and no current conversation available' };
      const channel = await this.discord.channels.fetch(legacyChannelId);
      if (!channel) return { error: `Channel ${legacyChannelId} not found` };

      const messages = await channel.messages.fetch({ limit: Math.min(limit, 50) });

      const result = [...messages.values()].reverse().map(msg => ({
        messageId: msg.id,
        author: msg.author.displayName || msg.author.username,
        authorId: msg.author.id,
        isBot: msg.author.bot,
        content: msg.content.substring(0, 500),
        timestamp: msg.createdAt.toISOString(),
        attachments: msg.attachments.size,
        reactions: [...msg.reactions.cache.values()].map(r => ({
          emoji: r.emoji.name,
          count: r.count,
        })),
      }));

      return { messages: result, count: result.length };
    } catch (e) {
      return { error: `Failed to read: ${e.message}` };
    }
  }

  /**
   * Query the knowledge graph
   */
  async _graphQueryTool(input) {
    const { query, nodeId, type, project } = input;

    if (!this.graph) {
      return { error: 'Graph context not available' };
    }

    // Query a shared project graph via ATTACH alias
    if (project && this.graph._sharedGraphs?.length > 0) {
      const sg = this.graph._sharedGraphs.find(s => s.slug === project);
      if (!sg) return { error: `Project "${project}" not found or not a member. Available: ${this.graph._sharedGraphs.map(s => s.slug).join(', ')}` };

      try {
        if (nodeId) {
          const row = this.graph.db.prepare(`SELECT * FROM ${sg.alias}.nodes WHERE id = ?`).get(nodeId);
          if (!row) return { error: `Node '${nodeId}' not found in project "${project}"` };
          const node = this.graph._hydrateSharedNode(row, sg);
          return { node: this._formatNodeForTool(node), project };
        }
        if (query) {
          const results = this.graph._searchSharedGraphs(query, 10);
          const projResults = results.filter(n => n._project === project);
          return {
            nodes: projResults.map(n => this._formatNodeForTool(n)),
            total: projResults.length,
            project,
          };
        }
        if (type) {
          const rows = this.graph.db.prepare(`SELECT * FROM ${sg.alias}.nodes WHERE type = ? ORDER BY importance DESC LIMIT 20`).all(type);
          const nodes = rows.map(r => this.graph._hydrateSharedNode(r, sg));
          return {
            nodes: nodes.map(n => this._formatNodeBrief(n)),
            total: nodes.length,
            project,
          };
        }
      } catch (e) {
        return { error: `Shared graph query failed: ${e.message}` };
      }
    }

    try {
      // Direct node lookup
      if (nodeId) {
        const node = this.graph.getNode(nodeId);
        if (!node) return { error: `Node '${nodeId}' not found` };
        node.edges = this.graph.getEdges(nodeId);
        graphEvents.emit('change', { op: 'node:accessed', nodeIds: [nodeId], source: 'graph_query' });
        return { node: this._formatNodeForTool(node) };
      }

      // Type filter
      if (type && !query) {
        const nodes = this.graph.getNodesByType(type);
        const shown = nodes.slice(0, 20);
        if (shown.length) graphEvents.emit('change', { op: 'node:accessed', nodeIds: shown.map(n => n.id), source: 'graph_query' });
        return {
          nodes: shown.map(n => this._formatNodeBrief(n)),
          total: nodes.length,
        };
      }

      // Hybrid search: vector similarity + keyword LIKE merged, across all nodes
      if (query) {
        const results = await this.graph.hybridSearch(query);
        const cap = 10;
        const shown = results.slice(0, cap);
        for (const node of shown) {
          node.edges = this.graph.getEdges(node.id);
        }
        if (shown.length) graphEvents.emit('change', { op: 'node:accessed', nodeIds: shown.map(n => n.id), source: 'graph_query' });
        return {
          nodes: shown.map(n => this._formatNodeForTool(n)),
          total: results.length,
          shown: shown.length,
          search: 'hybrid',
        };
      }

      return { error: 'Provide query, nodeId, or type' };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * Dialectic-style natural language entity query. Gathers all graph context
   * about an entity and uses LLM reasoning to synthesize an answer.
   */
  async _queryAboutTool(input) {
    const { entity, question } = input;
    if (!question) return { error: 'question is required' };
    if (!this.graph) return { error: 'Graph context not available' };

    const db = this.graph.db;
    if (!db) return { error: 'Graph database not available' };

    try {
      let targetNodes = [];

      if (entity) {
        const direct = db.prepare('SELECT id, label, type, description, importance FROM nodes WHERE id = ? OR LOWER(label) = ?').get(entity, entity.toLowerCase());
        if (direct) {
          targetNodes.push(direct);
        } else {
          const byAlias = db.prepare('SELECT n.id, n.label, n.type, n.description, n.importance FROM aliases a JOIN nodes n ON n.id = a.node_id WHERE LOWER(a.alias) = ? LIMIT 1').get(entity.toLowerCase());
          if (byAlias) targetNodes.push(byAlias);
        }

        if (targetNodes.length === 0) {
          const searchResults = await this.graph.hybridSearch(entity);
          targetNodes = searchResults.slice(0, 3);
        }
      } else {
        const searchResults = await this.graph.hybridSearch(question);
        targetNodes = searchResults.slice(0, 5);
      }

      if (targetNodes.length === 0) {
        return { answer: 'No relevant entities found in the knowledge graph for this query.', entities_searched: 0 };
      }

      const contextBlocks = [];

      for (const node of targetNodes.slice(0, 3)) {
        const nodeId = node.id;
        const aspects = db.prepare(`
          SELECT asp.name, asp.weight
          FROM aspects asp WHERE asp.node_id = ?
          ORDER BY asp.weight DESC LIMIT 15
        `).all(nodeId);

        const aspectDetails = [];
        for (const asp of aspects) {
          const attrs = db.prepare(`
            SELECT content, event_date, importance
            FROM attributes WHERE aspect_id = (SELECT id FROM aspects WHERE node_id = ? AND name = ?)
            ORDER BY importance DESC LIMIT 10
          `).all(nodeId, asp.name);
          if (attrs.length > 0) {
            aspectDetails.push(`  [${asp.name}]\n    ${attrs.map(a => {
              const dateSuffix = a.event_date ? ` (${a.event_date})` : '';
              return `${a.content}${dateSuffix}`;
            }).join('\n    ')}`);
          }
        }

        const edges = db.prepare(`
          SELECT e.type, n.label, n.type as node_type
          FROM edges e JOIN nodes n ON n.id = e.target
          WHERE e.source = ? LIMIT 15
        `).all(nodeId);
        const inEdges = db.prepare(`
          SELECT e.type, n.label, n.type as node_type
          FROM edges e JOIN nodes n ON n.id = e.source
          WHERE e.target = ? LIMIT 10
        `).all(nodeId);

        const reflections = db.prepare(
          'SELECT content FROM reflections WHERE node_id = ? ORDER BY updated DESC LIMIT 3'
        ).all(nodeId);

        let derivedFacts = [];
        try {
          derivedFacts = db.prepare(
            "SELECT content, reasoning_type, confidence, premises FROM derived_facts WHERE invalidated_at IS NULL AND source_node_ids LIKE ? ORDER BY created DESC LIMIT 8"
          ).all(`%${nodeId}%`);
        } catch (e) { this.log.warn('[tools] db.prepare failed: ' + e.message); }

        let gaps = [];
        try {
          gaps = db.prepare("SELECT content FROM gaps WHERE node_id = ? AND status = 'open' LIMIT 5").all(nodeId);
        } catch (e) { this.log.warn('[tools] db.prepare failed: ' + e.message); }

        let block = `## ${node.label} (${node.type})${node.description ? ': ' + node.description : ''}\n`;
        if (aspectDetails.length) block += `\nFacts:\n${aspectDetails.join('\n')}\n`;
        if (edges.length) block += `\nRelationships out:\n${edges.map(e => `  → ${e.label} (${e.node_type}) [${e.type}]`).join('\n')}\n`;
        if (inEdges.length) block += `\nRelationships in:\n${inEdges.map(e => `  ← ${e.label} (${e.node_type}) [${e.type}]`).join('\n')}\n`;
        if (reflections.length) block += `\nReflections:\n${reflections.map(r => `  ${r.content}`).join('\n')}\n`;
        if (derivedFacts.length) block += `\nDerived conclusions:\n${derivedFacts.map(d => `  [${d.reasoning_type || 'derived'}, ${d.confidence}] ${d.content}`).join('\n')}\n`;
        if (gaps.length) block += `\nOpen questions:\n${gaps.map(g => `  ? ${g.content}`).join('\n')}\n`;

        contextBlocks.push(block);
      }

      let episodeContext = '';
      try {
        const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'").get();
        if (hasFts) {
          const queryWords = question.split(/\s+/).filter(w => w.length > 3).slice(0, 6);
          if (queryWords.length > 0) {
            const ftsQuery = queryWords.join(' OR ');
            const episodes = db.prepare(`
              SELECT e.content, e.observed_at
              FROM episodes_fts
              JOIN episodes e ON episodes_fts.rowid = e.id
              WHERE episodes_fts MATCH ?
              ORDER BY rank
              LIMIT 5
            `).all(ftsQuery);
            if (episodes.length > 0) {
              episodeContext = `\nRelevant conversation excerpts:\n${episodes.map(ep => `  [${ep.observed_at?.substring(0, 10) || '?'}] ${ep.content.substring(0, 400)}`).join('\n')}\n`;
            }
          }
        }
      } catch (e) { this.log.warn('[tools] db.prepare failed: ' + e.message); }

      const fullContext = contextBlocks.join('\n---\n') + episodeContext;

      const { wrapSystemPromptForModel } = require('../providers');
      const _model = this.config.learnerModel || this.config.casualModel || this.config.model;
      const system = wrapSystemPromptForModel(
        [{ type: 'text', text: `You are reasoning about entities in a knowledge graph. Given comprehensive context about one or more entities (facts, relationships, derived conclusions, reflections, conversation history), synthesize a thorough answer to the question.

Be specific — cite facts, dates, and patterns. If the answer involves reasoning beyond what's explicitly stated, say so. If information is missing or uncertain, acknowledge it. Be direct and insightful, not generic.`, cache_control: { type: 'ephemeral' } }],
        _model,
        this.config,
      );

      const response = await this.llmClient.messages.create({
        model: this.config.learnerModel || this.config.casualModel || this.config.model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: `Question: ${question}\n\nEntity context:\n${fullContext}` }],
      });

      const answer = response.content.find(b => b.type === 'text')?.text || 'No answer generated.';
      graphEvents.emit('change', { op: 'node:accessed', nodeIds: targetNodes.map(n => n.id), source: 'query_about' });

      return {
        answer,
        entities_consulted: targetNodes.map(n => ({ id: n.id, label: n.label, type: n.type })),
        tokens_used: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 },
      };
    } catch (e) {
      return { error: `Query failed: ${e.message}` };
    }
  }

  _formatNodeForTool(node) {
    const out = {
      id: node.id,
      label: node.label,
      type: node.type,
      description: node.description?.substring(0, 300),
      importance: node.importance,
      mentions: node.mentions,
    };
    if (node.aspects && node.aspects.length > 0) {
      out.aspects = node.aspects.slice(0, 5).map(a => ({
        name: a.name,
        weight: a.weight,
        attributes: (a.attributes || []).slice(0, 3).map(attr => ({
          content: (typeof attr.content === 'string' ? attr.content : String(attr.content)).substring(0, 200),
          importance: attr.importance,
        })),
      }));
    }
    if (node.edges && node.edges.length > 0) {
      out.edges = node.edges.slice(0, 8).map(e => ({
        source: e.source, target: e.target, type: e.type, weight: e.weight,
      }));
    }
    return out;
  }

  _formatNodeBrief(node) {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      description: node.description?.substring(0, 200),
      importance: node.importance,
    };
  }

  _isPersonalityAspect(name) {
    const protected_ = ['identity', 'voice', 'personality', 'communication', 'hard_rules', 'startup_rules', 'rules', 'constraints'];
    return protected_.includes(name?.toLowerCase());
  }

  _normalizeNodeId(raw) {
    if (raw == null) return '';
    // Exact-match passthrough — Spore Code session nodes, discovery nodes,
    // and some event/service nodes legitimately use `:`, `@`, `_`, `.`
    // in their IDs (e.g. `session-cli:yam@spore-go-...`,
    // `qr_script_execution`, `expo.dev`). The legacy strict normalizer
    // stripped all of those away, making such IDs unreachable from
    // any tool that calls _normalizeNodeId. If the raw string already
    // corresponds to an existing node, use it verbatim.
    try {
      if (this.learner?.db) {
        const hit = this.learner.db.prepare('SELECT id FROM nodes WHERE id = ?').get(String(raw));
        if (hit) return hit.id;
      }
    } catch (e) { this.log.warn('[tools] learner.db.prepare failed: ' + e.message); }
    // Otherwise sanitize, but keep the broader set of characters that
    // real node IDs use. Whitespace → hyphen, strip disallowed chars,
    // collapse runs of hyphens, trim leading/trailing hyphens.
    return String(raw)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9:@._-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
  }

  _isProtectedNode(id) {
    if (!id) return false;
    // Reference + agent identity nodes are the backbone of the agent's own
    // capabilities and self-concept — refuse to delete them via tool calls.
    // Everything else (people, concepts, sessions, etc.) is fair game.
    return /^(ref-|agent-identity|agent-self|agent-core)/.test(String(id));
  }

  _modelMaxOutputTokens(model) {
    if (!model) return 16384;
    const m = model.toLowerCase();
    if (m.includes('opus')) return 64000;
    if (m.includes('sonnet')) return 32000;
    if (m.includes('haiku')) return 16000;
    return 16384;
  }

  // _noteDiscoveryTool moved to plugins/spore-code/index.js (phase 2.3c-2).

  _graphUpdateTool(input) {
    const { nodeId, label, type, description, aspects, edges, project, temp } = input;
    if (!this.learner?.db) return { error: 'Graph writer not available' };

    try {
      const db = (project && this.learner._sharedDbs?.[project]) || this.learner.db;
      if (project && !this.learner._sharedDbs?.[project]) {
        return { error: `Project "${project}" not found or not a member` };
      }
      let id = this._normalizeNodeId(nodeId);
      if (!id) return { error: 'Invalid nodeId — must contain at least one alphanumeric character' };

      let existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(id);
      if (!existing) {
        const fuzzy = db.prepare('SELECT id, label FROM nodes WHERE id LIKE ? OR label LIKE ? LIMIT 5')
          .all(`%${id.replace(/-/g, '%')}%`, `%${(label || nodeId).replace(/[^a-zA-Z0-9 ]/g, '%')}%`);
        if (fuzzy.length === 1) {
          id = fuzzy[0].id;
          existing = fuzzy[0];
        } else if (fuzzy.length > 1) {
          return { error: `Ambiguous nodeId "${nodeId}". Did you mean one of: ${fuzzy.map(f => `"${f.id}" (${f.label})`).join(', ')}? Use graph_query to find the correct node first.` };
        }
      }

      const isOwnNode = id === this.config.agentId;
      const personalityLocked = isOwnNode && !this.config.personalityEditable;

      if (personalityLocked && (label || description)) {
        return { error: 'Personality editing is disabled. Cannot modify the agent identity node label or description. Knowledge can be stored on other nodes.' };
      }

      // Build the `extra` JSON payload for new nodes, or merge into existing.
      const setTemp = (temp === true);
      const clearTemp = (temp === false);
      if (existing) {
        if (description) {
          db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
            .run(description, id);
        }
        if (setTemp || clearTemp) {
          const row = db.prepare('SELECT extra FROM nodes WHERE id = ?').get(id);
          let extraObj = {};
          try { extraObj = row?.extra ? JSON.parse(row.extra) : {}; } catch (e) { this.log.warn('[tools] JSON.parse failed: ' + e.message); }
          // Plugin lifecycle hook `isNodeManaged` lets a plugin claim
          // ownership of a node so core skips manual ttl mutations on
          // it. Plugins return true when the node is part of their
          // own lifecycle (e.g. spore-code's session-anchor nodes,
          // where session-end distillation owns ttl). Description
          // updates above still go through; only the ttl/temp flag
          // is gated.
          let isManaged = false;
          const mgr = this._pluginManager;
          if (mgr) {
            const hooks = mgr.getLifecycleHooks?.('isNodeManaged') || [];
            for (const h of hooks) {
              try { if (h({ nodeId: id, extra: extraObj })) { isManaged = true; break; } }
              catch (e) { this.log.warn('[tools] isNodeManaged hook failed: ' + e.message); }
            }
          }
          if (!isManaged) {
            if (setTemp) {
              if (extraObj.ttl !== 'temp') {
                extraObj.ttl = 'temp';
                extraObj.tempCreated = new Date().toISOString();
              }
            } else {
              delete extraObj.ttl;
              delete extraObj.tempCreated;
            }
            db.prepare('UPDATE nodes SET extra = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
              .run(JSON.stringify(extraObj), id);
          }
        }
      } else {
        // New node — set temp flag if the agent asked for it explicitly.
        // Acorn-specific defaults (born temp + tied to sessionId for
        // distillation later) are applied by the spore-code plugin's
        // afterToolExec middleware, which sees `created: true` in the
        // result and updates the row's `extra` column post-insert. Core
        // is acorn-blind here.
        let extraObj = {};
        if (setTemp) {
          extraObj = { ttl: 'temp', tempCreated: new Date().toISOString() };
        }
        const extraJson = JSON.stringify(extraObj);
        db.prepare(
          'INSERT INTO nodes (id, label, type, description, importance, mentions, extracted_with, extracted_at, provenance, extra) VALUES (?, ?, ?, ?, 5, 1, ?, ?, ?, ?)'
        ).run(id, label, type, description || '', 'spore-tool', new Date().toISOString(), 'self', extraJson);
      }

      let aspCount = 0, edgeCount = 0;

      let personalitySkipped = 0;
      if (aspects) {
        for (const asp of aspects) {
          if (!asp.name) continue;
          if (personalityLocked && this._isPersonalityAspect(asp.name)) {
            personalitySkipped++;
            continue;
          }
          let aspRow = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(id, asp.name);
          if (!aspRow) {
            db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, ?, ?)')
              .run(id, asp.name, asp.importance || 5, 'spore-tool');
            aspRow = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
          }
          for (const attr of (asp.attributes || [])) {
            if (!attr) continue;
            const exists = db.prepare('SELECT id FROM attributes WHERE aspect_id = ? AND content = ?').get(aspRow.id, attr);
            if (!exists) {
              db.prepare('INSERT INTO attributes (aspect_id, content, importance) VALUES (?, ?, ?)')
                .run(aspRow.id, attr, asp.importance || 5);
              aspCount++;
            }
          }
        }
      }

      if (edges) {
        for (const edge of edges) {
          if (!edge.target || !edge.type) continue;
          const tgt = this._normalizeNodeId(edge.target);
          if (!tgt) continue;
          const tgtExists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(tgt);
          if (!tgtExists) continue;
          const exists = db.prepare('SELECT rowid FROM edges WHERE source = ? AND target = ? AND type = ?').get(id, tgt, edge.type);
          if (!exists) {
            db.prepare('INSERT INTO edges (source, target, type, weight) VALUES (?, ?, ?, 1)').run(id, tgt, edge.type);
            edgeCount++;
          }
        }
      }

      embedNodeAsync(id, db);

      graphEvents.emit('change', { op: existing ? 'node:update' : 'node:create', node: { id, label: label || id, type: type || 'concept', description: description || '' }, source: 'graph_update' });
      if (aspCount > 0) graphEvents.emit('change', { op: 'aspect:create', nodeId: id, source: 'graph_update' });
      if (edgeCount > 0) {
        for (const edge of (edges || [])) {
          if (edge.target && edge.type) {
            graphEvents.emit('change', { op: 'edge:create', edge: { source: id, target: this._normalizeNodeId(edge.target), type: edge.type }, source: 'graph_update' });
          }
        }
      }

      const result = { success: true, nodeId: id, created: !existing, aspectsAdded: aspCount, edgesAdded: edgeCount };
      if (personalitySkipped > 0) {
        result.warning = `${personalitySkipped} personality aspect(s) skipped — personality editing is disabled. Knowledge can be stored on separate nodes.`;
      }
      return result;
    } catch (e) {
      return { error: `Graph update failed: ${e.message}` };
    }
  }

  _graphDeleteTool(input) {
    const { nodeId, aspectId, attributeId, edge, project } = input;
    if (!this.learner?.db) return { error: 'Graph writer not available' };
    if (project && !this.learner._sharedDbs?.[project]) {
      return { error: `Project "${project}" not found or not a member` };
    }
    const db = (project && this.learner._sharedDbs?.[project]) || this.learner.db;

    try {
      if (nodeId) {
        const id = this._normalizeNodeId(nodeId);
        if (!id) return { error: 'Invalid nodeId' };
        if (this._isProtectedNode(id)) return { error: `Cannot delete protected node: ${id}` };
        const existing = db.prepare('SELECT id, label, type, extra FROM nodes WHERE id = ?').get(id);
        if (!existing) return { error: `Node not found: ${id}` };
        // Distilled-knowledge guard — nodes that survived session-end
        // distillation represent accumulated cross-session learnings.
        // Deleting them wipes carefully-earned gotchas ("ANSI escape
        // codes break QR terminal scans", "expo dev server defaults to
        // 8081"). User hit this: agent called graph_delete({nodeId:
        // "expo"}) during an unrelated cleanup and nuked all the expo
        // gotchas from prior sessions. Require `force: true` to
        // delete anything with extra.distilled_at set.
        try {
          const ext = existing.extra ? JSON.parse(existing.extra) : {};
          if (ext.distilled_at && input?.force !== true) {
            return { error: `Refusing to delete "${id}" — it carries distilled cross-session knowledge (distilled_at=${ext.distilled_at}). Pass force: true if you really want to delete it. Consider graph_update to remove specific stale attributes instead.` };
          }
        } catch (e) { this.log.warn('[tools] JSON.parse failed: ' + e.message); }
        const edges = db.prepare('SELECT source, target, type FROM edges WHERE source = ? OR target = ?').all(id, id);
        db.prepare('DELETE FROM attributes WHERE aspect_id IN (SELECT id FROM aspects WHERE node_id = ?)').run(id);
        db.prepare('DELETE FROM aspects WHERE node_id = ?').run(id);
        db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(id, id);
        db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        for (const e of edges) {
          graphEvents.emit('change', { op: 'edge:delete', edge: e, source: 'graph_delete' });
        }
        graphEvents.emit('change', { op: 'node:delete', nodeId: id, node: existing, source: 'graph_delete' });
        return { success: true, deleted: 'node', nodeId: id };
      }

      if (aspectId) {
        const asp = db.prepare('SELECT id, node_id, name FROM aspects WHERE id = ?').get(aspectId);
        if (!asp) return { error: `Aspect not found: ${aspectId}` };
        db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(aspectId);
        db.prepare('DELETE FROM aspects WHERE id = ?').run(aspectId);
        graphEvents.emit('change', { op: 'aspect:delete', aspectId, nodeId: asp.node_id, source: 'graph_delete' });
        return { success: true, deleted: 'aspect', aspectId, nodeId: asp.node_id };
      }

      if (attributeId) {
        const attr = db.prepare('SELECT a.id, a.aspect_id, asp.node_id FROM attributes a JOIN aspects asp ON a.aspect_id = asp.id WHERE a.id = ?').get(attributeId);
        if (!attr) return { error: `Attribute not found: ${attributeId}` };
        db.prepare('DELETE FROM attributes WHERE id = ?').run(attributeId);
        graphEvents.emit('change', { op: 'attribute:delete', attributeId, nodeId: attr.node_id, source: 'graph_delete' });
        return { success: true, deleted: 'attribute', attributeId };
      }

      if (edge) {
        const src = (edge.source || '').toLowerCase().replace(/\s+/g, '-');
        const tgt = (edge.target || '').toLowerCase().replace(/\s+/g, '-');
        const typ = edge.type || '';
        const existing = db.prepare('SELECT rowid FROM edges WHERE source = ? AND target = ? AND type = ?').get(src, tgt, typ);
        if (!existing) return { error: 'Edge not found' };
        db.prepare('DELETE FROM edges WHERE source = ? AND target = ? AND type = ?').run(src, tgt, typ);
        graphEvents.emit('change', { op: 'edge:delete', edge: { source: src, target: tgt, type: typ }, source: 'graph_delete' });
        return { success: true, deleted: 'edge', edge: { source: src, target: tgt, type: typ } };
      }

      return { error: 'Specify nodeId, aspectId, attributeId, or edge to delete' };
    } catch (e) {
      return { error: `Graph delete failed: ${e.message}` };
    }
  }

  async _taskStatusTool({ taskId }) {
    if (!this._delegatedTasks) return { error: 'No tasks have been delegated yet' };
    const task = this._delegatedTasks.get(taskId);
    if (!task) return { error: `Unknown taskId: ${taskId}` };

    // Prune old completed tasks (>1 hour)
    const now = Date.now();
    for (const [id, t] of this._delegatedTasks.entries()) {
      if (t.status !== 'running' && now - t.completedAt > 3600000) {
        this._delegatedTasks.delete(id);
      }
    }

    const elapsed = Math.round((now - task.startedAt) / 1000);

    // Polling-detection. The agent frequently falls into a
    // task_status → sleep → task_status loop instead of ending the
    // turn and waiting for the push (task_complete trigger). Count
    // consecutive calls per session and escalate the hint into a
    // prominent warning from the 2nd call onward. Counter resets if
    // >60s elapses between polls (fresh conversation).
    if (!this._taskStatusPollState) this._taskStatusPollState = new Map();
    const sessionKey = this._ctxSessionKey() || '_global';
    const prev = this._taskStatusPollState.get(sessionKey);
    let pollCount = 1;
    if (prev && (now - prev.lastAt) < 60000) pollCount = prev.count + 1;
    this._taskStatusPollState.set(sessionKey, { count: pollCount, lastAt: now });

    if (task.status !== 'running') {
      // Clear the poll counter on any terminal status — agent got its
      // answer, polling has ended.
      this._taskStatusPollState.delete(sessionKey);
      return { status: task.status, taskId, result: task.result, elapsed_seconds: Math.round((task.completedAt - task.startedAt) / 1000) };
    }

    const response = { status: 'running', taskId, elapsed_seconds: elapsed };
    if (pollCount >= 2) {
      // Escalated: the agent is polling. Put the warning at the TOP
      // of the response as an unambiguous, forceful string.
      response._warning = `STOP POLLING. You have called task_status ${pollCount} times in a row for this session. The task_complete event will re-enter this loop AUTOMATICALLY when the task finishes. END YOUR TURN now. task_status+sleep loops are not how the harness works — they just burn tokens.`;
      response.hint = 'END YOUR TURN — the result will be pushed.';
    } else {
      response.hint = 'Task is still running. Results will be delivered automatically when complete — you do NOT need to poll. END your turn and the harness will wake you when the result arrives.';
    }
    return response;
  }

  _taskCancelTool({ taskId }) {
    if (!this._delegatedTasks) return { error: 'No tasks have been delegated yet' };
    const task = this._delegatedTasks.get(taskId);
    if (!task) return { error: `Unknown taskId: ${taskId}` };

    if (task.status !== 'running') {
      return { status: task.status, taskId, message: 'Task already finished.' };
    }

    if (task.abortCtrl) {
      task.abortCtrl.abort();
    }
    task.status = 'cancelled';
    task.result = { error: 'Cancelled by user' };
    task.completedAt = Date.now();
    this._activeSubagents = Math.max(0, this._activeSubagents - 1);

    this.log.info(`[subagent:${taskId}] Cancelled by user after ${Math.round((task.completedAt - task.startedAt) / 1000)}s`);
    return { status: 'cancelled', taskId, message: 'Task has been cancelled.' };
  }

  _taskUpdateTool({ taskId, message }) {
    if (!this._delegatedTasks) return { error: 'No tasks have been delegated yet' };
    const task = this._delegatedTasks.get(taskId);
    if (!task) return { error: `Unknown taskId: ${taskId}` };

    if (task.status !== 'running') {
      return { status: task.status, taskId, message: 'Task already finished — update not delivered.' };
    }

    if (!task.pendingInstructions) task.pendingInstructions = [];
    task.pendingInstructions.push(message);

    this.log.info(`[subagent:${taskId}] Queued user update: ${message.substring(0, 100)}`);
    return { status: 'update_queued', taskId, message: 'Instructions queued — the sub-agent will see them on its next step.' };
  }

  /**
   * Build a compact context block from the parent's knowledge graph
   * so subagents inherit identity, user info, and workspace awareness.
   */
  _buildSubagentGraphContext(taskEntry) {
    const parts = [];

    try {
      if (!this.graph) return '';

      const agentId = this.config.agentId || 'spore';
      const agentNode = this.graph.getNode(agentId);
      if (agentNode) {
        parts.push(`## Agent: ${agentNode.label || agentId}`);
        if (agentNode.description) parts.push(agentNode.description);

        const identity = agentNode.aspects?.find(a => a.name === 'identity');
        if (identity?.attributes?.length) {
          const top = identity.attributes
            .sort((a, b) => (b.importance || 5) - (a.importance || 5))
            .slice(0, 5)
            .map(a => `- ${a.content}`);
          parts.push(top.join('\n'));
        }
      }

      // User info — grab the most relevant user node
      const userName = taskEntry?.originalUserName;
      if (userName) {
        const userNodes = this.graph.searchNodes?.(userName) || [];
        const userNode = userNodes.find(n => n.type === 'person') || userNodes[0];
        if (userNode) {
          const prefs = [];
          for (const asp of (userNode.aspects || [])) {
            for (const attr of (asp.attributes || []).slice(0, 3)) {
              prefs.push(`- ${attr.content}`);
            }
          }
          if (prefs.length) {
            parts.push(`## User: ${userNode.label || userName}\n${prefs.slice(0, 8).join('\n')}`);
          }
        }
      }

      // Workspace overview — look for project/workspace nodes
      const edges = this.graph.getEdges?.(agentId) || [];
      const projectEdges = edges.filter(e =>
        e.type === 'works_on' || e.type === 'manages' || e.type === 'created'
      ).slice(0, 3);

      if (projectEdges.length) {
        const projectLines = [];
        for (const edge of projectEdges) {
          const target = this.graph.getNode(edge.target || edge.to);
          if (target) {
            projectLines.push(`- **${target.label}**: ${(target.description || '').substring(0, 120)}`);
          }
        }
        if (projectLines.length) {
          parts.push(`## Active projects\n${projectLines.join('\n')}`);
        }
      }

      // Key capabilities and tools (compact)
      const capabilities = agentNode?.aspects?.find(a => a.name === 'capabilities');
      if (capabilities?.attributes?.length) {
        const caps = capabilities.attributes
          .slice(0, 5)
          .map(a => `- ${a.content}`);
        parts.push(`## Capabilities\n${caps.join('\n')}`);
      }

    } catch (e) {
      this.log.warn(`[subagent] Graph context extraction failed: ${e.message}`);
    }

    return parts.length ? parts.join('\n\n') : '';
  }

  async _delegateTask(input) {
    const { task, context, model, timeoutSeconds, tools: enableTools = true, persona } = input;
    if (!this.llmClient) return { error: 'LLM client not available' };

    // Persona registry. Each persona overrides the sub-agent's system
    // prompt + tool subset to keep the sub-agent focused. The default
    // (no persona) keeps full tool access and the generic prompt
    // assembled below — backward compatible.
    //
    // researcher: web research only. Used by plan-mode planners to
    // delegate parallel investigations into libraries / frameworks /
    // best practices without burning the planner's own turn budget.
    // No file system access at all — sub-agents run server-side and
    // don't have the WebSocket bridge back to the user's CLI anyway,
    // so any read_file would just hit /workspace, not the user's repo.
    const PERSONAS = {
      researcher: {
        toolNames: ['web_search', 'web_fetch'],
        prompt: [
          'You are a RESEARCH sub-agent. Your job is to investigate a question by searching the web and return a structured findings summary.',
          '',
          'PROCESS:',
          '1. Use web_search broadly first ("how does Library X handle Y", "Y best practices 2026"). Look at the result snippets.',
          '2. Use web_fetch for the 1-3 most promising URLs to read the actual content.',
          '3. If a search returns nothing useful, retry with rephrased queries — do NOT give up after one search.',
          '4. Stop researching when you have enough to answer the question concretely. Do NOT exhaust the iteration budget chasing tangentially related material.',
          '',
          'OUTPUT FORMAT — return your final answer in exactly this shape (markdown):',
          '## Findings',
          '- <key finding 1, concise>  (source: <url>)',
          '- <key finding 2>  (source: <url>)',
          '- ...',
          '## Caveats',
          '- <unknown / contradiction / version-dependency>',
          '## Recommendation',
          '<2-3 sentences summarizing what the parent agent should take from this>',
          '',
          'RULES:',
          '- Cite a source URL for every factual claim. If you cannot cite, label it "(inference)".',
          '- Prefer official docs / primary sources over blog posts.',
          '- Do NOT call any tool other than web_search and web_fetch — your toolset is intentionally narrow.',
          '- Do NOT modify state. You have no read_file / write_file / exec / graph_update access.',
          '- 5-7 findings is a good target. More than 12 means you should narrow the question.',
        ].join('\n'),
      },
    };
    const personaSpec = persona ? PERSONAS[persona] : null;
    if (persona && !personaSpec) {
      return { error: `Unknown persona "${persona}". Valid: ${Object.keys(PERSONAS).join(', ')}` };
    }

    // Concurrency: limit active subagents
    // Resolution: pinned config field → effort preset → static fallback (8 = config.js default).
    const _eff = effortDefaults(this.config);
    const maxChildren = this.config.maxSubagentChildren || _eff.maxSubagentChildren || 8;
    if (!this._activeSubagents) this._activeSubagents = 0;
    if (this._activeSubagents >= maxChildren) {
      return { error: `Max concurrent subagents reached (${maxChildren}). Wait for existing ones to finish.` };
    }
    this._activeSubagents++;

    // Task registry for async status tracking
    if (!this._delegatedTasks) this._delegatedTasks = new Map();
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const abortCtrl = new AbortController();
    // Snapshot the originating session's context. AsyncLocalStorage
    // (this._ctx()) is the per-session-call source of truth — without
    // this the legacy _currentXxx singletons would leak whichever
    // session most-recently set them into a parallel session's
    // delegate_task. Critical for concurrent users: imagine user A
    // delegates research while user B's loop just wrote
    // _currentUserId='B' — without _ctx() priority, A's subagent would
    // come back as if B asked, and the wake-up turn would target B's
    // channel + B's projectContext.
    const _dctx = this._ctx?.() || {};
    this._delegatedTasks.set(taskId, {
      status: 'running',
      startedAt: Date.now(),
      channelId:           _dctx.channelId           ?? this._currentChannelId       ?? null,
      platform:            _dctx.platform            ?? this._currentPlatform        ?? 'discord',
      userId:              _dctx.userId              ?? this._currentUserId          ?? 'operator',
      originalUserMessage: _dctx.userMessage         ?? this._currentUserMessage     ?? task,
      originalUserName:    _dctx.userName            ?? this._currentUserName        ?? null,
      // Snapshot so the completion-delivery turn (see
      // _deliverTaskResult) can re-feed the same acorn project
      // context to processMessage. Without this the wake-up turn
      // wouldn't know the cwd/tools/tree the user was working in.
      projectContext:      _dctx.projectContext      ?? this._currentProjectContext  ?? null,
      abortCtrl,
    });

    const subModel = model || this.config.subagentModel || this.config.normalModel || this.config.model;
    const maxTimeoutSec = Math.min(timeoutSeconds || this.config.subagentTimeoutSeconds || _eff.subagentTimeoutSeconds || 900, 1800);
    const abortTimer = setTimeout(() => abortCtrl.abort(), maxTimeoutSec * 1000);
    abortTimer.unref?.();

    const taskEntry = this._delegatedTasks.get(taskId);
    this.broadcast({ type: 'subagent:start', taskId, model: subModel, task: task.substring(0, 300), timeout: maxTimeoutSec });

    (async () => {
      try {
        const nowISO = new Date().toISOString();
        const currentYear = new Date().getFullYear();

        // Extract compact context from parent's knowledge graph
        const graphContext = this._buildSubagentGraphContext(taskEntry);

        let basePrompt = personaSpec ? [
          personaSpec.prompt,
          `Current date: ${nowISO.slice(0, 10)} (year ${currentYear}). For time-sensitive topics include "${currentYear}" in your queries.`,
          context ? `Context from parent agent:\n${context}` : '',
        ].filter(Boolean).join('\n\n') : [
          'You are a sub-agent performing a delegated task for an AI agent system.',
          `Current date: ${nowISO.slice(0, 10)} (year ${currentYear}). When searching the web, include "${currentYear}" in queries about recent topics. Do NOT rely on pre-trained knowledge for current facts — always use web_search.`,
          graphContext,
          '%%TOOLS%%',
          '',
          'TOOL EFFICIENCY (critical):',
          '- **Plan first, execute minimally.** Think through the steps before calling tools. Prefer one correct approach over trying many in parallel.',
          '- **Sequential by default.** Only parallelize tool calls when the results are truly independent AND you are confident all branches are needed. Do NOT shotgun multiple approaches hoping one works — pick the best one, try it, and only fall back if it fails.',
          '- **Read output carefully.** If a tool call already gave you the information (e.g., file size in download output), do NOT call another tool to verify the same thing.',
          '- **Check before installing.** Run `which <cmd>` or `pip list | grep <pkg>` BEFORE installing. Never install the same thing multiple ways in parallel.',
          '- **Each tool call has cost.** Aim for the fewest calls that accomplish the task. Redundant calls waste tokens and time.',
          '- **API keys:** If you need an API key, ask the parent agent to provide it in the task context. Do NOT try to access keys via exec/printenv/echo/$VAR — they are filtered from subprocesses for security.',
          '',
          'RULES:',
          '- Use read_file/write_file/edit_file for file operations — not exec with cat/sed/grep.',
          '- For cron inside this container, use plain `cron` to ensure the daemon is running and `crontab` to manage jobs. Do NOT use `/etc/init.d/cron start`, `service cron start`, or `/usr/sbin/cron` directly — those bypass the wrapper and can fail with pidfile permission errors.',
          '- Use graph_update to persist knowledge and graph_delete to remove nodes/aspects/attributes/edges. Do NOT write SQL directly against graph.db.',
          '- For code/content: write to files using write_file, not inline text.',
          '- For reusable scripts: use save_tool instead of write_file.',
          '- Python: a persistent venv exists at /workspace/.venv. Use /workspace/.venv/bin/pip install <pkg> and /workspace/.venv/bin/python3 to run. System packages (numpy, PIL, opencv, moderngl, av) are pre-installed.',
          '- All installs persist: pip, npm global, Go, Cargo, gems, apt packages, and browser binaries (Playwright/Puppeteer) all survive restarts.',
          '- When you finish a meaningful step, write a one-sentence summary of what you accomplished (not what you\'re about to do).',
          '- After calling web_serve to start the server, your task is DONE. Immediately produce your final summary — do not run verification commands.',
          '- Return a brief final summary of what you did and where files were written. Keep it concise (2-4 sentences).',
          context ? `Context:\n${context}` : '',
        ].filter(Boolean).join('\n\n');

        const allTools = this.getToolDefinitions();
        const findTool = (name) => allTools.find(t => t.name === name);
        const subTools = personaSpec
          ? personaSpec.toolNames.map(findTool).filter(Boolean)
          : enableTools ? [
              findTool('exec'),
              findTool('read_file'),
              findTool('write_file'),
              findTool('edit_file'),
              findTool('graph_query'),
              findTool('graph_update'),
              findTool('graph_delete'),
              findTool('web_search'),
              findTool('web_fetch'),
              findTool('web_serve'),
              findTool('browser'),
              findTool('message_send'),
              findTool('save_tool'),
              findTool('skill_lookup'),
              findTool('skill_update'),
            ].filter(Boolean) : [];

        const toolNames = subTools.map(t => t.name).join(', ');
        basePrompt = basePrompt.replace('%%TOOLS%%', `Your tools: ${toolNames}.`);

        const { wrapSystemPromptForModel } = require('../providers');
        const systemPrompt = wrapSystemPromptForModel(
          [{ type: 'text', text: basePrompt, cache_control: { type: 'ephemeral' } }],
          subModel,
          this.config,
        );

        // Tag last tool with cache_control so the full tool array is cached across iterations
        if (subTools.length > 0) {
          const last = subTools[subTools.length - 1];
          if (!last.cache_control) {
            subTools[subTools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
          }
        }

        const originalMsg = taskEntry.originalUserMessage;
        const taskContent = (originalMsg && originalMsg !== task && originalMsg.length < 2000)
          ? `${task}\n\n---\nOriginal user request for reference:\n"${originalMsg}"`
          : task;
        let messages = [{ role: 'user', content: taskContent }];
        let totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        let finalText = '';
        const maxIter = Math.min(input.maxIterations || this.config.subagentMaxIter || effortDefaults(this.config).subagentMaxIter || 60, 200);
        const budgetPressureAt = Math.floor(maxIter * 0.8);

        // Progress reporting: send the subagent's natural summary to the channel periodically
        const progressIntervalMs = (this.config.intermediateTextThrottleSeconds || 30) * 1000;
        let lastProgressAt = Date.now();
        let latestSummary = '';

        const isInternalThinking = (text) => {
          if (!text || text.length < 10) return true;
          const t = text.trim();
          const thinkingPatterns = [
            /^(let me |now i need |i need to |i should |i'll |let's |i want to |first,? i)/i,
            /^(checking |looking |searching |finding |reading |opening |examining )/i,
            /^(ok |okay |alright |hmm |right )/i,
            /^(the tool |the function |the file |the graph |the api |the code )/i,
          ];
          return thinkingPatterns.some(p => p.test(t));
        };

        const sendProgress = (extraLine) => {
          try {
            if (!taskEntry.channelId || !this.platformManager) return;
            const gateway = this.platformManager.getGateway(taskEntry.platform || 'discord');
            if (!gateway?.sendProgressUpdate) return;
            const line = extraLine || (latestSummary.trim() ? latestSummary.trim().substring(0, 200) : null);
            if (!line) return;
            gateway.sendProgressUpdate(taskEntry.channelId, line);
            latestSummary = '';
          } catch (e) { this.log.warn('[tools] platformManager.getGateway failed: ' + e.message); }
        };
        const sendProgressDone = (error) => {
          try {
            if (!taskEntry.channelId || !this.platformManager) return;
            const gateway = this.platformManager.getGateway(taskEntry.platform || 'discord');
            if (gateway?.sendProgressUpdate) gateway.sendProgressUpdate(taskEntry.channelId, null, error ? { error: true } : { done: true });
          } catch (e) { this.log.warn('[tools] platformManager.getGateway failed: ' + e.message); }
        };
        sendProgress(`📋 **Task started**: ${task.substring(0, 120)}${task.length > 120 ? '…' : ''}`);

        const loopTracker = { history: [], sequence: [], maxHistory: 20 };
        const warnThreshold = this.config.loopDetection?.warn || 5;
        const criticalThreshold = this.config.loopDetection?.critical || 10;
        const pingPongThreshold = this.config.loopDetection?.pingPong || 8;
        const iterStats = { totalToolCalls: 0, writeFileCalls: 0, iterCount: 0, textChars: 0 };

        for (let i = 0; i < maxIter; i++) {
          if (abortCtrl.signal.aborted) break;
          const iterStart = Date.now();

          // Check for mid-task instructions from the user
          if (taskEntry.pendingInstructions?.length > 0) {
            const updates = taskEntry.pendingInstructions.splice(0);
            const updateText = updates.join('\n\n');
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
              // Append to existing tool results as a text block
              lastMsg.content.push({ type: 'text', text: `[UPDATE FROM USER — adjust your approach accordingly]:\n${updateText}` });
            } else if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
              lastMsg.content += `\n\n[UPDATE FROM USER — adjust your approach accordingly]:\n${updateText}`;
            } else {
              // Last message is assistant — add a new user message
              messages.push({ role: 'user', content: `[UPDATE FROM USER — adjust your approach accordingly]:\n${updateText}` });
            }
            this.log.info(`[subagent:${taskId}] Injected user update (${updates.length} message(s))`);
          }

          const systemWithBudget = i >= budgetPressureAt
            ? (Array.isArray(systemPrompt)
              ? [...systemPrompt, { type: 'text', text: `--- NOTE: You have used ${i + 1}/${maxIter} iterations. Prioritize writing output files and producing results. If you have remaining work, focus on the most important items first. ---` }]
              : systemPrompt + `\n\n--- NOTE: You have used ${i + 1}/${maxIter} iterations. Prioritize writing output files and producing results. If you have remaining work, focus on the most important items first. ---`)
            : systemPrompt;

          // Subagent thinking is gated by config.subagentThinkingBudget;
          // map the numeric budget to a categorical effort so the plugin
          // dispatch picks the right wire shape for the active model
          // (adaptive for claude-opus-4-6/4-7, budget_tokens for the
          // rest, no-op for non-thinking models). Without going through
          // the dispatch the request would hit Anthropic's adaptive-only
          // models with the legacy { type:'enabled', budget_tokens }
          // shape and the API rejects with `thinking.type.enabled is
          // not supported for this model`.
          const subThinkingBudget = this.config.subagentThinkingBudget || 32000;
          const _budgetToEffort = (budget) => {
            if (!budget || budget < 1) return 'off';
            if (budget <= 1024)  return 'minimal';
            if (budget <= 2048)  return 'low';
            if (budget <= 10000) return 'medium';
            if (budget <= 24000) return 'high';
            return 'max';
          };
          const subEffort = _budgetToEffort(subThinkingBudget);
          const baseMaxTokens = this.config.subagentMaxTokens || effortDefaults(this.config).subagentMaxTokens || this._modelMaxOutputTokens(subModel);
          // Reserve headroom for thinking tokens when the operator wants
          // a real budget. Non-thinking models silently no-op the
          // applyReasoningEffort below so the extra max_tokens is harmless.
          const subMaxTokens = subEffort !== 'off' ? Math.max(baseMaxTokens, subThinkingBudget + 16000) : baseMaxTokens;

          if (messages.length >= 2) {
            for (const m of messages) {
              if (m.role === 'user' && Array.isArray(m.content)) {
                for (let j = 0; j < m.content.length; j++) {
                  if (m.content[j].cache_control) {
                    const { cache_control, ...rest } = m.content[j];
                    m.content[j] = rest;
                  }
                }
              }
            }
            for (let mi = messages.length - 1; mi >= 0; mi--) {
              if (messages[mi].role === 'user') {
                const msg = messages[mi];
                if (Array.isArray(msg.content) && msg.content.length > 0) {
                  const lb = msg.content[msg.content.length - 1];
                  msg.content[msg.content.length - 1] = { ...lb, cache_control: { type: 'ephemeral' } };
                } else if (typeof msg.content === 'string') {
                  msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
                }
                break;
              }
            }
          }

          let requestOpts = {
            model: subModel,
            max_tokens: subMaxTokens,
            system: systemWithBudget,
            messages,
            ...(subTools.length > 0 ? { tools: subTools } : {}),
          };
          // Plugin-dispatched thinking config — anthropic-provider picks
          // adaptive vs budget shape per model; non-thinking models
          // (haiku-3, GPT-3.5, etc.) silently no-op via the in-tree
          // generic OAI fallback in core. Same path used by _callLLM.
          const { AgentLoop } = require('../agent/loop');
          if (subEffort !== 'off') {
            requestOpts = AgentLoop.applyReasoningEffort(requestOpts, subModel, subEffort);
          }

          // Stream the response so we can broadcast deltas to the panel
          this.broadcast({ type: 'subagent:iter', taskId, iteration: i + 1, maxIter, model: subModel });
          this.log.info(`[subagent:${taskId}] Iter ${i + 1} starting — model=${subModel}, max_tokens=${subMaxTokens}`);
              let streamingText = '';
              let thinkingTokens = 0;
              let _subStreamToolCount = 0;
              let _toolInputBytes = 0;
              let _currentToolName = '';
              let response;
              const MAX_API_RETRIES = 3;
              for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
                try {
                  streamingText = '';
                  thinkingTokens = 0;
                  _subStreamToolCount = 0;
                  _toolInputBytes = 0;
                  _currentToolName = '';
                  const _subStreamStart = Date.now();
                  const perCallTimeout = AbortSignal.timeout(180_000);
                  const stream = this.llmClient.messages.stream(requestOpts, { signal: perCallTimeout });

                  // Heartbeat during long subagent API calls — broadcast to panel for live progress
                  const subHeartbeat = setInterval(() => {
                    const elapsed = Math.round((Date.now() - _subStreamStart) / 1000);
                    const toolInfo = _toolInputBytes > 0 ? `, ${_currentToolName} ${Math.round(_toolInputBytes / 1024)}KB` : '';
                    this.log.info(`[subagent:${taskId}] Iter ${i + 1} streaming — ${elapsed}s, ${streamingText.length} chars, ${_subStreamToolCount} tool(s), ${thinkingTokens} thinking${toolInfo}`);
                    this.broadcast({ type: 'subagent:heartbeat', taskId, iteration: i + 1, elapsed, chars: streamingText.length, tools: _subStreamToolCount, thinking: thinkingTokens, toolBytes: _toolInputBytes, toolName: _currentToolName });
                  }, 10000);
                  subHeartbeat.unref?.();

                  stream.on('text', (text) => {
                    streamingText += text;
                    this.broadcast({ type: 'subagent:text', taskId, iteration: i + 1, text });
                  });

                  let _thinkingText = '';
                  stream.on('event', (event) => {
                    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
                      _thinkingText = '';
                      this.broadcast({ type: 'subagent:thinking_start', taskId, iteration: i + 1 });
                    }
                    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
                      thinkingTokens++;
                      _thinkingText += event.delta.thinking || '';
                      if (thinkingTokens % 20 === 0) {
                        const snippet = _thinkingText.length > 120
                          ? _thinkingText.slice(-120).replace(/^\S*\s/, '')
                          : _thinkingText;
                        this.broadcast({ type: 'subagent:thinking', taskId, iteration: i + 1, tokens: thinkingTokens, snippet });
                      }
                    }
                    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                      _subStreamToolCount++;
                      _toolInputBytes = 0;
                      _currentToolName = event.content_block.name || '';
                      this.broadcast({ type: 'subagent:tool_start', taskId, iteration: i + 1, tool: _currentToolName });
                    }
                    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
                      const prevKB = Math.floor(_toolInputBytes / 2048);
                      _toolInputBytes += (event.delta.partial_json || '').length;
                      const newKB = Math.floor(_toolInputBytes / 2048);
                      if (newKB > prevKB) {
                        this.broadcast({ type: 'subagent:tool_progress', taskId, iteration: i + 1, tool: _currentToolName, bytes: _toolInputBytes });
                      }
                    }
                  });

              try {
                response = await stream.finalMessage();
              } finally {
                clearInterval(subHeartbeat);
              }
              break;
            } catch (retryErr) {
              const isTimeout = retryErr.name === 'TimeoutError' || retryErr.name === 'AbortError';
              const retryable = isTimeout || [429, 500, 502, 503, 529].includes(retryErr.status);
              if (!retryable || attempt >= MAX_API_RETRIES) throw retryErr;
              const delay = isTimeout ? 3000 : retryErr.status === 429 ? 5000 : (attempt + 1) * 5000;
              this.log.warn(`[subagent:${taskId}] ${isTimeout ? 'API call timed out (180s)' : `API error ${retryErr.status}`}, retry ${attempt + 1}/${MAX_API_RETRIES} in ${delay / 1000}s`);
              this.broadcast({ type: 'subagent:text', taskId, iteration: i + 1, text: `\n[retrying — API returned ${retryErr.status}…]\n` });
              await new Promise(r => setTimeout(r, delay));
            }
          }

          if (response.usage) {
            totalUsage.input_tokens += (response.usage.input_tokens || 0)
              + (response.usage.cache_read_input_tokens || 0)
              + (response.usage.cache_creation_input_tokens || 0);
            totalUsage.output_tokens += response.usage.output_tokens || 0;
            totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
            totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
          }

          const textBlocks = response.content.filter(b => b.type === 'text');
          const toolBlocks = response.content.filter(b => b.type === 'tool_use');
          const newText = textBlocks.map(b => b.text).join('');
          if (finalText.length + newText.length < 100000) {
            finalText += newText;
          }
          if (newText.trim() && !isInternalThinking(newText)) latestSummary = newText;

          const iterMs = Date.now() - iterStart;
          const iterUsage = response.usage || {};
          iterStats.iterCount = i + 1;
          iterStats.textChars += newText.length;
          this.log.info(`[subagent:${taskId}] Iter ${i + 1}/${maxIter}: ${iterMs}ms, ${toolBlocks.length} tools, ${newText.length} chars text, stop=${response.stop_reason}, tokens=${iterUsage.input_tokens || 0}in/${iterUsage.output_tokens || 0}out`);
          this.broadcast({ type: 'subagent:iter_done', taskId, iteration: i + 1, durationMs: iterMs, toolCount: toolBlocks.length, textChars: newText.length, stopReason: response.stop_reason });

          // Mid-task nudge: if the task is about creating files and we're past 40%
          // of iterations without any writes, inject a reminder
          if (i >= Math.floor(maxIter * 0.4) && iterStats.writeFileCalls === 0 && iterStats.totalToolCalls > 3) {
            const taskLower = task.toLowerCase();
            const isFileTask = /\b(create|build|generate|make|write|produce|render)\b.*\b(file|page|html|chart|heatmap|dashboard|report|visualization|image|script|app)\b/i.test(taskLower);
            if (isFileTask && !taskEntry._writeNudgeSent) {
              taskEntry._writeNudgeSent = true;
              this.log.warn(`[subagent:${taskId}] Iter ${i + 1}: File-creation task at ${Math.round((i+1)/maxIter*100)}% with 0 write_file calls — nudging`);
              if (messages[messages.length - 1]?.role === 'user' && Array.isArray(messages[messages.length - 1].content)) {
                messages[messages.length - 1].content.push({
                  type: 'text',
                  text: `[SYSTEM: You are past ${Math.round((i+1)/maxIter*100)}% of your iteration budget and have not written any files yet. This task requires file output. Start writing files NOW using write_file — do not spend more iterations on research. Write incrementally: create the file first, then refine with edit_file if needed.]`,
                });
              }
            }
          }

          if (toolBlocks.length === 0 && newText.length > 500) {
            const codeBlockCount = (newText.match(/```/g) || []).length / 2;
            if (codeBlockCount >= 1 && i < maxIter - 1) {
              this.log.warn(`[subagent:${taskId}] Iter ${i + 1}: generated ${newText.length} chars with ~${Math.floor(codeBlockCount)} code blocks but NO tool calls — nudging to write files`);
              this.broadcast({ type: 'subagent:warn', taskId, iteration: i + 1, message: `${newText.length} chars with code blocks but no write_file calls — nudging` });
              messages.push({ role: 'assistant', content: response.content });
              messages.push({ role: 'user', content: '[SYSTEM: You generated code/content in your text response but did NOT call write_file to save it. Text responses are NOT persisted — the user will not see this code. You MUST call write_file now to write the content to disk. Extract the code blocks from your previous response and write each one to the appropriate file path.]' });
              continue;
            }
          }

          if (toolBlocks.length === 0 || response.stop_reason === 'end_turn') break;

          // Handle max_tokens truncation: the model tried to call a tool but
          // the response was cut off. Add the truncated attempt to history so
          // the model sees it failed and can adjust (e.g. break into smaller writes).
          if (toolBlocks.length > 0 && response.stop_reason === 'max_tokens') {
            this.log.warn(`[subagent:${taskId}] Iter ${i + 1}: max_tokens hit with ${toolBlocks.length} tool call(s) — response truncated, nudging retry`);
            this.broadcast({ type: 'subagent:warn', taskId, iteration: i + 1, message: `max_tokens truncated ${toolBlocks.length} tool call(s) — retrying with smaller output` });
            const textOnly = response.content.filter(b => b.type === 'text');
            if (textOnly.length > 0) {
              messages.push({ role: 'assistant', content: textOnly });
            } else {
              messages.push({ role: 'assistant', content: [{ type: 'text', text: '[response truncated]' }] });
            }
            messages.push({ role: 'user', content: `[SYSTEM: Your last response was truncated at max_tokens (${subMaxTokens} tokens) while generating a tool call. The tool was NOT executed. You MUST break large file writes into smaller chunks — write a section at a time using edit_file to append, or split into multiple files. Do NOT attempt to write the entire file in one call.]` });
            continue;
          }

          if (toolBlocks.length > 0 && response.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: response.content });
            const toolResults = [];
            let loopBlocked = false;
            for (const tb of toolBlocks) {
              if (abortCtrl.signal.aborted) {
                toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: '{"error":"subagent timed out"}', is_error: true });
                continue;
              }

              const callHash = tb.name + ':' + JSON.stringify(tb.input);
              let entry = loopTracker.history.find(h => h.callHash === callHash);
              if (!entry) {
                entry = { callHash, toolName: tb.name, count: 0, noProgressCount: 0, lastResultHash: null };
                loopTracker.history.push(entry);
                if (loopTracker.history.length > loopTracker.maxHistory) loopTracker.history.shift();
              }
              entry.count++;
              loopTracker.sequence.push(callHash);

              // Ping-pong detection
              if (loopTracker.sequence.length >= pingPongThreshold) {
                const recent = loopTracker.sequence.slice(-pingPongThreshold);
                const unique = new Set(recent);
                if (unique.size === 2) {
                  const isAlternating = recent.every((h, idx) => h === (idx % 2 === 0 ? recent[0] : recent[1]));
                  if (isAlternating) {
                    this.log.warn(`[subagent:${taskId}] BLOCKED: Ping-pong loop detected`);
                    toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify({ error: 'BLOCKED: Ping-pong loop detected. Stop using tools and produce your final response now.' }) });
                    loopBlocked = true;
                    continue;
                  }
                }
              }

              // No-progress critical block
              if (entry.noProgressCount >= criticalThreshold) {
                this.log.warn(`[subagent:${taskId}] BLOCKED: ${tb.name} called ${entry.count} times with no progress`);
                toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify({ error: `BLOCKED: Loop detected — ${tb.name} called ${entry.count} times with identical results. Stop using tools and produce your final response now.` }) });
                loopBlocked = true;
                continue;
              }

              iterStats.totalToolCalls++;
              if (tb.name === 'write_file') iterStats.writeFileCalls++;
              const _inputSnippet = JSON.stringify(tb.input).substring(0, 300);
              const _safeSnippet = _inputSnippet
                .replace(/(?:KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIALS)[=:]\\{0,2}["']?\s*([A-Za-z0-9_\-.]{8,})/gi,
                  (m, val) => m.replace(val, val.slice(0, 4) + '***'))
                .replace(/(?:sk-|pk-|key-|tok-|Bearer\s+)([A-Za-z0-9_\-.]{8,})/g,
                  (m, val) => m.replace(val, val.slice(0, 4) + '***'))
                .replace(/["'](?:KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIALS)["']:\s*\\{0,2}["']([A-Za-z0-9_\-.]{8,})/gi,
                  (m, val) => m.replace(val, val.slice(0, 4) + '***'))
                .replace(/[A-Fa-f0-9]{32,}/g, (m) => m.slice(0, 6) + '***');
              this.log.info(`[subagent:${taskId}] Tool: ${tb.name}(${_safeSnippet.substring(0, 80)})`);
              this.broadcast({ type: 'subagent:tool_call', taskId, iteration: i + 1, tool: tb.name, input: _safeSnippet.substring(0, 200) });
              sendProgress(`🔧 \`${tb.name}\``);
              const result = await this.executeTool(tb.name, tb.input);
              let resultStr = JSON.stringify(result);
              const subCap = { read_file: 80000, web_fetch: 15000 }[tb.name] || 20000;
              if (resultStr.length > subCap) {
                resultStr = resultStr.substring(0, subCap) + `\n[TRUNCATED: ${resultStr.length} chars → ${subCap}]`;
              }

              // Record result hash for progress detection
              const resultHash = resultStr.substring(0, 500);
              if (entry.lastResultHash !== null) {
                if (entry.lastResultHash === resultHash) {
                  entry.noProgressCount++;
                } else {
                  entry.noProgressCount = 0;
                }
              }
              entry.lastResultHash = resultHash;

              // Append warning if approaching loop
              if (entry.noProgressCount >= warnThreshold) {
                this.log.warn(`[subagent:${taskId}] WARNING: ${tb.name} repeated ${entry.count} times with no new results`);
                resultStr += `\n\n--- WARNING: You have called ${tb.name} with identical arguments ${entry.count} times with no new results (${entry.noProgressCount} identical). You may be stuck in a loop. Try a different approach or produce your output now. ---`;
              }

              // web_serve success = task is functionally complete — break after this tool batch
              const isWebServeSuccess = tb.name === 'web_serve'
                && (tb.input?.action === 'start' || tb.input?.action === 'backend')
                && !resultStr.includes('"error"');
              if (isWebServeSuccess) {
                taskEntry._terminalToolReached = true;
                this.log.info(`[subagent:${taskId}] web_serve succeeded at iter ${i + 1} — marking task complete`);
                this.broadcast({ type: 'subagent:finishing', taskId, iteration: i + 1 });
              }

              toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: resultStr });
            }
            messages.push({ role: 'user', content: toolResults });

            if (loopBlocked) {
              this.log.warn(`[subagent:${taskId}] Loop detected — forcing termination at iteration ${i + 1}`);
              break;
            }

            if (taskEntry._terminalToolReached) {
              this.log.info(`[subagent:${taskId}] Terminal tool completed — ending loop at iteration ${i + 1}`);
              break;
            }

            // Send the subagent's own natural status update if enough time has passed
            if (Date.now() - lastProgressAt >= progressIntervalMs) {
              sendProgress();
              lastProgressAt = Date.now();
            }
          }
        }

        // If we broke out due to a terminal tool, append the tool result as context
        if (taskEntry._terminalToolReached && !finalText.trim()) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
            const toolTexts = lastMsg.content
              .filter(b => b.type === 'tool_result' && typeof b.content === 'string')
              .map(b => b.content.substring(0, 1000));
            if (toolTexts.length) finalText = toolTexts.join('\n');
          }
        }

        taskEntry.status = 'done';
        taskEntry.result = { result: finalText, usage: totalUsage, model: subModel, iterations: messages.length };
        taskEntry.completedAt = Date.now();
        const elapsedSec = Math.round((taskEntry.completedAt - taskEntry.startedAt) / 1000);
        this.log.info(`[subagent:${taskId}] Completed in ${elapsedSec}s — ${iterStats.iterCount} iters, ${iterStats.totalToolCalls} tool calls (${iterStats.writeFileCalls} writes), ${iterStats.textChars} chars text, ${totalUsage.input_tokens}in/${totalUsage.output_tokens}out`);

        // Empty-hand recovery: extract stranded code blocks and write them to disk
        const codeBlocksInFinal = (finalText.match(/```/g) || []).length / 2;
        if (iterStats.writeFileCalls === 0 && codeBlocksInFinal >= 1 && finalText.length > 300) {
          this.log.warn(`[subagent:${taskId}] EMPTY-HAND: ${Math.floor(codeBlocksInFinal)} code blocks in ${finalText.length} chars of text but 0 write_file calls — attempting auto-extraction`);
          this.broadcast({ type: 'subagent:warn', taskId, message: `Empty-hand: extracting ${Math.floor(codeBlocksInFinal)} stranded code blocks to disk` });

          const codeBlockRe = /```(\w+)?\s*\n([\s\S]*?)```/g;
          let match;
          let extracted = 0;
          const extMap = { html: '.html', js: '.js', javascript: '.js', css: '.css', python: '.py', py: '.py', json: '.json', sh: '.sh', bash: '.sh', sql: '.sql', svg: '.svg', xml: '.xml', yaml: '.yml', yml: '.yml', markdown: '.md', md: '.md', tsx: '.tsx', ts: '.ts', jsx: '.jsx' };

          while ((match = codeBlockRe.exec(finalText)) !== null) {
            const lang = (match[1] || '').toLowerCase();
            const code = match[2];
            if (!code || code.trim().length < 20) continue;

            // Try to find a filename hint in the text before this code block
            const textBefore = finalText.substring(Math.max(0, match.index - 300), match.index);
            const filenameMatch = textBefore.match(/(?:file|save|write|create|called|named|path)[:\s]+[`"']?([/\w.-]+\.\w{1,5})[`"']?\s*$/i)
              || textBefore.match(/[`"']([/\w.-]+\.\w{1,5})[`"']\s*(?::|$)/);

            let filePath;
            if (filenameMatch) {
              filePath = filenameMatch[1];
              if (!filePath.startsWith('/')) filePath = `/workspace/${filePath}`;
            } else {
              const ext = extMap[lang] || '.txt';
              filePath = `/workspace/subagent-output-${extracted + 1}${ext}`;
            }

            try {
              const result = await this.executeTool('write_file', { path: filePath, content: code });
              if (!result?.error) {
                extracted++;
                this.log.info(`[subagent:${taskId}] Auto-extracted: ${filePath} (${code.length} chars)`);
                finalText += `\n\nAuto-extracted to: ${filePath}`;
              }
            } catch (we) {
              this.log.warn(`[subagent:${taskId}] Auto-extraction failed for ${filePath}: ${we.message}`);
            }
          }

          if (extracted > 0) {
            this.log.info(`[subagent:${taskId}] Auto-extracted ${extracted} code blocks to disk`);
            this.broadcast({ type: 'subagent:info', taskId, message: `Auto-extracted ${extracted} code blocks to disk` });
            iterStats.writeFileCalls += extracted;
          }
        }

        this.broadcast({ type: 'subagent:done', taskId, elapsed: elapsedSec, usage: totalUsage, iterations: iterStats.iterCount, toolCalls: iterStats.totalToolCalls, writeFileCalls: iterStats.writeFileCalls, textChars: iterStats.textChars });
        sendProgressDone(false);

        // Store subagent result as an episode so research is durably searchable
        if (this.learner?.storeEpisode && finalText) {
          try {
            this.learner.storeEpisode(
              taskEntry.originalUserMessage || task,
              (finalText || '').substring(0, 4000),
              { sessionId: `subagent:${taskId}`, observedAt: new Date().toISOString(), turnIdx: 0 }
            );
          } catch (e) { this.log.warn('[tools] learner.storeEpisode failed: ' + e.message); }
        }
      } catch (e) {
        if (taskEntry.status === 'cancelled') return;
        taskEntry.status = 'error';
        const friendlyError = e.name === 'AbortError'
          ? `Subagent timed out after ${maxTimeoutSec}s`
          : e.status === 529 || e.error?.type === 'overloaded_error' ? 'API is overloaded — try again in a moment'
            : e.status === 500 || e.error?.type === 'api_error' ? 'API server error — try again shortly'
              : e.status === 429 ? 'Rate limited — too many requests'
                : `Delegation failed: ${(e.error?.error?.message || e.message || 'unknown error').substring(0, 200)}`;
        taskEntry.result = { error: friendlyError };
        taskEntry.completedAt = Date.now();
        this.log.warn(`[subagent:${taskId}] Failed: ${taskEntry.result.error}`);
        this.broadcast({ type: 'subagent:error', taskId, error: taskEntry.result.error });
        try { if (typeof sendProgressDone === 'function') sendProgressDone(true); } catch (e) { this.log.warn('[tools] sendProgressDone failed: ' + e.message); }
      } finally {
        clearTimeout(abortTimer);
        this._activeSubagents = Math.max(0, this._activeSubagents - 1);
        // Auto-deliver result to the originating channel
        if (taskEntry.status !== 'cancelled') {
          this._deliverTaskResult(taskId, taskEntry);
        }
      }
    })();

    return { taskId, status: 'running', message: `Task started in the background. Results will be delivered here automatically when done. You can check progress with task_status("${taskId}") or cancel with task_cancel("${taskId}").` };
  }

  _deliverTaskResult(taskId, taskEntry) {
    try {
      const { channelId, platform, userId: taskUserId } = taskEntry;
      if (!channelId) return;

      // Web panel AND Spore Code both deliver via the same WebSocket
      // gateway — channelId = sessionId (per-(user,cwd) for acorn,
      // "web:control-panel" for web), broadcast frames go to all
      // connected clients (acorn filters by its active sessionId).
      // Previously CLI fell through to platformManager.getGateway('cli')
      // which returns null (no CLI gateway exists), so the push
      // silently dropped and the agent never got woken up.
      if (platform === 'web' || platform === 'cli') {
        const isCli = platform === 'cli';
        const deliveryUserId = taskUserId || 'operator';
        const elapsed = Math.round((taskEntry.completedAt - taskEntry.startedAt) / 1000);
        const status = taskEntry.status === 'done' ? 'completed' : 'failed';
        const resultText = taskEntry.status === 'done' ? (taskEntry.result?.result || '').substring(0, 4000) : (taskEntry.result?.error || 'unknown error');
        this.broadcast({ type: 'subagent:result', taskId, status, elapsed, result: resultText });

        // Trigger agent to process the result and respond to the user
        if (this._agent) {
          const usage = taskEntry.result?.usage;
          const usageStr = usage ? ` (${usage.input_tokens}/${usage.output_tokens} tokens)` : '';
          const statusLabel = taskEntry.status === 'done' ? 'completed successfully' : `failed: ${taskEntry.result?.error || 'unknown'}`;
          const resultSummary = taskEntry.status === 'done' ? (taskEntry.result?.result || '').substring(0, 6000) : '';
          const originalQ = taskEntry.originalUserMessage || '';
          const content = [
            `[BACKGROUND TASK ${statusLabel}]`,
            originalQ ? `Original request: ${originalQ.substring(0, 500)}` : '',
            `Task ID: ${taskId}`,
            `Duration: ${elapsed}s${usageStr}`,
            resultSummary ? `\nResult:\n${resultSummary}` : '',
            '\nSummarize the key findings for the user. If the task produced files, mention their paths.',
          ].filter(Boolean).join('\n');

          // Queue delivery to prevent concurrent deliveries from interleaving
          if (!this._deliveryQueue) this._deliveryQueue = Promise.resolve();
          this._deliveryQueue = this._deliveryQueue.then(async () => {
            // Wait for any active session run to finish before attempting delivery.
            // For acorn the sessionKey uses the session:false (non-DM) branch
            // because acorn treats each launch as its own channel — isDm for
            // session key purposes is just "deliverable independently".
            const sessionKey = this._agent.sessions?.constructor?.buildKey?.(channelId, true, deliveryUserId) || `dm:${deliveryUserId}`;
            const MAX_WAIT = 120000;
            const waitStart = Date.now();
            let waited = false;
            while (this._agent.activeRuns?.has(sessionKey) && Date.now() - waitStart < MAX_WAIT) {
              if (!waited) {
                this.log.info(`[subagent:${taskId}] Waiting for session ${sessionKey} to become free before delivering result`);
                waited = true;
              }
              await new Promise(r => setTimeout(r, 1500));
            }

            let chatStartSent = false;
            try {
              this.broadcast({ type: 'chat:start', sessionId: channelId });
              chatStartSent = true;
              const result = await this._agent.processMessage({
                content,
                channelId,
                channelName: isCli ? `cli:${deliveryUserId}` : 'control-panel',
                userId: deliveryUserId,
                userName: taskEntry.originalUserName || 'System',
                trigger: 'task_complete',
                platform: isCli ? 'cli' : 'web',
                isDm: !isCli, // CLI sessions aren't DM — preserves per-session isolation
                projectContext: taskEntry.projectContext || null,
                onTextDelta: (delta) => {
                  this.broadcast({ type: 'chat:delta', text: delta });
                },
                onToolUse: (toolName) => {
                  this.broadcast({ type: 'chat:tool', tool: toolName });
                },
              });
              if (result.skipped) {
                this._agent.sessions?.addMessage(sessionKey, 'user', content);
                this.broadcast({ type: 'chat:done', text: `Background task finished: ${statusLabel}. Send a message to see the full summary.` });
                this.log.info(`[subagent:${taskId}] Session busy at delivery time, result injected for next turn`);
              } else {
                this.broadcast({
                  type: 'chat:done',
                  text: result.text,
                  usage: result.usage,
                  iterations: result.iterations,
                  toolUsage: result.toolUsage,
                });
              }
            } catch (e) {
              this.log.warn(`[subagent:${taskId}] ${isCli ? 'CLI' : 'Web'} result delivery failed: ${e.message}`);
              this._agent.sessions?.addMessage(sessionKey, 'user', content);
              if (chatStartSent) this.broadcast({ type: 'chat:done', text: `Background task finished but delivery failed. Send a message to see results.` });
            }
          }).catch(e => {
            this.log.warn(`[subagent:${taskId}] Delivery queue error: ${e.message}`);
          });
        }
        return;
      }

      if (!this.platformManager) return;
      const gateway = this.platformManager.getGateway(platform);
      if (!gateway?.injectTaskComplete) return;

      gateway.injectTaskComplete(channelId, taskId, taskEntry);
    } catch (e) {
      this.log.warn(`[subagent:${taskId}] Failed to deliver result: ${e.message}`);
    }
  }

  // ── Web Search (SearXNG → Brave fallback) ────────────────────────────

  async _webSearchTool(input) {
    const { query, count = 5 } = input;

    // Try SearXNG first
    const searxngUrl = this.config.searxngUrl || process.env.SEARXNG_URL;
    const searxngApiKey = this.config.searxngApiKey || process.env.SEARXNG_API_KEY || '';
    if (searxngUrl) {
      try {
        const result = await this._searxngSearch(query, count, searxngUrl, searxngApiKey);
        if (result.results && result.results.length > 0) return result;
        // Fall through to Brave if SearXNG returned nothing
      } catch (e) {
        this.log.warn(`[search] SearXNG failed: ${e.message}, trying Brave fallback`);
      }
    }

    // Brave fallback
    const apiKey = this.config.braveApiKey;
    if (!apiKey && !searxngUrl) return { error: 'No search provider configured. Set SEARXNG_URL or BRAVE_API_KEY.' };
    if (!apiKey) return { results: [], query, note: 'SearXNG returned no results and no Brave API key configured' };
    return this._braveSearch(query, count, apiKey);
  }

  async _searxngSearch(query, count, baseUrl, apiKey) {
    const url = baseUrl.replace(/\/$/, '');
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: 'general',
    });

    return new Promise((resolve, reject) => {
      const fullUrl = `${url}/search?${params}`;
      const mod = fullUrl.startsWith('https') ? https : http;
      const opts = { timeout: 15000, headers: {} };
      if (apiKey) opts.headers['Authorization'] = `Bearer ${apiKey}`;

      const req = mod.get(fullUrl, opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`SearXNG HTTP ${res.statusCode}${data ? ': ' + data.slice(0, 120) : ''}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            const results = (json.results || []).slice(0, count).map(r => ({
              title: r.title || '',
              url: r.url || '',
              description: r.content || r.description || '',
            }));
            resolve({ results, query, total: (json.results || []).length, provider: 'searxng' });
          } catch (e) {
            reject(new Error(`SearXNG parse error: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(new Error(`SearXNG request failed: ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('SearXNG timed out')); });
    });
  }

  _braveSearch(query, count, apiKey) {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        q: query,
        count: Math.min(count, 20).toString(),
      });

      const options = {
        hostname: 'api.search.brave.com',
        path: `/res/v1/web/search?${params}`,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'identity',
          'X-Subscription-Token': apiKey,
        },
        agent: httpsAgent,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.web?.results) {
              const results = json.web.results.slice(0, count).map(r => ({
                title: r.title,
                url: r.url,
                description: r.description || '',
              }));
              resolve({ results, query, total: json.web.results.length, provider: 'brave' });
            } else {
              resolve({ results: [], query, note: 'No results found' });
            }
          } catch (e) {
            resolve({ error: `Failed to parse response: ${e.message}` });
          }
        });
      });

      req.on('error', (e) => resolve({ error: `Search request failed: ${e.message}` }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'Search timed out' }); });
      req.end();
    });
  }

  // ── Web Fetch ────────────────────────────────────────────────────────

  _isBlockedHost(hostname) {
    if (!hostname) return true;
    const blocked = [
      /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
      /^169\.254\./, /^0\./, /^fc00:/i, /^fe80:/i, /^::1$/,
      /^localhost$/i, /^metadata\./i, /\.internal$/i,
      /^spore-manager$/i, /^docker-proxy$/i, /^traefik$/i,
    ];
    return blocked.some(r => r.test(hostname));
  }

  _finalizeWebFetchResult({ body = '', contentType = '', url, maxLength = 8000, bytesRaw = 0, transport }) {
    const raw = typeof body === 'string' ? body : String(body || '');
    const normalizedType = String(contentType || '').toLowerCase();

    if (normalizedType.includes('application/json')) {
      return {
        content: raw.substring(0, maxLength),
        type: 'json',
        url,
        bytesRaw,
        transport,
      };
    }

    const isHtmlLike = normalizedType.includes('text/html')
      || normalizedType.includes('application/xhtml')
      || normalizedType.includes('application/xml')
      || normalizedType.includes('text/xml');
    if (!isHtmlLike) {
      return { content: raw.substring(0, maxLength), type: 'text', url, bytesRaw, transport };
    }

    const htmlText = this._extractTextFromHtml(raw);
    // Try state-blob recovery for SPAs that ship the article inline as
    // JSON (Next.js, Nuxt, Apollo). For Next.js sites like react.dev
    // this is the difference between getting SVG soup back and getting
    // the actual article markdown.
    const blobText = this._extractFromStateBlob(raw);
    // Prefer the blob when it's meaningfully bigger than the HTML
    // extractor's output — that signals the static HTML was a chrome
    // shell and the article lives in the JSON. Use the title from the
    // HTML extractor (it's still in the static <title>) so the agent
    // sees the page name regardless of which path won.
    let chosen = htmlText;
    let extractedFrom = 'html';
    if (blobText && blobText.length > htmlText.length * 1.5) {
      const titleLine = htmlText.match(/^# .*\n/)?.[0] || '';
      chosen = titleLine ? titleLine + '\n' + blobText : blobText;
      extractedFrom = 'state-blob';
    }

    return {
      content: chosen.substring(0, maxLength),
      type: 'text',
      url,
      bytesRaw,
      transport,
      extractedFrom,
    };
  }

  async _curlCffiFetch({ url, maxLength = 8000, method, body: reqBody, headers: extraHeaders }) {
    const helperPath = path.join(__dirname, 'curl_fetch.py');
    if (!fs.existsSync(helperPath)) {
      return { transportError: `curl_cffi helper not found: ${helperPath}` };
    }

    const abortSignal = this._abortSignal;
    if (abortSignal?.aborted) {
      return { error: 'Aborted', transport: 'curl_cffi' };
    }

    return await new Promise((resolve) => {
      const { spawn } = require('child_process');
      const payload = {
        url,
        maxLength,
        method: (method || 'GET').toUpperCase(),
        body: reqBody,
        headers: { ...(extraHeaders || {}) },
        timeout: 20,
        impersonate: 'safari_ios',
      };

      let resolved = false;
      let stdout = '';
      let stderr = '';
      let onAbort;
      let child = null;
      let hardTimeout = null;

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimeout);
        if (abortSignal && onAbort) {
          try { abortSignal.removeEventListener('abort', onAbort); } catch (e) { this.log.warn('[tools] abortSignal.removeEventListener failed: ' + e.message); }
        }
        if (child?.pid) this._trackedPids.delete(child.pid);
        resolve(result);
      };

      child = spawn('python3', [helperPath], {
        cwd: this.config.workspacePath || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!child.pid || !this._trackProcess(child.pid)) {
        done({ transportError: 'Unable to start curl_cffi helper — process limit reached' });
        return;
      }

      hardTimeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); } }, 2000);
        done({ transportError: `curl_cffi helper timed out after 22s for ${url}` });
      }, 22000);

      if (abortSignal) {
        onAbort = () => {
          try { child.kill('SIGTERM'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { this.log.warn('[tools] child.kill failed: ' + e.message); } }, 2000);
          done({ error: 'Aborted by user', transport: 'curl_cffi' });
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > Math.max(maxLength * 5, 20000)) {
          stdout = stdout.substring(0, Math.max(maxLength * 5, 20000));
        }
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.substring(0, 4000);
      });

      child.on('error', (e) => done({ transportError: `curl_cffi helper failed: ${e.message}` }));
      child.on('exit', () => {
        if (resolved) return;
        let parsed;
        try {
          parsed = JSON.parse(stdout || '{}');
        } catch {
          done({
            transportError: `curl_cffi helper returned invalid JSON${stderr ? `: ${stderr.substring(0, 300)}` : ''}`,
          });
          return;
        }
        if (parsed.transport_error) {
          done({ transportError: parsed.transport_error });
          return;
        }
        if (stderr.trim() && !parsed.detail) {
          parsed.detail = stderr.trim().substring(0, 500);
        }
        done(parsed);
      });

      try {
        child.stdin.end(JSON.stringify(payload));
      } catch (e) {
        done({ transportError: `curl_cffi helper input failed: ${e.message}` });
      }
    });
  }

  async _webFetchTool(input, _redirectDepth = 0) {
    const { url, maxLength = 8000, credential, method, body: reqBody, headers: extraHeaders } = input;
    if (!url) return { error: 'URL is required' };
    if (_redirectDepth > 3) return { error: 'Too many redirects' };

    // Route through manager vault proxy when a credential is specified
    if (credential && _redirectDepth === 0) {
      return this._vaultProxyFetch({ url, credential, method, body: reqBody, headers: extraHeaders, maxLength });
    }

    try {
      const parsed = new URL(url);
      if (this._isBlockedHost(parsed.hostname)) {
        return { error: `Blocked: access to ${parsed.hostname} is not allowed (private/internal network)` };
      }
    } catch {
      return { error: `Invalid URL: ${url}` };
    }

    // Primary: @teng-lin/agent-fetch — runs Mozilla Readability + text-density
    // (CETD) + JSON-LD + __NEXT_DATA__ + RSC (Next.js App Router) + WordPress
    // REST + CSS-selector strategies in parallel, picks the best result.
    // Plus its own Chrome TLS fingerprinting via httpcloak. Replaces the
    // older curl_cffi + hand-rolled extractor path for non-credential
    // requests; that path is kept as a defensive fallback below.
    const agentResult = await this._agentFetch({ url, maxLength, method, body: reqBody, headers: extraHeaders });
    if (agentResult && !agentResult.transportError) return agentResult;
    if (agentResult?.transportError) {
      this.log.warn(`[web_fetch] agent-fetch unavailable: ${agentResult.transportError} — falling back to curl_cffi`);
    }

    const curlResult = await this._curlCffiFetch({
      url,
      maxLength,
      method,
      body: reqBody,
      headers: extraHeaders,
    });
    if (curlResult?.transportError) {
      this.log.warn(`[web_fetch] curl_cffi unavailable, falling back to Node fetch: ${curlResult.transportError}`);
      return this._nodeWebFetchTool(input, _redirectDepth);
    }
    if (curlResult?.error) return curlResult;
    if (curlResult && typeof curlResult.body === 'string') {
      return this._finalizeWebFetchResult({
        body: curlResult.body,
        contentType: curlResult.contentType,
        url: curlResult.url || url,
        maxLength,
        bytesRaw: curlResult.bytesRaw,
        transport: curlResult.transport || 'curl_cffi',
      });
    }

    this.log.warn('[web_fetch] curl_cffi returned no usable payload, falling back to Node fetch');
    return this._nodeWebFetchTool(input, _redirectDepth);
  }

  // Lazy-load agent-fetch (ESM-only, can't `require()` from CJS). Cache the
  // module after first successful import; cache the failure too so we don't
  // re-pay the import cost when the dep isn't installed.
  async _loadAgentFetch() {
    if (this._agentFetchModule !== undefined) return this._agentFetchModule;
    try {
      this._agentFetchModule = await import('@teng-lin/agent-fetch');
    } catch (e) {
      this.log.warn(`[web_fetch] @teng-lin/agent-fetch import failed: ${e.message}`);
      this._agentFetchModule = null;
    }
    return this._agentFetchModule;
  }

  // Map agent-fetch's FetchResult onto our existing tool return shape.
  // Returns:
  //   - successful result   → { content, type, url, bytesRaw, transport, extractedFrom, ... }
  //   - import/runtime fail → { transportError } so caller falls back
  //   - graceful failure    → { error } so the agent sees the diagnostic
  async _agentFetch({ url, maxLength = 8000, method, body, headers }) {
    // Tool dispatch only accepts GET/POST/etc through agent-fetch's HEAD-less
    // pipeline. For non-GET requests, fall back to curl/node which support
    // arbitrary methods + bodies cleanly.
    if (method && String(method).toUpperCase() !== 'GET') {
      return { transportError: `non-GET method "${method}" — using fallback transport` };
    }

    const mod = await this._loadAgentFetch();
    if (!mod?.httpFetch) return { transportError: 'agent-fetch not installed' };

    let result;
    try {
      result = await mod.httpFetch(url, {
        timeout: 20000,
        cookies: undefined,
        // Pass any extra headers through — httpcloak will merge them onto
        // the impersonated browser headers.
        ...(headers ? { headers } : {}),
      });
    } catch (e) {
      return { transportError: `agent-fetch threw: ${e.message}` };
    }

    if (!result?.success) {
      const code = result?.error || 'unknown';
      const status = result?.statusCode;
      const detail = result?.errorDetails?.type || result?.hint || '';
      return { error: `Fetch failed: ${code}${status ? ` (HTTP ${status})` : ''}${detail ? ` — ${detail}` : ''}` };
    }

    // Prefer markdown (preserves headings, links, code), fall back to
    // textContent (plain prose), then to content (HTML — only if both
    // text variants are empty, which shouldn't happen but be safe).
    const body0 = result.markdown || result.textContent || result.content || '';
    const titlePrefix = result.title ? `# ${result.title}\n\n` : '';
    const fullText = titlePrefix + body0;
    const bytesRaw = result.rawHtml ? Buffer.byteLength(result.rawHtml, 'utf8') : (body0.length);

    return {
      content: fullText.substring(0, maxLength),
      type: 'text',
      url: result.url || url,
      bytesRaw,
      transport: 'agent-fetch',
      extractedFrom: result.extractionMethod || 'agent-fetch',
    };
  }

  async _nodeWebFetchTool(input, _redirectDepth = 0) {
    const { url, maxLength = 8000, method, body: reqBody, headers: extraHeaders } = input;
    if (_redirectDepth > 3) return { error: 'Too many redirects' };
    return new Promise((resolve) => {
      let resolved = false;
      let onAbort;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimeout);
        clearTimeout(dataTimeout);
        if (abortSignal && onAbort) try { abortSignal.removeEventListener('abort', onAbort); } catch (e) { this.log.warn('[tools] abortSignal.removeEventListener failed: ' + e.message); }
        resolve(result);
      };

      const hardTimeout = setTimeout(() => {
        done({ error: `Fetch timed out after 20s: ${url}` });
        try { req.destroy(); } catch (e) { this.log.warn('[tools] req.destroy failed: ' + e.message); }
      }, 20000);

      // Abort signal from agent loop (Ctrl+C)
      const abortSignal = this._abortSignal;
      if (abortSignal?.aborted) {
        resolve({ error: 'Aborted' });
        return;
      }
      onAbort = () => {
        done({ error: 'Aborted by user' });
        try { req.destroy(); } catch (e) { this.log.warn('[tools] req.destroy failed: ' + e.message); }
      };
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

      // Data timeout — if no data received for 10s after response starts, abort
      let dataTimeout;
      const resetDataTimeout = () => {
        clearTimeout(dataTimeout);
        dataTimeout = setTimeout(() => {
          done({ error: `Stalled: no data for 10s from ${url}` });
          try { req.destroy(); } catch (e) { this.log.warn('[tools] req.destroy failed: ' + e.message); }
        }, 10000);
      };

      const fetchHeaders = { ...(extraHeaders || {}) };
      const fetchMethod = (method || 'GET').toUpperCase();
      const proto = url.startsWith('https') ? https : http;

      const reqOpts = {
        method: fetchMethod,
        headers: fetchHeaders,
        agent: url.startsWith('https') ? httpsAgent : httpAgent,
        timeout: 15000,
      };

      const req = proto.request(url, reqOpts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(hardTimeout);
          let redirectUrl = res.headers.location;
          try {
            const redir = new URL(redirectUrl, url);
            redirectUrl = redir.href;
            if (this._isBlockedHost(redir.hostname)) {
              done({ error: `Redirect blocked: ${redir.hostname} is a private/internal host` });
              return;
            }
          } catch {
            done({ error: `Invalid redirect URL: ${redirectUrl}` });
            return;
          }
          const shouldBecomeGet = res.statusCode === 303
            || ((res.statusCode === 301 || res.statusCode === 302) && fetchMethod !== 'GET' && fetchMethod !== 'HEAD');
          const redirectMethod = shouldBecomeGet ? 'GET' : fetchMethod;
          const redirectBody = shouldBecomeGet ? undefined : reqBody;
          this._nodeWebFetchTool({
            url: redirectUrl,
            maxLength,
            method: redirectMethod,
            body: redirectBody,
            headers: extraHeaders,
          }, _redirectDepth + 1).then(result => done(result));
          return;
        }
        if (res.statusCode !== 200) {
          let errData = '';
          res.on('data', c => { errData += c; if (errData.length > 2000) res.destroy(); });
          res.on('end', () => done({
            error: `HTTP ${res.statusCode}`,
            detail: errData.substring(0, 500),
            transport: 'node',
          }));
          return;
        }

        let data = '';
        resetDataTimeout(); // start data timeout on response begin
        res.on('data', chunk => {
          data += chunk;
          resetDataTimeout(); // reset on each chunk
          if (data.length > maxLength * 3) res.destroy();
        });
        res.on('end', () => {
          done(this._finalizeWebFetchResult({
            body: data,
            contentType: res.headers['content-type'] || '',
            url,
            maxLength,
            bytesRaw: data.length,
            transport: 'node',
          }));
        });
        res.on('error', (e) => done({ error: `Response error: ${e.message}` }));
      });

      req.on('error', (e) => done({ error: `Fetch failed: ${e.message}` }));
      req.setTimeout(15000, () => { req.destroy(); done({ error: 'Fetch socket timed out' }); });

      if (reqBody && fetchMethod !== 'GET') {
        const bodyStr = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
        if (!fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
          req.setHeader('Content-Type', 'application/json');
        }
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async _vaultProxyFetch({ url, credential, method, body: reqBody, headers: extraHeaders, maxLength = 8000 }) {
    const managerUrl = this.config.managerUrl;
    const serviceKey = this.config.managerServiceKey;
    if (!managerUrl || !serviceKey) {
      return { error: 'Vault proxy unavailable — MANAGER_URL or MANAGER_SERVICE_KEY not configured' };
    }

    const proxyUrl = `${managerUrl}/api/vault/proxy`;
    const proxyBody = JSON.stringify({
      keyName: credential,
      url,
      method: method || 'GET',
      headers: extraHeaders || {},
      bodyContent: reqBody || null,
    });

    return new Promise((resolve) => {
      const proto = proxyUrl.startsWith('https') ? https : http;
      const req = proto.request(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': serviceKey,
          'X-SPORE-Id': this.config.agentId || 'unknown',
          'Content-Length': Buffer.byteLength(proxyBody),
        },
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; if (data.length > maxLength * 3) res.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try { resolve({ error: `Vault proxy: HTTP ${res.statusCode}`, detail: JSON.parse(data).error || data.substring(0, 300) }); }
            catch { resolve({ error: `Vault proxy: HTTP ${res.statusCode}`, detail: data.substring(0, 300) }); }
            return;
          }
          const contentType = res.headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            resolve({ content: data.substring(0, maxLength), type: 'json', url, proxied: true });
          } else {
            resolve({ content: data.substring(0, maxLength), type: 'text', url, proxied: true });
          }
        });
      });
      req.on('error', (e) => resolve({ error: `Vault proxy request failed: ${e.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ error: 'Vault proxy request timed out' }); });
      req.write(proxyBody);
      req.end();
    });
  }

  _extractTextFromHtml(html) {
    let text = html;

    // Pull <title> from the raw HTML before stripping anything else.
    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Strip whole tag+body blocks that never carry article content. Done
    // before article-root detection so a <main> wrapping chrome (sidebars,
    // comment forms, related-articles rails) yields cleaner text.
    const dropBlocks = [
      'script', 'style', 'svg', 'noscript', 'template',
      'picture', 'iframe', 'object', 'embed',
      'nav', 'footer', 'header', 'aside', 'form',
    ];
    for (const tag of dropBlocks) {
      text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
      // Stray self-closing variants that didn't have a paired close tag.
      text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
    }

    // Prefer <article> or <main> as content root when present and
    // meaningful — slices out doc shell (search bars, login chrome,
    // sidebar trees) before extraction. Falls through to full body
    // otherwise.
    const articleMatch = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
      || text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    if (articleMatch && articleMatch[1].length > 200) {
      text = articleMatch[1];
    }

    // Convert structural tags into whitespace markers BEFORE the
    // tag-strip pass so paragraph breaks survive.
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/h[1-6]>/gi, '\n\n');
    text = text.replace(/<li\b[^>]*>/gi, '- ');
    text = text.replace(/<[^>]+>/g, '');

    // Named entities — small whitelist; numeric refs handled below.
    const namedEntities = {
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
      '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'",
      '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
    };
    for (const [k, v] of Object.entries(namedEntities)) {
      text = text.replace(new RegExp(k, 'g'), v);
    }
    text = text.replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; }
    });
    text = text.replace(/&#x([\da-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; }
    });

    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.trim();

    return title ? `# ${title}\n\n${text}` : text;
  }

  // Recover article content from SPA state blobs that frameworks ship
  // inline in the static HTML — Next.js (`__NEXT_DATA__`), Nuxt 3
  // (`__NUXT_DATA__`), Apollo (`__APOLLO_STATE__`), and similar. Most
  // doc sites that look "JS-rendered" actually have the full page text
  // in one of these blobs already; we just have to walk the JSON.
  //
  // Strategy: find a known script id, parse the JSON, walk it deeply,
  // collect every string value with newlines (a strong signal of prose
  // content vs. metadata), dedupe, and join. Returns null if nothing
  // useful surfaces.
  _extractFromStateBlob(html) {
    const scriptIds = [
      '__NEXT_DATA__',         // Next.js (react.dev, Vercel docs)
      '__NUXT_DATA__',         // Nuxt 3
      '__APOLLO_STATE__',      // Apollo Client
      '__INITIAL_STATE__',     // Vue / Vuex SSR
      '__INITIAL_PROPS__',     // misc SSR
      '__REDUX_STATE__',       // Redux SSR
    ];
    let json = null;
    for (const id of scriptIds) {
      const re = new RegExp(`<script\\b[^>]*\\bid=["']?${id}["']?[^>]*>([\\s\\S]*?)<\\/script>`, 'i');
      const m = html.match(re);
      if (m && m[1]) {
        try {
          json = JSON.parse(m[1].trim());
          break;
        } catch { /* keep trying other ids */ }
      }
    }
    if (!json) return null;

    // Walk the JSON depth-first; collect string values that look like
    // prose. Heuristic: contains a newline OR is long-ish and contains
    // a sentence-ending punctuation. Skip URLs, hashes, and short
    // metadata strings (titles, slugs, author names).
    const collected = new Set();
    const walk = (v, depth) => {
      if (depth > 12) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s.length < 60) return;
        if (/^https?:\/\//.test(s)) return;
        if (/^[A-Fa-f0-9]{32,}$/.test(s)) return; // hash
        const looksLikeProse = s.includes('\n')
          || /[.!?]\s+[A-Z]/.test(s)
          || s.length > 200;
        if (looksLikeProse) collected.add(s);
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) walk(item, depth + 1);
        return;
      }
      if (v && typeof v === 'object') {
        for (const val of Object.values(v)) walk(val, depth + 1);
      }
    };
    try { walk(json, 0); } catch { /* JSON.parse'd it; walk shouldn't throw, but be safe */ }

    if (collected.size === 0) return null;
    // Sort by length descending — bigger blocks usually = the article body.
    return [...collected].sort((a, b) => b.length - a.length).join('\n\n');
  }

  // ── File I/O ─────────────────────────────────────────────────────────

  _readFileTool(input) {
    const { path: filePath, offset, limit } = input;
    const safe = this._safePath(filePath);
    if (safe.error) return safe;

    try {
      if (!fs.existsSync(safe.path)) return { error: `File not found: ${safe.path}` };
      const stat = fs.statSync(safe.path);
      if (stat.size > 512 * 1024) return { error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Use offset/limit params to read portions, or exec for binary inspection.` };

      // Reject binary files — check extension and content
      const binaryExts = /\.(mp3|mp4|wav|ogg|flac|aac|webm|avi|mkv|mov|png|jpg|jpeg|gif|bmp|webp|ico|svg|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|bin|dat|db|db-shm|db-wal|sqlite|wasm|ttf|otf|woff|woff2|pyc|class|o|a)$/i;
      if (binaryExts.test(safe.path)) {
        return { error: `Binary file detected (${safe.path.split('.').pop()}). Use exec to inspect binary files (e.g., file, xxd, ffprobe, mediainfo).` };
      }

      const buf = fs.readFileSync(safe.path);
      // Check for null bytes in first 8KB — strong binary indicator
      const sample = buf.subarray(0, Math.min(8192, buf.length));
      if (sample.includes(0)) {
        return { error: `Binary content detected in ${safe.path}. Use exec to inspect binary files.` };
      }

      let content = buf.toString('utf8');
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = offset || 0;
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return { content, path: safe.path, size: stat.size };
    } catch (e) {
      return { error: `Read failed: ${e.message}` };
    }
  }

  _writeFileTool(input) {
    const { path: filePath, content, append = false } = input;
    const safe = this._safePath(filePath, true);
    if (safe.error) return safe;

    // Guard: if the file already exists and is non-trivial, reject and
    // redirect to edit_file. This prevents multi-minute full-file rewrites
    // when a targeted edit would suffice.
    if (!append) {
      try {
        const existingStat = fs.statSync(safe.path);
        if (existingStat.size > 500) {
          return {
            error: `File "${safe.path}" already exists (${existingStat.size} bytes). Use edit_file to make targeted changes instead of rewriting the entire file. write_file should only be used for NEW files. If you truly need to replace everything, delete the file first with exec("rm path") then write_file.`,
          };
        }
      } catch (e) { this.log.warn('[tools] fs.statSync failed: ' + e.message); }
    }

    const guard = this._guardCredentialWrite(safe.path, content);
    if (guard?.error) return { error: guard.error };

    try {
      const dir = path.dirname(safe.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (append) {
        fs.appendFileSync(safe.path, content, 'utf8');
      } else {
        fs.writeFileSync(safe.path, content, 'utf8');
      }

      const result = { success: true, path: safe.path, bytes: Buffer.byteLength(content) };
      if (guard?.warning) result.security_warning = guard.warning;
      return result;
    } catch (e) {
      return { error: `Write failed: ${e.message}` };
    }
  }

  _checkForExposedKeys(filePath, content) {
    if (typeof content !== 'string' || !content) return null;

    const patterns = [
      { re: /(?:sk-|sk-proj-)[A-Za-z0-9_-]{20,}/g, name: 'OpenAI/Anthropic key' },
      { re: /(?:key-)[A-Fa-f0-9]{32,}/g, name: 'API key (key-prefix)' },
      { re: /(?:Bearer\s+)[A-Za-z0-9_.-]{30,}/g, name: 'Bearer token' },
      { re: /['"][A-Za-z0-9_]{2,}(?:_API_KEY|_SECRET|_TOKEN)\s*['"]:\s*['"][A-Za-z0-9_.\-]{16,}['"]/gi, name: 'hardcoded credential' },
      { re: /(?:api[_-]?key|apikey|secret|token|password|auth)\s*[:=]\s*['"][A-Za-z0-9_.\-/+]{20,}['"]/gi, name: 'inline credential' },
    ];

    const found = [];
    for (const { re, name } of patterns) {
      const matches = content.match(re);
      if (matches) found.push({ type: name, count: matches.length });
    }

    // Also check if any known env var values appear verbatim
    const SENSITIVE = /KEY|TOKEN|SECRET|PASS|AUTH/i;
    for (const [k, v] of Object.entries(process.env)) {
      if (!SENSITIVE.test(k) || !v || v.length < 16) continue;
      if (content.includes(v)) {
        found.push({ type: `env:${k}`, count: 1 });
      }
    }

    if (found.length === 0) return null;
    return found.map(f => `${f.type} (×${f.count})`).join(', ');
  }

  // Decides what to do about a write whose content matched _checkForExposedKeys.
  // Returns null to allow, { warning } to allow with a note, { error } to block.
  _guardCredentialWrite(filePath, content) {
    if (this._credentialGuardMode === 'off') return null;
    const summary = this._checkForExposedKeys(filePath, content);
    if (!summary) return null;
    const advice = `Possible exposed credentials in ${filePath}: ${summary}. ` +
      'API keys in writable files can be stolen or accidentally committed. Two secure alternatives: ' +
      '(1) call web_fetch with the credential parameter for server-side API calls; ' +
      '(2) for webapp frontend calls, write /workspace/web/.api-proxy.json with $VAULT:KEY_NAME headers and call /api/proxy/<route> — keys are injected server-side from the vault.';
    if (this._credentialGuardMode === 'warn') {
      this.log.warn(`[security] ${advice}`);
      return { warning: `⚠️ SECURITY: ${advice}` };
    }
    this.log.warn(`[security] Refused write: ${advice}`);
    return { error: `Refused to write ${filePath}: ${summary}. ${advice} Set SPORE_CREDENTIAL_GUARD=warn to override or SPORE_CREDENTIAL_GUARD=off to disable.` };
  }

  _editFileTool(input) {
    const { path: filePath, old_text, new_text, all = false } = input;
    const safe = this._safePath(filePath, true);
    if (safe.error) return safe;

    try {
      if (!fs.existsSync(safe.path)) return { error: `File not found: ${safe.path}` };
      const content = fs.readFileSync(safe.path, 'utf8');

      if (!content.includes(old_text)) {
        const preview = old_text.split('\n')[0].substring(0, 60);
        return { error: `old_text not found in file. First line searched: "${preview}". File has ${content.split('\n').length} lines. Use read_file to check the exact content.` };
      }

      const count = content.split(old_text).length - 1;
      if (count > 1 && !all) {
        return { error: `old_text matches ${count} locations. Add more surrounding context to match uniquely, or set all:true.` };
      }

      const updated = all ? content.replaceAll(old_text, new_text) : content.replace(old_text, new_text);
      const guard = this._guardCredentialWrite(safe.path, updated);
      if (guard?.error) return { error: guard.error };
      fs.writeFileSync(safe.path, updated, 'utf8');
      const result = { success: true, path: safe.path, replacements: all ? count : 1 };
      if (guard?.warning) result.security_warning = guard.warning;
      return result;
    } catch (e) {
      return { error: `Edit failed: ${e.message}` };
    }
  }

  // ── Search tools (server-side fallback for non-CLI sessions) ──────
  // For acorn sessions, the CLI claims grep+glob locally and runs them
  // in Go (see spore-code/internal/tools/search.go). These handlers
  // are the server-side path used when there's no CLI or the CLI is
  // disconnected. Mirrors the Go implementation's caps and noise-dir
  // skip list for predictable cross-session behavior.

  _searchNoiseDirs() {
    return new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', 'target']);
  }

  _grepTool(input) {
    const pattern = (input.pattern || '').toString();
    if (!pattern) return { error: 'pattern is required' };
    const safe = this._safePath(input.path || (this.config.workspacePath || process.cwd()));
    if (safe.error) return safe;
    const root = safe.path;
    const fileGlob = (input.glob || input.type || '').toString();
    let re;
    try {
      const flags = input['-i'] ? 'i' : '';
      re = new RegExp(pattern, flags);
    } catch (e) {
      return { error: `Invalid regex: ${e.message}` };
    }
    const noise = this._searchNoiseDirs();
    const results = [];
    let truncated = false;
    const cap = 200;
    const lineCap = 200;

    const walk = (dir) => {
      if (results.length >= cap) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (results.length >= cap) { truncated = true; return; }
        const name = ent.name;
        if (ent.isDirectory()) {
          if (name.startsWith('.') || noise.has(name)) continue;
          walk(path.join(dir, name));
          continue;
        }
        if (!ent.isFile()) continue;
        if (fileGlob) {
          // Translate the glob to a RegExp the same way Go's
          // filepath.Match does for basic *, ?, [abc].
          const g = fileGlob.replace(/[.+^${}()|]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
          if (!new RegExp('^' + g + '$').test(name)) continue;
        }
        const full = path.join(dir, name);
        const rel = path.relative(root, full);
        let buf;
        try {
          const st = fs.statSync(full);
          if (st.size > 4 * 1024 * 1024) continue; // skip huge files like Go's 4MB scanner buf
          buf = fs.readFileSync(full);
        } catch { continue; }
        // Skip likely-binary
        const sample = buf.subarray(0, Math.min(8192, buf.length));
        if (sample.includes(0)) continue;
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            let t = lines[i];
            if (t.length > lineCap) t = t.substring(0, lineCap);
            results.push({ file: rel, line: i + 1, text: t });
            if (results.length >= cap) { truncated = true; return; }
          }
        }
      }
    };
    walk(root);
    const out = { results, count: results.length };
    if (truncated) out.truncated = true;
    return out;
  }

  _globTool(input) {
    const pattern = (input.pattern || '*').toString();
    const safe = this._safePath(input.path || (this.config.workspacePath || process.cwd()));
    if (safe.error) return safe;
    const root = safe.path;
    const noise = this._searchNoiseDirs();
    // Same glob → regex translation as _grepTool. Match against either the
    // basename or the path-relative-to-root, mirroring the Go impl.
    const g = pattern.replace(/[.+^${}()|]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp('^' + g + '$');
    const matches = [];
    const cap = 500;
    const walk = (dir) => {
      if (matches.length >= cap) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (matches.length >= cap) return;
        const name = ent.name;
        if (ent.isDirectory()) {
          if (name.startsWith('.') || noise.has(name)) continue;
          walk(path.join(dir, name));
          continue;
        }
        const full = path.join(dir, name);
        const rel = path.relative(root, full);
        if (re.test(rel) || re.test(name)) matches.push(rel);
      }
    };
    walk(root);
    return { matches, count: matches.length };
  }

  _isFrameworkFile(resolved) {
    const frameworkPattern = /^\/app\/(agent|discord|context|tools|config|sessions|learner|feed|gateway|maintainer|embedder|spore)\.(js|json)$/;
    if (frameworkPattern.test(resolved)) return true;
    if (resolved === '/app/.env') return true;
    return false;
  }

  _safePath(p, isWrite = false) {
    if (!p) return { error: 'Path required' };
    const resolved = path.resolve(p);

    // Resolve symlinks to prevent traversal via symlink chains
    let realResolved = resolved;
    try {
      if (fs.existsSync(resolved)) realResolved = fs.realpathSync(resolved);
    } catch (e) { this.log.warn('[tools] fs.existsSync failed: ' + e.message); }

    // Block all .env files anywhere
    const basename = path.basename(realResolved);
    if (basename === '.env' || basename === '.spore-users.json') {
      return { error: 'Access denied: protected file' };
    }

    // Allowlist: only these directories are accessible
    const workspace = this.config.workspacePath || process.cwd();
    const hostPaths = (this.config.hostReadPaths || []).map(hp => `/host${hp}`);
    const extraPaths = this.config.extraPaths || [];
    const allowedRead = [workspace, '/app', '/tmp', '/data', ...hostPaths, ...extraPaths];
    const allowedWrite = [workspace, '/tmp', '/app/static', ...extraPaths];

    const targets = isWrite ? allowedWrite : allowedRead;
    const allowed = targets.some(prefix => realResolved.startsWith(prefix));
    if (!allowed) {
      return { error: `Access denied: ${resolved} is outside allowed paths` };
    }

    if (isWrite && this._isFrameworkFile(resolved)) {
      if (this.config.srcEditable) return { path: resolved };
      const trigger = this._ctx?.()?.trigger ?? this._currentTrigger;
      if (!trigger || trigger === 'lull') {
        return { error: `Blocked: cannot modify framework file ${resolved} during a ${trigger || 'background'} trigger. Self-modification is only allowed when a user directly asks. (To enable persistent self-modification, set SPORE_SRC_EDITABLE=true and bind-mount src/.)` };
      }
    }
    return { path: resolved };
  }

  // ── Session Tools ────────────────────────────────────────────────────

  _sessionStatusTool() {
    const sessions = this._sessions;
    const learner = this.learner;
    return {
      uptime: Math.floor(process.uptime()),
      model: this.config.model,
      learnerModel: this.config.learnerModel,
      learnerStats: learner?.getStats() || {},
      graphNodes: this._countGraphNodes(),
      activeSessions: sessions?.listSessions?.()?.length || 0,
      memoryMb: Math.round(process.memoryUsage.rss?.() || process.memoryUsage().rss / 1024 / 1024),
    };
  }

  _sessionsListTool() {
    const sessions = this._sessions;
    if (!sessions) return { error: 'Session manager not available' };
    const list = sessions.listSessions();
    return {
      sessions: list.map(s => ({
        key: s.key,
        messageCount: s.message_count,
        lastActive: s.updated,
      })),
      total: list.length,
    };
  }

  /**
   * Switch the active knowledge graph across all components.
   * Closes existing DB connections, updates config, re-initializes.
   */
  switchGraph(slug) {
    const registry = this._graphRegistry;
    if (!registry) throw new Error('Multi-graph registry not available');

    const entry = registry.get(slug);
    if (!entry) throw new Error(`Graph "${slug}" not found`);

    // Save stats for the current graph before switching
    const currentSlug = registry.getActiveSlug();
    if (currentSlug) registry.refreshStats(currentSlug);

    // Close existing connections
    try { this.graph?.db?.close(); } catch { /* silent: best-effort close */ }
    try { this.learner?.db?.close(); } catch { /* silent: best-effort close */ }

    // Close feed.js module-level DB
    try {
      const feed = require('../graph/feed');
      if (feed._closeDb) feed._closeDb();
    } catch (e) { this.log.warn('[tools] require failed: ' + e.message); }

    // Update registry active pointer
    registry.setActive(slug);
    const newDbPath = registry.getActiveDbPath();

    // Update config and env
    this.config.graphDbPath = newDbPath;
    process.env.GRAPH_DB_PATH = newDbPath;

    // Re-init graph context
    this.graph.config = this.config;
    this.graph._stmts = {};
    this.graph._cache = {};
    this.graph._cacheTimestamp = 0;
    this.graph._graphMtime = 0;
    this.graph._staticPromptCache = null;
    this.graph.init();

    // Re-init learner
    if (this.learner) {
      this.learner.config = this.config;
      this.learner.init();
    }

    this.log.info(`[multi-graph] Switched to graph "${entry.name}" (${slug}) at ${newDbPath}`);
    return { slug, name: entry.name, dbPath: newDbPath };
  }

  _countGraphNodes() {
    try {
      return this.graph?.db?.prepare('SELECT COUNT(*) as c FROM nodes').get()?.c || 0;
    } catch { return 0; }
  }

  // ── Web Server ──────────────────────────────────────────────────────

  async _envManageTool({ action, key, value }) {
    // Vault actions: route through manager
    if (action === 'vault_list' || action === 'vault_get') {
      return this._vaultEnvAction(action, key);
    }

    const SENSITIVE = /KEY|SECRET|TOKEN|PASS|CREDENTIALS/i;
    const SPORE_VARS = /^(SPORE_|ANTHROPIC_|OPENAI_|DEEPGRAM_|ELEVENLABS_|XI_|DISCORD_|SLACK_|TELEGRAM_|GOOGLE_|GEMINI_|REPLICATE_|STABILITY_|FAL_|TOGETHER_|BRAVE_|SEARXNG_|PERPLEXITY_|GROQ_|MISTRAL_|COHERE_|HUGGINGFACE_)/;

    const maskValue = (k, v) => {
      if (!v) return '(not set)';
      if (SENSITIVE.test(k) && v.length > 8) return v.slice(0, 4) + '***' + v.slice(-3);
      return v;
    };

    if (action === 'list') {
      const vars = [];
      const INCLUDE_ALWAYS = /^(GRAPH_DB_PATH|SESSION_DB_PATH|NODE_ENV|AGENT_ID|SPORE_OWNER)$/;
      const ANY_KEY_PATTERN = /_API_KEY$|_TOKEN$|_SECRET$/;
      for (const [k, v] of Object.entries(process.env)) {
        if (SPORE_VARS.test(k) || INCLUDE_ALWAYS.test(k) || ANY_KEY_PATTERN.test(k)) {
          vars.push({ key: k, value: maskValue(k, v), isSet: !!v });
        }
      }
      vars.sort((a, b) => a.key.localeCompare(b.key));
      return { variables: vars, note: 'These are the currently loaded env vars. To change them persistently, use action "set" — changes are written to .env on disk and take effect after restart.' };
    }

    if (action === 'get') {
      if (!key) return { error: 'key required' };
      const v = process.env[key];
      return { key, found: v !== undefined, value: v !== undefined ? maskValue(key, v) : '(not set)',
        note: 'Value is masked for display. Use action "get_raw" to get the unmasked value for use in scripts. Never display raw keys to users.' };
    }

    if (action === 'get_raw') {
      if (!key) return { error: 'key required' };
      const v = process.env[key];
      if (v === undefined) return { key, found: false, value: null };
      const tmpPath = `/tmp/.env-${key}-${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, v, { mode: 0o600 });
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch { /* silent: best-effort cleanup */ } }, 300_000);
      } catch (e) { return { error: `Failed to write temp file: ${e.message}` }; }
      return { key, found: true, path: tmpPath,
        note: `Value written to ${tmpPath} (auto-deleted in 5 min). Read it in your script: $(cat ${tmpPath}). NEVER cat/read this file in a tool call — use it inline in exec commands.` };
    }

    if (action === 'set' || action === 'delete') {
      if (!key) return { error: 'key required' };
      if (action === 'set' && (value === undefined || value === null)) return { error: 'value required' };
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return { error: 'Invalid key — use UPPER_SNAKE_CASE' };

      const envPath = [path.join(this.config.dataDir, '.env'), path.join(__dirname, '..', '.env')].find(p => fs.existsSync(p));
      if (!envPath) {
        // No .env mounted — try writing to /data/.env as a sidecar config
        // The manager API is the canonical way to update persistent env
        if (action === 'set') process.env[key] = value;
        else delete process.env[key];
        return { ok: true, key, runtime_only: true, note: 'Updated in current process only. To persist: ask the operator to update the .env through the manager, or use anima_manage update_env if you have orchestrator access.' };
      }

      const raw = fs.readFileSync(envPath, 'utf8');
      const lines = raw.split('\n');
      let found = false;
      const result = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0 && trimmed.slice(0, eqIdx) === key) {
            found = true;
            if (action === 'set') result.push(`${key}=${value}`);
            continue;
          }
        }
        result.push(line);
      }
      if (action === 'set' && !found) result.push(`${key}=${value}`);
      fs.writeFileSync(envPath, result.join('\n'));

      if (action === 'set') process.env[key] = value;
      else delete process.env[key];

      this.log.info(`[env] ${action === 'set' ? 'Set' : 'Deleted'} ${key}`);
      return { ok: true, key, persisted: true, note: 'Written to .env and applied to current process. Full restart recommended for dependent services to pick up changes.' };
    }

    return { error: `Unknown action: ${action}` };
  }

  async _vaultEnvAction(action, key) {
    const managerUrl = this.config.managerUrl;
    const serviceKey = this.config.managerServiceKey;
    if (!managerUrl || !serviceKey) {
      return { error: 'Vault unavailable — MANAGER_URL or MANAGER_SERVICE_KEY not configured' };
    }

    if (action === 'vault_list') {
      return new Promise((resolve) => {
        const proto = managerUrl.startsWith('https') ? https : http;
        const req = proto.get(`${managerUrl}/api/vault/list`, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': this.config.agentId || 'unknown' },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) { resolve({ error: parsed.error }); return; }
              const keys = (parsed.keys || []).map(k => ({
                name: k.name, scope: k.scope, description: k.description,
              }));
              resolve({ keys, note: 'These are vault keys stored on the manager. Use vault_get to retrieve a key, or use web_fetch with credential parameter for API calls.' });
            } catch { resolve({ error: 'Failed to parse vault response' }); }
          });
        });
        req.on('error', (e) => resolve({ error: `Vault request failed: ${e.message}` }));
      });
    }

    if (action === 'vault_get') {
      if (!key) return { error: 'key required for vault_get' };
      return new Promise((resolve) => {
        const proto = managerUrl.startsWith('https') ? https : http;
        const reqUrl = `${managerUrl}/api/vault/key?name=${encodeURIComponent(key)}`;
        const req = proto.get(reqUrl, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': this.config.agentId || 'unknown' },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) { resolve({ error: parsed.error }); return; }
              const tmpPath = `/tmp/.vault-${key}-${Date.now()}`;
              try {
                fs.writeFileSync(tmpPath, parsed.value, { mode: 0o600 });
                setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch { /* silent: best-effort cleanup */ } }, 300_000);
              } catch (e) { resolve({ error: `Failed to write temp file: ${e.message}` }); return; }
              resolve({ key, found: true, path: tmpPath,
                note: `Vault key written to ${tmpPath} (auto-deleted in 5 min). Read it in your script: $(cat ${tmpPath}). PREFERRED: use web_fetch with credential:"${key}" to make authenticated API calls without handling keys directly.` });
            } catch { resolve({ error: 'Failed to parse vault response' }); }
          });
        });
        req.on('error', (e) => resolve({ error: `Vault request failed: ${e.message}` }));
      });
    }

    return { error: `Unknown vault action: ${action}` };
  }

  async _browserTool(input) {
    if (!this._browserInstance) {
      const BrowserTool = require('./browser-tool');
      this._browserInstance = new BrowserTool(this.log, (data, isBinary) => {
        if (isBinary) {
          this.broadcastBinary(data);
        } else {
          this.broadcast(data);
        }
      }, this.config);
    }
    return await this._browserInstance.execute(input);
  }

  async _analyzeTool(input = {}) {
    const requestedKind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    if (requestedKind && requestedKind !== 'auto' && !['image', 'video', 'audio'].includes(requestedKind)) {
      return { error: `Invalid analyze kind "${input.kind}". Use image, video, audio, or omit it for auto detection.` };
    }
    if (requestedKind && requestedKind !== 'auto') {
      return this._analyzeMediaTool(requestedKind, input);
    }

    const resolvedTarget = this._resolveAnalyzeMediaAutoTarget(input.path);
    if (resolvedTarget.error) return resolvedTarget;
    return this._analyzeMediaTool(resolvedTarget.kind, {
      ...input,
      __resolved: resolvedTarget,
    });
  }

  async _analyzeMediaTool(kind, input = {}) {
    if (!this.llmClient) return { error: 'LLM client not available' };

    const configuredModel = kind === 'image'
      ? this.config.imageVlmModel
      : kind === 'video'
        ? this.config.videoVlmModel
        : this.config.audioVlmModel;
    if (!configuredModel) {
      const envName = kind === 'image'
        ? 'SPORE_IMAGE_VLM_MODEL'
        : kind === 'video'
          ? 'SPORE_VIDEO_VLM_MODEL'
          : 'SPORE_AUDIO_VLM_MODEL';
      return { error: `No ${envName} configured for ${kind} analysis.` };
    }

    const resolvedInput = input.__resolved && input.__resolved.kind === kind
      ? input.__resolved
      : this._resolveAnalyzeMediaPath(kind, input.path);
    if (resolvedInput.error) return resolvedInput;
    const safe = this._safePath(resolvedInput.path);
    if (safe.error) return safe;
    if (!fs.existsSync(safe.path)) return { error: `File not found: ${safe.path}` };

    const stat = fs.statSync(safe.path);
    if (!stat.isFile()) return { error: `Not a file: ${safe.path}` };
    if (stat.size > 25 * 1024 * 1024) {
      return { error: `File too large for multimodal analysis (${Math.round(stat.size / 1024 / 1024)} MB > 25 MB).` };
    }

    const mediaType = this._mediaTypeForPath(safe.path, kind);
    const prompt = String(input.prompt || this._defaultMediaAnalysisPrompt(kind)).trim();
    const maxTokens = Math.max(200, Math.min(Number(input.maxTokens) || 1200, 4000));
    const source = {
      type: 'base64',
      media_type: mediaType,
      data: fs.readFileSync(safe.path).toString('base64'),
      filename: path.basename(safe.path),
    };
    this.log.info(`[analyze_${kind}] requested=${input.path || '<latest>'} resolved=${safe.path} via=${resolvedInput.source} model=${configuredModel}`);

    try {
      const response = await this.llmClient.messages.create({
        model: configuredModel,
        max_tokens: maxTokens,
        system: `You are a specialized ${kind} analysis model assisting another agent. Analyze the provided ${kind} and answer the request directly. Be concrete and concise. Do not mention tool names, providers, or that you are a separate model.`,
        messages: [{
          role: 'user',
          content: [
            { type: kind, source },
            { type: 'text', text: prompt },
          ],
        }],
      });

      const analysis = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      return {
        kind,
        model: configuredModel,
        path: safe.path,
        requestedPath: input.path || null,
        pathSource: resolvedInput.source,
        mediaType,
        analysis,
        tokens_used: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
        },
      };
    } catch (e) {
      return { error: `${kind} analysis failed: ${e.message}` };
    }
  }

  _defaultMediaAnalysisPrompt(kind) {
    if (kind === 'image') return 'Describe the image and answer anything important a collaborating agent should know about it.';
    if (kind === 'video') return 'Summarize the video, notable scenes, actions, and any visible text or important events.';
    return 'Transcribe or summarize the audio, including speakers, tone, and any important details.';
  }

  _mediaTypeForPath(filePath, kind) {
    const ext = path.extname(filePath).toLowerCase();
    const mediaMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.avif': 'image/avif',
      '.heic': 'image/heic',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      '.webm': kind === 'video' ? 'video/webm' : 'audio/webm',
      '.aac': 'audio/aac',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
    };
    if (mediaMap[ext]) return mediaMap[ext];
    if (kind === 'image') return 'image/png';
    if (kind === 'video') return 'video/mp4';
    return 'audio/mpeg';
  }

  _analyzeMediaExtsByKind() {
    return {
      image: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic']),
      video: new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']),
      audio: new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.flac', '.webm', '.aac']),
    };
  }

  _detectAnalyzeMediaKind(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const extsByKind = this._analyzeMediaExtsByKind();
    if (extsByKind.image.has(ext)) return 'image';
    if (extsByKind.video.has(ext)) return 'video';
    if (extsByKind.audio.has(ext)) return 'audio';
    return null;
  }

  _resolveAnalyzeMediaPath(kind, requestedPath) {
    const cleanedPath = this._normalizeAnalyzeMediaPath(requestedPath);
    const extsByKind = this._analyzeMediaExtsByKind();
    const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
    const allowedExts = extsByKind[kind] || new Set();

    if (cleanedPath) {
      const exact = this._findAnalyzeMediaCandidate(cleanedPath, uploadDir, allowedExts);
      if (exact) return { path: exact, source: 'requested' };
    }

    const latest = this._latestUploadForKind(uploadDir, allowedExts);
    if (latest) {
      return {
        path: latest,
        source: cleanedPath ? 'latest_fallback' : 'latest',
      };
    }

    const noun = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio file';
    if (cleanedPath) {
      return { error: `Could not resolve ${noun} path "${cleanedPath}" and no matching uploads were found.` };
    }
    return { error: `No uploaded ${noun}s found in ${uploadDir}.` };
  }

  _resolveAnalyzeMediaAutoTarget(requestedPath) {
    const cleanedPath = this._normalizeAnalyzeMediaPath(requestedPath);
    const uploadDir = path.join(this.config.workspacePath || process.cwd(), 'uploads');
    const extsByKind = this._analyzeMediaExtsByKind();

    if (cleanedPath) {
      for (const kind of ['image', 'video', 'audio']) {
        const candidate = this._findAnalyzeMediaCandidate(cleanedPath, uploadDir, extsByKind[kind]);
        if (candidate) return { kind, path: candidate, source: 'requested' };
      }
    }

    const latest = this._latestUploadAny(uploadDir, extsByKind);
    if (latest) {
      return {
        kind: latest.kind,
        path: latest.path,
        source: cleanedPath ? 'latest_fallback' : 'latest',
      };
    }

    if (cleanedPath) {
      return { error: `Could not resolve media path "${cleanedPath}" and no matching uploads were found.` };
    }
    return { error: `No uploaded media files found in ${uploadDir}.` };
  }

  _normalizeAnalyzeMediaPath(value) {
    if (typeof value !== 'string') return '';
    let cleaned = value.trim();
    if (!cleaned) return '';
    cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '');
    cleaned = cleaned.replace(/[)>.,;:!?]+$/g, '');
    cleaned = cleaned.replace(/[\r\n\t]/g, '');
    cleaned = cleaned.replace(/\/+/g, '/');
    const tailTrimmed = cleaned.length >= 2 && cleaned[cleaned.length - 1] === cleaned[cleaned.length - 2]
      ? cleaned.slice(0, -1)
      : cleaned;
    return tailTrimmed;
  }

  _findAnalyzeMediaCandidate(requestedPath, uploadDir, allowedExts) {
    const maybeExact = this._safePath(requestedPath);
    if (!maybeExact.error && fs.existsSync(maybeExact.path) && fs.statSync(maybeExact.path).isFile()) {
      if (!allowedExts.size || allowedExts.has(path.extname(maybeExact.path).toLowerCase())) {
        return maybeExact.path;
      }
    }

    const basename = path.basename(requestedPath);
    if (!basename || !fs.existsSync(uploadDir)) return null;

    const entries = fs.readdirSync(uploadDir)
      .map(name => path.join(uploadDir, name))
      .filter(filePath => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      })
      .filter(filePath => !allowedExts.size || allowedExts.has(path.extname(filePath).toLowerCase()));

    const exactBasename = entries.find(filePath => path.basename(filePath) === basename);
    if (exactBasename) return exactBasename;

    const prefixBasename = entries.find(filePath => path.basename(filePath).startsWith(basename));
    if (prefixBasename) return prefixBasename;

    const suffixBasename = entries.find(filePath => path.basename(filePath).endsWith(basename));
    if (suffixBasename) return suffixBasename;

    return null;
  }

  _latestUploadForKind(uploadDir, allowedExts) {
    if (!fs.existsSync(uploadDir)) return null;
    const candidates = fs.readdirSync(uploadDir)
      .map(name => path.join(uploadDir, name))
      .filter(filePath => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      })
      .filter(filePath => !allowedExts.size || allowedExts.has(path.extname(filePath).toLowerCase()))
      .map(filePath => {
        try { return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.filePath || null;
  }

  _latestUploadAny(uploadDir, extsByKind) {
    if (!fs.existsSync(uploadDir)) return null;
    const candidates = fs.readdirSync(uploadDir)
      .map(name => path.join(uploadDir, name))
      .filter(filePath => {
        try { return fs.statSync(filePath).isFile(); } catch { return false; }
      })
      .map(filePath => {
        try {
          const stat = fs.statSync(filePath);
          const kind = this._detectAnalyzeMediaKind(filePath);
          if (!kind) return null;
          if (!extsByKind[kind]?.has(path.extname(filePath).toLowerCase())) return null;
          return { filePath, kind, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!candidates[0]) return null;
    return { path: candidates[0].filePath, kind: candidates[0].kind };
  }

  broadcast(msg) {
    this.gateway?.broadcast(msg);
  }

  broadcastBinary(buffer) {
    this.gateway?.broadcastBinary(buffer);
  }

  _webServeTool({ action, dir, command, command_dir }) {
    if (!this.gateway) {
      const { WebGateway } = require('../gateways/web');
      this.gateway = new WebGateway(this);
    }
    return this.gateway.handleAction(action, dir, { command, commandDir: command_dir });
  }

  get _webServer() { return this.gateway?._server || null; }
  get _wss() { return this.gateway?._wss || null; }
  get _webServerDir() { return this.gateway?._serverDir || null; }

  async handleHttp(req, res) {
    return false;
  }

  _ensureSSHManager() {
    if (this.gateway?._sshManager) return this.gateway._sshManager;
    if (this._sshManager) return this._sshManager;
    try {
      const { SSHManager } = require('./ssh-manager');
      this._sshManager = new SSHManager(this.config, this.log);
      if (this.gateway) this.gateway._sshManager = this._sshManager;
      return this._sshManager;
    } catch (e) {
      this.log.warn(`[ssh] SSHManager init failed: ${e.message}`);
      return null;
    }
  }

  _saveToolTool(input) {
    const { name, description, script, language = 'node', usage } = input;
    if (!name || !script) return { error: 'name and script are required' };

    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeName || safeName.startsWith('.')) return { error: 'Invalid tool name — must contain only alphanumeric, hyphens, and underscores' };

    const baseDir = this.config.workspacePath || process.cwd();
    const toolsDir = path.join(baseDir, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });

    const extMap = { bash: '.sh', python: '.py', node: '.js' };
    const ext = extMap[language] || '.js';
    const scriptPath = path.join(toolsDir, `${safeName}${ext}`);
    if (!path.resolve(scriptPath).startsWith(path.resolve(toolsDir))) {
      return { error: 'Invalid tool name — path traversal detected' };
    }
    fs.writeFileSync(scriptPath, script);
    if (language === 'bash' || language === 'python') fs.chmodSync(scriptPath, '755');

    const registryPath = path.join(toolsDir, 'TOOLS_REGISTRY.json');
    let registry = {};
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { /* silent: malformed JSON → fallback */ }

    const ws = this.config.workspacePath || process.cwd();
    const venvPython = path.join(ws, '.venv/bin/python3');
    const runCmd = language === 'python'
      ? `${venvPython} ${scriptPath}`
      : language === 'bash' ? `bash ${scriptPath}` : `node ${scriptPath}`;
    const entry = { name: safeName, description, language, path: scriptPath, usage: usage || `exec: ${runCmd}`, createdAt: new Date().toISOString() };
    registry[safeName] = entry;
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Persist to graph so tools are discoverable, visible in the constellation, and shareable
    this._upsertToolNode(safeName, description, language, scriptPath, usage || runCmd);

    return { saved: true, name: safeName, path: scriptPath, run: `exec: ${runCmd}`, graphNode: `tool-${safeName}` };
  }

  _upsertToolNode(name, description, language, scriptPath, usage) {
    const db = this.learner?.db;
    if (!db) return;

    try {
      const nodeId = `tool-${name}`;
      const existing = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);

      if (existing) {
        db.prepare('UPDATE nodes SET description = ?, updated = CURRENT_TIMESTAMP WHERE id = ?')
          .run(description || '', nodeId);
      } else {
        db.prepare(
          'INSERT INTO nodes (id, label, type, description, importance, mentions, extracted_with, extracted_at, provenance) VALUES (?, ?, ?, ?, 7, 1, ?, ?, ?)'
        ).run(nodeId, name, 'tool', description || '', 'save_tool', new Date().toISOString(), 'self');
      }

      // Upsert "tool_info" aspect with execution details
      let aspRow = db.prepare('SELECT id FROM aspects WHERE node_id = ? AND name = ?').get(nodeId, 'tool_info');
      if (!aspRow) {
        db.prepare('INSERT INTO aspects (node_id, name, weight, extracted_with) VALUES (?, ?, 8, ?)')
          .run(nodeId, 'tool_info', 'save_tool');
        aspRow = { id: db.prepare('SELECT last_insert_rowid() as id').get().id };
      }
      // Clear old attributes and replace with current info
      db.prepare('DELETE FROM attributes WHERE aspect_id = ?').run(aspRow.id);

      const attrs = [
        `Language: ${language}`,
        `Path: ${scriptPath}`,
        `Run: ${usage}`,
      ];
      if (description) attrs.unshift(description);
      for (const attr of attrs) {
        db.prepare('INSERT INTO attributes (aspect_id, content, importance, source) VALUES (?, ?, 7, ?)')
          .run(aspRow.id, attr, 'save_tool');
      }

      // Edge: agent → tool (has_tool)
      const agentId = this.config.agentId || 'spore';
      const edgeExists = db.prepare('SELECT rowid FROM edges WHERE source = ? AND target = ? AND type = ?')
        .get(agentId, nodeId, 'has_tool');
      if (!edgeExists) {
        const agentExists = db.prepare('SELECT id FROM nodes WHERE id = ?').get(agentId);
        if (agentExists) {
          db.prepare('INSERT INTO edges (source, target, type, weight) VALUES (?, ?, ?, 1)')
            .run(agentId, nodeId, 'has_tool');
        }
      }

      embedNodeAsync(nodeId, db);
      this.log.info(`[save_tool] Graph node upserted: ${nodeId}`);
      graphEvents.emit('change', { op: 'node:create', node: { id: nodeId, label: name, type: 'tool', description: description || '' }, source: 'save_tool' });
    } catch (e) {
      this.log.warn(`[save_tool] Graph upsert failed: ${e.message}`);
    }
  }

  _listCustomTools() {
    const baseDir = this.config.workspacePath || process.cwd();
    const registryPath = path.join(baseDir, 'tools', 'TOOLS_REGISTRY.json');
    if (!fs.existsSync(registryPath)) return { tools: [], hint: 'No custom tools yet. Use save_tool to create one.' };
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const tools = Object.values(registry);
      // Sync any tools missing from graph
      for (const t of tools) {
        this._upsertToolNode(t.name, t.description, t.language, t.path, t.usage);
      }
      return { tools, count: tools.length };
    } catch (e) { return { error: e.message }; }
  }

  _getCustomToolDefinitions() {
    const baseDir = this.config.workspacePath || process.cwd();
    const registryPath = path.join(baseDir, 'tools', 'TOOLS_REGISTRY.json');
    if (!fs.existsSync(registryPath)) return [];

    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const tools = Object.values(registry);
      if (tools.length === 0) return [];

      return [{
        name: 'list_custom_tools',
        description: `List custom tools you've created. Currently ${tools.length} registered: ${tools.map(t => t.name).join(', ')}. Run them via the exec tool.`,
        input_schema: { type: 'object', properties: {} },
      }];
    } catch { return []; }
  }

  // ── Remote SSH Tools ──────────────────────────────────────────────────

  _normalizeTmuxSessionName(name) {
    const prefix = (this.config.clusterTmuxPrefix || 'spore').replace(/[^a-zA-Z0-9_-]/g, '') || 'spore';
    const clean = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) return null;
    return clean.startsWith(prefix + '-') ? clean : `${prefix}-${clean}`;
  }

  _tmuxShellEscape(cmd) {
    // Escape single-quotes for wrapping inside sh -c '...'
    return String(cmd).replace(/'/g, `'\\''`);
  }

  async _remoteExecTool(input) {
    const { host, command, workdir, timeout, tmux_session, wait } = input;
    if (!host || !command) return { error: 'host and command are required' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };

    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(command)) {
        return { error: `Blocked: command matches dangerous pattern (${pattern.source})` };
      }
    }

    // tmux-session wrap: run inside a named tmux session so the command
    // survives SSH disconnects. wait=true (default) blocks until it exits
    // and captures the final pane; wait=false returns immediately with
    // the session name for later remote_tail.
    if (tmux_session) {
      const session = this._normalizeTmuxSessionName(tmux_session);
      if (!session) return { error: 'invalid tmux_session name' };
      const cdPrefix = workdir ? `cd ${String(workdir).replace(/[^\w/.\-~]/g, '')} && ` : '';
      const innerCmd = this._tmuxShellEscape(`${cdPrefix}${command}; echo "[spore-exit $?]"`);
      const shouldWait = wait !== false;

      // Launch detached, then optionally wait via polling
      const launch = `tmux new-session -d -s '${session}' 'sh -c '\\''${innerCmd}'\\'''`;
      try {
        const startRes = await mgr.remoteExec(host, `if tmux has-session -t '${session}' 2>/dev/null; then echo exists; else ${launch} && echo started; fi`, { cwd: workdir, timeout: Math.min(timeout || 30000, 60000) });
        const startStatus = (startRes.stdout || '').trim();
        if (!shouldWait) {
          return {
            tmux_session: session,
            status: startStatus || 'started-detached',
            note: `Session "${session}" is running on ${host}. Use remote_tail to read progress, remote_tmux_kill to stop.`,
          };
        }
        // Wait-for-completion: poll every 2s until the session exits or timeout
        const totalMs = Math.min(timeout || 120000, 120000);
        const started = Date.now();
        let exitLine = null;
        while (Date.now() - started < totalMs) {
          await new Promise(r => setTimeout(r, 2000));
          const check = await mgr.remoteExec(host, `tmux has-session -t '${session}' 2>/dev/null && echo alive || echo dead`, { timeout: 8000 });
          if ((check.stdout || '').trim() === 'dead') {
            // Session ended — capture last-pane via a short-lived "attach for read" trick:
            // We can't capture-pane on a dead session. So instead we captured at each poll below.
            break;
          }
          // Sample latest output
          const cap = await mgr.remoteExec(host, `tmux capture-pane -p -t '${session}' -S -50 2>/dev/null | tail -c 4000`, { timeout: 8000 });
          const tail = (cap.stdout || '').trim();
          const match = tail.match(/\[spore-exit (\d+)\]/);
          if (match) { exitLine = parseInt(match[1], 10); break; }
        }
        // Final capture (best-effort while session still exists)
        const final = await mgr.remoteExec(host, `tmux capture-pane -p -t '${session}' -S -500 2>/dev/null | tail -c 8000 || echo '(session already ended)'`, { timeout: 8000 });
        let output = (final.stdout || '').trim();
        if (output.length > 10000) output = output.slice(-10000);
        return {
          tmux_session: session,
          exitCode: exitLine,
          output: output || '(no output captured)',
          note: exitLine === null ? 'Session still running after timeout — use remote_tail to keep checking, or remote_tmux_kill to stop.' : undefined,
        };
      } catch (e) {
        return { error: `tmux remote_exec failed: ${e.message}`, tmux_session: session };
      }
    }

    // Non-tmux path (unchanged)
    try {
      const result = await mgr.remoteExec(host, command, { cwd: workdir, timeout });
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n--- stderr ---\n' : '') + result.stderr;
      if (output.length > 10000) output = output.substring(0, 10000) + '\n... (truncated)';
      return { exitCode: result.exitCode, output: output || '(no output)' };
    } catch (e) {
      return { error: e.message };
    }
  }

  async _remoteTailTool(input) {
    const { host, tmux_session, lines } = input;
    if (!host || !tmux_session) return { error: 'host and tmux_session are required' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };
    const session = this._normalizeTmuxSessionName(tmux_session);
    if (!session) return { error: 'invalid tmux_session name' };
    const n = Math.min(Math.max(1, Number(lines) || 200), 2000);
    try {
      const exists = await mgr.remoteExec(host, `tmux has-session -t '${session}' 2>/dev/null && echo alive || echo dead`, { timeout: 8000 });
      if ((exists.stdout || '').trim() === 'dead') {
        return { tmux_session: session, alive: false, note: 'Session not found — it may have finished and been cleaned up, or never existed.' };
      }
      const res = await mgr.remoteExec(host, `tmux capture-pane -p -t '${session}' -S -${n} 2>/dev/null | tail -c 10000`, { timeout: 10000 });
      let output = (res.stdout || '').trim();
      const exitMatch = output.match(/\[spore-exit (\d+)\]/);
      return {
        tmux_session: session,
        alive: true,
        exitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
        output: output || '(no output yet)',
      };
    } catch (e) {
      return { error: e.message, tmux_session: session };
    }
  }

  async _remoteTmuxKillTool(input) {
    const { host, tmux_session } = input;
    if (!host || !tmux_session) return { error: 'host and tmux_session are required' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };
    const session = this._normalizeTmuxSessionName(tmux_session);
    if (!session) return { error: 'invalid tmux_session name' };
    try {
      const res = await mgr.remoteExec(host, `tmux kill-session -t '${session}' 2>&1 && echo killed || echo 'not found'`, { timeout: 8000 });
      const msg = (res.stdout || '').trim();
      return { tmux_session: session, killed: msg.includes('killed'), output: msg };
    } catch (e) {
      return { error: e.message, tmux_session: session };
    }
  }

  // ── Email tools live in plugins/email/ — no inline implementation here ─

  async _remoteReadFileTool(input) {
    const { host, path: filePath, offset, limit } = input;
    if (!host || !filePath) return { error: 'host and path are required' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };

    try {
      const buf = await mgr.sftpReadFile(host, filePath, { maxBytes: 512 * 1024 });
      let content = buf.toString('utf8');
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = offset || 0;
        const end = limit ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return { content, path: filePath, host };
    } catch (e) {
      return { error: e.message };
    }
  }

  async _remoteWriteFileTool(input) {
    const { host, path: filePath, content, append } = input;
    if (!host || !filePath || content === undefined) return { error: 'host, path, and content are required' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };

    const guard = this._guardCredentialWrite(`${host}:${filePath}`, content);
    if (guard?.error) return { error: guard.error };

    try {
      if (append) {
        let existing = '';
        try {
          const buf = await mgr.sftpReadFile(host, filePath, { maxBytes: 10 * 1024 * 1024 });
          existing = buf.toString('utf8');
        } catch (e) { this.log.warn('[tools] mgr.sftpReadFile failed: ' + e.message); }
        await mgr.sftpWriteFile(host, filePath, existing + content);
      } else {
        await mgr.sftpWriteFile(host, filePath, content);
      }
      const result = { ok: true, path: filePath, host, bytes: Buffer.byteLength(content, 'utf8') };
      if (guard?.warning) result.security_warning = guard.warning;
      return result;
    } catch (e) {
      return { error: e.message };
    }
  }

  async _sshTunnelTool(input) {
    const { action, host, remoteHost, remotePort, localPort } = input;
    if (!action) return { error: 'action is required (create, close, or list)' };
    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };

    try {
      switch (action) {
        case 'create': {
          if (!host) return { error: 'host is required for create' };
          if (!remotePort) return { error: 'remotePort is required for create' };
          const result = await mgr.createTunnel(host, { remoteHost, remotePort, localPort });
          return { ok: true, ...result, hint: `Tunnel active. Set .app-port to ${result.localPort} to expose via web proxy, or use localhost:${result.localPort} internally.` };
        }
        case 'close': {
          if (!localPort) return { error: 'localPort is required for close' };
          const closed = mgr.closeTunnel(localPort);
          return closed ? { ok: true, closed: localPort } : { error: `No tunnel on port ${localPort}` };
        }
        case 'list':
          return { tunnels: mgr.listTunnels() };
        default:
          return { error: `Unknown action "${action}". Use create, close, or list.` };
      }
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── Startup Tasks ──────────────────────────────────────────────────────

  _startupTasksTool(input) {
    const TASKS_FILE = path.join(this.config.dataDir, '.startup-tasks.json');
    const LOG_DIR = path.join(this.config.workspacePath || process.cwd(), '.startup-logs');
    const { action, name, command, working_directory, delay_seconds, env: extraEnv } = input;

    const loadTasks = () => {
      try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
    };
    const saveTasks = (tasks) => {
      fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    };

    if (action === 'list') {
      const tasks = loadTasks();
      const running = this._startupRunning || {};
      return {
        tasks: tasks.map(t => ({
          ...t,
          status: running[t.name] ? 'running' : 'stopped',
          pid: running[t.name]?.pid || null,
        })),
        count: tasks.length,
        logDir: LOG_DIR,
      };
    }

    if (action === 'add') {
      if (!name || !command) return { error: 'name and command are required' };
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { error: 'name must be alphanumeric with hyphens/underscores only' };
      if (command.length > 2000) return { error: 'command too long (max 2000 chars)' };

      const tasks = loadTasks();
      const existing = tasks.findIndex(t => t.name === name);
      const maxStartupTasks = this.config.maxStartupTasks || 8;
      if (existing < 0 && tasks.length >= maxStartupTasks) {
        return { error: `Startup task limit reached (${tasks.length}/${maxStartupTasks}). Remove an existing task first.` };
      }
      const task = {
        name,
        command,
        workingDirectory: working_directory || this.config.workspacePath || process.cwd(),
        delaySeconds: Math.max(0, delay_seconds || 15),
        env: extraEnv || {},
        addedAt: new Date().toISOString(),
      };

      if (existing >= 0) {
        tasks[existing] = { ...task, addedAt: tasks[existing].addedAt, updatedAt: new Date().toISOString() };
      } else {
        tasks.push(task);
      }
      saveTasks(tasks);

      this._regenerateOnBootScript(tasks);

      this.log.info(`[startup-tasks] ${existing >= 0 ? 'Updated' : 'Added'} task "${name}": ${command}`);
      return {
        success: true,
        action: existing >= 0 ? 'updated' : 'added',
        task,
        hint: 'Task will auto-start on next container restart. Use action:"run" to start it now.',
      };
    }

    if (action === 'remove') {
      if (!name) return { error: 'name is required' };
      const tasks = loadTasks();
      const idx = tasks.findIndex(t => t.name === name);
      if (idx < 0) return { error: `No task named "${name}". Use action:"list" to see all tasks.` };

      // Kill if running
      const running = this._startupRunning || {};
      if (running[name]) {
        try { running[name].kill('SIGTERM'); } catch (e) { this.log.warn('[tools] kill failed: ' + e.message); }
        delete running[name];
      }

      tasks.splice(idx, 1);
      saveTasks(tasks);
      this._regenerateOnBootScript(tasks);

      this.log.info(`[startup-tasks] Removed task "${name}"`);
      return { success: true, removed: name, remaining: tasks.length };
    }

    if (action === 'run') {
      if (!name) return { error: 'name is required' };
      const tasks = loadTasks();
      const task = tasks.find(t => t.name === name);
      if (!task) return { error: `No task named "${name}". Use action:"add" first.` };

      return this._executeStartupTask(task);
    }

    return { error: `Unknown action "${action}". Use: add, remove, list, or run.` };
  }

  _executeStartupTask(task) {
    const LOG_DIR = path.join(this.config.workspacePath || process.cwd(), '.startup-logs');
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { this.log.warn('[tools] fs.mkdirSync failed: ' + e.message); }

    if (!this._startupRunning) this._startupRunning = {};

    // Kill existing process for this task name
    if (this._startupRunning[task.name]) {
      try { this._startupRunning[task.name].kill('SIGTERM'); } catch (e) { this.log.warn('[tools] kill failed: ' + e.message); }
      delete this._startupRunning[task.name];
    }

    const logFile = path.join(LOG_DIR, `${task.name}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n--- Task "${task.name}" started at ${new Date().toISOString()} ---\n`);
    logStream.write(`Command: ${task.command}\n`);
    logStream.write(`Working dir: ${task.workingDirectory}\n\n`);

    const childEnv = { ...process.env };
    // Strip sensitive vars from child env (same pattern as exec)
    const SENSITIVE = /KEY|TOKEN|SECRET|PASS|CREDENTIALS|AUTH/i;
    for (const k of Object.keys(childEnv)) {
      if (SENSITIVE.test(k)) delete childEnv[k];
    }
    // Apply task-specific env
    if (task.env) Object.assign(childEnv, task.env);

    const { spawn } = require('child_process');
    const child = spawn('sh', ['-c', task.command], {
      cwd: task.workingDirectory || this.config.workspacePath || process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    child.on('exit', (code, signal) => {
      logStream.write(`\n--- Exited: code=${code} signal=${signal} at ${new Date().toISOString()} ---\n`);
      logStream.end();
      this._trackedPids.delete(child.pid);
      if (this._startupRunning && this._startupRunning[task.name]?.pid === child.pid) {
        delete this._startupRunning[task.name];
      }
      this.log.info(`[startup-tasks] Task "${task.name}" exited (code=${code}, signal=${signal})`);
    });

    child.on('error', (err) => {
      logStream.write(`\n--- Error: ${err.message} ---\n`);
      logStream.end();
      this._trackedPids.delete(child.pid);
      this.log.warn(`[startup-tasks] Task "${task.name}" spawn error: ${err.message}`);
    });

    child.unref();
    this._startupRunning[task.name] = child;
    this._trackedPids.add(child.pid);

    this.log.info(`[startup-tasks] Started "${task.name}" (pid ${child.pid})`);
    return {
      success: true,
      started: task.name,
      pid: child.pid,
      logFile,
    };
  }

  _regenerateOnBootScript(tasks) {
    const wsDir = this.config.workspacePath || process.cwd();
    const ON_BOOT = path.join(wsDir, '.on-boot.sh');
    const HEADER = '#!/bin/sh\n# Auto-generated by startup_tasks tool — do not edit manually\n# Edits will be overwritten. Use the startup_tasks tool to manage tasks.\n\n';

    if (!tasks || tasks.length === 0) {
      try { fs.writeFileSync(ON_BOOT, HEADER + 'echo "[on-boot] No startup tasks configured"\n'); } catch (e) { this.log.warn('[tools] fs.writeFileSync failed: ' + e.message); }
      return;
    }

    let script = HEADER;
    script += `LOG_DIR="${path.join(wsDir, '.startup-logs')}"\nmkdir -p "$LOG_DIR"\n\n`;

    for (const task of tasks) {
      const envStr = task.env ? Object.entries(task.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : '';
      const delay = task.delaySeconds || 15;
      script += `# Task: ${task.name}\n`;
      script += `(\n`;
      script += `  sleep ${delay}\n`;
      script += `  echo "[on-boot] Starting ${task.name} at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_DIR/${task.name}.log"\n`;
      script += `  cd ${JSON.stringify(task.workingDirectory || wsDir)}\n`;
      if (envStr) script += `  export ${envStr}\n`;
      script += `  ${task.command} >> "$LOG_DIR/${task.name}.log" 2>&1\n`;
      script += `  echo "[on-boot] ${task.name} exited ($?) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_DIR/${task.name}.log"\n`;
      script += `) &\n\n`;
    }

    script += `echo "[on-boot] Launched ${tasks.length} startup task(s)"\n`;

    try { fs.writeFileSync(ON_BOOT, script, { mode: 0o755 }); } catch (e) {
      this.log.warn(`[startup-tasks] Failed to write on-boot script: ${e.message}`);
    }
  }

  restoreStartupTasks() {
    const TASKS_FILE = path.join(this.config.dataDir, '.startup-tasks.json');
    let tasks;
    try {
      tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    } catch { return { restored: 0 }; }
    if (!Array.isArray(tasks) || tasks.length === 0) return { restored: 0 };

    let restored = 0;
    const errors = [];
    for (const task of tasks) {
      const delay = (task.delaySeconds || 15) * 1000;
      setTimeout(() => {
        try {
          const result = this._executeStartupTask(task);
          if (result.error) {
            this.log.warn(`[startup-tasks] Restore failed for "${task.name}": ${result.error}`);
          } else {
            this.log.info(`[startup-tasks] Restored "${task.name}" (pid ${result.pid})`);
          }
        } catch (e) {
          this.log.warn(`[startup-tasks] Restore error for "${task.name}": ${e.message}`);
        }
      }, delay);
      restored++;
    }

    this.log.info(`[startup-tasks] Scheduled ${restored} task(s) for delayed startup`);
    return { restored, total: tasks.length };
  }

  // ── Data Poller ───────────────────────────────────────────────────────

  async _dataPollerTool(input) {
    const { action, host, template, interval, pollerId } = input;
    if (!action) return { error: 'action is required (start, stop, list, or templates)' };

    const trigger = this._ctx?.()?.trigger ?? this._currentTrigger;
    if (action === 'start' && (!trigger || trigger === 'lull')) {
      return { error: 'Pollers can only be started during an active conversation (not during lull/background).' };
    }

    const mgr = this._ensureSSHManager();
    if (!mgr) return { error: 'SSH manager not available' };

    if (!this._dataPoller) {
      const { DataPoller } = require('./data-poller');
      const auditFn = mgr.audit ? mgr.audit.bind(mgr) : () => {};
      this._dataPoller = new DataPoller(mgr, this.log, auditFn, this.config.dataDir);
    }

    switch (action) {
      case 'templates':
        return { templates: this._dataPoller.getTemplates() };
      case 'list':
        return { pollers: this._dataPoller.list() };
      case 'stop': {
        if (!pollerId) return { error: 'pollerId is required for stop' };
        return this._dataPoller.stop(pollerId);
      }
      case 'start': {
        if (!host) return { error: 'host is required for start' };
        if (!template) return { error: 'template is required for start' };
        const webDir = this.gateway?._serverDir || path.join(this.config.workspacePath || process.cwd(), 'web');
        const intervalMs = (interval || 120) * 1000;
        return this._dataPoller.start(host, template, intervalMs, webDir);
      }
      default:
        return { error: `Unknown action "${action}". Use start, stop, list, or templates.` };
    }
  }

  // ── Webapp Request ──────────────────────────────────────────────────

  async _webappRequestTool(input) {
    const { method, path: reqPath, body, headers: extraHeaders, as_user } = input;
    if (!reqPath || !reqPath.startsWith('/')) return { error: 'path must start with /' };
    if (!this.gateway?._server) return { error: 'No webapp is currently hosted. Use web_serve first.' };

    const port = this.config.webPort;
    if (!port) return { error: 'webPort not configured' };

    // Resolve session cookie for the target user. Prefer AsyncLocalStorage
    // — without it, two web users hitting webapp_request concurrently
    // could swap session tokens (whoever wrote _currentSessionToken last
    // wins the singleton field), and the wrong user's cookies would be
    // sent on the proxied request.
    const _wctx = this._ctx?.() || {};
    const targetUser = as_user || _wctx.userName || this._currentUserName || 'operator';
    const sessionToken = _wctx.sessionToken ?? this._currentSessionToken;
    let cookieHeader = '';
    let authenticated = false;
    if (!as_user && sessionToken) {
      cookieHeader = `anima_session=${sessionToken}`;
      authenticated = true;
    } else {
      const sess = this.gateway.getSessionForUser(targetUser);
      if (sess) { cookieHeader = `${sess.cookieName}=${sess.sessionId}`; authenticated = true; }
    }

    const url = `http://127.0.0.1:${port}${reqPath}`;
    const fetchOpts = {
      method: method || 'GET',
      headers: {
        ...(extraHeaders || {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOpts.body = JSON.stringify(body);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timeout);

      const contentType = res.headers.get('content-type') || '';
      let responseBody;
      if (contentType.includes('application/json')) {
        try { responseBody = await res.json(); } catch { responseBody = await res.text(); }
      } else {
        responseBody = await res.text();
        if (responseBody.length > 8000) responseBody = responseBody.substring(0, 8000) + '\n... (truncated)';
      }

      return {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries([...res.headers.entries()].filter(([k]) =>
          ['content-type', 'content-length', 'x-request-id', 'location', 'set-cookie'].includes(k.toLowerCase())
        )),
        body: responseBody,
        authenticatedAs: authenticated ? targetUser : null,
      };
    } catch (e) {
      if (e.name === 'AbortError') return { error: 'Request timed out (15s)' };
      return { error: `Request failed: ${e.message}` };
    }
  }

  // ── Shared Skills tools ──

  _skillLookupTool(input) {
    const { action, slug, query, tags } = input;
    if (!action) return { error: 'action is required (list, search, or read)' };

    switch (action) {
      case 'list':
        return this.skills.list();
      case 'search':
        return this.skills.list(query, tags);
      case 'read':
        if (!slug) return { error: 'slug is required for action "read"' };
        return this.skills.read(slug);
      default:
        return { error: `Unknown action: ${action}. Use list, search, or read.` };
    }
  }

  _skillUpdateTool(input) {
    const { slug, title, tags, summary, content, mode } = input;
    const author = this.config.agentId || 'unknown';
    return this.skills.write(slug, { title, tags, author, summary, content, mode: mode || 'replace' });
  }

  // ── Orchestrator Tools (super agent only) ──────────────────────────

  async _managerFetch(path, method = 'GET', body = null) {
    const url = `${this.config.managerUrl}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.managerServiceKey) {
      headers['X-Service-Key'] = this.config.managerServiceKey;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    return resp.json();
  }

  async _animaListTool(input) {
    const data = await this._managerFetch('/api/animas');
    const list = data?.animas;
    if (!Array.isArray(list)) return { error: 'Failed to fetch spore list' };

    const results = [];
    for (const a of list) {
      const entry = { id: a.id, displayName: a.displayName, model: a.model, status: a.status };
      if (input.includeHealth !== false) {
        try {
          const health = await this._managerFetch(`/api/spores/${a.id}/health`);
          entry.health = health;
        } catch { entry.health = { status: 'unreachable' }; }
      }
      results.push(entry);
    }
    return { animas: results, count: results.length };
  }

  async _animaMessageTool(input) {
    const { target, message, context, timeout } = input;
    if (!target || !message) return { error: 'target and message are required' };

    const animaData = await this._managerFetch(`/api/spores/${target}`);
    if (animaData?.error) return { error: `Could not find spore "${target}": ${animaData.error}` };

    const healthPort = animaData.env?.SPORE_HEALTH_PORT || '18790';
    const invokeUrl = `http://${target}:${healthPort}/api/invoke`;

    const headers = { 'Content-Type': 'application/json' };
    if (this.config.managerServiceKey) {
      headers['X-Service-Key'] = this.config.managerServiceKey;
    }

    const myName = this.config.displayName || this.config.agentId || 'unknown-spore';

    try {
      const resp = await fetch(invokeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, context, timeout: timeout || 120, from: myName }),
        signal: AbortSignal.timeout((timeout || 120) * 1000 + 5000),
      });
      const result = await resp.json();
      return {
        target,
        response: result.response,
        model: result.model,
        duration: result.duration,
      };
    } catch (e) {
      return { error: `Failed to invoke ${target}: ${e.message}` };
    }
  }

  async _animaGraphTool(input) {
    const { target, mode } = input;
    if (!target) return { error: 'target is required' };

    if (mode === 'read') {
      const params = new URLSearchParams();
      if (input.query) params.set('query', input.query);
      if (input.nodeId) params.set('nodeId', input.nodeId);
      if (input.type) params.set('type', input.type);
      return await this._managerFetch(`/api/spores/${target}/graph?${params.toString()}`);
    }

    if (mode === 'write') {
      if (!input.nodeId) return { error: 'nodeId required for write mode' };
      return await this._managerFetch(`/api/spores/${target}/graph`, 'POST', {
        nodeId: input.nodeId,
        label: input.label,
        type: input.type,
        description: input.description,
        aspects: input.aspects,
        edges: input.edges,
      });
    }

    return { error: 'mode must be "read" or "write"' };
  }

  async _animaManageTool(input) {
    const { target, action } = input;
    if (!target || !action) return { error: 'target and action are required' };

    switch (action) {
      case 'health':
        return await this._managerFetch(`/api/spores/${target}/health`);
      case 'tokens':
        return await this._managerFetch(`/api/spores/${target}/tokens`);
      case 'logs':
        return await this._managerFetch(`/api/spores/${target}/logs?lines=50`);
      case 'restart':
        return await this._managerFetch(`/api/spores/${target}/restart`, 'POST', {
          rebuild: input.rebuild !== false,
        });
      case 'update_env':
        if (!input.env || typeof input.env !== 'object') return { error: 'env object required' };
        return await this._managerFetch(`/api/spores/${target}/env`, 'PUT', { env: input.env });
      case 'update_config':
        if (!input.config || typeof input.config !== 'object') return { error: 'config object required' };
        return await this._managerFetch(`/api/spores/${target}/config`, 'PUT', { config: input.config });
      default:
        return { error: `Unknown action: ${action}. Use: health, tokens, logs, restart, update_env, update_config` };
    }
  }

  // ── Phase 1: schedule_wakeup ──────────────────────────────────────
  _scheduleWakeupTool({ delaySeconds, prompt, reason }) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    if (!this._ctxSessionKey()) return { error: 'No active session to wake up' };
    const ctx = this._ctx();
    if (!ctx) return { error: 'No session context — cannot record wakeup' };
    const secs = Math.max(60, Math.min(Number(delaySeconds) || 60, 3600));
    const now = Date.now();
    const fireAt = now + secs * 1000;
    const p = String(prompt || '').trim();
    if (!p) return { error: 'prompt is required' };
    const info = sessions.db.prepare(
      `INSERT INTO wakeups (session_key, channel_id, channel_name, user_id, user_name, platform, is_dm, fire_at, prompt, reason, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      this._ctxSessionKey(),
      ctx.channelId || null, ctx.channelName || null,
      ctx.userId || null, ctx.userName || null,
      ctx.platform || 'web',
      ctx.isDm !== false ? 1 : 0,
      fireAt, p, String(reason || '').slice(0, 200), now,
    );
    this.log.info(`[wakeup] scheduled id=${info.lastInsertRowid} in ${secs}s for ${this._ctxSessionKey()}`);
    return { ok: true, wakeupId: info.lastInsertRowid, fireAt, delaySeconds: secs };
  }

  _listWakeupsTool() {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    const key = this._ctxSessionKey();
    if (!key) return { error: 'No active session' };
    const rows = sessions.db.prepare(
      'SELECT id, fire_at, prompt, reason, fired, fired_at, failed, error FROM wakeups WHERE session_key = ? ORDER BY fire_at ASC LIMIT 50'
    ).all(key);
    return { wakeups: rows };
  }

  _cancelWakeupTool({ wakeupId }) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    const id = Number(wakeupId);
    if (!Number.isFinite(id)) return { error: 'wakeupId required' };
    const row = sessions.db.prepare('SELECT session_key, fired FROM wakeups WHERE id=?').get(id);
    if (!row) return { error: 'Wakeup not found' };
    if (row.session_key !== this._ctxSessionKey()) return { error: 'Wakeup belongs to a different session' };
    if (row.fired) return { ok: true, alreadyFired: true };
    sessions.db.prepare('UPDATE wakeups SET fired=1, fired_at=?, error=? WHERE id=?')
      .run(Date.now(), 'cancelled', id);
    return { ok: true, cancelled: id };
  }

  // Called by app.js heartbeat. Fires due wakeups by either injecting into a
  // running session or starting a new processMessage turn. Mark fired BEFORE
  // invoking so a long processMessage can't cause double-fire on the next tick.
  async sweepWakeups() {
    const sessions = this._sessions;
    const agent = this._agent;
    if (!sessions?.db || !agent) return;
    const now = Date.now();
    const due = sessions.db.prepare(
      'SELECT * FROM wakeups WHERE fired=0 AND fire_at<=? ORDER BY fire_at ASC LIMIT 20'
    ).all(now);
    for (const row of due) {
      sessions.db.prepare('UPDATE wakeups SET fired=1, fired_at=? WHERE id=?').run(now, row.id);
      try {
        const opts = {
          content: row.prompt,
          channelId: row.channel_id || 'web:control-panel',
          channelName: row.channel_name || 'wakeup',
          userId: row.user_id || 'operator',
          userName: row.user_name || 'Wakeup',
          trigger: 'wakeup',
          platform: row.platform || 'web',
          isDm: row.is_dm === 1,
        };
        const key = row.session_key;
        if (agent.activeRuns?.has(key)) {
          this.log.info(`[wakeup] injecting into running session ${key} (id=${row.id})`);
          agent.interject(key, row.prompt);
        } else {
          this.log.info(`[wakeup] firing processMessage for ${key} (id=${row.id}, reason=${row.reason || ''})`);
          agent.processMessage(opts).catch(e => {
            sessions.db.prepare('UPDATE wakeups SET failed=1, error=? WHERE id=?')
              .run(String(e.message || e).slice(0, 500), row.id);
          });
        }
      } catch (e) {
        sessions.db.prepare('UPDATE wakeups SET failed=1, error=? WHERE id=?')
          .run(String(e.message || e).slice(0, 500), row.id);
      }
    }
  }

  // ── Phase 2: persistent task list ─────────────────────────────────
  _tasklistCreateTool({ subject, description, blockedBy, priority, id }) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    const subj = String(subject || '').trim();
    if (!subj) return { error: 'subject required' };
    const ctx = this._ctx() || {};
    const slug = (id || crypto.randomUUID()).toString().slice(0, 64);
    const now = Date.now();
    try {
      sessions.db.prepare(
        `INSERT INTO tasks (id, subject, description, status, owner, blocked_by, channel_id, session_key, user_id, priority, created, updated)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        slug, subj, String(description || ''), 'agent',
        JSON.stringify(Array.isArray(blockedBy) ? blockedBy : []),
        ctx.channelId || null, this._ctxSessionKey() || null, ctx.userId || null,
        Number.isFinite(priority) ? priority : 3,
        now, now,
      );
    } catch (e) {
      return { error: `Failed to create: ${e.message}` };
    }
    // Broadcast so clients (Spore Code in particular) can render a
    // live task-list side panel. sessionKey lets old/unscoped clients
    // filter — the acorn CLI listens for task:* frames and only
    // renders rows tagged with its own session.
    try {
      this.broadcast({
        type: 'task:create',
        id: slug,
        subject: subj,
        description: String(description || '').slice(0, 500),
        status: 'pending',
        priority: Number.isFinite(priority) ? priority : 3,
        blockedBy: Array.isArray(blockedBy) ? blockedBy : [],
        sessionKey: this._ctxSessionKey() || null,
        channelId: ctx.channelId || null,
      });
    } catch (e) { this.log.warn('[tools] broadcast failed: ' + e.message); }
    return { ok: true, id: slug };
  }

  _tasklistProgressTool({ id, status, result, note, blockedBy, priority }) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    if (!id) return { error: 'id required' };
    const row = sessions.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) return { error: `Task not found: ${id}` };
    const fields = [];
    const values = [];
    const now = Date.now();
    if (status) { fields.push('status=?'); values.push(status); if (['done', 'cancelled', 'error'].includes(status)) { fields.push('completed=?'); values.push(now); } }
    if (result != null) { fields.push('result=?'); values.push(String(result).slice(0, 8000)); }
    if (Array.isArray(blockedBy)) { fields.push('blocked_by=?'); values.push(JSON.stringify(blockedBy)); }
    if (Number.isFinite(priority)) { fields.push('priority=?'); values.push(priority); }
    fields.push('updated=?'); values.push(now);
    values.push(id);
    sessions.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id=?`).run(...values);
    if (note) {
      sessions.db.prepare('INSERT INTO task_comments (task_id, author, body, created) VALUES (?, ?, ?, ?)')
        .run(id, 'agent', String(note).slice(0, 4000), now);
    }
    // Broadcast a task:update frame. Payload mirrors the task:create
    // shape so the client can update its row in place. sessionKey
    // carried from the task row (not ctx) since task_progress can be
    // called for tasks created in a different context.
    try {
      this.broadcast({
        type: 'task:update',
        id,
        subject: row.subject,
        status: status || row.status,
        note: note ? String(note).slice(0, 500) : undefined,
        result: (result != null) ? String(result).slice(0, 500) : undefined,
        priority: Number.isFinite(priority) ? priority : row.priority,
        sessionKey: row.session_key || this._ctxSessionKey() || null,
        channelId: row.channel_id || null,
      });
    } catch (e) { this.log.warn('[tools] broadcast failed: ' + e.message); }
    // Cascade: if status flipped to done, unblock dependents whose remaining
    // blockers are all done. Cheap even on large task tables — we filter by
    // LIKE on the json column then re-check each candidate in JS.
    if (status === 'done') {
      const candidates = sessions.db.prepare(
        "SELECT id, blocked_by FROM tasks WHERE status='blocked' AND blocked_by LIKE ?"
      ).all(`%"${id}"%`);
      for (const cand of candidates) {
        try {
          const deps = JSON.parse(cand.blocked_by || '[]');
          if (!deps.length) continue;
          const q = sessions.db.prepare(`SELECT id, status FROM tasks WHERE id IN (${deps.map(() => '?').join(',')})`).all(...deps);
          if (q.every(r => r.status === 'done')) {
            sessions.db.prepare("UPDATE tasks SET status='pending', updated=? WHERE id=?").run(now, cand.id);
          }
        } catch (e) { this.log.warn('[tools] JSON.parse failed: ' + e.message); }
      }
    }
    return { ok: true };
  }

  _tasklistListTool({ status, sessionScope = 'session', limit = 50 } = {}) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    const clauses = [];
    const values = [];
    if (status) { clauses.push('status=?'); values.push(status); }
    else { clauses.push("status NOT IN ('done','cancelled')"); }
    if (sessionScope === 'session' && this._ctxSessionKey()) {
      clauses.push('session_key=?'); values.push(this._ctxSessionKey());
    } else if (sessionScope === 'owned') {
      const ctx = this._ctx() || {};
      if (ctx.userId) { clauses.push('user_id=?'); values.push(ctx.userId); }
    }
    const sql = `SELECT id, subject, status, owner, blocked_by, priority, created, updated, completed FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY priority ASC, created ASC LIMIT ?`;
    values.push(Math.max(1, Math.min(limit, 500)));
    const rows = sessions.db.prepare(sql).all(...values);
    // Compute blocked flag per row
    for (const r of rows) {
      try {
        const deps = JSON.parse(r.blocked_by || '[]');
        if (deps.length) {
          const placeholders = deps.map(() => '?').join(',');
          const others = sessions.db.prepare(`SELECT status FROM tasks WHERE id IN (${placeholders})`).all(...deps);
          r.blocked = others.some(o => o.status !== 'done');
        } else {
          r.blocked = false;
        }
      } catch { r.blocked = false; }
    }
    return { tasks: rows, count: rows.length };
  }

  _tasklistGetTool({ id }) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'Session manager not available' };
    if (!id) return { error: 'id required' };
    const row = sessions.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) return { error: `Task not found: ${id}` };
    const comments = sessions.db.prepare('SELECT author, body, created FROM task_comments WHERE task_id=? ORDER BY created ASC').all(id);
    try { row.blocked_by = JSON.parse(row.blocked_by || '[]'); } catch { row.blocked_by = []; }
    return { task: row, comments };
  }

  // ── Phase 3: log_watch ────────────────────────────────────────────
  async _logWatchTool({ path: logPath, match, tag, maxMatches, idleKillMs, timeoutMs }) {
    if (!this._ctxSessionKey()) return { error: 'No active session' };
    if (!logPath || !match) return { error: 'path and match required' };
    if (!this._activeLogWatches) this._activeLogWatches = new Map();
    const watchId = `lw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const sessionKey = this._ctxSessionKey();
    const opts = {
      maxMatches: Math.max(1, Math.min(Number(maxMatches) || 200, 5000)),
      idleKillMs: Math.max(10_000, Math.min(Number(idleKillMs) || 300_000, 24 * 3600 * 1000)),
      timeoutMs: Math.max(30_000, Math.min(Number(timeoutMs) || 3_600_000, 24 * 3600 * 1000)),
    };
    if (logPath.startsWith('ssh://')) {
      return { error: 'Remote (ssh://) log_watch is not implemented yet. For remote tails, pair remote_exec (with tmux_session) + remote_tail.' };
    }
    const cmd = `tail -n 0 -F -- ${_shellEscape(logPath)} | grep -E --line-buffered -- ${_shellEscape(match)}`;
    const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = {
      child, path: logPath, match, tag: String(tag || '').slice(0, 40),
      sessionKey, startedAt: Date.now(), matchCount: 0, lastMatchAt: null,
      pendingBatch: [], batchTimer: null,
      idleTimer: null, hardTimer: null, alive: true,
      maxMatches: opts.maxMatches, idleKillMs: opts.idleKillMs,
    };
    this._activeLogWatches.set(watchId, entry);
    const flushBatch = () => {
      if (!entry.pendingBatch.length) return;
      const lines = entry.pendingBatch;
      entry.pendingBatch = [];
      entry.batchTimer = null;
      const tagStr = entry.tag || entry.path;
      const body = lines.slice(0, 30).map(l => String(l).slice(0, 400)).join('\n');
      const extra = lines.length > 30 ? `\n…(+${lines.length - 30} more)` : '';
      const msg = `[log_watch ${tagStr}] ${lines.length} line(s):\n${body}${extra}`;
      try { this._agent?.interject?.(sessionKey, msg); } catch (e) { this.log.warn('[tools] this failed: ' + e.message); }
    };
    const resetIdleTimer = () => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => this.stopLogWatch(watchId, 'idle'), entry.idleKillMs);
    };
    resetIdleTimer();
    entry.hardTimer = setTimeout(() => this.stopLogWatch(watchId, 'timeout'), opts.timeoutMs);
    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (!line) continue;
        entry.matchCount++;
        entry.lastMatchAt = Date.now();
        entry.pendingBatch.push(line);
        if (!entry.batchTimer) entry.batchTimer = setTimeout(flushBatch, 200);
        if (entry.matchCount >= entry.maxMatches) {
          this.stopLogWatch(watchId, 'max-matches');
          return;
        }
      }
      resetIdleTimer();
    });
    child.stderr.on('data', (d) => this.log.debug(`[log_watch ${watchId}] stderr: ${d.toString().slice(0, 200)}`));
    child.on('exit', (code) => {
      entry.alive = false;
      flushBatch();
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      try { this._agent?.interject?.(sessionKey, `[log_watch ${entry.tag || entry.path}] watch ended (exit ${code}, matches=${entry.matchCount}).`); } catch (e) { this.log.warn('[tools] ended failed: ' + e.message); }
      this._activeLogWatches.delete(watchId);
    });
    this.log.info(`[log_watch] started id=${watchId} path=${logPath} match=${match}`);
    return { ok: true, watchId, path: logPath, match };
  }

  _logWatchListTool() {
    if (!this._activeLogWatches) return { watches: [] };
    const out = [];
    for (const [id, e] of this._activeLogWatches) {
      if (e.sessionKey !== this._ctxSessionKey()) continue;
      out.push({
        watchId: id, path: e.path, match: e.match, tag: e.tag,
        startedAt: e.startedAt, matchCount: e.matchCount, lastMatchAt: e.lastMatchAt,
        alive: e.alive,
      });
    }
    return { watches: out };
  }

  _logWatchStopTool({ watchId }) {
    if (!this._activeLogWatches?.has(watchId)) return { error: 'Unknown watchId' };
    this.stopLogWatch(watchId, 'stopped-by-tool');
    return { ok: true };
  }

  stopLogWatch(watchId, reason = 'stopped') {
    const entry = this._activeLogWatches?.get(watchId);
    if (!entry) return;
    entry.alive = false;
    try { entry.child.kill('SIGTERM'); } catch (e) { this.log.warn('[tools] entry.child.kill failed: ' + e.message); }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    this.log.info(`[log_watch] stop id=${watchId} reason=${reason} matches=${entry.matchCount}`);
    // Let the 'exit' handler do final cleanup; just nudge removal in case it hangs
    setTimeout(() => { if (this._activeLogWatches?.get(watchId) === entry) this._activeLogWatches.delete(watchId); }, 2000);
  }

  killSessionLogWatches(sessionKey) {
    if (!this._activeLogWatches) return;
    for (const [id, e] of this._activeLogWatches) {
      if (e.sessionKey === sessionKey) this.stopLogWatch(id, 'session-ended');
    }
  }

  // ── Phase 4: ask_user ─────────────────────────────────────────────
  async _askUserTool({ question, options, timeoutMs }) {
    const sessionKey = this._ctxSessionKey();
    if (!sessionKey) return { error: 'No active session' };
    const ctx = this._ctx();
    // Both web and Spore Code have the picker modal wired:
    //   - web:        gateway broadcasts ask_user frames to the panel
    //   - spore-code:  internal/app/update.go listens for ask_user WS
    //                 frames, openStructuredQuestion shows the modal,
    //                 finishQuestions sends ask_user_answer back.
    // The platform gate that used to refuse cli was a stale relic from
    // before the CLI gained the modal handler. Discord/Telegram and any
    // OTHER non-modal-capable platform still get the prose fallback.
    const ALLOWED_PLATFORMS = new Set(['web', 'cli']);
    if (ctx.platform && !ALLOWED_PLATFORMS.has(ctx.platform)) {
      return {
        error: `ask_user is not available on ${ctx.platform} (no modal UI). Ask the question in your reply text and wait for the user's free-form answer.`,
        platform: ctx.platform,
      };
    }
    if (!question || !Array.isArray(options) || options.length < 2 || options.length > 5) {
      return { error: 'question + 2-5 options required' };
    }
    if (!this._pendingQuestions) this._pendingQuestions = new Map();
    const qid = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const timeout = Math.max(30_000, Math.min(Number(timeoutMs) || 300_000, 3_600_000));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingQuestions?.has(qid)) {
          this._pendingQuestions.delete(qid);
          resolve({ timedOut: true, question });
        }
      }, timeout);
      this._pendingQuestions.set(qid, { resolve, sessionKey, channelId: ctx.channelId, timer, options, question, createdAt: Date.now() });
      try {
        if (typeof this._wsBroadcast === 'function') {
          this._wsBroadcast(sessionKey, { type: 'ask_user', qid, question, options });
        } else {
          this.log.warn('[ask_user] no WS broadcaster wired — answer will only arrive if UI already polls');
        }
      } catch (e) {
        this.log.warn(`[ask_user] broadcast failed: ${e.message}`);
      }
    });
  }

  answerAskUser(qid, answer) {
    const entry = this._pendingQuestions?.get(qid);
    if (!entry) return false;
    if (!entry.options.some(o => o.label === answer)) return false;
    clearTimeout(entry.timer);
    this._pendingQuestions.delete(qid);
    entry.resolve({ answer });
    return true;
  }

  cancelSessionAskUser(sessionKey) {
    if (!this._pendingQuestions) return;
    for (const [qid, entry] of this._pendingQuestions) {
      if (entry.sessionKey === sessionKey) {
        clearTimeout(entry.timer);
        this._pendingQuestions.delete(qid);
        entry.resolve({ timedOut: true, cancelled: true });
      }
    }
  }

  listPendingQuestions(sessionKey) {
    if (!this._pendingQuestions) return [];
    const out = [];
    for (const [qid, entry] of this._pendingQuestions) {
      if (entry.sessionKey === sessionKey) {
        out.push({ qid, question: entry.question, options: entry.options, createdAt: entry.createdAt });
      }
    }
    return out;
  }

  // ── Phase 5: plan-mode proposal queue ─────────────────────────────
  _queuePlanProposal(sessionKey, toolName, input) {
    const sessions = this._sessions;
    if (!sessions?.db) {
      return { error: 'Plan mode requires session DB; cannot queue proposal.' };
    }
    const summary = this._planModeSummary(toolName, input);
    const seq = sessions.db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM plan_proposals WHERE session_key=?'
    ).get(sessionKey).n;
    const info = sessions.db.prepare(
      `INSERT INTO plan_proposals (session_key, sequence, tool, input, summary, created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionKey, seq, toolName, JSON.stringify(input || {}), summary, Date.now());
    try {
      if (typeof this._wsBroadcast === 'function') {
        this._wsBroadcast(sessionKey, { type: 'plan_proposal', proposalId: info.lastInsertRowid, tool: toolName, summary, sequence: seq });
      }
    } catch (e) { this.log.warn('[tools] _wsBroadcast failed: ' + e.message); }
    return {
      queued: true,
      planMode: true,
      proposalId: info.lastInsertRowid,
      sequence: seq,
      summary,
      note: 'Execution deferred — awaiting operator approval.',
    };
  }

  _planModeSummary(tool, input) {
    try {
      switch (tool) {
        case 'graph_delete': return `Delete ${input?.nodeId ? 'node ' + input.nodeId : input?.aspectId ? 'aspect ' + input.aspectId : input?.attributeId ? 'attribute ' + input.attributeId : 'entity'}`;
        case 'graph_update': return `Update/create node ${input?.nodeId || input?.label || '?'}`;
        case 'exec': return `Shell: ${String(input?.command || '').slice(0, 120)}`;
        case 'remote_exec': return `Remote shell (${input?.host || 'primary'}): ${String(input?.command || '').slice(0, 100)}`;
        case 'write_file': return `Write ${input?.path || '?'}`;
        case 'edit_file': return `Edit ${input?.path || '?'}`;
        case 'email_send': return `Email to ${input?.to || '?'}: ${String(input?.subject || '').slice(0, 60)}`;
        case 'message_send': return `Message to ${input?.target || '?'}`;
        case 'web_serve': return `web_serve ${input?.action || 'start'} ${input?.name || ''}`;
        case 'env_manage': return `env ${input?.action || '?'} ${input?.key || ''}`;
        default: return `${tool}(${JSON.stringify(input || {}).slice(0, 80)})`;
      }
    } catch { return tool; }
  }

  async applyPlanProposals(sessionKey) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'No session DB' };
    const rows = sessions.db.prepare(
      "SELECT * FROM plan_proposals WHERE session_key=? AND status='pending' ORDER BY sequence ASC"
    ).all(sessionKey);
    const results = [];
    const ctx = this._sessionContexts?.get(sessionKey) || { sessionKey };
    for (const row of rows) {
      let input;
      try { input = JSON.parse(row.input); } catch { input = {}; }
      try {
        // Run inside the session's async context so any nested tool call
        // (e.g. graph_update's dependencies) sees the right sessionKey.
        const result = await _execContext.run(ctx, () => this._executeToolDirect(row.tool, input));
        const ok = !(result && result.error);
        sessions.db.prepare(
          'UPDATE plan_proposals SET status=?, result=?, applied_at=? WHERE id=?'
        ).run(ok ? 'applied' : 'failed', JSON.stringify(result || {}).slice(0, 8000), Date.now(), row.id);
        results.push({ proposalId: row.id, tool: row.tool, ok, summary: row.summary });
        if (!ok) break; // stop the batch on first failure
      } catch (e) {
        sessions.db.prepare('UPDATE plan_proposals SET status=?, error=?, applied_at=? WHERE id=?')
          .run('failed', String(e.message || e).slice(0, 500), Date.now(), row.id);
        results.push({ proposalId: row.id, tool: row.tool, ok: false, error: e.message });
        break;
      }
    }
    try {
      if (typeof this._wsBroadcast === 'function') {
        this._wsBroadcast(sessionKey, { type: 'plan_applied', results });
      }
    } catch (e) { this.log.warn('[tools] _wsBroadcast failed: ' + e.message); }
    return { ok: true, applied: results.length, results };
  }

  rejectPlanProposals(sessionKey) {
    const sessions = this._sessions;
    if (!sessions?.db) return { error: 'No session DB' };
    const now = Date.now();
    const info = sessions.db.prepare(
      "UPDATE plan_proposals SET status='rejected', applied_at=? WHERE session_key=? AND status='pending'"
    ).run(now, sessionKey);
    try {
      if (typeof this._wsBroadcast === 'function') {
        this._wsBroadcast(sessionKey, { type: 'plan_rejected', count: info.changes });
      }
    } catch (e) { this.log.warn('[tools] _wsBroadcast failed: ' + e.message); }
    return { ok: true, rejected: info.changes };
  }

  listPendingProposals(sessionKey) {
    const sessions = this._sessions;
    if (!sessions?.db) return [];
    return sessions.db.prepare(
      "SELECT id, sequence, tool, summary, created FROM plan_proposals WHERE session_key=? AND status='pending' ORDER BY sequence ASC"
    ).all(sessionKey);
  }
}

function _shellEscape(s) {
  // Single-quote with embedded '\'' escape — safe for use inside bash -c "…"
  // after double-quotes have already opened the outer string.
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

module.exports = { ToolSystem, MUTATING_TOOLS };
