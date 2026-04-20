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

function _searxngSearch({ query, count, baseUrl, apiKey }) {
  return new Promise((resolve, reject) => {
    const url = baseUrl.replace(/\/$/, '');
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
    const fullUrl = `${url}/search?${params}`;
    const mod = fullUrl.startsWith('https') ? https : http;
    const opts = { timeout: 15000, headers: {} };
    if (apiKey) opts.headers['Authorization'] = `Bearer ${apiKey}`;
    const req = mod.get(fullUrl, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`SearXNG HTTP ${res.statusCode}${data ? ': ' + data.slice(0, 120) : ''}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const results = (json.results || []).slice(0, count).map(r => ({
            title: r.title || '',
            url: r.url || '',
            description: r.content || r.description || '',
          }));
          resolve({ provider: 'searxng', results, query, total: (json.results || []).length });
        } catch (e) { reject(new Error(`SearXNG parse error: ${e.message}`)); }
      });
    });
    req.on('error', e => reject(new Error(`SearXNG request failed: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('SearXNG timed out')); });
  });
}

function _braveSearch({ query, count, apiKey }) {
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
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.web?.results) {
            const results = json.web.results.slice(0, count).map(r => ({
              title: r.title, url: r.url, description: r.description || '',
            }));
            resolve({ provider: 'brave', results, query, total: json.web.results.length });
          } else if (json.error || json.message) {
            resolve({ error: `Brave: ${json.error?.message || json.message || 'unknown error'}` });
          } else {
            resolve({ provider: 'brave', results: [], query, note: 'No results found' });
          }
        } catch (e) { resolve({ error: `Brave parse error: ${e.message}` }); }
      });
    });
    req.on('error', e => resolve({ error: `Brave request failed: ${e.message}` }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'Brave timed out' }); });
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
