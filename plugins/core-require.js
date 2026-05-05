'use strict';

const path = require('path');

function _unique(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function coreRequire(modulePath) {
  const rel = String(modulePath || '').replace(/^\.?\//, '');
  const candidates = _unique([
    // Source checkout: <repo>/plugins/core-require.js -> <repo>/src/<module>
    path.join(__dirname, '..', 'src', rel),
    // Docker image: /app/plugins/core-require.js -> /app/<module>
    path.join(__dirname, '..', rel),
    // Test/process fallbacks for unusual cwd values.
    path.join(process.cwd(), 'src', rel),
    path.join(process.cwd(), rel),
  ]);

  const misses = [];
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = require.resolve(candidate);
    } catch (e) {
      if (e?.code !== 'MODULE_NOT_FOUND') throw e;
      misses.push(candidate);
      continue;
    }
    return require(resolved);
  }
  const err = new Error(`Unable to resolve core module "${rel}". Tried: ${misses.join(', ')}`);
  err.code = 'CORE_MODULE_NOT_FOUND';
  throw err;
}

function _legacyTierValue(config, tier) {
  const nested = config?.models || {};
  const direct = nested[tier] || config?.[`${tier}Model`];
  if (direct) return direct;

  const chains = {
    casual: ['normal', 'planner'],
    normal: ['planner', 'casual'],
    planner: ['normal', 'casual'],
    subagent: ['planner', 'normal', 'casual'],
    learner: ['casual', 'normal'],
    recall: ['learner', 'casual'],
  };
  for (const next of chains[tier] || []) {
    const value = nested[next] || config?.[`${next}Model`];
    if (value) return value;
  }
  return null;
}

function modelForTier(tier, config, opts = {}) {
  try {
    const settings = coreRequire('settings');
    const value = settings?.modelForTier?.(tier, opts);
    if (value) return value;
  } catch {
    // Fall through to the host config snapshot. Plugins must remain
    // loadable in tests and during early boot before settings is ready.
  }
  if (opts?.strict) {
    const nested = config?.models || {};
    return nested[tier] || config?.[`${tier}Model`] || null;
  }
  return _legacyTierValue(config, tier);
}

module.exports = { coreRequire, modelForTier };
