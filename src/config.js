/**
 * config.js — Configuration loader for SPORE
 *
 * Loads from spore.json and environment variables.
 * Priority: env vars > spore.json > defaults
 *
 * Persistence locations: the wizard / settings UI writes spore.json and
 * .env into the data dir (resolved from SPORE_DATA_DIR or
 * dirname(GRAPH_DB_PATH), default `/data` in Docker). Legacy installs
 * had these files at `/app/spore.json` and `/app/.env` via bind mount;
 * loadConfigFresh below auto-migrates them forward on first boot of an
 * upgraded image.
 */

const fs = require('fs');
const { createLogger } = require('./observability/logger');
const path = require('path');

// Resolve dataDir at module-load time (before functions are called)
// so we can find a .env file in the right place. Prefer SPORE_DATA_DIR,
// fall back to dirname(GRAPH_DB_PATH), then to <__dirname>/data which
// is the bare-mode default.
function _resolveBootDataDir() {
  if (process.env.SPORE_DATA_DIR) return process.env.SPORE_DATA_DIR;
  if (process.env.GRAPH_DB_PATH) return path.dirname(process.env.GRAPH_DB_PATH);
  return path.join(__dirname, 'data');
}

function _deriveDefaultWorkspacePath(config, root) {
  const dataDir = config.dataDir || (config.graphDbPath ? path.dirname(config.graphDbPath) : null);
  const resolvedDataDir = dataDir && path.isAbsolute(dataDir) ? dataDir : path.resolve(root, dataDir || 'data');
  // Container images keep immutable app code in /app and mount user state at /workspace.
  // Falling back to process.cwd() in Docker causes /app/tools to be indexed as user tools.
  if (resolvedDataDir === '/data' || config.graphDbPath === '/data/graph.db') return '/workspace';
  return path.join(root, 'workspace');
}

// Load .env file. Prefer the data-dir copy (the wizard writes here on
// new installs); fall back to the legacy /app/.env that older installs
// bind-mount. Order matters — read legacy first, then data-dir, so
// data-dir values win on key collision.
const _bootDataDir = _resolveBootDataDir();
const _legacyEnvPath = path.join(__dirname, '.env');
const _dataDirEnvPath = path.join(_bootDataDir, '.env');
// One-time migration: if legacy /app/.env exists but data-dir doesn't,
// copy it forward so the wizard's future writes build on it.
if (fs.existsSync(_legacyEnvPath) && !fs.existsSync(_dataDirEnvPath)) {
  try {
    fs.mkdirSync(_bootDataDir, { recursive: true });
    fs.copyFileSync(_legacyEnvPath, _dataDirEnvPath);
  } catch { /* read-only data dir; we'll just keep reading legacy */ }
}
for (const candidate of [_legacyEnvPath, _dataDirEnvPath]) {
  if (!fs.existsSync(candidate)) continue;
  try {
    fs.readFileSync(candidate, 'utf8').split('\n').forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
  } catch { /* unreadable .env is non-fatal */ }
}

