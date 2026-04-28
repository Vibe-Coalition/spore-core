// OAI-compatible chat-completion client + every helper used to build
// requests, parse responses, and recover from vLLM tool-parser failures.
//
// Was previously defined in `src/providers/index.js` and re-exported
// from this file as a transitional shim. Phase E of the provider
// extraction moves the source here so vendor-specific request/response
// transformation lives next to the plugin that owns the wire shape.
// Sibling provider plugins (openai-provider, openrouter-provider) wrap
// this same client; core no longer references it.
//
// Usage:
//   const { OAICompatClient } = require('./lib/oai-compat-client');           // local-oai-provider
//   const { OAICompatClient } = require('../local-oai-provider/lib/oai-compat-client'); // siblings

const { stripPrefix } = require('../../../providers');

// ───────────────────────────────────────────────────────────────────
// Tool-name aliasing + JSON repair (vLLM tool parsers occasionally
// emit malformed JSON or an alias like 'graph' instead of
// 'graph_update'; these helpers normalize back to the agent's tool
// schema).
// ───────────────────────────────────────────────────────────────────

const _TOOL_NAME_ALIASES = new Map([
  ['graph', 'graph_update'],
  ['analyze', 'analyze_media'],
]);

function normalizeToolName(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  return _TOOL_NAME_ALIASES.get(trimmed.toLowerCase()) || trimmed;
}

function _trimRepeatedTail(value) {
  if (typeof value !== 'string' || value.length < 2) return value;
  const last = value[value.length - 1];
  const prev = value[value.length - 2];
  if (last !== prev) return value;
  if (!/[A-Za-z0-9_-]/.test(last)) return value;
  return value.slice(0, -1);
}

function _repairGraphToolInput(value, key = '') {
  if (Array.isArray(value)) return value.map(item => _repairGraphToolInput(item, key));
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      value[childKey] = _repairGraphToolInput(childValue, childKey);
    }
    return value;
  }
  if (typeof value === 'string' && ['nodeId', 'type', 'target', 'project'].includes(key)) {
    return _trimRepeatedTail(value);
  }
  return value;
}

function _repairAnalyzeMediaToolInput(value, key = '') {
  if (Array.isArray(value)) return value.map(item => _repairAnalyzeMediaToolInput(item, key));
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      value[childKey] = _repairAnalyzeMediaToolInput(childValue, childKey);
    }
    return value;
  }
  if (typeof value === 'string' && ['path', 'prompt', 'kind'].includes(key)) {
    const trimmed = _trimRepeatedTail(value.trim());
    return key === 'kind' ? trimmed.toLowerCase() : trimmed;
  }
  return value;
}

function _postProcessToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return input;
  switch (normalizeToolName(toolName)) {
    case 'graph_update':
      return _repairGraphToolInput(input);
    case 'analyze_media':
    case 'analyze_image':
    case 'analyze_video':
    case 'analyze_audio':
      return _repairAnalyzeMediaToolInput(input);
    default:
      return input;
  }
}

function _repairToolJson(raw) {
  let repaired = String(raw || '').trim();
  if (!repaired) return repaired;
  repaired = repaired
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '\'')
    .replace(/,\s*([}\]])/g, '$1');
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
  repaired = repaired.replace(
    /(:\s*)([A-Za-z_./:-][A-Za-z0-9_./:-]*)(\")(\s*[,}\]])/g,
    '$1"$2"$4',
  );
  repaired = repaired.replace(/(:\s*)([A-Za-z_./:-][A-Za-z0-9_./:-]*)(\s*[,}\]])/g, (match, prefix, value, suffix) => {
    if (/^(true|false|null)$/i.test(value)) return match;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return match;
    return `${prefix}"${value}"${suffix}`;
  });
  repaired = repaired.replace(/([\[,]\s*)([A-Za-z_./:-][A-Za-z0-9_./:-]*)(\s*[,]\s*|\s*\])/g, (match, prefix, value, suffix) => {
    if (/^(true|false|null)$/i.test(value)) return match;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return match;
    return `${prefix}"${value}"${suffix}`;
  });
  return repaired;
}

