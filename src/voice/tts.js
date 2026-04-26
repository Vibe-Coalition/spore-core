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
  } catch (e) { console.warn('[tts] fs.existsSync failed: ' + e.message); }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const d = path.join(os.tmpdir(), `spore-edge-tts-${uid}`);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ElevenLabsTTS moved to plugins/elevenlabs/lib/elevenlabs-tts.js. The
// plugin registers the 'elevenlabs' TTS provider via
// api.registerTTSProvider — when installed, createTTS below picks it
// up automatically.

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

    try {
      await new Promise((resolve, reject) => {
        execFile('edge-tts', args, { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr?.trim() || err.message));
          resolve();
        });
      });

      const buf = fs.readFileSync(tmpFile);
      if (!buf.length) throw new Error('edge-tts produced empty audio');
      return buf;
    } finally {
      // Always clean up — execFile timeouts and read errors leave the
      // partial .mp3 on disk otherwise.
      try { fs.unlinkSync(tmpFile); } catch { /* silent: best-effort cleanup */ }
    }
  }

  async synthesizeOgg(text) {
    return this.synthesize(text);
  }
}

/**
 * Factory — create the right TTS provider.
 *
 * Walks plugin-registered providers first (via manager.getTTSProviders())
 * and returns the one whose name matches `config.voice.ttsProvider`.
 * Falls through to in-tree OpenAI / Edge classes (no plugin owns them
 * yet — Edge is a free fallback that should always work; OpenAI shares
 * a key with the LLM inference layer). The ElevenLabs class extracted
 * to plugins/elevenlabs/ in the TTS plugin extraction pass.
 */
function createTTS(config, manager) {
  const preferred = config?.voice?.ttsProvider;

  if (manager?.getTTSProviders) {
    const providers = manager.getTTSProviders();
    if (preferred) {
      const named = providers.find(p => p.name === preferred && p.configured);
      if (named) {
        try { return named.factory(config); } catch { /* fall through */ }
      }
    }
    // No preferred (or preferred unmatched/misconfigured): if a plugin
    // registered a provider that's configured, prefer it over the
    // in-tree paid OpenAI option but still let the operator opt into
    // 'openai' / 'edge' explicitly via the dropdown.
    if (!preferred) {
      const firstConfigured = providers.find(p => p.configured);
      if (firstConfigured) {
        try { return firstConfigured.factory(config); } catch { /* fall through */ }
      }
    }
  }

  // In-tree fallbacks. Operator-explicit 'openai' / 'edge' lands here;
  // 'auto' selects OpenAI (if keyed) or Edge (free, always available).
  if (preferred === 'openai' && config.openaiApiKey) {
    return new OpenAITTS(config.openaiApiKey, config.voice);
  }
  if (preferred === 'edge') {
    return new EdgeTTS(config.voice);
  }
  if (config.openaiApiKey) {
    return new OpenAITTS(config.openaiApiKey, config.voice);
  }
  return new EdgeTTS(config.voice);
}

module.exports = { OpenAITTS, EdgeTTS, createTTS };