const DEFAULTS = {
  // Model tiering — resolved from SPORE_MODEL / per-tier env vars at load time.
  // No hardcoded provider — the user's configured model is used for all tiers.
  casualModel: null,
  normalModel: null,
  plannerModel: null,
  subagentModel: null,
  learnerModel: null,
  imageVlmModel: null,
  videoVlmModel: null,
  audioVlmModel: null,
  // Dedicated model for the LLM-assisted recall query decomposition
  // (graph/retrieval.js _llmDecomposeQuery). When unset, falls back
  // through learnerModel → casualModel → main model. Pick a fast,
  // cheap model here — decomposition is one ~250-token call per
  // recall search, fires only when enhancedRecall is on.
  recallModel: null,
  model: null, // DEPRECATED — backward compat; resolved to plannerModel at load time
  embedder: null, // SPORE_EMBEDDER — active graph embedder provider name (e.g. gemma-300m, gemini)
  agentId: 'spore',
  /** Optional YYYY-MM-DD — authoritative "born" date for prompt tenure math (overrides graph node created). */
  agentBornDate: null,
  displayName: null,      // e.g. "Harry The Alien" — how the agent introduces itself
  nicknames: [],          // e.g. ["harry", "h"] — group chat trigger words
  maxTokens: 16384,
  contextWindow: 200000,
  tokenPricing: {}, // SPORE_TOKEN_PRICING — JSON map of model → USD per million tokens

  // Learner
  learningMode: 'always', // 'always' | 'flush_only' | 'disabled'
  subagentMaxTokens: null, // null = auto, derived from the active model's modelLimits[].maxTokens
  maintainerIdleOnly: false,
  // SPORE_LEARNER_HYPEREDGES — when true, the extraction prompt asks the
  // LLM to also emit n-ary group facts (3+ entities) as hyperedges.
  // Off by default because it adds tokens to every extraction call;
  // turn on for experiments or when group facts are clearly under-served.
  learnerHyperedges: false,

  // SPORE_RULE_REFUSAL_MODE — 'helpful' (default) or 'strict'. When
  // 'strict', the persona section is augmented with framing that prefers
  // brief refusals over partial answers when an operator-defined rule
  // could plausibly apply. Trades helpfulness for guard-rail certainty.
  ruleRefusalMode: 'helpful',

  // Optional capabilities
  webPort: null,            // SPORE_WEB_PORT — expose an HTTP server on this port
  browserBackend: 'zendriver', // SPORE_BROWSER_BACKEND — default browser tool backend
  tempNodeTtlHours: 48,     // SPORE_TEMP_NODE_TTL_HOURS — maintainer purges temp nodes older than this (based on extra.tempCreated)
  janitorMode: 'moderate',  // SPORE_JANITOR_MODE — 'conservative' | 'moderate' | 'aggressive'
  janitorIntervalMinutes: 360,      // SPORE_JANITOR_INTERVAL_MINUTES — how often the janitor runs
  janitorRecycleBinTtlDays: 14,     // SPORE_JANITOR_RECYCLE_BIN_TTL_DAYS — auto-purge bin rows older than this
  janitorPruneBatchSize: 5,         // SPORE_JANITOR_PRUNE_BATCH — permanent nodes scanned per cycle
  janitorBootDelayMinutes: 8,       // first janitor cycle after boot — slightly after maintainer
  janitorEnabled: true,     // SPORE_JANITOR_ENABLED=false to disable entirely
  channelDistillerEnabled: true,       // SPORE_CHANNEL_DISTILLER_ENABLED=false to disable
  channelDistillerIntervalMinutes: 120, // SPORE_CHANNEL_DISTILLER_INTERVAL_MINUTES
  channelDistillerIdleMinutes: 45,     // SPORE_CHANNEL_DISTILLER_IDLE_MINUTES
  channelDistillerBootDelayMinutes: 20, // SPORE_CHANNEL_DISTILLER_BOOT_DELAY_MINUTES
  channelDistillerBatchSize: 3,        // SPORE_CHANNEL_DISTILLER_BATCH_SIZE
  graphMaintenanceEnabled: true,       // SPORE_GRAPH_MAINTENANCE_ENABLED=false to disable scoped graph upkeep
  graphMaintenanceIntervalMinutes: 120, // SPORE_GRAPH_MAINTENANCE_INTERVAL_MINUTES
  graphMaintenanceBatchSize: 4,        // SPORE_GRAPH_MAINTENANCE_BATCH_SIZE
  generalKbResearchEnabled: true,      // SPORE_GENERAL_KB_RESEARCH_ENABLED=false to disable background KB enrichment
  generalKbResearchIntervalHours: 24,  // SPORE_GENERAL_KB_RESEARCH_INTERVAL_HOURS
  generalKbResearchBatchSize: 1,       // SPORE_GENERAL_KB_RESEARCH_BATCH_SIZE
  runtimeQueueEnabled: true,           // SPORE_RUNTIME_QUEUE_ENABLED=false to bypass central runtime queue
  runtimeQueueLaneLimits: {            // SPORE_RUNTIME_QUEUE_LANE_LIMITS='{"interactive":2,...}'
    interactive: 2,
    channel: 1,
    deferred: 1,
    learner: 1,
    maintenance: 1,
    background: 1,
  },
  nodePerformanceMetricViz: false,    // Show graph renderer/node performance status line in the web UI
  graphBackupEnabled: true,          // SPORE_BACKUP_ENABLED=false to disable
  graphBackupIntervalMinutes: 60,    // SPORE_BACKUP_INTERVAL_MINUTES
  graphBackupRetention: 20,          // SPORE_BACKUP_RETENTION — rolling count kept
  graphBackupDir: null,              // SPORE_BACKUP_DIR — defaults to <dataDir>/graphs/backups
  graphBackupOnChangeOnly: true,     // skip snapshot if DB hasn't changed (row-count hash)

  // Compute cluster + tailscale
  clusterUsername: null,             // SPORE_CLUSTER_USERNAME — SSH user for the primary cluster
  clusterLoginHost: null,            // SPORE_CLUSTER_LOGIN_HOST — tailnet hostname of primary login node
  clusterTmuxPrefix: 'spore',        // SPORE_CLUSTER_TMUX_PREFIX — namespace for tmux sessions
  clusterHosts: [],                  // SPORE_CLUSTER_HOSTS (JSON array) — additional clusters [{name, host, username}]

  // Email config moved to plugins/email/ — populated under config.plugins.email.
  // The plugin's index.js does a one-time backfill copying any pre-existing
  // top-level emailProvider/emailAddress/etc. forward into config.plugins.email
  // on first install. Keep these env-var loaders below for the legacy
  // copy-forward; plugins/email/index.js consumes them via getHostConfig().
tailscaleEnabled: false,           // SPORE_TAILSCALE_ENABLED — start tailscaled at boot
  tailscaleHostname: null,           // SPORE_TAILSCALE_HOSTNAME — default: spore-<agentId>
  hostReadPaths: [],        // SPORE_HOST_READ_PATHS — host paths mounted at /host/<path>
  extraPaths: [],           // SPORE_EXTRA_PATHS — additional read+write paths (comma-separated)
  personalityEditable: false, // SPORE_PERSONALITY_EDITABLE — agent can modify its own identity/voice/rules
  srcEditable: false,       // SPORE_SRC_EDITABLE — src bind-mounted rw; agent can self-modify and changes persist
  enhancedRecall: false,    // LLM-at-search-time query decomposition for better temporal recall

  // Paths (Docker overrides via GRAPH_DB_PATH=/data/graph.db in compose)
  graphDbPath: path.join(__dirname, 'data', 'graph.db'),
  sessionDbPath: path.join(__dirname, 'sessions.db'),
  workspacePath: null, // derived after dataDir: /workspace in Docker, ./workspace for bare installs

  // Session + Compaction
  maxSessionMessages: 200,
  compactTokenThreshold: 120000,
  sessionIdleTimeoutMinutes: 60,
  sessionDailyResetHour: 4,

  // Discord
  maxMessageLength: 2000,
  typingInterval: 5000,
  maxQueuePerChannel: 3,
  messageDebounceMs: 800,

  // Multi-platform gateways
  telegramBotToken: null,
  privacy: {
    default: { private: false, learn: true, shareToFeed: true, respond: true },
    platforms: {},
    sources: {},
  },
  channels: {
    telegram: {
      enabled: false,
      dmPolicy: 'pairing',
      groupPolicy: 'open',
      allowFrom: [],
      groupAllowFrom: [],
      requireMention: true,
      streaming: 'partial',
      textChunkLimit: 4000,
      chunkMode: 'length',
      reactions: false,
    },
    slack: {
      enabled: false,
      botToken: null,
      appToken: null,
      requireMention: true,  // in channels; DMs bypass this automatically
      textChunkLimit: 3000,
      dmPolicy: 'open',
    },
  },

  // Voice (STT/TTS pipeline for Discord voice channels + Telegram voice notes).
  // sttProvider/ttsProvider are user preferences ("which configured plugin
  // do I prefer"). When null, the voice pipeline picks the first
  // configured provider it finds. Specific plugin keys (XI_API_KEY,
  // DEEPGRAM_API_KEY, etc.) live inside their plugins, not here.
  voice: {
    enabled: false,
    sttProvider: null,
    ttsProvider: null,
    ttsVoice: null,
    ttsModel: null,
    ttsSpeed: 1.0,
    edgeVoice: 'en-US-AriaNeural',
    silenceThresholdMs: 400,
    maxUtteranceSecs: 30,
  },

  // Agent
  agentTimeoutMs: 1800000,
  intermediateTextThrottleSeconds: 30,
  dmMaxIterations: 75,
  tokenBudgetPressure: 120000,
  // System-prompt section budgets (graph/context.js GraphContext.SECTION_BUDGETS).
  // Empty object keeps the in-source defaults; overlay any number of section
  // keys to tune per-instance. Set via spore.json `sectionBudgets: {...}` or
  // env var SPORE_SECTION_BUDGETS=`{"runtime":3000,"rules":1200}` (JSON).
  // Unknown keys are warned and ignored. Known keys: persona, identity, voice,
  // rules, selfknowledge, channel, person, relevant, anti, feed, tooling,
  // behavior, runtime, reflections, derived, gaps, plugin, episodes.
  sectionBudgets: {},
  // Total system-prompt token budget (graph/context.js GraphContext.TOTAL_BUDGET).
  // null = use the in-source default (40000). Override with spore.json
  // `totalPromptBudget: <int>` or env var SPORE_TOTAL_BUDGET=<int>.
  totalPromptBudget: null,
  // Agent Effort preset — bundles message budgets, iteration caps,
  // tool-result cap, and sub-agent fan-out into a single dial.
  // 'balanced' (default) matches historic behavior; 'quick' tightens
  // for chatty/cheap turns; 'deep' loosens for long research/coding
  // sessions. See agent/effort.js for the full per-tier table.
  // Operator-pinned fields always beat the preset; the preset only
  // fills in fields the operator hasn't explicitly set.
  agentEffort: 'balanced',
  maxSubagentChildren: 8,
  subagentMaxIter: 100,
  subagentTimeoutSeconds: 3600,
  lullMaxIterations: 4,
  openaiReasoningEffort: null,
  loopDetection: {
    warn: 8,
    critical: 15,
    pingPong: 8,
    ceiling: 200,
    budgetPressure: 60,
  },
  plannerAdvisor: {
    enabled: true,
    mode: 'adaptive',
    maxInputTokens: 4000,
    maxOutputTokens: 700,
    cooldownIterations: 2,
    allowEscalation: true,
  },

  // Proactive outreach (heartbeat-triggered, personality-gated)
  proactive: {
    enabled: true,
    cooldownMinutes: 60,
    maxPerDay: 5,
    channels: [],
  },

  // Heartbeat
  heartbeatIntervalMinutes: 45,

  // Health check
  healthPort: 18790,
  healthBindAddr: '0.0.0.0', // HEALTH_BIND_ADDR — container default; host restriction via docker-compose port mapping

  // Security
  discordAdmins: [],           // SPORE_DISCORD_ADMINS — comma-separated user/role IDs for privileged commands

  // Plugins
  pluginsDir: null,            // SPORE_PLUGINS_DIR — bundled dir, ships with image; defaults to <repo>/plugins
  pluginsUserDir: null,        // SPORE_PLUGINS_USER_DIR — operator-writable dir for installed plugins; defaults to <workspace>/plugins
  pluginsEnabled: false,       // SPORE_PLUGINS_ENABLED — opt-in; plugins run as full-privilege Node code
  pluginsHotReload: true,      // SPORE_PLUGINS_HOT_RELOAD=false disables runtime install/uninstall via /api/plugins
  plugins: {},                 // per-plugin config; populated as plugins.<id> = { ... } at runtime

  // Credential guard for write tools
  credentialGuard: 'block',    // SPORE_CREDENTIAL_GUARD — 'block' | 'warn' | 'off'

  // Logging
  logLevel: 'info',
};

let _configCache = null;

