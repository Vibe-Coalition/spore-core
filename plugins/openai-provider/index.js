// openai-provider plugin — native OpenAI Responses API.
//
// This provider intentionally owns the official OpenAI wire format itself.
// OpenAI-compatible /chat/completions endpoints belong to local-oai-provider.
// Claims the 'openai' model prefix.

// OpenAI's official /v1/models API only returns basic model objects
// (id/object/created/owned_by). Context/max-output are therefore
// populated from endpoint metadata fields where available; gpt-5
// context is auto-probed from OpenAI's own over-limit errors when the
// model list does not expose sizing. No baked local context table.
//
// capabilities = (model supports it) ∧ (our Responses transport supports it):
//   - vision: gpt-4o, gpt-4.1, gpt-4-turbo, o1, o3, o4 — yes. gpt-3.5,
//     legacy gpt-4 (8K/32K), o1-mini, o1-preview — no.
//   - audio: NO across the board. gpt-4o-audio-preview is the only OAI
//     model that takes audio input, and our model-list filter
//     drops it (see _OPENAI_NON_CHAT_TOKEN). Real-time audio uses a
//     different endpoint we don't speak.
//   - video: NO. This provider does not convert video blocks into Responses input.
const _VIS = { tools: true, vision: true, audio: false, video: false };
const _TXT = { tools: true, vision: false, audio: false, video: false };
const _DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const _OPENAI_CONTEXT_PROBE_CACHE = new Map();
const _OPENAI_CONTEXT_PROBE_INPUT_TOKENS = Math.max(
  100000,
  Number(process.env.OPENAI_CONTEXT_PROBE_INPUT_TOKENS || 1200000),
);
const _OPENAI_CONTEXT_PROBE_MAX_FAMILIES = Math.max(
  1,
  Number(process.env.OPENAI_CONTEXT_PROBE_MAX_FAMILIES || 24),
);
const _OPENAI_CONTEXT_PROBE_TTL_MS = Math.max(
  60000,
  Number(process.env.OPENAI_CONTEXT_PROBE_TTL_MS || 6 * 60 * 60 * 1000),
);
function _isOpenAIReasoningModel(model) {
  const bare = _stripOpenAIPrefix(model).toLowerCase();
  return /^(o1|o3|o4|gpt-5(?:[.\-]|$))/.test(bare);
}

// OpenAI reasoning-effort translator — categorical effort → Responses
// `reasoning.effort`. gpt-5 family accepts 'minimal' as a value; the
// o-series (o1/o3/o4) does not, so collapse minimal→low for those.
// 'off' deletes the field so the request stays a plain Responses call.
function applyOpenAIReasoningEffort(req, model, effort) {
  if (!_isOpenAIReasoningModel(model)) return req;
  const bare = _stripOpenAIPrefix(model).toLowerCase();
  const out = { ...req };
  if (effort === 'off') {
    delete out.reasoning;
    delete out.reasoning_effort;
    return out;
  }
  const supportsMinimal = /^gpt-5(?:[.\-]|$)/.test(bare);
  let v = effort;
  if (v === 'max') v = 'high';
  if (v === 'minimal' && !supportsMinimal) v = 'low';
  out.reasoning = { ...(out.reasoning && typeof out.reasoning === 'object' ? out.reasoning : {}), effort: v };
  delete out.reasoning_effort;
  return out;
}

// Filter: tier-routable Responses models only.
// Drop embedding/audio/image/moderation lines AND specialty variants
// (deep-research, realtime, audio, image, search-preview, transcribe,
// tts, codex, instruct/base legacy) that aren't routable through this
// provider. Without this filter, OpenAI's /v1/models
// returns 100+ ids — the tier dropdown becomes unusable.
const _OPENAI_NON_CHAT_PREFIX = /^(text-embedding-|tts-|whisper-|dall-e-|omni-moderation-|babbage-|davinci-|computer-use-|codex-|chatgpt-image-)/;
// Substring patterns — these tokens make a model non-chat regardless
// of their position in the id (gpt-image-X, gpt-4o-realtime-Y, etc.).
const _OPENAI_NON_CHAT_TOKEN = /(?:^|-)(realtime|audio|image|transcribe|tts|codex|deep-research|search-preview|search-api|instruct|base)(?:-|$)/;
function _isOpenAIChatModel(id) {
  if (!id) return false;
  if (_OPENAI_NON_CHAT_PREFIX.test(id)) return false;
  if (_OPENAI_NON_CHAT_TOKEN.test(id)) return false;
  return /^(gpt-|o\d|chatgpt-)/i.test(id);
}

