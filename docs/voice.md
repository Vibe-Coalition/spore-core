# Voice Pipeline

Anima supports **voice notes** on Discord and Telegram. When a voice message arrives it is transcribed (STT), processed through the agent loop exactly like a text message, then sent back as a synthesised voice note (TTS).

The pipeline is completely transparent to the agent — it sees transcribed text in, and sends text out. The gateway layers handle audio encoding/decoding.

---

## How It Works

```
User voice note
     ↓
Gateway (Discord / Telegram) downloads audio
     ↓
STT provider transcribes to text
     ↓
AgentLoop processes (same path as text messages)
     ↓
TTS provider synthesises audio
     ↓
Gateway sends voice note reply
```

---

## Enabling Voice

Voice auto-enables when an STT key is available. TTS always has a free fallback (Edge TTS), so you only need one key:

```bash
# Minimum — free TTS, paid STT
DEEPGRAM_API_KEY=your-key-here

# Best quality — paid TTS
DEEPGRAM_API_KEY=your-deepgram-key
XI_API_KEY=your-elevenlabs-key
```

Set these in the agent's `.env` or via the Anima Manager.

---

## STT Providers

| Provider | Key | Notes |
|---|---|---|
| **Deepgram** | `DEEPGRAM_API_KEY` | Default. Free tier: 45 hrs/month at [console.deepgram.com](https://console.deepgram.com) |
| **OpenAI Whisper** | `OPENAI_API_KEY` + `ANIMA_STT_PROVIDER=openai` | Used if no Deepgram key is set |

---

## TTS Providers

Providers are chosen in this order when `ANIMA_TTS_PROVIDER` is not set:

1. **ElevenLabs** — highest quality, paid, requires `XI_API_KEY`
2. **OpenAI TTS** — good quality, paid, requires `OPENAI_API_KEY`
3. **Edge TTS** — free, no key, always available as fallback

### ElevenLabs

```bash
ANIMA_TTS_PROVIDER=elevenlabs   # (or leave blank for auto)
XI_API_KEY=your-elevenlabs-key
ANIMA_TTS_VOICE=JBFqnCBsd6RMkjVDRZzb   # Voice ID (George)
```

Popular voice IDs: `JBFqnCBsd6RMkjVDRZzb` (George), `21m00Tcm4TlvDq8ikWAM` (Rachel), `ErXwobaYiN019PkySvjV` (Antoni).

### OpenAI TTS

```bash
ANIMA_TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...
ANIMA_TTS_VOICE=alloy     # alloy, echo, fable, onyx, nova, shimmer
```

### Edge TTS (free)

```bash
ANIMA_TTS_PROVIDER=edge
ANIMA_TTS_EDGE_VOICE=en-US-AriaNeural
```

Popular Edge voices: `en-US-AriaNeural`, `en-US-GuyNeural`, `en-GB-SoniaNeural`, `en-AU-NatashaNeural`, `en-IE-ConnorNeural`.

To list all available Edge voices:

```bash
docker exec <agent-id> node -e "
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const tts = new MsEdgeTTS();
tts.getVoices().then(v => v.forEach(x => console.log(x.ShortName, x.Locale)));
"
```

---

## Platform-Specific Notes

### Telegram

Voice notes work out of the box. The gateway converts between OGG Opus (Telegram's format) and MP3/PCM as needed.

### Discord

Discord voice requires the agent to join a voice channel. The bot must have `Connect` and `Speak` permissions. When a user speaks in a voice channel the bot is in, it will listen, transcribe, and respond via voice.

To trigger Discord voice, mention the bot or use `/voice` while in a voice channel (configuration may vary by setup).

---

## Configuration Reference

| Variable | Description | Default |
|---|---|---|
| `ANIMA_VOICE_ENABLED` | `true` / `false` / auto | auto |
| `DEEPGRAM_API_KEY` | Deepgram streaming STT key | — |
| `ANIMA_STT_PROVIDER` | `deepgram` or `openai` | `deepgram` |
| `ANIMA_TTS_PROVIDER` | `elevenlabs`, `openai`, `edge`, or auto | auto |
| `XI_API_KEY` | ElevenLabs API key | — |
| `ANIMA_TTS_VOICE` | ElevenLabs voice ID or OpenAI voice name | — |
| `ANIMA_TTS_MODEL` | ElevenLabs model override | — |
| `ANIMA_TTS_SPEED` | TTS speed multiplier (1.0 = normal) | `1.0` |
| `ANIMA_TTS_EDGE_VOICE` | Edge TTS voice name | `en-US-AriaNeural` |

---

## Troubleshooting

**Voice not responding:**
- Check `docker logs <agent-id>` for `[voice] Pipeline disabled` — this means no STT key is set.
- Confirm `DEEPGRAM_API_KEY` or `OPENAI_API_KEY` is present in `.env`.

**Audio is synthesised but sounds robotic:**
- Switch to ElevenLabs for much better quality.
- Try different Edge voices — quality varies significantly between them.

**Telegram voice notes not received:**
- Ensure the bot has permission to send voice messages in the chat.
- Voice notes must be sent as `.ogg` files — check the gateway logs for conversion errors.