/**
 * Merge spore.json + env and resolve relative paths. Does not use the process cache.
 */
function loadConfigFresh() {
  const config = { ...DEFAULTS };

  // Phase 2: settings.db (in dataDir) is the canonical store. spore.json
  // is read once by the settings migrator (loader.js) which writes its
  // contents into settings.db and renames the file. We deliberately do
  // NOT copy-forward spore.json from src/ to dataDir here — the
  // migrator handles legacy locations. We still parse a dataDir
  // spore.json if one exists so any pre-Phase-2 boots (where the
  // settings migration hasn't run yet) hydrate this.config correctly.
  const bootDataDir = _resolveBootDataDir();
  const dataDirConfigPath = path.join(bootDataDir, 'spore.json');
  const legacySrcConfigPath = path.join(__dirname, 'spore.json');

  let configPath = null;
  if (fs.existsSync(dataDirConfigPath)) configPath = dataDirConfigPath;
  else if (fs.existsSync(legacySrcConfigPath)) configPath = legacySrcConfigPath;

  if (configPath && fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      Object.assign(config, fileConfig);
      config.privacy = {
        ...DEFAULTS.privacy,
        ...(fileConfig.privacy || {}),
        default: {
          ...DEFAULTS.privacy.default,
          ...(fileConfig.privacy?.default || {}),
        },
        platforms: {
          ...DEFAULTS.privacy.platforms,
          ...(fileConfig.privacy?.platforms || {}),
        },
        sources: {
          ...DEFAULTS.privacy.sources,
          ...(fileConfig.privacy?.sources || {}),
        },
      };
      config.channels = {
        telegram: {
          ...DEFAULTS.channels.telegram,
          ...(fileConfig.channels?.telegram || {}),
        },
      };
      if (fileConfig.proactive) {
        config.proactive = { ...DEFAULTS.proactive, ...fileConfig.proactive };
      }
      if (fileConfig.loopDetection) {
        config.loopDetection = { ...DEFAULTS.loopDetection, ...fileConfig.loopDetection };
      }
    } catch (e) {
      console.error('[config] Failed to parse spore.json:', e.message);
    }
  }

  if (process.env.DISCORD_TOKEN) config.discordToken = process.env.DISCORD_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.AGENT_ID) config.agentId = process.env.AGENT_ID;
  if (process.env.SPORE_AGENT_BORN_DATE) config.agentBornDate = process.env.SPORE_AGENT_BORN_DATE.trim();
  if (process.env.SPORE_DISPLAY_NAME) config.displayName = process.env.SPORE_DISPLAY_NAME;
  if (process.env.SPORE_NICKNAMES) config.nicknames = process.env.SPORE_NICKNAMES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.BRAVE_API_KEY) config.braveApiKey = process.env.BRAVE_API_KEY;
  if (process.env.SEARXNG_URL) config.searxngUrl = process.env.SEARXNG_URL;
  if (process.env.SEARXNG_API_KEY) config.searxngApiKey = process.env.SEARXNG_API_KEY;

  // Per-model context overrides — JSON map of `<modelRef>: {contextWindow, compactAt}`
  if (process.env.SPORE_MODEL_LIMITS) {
    try { config.modelLimits = JSON.parse(process.env.SPORE_MODEL_LIMITS); } catch {
      // silent: malformed JSON → fallback
    }
  }
  if (process.env.SPORE_TOKEN_PRICING) {
    try { config.tokenPricing = JSON.parse(process.env.SPORE_TOKEN_PRICING); } catch {
      // silent: malformed JSON → fallback
    }
  }
  // Section-budget overrides — JSON map of `<sectionKey>: <tokens>`. Merged
  // with anything already provided in spore.json. Validation (unknown-key
  // warning, non-positive rejection) happens in GraphContext's constructor
  // so the same rules apply whether overrides came from JSON file or env.
  if (process.env.SPORE_SECTION_BUDGETS) {
    try {
      const fromEnv = JSON.parse(process.env.SPORE_SECTION_BUDGETS);
      config.sectionBudgets = { ...(config.sectionBudgets || {}), ...fromEnv };
    } catch { /* silent: malformed JSON → fallback */ }
  }
  if (process.env.SPORE_TOTAL_BUDGET) {
    const n = parseInt(process.env.SPORE_TOTAL_BUDGET, 10);
    if (Number.isFinite(n) && n > 0) config.totalPromptBudget = n;
  }
  if (process.env.TELEGRAM_BOT_TOKEN) config.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

  // Slack
  if (process.env.SLACK_BOT_TOKEN) config.slackBotToken = process.env.SLACK_BOT_TOKEN;
  if (process.env.SLACK_APP_TOKEN) config.slackAppToken = process.env.SLACK_APP_TOKEN;

  // Shared OpenAI API key — used by core for completions when an
  // OpenAI-tier model is configured. Voice provider keys (Deepgram,
  // ElevenLabs, ...) live inside their plugins; the plugin reads its
  // own env var and exposes its state through the plugin manager.
  if (process.env.OPENAI_API_KEY) config.openaiApiKey = process.env.OPENAI_API_KEY;

  if (process.env.GRAPH_DB_PATH) config.graphDbPath = process.env.GRAPH_DB_PATH;
  if (process.env.SESSION_DB_PATH) config.sessionDbPath = process.env.SESSION_DB_PATH;
  if (process.env.SPORE_WORKSPACE_PATH) config.workspacePath = process.env.SPORE_WORKSPACE_PATH;

  // Derived directories — all persistent files should use these instead of hardcoded paths.
  // Docker: GRAPH_DB_PATH=/data/graph.db → dataDir=/data, workspacePath=/workspace
  // Bare:   GRAPH_DB_PATH=./data/graph.db → dataDir=./data, workspacePath=./workspace
  if (process.env.SPORE_DATA_DIR) config.dataDir = process.env.SPORE_DATA_DIR;
  if (process.env.SHARED_GRAPHS_DIR) config.sharedGraphsDir = process.env.SHARED_GRAPHS_DIR;
  if (process.env.SHARED_SKILLS_DIR) config.sharedSkillsDir = process.env.SHARED_SKILLS_DIR;
  if (process.env.SPORE_MODEL) config.model = process.env.SPORE_MODEL;
  if (process.env.SPORE_CASUAL_MODEL) config.casualModel = process.env.SPORE_CASUAL_MODEL;
  if (process.env.SPORE_NORMAL_MODEL) config.normalModel = process.env.SPORE_NORMAL_MODEL;
  if (process.env.SPORE_PLANNER_MODEL) config.plannerModel = process.env.SPORE_PLANNER_MODEL;
  if (process.env.SPORE_LOG_LEVEL) config.logLevel = process.env.SPORE_LOG_LEVEL;
  if (process.env.SPORE_HEALTH_PORT) config.healthPort = parseInt(process.env.SPORE_HEALTH_PORT, 10);
  if (process.env.SPORE_LEARNER_MODEL) config.learnerModel = process.env.SPORE_LEARNER_MODEL;
  if (process.env.SPORE_LEARNER_HYPEREDGES) {
    const v = String(process.env.SPORE_LEARNER_HYPEREDGES).trim().toLowerCase();
    config.learnerHyperedges = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
  }
  if (process.env.SPORE_RULE_REFUSAL_MODE) {
    const v = String(process.env.SPORE_RULE_REFUSAL_MODE).trim().toLowerCase();
    if (v === 'strict' || v === 'helpful') config.ruleRefusalMode = v;
  }
  if (process.env.SPORE_SUBAGENT_MODEL) config.subagentModel = process.env.SPORE_SUBAGENT_MODEL;
  if (process.env.SPORE_IMAGE_VLM_MODEL) config.imageVlmModel = process.env.SPORE_IMAGE_VLM_MODEL;
  if (process.env.SPORE_VIDEO_VLM_MODEL) config.videoVlmModel = process.env.SPORE_VIDEO_VLM_MODEL;
  if (process.env.SPORE_AUDIO_VLM_MODEL) config.audioVlmModel = process.env.SPORE_AUDIO_VLM_MODEL;
  if (process.env.SPORE_RECALL_MODEL) config.recallModel = process.env.SPORE_RECALL_MODEL;
  if (process.env.SPORE_EMBEDDER) config.embedder = process.env.SPORE_EMBEDDER;
  if (process.env.SPORE_SUBAGENT_MAX_TOKENS) config.subagentMaxTokens = parseInt(process.env.SPORE_SUBAGENT_MAX_TOKENS, 10);
  if (process.env.SPORE_OPENAI_REASONING_EFFORT) config.openaiReasoningEffort = process.env.SPORE_OPENAI_REASONING_EFFORT;
  if (process.env.SPORE_HEARTBEAT_MINUTES) config.heartbeatIntervalMinutes = parseInt(process.env.SPORE_HEARTBEAT_MINUTES, 10);
  if (process.env.SPORE_DEBOUNCE_MS) config.messageDebounceMs = parseInt(process.env.SPORE_DEBOUNCE_MS, 10);
  if (process.env.HEALTH_BIND_ADDR) config.healthBindAddr = process.env.HEALTH_BIND_ADDR;
  if (process.env.SPORE_DISCORD_ADMINS) config.discordAdmins = process.env.SPORE_DISCORD_ADMINS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.SPORE_PLUGINS_DIR) config.pluginsDir = process.env.SPORE_PLUGINS_DIR;
  if (process.env.SPORE_PLUGINS_USER_DIR) config.pluginsUserDir = process.env.SPORE_PLUGINS_USER_DIR;
  if (process.env.SPORE_PLUGINS_ENABLED) config.pluginsEnabled = /^(1|true|yes|on)$/i.test(process.env.SPORE_PLUGINS_ENABLED);
  if (process.env.SPORE_PLUGINS_HOT_RELOAD) config.pluginsHotReload = /^(1|true|yes|on)$/i.test(process.env.SPORE_PLUGINS_HOT_RELOAD);
  if (process.env.SPORE_CREDENTIAL_GUARD) config.credentialGuard = process.env.SPORE_CREDENTIAL_GUARD.toLowerCase();
  if (process.env.SPORE_INTERMEDIATE_THROTTLE) config.intermediateTextThrottleSeconds = parseInt(process.env.SPORE_INTERMEDIATE_THROTTLE, 10);

  // OpenAI
  if (process.env.OPENAI_BASE_URL) config.openaiBaseUrl = process.env.OPENAI_BASE_URL;

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) config.openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_BASE_URL) config.openrouterBaseUrl = process.env.OPENROUTER_BASE_URL;
  if (process.env.OPENROUTER_REFERER) config.openrouterReferer = process.env.OPENROUTER_REFERER;

  // Local / OAI-compat (Ollama, LM Studio, vLLM, etc.)
  if (process.env.LOCAL_MODEL_BASE_URL) config.localModelBaseUrl = process.env.LOCAL_MODEL_BASE_URL;
  if (process.env.LOCAL_MODEL_API_KEY) config.localModelApiKey = process.env.LOCAL_MODEL_API_KEY;
  // Auth header for local OAI-compat endpoints. 'bearer' (default) /
  // 'x-api-key' / 'x-key'. Some self-hosted servers reject Authorization.
  if (process.env.LOCAL_MODEL_AUTH_HEADER) config.localModelAuthHeader = process.env.LOCAL_MODEL_AUTH_HEADER;

  // Gemini API key — kept readable here as a legacy bridge so the
  // gemini-embedder plugin's backfill picks up GEMINI_API_KEY env vars
  // from existing operators on first install. The plugin owns its
  // own slot at config.plugins['gemini-embedder'].apiKey going forward.
  if (process.env.GEMINI_API_KEY) config.geminiApiKey = process.env.GEMINI_API_KEY;

  // Legacy multimodal fallbacks — used only when dedicated VLM tool tiers are not configured.
  if (process.env.SPORE_VISION_FALLBACK_MODEL) config.visionFallbackModel = process.env.SPORE_VISION_FALLBACK_MODEL;
  if (process.env.SPORE_AUDIO_FALLBACK_MODEL) config.audioFallbackModel = process.env.SPORE_AUDIO_FALLBACK_MODEL;
  if (process.env.SPORE_VIDEO_FALLBACK_MODEL) config.videoFallbackModel = process.env.SPORE_VIDEO_FALLBACK_MODEL;
  if (!config.visionFallbackModel) config.visionFallbackModel = null;
  if (!config.audioFallbackModel) config.audioFallbackModel = null;
  if (!config.videoFallbackModel) config.videoFallbackModel = null;

  // Custom providers: SPORE_PROVIDER_<NAME>_URL, _KEY, _AUTH_HEADER
  // e.g. SPORE_PROVIDER_TOGETHER_URL=https://api.together.xyz/v1 → config.customProviders.together
  // Capabilities (vision, tools, audio, video) are auto-detected at runtime.
  if (!config.customProviders) config.customProviders = {};
  const providerRe = /^SPORE_PROVIDER_([A-Z0-9_]+)_(URL|KEY|AUTH_HEADER)$/;
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(providerRe);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const field = m[2];
    if (!config.customProviders[name]) config.customProviders[name] = { name };
    if (field === 'URL') config.customProviders[name].url = v;
    else if (field === 'KEY') config.customProviders[name].key = v;
    else if (field === 'AUTH_HEADER') config.customProviders[name].authHeader = v;
  }

  // Context & learning settings
  if (process.env.SPORE_CONTEXT_WINDOW) config.contextWindow = parseInt(process.env.SPORE_CONTEXT_WINDOW, 10);
  if (process.env.SPORE_COMPACT_THRESHOLD) config.compactTokenThreshold = parseInt(process.env.SPORE_COMPACT_THRESHOLD, 10);
  // Agent context budget overrides — written by the Agent tab's
  // "Context budgets" panel via /api/settings, also honored if set
  // directly in .env. Each must be a positive integer; anything else
  // falls through to the loop's auto-scaled default.
  if (process.env.SPORE_CASUAL_MESSAGE_BUDGET) {
    const n = parseInt(process.env.SPORE_CASUAL_MESSAGE_BUDGET, 10);
    if (Number.isFinite(n) && n > 0) config.casualMessageBudget = n;
  }
  if (process.env.SPORE_COMPLEX_MESSAGE_BUDGET) {
    const n = parseInt(process.env.SPORE_COMPLEX_MESSAGE_BUDGET, 10);
    if (Number.isFinite(n) && n > 0) config.complexMessageBudget = n;
  }
  if (process.env.SPORE_MAX_TOOL_RESULT_CHARS) {
    const n = parseInt(process.env.SPORE_MAX_TOOL_RESULT_CHARS, 10);
    if (Number.isFinite(n) && n > 0) config.maxToolResultChars = n;
  }
  if (process.env.SPORE_AGENT_EFFORT) {
    const e = String(process.env.SPORE_AGENT_EFFORT).toLowerCase();
    if (['quick', 'balanced', 'deep'].includes(e)) config.agentEffort = e;
  }
  if (process.env.SPORE_LEARNING_MODE) config.learningMode = process.env.SPORE_LEARNING_MODE;
  if (process.env.SPORE_MAINTAINER_IDLE_ONLY) config.maintainerIdleOnly = process.env.SPORE_MAINTAINER_IDLE_ONLY === 'true';

  // Web server port (0 / unset = disabled)
  if (process.env.SPORE_WEB_PORT) {
    const wp = parseInt(process.env.SPORE_WEB_PORT, 10);
    config.webPort = wp > 0 ? wp : null;
  }
  if (process.env.SPORE_BROWSER_BACKEND) {
    const browserBackend = String(process.env.SPORE_BROWSER_BACKEND || '').trim().toLowerCase();
    if (browserBackend) config.browserBackend = browserBackend;
  }

  // Host filesystem read access: comma-separated host paths mounted at /host/<path>
  if (process.env.SPORE_HOST_READ_PATHS) {
    config.hostReadPaths = process.env.SPORE_HOST_READ_PATHS.split(',').map(p => p.trim()).filter(Boolean);
  }

  // Extra read+write paths: comma-separated directories the agent can freely access
  if (process.env.SPORE_EXTRA_PATHS) {
    config.extraPaths = process.env.SPORE_EXTRA_PATHS.split(',').map(p => p.trim()).filter(Boolean);
  }

  // Web basic auth
  if (process.env.SPORE_WEB_AUTH_USER) config.webAuthUser = process.env.SPORE_WEB_AUTH_USER;
  if (process.env.SPORE_WEB_AUTH_PASS) config.webAuthPass = process.env.SPORE_WEB_AUTH_PASS;

  // SPORE invite key — single host-level secret used for two things:
  //   1. Webapp self-register gate (anyone with the key can create a
  //      webapp user account).
  //   2. Spore Code /auth gate (Go binaries pass the key to obtain a
  //      Bearer token).
  // Plugins read `config.inviteKey` from the host config; nobody owns
  // this slot from a plugin.
  if (process.env.SPORE_INVITE_KEY) config.inviteKey = process.env.SPORE_INVITE_KEY;

  // Public URL (set by manager during creation, or derived from legacy ingress vars)
  if (process.env.SPORE_PUBLIC_URL) {
    config.publicUrl = process.env.SPORE_PUBLIC_URL.replace(/\/+$/, '');
  }
  // Legacy per-agent ingress vars (backwards compat)
  if (process.env.SPORE_INGRESS_MODE) config.ingressMode = process.env.SPORE_INGRESS_MODE;
  if (process.env.SPORE_INGRESS_DOMAIN) config.ingressDomain = process.env.SPORE_INGRESS_DOMAIN;
  if (process.env.SPORE_INGRESS_PATH) config.ingressPath = process.env.SPORE_INGRESS_PATH;
  if (process.env.SPORE_INGRESS_HTTPS) config.ingressHttps = process.env.SPORE_INGRESS_HTTPS === 'true';
  if (process.env.SPORE_TEMP_NODE_TTL_HOURS) {
    const h = Number(process.env.SPORE_TEMP_NODE_TTL_HOURS);
    if (Number.isFinite(h) && h > 0) config.tempNodeTtlHours = h;
  }
  if (process.env.SPORE_JANITOR_MODE) {
    const m = String(process.env.SPORE_JANITOR_MODE).trim().toLowerCase();
    if (['conservative', 'moderate', 'aggressive'].includes(m)) config.janitorMode = m;
  }
  if (process.env.SPORE_JANITOR_INTERVAL_MINUTES) {
    const n = Number(process.env.SPORE_JANITOR_INTERVAL_MINUTES);
    if (Number.isFinite(n) && n > 0) config.janitorIntervalMinutes = n;
  }
  if (process.env.SPORE_JANITOR_RECYCLE_BIN_TTL_DAYS) {
    const n = Number(process.env.SPORE_JANITOR_RECYCLE_BIN_TTL_DAYS);
    if (Number.isFinite(n) && n >= 0) config.janitorRecycleBinTtlDays = n;
  }
  if (process.env.SPORE_JANITOR_PRUNE_BATCH) {
    const n = Number(process.env.SPORE_JANITOR_PRUNE_BATCH);
    if (Number.isFinite(n) && n > 0) config.janitorPruneBatchSize = Math.floor(n);
  }
  if (process.env.SPORE_JANITOR_ENABLED === 'false') config.janitorEnabled = false;
  if (process.env.SPORE_CHANNEL_DISTILLER_ENABLED === 'false') config.channelDistillerEnabled = false;
  if (process.env.SPORE_CHANNEL_DISTILLER_INTERVAL_MINUTES) {
    const n = Number(process.env.SPORE_CHANNEL_DISTILLER_INTERVAL_MINUTES);
    if (Number.isFinite(n) && n > 0) config.channelDistillerIntervalMinutes = n;
  }
  if (process.env.SPORE_CHANNEL_DISTILLER_IDLE_MINUTES) {
    const n = Number(process.env.SPORE_CHANNEL_DISTILLER_IDLE_MINUTES);
    if (Number.isFinite(n) && n > 0) config.channelDistillerIdleMinutes = n;
  }
  if (process.env.SPORE_CHANNEL_DISTILLER_BOOT_DELAY_MINUTES) {
    const n = Number(process.env.SPORE_CHANNEL_DISTILLER_BOOT_DELAY_MINUTES);
    if (Number.isFinite(n) && n >= 0) config.channelDistillerBootDelayMinutes = n;
  }
  if (process.env.SPORE_CHANNEL_DISTILLER_BATCH_SIZE) {
    const n = Number(process.env.SPORE_CHANNEL_DISTILLER_BATCH_SIZE);
    if (Number.isFinite(n) && n > 0) config.channelDistillerBatchSize = Math.floor(n);
  }
  if (process.env.SPORE_GRAPH_MAINTENANCE_ENABLED === 'false') config.graphMaintenanceEnabled = false;
  if (process.env.SPORE_GRAPH_MAINTENANCE_INTERVAL_MINUTES) {
    const n = Number(process.env.SPORE_GRAPH_MAINTENANCE_INTERVAL_MINUTES);
    if (Number.isFinite(n) && n > 0) config.graphMaintenanceIntervalMinutes = n;
  }
  if (process.env.SPORE_GRAPH_MAINTENANCE_BATCH_SIZE) {
    const n = Number(process.env.SPORE_GRAPH_MAINTENANCE_BATCH_SIZE);
    if (Number.isFinite(n) && n > 0) config.graphMaintenanceBatchSize = Math.floor(n);
  }
  if (process.env.SPORE_GENERAL_KB_RESEARCH_ENABLED === 'false') config.generalKbResearchEnabled = false;
  if (process.env.SPORE_GENERAL_KB_RESEARCH_INTERVAL_HOURS) {
    const n = Number(process.env.SPORE_GENERAL_KB_RESEARCH_INTERVAL_HOURS);
    if (Number.isFinite(n) && n > 0) config.generalKbResearchIntervalHours = n;
  }
  if (process.env.SPORE_GENERAL_KB_RESEARCH_BATCH_SIZE) {
    const n = Number(process.env.SPORE_GENERAL_KB_RESEARCH_BATCH_SIZE);
    if (Number.isFinite(n) && n > 0) config.generalKbResearchBatchSize = Math.floor(n);
  }
  if (process.env.SPORE_RUNTIME_QUEUE_ENABLED === 'false') config.runtimeQueueEnabled = false;
  if (process.env.SPORE_RUNTIME_QUEUE_LANE_LIMITS) {
    try {
      const limits = JSON.parse(process.env.SPORE_RUNTIME_QUEUE_LANE_LIMITS);
      if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
        config.runtimeQueueLaneLimits = { ...(config.runtimeQueueLaneLimits || {}), ...limits };
      }
    } catch {}
  }
  if (process.env.SPORE_BACKUP_ENABLED === 'false') config.graphBackupEnabled = false;
  if (process.env.SPORE_BACKUP_INTERVAL_MINUTES) {
    const n = Number(process.env.SPORE_BACKUP_INTERVAL_MINUTES);
    if (Number.isFinite(n) && n > 0) config.graphBackupIntervalMinutes = n;
  }
  if (process.env.SPORE_BACKUP_RETENTION) {
    const n = Number(process.env.SPORE_BACKUP_RETENTION);
    if (Number.isFinite(n) && n > 0) config.graphBackupRetention = Math.floor(n);
  }
  if (process.env.SPORE_BACKUP_DIR) config.graphBackupDir = process.env.SPORE_BACKUP_DIR;
  if (process.env.SPORE_BACKUP_ON_CHANGE_ONLY === 'false') config.graphBackupOnChangeOnly = false;
  if (process.env.SPORE_CLUSTER_USERNAME) config.clusterUsername = process.env.SPORE_CLUSTER_USERNAME.trim();
  if (process.env.SPORE_CLUSTER_LOGIN_HOST) config.clusterLoginHost = process.env.SPORE_CLUSTER_LOGIN_HOST.trim();
  if (process.env.SPORE_CLUSTER_TMUX_PREFIX) config.clusterTmuxPrefix = process.env.SPORE_CLUSTER_TMUX_PREFIX.trim();
  if (process.env.SPORE_EMAIL_PROVIDER) config.emailProvider = process.env.SPORE_EMAIL_PROVIDER.trim().toLowerCase();
  if (process.env.SPORE_EMAIL_ADDRESS) config.emailAddress = process.env.SPORE_EMAIL_ADDRESS.trim();
  if (process.env.SPORE_EMAIL_SMTP_HOST) config.emailSmtpHost = process.env.SPORE_EMAIL_SMTP_HOST.trim();
  if (process.env.SPORE_EMAIL_SMTP_PORT) {
    const n = Number(process.env.SPORE_EMAIL_SMTP_PORT);
    if (Number.isFinite(n) && n > 0) config.emailSmtpPort = n;
  }
  if (process.env.SPORE_EMAIL_SMTP_SECURE === 'true') config.emailSmtpSecure = true;
  if (process.env.SPORE_EMAIL_IMAP_HOST) config.emailImapHost = process.env.SPORE_EMAIL_IMAP_HOST.trim();
  if (process.env.SPORE_EMAIL_IMAP_PORT) {
    const n = Number(process.env.SPORE_EMAIL_IMAP_PORT);
    if (Number.isFinite(n) && n > 0) config.emailImapPort = n;
  }
  if (process.env.SPORE_EMAIL_IMAP_SECURE === 'false') config.emailImapSecure = false;
  if (process.env.SPORE_EMAIL_SMTP_PASSWORD) config.emailSmtpPassword = process.env.SPORE_EMAIL_SMTP_PASSWORD;
  if (process.env.SPORE_EMAIL_SMTP_USERNAME) config.emailSmtpUsername = process.env.SPORE_EMAIL_SMTP_USERNAME.trim();

  if (process.env.SPORE_CLUSTER_HOSTS) {
    try {
      const parsed = JSON.parse(process.env.SPORE_CLUSTER_HOSTS);
      if (Array.isArray(parsed)) config.clusterHosts = parsed;
    } catch (e) {
      console.warn('[config] SPORE_CLUSTER_HOSTS is not valid JSON:', e.message);
    }
  }
  if (process.env.SPORE_TAILSCALE_ENABLED === 'true') config.tailscaleEnabled = true;
  if (process.env.SPORE_TAILSCALE_HOSTNAME) config.tailscaleHostname = process.env.SPORE_TAILSCALE_HOSTNAME.trim();
  if (!config.tailscaleHostname) config.tailscaleHostname = `spore-${config.agentId || 'agent'}`;

  // Personality editing: agent can modify its own identity, voice, rules, personality aspects
  if (process.env.SPORE_PERSONALITY_EDITABLE === 'true') config.personalityEditable = true;

  // Src editing: bind-mounted src allows the agent to self-modify and have changes persist
  if (process.env.SPORE_SRC_EDITABLE === 'true') config.srcEditable = true;

  // Super agent orchestration
  if (process.env.MANAGER_URL) config.managerUrl = process.env.MANAGER_URL;
  if (process.env.MANAGER_SERVICE_KEY) config.managerServiceKey = process.env.MANAGER_SERVICE_KEY;
  if (!config.managerUrl) config.managerUrl = 'http://spore-manager:18900';
  if (!config.managerServiceKey) config.managerServiceKey = process.env.MANAGER_SERVICE_KEY || '';

  // Voice pipeline config
  if (process.env.SPORE_VOICE_ENABLED === 'true') config.voice.enabled = true;
  if (process.env.SPORE_STT_PROVIDER) config.voice.sttProvider = process.env.SPORE_STT_PROVIDER;
  if (process.env.SPORE_TTS_PROVIDER) config.voice.ttsProvider = process.env.SPORE_TTS_PROVIDER;
  if (process.env.SPORE_TTS_VOICE) config.voice.ttsVoice = process.env.SPORE_TTS_VOICE;
  if (process.env.SPORE_TTS_MODEL) config.voice.ttsModel = process.env.SPORE_TTS_MODEL;
  if (process.env.SPORE_TTS_SPEED) config.voice.ttsSpeed = parseFloat(process.env.SPORE_TTS_SPEED);
  if (process.env.SPORE_TTS_EDGE_VOICE) config.voice.edgeVoice = process.env.SPORE_TTS_EDGE_VOICE;

  // Proactive outreach
  if (!config.proactive) config.proactive = { ...DEFAULTS.proactive };
  if (process.env.SPORE_PROACTIVE_ENABLED) config.proactive.enabled = process.env.SPORE_PROACTIVE_ENABLED === 'true';
  if (process.env.SPORE_PROACTIVE_COOLDOWN) config.proactive.cooldownMinutes = parseInt(process.env.SPORE_PROACTIVE_COOLDOWN, 10);
  if (process.env.SPORE_PROACTIVE_MAX_DAY) config.proactive.maxPerDay = parseInt(process.env.SPORE_PROACTIVE_MAX_DAY, 10);
  if (process.env.SPORE_PROACTIVE_CHANNELS) config.proactive.channels = process.env.SPORE_PROACTIVE_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);

  // Auto-enable voice if a likely-STT key is present in the env. We
  // only peek at env (not config) — the actual STT plugin owns the
  // key. This is best-effort: the voice pipeline still asks the plugin
  // manager whether any STT provider is configured at runtime, and
  // gracefully no-ops when none is.
  const sttHintKeys = ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY'];
  const hasSttHint = sttHintKeys.some(k => !!process.env[k]);
  if (hasSttHint && config.voice.enabled !== false) {
    config.voice.enabled = true;
  }

  // Normalize nicknames to lowercase strings
  if (!Array.isArray(config.nicknames)) config.nicknames = [];
  config.nicknames = config.nicknames.map(n => String(n).toLowerCase().trim()).filter(Boolean);

  // displayName falls back to a prettified agentId if not set
  if (!config.displayName) {
    config.displayName = (config.agentId || 'spore')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  if (!config.discordToken && !config.telegramBotToken && !config.slackBotToken && !config.webPort) {
    console.warn('[config] No platform tokens or web port set — agent will only be reachable via the invoke API');
  }
  // Per-provider key validation moved to each provider plugin's
  // isConfigured/init time. Config-validation runs before plugins
  // load, so it can't see plugin state — the agent loop's init()
  // logs the actionable warning when a backend is selected but
  // unconfigured (see src/agent/loop.js).

  // Channel config shims
  if (!config.channels) config.channels = {};
  if (!config.channels.telegram) config.channels.telegram = { ...DEFAULTS.channels.telegram };

  if (config.telegramBotToken && !config.channels.telegram.botToken) {
    config.channels.telegram.botToken = config.telegramBotToken;
  }

  config.channels.telegram.enabled = Boolean(config.channels.telegram.enabled || config.channels.telegram.botToken);

  // Slack channel shim
  if (!config.channels.slack) config.channels.slack = { ...DEFAULTS.channels.slack };
  if (config.slackBotToken && !config.channels.slack.botToken) {
    config.channels.slack.botToken = config.slackBotToken;
  }
  if (config.slackAppToken && !config.channels.slack.appToken) {
    config.channels.slack.appToken = config.slackAppToken;
  }
  config.channels.slack.enabled = Boolean(
    config.channels.slack.botToken && config.channels.slack.appToken
  );

  // ── Model tier resolution (backward compat) ──────────────────────
  // Old configs set `model` only. New configs set normalModel/plannerModel.
  // If the legacy `model` key is set but the new keys aren't, fan it out.
  if (config.model && !config.normalModel) config.normalModel = config.model;
  if (config.model && !config.plannerModel) config.plannerModel = config.model;
  // Ensure `model` always points at the top-tier model for downstream compat
  // (provider init, /model command, app.js logging, detectBackend, etc.)
  config.model = config.plannerModel || config.normalModel || config.casualModel || null;

  const root = __dirname;
  if (config.graphDbPath && !path.isAbsolute(config.graphDbPath)) {
    config.graphDbPath = path.resolve(root, config.graphDbPath);
  }
  if (config.sessionDbPath && !path.isAbsolute(config.sessionDbPath)) {
    config.sessionDbPath = path.resolve(root, config.sessionDbPath);
  }
  // dataDir: parent of graph DB — all runtime state files live here
  if (!config.dataDir) config.dataDir = path.dirname(config.graphDbPath);
  if (!path.isAbsolute(config.dataDir)) config.dataDir = path.resolve(root, config.dataDir);

  if (!config.workspacePath) {
    config.workspacePath = _deriveDefaultWorkspacePath(config, root);
  }
  if (config.workspacePath) {
    config.workspacePath = path.isAbsolute(config.workspacePath)
      ? config.workspacePath
      : path.resolve(root, config.workspacePath);
  }

  // Shared dirs default to <dataDir>/shared/* (Docker mounts override via env)
  if (!config.sharedGraphsDir) config.sharedGraphsDir = path.join(config.dataDir, 'shared', 'graphs');
  if (!config.sharedSkillsDir) config.sharedSkillsDir = path.join(config.dataDir, 'shared', 'skills');

  return config;
}

