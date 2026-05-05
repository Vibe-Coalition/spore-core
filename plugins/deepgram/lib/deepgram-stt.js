// Server-side Deepgram Nova-3 STT.
// Extracted from src/voice/stt.js DeepgramSTT class — same shape, same
// API contract (transcribe(audioBuffer, mimeType) → {text, confidence}).
// Reads the API key from the plugin slot first, then falls back to
// process.env.DEEPGRAM_API_KEY so existing .env files keep working.

const https = require('https');
const { URL } = require('url');

class DeepgramSTT {
  constructor(config) {
    const slot = config?.plugins?.deepgram || {};
    this.apiKey = slot.apiKey || process.env.DEEPGRAM_API_KEY || null;
    this.model = slot.model || config?.voice?.deepgramModel || 'nova-3';
    this.language = slot.language || config?.voice?.deepgramLanguage || 'en';
    if (!this.apiKey) throw new Error('Deepgram STT: no API key (set plugins.deepgram.apiKey or DEEPGRAM_API_KEY)');
  }

  /**
   * Batch transcription — accepts a Buffer of audio data.
   * Works with ogg/opus (Telegram voice notes), wav, mp3, webm, etc.
   * @param {Buffer} audioBuffer
   * @param {string} mimeType
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
}

module.exports = { DeepgramSTT };
