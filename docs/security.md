# Security

Spore is a privileged runtime. It can execute commands, store credentials,
connect to private networks, run browser automation, load plugins, and write
long-term memory. Treat the web UI, plugin directories, `/data`, and any channel
pairing surface as operator-grade control planes.

## Threat Model

Primary risks:

- unauthorized web or websocket access,
- leaked provider/channel secrets,
- cross-user or cross-graph memory leakage,
- prompt injection that reaches powerful tools,
- untrusted plugin code,
- browser automation leaking across users or channels,
- SSH key exposure,
- destructive shell/file operations,
- stale websocket sessions keeping auth state alive,
- backups or logs exposing private data.

## Web Auth

The web app uses session auth for operators and webapp users. Login endpoints are
rate limited. A valid login should clear stale lockout state for that credential
path so an already connected websocket or previous failed attempts do not leave a
legitimate user unable to re-login indefinitely.

Cookies should be `HttpOnly` and same-site where possible. Websocket auth must be
checked independently; do not assume an existing socket belongs to the currently
logged-in browser tab.

## Webapp Users

Webapp users are not operators. They should receive their own user graph and only
see:

- their own graph,
- General Knowledge/default where policy allows,
- projects they collaborate on,
- channel/session views explicitly tied to them.

Operator-only settings, logs, plugin install/uninstall, backups, raw graph
administration, and credential surfaces should remain gated.

## Graph Privacy

Graph scoping is a security boundary, not only a relevance feature.

Expected behavior:

- Spore Code writes project memory, not default.
- Channel sessions write channel/person memory, not default.
- Plugin reference nodes install into General Knowledge.
- Learner and proactive jobs preserve the originating graph/session/user.
- General Knowledge receives only reusable non-private lessons.

Do not rely on prompt instructions to keep the model from using private memory.
The code should avoid putting unrelated graph context in the prompt in the first
place.

## Tool Catalog Boundaries

Tool exposure is context-sensitive:

- CLI/Spore Code should not see browser or webapp request tools.
- Cron job creation/destruction should not be available to CLI by default.
- Browser tools should be scoped to the requesting user, session, and channel.
- Plan mode should avoid mutating tools until execution is approved.
- Subagents should receive a reduced catalog.

When adding tools, define the session types where the tool is valid and add
tests for the negative cases.

## Shell And Package Installs

The `exec` tool is powerful. Core hardening includes dangerous-command checks
and package-install vetting. The Docker image includes many operator tools, but
agents should still prefer isolated project-local setup where possible:

- Python virtual environments inside the repo are acceptable for coding tasks.
- Userland installs are preferred when system package installation is not
  required.
- Destructive filesystem or host-network operations need explicit operator
  intent.

Do not document private host paths, usernames, or cluster names as examples.

## Plugins

Plugins are trusted code. The plugin manager loads plugin entry points directly
with Node.js; there is no sandbox. A plugin can read environment variables,
register HTTP routes, add tools, alter prompts, and start workers.

Security rules:

- install only reviewed plugins,
- keep plugin directories outside agent-writable workspace paths,
- treat plugin settings as privileged,
- verify plugin reference nodes clean up on uninstall,
- test tool availability rules for plugin tools.

## Secrets And Settings

Secrets can come from environment variables, `/data/.env`, settings DB rows, or
plugin settings. UI/API responses should redact secrets and avoid returning raw
values after save.

Provider keys, channel tokens, invite keys, SSH passphrases, and service keys
must not be written into graph memory or docs. If a secret is needed by a tool,
prefer a short-lived file or process-level access over model-visible text.

## Browser Automation

Browser sessions can expose logged-in state and private pages. Browser tools must
be scoped to the user/session/channel that requested them. A CLI session should
not be able to open or control a browser tab in some unrelated web user's view.

## SSH, Tailscale, And Remote Access

Remote access is optional and should be explicit.

- Tailscale state persists under `/data/tailscale`.
- SSH saved hosts can use local encrypted fallback storage.
- The `ssh-sidecar` plugin can isolate saved-host CRUD, interactive SSH, remote
  exec, and SFTP in a sidecar process.
- If the sidecar is unavailable, decrypted keys may live in the main process
  while in use.

Use host allowlists and private-network policy when SSH credentials grant access
to sensitive systems.

## Channels And Pairing

Telegram, Slack, Discord, and other channels should bind incoming users/chats to
explicit channel graph scopes. Pairing approval should be visible in settings
and should not require asking the agent to approve a pending request.

Never paste login codes from a human Telegram account into Spore. Channel
plugins should use bot/channel pairing flows, not personal account login codes.

## Backups And Logs

Backups may contain full graph memory, sessions, user facts, and plugin reference
nodes. Logs may contain prompts, tool names, error messages, filenames, and route
metadata. Store and share them accordingly.

Before resetting or pruning data, back up `/data` unless the desired outcome is a
complete wipe.

## Health Endpoint

The health endpoint is separate from the web UI and should normally bind to
localhost:

```yaml
127.0.0.1:${SPORE_HEALTH_PORT:-18790}:${SPORE_HEALTH_PORT:-18790}
```

Expose it publicly only if the surrounding infrastructure requires it and the
returned data is acceptable for that environment.
