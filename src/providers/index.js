/**
 * providers/index.js — Unified LLM provider abstraction
 *
 * Supports multiple backends, chosen by model string prefix:
 *
 *   Anthropic (default):  model = "claude-*" or no prefix
 *   OpenAI:               model = "openai/<model>"    (native OpenAI API)
 *   OpenRouter:           model = "openrouter/<model>"
 *   Local (OAI-compat):   model = "local/<model>"     (Ollama / LM Studio / vLLM)
 *   Gemini:               model = "gemini/<model>"
 *   Custom providers:     model = "<name>/<model>"     (any OAI-compat endpoint via SPORE_PROVIDER_<NAME>_URL)
 *
 * All backends expose the same interface:
 *
 *   provider.messages.create({ model, max_tokens, system, messages, tools? })
 *     → { content: [{type:'text',text},...], usage: {input_tokens, output_tokens}, stop_reason }
 *
 * Multimodal handling:
 *   - legacy vision/audio/video fallbacks still work for backwards compatibility
 *   - when dedicated IMAGE/VIDEO/AUDIO VLM tiers are configured, the main chat
 *     path stays on the primary model and multimodal subcalls are expected to
 *     happen through explicit tools instead of silent model replacement
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _BUILTIN_PREFIXES = new Set(['openai', 'openrouter', 'local', 'gemini']);
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

  // Quote bare object keys.
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');

  // Fix the common broken pattern: `"key": bareword"` (missing opening quote).
  repaired = repaired.replace(
    /(:\s*)([A-Za-z_./:-][A-Za-z0-9_./:-]*)(\")(\s*[,}\]])/g,
    '$1"$2"$4',
  );

  // Quote remaining bareword scalar values in objects.
  repaired = repaired.replace(/(:\s*)([A-Za-z_./:-][A-Za-z0-9_./:-]*)(\s*[,}\]])/g, (match, prefix, value, suffix) => {
    if (/^(true|false|null)$/i.test(value)) return match;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return match;
    return `${prefix}"${value}"${suffix}`;
  });

  // Quote remaining bareword scalar values in arrays.
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
  } catch {}

  const repaired = _repairToolJson(raw);
  if (repaired && repaired !== raw) {
    try {
      return _postProcessToolInput(toolName, JSON.parse(repaired || '{}'));
    } catch {}
  }

  return {
    _parse_error: `Tool arguments were malformed JSON and could not be parsed. Raw args (first 500 chars): ${(raw || '').substring(0, 500)}`,
  };
}

/** Strip provider prefix from model string: "openrouter/x/y" → "x/y", "together/llama" → "llama" */
function stripPrefix(model) {
  const slash = model.indexOf('/');
  if (slash === -1) return model;
  const prefix = model.substring(0, slash);
  if (_BUILTIN_PREFIXES.has(prefix) || _customProviderNames.has(prefix)) {
    return model.substring(slash + 1);
  }
  return model;
}

let _customProviderNames = new Set();

/** Detect which backend a model string targets */
function detectBackend(model) {
  if (!model) return 'none';
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('openrouter/')) return 'openrouter';
  if (model.startsWith('local/')) return 'local';
  if (model.startsWith('gemini/')) return 'gemini';
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.substring(0, slash);
    if (_customProviderNames.has(prefix)) return 'custom';
  }
  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Content-type detectors
// ---------------------------------------------------------------------------

function _hasImages(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image') return true;
    }
  }
  return false;
}

function _hasAudio(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'audio' || block.type === 'input_audio') return true;
    }
  }
  return false;
}

function _hasVideo(params) {
  for (const msg of params.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'video') return true;
    }
  }
  return false;
}

function _hasTools(params) {
  return params.tools && params.tools.length > 0;
}

// ---------------------------------------------------------------------------
// Capability inference & cache
// ---------------------------------------------------------------------------

const _VISION_PATTERNS = /\bvl\b|vision|pixtral|4o|4v/i;
const _AUDIO_PATTERNS  = /audio|realtime|4o-audio/i;
const _VIDEO_PATTERNS  = /\bvl\b|video/i;

/**
 * Infer capabilities from a model name using heuristics.
 * Returns { tools, vision, audio, video } where each is true/false/null.
 * null = genuinely unknown, will be probed at runtime.
 */
