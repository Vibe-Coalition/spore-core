'use strict';

const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+\b/g;
const SECRET_FIELD = /(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi;

function redactLogValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE, '$1…').replace(SECRET_FIELD, '$1[redacted]');
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogValue(value.message),
      stack: redactLogValue(value.stack || ''),
    };
  }
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/(api[_-]?key|token|secret|password|authorization)/i.test(key)) out[key] = '[redacted]';
      else out[key] = redactLogValue(val);
    }
    return out;
  }
  return value;
}

function formatArg(arg) {
  const redacted = redactLogValue(arg);
  if (typeof redacted === 'string') return redacted;
  try { return JSON.stringify(redacted); }
  catch { return String(redacted); }
}

function createLogger(level = 'info') {
  if (typeof level === 'object' && level) level = level.level || 'info';
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const threshold = levels[level] ?? 1;
  const ring = [];
  const RING_MAX = 2000;

  const log = (lvl, ...args) => {
    if ((levels[lvl] ?? 1) >= threshold) {
      const ts = new Date().toISOString().substring(11, 19);
      const line = `[${ts}] [${lvl}] ${args.map(formatArg).join(' ')}`;
      ring.push(line);
      if (ring.length > RING_MAX) ring.shift();
      const writer = lvl === 'error' ? console.error : (lvl === 'warn' ? console.warn : console.log);
      writer.call(console, line);
    }
  };

  return {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    recent: () => ring.slice(),
    _ring: ring,
  };
}

module.exports = { createLogger, redactLogValue };
