// Server-side OpenAI Whisper STT.
// Extracted from src/voice/stt.js OpenAISTT class — same shape, same
// API contract (transcribe(audioBuffer, mimeType) → {text, confidence}).
// Reads the API key from the plugin slot first, then falls back to the
// legacy host-level `openaiApiKey` (which the LLM inference layer also
// uses). This keeps existing instances working out of the box.

const https = require('https');

class OpenAIWhisperSTT {
  constructor(config) {
    const slot = config?.plugins?.whisper || {};
    this.apiKey = slot.apiKey || config?.openaiApiKey || null;
    this.model = slot.model || config?.voice?.whisperModel || 'whisper-1';
    if (!this.apiKey) throw new Error('OpenAI Whisper STT: no API key (set plugins.whisper.apiKey or OPENAI_API_KEY)');
  }

  /**
   * Batch transcription via OpenAI Whisper API.
   * @param {Buffer} audioBuffer
   * @param {string} mimeType — audio/ogg, audio/wav, audio/webm, audio/mp3
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

module.exports = { OpenAIWhisperSTT };