function _usableDiscoveredLimit(value, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return null;
  return Math.floor(n);
}

function _familyForOpenAIModel(id) {
  const m = String(id || '').toLowerCase();
  if (/^(o1|o3|o4)/.test(m)) return 'reasoning';
  if (/^(gpt-|chatgpt-)/.test(m)) return 'gpt';
  return null;
}

function _capabilitiesForOpenAIModel(id) {
  const m = String(id || '').toLowerCase();
  if (/^(gpt-3\.5|gpt-4(?:-|$)|o1-mini|o1-preview)/.test(m)) return _TXT;
  return _VIS;
}

const _TOOL_NAME_ALIASES = new Map([
  ['graph', 'graph_update'],
  ['analyze', 'analyze_media'],
]);

function _normalizeToolName(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  return _TOOL_NAME_ALIASES.get(trimmed.toLowerCase()) || trimmed;
}

function _stripOpenAIPrefix(model) {
  const raw = String(model || '').trim();
  return raw.startsWith('openai/') ? raw.slice('openai/'.length) : raw;
}

function _systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n\n')
      .trim();
  }
  return '';
}

function _contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'tool_result') return _contentToText(part.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function _safeJsonParse(raw, fallback = {}) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) {
    return {
      _parse_error: `Tool arguments were malformed JSON and could not be parsed. Raw args (first 500 chars): ${text.substring(0, 500)}`,
    };
  }
}

function _responseMessageContentFromBlocks(blocks, role) {
  const content = [];
  for (const block of blocks || []) {
    if (block?.type === 'text' && block.text) {
      content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
    } else if (role !== 'assistant' && block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
      content.push({
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
      });
    } else if (role !== 'assistant' && block?.type === 'file' && block.source?.type === 'base64' && block.source.data) {
      content.push({
        type: 'input_file',
        filename: block.source.filename || 'input-file',
        file_data: `data:${block.source.media_type || 'application/octet-stream'};base64,${block.source.data}`,
      });
    }
  }
  return content;
}

function _pushResponsesInputForMessage(input, msg) {
  const role = msg?.role || 'user';
  const content = msg?.content;
  if (typeof content === 'string') {
    input.push({
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
    });
    return;
  }
  if (!Array.isArray(content)) return;

  const textBlocks = content.filter(b => b?.type === 'text');
  const toolUseBlocks = content.filter(b => b?.type === 'tool_use');
  const toolResultBlocks = content.filter(b => b?.type === 'tool_result');

  if (toolResultBlocks.length > 0) {
    for (const tr of toolResultBlocks) {
      input.push({
        type: 'function_call_output',
        call_id: tr.tool_use_id,
        output: _contentToText(tr.content),
      });
    }
    return;
  }

  if (role === 'assistant') {
    const text = textBlocks.map(b => b.text || '').join('');
    if (text) {
      input.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const tu of toolUseBlocks) {
      input.push({
        type: 'function_call',
        call_id: tu.id,
        name: _normalizeToolName(tu.name),
        arguments: JSON.stringify(tu.input || {}),
      });
    }
    return;
  }

  const converted = _responseMessageContentFromBlocks(content, role);
  if (converted.length > 0) {
    input.push({ type: 'message', role, content: converted });
  }
}

function _toResponsesToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' && choice.name) return { type: 'function', name: choice.name };
  if (choice.type === 'function' && choice.function?.name) return { type: 'function', name: choice.function.name };
  if ((choice.type === 'tool' || choice.type === 'function') && choice.name) return { type: 'function', name: choice.name };
  if (choice.name) return { type: 'function', name: choice.name };
  return null;
}

function _normalizeToolParameters(schema) {
  const normalized = _normalizeOpenAIToolSchema(schema);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return { type: 'object', properties: {} };
  }
  if (normalized.type !== 'object') normalized.type = 'object';
  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function _normalizeOpenAIToolSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return _sanitizeOpenAIJsonSchema(schema);
}

function _sanitizeOpenAIJsonSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  if (depth > 24) return {};

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || typeof value === 'function') continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        out.properties[propName] = _sanitizeOpenAIJsonSchema(propSchema, depth + 1);
      }
      continue;
    }
    if (key === 'items') {
      if (Array.isArray(value)) {
        out.items = value.length > 0 ? _sanitizeOpenAIJsonSchema(value[0], depth + 1) : {};
      } else if (value && typeof value === 'object') {
        out.items = _sanitizeOpenAIJsonSchema(value, depth + 1);
      } else {
        out.items = {};
      }
      continue;
    }
    if ((key === 'additionalProperties' || key === 'propertyNames') && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = _sanitizeOpenAIJsonSchema(value, depth + 1);
      continue;
    }
    if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
      out[key] = value.map(v => _sanitizeOpenAIJsonSchema(v, depth + 1));
      continue;
    }
    if (['not', 'if', 'then', 'else', 'contains'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = _sanitizeOpenAIJsonSchema(value, depth + 1);
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch (_) {
      // Ignore unserializable schema metadata; OpenAI only needs JSON schema.
    }
  }

  const type = Array.isArray(out.type) ? out.type : [out.type].filter(Boolean);
  if (type.includes('array') && !Object.prototype.hasOwnProperty.call(out, 'items')) {
    out.items = {};
  }
  if (type.includes('object') && out.properties && typeof out.properties === 'object') {
    const required = Array.isArray(out.required) ? out.required.filter(name => typeof name === 'string') : null;
    if (required) out.required = required;
  }
  return out;
}

function _toOpenAIResponsesRequest(params, opts = {}) {
  const input = [];
  for (const msg of params.messages || []) _pushResponsesInputForMessage(input, msg);
  if (input.length === 0) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: ' ' }] });
  }

  const body = {
    model: _stripOpenAIPrefix(params.model),
    input,
  };

  const instructions = _systemText(params.system);
  if (instructions) body.instructions = instructions;
  if (params.max_tokens != null) body.max_output_tokens = params.max_tokens;
  if (opts.stream) body.stream = true;

  const reasoning = params.reasoning && typeof params.reasoning === 'object'
    ? params.reasoning
    : (params.reasoning_effort ? { effort: params.reasoning_effort } : null);
  if (reasoning?.effort) body.reasoning = reasoning;

  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: _normalizeToolParameters(t.input_schema || t.parameters),
    }));
    body.tool_choice = _toResponsesToolChoice(params.tool_choice || params.toolChoice) || 'auto';
  }

  return body;
}

function _withOpenAIModelMetadata(_raw, base) {
  if (!_isOpenAIChatModel(base?.id)) return null;
  const discoveredContext = _usableDiscoveredLimit(base.contextLength, 1024);
  const discoveredOutput = _usableDiscoveredLimit(base.maxOutput, 256);
  const cleanBase = {
    ...base,
    contextLength: discoveredContext,
    family: _familyForOpenAIModel(base.id),
    capabilities: _capabilitiesForOpenAIModel(base.id),
  };
  if (discoveredOutput) cleanBase.maxOutput = discoveredOutput;
  else delete cleanBase.maxOutput;
  return cleanBase;
}

function _normalizeOpenAIModelFamily(id) {
  const raw = String(id || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{4}$/, '');
}

function _parseOpenAIContextLimitFromError(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || {});
  const patterns = [
    /configured limit of\s+([\d,]+)\s+tokens/i,
    /maximum context length is\s+([\d,]+)\s+tokens/i,
    /max(?:imum)?(?:\s+input)?(?:\s+context)?(?:\s+length)?\s*(?:is|of|:)\s*([\d,]+)\s+tokens/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1024) return Math.floor(n);
  }
  return null;
}

function _isOpenAIChatUnsupportedError(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || {});
  return /not a chat model|not supported in (?:the )?v1\/chat\/completions endpoint|only supported in v1\/responses/i.test(s);
}

function _isOpenAIResponsesUnsupportedError(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || {});
  return /not supported in (?:the )?v1\/responses endpoint|only supported in v1\/chat\/completions|not a responses model/i.test(s);
}

function _isOfficialOpenAIBaseUrl(baseUrl) {
  if (process.env.OPENAI_CONTEXT_PROBE_ANY_BASE_URL === '1') return true;
  try {
    const host = new URL(baseUrl || 'https://api.openai.com/v1').hostname.toLowerCase();
    return host === 'api.openai.com';
  } catch (_) {
    return false;
  }
}

function _makeContextProbeInput(tokens = _OPENAI_CONTEXT_PROBE_INPUT_TOKENS) {
  return 'x '.repeat(Math.max(1, Math.floor(tokens)));
}

