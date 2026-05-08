'use strict';

function matchProxyRoute(proxyRoute, config, req = {}) {
  for (const [name, route] of Object.entries(config?.routes || {})) {
    if (proxyRoute === name || proxyRoute.startsWith(name + '/')) {
      if (route.methods && !route.methods.includes(req.method)) continue;
      return { name, route, remainder: proxyRoute.slice(name.length) };
    }
  }
  return null;
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (!req.on) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function defaultRedactSecrets(value) {
  return String(value ?? '')
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/([A-Za-z0-9_]*key[A-Za-z0-9_]*\s*[=:]\s*)[^\s,"']+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_]*token[A-Za-z0-9_]*\s*[=:]\s*)[^\s,"']+/gi, '$1[redacted]');
}


function createApiProxyHandler(opts = {}) {
  const fetchImpl = opts.fetchImpl || opts.fetch || global.fetch;
  const fetchVaultKey = opts.fetchVaultKey || (() => null);
  const redactSecrets = opts.redactSecrets || defaultRedactSecrets;
  const log = opts.log || console;

  if (!fetchImpl) throw new Error('API proxy requires fetch');

  return async function handleApiProxy(req, res, matched, proxyRoute) {
    const { name, route, remainder } = matched || {};
    if (!route?.target) {
      writeJson(res, 500, { error: `Proxy route "${name}" has no target URL` });
      return;
    }

    try {
      const targetUrl = new URL(remainder || '/', route.target);
      const origUrl = new URL(req.url, 'http://localhost');
      for (const [k, v] of origUrl.searchParams) targetUrl.searchParams.append(k, v);

      const headers = { ...(route.headers || {}) };
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string' && value.startsWith('$VAULT:')) {
          headers[key] = await fetchVaultKey(value.slice(7)) || '';
        }
      }
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = await readRequestBody(req);

      const upstream = await fetchImpl(targetUrl, init);
      const contentType = upstream.headers?.get?.('content-type') || 'application/json';
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': contentType });
      res.end(body);
    } catch (err) {
      const safe = redactSecrets(err?.message || err);
      log.warn?.(`[web] API proxy failed for ${name || proxyRoute}: ${safe}`);
      writeJson(res, 502, { error: 'Proxy request failed', detail: safe });
    }
  };
}

module.exports = { matchProxyRoute, createApiProxyHandler, defaultRedactSecrets };
