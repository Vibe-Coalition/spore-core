'use strict';

// Shared URL safety + frame encoding for the browser tool. Lives in
// browser-core; backend plugins (zendriver, playwright) require this
// via relative path: `require('../../browser-core/lib/url-block')`.

const _blockedHostPatterns = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^fc00:/i, /^fe80:/i, /^::1$/,
  /^localhost$/i, /^metadata\./i, /\.internal$/i,
  /^spore-manager$/i, /^docker-proxy$/i, /^traefik$/i,
];

function _isAllowedLocalSporeUrl(parsed, opts = {}) {
  if (!opts.allowLocalSpore) return false;
  const webPort = String(opts.webPort || '').trim();
  if (!webPort || parsed.port !== webPort) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  return localHost && parsed.pathname.startsWith('/serve/');
}

function getBlockedUrlError(urlStr, opts = {}) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Blocked: only http/https URLs allowed (got ${parsed.protocol})`;
    }
    if (_blockedHostPatterns.some((pattern) => pattern.test(parsed.hostname)) && !_isAllowedLocalSporeUrl(parsed, opts)) {
      return `Blocked: access to ${parsed.hostname} is not allowed (private/internal network)`;
    }
    return null;
  } catch {
    return `Invalid URL: ${urlStr}`;
  }
}

function encodeBrowserFrame(header, jpegBuffer) {
  const headerJson = JSON.stringify(header);
  const headerBuf = Buffer.from(headerJson, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  return Buffer.concat([lenBuf, headerBuf, jpegBuffer]);
}

module.exports = {
  getBlockedUrlError,
  encodeBrowserFrame,
};