function _parseToolInput(rawArgs, toolName) {
  const raw = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
  try {
    return _postProcessToolInput(toolName, JSON.parse(raw || '{}'));
  } catch (e) { console.warn('[oai-compat] _postProcessToolInput failed: ' + e.message); }
  const repaired = _repairToolJson(raw);
  if (repaired && repaired !== raw) {
    try {
      return _postProcessToolInput(toolName, JSON.parse(repaired || '{}'));
    } catch (e) { console.warn('[oai-compat] _postProcessToolInput failed: ' + e.message); }
  }
  return {
    _parse_error: `Tool arguments were malformed JSON and could not be parsed. Raw args (first 500 chars): ${(raw || '').substring(0, 500)}`,
  };
}

// ───────────────────────────────────────────────────────────────────
// Multimodal block conversion (Anthropic-shape → OAI parts).
// ───────────────────────────────────────────────────────────────────

const _EXT_BY_MEDIA_TYPE = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/heic': 'heic',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi',
};

function _sanitizeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function _extensionFromMediaType(mediaType, fallback = 'bin') {
  const key = String(mediaType || '').toLowerCase();
  if (_EXT_BY_MEDIA_TYPE[key]) return _EXT_BY_MEDIA_TYPE[key];
  const tail = key.split('/')[1] || fallback;
  const clean = tail.replace(/[^a-z0-9]/gi, '');
  return clean || fallback;
}

function _oaiFilePartFromSource(source, prefix) {
  if (source?.type !== 'base64' || !source?.data) return null;
  const ext = _extensionFromMediaType(source.media_type, 'bin');
  const filename = _sanitizeFilename(source.filename) || `${prefix}.${ext}`;
  return { type: 'file', file: { filename, file_data: source.data } };
}

function _oaiAudioPartFromSource(source) {
  if (source?.type !== 'base64' || !source?.data) return null;
  const mediaType = String(source.media_type || '').toLowerCase();
  const format = mediaType === 'audio/wav' || mediaType === 'audio/x-wav'
    ? 'wav'
    : mediaType === 'audio/mpeg' || mediaType === 'audio/mp3'
      ? 'mp3'
      : null;
  if (!format) return null;
  return { type: 'input_audio', input_audio: { data: source.data, format } };
}

function _oaiVideoUrlPartFromSource(source) {
  if (source?.type !== 'base64' || !source?.data) return null;
  const mediaType = String(source.media_type || '').toLowerCase() || 'video/mp4';
  return { type: 'video_url', video_url: { url: `data:${mediaType};base64,${source.data}` } };
}

// ───────────────────────────────────────────────────────────────────
// Anthropic-shape ↔ OAI request/response transformer.
// ───────────────────────────────────────────────────────────────────

