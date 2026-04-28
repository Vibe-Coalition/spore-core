// Gemini chat client (native REST, no SDK). Phase E of the provider
// extraction moves the source here from `src/providers/index.js` so
// vendor-specific request/response transformation lives next to the
// plugin that owns the wire shape. Core no longer references it.
//
// Anthropic-shape input (system, messages with text/image/audio/video/
// file content blocks, tools) → Gemini /v1beta/models/<id>:generateContent
// body. Multimodal blocks become inline_data parts; without that
// conversion, every image/audio/video block from upstream silently
// drops and the model responds as if the user sent text-only.

const { stripPrefix } = require('../../../providers');

class GeminiClient {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs = opts.timeoutMs || 120000;
    this.messages = { create: this._create.bind(this) };
  }

  async _create(params) {
    const model = stripPrefix(params.model);
    // Send the API key as a header rather than a URL query param so it
    // doesn't leak into fetch error messages (undici TypeErrors include
    // the URL in the cause chain) or any URL-bearing log.
    const url = `${this.baseURL}/models/${model}:generateContent`;

    // Convert Anthropic-style system+messages to Gemini format
    const systemText = Array.isArray(params.system)
      ? params.system.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : (params.system || '');

    // Convert Anthropic-shape content blocks → Gemini `parts`.
    // Gemini expects { text } or { inline_data: { mime_type, data } } for
    // base64 image/audio/video content. file_data:{file_uri} exists for
    // Files-API-uploaded blobs but the agent loop sends base64 directly,
    // so we use inline_data for all media.
    const contents = [];
    for (const msg of params.messages || []) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text' && b.text) {
            parts.push({ text: b.text });
          } else if ((b.type === 'image' || b.type === 'audio' || b.type === 'input_audio' || b.type === 'video') && b.source?.type === 'base64' && b.source.data) {
            // input_audio is Anthropic's spelling for OAI parity; both
            // map to inline_data with the source media_type.
            parts.push({
              inline_data: {
                mime_type: b.source.media_type || (b.type === 'image' ? 'image/png' : b.type === 'video' ? 'video/mp4' : 'audio/mpeg'),
                data: b.source.data,
              },
            });
          } else if (b.type === 'file' && b.source?.type === 'base64' && b.source.data) {
            parts.push({
              inline_data: {
                mime_type: b.source.media_type || 'application/octet-stream',
                data: b.source.data,
              },
            });
          }
        }
      } else if (msg.content) {
        parts.push({ text: JSON.stringify(msg.content) });
      }
      if (parts.length > 0) contents.push({ role, parts });
    }

    const body = {
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents,
      generationConfig: {
        maxOutputTokens: params.max_tokens || 2048,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${errText.substring(0, 300)}`);
      }

      const data = await res.json();
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map(p => p.text).join('') || '';
      const usage = data.usageMetadata || {};

      return {
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: usage.promptTokenCount || 0,
          output_tokens: usage.candidatesTokenCount || 0,
        },
        stop_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { GeminiClient };
