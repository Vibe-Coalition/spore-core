// effort.js — Agent Effort presets.
//
// "Agent Effort" bundles ten orthogonal knobs (message budgets, iteration
// caps, tool-result cap, sub-agent fan-out + iter + timeout + max-tokens)
// into three named tiers so an operator can pick a single dial instead of
// tuning each field.
//
// Resolution model: default-fallback. The preset wins ONLY where the
// operator hasn't pinned an explicit value on the field. Explicit field
// values in config / settings always take precedence — so "Deep with
// maxToolResultChars=10k" is expressible by picking Deep and pinning
// just that field.
//
// Balanced is the default tier and its values match the historical
// defaults, so picking Balanced (or leaving agentEffort unset) changes
// nothing about runtime behavior.

const EFFORT_PRESETS = {
  quick: {
    casualMessageBudget:         15000,
    complexMessageBudget:        50000,
    maxToolResultChars:          15000,
    dmMaxIterations:                 6,
    lullMaxIterations:               2,
    loopDetectionBudgetPressure:     4,
    subagentMaxTokens:            4096,
    subagentMaxIter:                30,
    subagentTimeoutSeconds:        300,
    maxSubagentChildren:             2,
  },
  balanced: {
    casualMessageBudget:         30000,
    complexMessageBudget:        80000,
    maxToolResultChars:          30000,
    dmMaxIterations:                12,
    lullMaxIterations:               4,
    loopDetectionBudgetPressure:     6,
    subagentMaxTokens:            8192,
    subagentMaxIter:                60,
    subagentTimeoutSeconds:        900,
    maxSubagentChildren:             4,
  },
  deep: {
    casualMessageBudget:         60000,
    complexMessageBudget:       160000,
    maxToolResultChars:          60000,
    dmMaxIterations:                24,
    lullMaxIterations:               8,
    loopDetectionBudgetPressure:    10,
    subagentMaxTokens:           16384,
    subagentMaxIter:               100,
    subagentTimeoutSeconds:       1800,
    maxSubagentChildren:             8,
  },
};

const EFFORT_TIERS = ['quick', 'balanced', 'deep'];
const DEFAULT_EFFORT = 'balanced';

function resolveEffortTier(config) {
  const raw = config && config.agentEffort;
  if (typeof raw === 'string' && EFFORT_TIERS.includes(raw)) return raw;
  return DEFAULT_EFFORT;
}

function effortDefaults(config) {
  return EFFORT_PRESETS[resolveEffortTier(config)] || EFFORT_PRESETS[DEFAULT_EFFORT];
}

module.exports = {
  EFFORT_PRESETS,
  EFFORT_TIERS,
  DEFAULT_EFFORT,
  resolveEffortTier,
  effortDefaults,
};