/**
 * Cached config for the process. Sets GRAPH_DB_PATH for feed.js / embedder.js.
 * gateway.js must call this before requiring context.js.
 */
function loadConfig() {
  if (_configCache) return _configCache;
  _configCache = loadConfigFresh();
  process.env.GRAPH_DB_PATH = _configCache.graphDbPath;

  // Phase 1 dual-run: also boot the new schema-driven settings system
  // so its store + DB are warm. The new system runs alongside the legacy
  // one — reads still flow through this object, writes still flow through
  // _persistSettingsPatch, but the registry-backed snapshot is asserted
  // to match the legacy snapshot in dev mode (see _settingsDualRunAssert).
  // Phase 2 will switch the write path; Phase 3 will switch the read path.
  try {
    const settings = require('./settings');
    settings.boot({ dataDir: _configCache.dataDir });
    if (process.env.SPORE_SETTINGS_DUAL_RUN_ASSERT === '1' || process.env.NODE_ENV === 'development') {
      _settingsDualRunAssert(_configCache, settings);
    }
    // CRITICAL: copy settings.db values back into _configCache so the
    // legacy `config.foo` readers (agent loop, providers, _getSettingsState,
    // etc.) see persisted state on every boot. Without this, settings.db
    // has the values but every restart shows blank API keys / models in
    // the UI because legacy loadConfigFresh only reads spore.json/.env.
    _mirrorSettingsIntoLegacyConfig(_configCache, settings);
  } catch (e) {
    // Don't block boot if Phase 1 setup throws — log and continue.
    // eslint-disable-next-line no-console
    console.warn(`[config] settings module did not boot: ${e.stack || e.message}`);
  }

  return _configCache;
}

