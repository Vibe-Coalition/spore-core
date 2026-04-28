// Server-side EmbeddingGemma-300M client via Transformers.js (ONNX Runtime).
// Lazy-loads the model on first embed() call. Subsequent calls reuse the
// cached pipeline. Model files cache under <dataDir>/transformers-cache
// so they survive container rebuilds via the /data bind mount.
//
// Why fp32/q8/q4 only (no fp16): EmbeddingGemma activations don't
// support fp16; q4 is the practical CPU pick (~150MB on disk, ~10-30ms
// per embed on a modern x86 core after warm-up).
//
// Matryoshka: native dim is 768. Truncating to 512/256/128 is an
// explicit feature of the model's training — slice the prefix and
// re-normalize. Smaller dims = faster cosine but slightly lower recall;
// 256 is a good balance for graph-scale workloads.

const path = require('path');
const fs = require('fs');

const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';
const VALID_DTYPES = new Set(['q4', 'q8', 'fp32']);
const VALID_DIMS = new Set([128, 256, 512, 768]);

let _pipelinePromise = null;
let _pipelineDtype = null;

/**
 * Resolve the on-disk cache dir for downloaded model files. Lives under
 * the SPORE data dir so models survive container rebuilds. Falls back
 * to a conventional /data path when the env var is unset (legacy boot
 * sequence).
 */
function _cacheDir(api) {
  const fromConfig = api?.getHostConfig?.()?.dataDir;
  const dir = fromConfig || process.env.SPORE_DATA_DIR || '/data';
  const out = path.join(dir, 'transformers-cache');
  try { fs.mkdirSync(out, { recursive: true }); } catch (e) {
    // Non-fatal — Transformers.js will fall back to its default cache dir.
  }
  return out;
}

/**
 * Lazy pipeline construction. Re-resolves if the caller asks for a
 * different dtype than the cached one (rare — happens on a settings
 * change).
 */
async function _getPipeline(dtype, cacheDir, log) {
  if (_pipelinePromise && _pipelineDtype === dtype) return _pipelinePromise;
  _pipelineDtype = dtype;

  let pipelineFn;
  try {
    ({ pipeline: pipelineFn } = require('@huggingface/transformers'));
  } catch (e) {
    throw new Error(
      '@huggingface/transformers not installed. Run `npm install @huggingface/transformers` ' +
      'in the SPORE app dir (~530 MB including onnxruntime-node) and restart, then re-enable this plugin.'
    );
  }

  log?.info?.(`[embedder-gemma] Loading ${MODEL_ID} (dtype=${dtype}). First call downloads ~150MB to ${cacheDir}; subsequent calls reuse the cache.`);
  _pipelinePromise = pipelineFn('feature-extraction', MODEL_ID, {
    dtype,
    cache_dir: cacheDir,
  }).then((p) => {
    log?.info?.('[embedder-gemma] Model ready.');
    return p;
  }).catch((e) => {
    _pipelinePromise = null;
    _pipelineDtype = null;
    throw e;
  });
  return _pipelinePromise;
}

class GemmaEmbedder {
  constructor(config, api) {
    const slot = config?.plugins?.['embedder-gemma'] || {};
    this.dtype = VALID_DTYPES.has(slot.dtype) ? slot.dtype : 'q4';
    this.targetDim = VALID_DIMS.has(Number(slot.dim)) ? Number(slot.dim) : 768;
    this.api = api;
  }

  async embed(text, opts = {}) {
    const cacheDir = _cacheDir(this.api);
    const log = this.api?.getLogger?.();
    const p = await _getPipeline(this.dtype, cacheDir, log);

    // EmbeddingGemma uses asymmetric prompt prefixes for retrieval —
    // queries get "task: search result | query: ..." (predicting which
    // doc embedding lands close), documents get "title: none | text: ..."
    // (representing the doc itself). Using the query prefix for both
    // reduces retrieval quality: doc-doc similarity gets compressed into
    // a tight band because all vectors are anchored against the same
    // query template. Default = 'document' since indexing dominates the
    // call volume; retrieval.js passes intent='query' explicitly.
    const safeText = String(text || '').slice(0, 2048);
    const prefixed = opts.intent === 'query'
      ? `task: search result | query: ${safeText}`
      : `title: none | text: ${safeText}`;

    const out = await p(prefixed, { pooling: 'mean', normalize: true });
    let vec = Array.from(out.data);

    // Matryoshka truncation: slice prefix, re-normalize. The output of
    // pooling+normalize is a unit vector; slicing breaks the unit
    // length, so we re-normalize.
    if (this.targetDim < vec.length) {
      vec = vec.slice(0, this.targetDim);
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 0) vec = vec.map(v => v / norm);
    }

    return vec;
  }
}

module.exports = { GemmaEmbedder };
