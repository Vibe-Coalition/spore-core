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

function readRequestBody(req, maxBytes = 5_000_000) {
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    if (Buffer.byteLength(req.body) > maxBytes) return Promise.reject(new Error('Body too large'));
    return Promise.resolve(req.body);
  }
  if (!req.on) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > maxBytes) {
        failed = true;
        if (typeof req.destroy === 'function') {
          try { req.destroy(); } catch { /* ignore */ }
        }
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(buf);
    });
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

async function resolveHeaderValue(value, routeName, fetchVaultKey) {
  if (typeof value !== 'string') return value;

  if (value.includes('$VAULT:')) {
    const vaultRefs = [...value.matchAll(/\$VAULT:([A-Z_][A-Z0-9_]*)/g)];
    if (vaultRefs.length === 0) {
      throw Object.assign(new Error(`Invalid $VAULT reference in proxy route "${routeName}"`), { status: 500 });
    }
    let resolved = value;
    for (const match of vaultRefs) {
      const keyName = match[1];
      const vaultVal = await fetchVaultKey(keyName);
      const replacement = vaultVal || process.env[keyName];
      if (!replacement) {
        throw Object.assign(new Error(`Required vault key not found for proxy route "${routeName}"`), { status: 500 });
      }
      resolved = resolved.replaceAll(match[0], replacement);
    }
    return resolved;
  }

  if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) {
    const envKey = value.slice(1);
    const envVal = process.env[envKey];
    if (!envVal) {
      throw Object.assign(new Error(`Required env credential not set for proxy route "${routeName}"`), { status: 500 });
    }
    return envVal;
  }

  return value;
}

async function buildProxyHeaders(req, route, routeName, fetchVaultKey) {
  const headers = {};
  const forwardHeaders = ['content-type', 'content-length', 'accept', 'accept-encoding'];
  for (const header of forwardHeaders) {
    if (req.headers?.[header]) headers[header] = req.headers[header];
  }

  for (const [key, value] of Object.entries(route.headers || {})) {
    headers[key] = await resolveHeaderValue(value, routeName, fetchVaultKey);
  }

  return headers;
}

function responseHeaders(upstream) {
  const headers = {};
  const upstreamHeaders = upstream?.headers;
  if (upstreamHeaders && typeof upstreamHeaders[Symbol.iterator] === 'function') {
    for (const [key, value] of upstreamHeaders) {
      if (String(key).toLowerCase() !== 'access-control-allow-origin') headers[key] = value;
    }
  } else {
    const contentType = upstreamHeaders?.get?.('content-type');
    if (contentType) headers['content-type'] = contentType;
  }
  headers['access-control-allow-origin'] = '*';
  return headers;
}

async function writeUpstreamBody(upstream, res) {
  if (upstream?.body?.getReader) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof res.write === 'function') res.write(value);
    }
    res.end();
    return;
  }
  if (upstream?.body && typeof upstream.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of upstream.body) {
      if (typeof res.write === 'function') res.write(chunk);
    }
    res.end();
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
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

      const headers = await buildProxyHeaders(req, route, name, fetchVaultKey);
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = await readRequestBody(req, route.maxBodyBytes || 5_000_000);
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(route.timeout || 30_000);
      }

      const upstream = await fetchImpl(targetUrl, init);
      res.writeHead(upstream.status, responseHeaders(upstream));
      await writeUpstreamBody(upstream, res);
    } catch (err) {
      const safe = redactSecrets(err?.message || err);
      log.warn?.(`[web] API proxy failed for ${name || proxyRoute}: ${safe}`);
      if (!res.headersSent) {
        writeJson(res, err?.status || 502, { error: err?.status ? safe : 'Proxy request failed', detail: safe });
      } else if (typeof res.end === 'function') {
        res.end();
      }
    }
  };
}

module.exports = {
  matchProxyRoute,
  createApiProxyHandler,
  defaultRedactSecrets,
  resolveHeaderValue,
  buildProxyHeaders,
};