/**
 * Pull every value from the settings store into the legacy `config`
 * object the rest of the codebase consumes. Mirrors the same legacy-key
 * mapping used by WebGateway._mirrorSettingsToLegacyConfig — see the
 * inline comment there for the canonical list. We duplicate it here so
 * values are populated at boot, before any consumer reads them.
 */
function _mirrorSettingsIntoLegacyConfig(cfg, settings) {
  const snap = settings.snapshot();

  if (snap.displayName !== undefined) cfg.displayName = snap.displayName;
  if (Array.isArray(snap.nicknames)) cfg.nicknames = snap.nicknames;
  if (snap.agentId) cfg.agentId = snap.agentId;
  if (snap.enhancedRecall !== undefined) cfg.enhancedRecall = !!snap.enhancedRecall;

  const models = snap.models || {};
  if (models.casual !== undefined)         cfg.casualModel = models.casual;
  if (models.normal !== undefined)         cfg.normalModel = models.normal;
  if (models.planner !== undefined)        cfg.plannerModel = models.planner;
  if (models.subagent !== undefined)       cfg.subagentModel = models.subagent;
  if (models.learner !== undefined)        cfg.learnerModel = models.learner;
  if (models.imageVlm !== undefined)       cfg.imageVlmModel = models.imageVlm;
  if (models.videoVlm !== undefined)       cfg.videoVlmModel = models.videoVlm;
  if (models.audioVlm !== undefined)       cfg.audioVlmModel = models.audioVlm;
  if (models.recall !== undefined)         cfg.recallModel = models.recall;
  if (models.visionFallback !== undefined) cfg.visionFallbackModel = models.visionFallback;
  if (models.audioFallback !== undefined)  cfg.audioFallbackModel = models.audioFallback;
  if (models.videoFallback !== undefined)  cfg.videoFallbackModel = models.videoFallback;
  cfg.model = cfg.plannerModel || cfg.normalModel || cfg.casualModel || null;
  if (snap.modelLimits !== undefined)      cfg.modelLimits = snap.modelLimits;
  if (snap.tokenPricing !== undefined)     cfg.tokenPricing = snap.tokenPricing;

  const providers = snap.providers || {};
  if (providers.anthropic?.apiKey !== undefined)   cfg.anthropicApiKey = providers.anthropic.apiKey;
  if (providers.openai?.apiKey !== undefined)      cfg.openaiApiKey = providers.openai.apiKey;
  if (providers.openai?.baseUrl !== undefined)     cfg.openaiBaseUrl = providers.openai.baseUrl;
  if (providers.openrouter?.apiKey !== undefined)  cfg.openrouterApiKey = providers.openrouter.apiKey;
  if (providers.openrouter?.baseUrl !== undefined) cfg.openrouterBaseUrl = providers.openrouter.baseUrl;
  if (providers.openrouter?.referer !== undefined) cfg.openrouterReferer = providers.openrouter.referer;
  if (providers.local?.apiKey !== undefined)       cfg.localModelApiKey = providers.local.apiKey;
  if (providers.local?.baseUrl !== undefined)      cfg.localModelBaseUrl = providers.local.baseUrl;
  if (providers.local?.authHeader !== undefined)   cfg.localModelAuthHeader = providers.local.authHeader;
  if (providers.gemini?.apiKey !== undefined)      cfg.geminiApiKey = providers.gemini.apiKey;
  if (Array.isArray(providers.custom)) {
    cfg.customProviders = {};
    for (const p of providers.custom) {
      const name = String(p?.name || '').trim().toLowerCase();
      if (!name || !p?.url) continue;
      cfg.customProviders[name] = {
        url: p.url,
        key: p.key || '',
        authHeader: p.authHeader || 'bearer',
      };
    }
    const local = cfg.customProviders.local;
    if (local?.url) {
      cfg.localModelBaseUrl = local.url;
      cfg.localModelApiKey = local.key || '';
      cfg.localModelAuthHeader = local.authHeader || 'bearer';
    }
  }

  const ws = snap.webSearch || {};
  if (ws.searxngUrl !== undefined)    cfg.searxngUrl = ws.searxngUrl;
  if (ws.searxngApiKey !== undefined) cfg.searxngApiKey = ws.searxngApiKey;
  if (ws.braveApiKey !== undefined)   cfg.braveApiKey = ws.braveApiKey;

  if (snap.voice)     cfg.voice    = { ...(cfg.voice || {}),    ...snap.voice };
  if (snap.proactive) cfg.proactive = { ...(cfg.proactive || {}), ...snap.proactive };
  if (snap.plannerAdvisor) cfg.plannerAdvisor = { ...(cfg.plannerAdvisor || {}), ...snap.plannerAdvisor };
  if (snap.channels)  cfg.channels  = { ...(cfg.channels || {}),  ...snap.channels };

  // Plugin slots: settings store has plugins.<id>.<key> as flat keys.
  // Reassemble into config.plugins[id] = { ...fields }.
  if (!cfg.plugins) cfg.plugins = {};
  for (const [k, v] of Object.entries(settings.snapshotFlat())) {
    if (!k.startsWith('plugins.')) continue;
    const rest = k.slice('plugins.'.length);
    const slash = rest.indexOf('.');
    if (slash <= 0) continue;
    const pluginId = rest.slice(0, slash);
    const field = rest.slice(slash + 1);
    if (!cfg.plugins[pluginId]) cfg.plugins[pluginId] = {};
    cfg.plugins[pluginId][field] = v;
  }

  if (snap.browserBackend !== undefined) cfg.browserBackend = snap.browserBackend;

  // Other flat scalars that legacy code reads directly.
  for (const k of [
    'agentEffort', 'agentTimeoutMs', 'dmMaxIterations',
    'maxSessionMessages', 'sessionIdleTimeoutMinutes', 'sessionDailyResetHour',
    'maxTokens', 'contextWindow', 'compactTokenThreshold',
    'casualMessageBudget', 'complexMessageBudget', 'maxToolResultChars',
    'totalPromptBudget', 'sectionBudgets',
    'subagentMaxTokens', 'subagentMaxIter', 'subagentTimeoutSeconds',
    'maxSubagentChildren', 'lullMaxIterations',
    'tokenBudgetPressure', 'intermediateTextThrottleSeconds',
    'openaiReasoningEffort', 'learningMode', 'maintainerIdleOnly',
    'tempNodeTtlHours', 'janitorMode', 'janitorIntervalMinutes',
    'janitorRecycleBinTtlDays', 'janitorPruneBatchSize', 'janitorEnabled',
    'channelDistillerEnabled', 'channelDistillerIntervalMinutes',
    'channelDistillerIdleMinutes', 'channelDistillerBootDelayMinutes',
    'channelDistillerBatchSize',
    'graphMaintenanceEnabled', 'graphMaintenanceIntervalMinutes',
    'graphMaintenanceBatchSize',
    'generalKbResearchEnabled', 'generalKbResearchIntervalHours',
    'generalKbResearchBatchSize',
    'runtimeQueueEnabled', 'runtimeQueueLaneLimits',
    'nodePerformanceMetricViz',
    'graphBackupEnabled', 'graphBackupIntervalMinutes', 'graphBackupRetention',
    'graphBackupDir', 'graphBackupOnChangeOnly',
    'heartbeatIntervalMinutes',
    'clusterUsername', 'clusterLoginHost', 'clusterTmuxPrefix', 'clusterHosts',
    'tailscaleEnabled', 'tailscaleHostname',
    'hostReadPaths', 'extraPaths',
    'webPort', 'publicUrl', 'ingressMode', 'ingressDomain', 'ingressPath', 'ingressHttps',
    'webAuthUser', 'webAuthPass', 'inviteKey',
    'personalityEditable', 'srcEditable', 'credentialGuard',
    'pluginsEnabled', 'pluginsHotReload', 'embedder',
    'logLevel', 'agentBornDate',
  ]) {
    if (snap[k] !== undefined) cfg[k] = snap[k];
  }

  // Null means "use the runtime-derived workspace", not "fall back to /app".
  // Keep this separate from the generic scalar loop because settings defaults
  // are nullable while the runtime path must always be concrete.
  if (snap.workspacePath) {
    cfg.workspacePath = path.isAbsolute(snap.workspacePath)
      ? snap.workspacePath
      : path.resolve(__dirname, snap.workspacePath);
  }
}

