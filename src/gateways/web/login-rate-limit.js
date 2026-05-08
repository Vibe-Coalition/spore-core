'use strict';

function normalizeKey(key) {
  const clean = String(key || '').trim();
  return clean || 'unknown';
}

function createLoginRateLimiter(opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 5;
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : 15 * 60 * 1000;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const attempts = opts.attempts instanceof Map ? opts.attempts : new Map();

  const trim = (key, at = now()) => {
    const k = normalizeKey(key);
    const entry = attempts.get(k);
    if (!entry) return null;
    entry.attempts = entry.attempts.filter(ts => at - ts < windowMs);
    if (entry.attempts.length === 0) {
      attempts.delete(k);
      return null;
    }
    return entry;
  };

  const isLimited = (key) => {
    const entry = trim(key);
    return !!entry && entry.attempts.length >= maxAttempts;
  };

  const recordFailure = (key) => {
    const k = normalizeKey(key);
    const at = now();
    let entry = trim(k, at);
    if (!entry) {
      entry = { attempts: [] };
      attempts.set(k, entry);
    }
    entry.attempts.push(at);
    return {
      attempts: entry.attempts.length,
      limited: entry.attempts.length >= maxAttempts,
      remaining: Math.max(0, maxAttempts - entry.attempts.length),
    };
  };

  const clear = (key) => attempts.delete(normalizeKey(key));

  const retryAfterMs = (key) => {
    const entry = trim(key);
    if (!entry || entry.attempts.length < maxAttempts) return 0;
    const oldest = Math.min(...entry.attempts);
    return Math.max(0, windowMs - (now() - oldest));
  };

  const sweep = () => {
    for (const key of [...attempts.keys()]) trim(key);
  };

  return {
    clear,
    isLimited,
    recordFailure,
    retryAfterMs,
    sweep,
    _attempts: attempts,
  };
}

module.exports = { createLoginRateLimiter };