function toOAIRequest(params, opts = {}) {
  // opts.useMaxCompletionTokens — true for true OpenAI (api.openai.com)
  // chat completions with newer reasoning-model field name. vLLM/Ollama/
  // OpenRouter etc. accept the legacy `max_tokens` so default to that.
  const useMaxCompletionTokens = !!opts.useMaxCompletionTokens;
  const maxTokenField = useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';

  const oaiMessages = [];

  if (params.system) {
    const sysText = Array.isArray(params.system)
      ? params.system.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : params.system;
    if (sysText.trim()) oaiMessages.push({ role: 'system', content: sysText });
  }

  for (const msg of params.messages || []) {
    const role = msg.role;
    if (typeof msg.content === 'string') {
      oaiMessages.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const textBlocks = msg.content.filter(b => b.type === 'text');
    const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');

    if (toolResultBlocks.length > 0) {
      for (const tr of toolResultBlocks) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : JSON.stringify(tr.content);
        oaiMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
      }
      continue;
    }
    if (toolUseBlocks.length > 0) {
      const oaiMsg = {
        role: 'assistant',
        content: textBlocks.map(b => b.text).join('') || null,
        tool_calls: toolUseBlocks.map(tu => ({
          id: tu.id,
          type: 'function',
          function: { name: normalizeToolName(tu.name), arguments: JSON.stringify(tu.input || {}) },
        })),
      };
      oaiMessages.push(oaiMsg);
      continue;
    }

    const parts = [];
    let hasStructuredInput = false;
    for (const b of msg.content) {
      if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` },
        });
        hasStructuredInput = true;
      } else if ((b.type === 'audio' || b.type === 'input_audio') && b.source?.type === 'base64') {
        const audioPart = _oaiAudioPartFromSource(b.source) || _oaiFilePartFromSource(b.source, 'input-audio');
        if (audioPart) { parts.push(audioPart); hasStructuredInput = true; }
      } else if (b.type === 'video' && b.source?.type === 'base64') {
        const videoPart = _oaiVideoUrlPartFromSource(b.source);
        if (videoPart) { parts.push(videoPart); hasStructuredInput = true; }
      } else if (b.type === 'file' && b.source?.type === 'base64') {
        const filePart = _oaiFilePartFromSource(b.source, 'input-file');
        if (filePart) { parts.push(filePart); hasStructuredInput = true; }
      }
    }
    if (hasStructuredInput) {
      if (parts.length > 0) oaiMessages.push({ role, content: parts });
      continue;
    }
    const text = textBlocks.map(b => b.text).join('');
    if (text) oaiMessages.push({ role, content: text });
  }

  let oaiTools;
  if (params.tools && params.tools.length > 0) {
    oaiTools = params.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  const strippedModel = stripPrefix(params.model);
  const body = { messages: oaiMessages };
  if (params.max_tokens != null) body[maxTokenField] = params.max_tokens;
  if (useMaxCompletionTokens && params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
  if (strippedModel) body.model = strippedModel;
  if (oaiTools) {
    body.tools = oaiTools;
    body.tool_choice = 'auto';
  }
  return body;
}

// Extract tool calls embedded as text tags when vLLM's tool parser fails.
// Handles both Qwen-style (<function=name><parameter=k>v</parameter></function>)
// and Hermes-style (JSON inside <tool_call> tags).
function _extractInlineToolCalls(text) {
  if (!text || !text.includes('<tool_call>')) return null;
  const toolBlocks = [];
  const cleanText = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body) => {
    const jsonTrimmed = body.trim();
    if (jsonTrimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(jsonTrimmed);
        toolBlocks.push({
          type: 'tool_use',
          id: `tc_${toolBlocks.length}`,
          name: normalizeToolName(parsed.name),
          input: _postProcessToolInput(parsed.name, parsed.arguments || {}),
        });
        return '';
      } catch { /* silent: malformed JSON → fallback */ }
    }
    const fnMatch = body.match(/<function=([^>]+)>([\s\S]*?)<\/function>/);
    if (fnMatch) {
      const name = fnMatch[1].trim();
      const paramsBody = fnMatch[2];
      const input = {};
      const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramRe.exec(paramsBody)) !== null) {
        const val = pm[2].trim();
        try { input[pm[1].trim()] = JSON.parse(val); } catch { input[pm[1].trim()] = val; }
      }
      toolBlocks.push({
        type: 'tool_use',
        id: `tc_${toolBlocks.length}`,
        name: normalizeToolName(name),
        input: _postProcessToolInput(name, input),
      });
      return '';
    }
    return '';
  }).trim();
  return toolBlocks.length > 0 ? { cleanText, toolBlocks } : null;
}

function fromOAIResponse(oaiResp) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    };
  }

  const msg = choice.message;
  const content = [];

  let reasoningText = msg.reasoning_content || msg.reasoning || msg.thinking || '';
  let text = msg.content || '';

  if (text) {
    const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    let m;
    while ((m = thinkRe.exec(text)) !== null) {
      reasoningText += (reasoningText ? '\n' : '') + m[1].trim();
    }
    text = text.replace(thinkRe, '').trim();
    const openOnly = text.match(/<think(?:ing)?>([\s\S]*)$/i);
    if (openOnly) {
      reasoningText += (reasoningText ? '\n' : '') + openOnly[1].trim();
      text = text.replace(/<think(?:ing)?>[\s\S]*$/i, '').trim();
    }
  }

  if (!text && reasoningText && choice.finish_reason !== 'length') {
    text = reasoningText;
    reasoningText = '';
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    if (text) content.push({ type: 'text', text });
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: normalizeToolName(tc.function.name),
        input: _parseToolInput(tc.function.arguments || '{}', tc.function.name),
      });
    }
  } else {
    const extracted = _extractInlineToolCalls(text);
    if (extracted) {
      if (extracted.cleanText) content.push({ type: 'text', text: extracted.cleanText });
      content.push(...extracted.toolBlocks);
    } else if (text) {
      content.push({ type: 'text', text });
    }
  }

  if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText });
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const hasToolUse = content.some(b => b.type === 'tool_use');
  const stopReason = (choice.finish_reason === 'tool_calls' || hasToolUse) ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens'
    : 'end_turn';

  return {
    content,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
    },
    stop_reason: stopReason,
  };
}

// ───────────────────────────────────────────────────────────────────
// Client.
// ───────────────────────────────────────────────────────────────────

class OAICompatClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL              — full base URL, e.g. https://openrouter.ai/api/v1
   * @param {string} [opts.apiKey]             — API key / token
   * @param {string} [opts.authHeader]         — header name for auth: 'bearer' (default) → Authorization: Bearer <key>;
   *                                             anything else (e.g. 'x-api-key') → <header>: <key>
   * @param {object} [opts.headers]            — extra headers
   * @param {number} [opts.timeoutMs]
   * @param {boolean} [opts.useMaxCompletionTokens] — true for api.openai.com (newer reasoning models require
   *                                                  `max_completion_tokens` instead of `max_tokens`)
   * @param {Function} [opts.onCapability]     — (model, cap, val) => void; called when server responses
   *                                              imply a capability (no tools support, etc.)
   */
  constructor(opts) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey || '';
    this.authHeader = (opts.authHeader || 'bearer').toLowerCase();
    this.extraHeaders = opts.headers || {};
    this.timeoutMs = opts.timeoutMs || 120000;
    this.firstContactTimeoutMs = opts.firstContactTimeoutMs || this.timeoutMs;
    this._contactedModels = new Set();
    this.useMaxCompletionTokens = !!opts.useMaxCompletionTokens;
    /** @type {((model:string, cap:string, val:boolean) => void)|null} */
    this.onCapability = opts.onCapability || null;
    this.messages = {
      create: this._create.bind(this),
      stream: this._stream.bind(this),
    };
  }

  _maxTokenField() {
    return this.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
  }

  _buildAuthHeaders() {
    if (!this.apiKey) return {};
    if (this.authHeader === 'bearer') return { Authorization: `Bearer ${this.apiKey}` };
    return { [this.authHeader]: this.apiKey };
  }

  _buildHeaders() {
    return {
      'Content-Type': 'application/json',
      ...this._buildAuthHeaders(),
      ...this.extraHeaders,
    };
  }

  _timeoutFor(model) {
    if (this._contactedModels.has(model)) return this.timeoutMs;
    return this.firstContactTimeoutMs;
  }

  _markContacted(model) { this._contactedModels.add(model); }

  _isContextLengthError(err) {
    return err.status === 400 && /context length|max.*token|maximum.*length|too many tokens/i.test(err.message);
  }

  async _fetchJSON(body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`OAI provider HTTP ${res.status}: ${errText.substring(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const rawText = await res.text();
      try { return JSON.parse(rawText); }
      catch { throw new Error(`OAI provider returned non-JSON: ${rawText.substring(0, 200)}`); }
    } finally {
      clearTimeout(timer);
    }
  }

  async _create(params, _opts) {
    const body = toOAIRequest(params, { useMaxCompletionTokens: this.useMaxCompletionTokens });
    const model = body.model || '';
    const timeout = this._timeoutFor(model);
    const maxTokenField = this._maxTokenField();

    try {
      const oaiResp = await this._fetchJSON(body, timeout);
      this._markContacted(model);
      const result = fromOAIResponse(oaiResp);
      if (result.stop_reason === 'tool_use'
          && body.tools?.length
          && !result.content.some(b => b.type === 'tool_use' && b.name)) {
        if (this.onCapability) this.onCapability(params.model, 'tools', false);
        delete body.tools;
        delete body.tool_choice;
        const retry = await this._fetchJSON(body, timeout);
        return fromOAIResponse(retry);
      }
      if (body.tools?.length && this.onCapability) this.onCapability(params.model, 'tools', true);
      return result;
    } catch (err) {
      if (err.status === 400 && body.tools?.length && !this._isContextLengthError(err)) {
        if (this.onCapability) this.onCapability(params.model, 'tools', false);
        delete body.tools;
        delete body.tool_choice;
        const oaiResp = await this._fetchJSON(body, timeout);
        this._markContacted(model);
        return fromOAIResponse(oaiResp);
      }
      if (this._isContextLengthError(err) && body[maxTokenField] > 512) {
        body[maxTokenField] = Math.floor(body[maxTokenField] / 2);
        const oaiResp = await this._fetchJSON(body, timeout);
        this._markContacted(model);
        return fromOAIResponse(oaiResp);
      }
      throw err;
    }
  }

  /**
   * SSE streaming — returns an object matching the Anthropic SDK stream shape:
   *   .on('text', cb)   — text deltas
   *   .on('event', cb)  — structured events
   *   .on('end', cb)    — stream finished
   *   .abort()           — cancel
   *   .finalMessage()    — Promise<AnthropicMessage>
   */
  _stream(params, _opts) {
    const self = this;
    const origBody = { ...toOAIRequest(params, { useMaxCompletionTokens: this.useMaxCompletionTokens }), stream: true, stream_options: { include_usage: true } };
    const model = origBody.model || '';
    const timeout = this._timeoutFor(model);
    const maxTokenField = this._maxTokenField();

    const listeners = { text: [], event: [], end: [] };
    const emit = (type, data) => {
      for (const fn of listeners[type] || []) { try { fn(data); } catch (e) { console.warn('[oai-compat] listener failed: ' + e.message); } }
    };

    const abortCtrl = new AbortController();

    const done = (async () => {
      let body = origBody;
      let retried = false;

      const runStream = async (streamBody) => {
        let inactivityTimer = setTimeout(() => abortCtrl.abort(), timeout);
        const resetInactivityTimer = () => {
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => abortCtrl.abort(), timeout);
        };
        let fullText = '';
        let reasoningText = '';
        let toolCalls = {};
        let usage = { input_tokens: 0, output_tokens: 0 };
        let stopReason = 'end_turn';

        try {
          const res = await fetch(`${self.baseURL}/chat/completions`, {
            method: 'POST',
            headers: self._buildHeaders(),
            body: JSON.stringify(streamBody),
            signal: abortCtrl.signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            const err = new Error(`OAI provider HTTP ${res.status}: ${errText.substring(0, 300)}`);
            err.status = res.status;
            throw err;
          }

          self._markContacted(model);
          resetInactivityTimer();

          const reader = res.body.getReader?.();
          if (!reader) {
            const rawText = await res.text();
            return fromOAIResponse(JSON.parse(rawText));
          }

          const decoder = new TextDecoder();
          let buffer = '';
          let sentBlockStart = false;
          let sentThinkingStart = false;
          const STALL_MS = 15000;

          while (true) {
            const readResult = await Promise.race([
              reader.read(),
              new Promise(resolve => setTimeout(() => resolve({ stalled: true }), STALL_MS)),
            ]);
            if (readResult.stalled) break;
            const { done: readerDone, value } = readResult;
            if (readerDone) break;
            resetInactivityTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;

              let chunk;
              try { chunk = JSON.parse(payload); } catch { continue; }

              if (chunk.usage) {
                usage.input_tokens = chunk.usage.prompt_tokens || usage.input_tokens;
                usage.output_tokens = chunk.usage.completion_tokens || usage.output_tokens;
              }

              if (chunk.error) {
                throw new Error(`OAI stream error: ${JSON.stringify(chunk.error).substring(0, 300)}`);
              }

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              const reasoning = delta.reasoning || delta.reasoning_content || delta.thinking || '';
              if (reasoning) {
                reasoningText += reasoning;
                if (!sentThinkingStart) {
                  emit('event', { type: 'content_block_start', content_block: { type: 'thinking' } });
                  sentThinkingStart = true;
                }
                emit('event', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: reasoning } });
              }

              const textPart = delta.content || '';
              if (textPart) {
                if (sentThinkingStart) {
                  emit('event', { type: 'content_block_stop' });
                  sentThinkingStart = false;
                }
                if (!sentBlockStart) {
                  emit('event', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                  sentBlockStart = true;
                }
                fullText += textPart;
                emit('text', textPart);
                emit('event', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: textPart } });
              }

              if (delta.tool_calls) {
                if (sentThinkingStart) {
                  emit('event', { type: 'content_block_stop' });
                  sentThinkingStart = false;
                }
                if (sentBlockStart) {
                  emit('event', { type: 'content_block_stop' });
                  sentBlockStart = false;
                }
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `tc_${idx}`, name: '', args: '' };
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.function?.name) {
                    toolCalls[idx].name = tc.function.name;
                    emit('event', { type: 'content_block_start', content_block: { type: 'tool_use', id: toolCalls[idx].id, name: tc.function.name } });
                  }
                  if (tc.function?.arguments) {
                    toolCalls[idx].args += tc.function.arguments;
                    if (toolCalls[idx].args.length % 200 < tc.function.arguments.length) {
                      emit('event', { type: 'tool_use_delta', index: idx, name: toolCalls[idx].name, argsLength: toolCalls[idx].args.length });
                    }
                  }
                }
              }

              const fr = chunk.choices?.[0]?.finish_reason;
              if (fr === 'tool_calls') {
                stopReason = 'tool_use';
                for (const tc of Object.values(toolCalls)) {
                  if (tc.name) emit('event', { type: 'content_block_stop' });
                }
              } else if (fr === 'length') {
                stopReason = 'max_tokens';
              } else if (fr === 'stop') {
                stopReason = 'end_turn';
              }
            }
          }

          if (sentThinkingStart) emit('event', { type: 'content_block_stop' });
          if (sentBlockStart) emit('event', { type: 'content_block_stop' });
        } finally {
          clearTimeout(inactivityTimer);
        }

        // Pull <think>...</think> blocks out of inline content (Kimi K2 / DeepSeek variants).
        {
          const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
          let m;
          let stripped = fullText;
          while ((m = thinkRe.exec(fullText)) !== null) {
            reasoningText += (reasoningText ? '\n' : '') + m[1].trim();
          }
          stripped = fullText.replace(thinkRe, '').trim();
          const openOnly = stripped.match(/<think(?:ing)?>([\s\S]*)$/i);
          if (openOnly) {
            reasoningText += (reasoningText ? '\n' : '') + openOnly[1].trim();
            stripped = stripped.replace(/<think(?:ing)?>[\s\S]*$/i, '').trim();
          }
          fullText = stripped;
        }

        if (!fullText && reasoningText && stopReason === 'end_turn') {
          fullText = reasoningText;
          reasoningText = '';
        }

        const content = [];
        const serverToolCalls = Object.values(toolCalls);

        if (serverToolCalls.length > 0) {
          if (fullText) content.push({ type: 'text', text: fullText });
          for (const tc of serverToolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: normalizeToolName(tc.name),
              input: _parseToolInput(tc.args || '{}', tc.name),
            });
          }
        } else {
          const extracted = _extractInlineToolCalls(fullText);
          if (extracted) {
            if (extracted.cleanText) content.push({ type: 'text', text: extracted.cleanText });
            content.push(...extracted.toolBlocks);
            stopReason = 'tool_use';
            for (const tb of extracted.toolBlocks) {
              emit('event', { type: 'content_block_start', content_block: { type: 'tool_use', id: tb.id, name: tb.name } });
              emit('event', { type: 'content_block_stop' });
            }
          } else if (fullText) {
            content.push({ type: 'text', text: fullText });
          }
        }

        if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText });
        if (content.length === 0) content.push({ type: 'text', text: '' });
        if (streamBody.tools?.length && self.onCapability) self.onCapability(params.model, 'tools', true);

        return { content, usage, stop_reason: stopReason };
      };

      try {
        const result = await runStream(body);
        if (result.stop_reason === 'tool_use'
            && body.tools?.length
            && !result.content.some(b => b.type === 'tool_use' && b.name)) {
          if (self.onCapability) self.onCapability(params.model, 'tools', false);
          const { tools, tool_choice, ...rest } = body;
          return await runStream(rest);
        }
        return result;
      } catch (err) {
        if (err.status === 400 && body.tools?.length && !retried && !self._isContextLengthError(err)) {
          retried = true;
          if (self.onCapability) self.onCapability(params.model, 'tools', false);
          const { tools, tool_choice, ...rest } = body;
          return await runStream(rest);
        }
        if (self._isContextLengthError(err) && body[maxTokenField] > 512) {
          body[maxTokenField] = Math.floor(body[maxTokenField] / 2);
          return await runStream(body);
        }
        throw err;
      } finally {
        emit('end', undefined);
      }
    })();

    return {
      on(event, cb) { (listeners[event] || []).push(cb); return this; },
      abort() { abortCtrl.abort(); },
      async finalMessage() { return done; },
    };
  }
}

