# Voice

Spore supports voice through the web app and channel plugins when the relevant
STT/TTS providers are configured. Voice input is transcribed to text, processed
by the normal agent loop, and optionally returned as synthesized speech.

## Pipeline

```text
audio input
  -> gateway or web client
  -> STT provider
  -> agent loop with the active session and graph scope
  -> text response
  -> optional TTS provider
  -> channel or web playback
```

Voice does not bypass graph scoping. A Telegram voice message should use the
Telegram channel graph. A web voice message should use the active web session
graph.

## Settings

Core voice preferences live under the voice settings group:

| Setting | Purpose |
|---|---|
| enabled | enable/disable voice features |
| STT provider | preferred speech-to-text provider |
| TTS provider | preferred text-to-speech provider |
| TTS voice/model/speed | synthesis choices |
| Edge voice | local/free fallback voice |
| silence threshold | live utterance cutoff |
| max utterance seconds | maximum captured speech segment |

Provider credentials live in their plugins.

## Bundled Voice Plugins

| Plugin | Role |
|---|---|
| Deepgram | speech-to-text |
| Whisper | speech-to-text |
| ElevenLabs | text-to-speech |

The image also includes the runtime dependencies used by available voice/media
paths, such as ffmpeg.

## Web Voice

When enabled, the web app can record audio and send it through the same websocket
session as text chat. The response should appear in the current chat and use the
currently selected graph/session.

## Channel Voice

Channel plugins decide which voice features they expose:

- Telegram can receive voice notes when the bot and plugin support it.
- Discord voice features depend on bot permissions and channel setup.
- Slack voice depends on available file/event support from the plugin.

Always verify that the channel bot has permission to read the audio event and
send the response format.

## Troubleshooting

If transcription fails:

- check that the STT plugin is installed and configured,
- confirm the provider key is saved in plugin settings,
- inspect logs for media conversion errors,
- verify the uploaded audio format is supported.

If TTS fails:

- check the selected provider and voice name,
- fall back to another provider or text-only replies,
- inspect plugin logs for provider-specific errors.

If voice replies land in the wrong place, debug it like a channel routing issue:
the originating session, user, channel, and graph should travel together through
the pipeline.
