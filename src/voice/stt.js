/**
 * voice/stt.js — Speech-to-Text abstraction
 *
 * Priority:
 *   1. Deepgram Nova-3 (when DEEPGRAM_API_KEY is set)
 *   2. OpenAI Whisper (fallback when no Deepgram key)
 *
 * Browser clients follow the same priority: use server STT (Deepgram) when
 * sttEnabled=true in /api/identity, otherwise fall back to local WebGPU Whisper.
 */

const https = require('https');
const { URL } = require('url');

class DeepgramSTT {
  constructor(apiKey, opts = {}) {
    this.apiKey = apiKey;
    this.model = opts.model || 'nova-3';
    this.language = opts.language || 'en';
  }

  /**
   * Batch transcription — accepts a Buffer of audio data.
   * Works with ogg/opus (Telegram voice notes), wav, mp3, webm, etc.
   * @param {Buffer} audioBuffer
   * @param {string} mimeType - e.g. 'audio/ogg', 'audio/wav', 'audio/webm'
   * @returns {Promise<{text: string, confidence: number}>}
   */
  async transcribe(audioBuffer, mimeType = 'audio/ogg') {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      smart_format: 'true',
      punctuate: 'true',
    });

    const url = `https://api.deepgram.com/v1/listen?${params}`;

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': mimeType,
          'Content-Length': audioBuffer.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              return reject(new Error(parsed.err_msg || parsed.message || `Deepgram ${res.statusCode}`));
            }
            const alt = parsed.results?.channels?.[0]?.alternatives?.[0];
            resolve({
              text: alt?.transcript || '',
              confidence: alt?.confidence || 0,
            });
          } catch (e) {
            reject(new Error(`Deepgram parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(audioBuffer);
      req.end();
    });
  }

  /**
   * Create a streaming transcription session via WebSocket.
   * Returns an object with { send(chunk), close(), onTranscript(cb) }.
   *
   * Requires the 'ws' package — but since we want to keep deps minimal,
   * we use a simpler approach: accumulate PCM and batch-transcribe on silence.
   * For real streaming, a future upgrade can use Deepgram's WebSocket API.
   */
}

// OpenAISTT moved to plugins/whisper/lib/openai-whisper.js (Phase B).
// The plugin registers the 'openai' STT provider via
// api.registerSTTProvider — when installed, createSTT below picks it
// up automatically.

/**
 * Factory — create the right STT provider.
 *
 * Walks plugin-registered providers first (via manager.getSTTProviders())
 * and returns the one whose name matches `config.voice.sttProvider`.
 * If no preference is set, falls back to the first configured provider.
 * Plugin-driven path is the canonical one; the in-tree DeepgramSTT /
 * OpenAISTT classes below are transitional fallbacks that only fire
 * when no plugin claims the provider name (Phase A of whisper plugin
 * extraction). They will be removed in Phases B + C.
 */
function createSTT(config, manager) {
  const preferred = config.voice?.sttProvider;
  if (manager?.getSTTProviders) {
    const providers = manager.getSTTProviders();
    if (preferred) {
      const named = providers.find(p => p.name === preferred && p.configured);
      if (named) {
        try { return named.factory(config); } catch (e) {
          // Fall through to other providers if this one's factory throws.
        }
      }
    }
    const firstConfigured = providers.find(p => p.configured);
    if (firstConfigured) {
      try { return firstConfigured.factory(config); } catch (e) {
        // Fall through to in-tree fallback.
      }
    }
  }
  // Transitional: in-tree DeepgramSTT fallback (the class still lives
  // here until Phase C extracts it). OpenAI Whisper has already moved
  // to the whisper plugin; without that plugin installed, openai is
  // simply unavailable.
  if (config.deepgramApiKey) {
    return new DeepgramSTT(config.deepgramApiKey, config.voice);
  }
  return null;
}

module.exports = { DeepgramSTT, createSTT };
