/**
 * config.js — Configuration loader for SPORE
 * 
 * Loads from spore.json and environment variables.
 * Priority: env vars > spore.json > defaults
 */

const fs = require('fs');
const path = require('path');

// Load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
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
  model: null, // DEPRECATED — backward compat; resolved to plannerModel at load time
  agentId: 'spore',
  /** Optional YYYY-MM-DD — authoritative "born" date for prompt tenure math (overrides graph node created). */
  agentBornDate: null,
  displayName: null,      // e.g. "Harry The Alien" — how the agent introduces itself
  nicknames: [],          // e.g. ["harry", "h"] — group chat trigger words
  maxTokens: 16384,
  contextWindow: 200000,

  // Learner
  learningMode: 'always', // 'always' | 'flush_only' | 'disabled'
  subagentMaxTokens: null, // null = auto, derived from the active model's modelLimits[].maxTokens
  maintainerIdleOnly: false,

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
  workspacePath: null, // null = process.cwd() in tools; or set e.g. "./workspace"

  // Session + Compaction
  maxSessionMessages: 200,
  compactTokenThreshold: 120000,
  compactKeepTail: 20,
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

  // Voice (STT/TTS pipeline for Discord voice channels + Telegram voice notes)
  voice: {
    enabled: false,
    sttProvider: 'deepgram',
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
  maxConcurrent: 6,
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
  pluginsHotReload: false,     // SPORE_PLUGINS_HOT_RELOAD — opt-in; allow runtime install/uninstall via /api/plugins
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

  // Prefer spore.json; fall back to legacy anima.json for un-migrated bind mounts.
  let configPath = path.join(__dirname, 'spore.json');
  if (!fs.existsSync(configPath)) configPath = path.join(__dirname, 'anima.json');
  if (fs.existsSync(configPath)) {
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

  // Voice / STT / TTS keys + shared OpenAI API key
  if (process.env.DEEPGRAM_API_KEY) config.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (process.env.OPENAI_API_KEY) config.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.XI_API_KEY) config.xiApiKey = process.env.XI_API_KEY;

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
  if (process.env.SPORE_SUBAGENT_MODEL) config.subagentModel = process.env.SPORE_SUBAGENT_MODEL;
  if (process.env.SPORE_IMAGE_VLM_MODEL) config.imageVlmModel = process.env.SPORE_IMAGE_VLM_MODEL;
  if (process.env.SPORE_VIDEO_VLM_MODEL) config.videoVlmModel = process.env.SPORE_VIDEO_VLM_MODEL;
  if (process.env.SPORE_AUDIO_VLM_MODEL) config.audioVlmModel = process.env.SPORE_AUDIO_VLM_MODEL;
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
  if (process.env.SPORE_COMPACT_KEEP_TAIL) config.compactKeepTail = parseInt(process.env.SPORE_COMPACT_KEEP_TAIL, 10);
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
  //   2. acorn-cli /auth gate (Go binaries pass the key to obtain a
  //      Bearer token).
  // Reads SPORE_INVITE_KEY first, falls back to legacy SPORE_ACORN_KEY
  // for backward compat. Plugins read `config.inviteKey` from the host
  // config; nobody owns this slot from a plugin.
  if (process.env.SPORE_INVITE_KEY) config.inviteKey = process.env.SPORE_INVITE_KEY;
  else if (process.env.SPORE_ACORN_KEY) config.inviteKey = process.env.SPORE_ACORN_KEY;

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

  // Auto-enable voice if STT is available (TTS always available via free Edge TTS fallback)
  const hasSTT = !!(config.deepgramApiKey || config.openaiApiKey);
  if (hasSTT && config.voice.enabled !== false) {
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
  if (config.workspacePath) {
    config.workspacePath = path.isAbsolute(config.workspacePath)
      ? config.workspacePath
      : path.resolve(root, config.workspacePath);
  }

  // dataDir: parent of graph DB — all runtime state files live here
  if (!config.dataDir) config.dataDir = path.dirname(config.graphDbPath);
  if (!path.isAbsolute(config.dataDir)) config.dataDir = path.resolve(root, config.dataDir);

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
  return _configCache;
}

function resetConfigCache() {
  _configCache = null;
}

// Logger utility
function createLogger(level = 'info') {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const threshold = levels[level] ?? 1;
  const ring = [];
  const RING_MAX = 2000;

  const log = (lvl, ...args) => {
    if ((levels[lvl] ?? 1) >= threshold) {
      const ts = new Date().toISOString().substring(11, 19);
      const line = `[${ts}] [${lvl}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
      console[lvl === 'debug' ? 'log' : lvl](`[${ts}] [${lvl}]`, ...args);
      ring.push(line);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    }
  };

  return {
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    _ring: ring,
  };
}

module.exports = { loadConfig, loadConfigFresh, resetConfigCache, createLogger };
