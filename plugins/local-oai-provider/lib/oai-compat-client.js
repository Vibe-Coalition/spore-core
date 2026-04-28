// Reference contract: OAI-compatible chat-completion client.
//
// Phase B of the provider extraction re-exports the existing
// OAICompatClient from core's `src/providers/index.js`. Phase E will
// move the implementation into this plugin and core will require it
// from here. Until then, this file is a thin shim — its purpose is to
// give other provider plugins (openai-provider, openrouter-provider)
// a stable import path that survives the eventual code move.
//
// Usage from a sibling provider plugin:
//   const { OAICompatClient } = require('../../local-oai-provider/lib/oai-compat-client');

const { OAICompatClient } = require('../../../providers');

// Generic OAI-compatible /models probe. Used by every provider plugin
// that wraps OAICompatClient. Reads context-length-shaped fields
// vendors commonly expose (vLLM ships max_model_len, OpenRouter ships
// context_length, llama.cpp ships max_position_embeddings, etc.) so
// providers that DO surface ctx in their response don't need a
// per-vendor table. Vendors that don't (OpenAI, Anthropic) override
// listModels with their own augmenter.
//
// Returns { ok, models: [{ id, contextLength?, maxOutput?, displayName?, raw? }], error? }.
// Caller can pass `transform(rawEntry, base) => extendedBase` to attach
// vendor-specific metadata (family, displayName, etc.) without rewriting
// the fetch + parse.
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

// Generic prefix-table resolver — longest match wins. Each vendor with
// no inline ctx in its /models response (OpenAI, Anthropic) ships a
// table of `{ prefix, contextLength, maxOutput, family? }` entries and
// uses this to augment ids. Caller is responsible for the family field.
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

module.exports = { OAICompatClient, listOaiCompatModels, resolveByPrefix };