function _cacheGet(cacheKey) {
  const row = _OPENAI_CONTEXT_PROBE_CACHE.get(cacheKey);
  if (!row) return undefined;
  if ((Date.now() - row.ts) > _OPENAI_CONTEXT_PROBE_TTL_MS) {
    _OPENAI_CONTEXT_PROBE_CACHE.delete(cacheKey);
    return undefined;
  }
  return row.value;
}

function _cacheSet(cacheKey, value) {
  _OPENAI_CONTEXT_PROBE_CACHE.set(cacheKey, { ts: Date.now(), value });
}

function _selectOpenAIContextProbeTargets(models, maxFamilies = _OPENAI_CONTEXT_PROBE_MAX_FAMILIES) {
  const groups = new Map();
  for (const model of models || []) {
    if (model?.contextLength || !_isOpenAIChatModel(model?.id)) continue;
    const family = _normalizeOpenAIModelFamily(model.id);
    if (!family) continue;
    const prev = groups.get(family);
    if (!prev || model.id.length < prev.id.length || model.id === family) {
      groups.set(family, model);
    }
  }
  return Array.from(groups.entries())
    .map(([family, model]) => ({ family, modelId: model.id }))
    .sort((a, b) => a.family.localeCompare(b.family))
    .slice(0, maxFamilies);
}

function _applyOpenAIContextProbeResults(models, byFamily) {
  if (!byFamily || byFamily.size === 0) return models;
  return (models || []).map(model => {
    if (model?.contextLength || !_isOpenAIChatModel(model?.id)) return model;
    const family = _normalizeOpenAIModelFamily(model.id);
    const probe = byFamily.get(family);
    if (probe?.responsesSupported === false || probe?.chatSupported === false) return null;
    const contextLength = _usableDiscoveredLimit(
      typeof probe === 'number' ? probe : probe?.contextLength,
      1024,
    );
    if (!contextLength) return model;
    return {
      ...model,
      contextLength,
      contextSource: 'openai-overflow-probe',
    };
  }).filter(Boolean);
}

async function _probeOpenAIContextLimit({ baseUrl, apiKey, modelId, fetchImpl = fetch, logger } = {}) {
  if (!apiKey || !modelId || !_isOfficialOpenAIBaseUrl(baseUrl)) {
    return { contextLength: null, responsesSupported: true };
  }
  const cleanBaseUrl = (baseUrl || _DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
  const url = cleanBaseUrl + '/responses';
  const body = {
    model: modelId,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: _makeContextProbeInput() }] }],
    max_output_tokens: 16,
  };
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const text = await r.text().catch(() => '');
    if (r.ok) return { contextLength: null, responsesSupported: true };
    return {
      contextLength: _parseOpenAIContextLimitFromError(text),
      responsesSupported: !_isOpenAIResponsesUnsupportedError(text),
    };
  } catch (e) {
    logger?.debug?.(`OpenAI context probe failed for ${modelId}: ${e.message || e}`);
    return { contextLength: null, responsesSupported: true };
  }
}

async function _autoprobeOpenAIContextLengths(models, { baseUrl, apiKey, logger } = {}) {
  if (!apiKey || !_isOfficialOpenAIBaseUrl(baseUrl)) return models;
  const targets = _selectOpenAIContextProbeTargets(models);
  if (targets.length === 0) return models;

  const byFamily = new Map();
  const baseKey = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '').toLowerCase();
  for (const target of targets) {
    const cacheKey = `${baseKey}|${target.family}`;
    let probe = _cacheGet(cacheKey);
    if (probe === undefined) {
      probe = await _probeOpenAIContextLimit({ baseUrl, apiKey, modelId: target.modelId, logger });
      _cacheSet(cacheKey, probe || { contextLength: null, chatSupported: true });
    }
    if (probe?.contextLength || probe?.responsesSupported === false || probe?.chatSupported === false) {
      byFamily.set(target.family, probe);
    }
  }
  return _applyOpenAIContextProbeResults(models, byFamily);
}

function _usageFromResponsesPayload(payload) {
  const usage = payload?.usage || {};
  const inputTotal = Number(usage.input_tokens) || 0;
  const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, inputTotal - cached),
    output_tokens: Number(usage.output_tokens) || 0,
  };
}

function _stopReasonFromResponses(payload, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  if (payload?.status === 'incomplete') return 'max_tokens';
  return 'end_turn';
}

function _thinkingFromReasoningItem(item) {
  if (Array.isArray(item?.summary)) {
    return item.summary.map(part => part?.text || '').filter(Boolean).join('\n\n');
  }
  return '';
}

