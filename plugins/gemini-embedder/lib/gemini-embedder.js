// Server-side Gemini text-embedding client.
// Extracted from src/graph/embedder.js. Same wire shape: POST to
// https://generativelanguage.googleapis.com/v1beta/models/<model>:embedContent
// with the API key in the x-goog-api-key header (NOT the URL — the URL
// leaks into undici TypeError cause chains and any URL-bearing log).
//
// Default model: gemini-embedding-2-preview (768-dim). Other models exposed
// by the same endpoint produce different dims; if you change the model
// you must also update the dim declared in index.js's registerEmbedder
// call so vectorSearch's dim filter stays correct.

class GeminiEmbedder {
  constructor(config) {
    const slot = config?.plugins?.['gemini-embedder'] || {};
    this.apiKey = slot.apiKey || config?.geminiApiKey || null;
    this.model = slot.model || 'gemini-embedding-2-preview';
    if (!this.apiKey) throw new Error('Gemini embedder: no API key (set plugins.gemini-embedder.apiKey or GEMINI_API_KEY)');
  }

  async embed(text, opts = {}) {
    // Gemini's embedContent API supports a `taskType` hint that lets it
    // produce asymmetric query vs document vectors — same idea as
    // EmbeddingGemma's prompt prefixes, but applied server-side. Map
    // the cross-provider 'intent' to Gemini's task-type strings; if
    // intent is omitted (or 'query'), default to retrieval-query since
    // that's the call shape from retrieval.js.
    const taskType = opts.intent === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text: String(text || '').slice(0, 2048) }] },
        taskType,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini embedding ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const vec = data?.embedding?.values;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('Gemini embedding: empty vector in response');
    }
    return vec;
  }
}

module.exports = { GeminiEmbedder };
