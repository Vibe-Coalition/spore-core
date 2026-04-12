/**
 * providers/index.js — Unified LLM provider abstraction
 *
 * Supports multiple backends, chosen by model string prefix:
 *
 *   Anthropic (default):  model = "claude-*" or no prefix
 *   OpenRouter:           model = "openrouter/<model>"
 *   Local (OAI-compat):   model = "local/<model>"     (Ollama / LM Studio / vLLM)
 *   Gemini:               model = "gemini/<model>"
 *   Custom providers:     model = "<name>/<model>"     (any OAI-compat endpoint via ANIMA_PROVIDER_<NAME>_URL)
 *
 * All backends expose the same interface:
 *
 *   provider.messages.create({ model, max_tokens, system, messages, tools? })
 *     → { content: [{type:'text',text},...], usage: {input_tokens, output_tokens}, stop_reason }
 *
 * Vision auto-routing: when the active model lacks VLM support and the message
 * contains images, MultiProvider transparently swaps to visionFallbackModel for
 * that single API call.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _BUILTIN_PREFIXES = new Set(['openrouter', 'local', 'gemini']);

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
  if (backend === 'gemini')    return { tools: true, vision: true, audio: true,  video: true  };

  const name = stripPrefix(model).toLowerCase();
  return {
    tools:  null,
    vision: _VISION_PATTERNS.test(name) ? true : false,
    audio:  _AUDIO_PATTERNS.test(name)  ? true : false,
    video:  _VIDEO_PATTERNS.test(name)  ? true : false,
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
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        })),
      };
      oaiMessages.push(oaiMsg);
      continue;
    }

    // Multimodal: text + image blocks → OAI content array
    const imageBlocks = msg.content.filter(b => b.type === 'image');
    if (imageBlocks.length > 0) {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` },
          });
        }
      }
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
    max_tokens: params.max_tokens,
    messages: oaiMessages,
  };
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
          name: parsed.name,
          input: parsed.arguments || {},
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
      toolBlocks.push({ type: 'tool_use', id: `tc_${toolBlocks.length}`, name, input });
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

  const text = msg.content || msg.reasoning_content || msg.reasoning || '';

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    if (text) content.push({ type: 'text', text });
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (parseErr) {
        input = { _parse_error: `Tool arguments were malformed JSON and could not be parsed. Raw args (first 500 chars): ${(tc.function.arguments || '').substring(0, 500)}` };
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
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
    this.firstContactTimeoutMs = opts.firstContactTimeoutMs || 10000;
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
      // Retry with halved max_tokens on context-length errors
      if (this._isContextLengthError(err) && body.max_tokens > 512) {
        body.max_tokens = Math.floor(body.max_tokens / 2);
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

              // Thinking tokens (Qwen: delta.reasoning, others: delta.reasoning_content)
              const reasoning = delta.reasoning || delta.reasoning_content || '';
              if (reasoning) {
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
                  if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
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

        const content = [];
        const serverToolCalls = Object.values(toolCalls);

        if (serverToolCalls.length > 0) {
          // Server parsed tool calls normally
          if (fullText) content.push({ type: 'text', text: fullText });
          for (const tc of serverToolCalls) {
            let input = {};
            try { input = JSON.parse(tc.args || '{}'); } catch (parseErr) {
              input = { _parse_error: `Tool arguments were malformed JSON and could not be parsed. Raw args (first 500 chars): ${(tc.args || '').substring(0, 500)}` };
            }
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
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
        if (self._isContextLengthError(err) && body.max_tokens > 512) {
          body.max_tokens = Math.floor(body.max_tokens / 2);
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
 * @param {object} config         — full anima config
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
    if (!prov?.url) throw new Error(`Custom provider '${prefix}' has no URL. Set ANIMA_PROVIDER_${prefix.toUpperCase()}_URL`);
    return new OAICompatClient({
      baseURL: prov.url,
      apiKey: prov.key || '',
      authHeader: prov.authHeader || 'bearer',
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
        'HTTP-Referer': config.openrouterReferer || 'https://anima.local',
        'X-Title': config.openrouterTitle || (config.displayName || 'Anima'),
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

  /**
   * Adapt a request based on model capabilities:
   *  - Strip tools if model doesn't support them
   *  - Swap to fallback model for vision/audio/video if unsupported
   */
  _adaptRequest(params) {
    let adapted = params;
    const caps = this._getCaps(params.model);

    if (_hasTools(adapted) && caps.tools === false) {
      const { tools, tool_choice, ...rest } = adapted;
      adapted = rest;
    }

    if (_hasImages(adapted) && !caps.vision) {
      const fb = this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
    }

    if (_hasAudio(adapted) && !caps.audio) {
      const fb = this.config.audioFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
    }

    if (_hasVideo(adapted) && !caps.video) {
      const fb = this.config.videoFallbackModel || this.config.visionFallbackModel || this.config.model;
      if (fb) adapted = { ...adapted, model: fb };
    }

    return adapted;
  }

  get messages() {
    return {
      create: (params, opts) => {
        const effective = this._adaptRequest(params);
        const client = this._clientFor(effective.model);
        return client.messages.create(effective, opts);
      },
      stream: (params, opts) => {
        const effective = this._adaptRequest(params);
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
          headers: { 'X-Service-Key': serviceKey, 'X-Anima-Id': config.agentId || 'unknown' },
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
            headers: { 'X-Service-Key': serviceKey, 'X-Anima-Id': config.agentId || 'unknown' },
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
