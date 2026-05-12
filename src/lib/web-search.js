/**
 * Shared web-search helper.
 *
 * Tries SearXNG first (self-hosted, no API key needed). Falls back to
 * Brave Search when SearXNG isn't configured, returns nothing, or errors.
 * Used by both the web_search tool and the maintainer's gap-fill helper so
 * they stay in sync.
 *
 * searchWeb({ query, count, searxngUrl, braveApiKey, log }) →
 *   { provider, results, query, total } on success
 *   { error }                             on failure with no provider usable
 *   { results: [], note }                 when both are reachable but empty
 */

const http = require('http');
const https = require('https');

const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARXNG_TIMEOUT_MS = 15000;
const BRAVE_TIMEOUT_MS = 10000;

function _searxngSearch({ query, count, baseUrl, apiKey, timeoutMs = SEARXNG_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const url = baseUrl.replace(/\/$/, '');
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
    const fullUrl = `${url}/search?${params}`;
    const mod = fullUrl.startsWith('https') ? https : http;
    const opts = { timeout: timeoutMs, headers: {} };
    if (apiKey) opts.headers['Authorization'] = `Bearer ${apiKey}`;
    let settled = false;
    let req;
    let timer;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    timer = setTimeout(() => {
      if (req) req.destroy(new Error('SearXNG hard timeout'));
      settle(new Error(`SearXNG timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    timer.unref?.();

    req = mod.get(fullUrl, opts, (res) => {
      let data = '';
      res.on('data', c => {
        data += c;
        if (data.length > MAX_SEARCH_RESPONSE_BYTES) {
          if (req) req.destroy(new Error('SearXNG response too large'));
          settle(new Error(`SearXNG response exceeded ${MAX_SEARCH_RESPONSE_BYTES} bytes`));
        }
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          settle(new Error(`SearXNG HTTP ${res.statusCode}${data ? ': ' + data.slice(0, 120) : ''}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const results = (json.results || []).slice(0, count).map(r => ({
            title: r.title || '',
            url: r.url || '',
            description: r.content || r.description || '',
          }));
          settle(null, { provider: 'searxng', results, query, total: (json.results || []).length });
        } catch (e) { settle(new Error(`SearXNG parse error: ${e.message}`)); }
      });
    });
    req.on('error', e => settle(new Error(`SearXNG request failed: ${e.message}`)));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('SearXNG socket timeout'));
      settle(new Error(`SearXNG timed out after ${timeoutMs}ms`));
    });
  });
}

function _braveSearch({ query, count, apiKey, timeoutMs = BRAVE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ q: query, count: Math.min(count, 20).toString() });
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?${params}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'X-Subscription-Token': apiKey,
      },
    };
    let settled = false;
    let req;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      if (req) req.destroy(new Error('Brave hard timeout'));
      finish({ error: `Brave timed out after ${timeoutMs}ms` });
    }, timeoutMs + 1000);
    timer.unref?.();

    req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => {
        data += c;
        if (data.length > MAX_SEARCH_RESPONSE_BYTES) {
          if (req) req.destroy(new Error('Brave response too large'));
          finish({ error: `Brave response exceeded ${MAX_SEARCH_RESPONSE_BYTES} bytes` });
        }
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.web?.results) {
            const results = json.web.results.slice(0, count).map(r => ({
              title: r.title, url: r.url, description: r.description || '',
            }));
            finish({ provider: 'brave', results, query, total: json.web.results.length });
          } else if (json.error || json.message) {
            finish({ error: `Brave: ${json.error?.message || json.message || 'unknown error'}` });
          } else {
            finish({ provider: 'brave', results: [], query, note: 'No results found' });
          }
        } catch (e) { finish({ error: `Brave parse error: ${e.message}` }); }
      });
    });
    req.on('error', e => finish({ error: `Brave request failed: ${e.message}` }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Brave socket timeout'));
      finish({ error: `Brave timed out after ${timeoutMs}ms` });
    });
    req.end();
  });
}

async function searchWeb({ query, count = 5, searxngUrl, searxngApiKey, braveApiKey, log } = {}) {
  if (!query) return { error: 'missing query' };

  // SearXNG first
  if (searxngUrl) {
    try {
      const res = await _searxngSearch({ query, count, baseUrl: searxngUrl, apiKey: searxngApiKey });
      if (res.results && res.results.length > 0) return res;
      // Empty results — fall through to Brave if configured
    } catch (e) {
      log?.warn?.(`[search] SearXNG failed: ${e.message}, trying Brave`);
    }
  }

  // Brave fallback
  if (braveApiKey) return _braveSearch({ query, count, apiKey: braveApiKey });

  if (!searxngUrl && !braveApiKey) {
    return { error: 'No search provider configured. Set SEARXNG_URL or BRAVE_API_KEY.' };
  }
  return { results: [], query, note: 'SearXNG returned no results and no Brave API key configured' };
}

module.exports = { searchWeb };
