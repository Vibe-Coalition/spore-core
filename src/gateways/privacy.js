function mergePolicy(base = {}, extra = {}) {
  return { ...base, ...extra };
}

function resolveSourcePolicy(config, platform, sourceId) {
  const privacy = config.privacy || {};
  const defaults = {
    private: false,
    learn: true,
    shareToFeed: true,
    respond: true,
  };

  const merged = mergePolicy(
    mergePolicy(
      mergePolicy(defaults, privacy.default || {}),
      (privacy.platforms || {})[platform] || {}
    ),
    (privacy.sources || {})[`${platform}:${sourceId}`] || {}
  );

  // Private sources default to staying out of the shared feed and learner
  if (merged.private) {
    if (merged.shareToFeed === undefined || merged.shareToFeed === true) merged.shareToFeed = false;
    if (merged.learn === undefined || merged.learn === true) merged.learn = false;
  }

  return merged;
}

module.exports = { resolveSourcePolicy };
