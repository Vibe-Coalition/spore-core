# Tools

Tools are callable capabilities exposed to the agent. The exact catalog depends
on session type, plan/execute mode, plugin state, and availability callbacks.

## Built-In Tool Groups

Core tool handlers are declared in `src/tools/builtin-registry.js` and described
in `src/tools/tools.js`.

| Group | Tools |
|---|---|
| shell/files | `exec`, `read_file`, `write_file`, `edit_file`, `grep`, `glob` |
| messaging | `message_send`, `message_react`, `message_edit`, `message_read` |
| graph | `graph_query`, `query_about`, `graph_update`, `graph_diff`, `graph_delete` |
| delegation | `delegate_task`, `task_status`, `task_cancel`, `task_update` |
| web | `web_search`, `web_fetch`, `web_serve`, `webapp_request` |
| sessions/settings | `session_status`, `sessions_list`, `settings_read`, `env_manage` |
| media | `analyze_media`, `analyze_image`, `analyze_video`, `analyze_audio` |
| custom skills/tools | `save_tool`, `list_custom_tools`, `skill_lookup`, `skill_update` |
| scheduling | `sleep`, `notify_user`, `schedule_wakeup`, `list_wakeups`, `cancel_wakeup` |
| checklist | `task_create`, `task_progress`, `task_list`, `task_get` |
| logs | `log_watch`, `log_watch_list`, `log_watch_stop` |
| questions | `ask_user` |
| multi-spore | `spore_list`, `spore_message`, `spore_graph`, `spore_manage` |
| remote | `remote_exec`, `remote_tail`, `remote_tmux_kill`, `remote_read_file`, `remote_write_file`, `ssh_tunnel` |
| runtime | `startup_tasks`, `data_poller` |

Plugin tools add to this list when their plugins are installed.

## Plugin Tools

Bundled plugin tools include:

- `browser` from `browser-core`,
- `email_send`, `email_list`, `email_read`, `email_search` from `email`,
- `generate_image` from `flux`,
- `cron` from `cron`,
- `telegram_pairing` from `telegram`,
- Spore Code helpers such as `index_codebase`, `search_symbols`, `trace_calls`,
  `get_snippet`, `architecture`, `impact`, `verify_implementation`,
  `code_overview`, `trace_path`, and `code_diff`,
- session graph helpers such as `note_discovery`, project scripts, project
  summary updates, script outcomes, and decision records.

Plugin availability is dynamic. Do not document a plugin tool as always present.

## Tool Catalog Boundaries

Tool exposure should be enforced before the model sees the tool list.

Examples:

- Spore Code should not see `browser` or `webapp_request`.
- Cron guidance is hidden from CLI sessions.
- Browser instances are scoped by user/session/channel.
- Webapp request cookies use the active user context.
- Plan mode should queue or hide mutating actions until execution is approved.
- Background workers should not receive user-interactive tools such as
  `ask_user`.
- Subagents receive restricted catalogs unless intentionally configured.

## `ask_user`

`ask_user` pauses a web or Spore Code session and shows a structured picker with
2-5 options. It is for concrete decisions the agent cannot infer, such as merge
choice, provider choice, or whether to proceed with a risky operation.

Do not use it for normal information gathering, rhetorical questions, or channel
sessions that cannot render the modal. If a user sends normal text while a
picker is pending and the text does not match an option, the pending question
should be cancelled or superseded rather than swallowing the user's message.

## Wakeups And Deferred Work

Use `schedule_wakeup` for delayed follow-up. The runtime should store enough
origin metadata to re-enter the same session, graph, user, and channel.

Do not implement polling by looping over `sleep` and status checks. Schedule one
wakeup or use a log watch.

## Browser Tool

The `browser` tool is owned by `browser-core` and dispatched to browser backend
plugins such as `zendriver` and `playwright`.

Browser sessions can contain private logged-in state. They must be scoped to the
requesting user/session/channel and hidden from CLI sessions.

## Shell And File Tools

For code inspection, prefer file tools over shelling out to `cat` or `sed`.
`exec` is still available for tests, builds, package managers, git commands, and
other commands that need a real shell.

Package installs are vetted where possible. Project-local virtual environments
are acceptable for isolated coding work.

## Remote Tools

Remote SSH tools can use local encrypted fallback or the optional SSH sidecar.
Saved hosts and credentials are privileged. Avoid exposing raw private key
material to the model or returning it through API responses.

## Testing Tool Changes

Use focused tests when changing tools:

```bash
node --test tests/tools/ask-user.test.js
node --test tests/tools/plugin-execution-boundary.test.js
node --test tests/tools/browser-core-tool.test.js
node --test tests/plugins/channel-routing.test.js
node --test tests/graph/scoped-memory.test.js
```

Also run `git diff --check` before handing off.