/**
 * Phase 1 only — emits warnings when the legacy config object and the
 * new typed registry disagree about the resolved value of any
 * registered key. Does NOT throw; the legacy config remains the
 * source of truth until Phase 2.
 *
 * Drop this function (and its call site) when Phase 2 lands.
 */
function _settingsDualRunAssert(legacyConfig, settings) {
  // Keys that are intentionally new in the registry — no legacy
  // equivalent exists, so a mismatch here is expected. Drop entries
  // here as legacy code grows to set them.
  const NEW_REGISTRY_KEYS = new Set(['appearance.theme']);
  const mismatches = [];
  for (const def of settings.allDefs()) {
    if (def.pluginId) continue;          // plugin keys aren't on legacy config
    if (def.scope.includes('bootstrap')) continue;
    if (NEW_REGISTRY_KEYS.has(def.key)) continue;
    const legacyValue = _getLegacyConfigValue(legacyConfig, def.key);
    const newValue = settings.get(def.key);
    if (!_settingsValuesEqual(def.type, legacyValue, newValue)) {
      mismatches.push({ key: def.key, legacy: legacyValue, registry: newValue, type: def.type });
    }
  }
  if (mismatches.length) {
    // eslint-disable-next-line no-console
    console.warn(`[settings/dual-run] ${mismatches.length} key(s) differ between legacy config and registry:`);
    for (const m of mismatches.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.warn(`  ${m.key} (${m.type}): legacy=${JSON.stringify(m.legacy)} registry=${JSON.stringify(m.registry)}`);
    }
    if (mismatches.length > 20) {
      // eslint-disable-next-line no-console
      console.warn(`  …${mismatches.length - 20} more`);
    }
  }
}

