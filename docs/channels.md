# Channels

Channels let people talk to Spore outside the web app. Bundled channel plugins
include Telegram, Slack, and Discord. Channel sessions should behave like first
class sessions: they get their own graph scope, routing, wakeups, and learning
behavior.

## Channel Graphs

Channel traffic should write to a channel/person graph rather than default.
That graph can read General Knowledge so the agent can reuse shared capability
knowledge without polluting other users or channels.

Expected behavior:

- incoming channel message resolves platform, chat/channel ID, user, and graph,
- replies go back to the originating channel,
- wakeups keep the same origin and graph,
- learner writes stay in the channel/person graph,
- reusable non-private lessons can be distilled to General Knowledge.

## Telegram

The Telegram plugin provides a bot gateway with DMs, groups, forum topics,
attachments, reactions, recent-message recall, and voice-note transcription when
voice providers are configured.

Pairing should be handled through the plugin's pending-request flow. A human
Telegram login code is not a bot pairing code and should not be pasted into
Spore.

## Slack

The Slack plugin uses Socket Mode. It supports channels, DMs, mentions, threads,
file uploads, reactions, task progress, lull responses, and configurable
thread/session mapping.

Slack requires the correct bot/app tokens and workspace permissions.

## Discord

The Discord plugin supports messages, DMs, replies, reactions, attachments, task
progress, and optional voice-channel join/leave behavior depending on
permissions.

Discord bots need channel permissions for reading, sending, attachments, and any
voice actions used.

## Pairing And Approval

Channel pairing settings should show:

- pending requests,
- approved users/chats,
- approve/revoke actions,
- refresh/error state.

The operator should be able to approve a pending pairing from settings without
asking the agent to do it in chat.

## Recurring Work

Scheduled channel work should preserve its origin. If a user asks in Telegram
for a recurring market update, the scheduled turn should send the update back to
that Telegram chat and write any conversation state to the same channel/person
graph.

If a wakeup appears in the web app or CLI instead, inspect the runtime job's
stored session key, platform, channel ID, user ID, and graph slug.

## Channel Distillation

Channels often stay open forever. The channel distiller periodically summarizes
conversation progress when there has been activity and enough idle time. The
distiller should:

- keep channel-specific facts in the channel graph,
- promote reusable lessons to General Knowledge,
- avoid writing private/person-specific noise to default,
- emit events so operators can inspect what happened.

## Privacy Policies

Channel privacy controls can decide whether a source is private, learnable,
shared to feeds, or respondable. These policies should be evaluated before
learning or sending.

## Troubleshooting

If channel settings show HTTP errors, check the plugin route registration,
installed plugin state, and auth.

If replies land in the wrong UI, inspect wakeup delivery and session binding.

If a channel graph learns unrelated web/CLI facts, inspect scoped recall and
learner write targets.