function _inferCapabilities(model) {
  if (!model) return { tools: null, vision: null, audio: null, video: null };
  const backend = detectBackend(model);

  if (backend === 'anthropic') return { tools: true, vision: true, audio: false, video: false };
  if (backend === 'openai')    return { tools: true, vision: true, audio: false, video: false };
  if (backend === 'gemini')    return { tools: true, vision: true, audio: true,  video: true  };

  const name = stripPrefix(model).toLowerCase();
  return {
    tools:  null,
    vision: _VISION_PATTERNS.test(name) ? true : false,
    audio:  _AUDIO_PATTERNS.test(name)  ? true : false,
    video:  _VIDEO_PATTERNS.test(name)  ? true : false,
  };
}

function _maxOutputTokenField(model) {
  return detectBackend(model) === 'openai' ? 'max_completion_tokens' : 'max_tokens';
}

const _EXT_BY_MEDIA_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
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
  return {
    type: 'file',
    file: {
      filename,
      file_data: source.data,
    },
  };
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
  return {
    type: 'input_audio',
    input_audio: {
      data: source.data,
      format,
    },
  };
}

function _oaiVideoUrlPartFromSource(source) {
  if (source?.type !== 'base64' || !source?.data) return null;
  const mediaType = String(source.media_type || '').toLowerCase() || 'video/mp4';
  return {
    type: 'video_url',
    video_url: {
      url: `data:${mediaType};base64,${source.data}`,
    },
  };
}

/**
 * Convert Anthropic-style messages.create params → OpenAI chat/completions body.
 *
 * Handles:
 *  - system: string | [{type:'text',text}]  → messages[0] with role:'system'
 *  - messages: Anthropic message array (text + tool_use + tool_result blocks)
 *  - tools: Anthropic tool definitions → OpenAI function tools
 */
function toOAIRequest(params) {
  const oaiMessages = [];

  // System prompt
  if (params.system) {
    const sysText = Array.isArray(params.system)
      ? params.system.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : params.system;
    if (sysText.trim()) oaiMessages.push({ role: 'system', content: sysText });
  }

  // Messages — convert Anthropic block arrays to OAI content
  for (const msg of params.messages || []) {
    const role = msg.role; // 'user' | 'assistant'

    if (typeof msg.content === 'string') {
      oaiMessages.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    // Split: text blocks → content string, tool_use → tool_calls, tool_result → tool role
    const textBlocks = msg.content.filter(b => b.type === 'text');
    const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');

    if (toolResultBlocks.length > 0) {
      // Anthropic tool_result blocks → OAI tool messages
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
      // assistant turn with tool calls
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

    // Multimodal: text + image/audio/video/file blocks → OAI content array
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
        if (audioPart) {
          parts.push(audioPart);
          hasStructuredInput = true;
        }
      } else if (b.type === 'video' && b.source?.type === 'base64') {
        const videoPart = _oaiVideoUrlPartFromSource(b.source);
        if (videoPart) {
          parts.push(videoPart);
          hasStructuredInput = true;
        }
      } else if (b.type === 'file' && b.source?.type === 'base64') {
        const filePart = _oaiFilePartFromSource(b.source, 'input-file');
        if (filePart) {
          parts.push(filePart);
          hasStructuredInput = true;
        }
      }
    }
    if (hasStructuredInput) {
      if (parts.length > 0) oaiMessages.push({ role, content: parts });
      continue;
    }

    // Plain text turn
    const text = textBlocks.map(b => b.text).join('');
    if (text) oaiMessages.push({ role, content: text });
  }

  // Tools
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
  const body = {
    messages: oaiMessages,
  };
  if (params.max_tokens != null) body[_maxOutputTokenField(params.model)] = params.max_tokens;
  if (detectBackend(params.model) === 'openai' && params.reasoning_effort) {
    body.reasoning_effort = params.reasoning_effort;
  }
  if (strippedModel) body.model = strippedModel;
  if (oaiTools) {
    body.tools = oaiTools;
    body.tool_choice = 'auto';
  }
  return body;
}

/**
 * Convert OpenAI chat completion response → Anthropic messages response shape.
 */
/**
 * Extract tool calls embedded as text tags when vLLM's tool parser fails.
 * Handles both Qwen-style (<function=name><parameter=k>v</parameter></function>)
 * and Hermes-style (JSON inside <tool_call> tags).
 * Returns { cleanText, toolBlocks } where toolBlocks are Anthropic-shaped tool_use blocks.
 */
