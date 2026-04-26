// FLUX API client — submit + poll-until-ready, returns the result.sample URL.
// Wraps the contract documented in the ref-bfl-api node so the agent
// can call generate_image once instead of hand-rolling a polling loop
// over web_fetch.

const https = require('https');
const { URL } = require('url');

const DEFAULT_MODEL = 'flux-2-pro-preview';
const ALLOWED_MODELS = new Set([
  'flux-2-pro-preview',
  'flux-kontext-pro',
  'flux-kontext-max',
  'flux-pro-1.1',
  'flux-2-pro',
]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

function resolveApiKey(config) {
  const slot = config?.plugins?.flux || {};
  // Plugin slot first; legacy host config slot (set by env loader) second.
  return slot.apiKey || config?.bflApiKey || process.env.BFL_API_KEY || null;
}

/**
 * POST https://api.bfl.ai/v1/{model} with the given body, return the
 * parsed { id, polling_url } response.
 */
function submit(apiKey, model, body) {
  const path = `/v1/${model}`;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.bfl.ai',
      path,
      method: 'POST',
      headers: {
        'X-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(parsed.detail?.[0]?.msg || parsed.error || `FLUX submit ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`FLUX submit parse error (${res.statusCode}): ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** GET the polling URL once. */
function pollOnce(apiKey, pollUrl) {
  const u = new URL(pollUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'X-Key': apiKey },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(parsed.error || `FLUX poll ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`FLUX poll parse error (${res.statusCode}): ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Submit a generation and poll until it's Ready (or fails / times out).
 *
 * @param {object} config — runtime config; resolveApiKey reads it
 * @param {object} input — { prompt, model?, width?, height?, output_format?, seed?, input_image? }
 * @returns {Promise<{ url, model, prompt, ms, id }>}
 */
async function generate(config, input = {}) {
  const apiKey = resolveApiKey(config);
  if (!apiKey) throw new Error('FLUX: no API key (set plugins.flux.apiKey or BFL_API_KEY)');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('FLUX: prompt is required');
  const model = input.model && ALLOWED_MODELS.has(input.model) ? input.model : DEFAULT_MODEL;

  const body = { prompt };
  if (input.width)  body.width  = input.width;
  if (input.height) body.height = input.height;
  if (input.output_format) body.output_format = input.output_format;
  if (typeof input.seed === 'number') body.seed = input.seed;
  if (input.input_image) body.input_image = input.input_image;

  const t0 = Date.now();
  const submitted = await submit(apiKey, model, body);
  if (!submitted?.polling_url) {
    throw new Error('FLUX submit returned no polling_url');
  }
  const id = submitted.id || null;

  // Poll until Ready or timeout.
  while (true) {
    if (Date.now() - t0 > POLL_TIMEOUT_MS) {
      throw new Error(`FLUX poll timeout after ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const status = await pollOnce(apiKey, submitted.polling_url);
    if (status.status === 'Ready') {
      const url = status.result?.sample;
      if (!url) throw new Error('FLUX Ready but no result.sample URL');
      return { url, model, prompt, ms: Date.now() - t0, id };
    }
    if (status.status === 'Error' || status.status === 'Content Moderated' || status.status === 'Request Moderated') {
      throw new Error(`FLUX ${status.status}: ${status.result?.error || status.error || 'unknown'}`);
    }
    // Pending / Queued / In Progress — keep polling.
  }
}

module.exports = { generate, resolveApiKey, ALLOWED_MODELS, DEFAULT_MODEL };