function _contentFromResponsesPayload(payload) {
  const content = [];
  for (const item of payload?.output || []) {
    if (item?.type === 'message') {
      const text = (item.content || [])
        .map(part => part?.type === 'output_text' ? (part.text || '') : (part?.refusal || ''))
        .join('');
      if (text) content.push({ type: 'text', text });
    } else if (item?.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: _normalizeToolName(item.name),
        input: _safeJsonParse(item.arguments, {}),
      });
    } else if (item?.type === 'reasoning') {
      const thinking = _thinkingFromReasoningItem(item);
      if (thinking) content.push({ type: 'thinking', thinking });
    }
  }
  if (content.length === 0 && payload?.output_text) {
    content.push({ type: 'text', text: String(payload.output_text) });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return content;
}

function _fromOpenAIResponsesPayload(payload) {
  const content = _contentFromResponsesPayload(payload);
  const hasToolUse = content.some(block => block.type === 'tool_use');
  return {
    content,
    usage: _usageFromResponsesPayload(payload),
    stop_reason: _stopReasonFromResponses(payload, hasToolUse),
  };
}

function _parseResponsesSSELineBuffer(buffer, onEvent) {
  let eventName = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const typeName = eventName;
    const data = dataLines.join('\n').trim();
    eventName = '';
    dataLines = [];
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    if (!event.type && typeName) event.type = typeName;
    onEvent(event);
  };

  for (const rawLine of buffer.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
}

