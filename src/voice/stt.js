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

class OpenAISTT {
  constructor(apiKey, opts = {}) {
    this.apiKey = apiKey;
    this.model = opts.model || 'whisper-1';
  }

  /**
   * Batch transcription via OpenAI Whisper API.
   * Accepts audio buffer. The API expects multipart form data.
   * @param {Buffer} audioBuffer
   * @param {string} mimeType
   * @returns {Promise<{text: string, confidence: number}>}
   */
  async transcribe(audioBuffer, mimeType = 'audio/ogg') {
    const ext = mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('wav') ? 'wav'
      : mimeType.includes('webm') ? 'webm'
      : mimeType.includes('mp3') ? 'mp3'
      : 'ogg';
    const filename = `audio.${ext}`;

    const boundary = '----VoiceBoundary' + Date.now();
    const parts = [];

    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    parts.push(audioBuffer);
    parts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.model}\r\n--${boundary}--\r\n`);

    const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              return reject(new Error(parsed.error?.message || `OpenAI STT ${res.statusCode}`));
            }
            resolve({ text: parsed.text || '', confidence: 1.0 });
          } catch (e) {
            reject(new Error(`OpenAI STT parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

/**
 * Factory — create the right STT provider.
 * Deepgram is always tried first (when key is present).
 * OpenAI Whisper is used as a fallback when no Deepgram key is available.
 */
function createSTT(config) {
  if (config.deepgramApiKey) {
    return new DeepgramSTT(config.deepgramApiKey, config.voice);
  }
  if (config.openaiApiKey) {
    return new OpenAISTT(config.openaiApiKey, config.voice);
  }
  return null;
}

module.exports = { DeepgramSTT, OpenAISTT, createSTT };
