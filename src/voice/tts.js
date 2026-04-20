/**
 * voice/tts.js — Text-to-Speech abstraction
 *
 * Supports:
 *   - ElevenLabs (highest quality, voice cloning, XI_API_KEY)
 *   - OpenAI TTS (simple, good quality, OPENAI_API_KEY)
 *   - Edge TTS (free, no API key, Microsoft neural voices)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Writable dir for edge-tts output — avoid /tmp/spore-edge-tts if root created it (Permission denied). */
function edgeTtsTmpDir() {
  const ws = process.env.SPORE_WORKSPACE_PATH || process.cwd();
  try {
    if (fs.existsSync(ws)) {
      const d = path.join(ws, '.edge-tts-tmp');
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      return d;
    }
  } catch {}
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const d = path.join(os.tmpdir(), `spore-edge-tts-${uid}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

class ElevenLabsTTS {
  constructor(apiKey, opts = {}) {
    this.apiKey = apiKey;
    this.voiceId = opts.ttsVoice || opts.voiceId || 'JBFqnCBsd6RMkjVDRZzb'; // "George" — warm male
    this.modelId = opts.ttsModel || 'eleven_turbo_v2_5';
    this.stability = opts.stability ?? 0.5;
    this.similarityBoost = opts.similarityBoost ?? 0.75;
    this.speed = opts.ttsSpeed ?? 1.0;
  }

  /**
   * Synthesize text to audio.
   * @param {string} text
   * @param {object} opts - { format: 'mp3_44100_128' | 'pcm_16000' | 'opus' }
   * @returns {Promise<Buffer>} audio data
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

  /**
   * Synthesize and return OGG/Opus suitable for Telegram voice notes.
   */
  async synthesizeOgg(text) {
    return this.synthesize(text, { format: 'mp3_44100_128' });
  }
}

class OpenAITTS {
  constructor(apiKey, opts = {}) {
    this.apiKey = apiKey;
    this.voice = opts.ttsVoice || 'alloy';
    this.model = opts.ttsModel || 'tts-1';
    this.speed = opts.ttsSpeed ?? 1.0;
  }

  /**
   * Synthesize text to audio via OpenAI TTS.
   * @param {string} text
   * @param {object} opts - { format: 'mp3' | 'opus' | 'aac' | 'flac' | 'pcm' }
   * @returns {Promise<Buffer>}
   */
  async synthesize(text, opts = {}) {
    const format = opts.format || 'mp3';
    const body = JSON.stringify({
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: format,
      speed: this.speed,
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            try {
              const err = JSON.parse(buf.toString());
              return reject(new Error(err.error?.message || `OpenAI TTS ${res.statusCode}`));
            } catch {
              return reject(new Error(`OpenAI TTS ${res.statusCode}`));
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

  async synthesizeOgg(text) {
    return this.synthesize(text, { format: 'opus' });
  }
}

class EdgeTTS {
  constructor(opts = {}) {
    this.voice = opts.ttsVoice || opts.edgeVoice || 'en-US-AriaNeural';
    const pct = opts.ttsSpeed ? Math.round((opts.ttsSpeed - 1) * 100) : 0;
    this.rate = pct !== 0 ? `${pct > 0 ? '+' : ''}${pct}%` : null;
    this.pitch = null;
  }

  async synthesize(text) {
    const { execFile } = require('child_process');
    const tmpDir = edgeTtsTmpDir();
    const tmpFile = path.join(tmpDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);

    const args = ['--text', text, '--write-media', tmpFile, '--voice', this.voice];
    if (this.rate) args.push('--rate', this.rate);
    if (this.pitch) args.push('--pitch', this.pitch);

    await new Promise((resolve, reject) => {
      execFile('edge-tts', args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve();
      });
    });

    const buf = fs.readFileSync(tmpFile);
    try { fs.unlinkSync(tmpFile); } catch {}
    if (!buf.length) throw new Error('edge-tts produced empty audio');
    return buf;
  }

  async synthesizeOgg(text) {
    return this.synthesize(text);
  }
}

/**
 * Factory — create the right TTS provider.
 * Priority: explicit provider > ElevenLabs (if key) > OpenAI (if key) > Edge TTS (free fallback)
 */
function createTTS(config) {
  const provider = config.voice?.ttsProvider;

  if (provider === 'openai' && config.openaiApiKey) {
    return new OpenAITTS(config.openaiApiKey, config.voice);
  }
  if (provider === 'edge') {
    return new EdgeTTS(config.voice);
  }
  if (provider === 'elevenlabs' && config.xiApiKey) {
    return new ElevenLabsTTS(config.xiApiKey, config.voice);
  }

  // Auto-select: paid providers first, Edge as free fallback
  if (config.xiApiKey) {
    return new ElevenLabsTTS(config.xiApiKey, config.voice);
  }
  if (config.openaiApiKey) {
    return new OpenAITTS(config.openaiApiKey, config.voice);
  }

  // Edge TTS — always available, no API key needed
  return new EdgeTTS(config.voice);
}

module.exports = { ElevenLabsTTS, OpenAITTS, EdgeTTS, createTTS };