class OpenAIResponsesClient {
  constructor(opts = {}) {
    this.baseURL = (opts.baseURL || _DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = opts.timeoutMs || 120000;
    this.firstContactTimeoutMs = opts.firstContactTimeoutMs || Math.max(this.timeoutMs, 180000);
    this._contactedModels = new Set();
    this.onCapability = opts.onCapability || null;
    this.messages = {
      create: this._create.bind(this),
      stream: this._stream.bind(this),
    };
  }

  _timeoutFor(model) {
    return this._contactedModels.has(model) ? this.timeoutMs : this.firstContactTimeoutMs;
  }

  _markContacted(model) {
    this._contactedModels.add(model);
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  _isContextLengthError(err) {
    return err.status === 400 && /context length|max.*token|maximum.*length|too many tokens|configured limit/i.test(err.message);
  }

  async _fetchResponses(body, { signal, timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`OpenAI Responses HTTP ${res.status}: ${errText.substring(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async _create(params, opts = {}) {
    let body = _toOpenAIResponsesRequest(params);
    const model = body.model || '';
    const timeoutMs = this._timeoutFor(model);
    try {
      const res = await this._fetchResponses(body, { signal: opts?.signal, timeoutMs });
      const payload = await res.json();
      this._markContacted(model);
      if (body.tools?.length && this.onCapability) this.onCapability(params.model, 'tools', true);
      return _fromOpenAIResponsesPayload(payload);
    } catch (err) {
      if (this._isContextLengthError(err) && body.max_output_tokens > 512) {
        body = { ...body, max_output_tokens: Math.floor(body.max_output_tokens / 2) };
        const res = await this._fetchResponses(body, { signal: opts?.signal, timeoutMs });
        const payload = await res.json();
        this._markContacted(model);
        return _fromOpenAIResponsesPayload(payload);
      }
      throw err;
    }
  }

  _stream(params, opts = {}) {
    const body = _toOpenAIResponsesRequest(params, { stream: true });
    const model = body.model || '';
    const listeners = { text: [], event: [], end: [] };
    const emit = (type, data) => {
      for (const fn of listeners[type] || []) {
        try { fn(data); } catch (e) { console.warn('[openai-provider] stream listener failed: ' + e.message); }
      }
    };
    const abortCtrl = new AbortController();
    const onExternalAbort = () => abortCtrl.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) abortCtrl.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const done = (async () => {
      try {
        return await this._runStream(body, params.model, emit, abortCtrl.signal);
      } finally {
        if (opts?.signal) opts.signal.removeEventListener('abort', onExternalAbort);
        emit('end', undefined);
      }
    })();

    return {
      on(event, cb) { (listeners[event] || []).push(cb); return this; },
      abort() { abortCtrl.abort(); },
      async finalMessage() { return done; },
    };
  }

  async _runStream(body, paramsModel, emit, signal) {
    const model = body.model || '';
    const timeoutMs = this._timeoutFor(model);
    const res = await this._fetchResponses(body, { signal, timeoutMs });
    this._markContacted(model);
    if (body.tools?.length && this.onCapability) this.onCapability(paramsModel, 'tools', true);

    if (!res.body?.getReader) {
      const payload = await res.json();
      return _fromOpenAIResponsesPayload(payload);
    }

    const state = {
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      textOpen: false,
      thinkingOpen: false,
      toolsByItem: new Map(),
    };

    const finishText = () => {
      if (!state.textOpen) return;
      emit('event', { type: 'content_block_stop' });
      state.textOpen = false;
    };
    const finishThinking = () => {
      if (!state.thinkingOpen) return;
      emit('event', { type: 'content_block_stop' });
      state.thinkingOpen = false;
    };
    const ensureText = () => {
      finishThinking();
      if (state.textOpen) return state.content[state.content.length - 1];
      const block = { type: 'text', text: '' };
      state.content.push(block);
      state.textOpen = true;
      emit('event', { type: 'content_block_start', content_block: { type: 'text', text: '' } });
      return block;
    };
    const ensureThinking = () => {
      finishText();
      if (state.thinkingOpen) return state.content[state.content.length - 1];
      const block = { type: 'thinking', thinking: '' };
      state.content.push(block);
      state.thinkingOpen = true;
      emit('event', { type: 'content_block_start', content_block: { type: 'thinking' } });
      return block;
    };
    const ensureTool = (item = {}) => {
      finishText();
      finishThinking();
      const key = item.id || item.item_id || item.call_id || `tool_${state.toolsByItem.size}`;
      let block = state.toolsByItem.get(key);
      if (block) return block;
      block = {
        type: 'tool_use',
        id: item.call_id || item.id || key,
        name: _normalizeToolName(item.name || ''),
        input: {},
        _partialJson: typeof item.arguments === 'string' ? item.arguments : '',
        _stopped: false,
      };
      state.content.push(block);
      state.toolsByItem.set(key, block);
      if (item.call_id) state.toolsByItem.set(item.call_id, block);
      emit('event', {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      });
      return block;
    };
    const finishTool = (block, item = {}) => {
      if (!block) return;
      if (item.name) block.name = _normalizeToolName(item.name);
      if (item.call_id) block.id = item.call_id;
      if (block._stopped) return;
      const args = typeof item.arguments === 'string' && item.arguments
        ? item.arguments
        : block._partialJson;
      block.input = _safeJsonParse(args, {});
      delete block._partialJson;
      block._stopped = true;
      emit('event', { type: 'content_block_stop' });
    };
    const processEvent = (event) => {
      const type = event?.type;
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = String(event.delta || '');
        if (!delta) return;
        const block = ensureText();
        block.text += delta;
        emit('text', delta);
        emit('event', { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } });
      } else if (type === 'response.reasoning_summary_text.delta') {
        const delta = String(event.delta || '');
        if (!delta) return;
        const block = ensureThinking();
        block.thinking += delta;
        emit('event', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: delta } });
      } else if (type === 'response.output_item.added') {
        if (event.item?.type === 'function_call') ensureTool(event.item);
        if (event.item?.type === 'reasoning') ensureThinking();
      } else if (type === 'response.function_call_arguments.delta') {
        const block = ensureTool({ id: event.item_id });
        const delta = String(event.delta || '');
        block._partialJson = `${block._partialJson || ''}${delta}`;
        emit('event', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: delta } });
        emit('event', { type: 'tool_use_delta', name: block.name, argsLength: block._partialJson.length });
      } else if (type === 'response.function_call_arguments.done') {
        const block = ensureTool({ id: event.item_id, name: event.name });
        finishTool(block, { name: event.name, arguments: event.arguments });
      } else if (type === 'response.output_item.done') {
        const item = event.item || {};
        if (item.type === 'function_call') {
          const block = ensureTool(item);
          finishTool(block, item);
        } else if (item.type === 'message') {
          const text = (item.content || [])
            .map(part => part?.type === 'output_text' ? (part.text || '') : (part?.refusal || ''))
            .join('');
          if (text && state.textOpen) {
            const block = state.content[state.content.length - 1];
            if (block?.type === 'text') block.text = text;
          }
          finishText();
        } else if (item.type === 'reasoning') {
          const thinking = _thinkingFromReasoningItem(item);
          if (thinking && state.thinkingOpen) {
            const block = state.content[state.content.length - 1];
            if (block?.type === 'thinking') block.thinking = thinking;
          }
          finishThinking();
        }
      } else if (type === 'response.completed') {
        const payload = event.response || {};
        state.usage = _usageFromResponsesPayload(payload);
        const hasToolUse = state.content.some(block => block.type === 'tool_use');
        state.stop_reason = _stopReasonFromResponses(payload, hasToolUse);
      } else if (type === 'response.failed') {
        const err = event.response?.error;
        throw new Error(err?.message || err?.code || 'OpenAI response failed');
      } else if (type === 'error') {
        throw new Error(event.message || event.error?.message || 'OpenAI stream error');
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const boundary = buffer.lastIndexOf('\n\n');
      if (boundary === -1) continue;
      const chunk = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      _parseResponsesSSELineBuffer(chunk, processEvent);
    }
    if (buffer.trim()) _parseResponsesSSELineBuffer(buffer + '\n\n', processEvent);

    finishText();
    finishThinking();
    for (const block of state.content.filter(b => b.type === 'tool_use')) {
      finishTool(block);
    }

    for (const block of state.content) {
      delete block._partialJson;
      delete block._stopped;
    }
    if (state.content.length === 0) state.content.push({ type: 'text', text: '' });
    if (state.content.some(block => block.type === 'tool_use')) state.stop_reason = 'tool_use';
    return { content: state.content, usage: state.usage, stop_reason: state.stop_reason };
  }
}

async function _listOpenAIModels({ baseUrl, apiKey, transform } = {}) {
  if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 160) : ''}` };
    }
    const d = await r.json().catch(() => null);
    const arr = Array.isArray(d?.data) ? d.data : null;
    if (!arr) return { ok: false, error: 'no `data` array in response' };
    const models = arr.map(m => {
      if (typeof m === 'string') return { id: m, contextLength: null };
      const id = m?.id || m?.name || '';
      if (!id) return null;
      const base = {
        id,
        contextLength: null,
        ...(m.display_name || (m.name && !m.id) ? { displayName: m.display_name || m.name } : {}),
      };
      return transform ? transform(m, base) : base;
    }).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const patch = {};
  if (host?.openaiApiKey) patch.apiKey = host.openaiApiKey;
  if (host?.openaiBaseUrl) patch.baseUrl = host.openaiBaseUrl;
  if (Object.keys(patch).length > 0) {
    api.setConfig(patch).catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info(`Migrated legacy openaiApiKey/baseUrl into plugins.openai-provider.${Object.keys(patch).join(', ')}`);
  }
}

function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider('openai', (config) => {
    const slot = config?.plugins?.['openai-provider'] || {};
    // Env wins over slot — Settings-pane Save with stale defaults must
    // not poison what the wizard / .env wrote.
    const apiKey = process.env.OPENAI_API_KEY || config.openaiApiKey || slot.apiKey || '';
    if (!apiKey) throw new Error('OpenAI provider: no API key (set plugins.openai-provider.apiKey or OPENAI_API_KEY)');
    return new OpenAIResponsesClient({
      baseURL: process.env.OPENAI_BASE_URL || config.openaiBaseUrl || slot.baseUrl || 'https://api.openai.com/v1',
      apiKey,
      timeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['openai'],
    label: 'OpenAI',
    modelsPlaceholder: 'gpt-4o, gpt-4o-mini',
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['openai-provider'] || {};
      return !!(process.env.OPENAI_API_KEY || config?.openaiApiKey || slot.apiKey);
    },
    defaultBaseUrl: 'https://api.openai.com/v1',
    // Wizard/settings model discovery hits this. Official OpenAI
    // /v1/models gives id + ownership only, so gpt-5 context is
    // discovered with a cached over-limit probe when the model list
    // does not expose real sizing fields.
    listModels: async (body) => {
      const host = api.getHostConfig();
      const slot = api.getConfig();
      const apiKey = (body?.apiKey || '').trim()
        || process.env.OPENAI_API_KEY
        || host?.openaiApiKey
        || slot?.apiKey
        || '';
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.OPENAI_BASE_URL
        || host?.openaiBaseUrl
        || slot?.baseUrl
        || 'https://api.openai.com/v1';
      const r = await _listOpenAIModels({
        baseUrl, apiKey,
        transform: _withOpenAIModelMetadata,
      });
      if (!r.ok) return r;
      // Strip nulls left by transform's filter, sort newest-first.
      const probed = await _autoprobeOpenAIContextLengths(r.models.filter(Boolean), {
        baseUrl,
        apiKey,
        logger: api.getLogger?.(),
      });
      const models = probed.sort((a, b) => b.id.localeCompare(a.id));
      return { ok: true, models };
    },
    applyReasoningEffort: applyOpenAIReasoningEffort,
    // host config field is `openaiReasoningEffort` (categorical:
    // off/minimal/low/medium/high/max). Pass straight through — the
    // applyReasoningEffort translator handles gpt-5 vs o-series
    // 'minimal' compatibility.
    getDefaultReasoningEffort: (model, hostConfig) => {
      if (!_isOpenAIReasoningModel(model)) return null;
      return hostConfig?.openaiReasoningEffort || null;
    },
    // /models GET probe — lighter than a chat call and sufficient to
    // validate the key. Returns the model count so the wizard's UI can
    // show "ok · N models listed".
    probe: async (body) => {
      const apiKey = (body?.apiKey || '').trim()
        || process.env.OPENAI_API_KEY
        || api.getHostConfig()?.openaiApiKey
        || api.getConfig()?.apiKey
        || '';
      const baseUrl = (body?.baseUrl || '').trim()
        || process.env.OPENAI_BASE_URL
        || api.getHostConfig()?.openaiBaseUrl
        || api.getConfig()?.baseUrl
        || 'https://api.openai.com/v1';
      if (!apiKey) return { ok: false, error: 'missing apiKey' };
      try {
        const t0 = Date.now();
        const r = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json().catch(() => ({}));
        const count = Array.isArray(d?.data) ? d.data.length : 0;
        return { ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 200) };
      }
    },
  });

  api.registerSettingsPane({
    tab: 'providers',
    title: 'OpenAI',
    description: 'GPT-4o, GPT-4.1, etc. Use model strings like `openai/gpt-4o-mini` in tier routing.',
    schema: [
      { key: 'apiKey', label: 'OPENAI_API_KEY', type: 'password', secret: true,
        envFallback: 'OPENAI_API_KEY',
        help: 'Standard OpenAI API key (sk-…). Also used by the whisper plugin\'s server-side STT fallback.' },
      { key: 'baseUrl', label: 'Base URL (optional)', type: 'text',
        envFallback: 'OPENAI_BASE_URL',
        help: 'Default https://api.openai.com/v1. Override for proxy / Azure-routed deployments.' },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Only mirror NON-EMPTY values. Empty form input = "leave alone",
    // not "clear" — prevents the regression where saving the plugin
    // pane with default/empty fields wipes the wizard's persisted env.
    const host = api.getHostConfig();
    const upd = {};
    if (newCfg.apiKey)  { host.openaiApiKey = newCfg.apiKey;   upd.OPENAI_API_KEY = newCfg.apiKey; }
    if (newCfg.baseUrl) { host.openaiBaseUrl = newCfg.baseUrl; upd.OPENAI_BASE_URL = newCfg.baseUrl; }
    if (Object.keys(upd).length === 0) return;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') gw._applyEnvUpdates(upd);
    } catch (e) { api.getLogger().warn('OPENAI env mirror failed: ' + e.message); }
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = process.env.OPENAI_API_KEY || host.openaiApiKey || slot.apiKey || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const r = await fetch((process.env.OPENAI_BASE_URL || host.openaiBaseUrl || slot.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json().catch(() => ({}));
      const count = Array.isArray(d?.data) ? d.data.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, model: `${count} models listed` }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  api.getLogger().info(`Plugin ready — provider 'openai' (prefix: openai) registered.`);
}

register._test = {
  isOpenAIChatModel: _isOpenAIChatModel,
  isOpenAIReasoningModel: _isOpenAIReasoningModel,
  withOpenAIModelMetadata: _withOpenAIModelMetadata,
  normalizeOpenAIModelFamily: _normalizeOpenAIModelFamily,
  parseOpenAIContextLimitFromError: _parseOpenAIContextLimitFromError,
  isOpenAIChatUnsupportedError: _isOpenAIChatUnsupportedError,
  selectOpenAIContextProbeTargets: _selectOpenAIContextProbeTargets,
  applyOpenAIContextProbeResults: _applyOpenAIContextProbeResults,
  isOpenAIResponsesUnsupportedError: _isOpenAIResponsesUnsupportedError,
  toOpenAIResponsesRequest: _toOpenAIResponsesRequest,
  fromOpenAIResponsesPayload: _fromOpenAIResponsesPayload,
  OpenAIResponsesClient,
};

module.exports = register;