function _getLegacyConfigValue(cfg, key) {
  // Registry keys are dotted; the legacy config has a mix of flat
  // (e.g. casualModel) and nested (e.g. voice.silenceThresholdMs) shapes.
  // Try nested-path resolution first; then map dotted registry keys back
  // to their legacy flat-key equivalent for the migrated names.
  const nested = key.split('.').reduce((acc, p) => (acc != null ? acc[p] : undefined), cfg);
  if (nested !== undefined) return nested;
  // Fallback: registry uses 'models.planner' but legacy uses 'plannerModel', etc.
  const flatMap = {
    'models.casual': 'casualModel',
    'models.normal': 'normalModel',
    'models.planner': 'plannerModel',
    'models.subagent': 'subagentModel',
    'models.learner': 'learnerModel',
    'models.imageVlm': 'imageVlmModel',
    'models.videoVlm': 'videoVlmModel',
    'models.audioVlm': 'audioVlmModel',
    'models.recall': 'recallModel',
    'models.visionFallback': 'visionFallbackModel',
    'models.audioFallback': 'audioFallbackModel',
    'models.videoFallback': 'videoFallbackModel',
    'providers.anthropic.apiKey': 'anthropicApiKey',
    'providers.openai.apiKey': 'openaiApiKey',
    'providers.openai.baseUrl': 'openaiBaseUrl',
    'providers.openrouter.apiKey': 'openrouterApiKey',
    'providers.openrouter.baseUrl': 'openrouterBaseUrl',
    'providers.openrouter.referer': 'openrouterReferer',
    'providers.local.apiKey': 'localModelApiKey',
    'providers.local.baseUrl': 'localModelBaseUrl',
    'providers.local.authHeader': 'localModelAuthHeader',
    'providers.gemini.apiKey': 'geminiApiKey',
    'webSearch.searxngUrl': 'searxngUrl',
    'webSearch.searxngApiKey': 'searxngApiKey',
    'webSearch.braveApiKey': 'braveApiKey',
    'channels.telegram.botToken': 'telegramBotToken',
    'channels.slack.botToken': 'slackBotToken',
    'channels.slack.appToken': 'slackAppToken',
    'channels.discord.token': 'discordToken',
    'channels.discord.admins': 'discordAdmins',
    'channels.discord.maxMessageLength': 'maxMessageLength',
    'channels.discord.typingInterval': 'typingInterval',
    'channels.discord.maxQueuePerChannel': 'maxQueuePerChannel',
    'channels.discord.messageDebounceMs': 'messageDebounceMs',
  };
  if (flatMap[key]) return cfg[flatMap[key]];
  return undefined;
}

function _settingsValuesEqual(type, a, b) {
  // null / undefined / empty-string are interchangeable for this
  // assertion: legacy code uses any of the three to mean "unset".
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return true;
  if (aEmpty || bEmpty) return false;
  if (type === 'array<string>') {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  if (type === 'json') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  if (type === 'integer' || type === 'number') {
    return Number(a) === Number(b);
  }
  if (type === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return String(a) === String(b);
}

function resetConfigCache() {
  _configCache = null;
}

module.exports = { loadConfig, loadConfigFresh, resetConfigCache, createLogger };