// ───────────────────────────────────────────────────────────────────
// /models probe (used by the wizard's "populate models" button + the
// per-tier ctx auto-enrichment in /api/onboarding/complete and
// /api/settings).
// ───────────────────────────────────────────────────────────────────

async function listOaiCompatModels({ baseUrl, apiKey, authHeader, headers: extraHeaders, transform } = {}) {
  if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const headers = { ...(extraHeaders || {}) };
  if (apiKey) {
    if (authHeader === 'x-api-key')      headers['x-api-key']  = apiKey;
    else if (authHeader === 'x-key')     headers['x-key']      = apiKey;
    else                                 headers['Authorization'] = `Bearer ${apiKey}`;
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    if (!d) return { ok: false, error: 'invalid JSON response' };
    const arr = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.models) ? d.models : null);
    if (!arr) return { ok: false, error: 'no `data` or `models` array in response' };
    const ctxFields = ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'max_position_embeddings', 'max_input_tokens'];
    const outFields = ['max_completion_tokens', 'max_output_tokens', 'max_response_tokens'];
    const readField = (obj, names) => {
      for (const f of names) {
        const v = Number(obj?.[f]);
        if (Number.isFinite(v) && v > 0) return Math.floor(v);
      }
      return null;
    };
    const models = arr.map(m => {
      if (typeof m === 'string') return { id: m, contextLength: null };
      const id = m.id || m.name || '';
      if (!id) return null;
      const ctx = readField(m, ctxFields) ?? readField(m.top_provider, ctxFields);
      const out = readField(m, outFields) ?? readField(m.top_provider, outFields);
      const base = {
        id,
        contextLength: ctx,
        ...(out ? { maxOutput: out } : {}),
        ...(m.display_name || m.name ? { displayName: m.display_name || (m.id ? null : m.name) } : {}),
      };
      return transform ? transform(m, base) : base;
    }).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

// Longest-prefix-wins lookup for vendor metadata tables.
function resolveByPrefix(modelId, table) {
  if (!modelId) return null;
  let best = null;
  for (const row of table || []) {
    if (modelId.startsWith(row.prefix)) {
      if (!best || row.prefix.length > best.prefix.length) best = row;
    }
  }
  return best;
}

module.exports = {
  OAICompatClient,
  toOAIRequest,
  fromOAIResponse,
  listOaiCompatModels,
  resolveByPrefix,
  // Helpers exposed for any plugin that needs them (e.g. when a future
  // backend uses an OAI-shape request-builder but bypasses the client).
  normalizeToolName,
  _postProcessToolInput,
  _parseToolInput,
};