function _extractInlineToolCalls(text) {
  if (!text || !text.includes('<tool_call>')) return null;
  const toolBlocks = [];
  const cleanText = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body) => {
    // Try Hermes JSON format first
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
      } catch {}
    }
    // Qwen XML-like format: <function=name><parameter=k>v</parameter>...</function>
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

  // Reasoning field name varies by provider:
  //   DeepSeek / GLM → msg.reasoning_content
  //   Qwen → msg.reasoning
  //   Kimi (Moonshot) → msg.thinking (or msg.reasoning_content, version-dependent)
  let reasoningText = msg.reasoning_content || msg.reasoning || msg.thinking || '';
  let text = msg.content || '';

  // Some providers wrap reasoning inline in <think>...</think> tags inside
  // content. Split those out so reasoning ends up in a thinking block rather
  // than polluting the visible response.
  if (text) {
    const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    let m;
    while ((m = thinkRe.exec(text)) !== null) {
      reasoningText += (reasoningText ? '\n' : '') + m[1].trim();
    }
    text = text.replace(thinkRe, '').trim();
    // Orphan opening tag (model cut off mid-thought)
    const openOnly = text.match(/<think(?:ing)?>([\s\S]*)$/i);
    if (openOnly) {
      reasoningText += (reasoningText ? '\n' : '') + openOnly[1].trim();
      text = text.replace(/<think(?:ing)?>[\s\S]*$/i, '').trim();
    }
  }

  // Kimi K2.6 / some vLLM configs emit the entire output on the reasoning
  // channel and leave content null/empty. If we have no text but reasoning
  // is populated and the model finished normally, treat the reasoning as
  // the final answer.
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
    // Check for inline tool calls (Qwen/Hermes format in text when vLLM parser fails)
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

// ---------------------------------------------------------------------------
// OAI-compat client (fetch-based, no extra deps)
// ---------------------------------------------------------------------------

class OAICompatClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL     — full base URL, e.g. https://openrouter.ai/api/v1
   * @param {string} [opts.apiKey]    — API key / token
   * @param {string} [opts.authHeader] — header name for auth: 'bearer' (default) → Authorization: Bearer <key>,
   *                                     anything else (e.g. 'x-api-key') → <header>: <key>
   * @param {object} [opts.headers]   — extra headers
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.apiKey = opts.apiKey || '';
    this.authHeader = (opts.authHeader || 'bearer').toLowerCase();
    this.extraHeaders = opts.headers || {};
    this.timeoutMs = opts.timeoutMs || 120000;
    this.firstContactTimeoutMs = opts.firstContactTimeoutMs || this.timeoutMs;
    this._contactedModels = new Set();
    /** @type {((model:string, cap:string, val:boolean) => void)|null} */
    this.onCapability = opts.onCapability || null;
    this.messages = {
      create: this._create.bind(this),
      stream: this._stream.bind(this),
    };
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

  _markContacted(model) {
    this._contactedModels.add(model);
  }

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
    const body = toOAIRequest(params);
    const model = body.model || '';
    const timeout = this._timeoutFor(model);
    const maxTokenField = _maxOutputTokenField(params.model);

    try {
      const oaiResp = await this._fetchJSON(body, timeout);
      this._markContacted(model);
      const result = fromOAIResponse(oaiResp);
      // Phantom tool call: server says tool_use but no actual tool blocks parsed
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
      // Retry without tools if server rejects them
      if (err.status === 400 && body.tools?.length && !this._isContextLengthError(err)) {
        if (this.onCapability) this.onCapability(params.model, 'tools', false);
        delete body.tools;
        delete body.tool_choice;
        const oaiResp = await this._fetchJSON(body, timeout);
        this._markContacted(model);
        return fromOAIResponse(oaiResp);
      }
      // Retry with halved output tokens on context-length errors
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
    const origBody = { ...toOAIRequest(params), stream: true, stream_options: { include_usage: true } };
    const model = origBody.model || '';
    const timeout = this._timeoutFor(model);
    const maxTokenField = _maxOutputTokenField(params.model);

    const listeners = { text: [], event: [], end: [] };
    const emit = (type, data) => {
      for (const fn of listeners[type] || []) { try { fn(data); } catch {} }
    };

    // Shared abort controller — wired to both the public .abort() and the fetch signal
    const abortCtrl = new AbortController();

    const done = (async () => {
      let body = origBody;
      let retried = false;

      const runStream = async (streamBody) => {
        // Rolling inactivity timeout — resets every time data arrives so slow
        // models (large tool-call args) don't get killed mid-stream.
        let inactivityTimer = setTimeout(() => abortCtrl.abort(), timeout);
        const resetInactivityTimer = () => {
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => abortCtrl.abort(), timeout);
        };
        let fullText = '';
        let reasoningText = '';   // accumulated thinking/reasoning content
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
            // Stall guard: if vLLM hangs (e.g. tool parser crash), break out
            // after STALL_MS so we can process whatever text we've accumulated.
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

              // Thinking tokens — field name varies by provider:
              //   Qwen → delta.reasoning
              //   DeepSeek / GLM → delta.reasoning_content
              //   Kimi (Moonshot) → delta.thinking (or .reasoning_content, version-dependent)
              const reasoning = delta.reasoning || delta.reasoning_content || delta.thinking || '';
              if (reasoning) {
                reasoningText += reasoning;
                if (!sentThinkingStart) {
                  emit('event', { type: 'content_block_start', content_block: { type: 'thinking' } });
                  sentThinkingStart = true;
                }
                emit('event', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: reasoning } });
              }

              // Text content
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

              // Tool call deltas
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

          // Close any open blocks at stream end
          if (sentThinkingStart) emit('event', { type: 'content_block_stop' });
          if (sentBlockStart) emit('event', { type: 'content_block_stop' });
        } finally {
          clearTimeout(inactivityTimer);
        }

        // Some providers (Kimi K2 Thinking, some DeepSeek flavors) emit the
        // reasoning inline in content wrapped in <think>...</think> instead of
        // via a separate reasoning_content field. Split that out so downstream
        // code sees the real final answer as `text` and the chain-of-thought
        // as `thinking`.
        {
          const thinkRe = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
          let m;
          let stripped = fullText;
          while ((m = thinkRe.exec(fullText)) !== null) {
            reasoningText += (reasoningText ? '\n' : '') + m[1].trim();
          }
          stripped = fullText.replace(thinkRe, '').trim();
          // If there's a lone opening <think> with no closing tag (model was
          // cut off mid-thought), treat everything from <think> onward as
          // reasoning and leave no final text.
          const openOnly = stripped.match(/<think(?:ing)?>([\s\S]*)$/i);
          if (openOnly) {
            reasoningText += (reasoningText ? '\n' : '') + openOnly[1].trim();
            stripped = stripped.replace(/<think(?:ing)?>[\s\S]*$/i, '').trim();
          }
          fullText = stripped;
        }

        // Misconfigured vLLM tunnels (observed on Kimi K2.6 and a few DeepSeek
        // variants) emit the entire output — reasoning AND the final answer —
        // on the `reasoning` channel, leaving `content` null/empty. If the
        // stream finished normally (not truncated) with no text but reasoning
        // filled, treat the reasoning as the final answer so the model is
        // actually usable.
        if (!fullText && reasoningText && stopReason === 'end_turn') {
          fullText = reasoningText;
          reasoningText = '';
        }

        const content = [];
        const serverToolCalls = Object.values(toolCalls);

          if (serverToolCalls.length > 0) {
          // Server parsed tool calls normally
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
          // Check for inline tool calls in text (Qwen/Hermes when vLLM parser fails)
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

        // Surface accumulated reasoning as a thinking block. The probe checks
        // for this as a fallback when text is empty, and preserving it keeps
        // the non-stream parser + streaming parser in sync for reasoning models.
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

// ---------------------------------------------------------------------------
// Gemini (native REST, no SDK dependency)
// ---------------------------------------------------------------------------

class GeminiClient {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs = opts.timeoutMs || 120000;
    this.messages = { create: this._create.bind(this) };
  }

  async _create(params) {
    const model = stripPrefix(params.model);
    const url = `${this.baseURL}/models/${model}:generateContent?key=${this.apiKey}`;

    // Convert Anthropic-style system+messages to Gemini format
    const systemText = Array.isArray(params.system)
      ? params.system.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : (params.system || '');

    const contents = [];
    for (const msg of params.messages || []) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : JSON.stringify(msg.content);
      contents.push({ role, parts: [{ text }] });
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
        headers: { 'Content-Type': 'application/json' },
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate LLM client for a given model string.
 * Falls back to Anthropic for unknown / unprefixed models.
 *
 * @param {string} model          — model identifier (may include prefix)
 * @param {object} config         — full spore config
 * @returns {{ messages: { create: Function }, _backend: string }}
 */
function createClientForModel(model, config) {
  // Register custom provider names so detectBackend/stripPrefix recognize them
  if (config?.customProviders) {
    _customProviderNames = new Set(Object.keys(config.customProviders));
  }

  const backend = detectBackend(model);

  if (backend === 'custom') {
    const prefix = model.substring(0, model.indexOf('/'));
    const prov = config.customProviders?.[prefix];
    if (!prov?.url) throw new Error(`Custom provider '${prefix}' has no URL. Set SPORE_PROVIDER_${prefix.toUpperCase()}_URL`);
    return new OAICompatClient({
      baseURL: prov.url,
      apiKey: prov.key || '',
      authHeader: prov.authHeader || 'bearer',
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }

  if (backend === 'openai') {
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('OpenAI model requested but OPENAI_API_KEY not set');
    return new OAICompatClient({
      baseURL: config.openaiBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey,
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }

  if (backend === 'openrouter') {
    const apiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY || '';
    if (!apiKey) throw new Error('OpenRouter model requested but OPENROUTER_API_KEY not set');
    return new OAICompatClient({
      baseURL: config.openrouterBaseUrl || 'https://openrouter.ai/api/v1',
      apiKey,
      headers: {
        'HTTP-Referer': config.openrouterReferer || 'https://spore.local',
        'X-Title': config.openrouterTitle || (config.displayName || 'SPORE'),
      },
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }

  if (backend === 'local') {
    const baseURL = config.localModelBaseUrl || process.env.LOCAL_MODEL_BASE_URL || 'http://localhost:11434/v1';
    return new OAICompatClient({
      baseURL,
      apiKey: config.localModelApiKey || process.env.LOCAL_MODEL_API_KEY || 'local',
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }

  if (backend === 'gemini') {
    const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
    if (!apiKey) throw new Error('Gemini model requested but GEMINI_API_KEY not set');
    return new GeminiClient({ apiKey, timeoutMs: config.apiTimeoutMs || 120000 });
  }

  // Anthropic (default)
  const isOAuth = config._isOAuth || config.anthropicApiKey?.includes('sk-ant-oat');
  return new Anthropic(
    isOAuth
      ? {
          authToken: config.anthropicApiKey,
          apiKey: null,
          defaultHeaders: {
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
            'user-agent': 'claude-cli/2.1.75',
            'x-app': 'cli',
          },
        }
      : { apiKey: config.anthropicApiKey }
  );
}

/**
 * Create a multi-model provider that routes each call to the right backend
 * based on the model field in the request params.
 *
 * This is what app.js creates once and passes everywhere. Callsites just do
 * provider.messages.create({ model: ..., ... }) and get back the normalized
 * Anthropic-shape response regardless of backend.
 *
 * Clients are cached per model string — no reconnect overhead on repeated calls.
 */
class MultiProvider {
  constructor(config) {
    this.config = config;
    this._cache = new Map();
    /** @type {Map<string, {tools:boolean|null, vision:boolean, audio:boolean, video:boolean}>} */
    this._capabilities = new Map();
    if (config?.customProviders) {
      _customProviderNames = new Set(Object.keys(config.customProviders));
    }
  }

  clearCache() {
    this._cache.clear();
    this._capabilities.clear();
    _customProviderNames = new Set(Object.keys(this.config?.customProviders || {}));
  }

  _clientFor(model) {
    if (!this._cache.has(model)) {
      const client = createClientForModel(model, this.config);
      if (client instanceof OAICompatClient) {
        client.onCapability = (m, cap, val) => this._setCap(m, cap, val);
      }
      this._cache.set(model, client);
    }
    return this._cache.get(model);
  }

  _getCaps(model) {
    if (!this._capabilities.has(model)) {
      this._capabilities.set(model, _inferCapabilities(model));
    }
    return this._capabilities.get(model);
  }

  _setCap(model, cap, val) {
    const caps = this._getCaps(model);
    caps[cap] = val;
  }

  resolveRequest(params) {
    return this._adaptRequest(params);
  }

  resolveModel(params) {
    return this.resolveRequest(params).model;
  }

  /**
   * Adapt a request based on model capabilities:
   *  - Strip tools if model doesn't support them
   *  - Swap to fallback model for vision/audio/video if unsupported
   */
  _adaptRequest(params) {
    let adapted = params;
    const hasDedicatedVlmTiers = Boolean(
      this.config?.imageVlmModel
      || this.config?.videoVlmModel
      || this.config?.audioVlmModel
    );
    let caps = this._getCaps(adapted.model);

    if (_hasTools(adapted) && caps.tools === false) {
      const { tools, tool_choice, ...rest } = adapted;
      adapted = rest;
    }

    if (!hasDedicatedVlmTiers && _hasImages(adapted) && caps.vision === false) {
      const fb = this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
      caps = this._getCaps(adapted.model);
    }

    if (!hasDedicatedVlmTiers && _hasAudio(adapted) && caps.audio === false) {
      const fb = this.config.audioFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
      caps = this._getCaps(adapted.model);
    }

    if (!hasDedicatedVlmTiers && _hasVideo(adapted) && caps.video === false) {
      const fb = this.config.videoFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
    }

    return adapted;
  }

  get messages() {
    return {
      create: (params, opts) => {
        const effective = this.resolveRequest(params);
        const client = this._clientFor(effective.model);
        return client.messages.create(effective, opts);
      },
      stream: (params, opts) => {
        const effective = this.resolveRequest(params);
        const client = this._clientFor(effective.model);
        if (typeof client.messages.stream === 'function') {
          return client.messages.stream(effective, opts);
        }
        const result = client.messages.create(effective, opts);
        return { finalMessage: () => result, on: () => {} };
      },
    };
  }

  /**
   * Pull LLM provider configs from the Manager and merge into config.customProviders.
   * Env vars take precedence — manager-provided configs only fill gaps.
   */
  static async populateProvidersFromManager(config, log) {
    const managerUrl = config.managerUrl;
    const serviceKey = config.managerServiceKey;
    if (!managerUrl || !serviceKey) return;

    const http_ = managerUrl.startsWith('https') ? require('https') : require('http');
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http_.get(`${managerUrl}/api/providers/config`, {
          headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': config.agentId || 'unknown' },
          timeout: 5000,
        }, (res) => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) { resolve(null); return; }
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });

      if (data?.providers) {
        if (!config.customProviders) config.customProviders = {};
        let count = 0;
        for (const [name, prov] of Object.entries(data.providers)) {
          if (config.customProviders[name]) continue;
          config.customProviders[name] = {
            name,
            url: prov.url,
            key: prov.key || '',
            authHeader: prov.authHeader || 'bearer',
          };
          count++;
        }
        if (count > 0 && log) log.info(`[providers] Loaded ${count} provider(s) from manager`);
      }
    } catch {}
  }

  /**
   * Pre-populate config with API keys from the manager vault for any missing inference keys.
   * Call before constructing the MultiProvider. Non-blocking — silently skips on failure.
   */
  static async populateFromVault(config, log) {
    const managerUrl = config.managerUrl;
    const serviceKey = config.managerServiceKey;
    if (!managerUrl || !serviceKey) return;

    const keyMap = {
      ANTHROPIC_API_KEY: 'anthropicApiKey',
      OPENROUTER_API_KEY: 'openrouterApiKey',
      OPENAI_API_KEY: 'openaiApiKey',
      GEMINI_API_KEY: 'geminiApiKey',
      LOCAL_MODEL_API_KEY: 'localModelApiKey',
      DEEPGRAM_API_KEY: 'deepgramApiKey',
      XI_API_KEY: 'xiApiKey',
      REPLICATE_API_TOKEN: 'replicateApiToken',
      BRAVE_API_KEY: 'braveApiKey',
    };

    const missing = Object.entries(keyMap).filter(([envName, configKey]) => !config[configKey] && !process.env[envName]);
    if (missing.length === 0) return;

    const http_ = managerUrl.startsWith('https') ? require('https') : require('http');

    for (const [envName, configKey] of missing) {
      try {
        const val = await new Promise((resolve, reject) => {
          const req = http_.get(`${managerUrl}/api/vault/key?name=${encodeURIComponent(envName)}`, {
            headers: { 'X-Service-Key': serviceKey, 'X-SPORE-Id': config.agentId || 'unknown' },
            timeout: 5000,
          }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              if (res.statusCode !== 200) { resolve(null); return; }
              try {
                const parsed = JSON.parse(data);
                resolve(parsed.value || null);
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });

        if (val) {
          config[configKey] = val;
          process.env[envName] = val;
          if (log) log.info(`[vault] Loaded ${envName} from vault`);
        }
      } catch {}
    }
  }
}

module.exports = { MultiProvider, createClientForModel, detectBackend, stripPrefix, _hasImages, _inferCapabilities };
