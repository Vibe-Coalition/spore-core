// ElevenLabs TTS — extracted from src/voice/tts.js. Same shape as the
// in-tree class was: synthesize(text, opts) → Buffer, synthesizeOgg(text)
// alias. Reads the API key + voice/model overrides from the plugin
// slot (config.plugins.elevenlabs.*) first, then falls back to
// host-level fields (config.xiApiKey + config.voice.ttsVoice etc.) so
// existing instances keep working without re-entering credentials.

const https = require('https');

class ElevenLabsTTS {
  constructor(config) {
    const slot = config?.plugins?.elevenlabs || {};
    const voice = config?.voice || {};
    this.apiKey = slot.apiKey || config?.xiApiKey || null;
    if (!this.apiKey) throw new Error('ElevenLabs TTS: no API key (set plugins.elevenlabs.apiKey or XI_API_KEY)');
    this.voiceId = slot.voiceId || voice.ttsVoice || 'JBFqnCBsd6RMkjVDRZzb'; // 'George' — warm male
    this.modelId = slot.modelId || voice.ttsModel || 'eleven_turbo_v2_5';
    this.stability = slot.stability ?? voice.stability ?? 0.5;
    this.similarityBoost = slot.similarityBoost ?? voice.similarityBoost ?? 0.75;
    this.speed = slot.speed ?? voice.ttsSpeed ?? 1.0;
  }

  /**
   * Synthesize text to audio.
   * @param {string} text
   * @param {object} opts — { format: 'mp3_44100_128' | 'pcm_16000' | 'opus' }
   * @returns {Promise<Buffer>}
   */
  async synthesize(text, opts = {}) {
    const format = opts.format || 'mp3_44100_128';
    const body = JSON.stringify({
      text,
      model_id: this.modelId,
      voice_settings: {
        stability: this.stability,
        similarity_boost: this.similarityBoost,
        speed: this.speed,
      },
    });
    const path = `/v1/text-to-speech/${this.voiceId}?output_format=${format}`;

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.elevenlabs.io',
        path,
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'audio/mpeg',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            try {
              const err = JSON.parse(buf.toString());
              return reject(new Error(err.detail?.message || err.message || `ElevenLabs ${res.statusCode}`));
            } catch {
              return reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
            }
          }
          resolve(buf);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Telegram-friendly alias. Telegram accepts mp3 in send_voice fine. */
  async synthesizeOgg(text) {
    return this.synthesize(text, { format: 'mp3_44100_128' });
  }
}

module.exports = { ElevenLabsTTS };
