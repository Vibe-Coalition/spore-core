/**
 * config.js — Configuration loader for Anima
 * 
 * Loads from anima.json and environment variables.
 * Priority: env vars > anima.json > defaults
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
  // Model tiering — resolved from ANIMA_MODEL / per-tier env vars at load time.
  // No hardcoded provider — the user's configured model is used for all tiers.
  casualModel: null,
  normalModel: null,
  plannerModel: null,
  subagentModel: null,
  learnerModel: null,
  model: null, // DEPRECATED — backward compat; resolved to plannerModel at load time
  agentId: 'anima',
  /** Optional YYYY-MM-DD — authoritative "born" date for prompt tenure math (overrides graph node created). */
  agentBornDate: null,
  displayName: null,      // e.g. "Harry The Alien" — how the agent introduces itself
  nicknames: [],          // e.g. ["harry", "h"] — group chat trigger words
  maxTokens: 8192,
  contextWindow: 200000,

  // Learner
  learningMode: 'always', // 'always' | 'flush_only' | 'disabled'
  subagentMaxTokens: null, // null = auto based on model (opus 64K, sonnet 32K, haiku 16K)
  maintainerIdleOnly: true,

  // Optional capabilities
  webPort: null,            // ANIMA_WEB_PORT — expose an HTTP server on this port
  hostReadPaths: [],        // ANIMA_HOST_READ_PATHS — host paths mounted at /host/<path>
  personalityEditable: false, // ANIMA_PERSONALITY_EDITABLE — agent can modify its own identity/voice/rules
  srcEditable: false,       // ANIMA_SRC_EDITABLE — src bind-mounted rw; agent can self-modify and changes persist
  enhancedRecall: false,    // LLM-at-search-time query decomposition for better temporal recall

  // Paths (Docker overrides via GRAPH_DB_PATH=/data/graph.db in compose)
  graphDbPath: path.join(__dirname, 'data', 'graph.db'),
  sessionDbPath: path.join(__dirname, 'sessions.db'),
  workspacePath: null, // null = process.cwd() in tools; or set e.g. "./workspace"

  // Session + Compaction
  maxSessionMessages: 200,
  compactTokenThreshold: 80000,
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
  agentTimeoutMs: 600000,
  intermediateTextThrottleSeconds: 30,
  dmMaxIterations: 20,
  tokenBudgetPressure: 120000,
  maxConcurrent: 6,
  maxSubagentChildren: 8,
  subagentMaxIter: 50,
  subagentTimeoutSeconds: 1200,
  lullMaxIterations: 4,
  loopDetection: {
    warn: 5,
    critical: 10,
    pingPong: 8,
    ceiling: 50,
    budgetPressure: 15,
  },

  // Proactive outreach (heartbeat-triggered, personality-gated)
  proactive: {
    enabled: false,
    cooldownMinutes: 180,
    maxPerDay: 3,
    channels: [],
  },

  // Heartbeat
  heartbeatIntervalMinutes: 120,

  // Health check
  healthPort: 18790,
  healthBindAddr: '0.0.0.0', // HEALTH_BIND_ADDR — container default; host restriction via docker-compose port mapping

  // Security
  discordAdmins: [],           // ANIMA_DISCORD_ADMINS — comma-separated user/role IDs for privileged commands

  // Plugins
  pluginsDir: null,            // ANIMA_PLUGINS_DIR — defaults to {workspace}/plugins

  // Logging
  logLevel: 'info',
};

let _configCache = null;

/**
 * Merge anima.json + env and resolve relative paths. Does not use the process cache.
 */
function loadConfigFresh() {
  const config = { ...DEFAULTS };

  const configPath = path.join(__dirname, 'anima.json');
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
      console.error('[config] Failed to parse anima.json:', e.message);
    }
  }

  if (process.env.DISCORD_TOKEN) config.discordToken = process.env.DISCORD_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.AGENT_ID) config.agentId = process.env.AGENT_ID;
  if (process.env.ANIMA_AGENT_BORN_DATE) config.agentBornDate = process.env.ANIMA_AGENT_BORN_DATE.trim();
  if (process.env.ANIMA_DISPLAY_NAME) config.displayName = process.env.ANIMA_DISPLAY_NAME;
  if (process.env.ANIMA_NICKNAMES) config.nicknames = process.env.ANIMA_NICKNAMES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.BRAVE_API_KEY) config.braveApiKey = process.env.BRAVE_API_KEY;
  if (process.env.TELEGRAM_BOT_TOKEN) config.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

  // Slack
  if (process.env.SLACK_BOT_TOKEN) config.slackBotToken = process.env.SLACK_BOT_TOKEN;
  if (process.env.SLACK_APP_TOKEN) config.slackAppToken = process.env.SLACK_APP_TOKEN;

  // Voice / STT / TTS keys
  if (process.env.DEEPGRAM_API_KEY) config.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (process.env.OPENAI_API_KEY) config.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.XI_API_KEY) config.xiApiKey = process.env.XI_API_KEY;

  if (process.env.GRAPH_DB_PATH) config.graphDbPath = process.env.GRAPH_DB_PATH;
  if (process.env.SESSION_DB_PATH) config.sessionDbPath = process.env.SESSION_DB_PATH;
  if (process.env.ANIMA_WORKSPACE_PATH) config.workspacePath = process.env.ANIMA_WORKSPACE_PATH;

  // Derived directories — all persistent files should use these instead of hardcoded paths.
  // Docker: GRAPH_DB_PATH=/data/graph.db → dataDir=/data, workspacePath=/workspace
  // Bare:   GRAPH_DB_PATH=./data/graph.db → dataDir=./data, workspacePath=./workspace
  if (process.env.ANIMA_DATA_DIR) config.dataDir = process.env.ANIMA_DATA_DIR;
  if (process.env.SHARED_GRAPHS_DIR) config.sharedGraphsDir = process.env.SHARED_GRAPHS_DIR;
  if (process.env.SHARED_SKILLS_DIR) config.sharedSkillsDir = process.env.SHARED_SKILLS_DIR;
  if (process.env.ANIMA_MODEL) config.model = process.env.ANIMA_MODEL;
  if (process.env.ANIMA_CASUAL_MODEL) config.casualModel = process.env.ANIMA_CASUAL_MODEL;
  if (process.env.ANIMA_NORMAL_MODEL) config.normalModel = process.env.ANIMA_NORMAL_MODEL;
  if (process.env.ANIMA_PLANNER_MODEL) config.plannerModel = process.env.ANIMA_PLANNER_MODEL;
  if (process.env.ANIMA_LOG_LEVEL) config.logLevel = process.env.ANIMA_LOG_LEVEL;
  if (process.env.ANIMA_HEALTH_PORT) config.healthPort = parseInt(process.env.ANIMA_HEALTH_PORT, 10);
  if (process.env.ANIMA_LEARNER_MODEL) config.learnerModel = process.env.ANIMA_LEARNER_MODEL;
  if (process.env.ANIMA_SUBAGENT_MODEL) config.subagentModel = process.env.ANIMA_SUBAGENT_MODEL;
  if (process.env.ANIMA_SUBAGENT_MAX_TOKENS) config.subagentMaxTokens = parseInt(process.env.ANIMA_SUBAGENT_MAX_TOKENS, 10);
  if (process.env.ANIMA_HEARTBEAT_MINUTES) config.heartbeatIntervalMinutes = parseInt(process.env.ANIMA_HEARTBEAT_MINUTES, 10);
  if (process.env.ANIMA_DEBOUNCE_MS) config.messageDebounceMs = parseInt(process.env.ANIMA_DEBOUNCE_MS, 10);
  if (process.env.HEALTH_BIND_ADDR) config.healthBindAddr = process.env.HEALTH_BIND_ADDR;
  if (process.env.ANIMA_DISCORD_ADMINS) config.discordAdmins = process.env.ANIMA_DISCORD_ADMINS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.ANIMA_PLUGINS_DIR) config.pluginsDir = process.env.ANIMA_PLUGINS_DIR;
  if (process.env.ANIMA_INTERMEDIATE_THROTTLE) config.intermediateTextThrottleSeconds = parseInt(process.env.ANIMA_INTERMEDIATE_THROTTLE, 10);

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) config.openrouterApiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_BASE_URL) config.openrouterBaseUrl = process.env.OPENROUTER_BASE_URL;
  if (process.env.OPENROUTER_REFERER) config.openrouterReferer = process.env.OPENROUTER_REFERER;

  // Local / OAI-compat (Ollama, LM Studio, vLLM, etc.)
  if (process.env.LOCAL_MODEL_BASE_URL) config.localModelBaseUrl = process.env.LOCAL_MODEL_BASE_URL;
  if (process.env.LOCAL_MODEL_API_KEY) config.localModelApiKey = process.env.LOCAL_MODEL_API_KEY;

  // Gemini
  if (process.env.GEMINI_API_KEY) config.geminiApiKey = process.env.GEMINI_API_KEY;

  // Vision fallback model (used when active model lacks VLM support)
  if (process.env.ANIMA_VISION_FALLBACK_MODEL) config.visionFallbackModel = process.env.ANIMA_VISION_FALLBACK_MODEL;
  if (!config.visionFallbackModel) config.visionFallbackModel = null;

  // Custom providers: ANIMA_PROVIDER_<NAME>_URL, _KEY, _AUTH_HEADER
  // e.g. ANIMA_PROVIDER_TOGETHER_URL=https://api.together.xyz/v1 → config.customProviders.together
  // Capabilities (vision, tools, audio, video) are auto-detected at runtime.
  if (!config.customProviders) config.customProviders = {};
  const providerRe = /^ANIMA_PROVIDER_([A-Z0-9_]+)_(URL|KEY|AUTH_HEADER)$/;
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
  if (process.env.ANIMA_CONTEXT_WINDOW) config.contextWindow = parseInt(process.env.ANIMA_CONTEXT_WINDOW, 10);
  if (process.env.ANIMA_COMPACT_THRESHOLD) config.compactTokenThreshold = parseInt(process.env.ANIMA_COMPACT_THRESHOLD, 10);
  if (process.env.ANIMA_COMPACT_KEEP_TAIL) config.compactKeepTail = parseInt(process.env.ANIMA_COMPACT_KEEP_TAIL, 10);
  if (process.env.ANIMA_LEARNING_MODE) config.learningMode = process.env.ANIMA_LEARNING_MODE;
  if (process.env.ANIMA_MAINTAINER_IDLE_ONLY) config.maintainerIdleOnly = process.env.ANIMA_MAINTAINER_IDLE_ONLY === 'true';

  // Web server port (0 / unset = disabled)
  if (process.env.ANIMA_WEB_PORT) {
    const wp = parseInt(process.env.ANIMA_WEB_PORT, 10);
    config.webPort = wp > 0 ? wp : null;
  }

  // Host filesystem read access: comma-separated host paths mounted at /host/<path>
  if (process.env.ANIMA_HOST_READ_PATHS) {
    config.hostReadPaths = process.env.ANIMA_HOST_READ_PATHS.split(',').map(p => p.trim()).filter(Boolean);
  }

  // Web basic auth
  if (process.env.ANIMA_WEB_AUTH_USER) config.webAuthUser = process.env.ANIMA_WEB_AUTH_USER;
  if (process.env.ANIMA_WEB_AUTH_PASS) config.webAuthPass = process.env.ANIMA_WEB_AUTH_PASS;

  // Public URL (set by manager during creation, or derived from legacy ingress vars)
  if (process.env.ANIMA_PUBLIC_URL) {
    config.publicUrl = process.env.ANIMA_PUBLIC_URL.replace(/\/+$/, '');
  }
  // Legacy per-agent ingress vars (backwards compat)
  if (process.env.ANIMA_INGRESS_MODE) config.ingressMode = process.env.ANIMA_INGRESS_MODE;
  if (process.env.ANIMA_INGRESS_DOMAIN) config.ingressDomain = process.env.ANIMA_INGRESS_DOMAIN;
  if (process.env.ANIMA_INGRESS_PATH) config.ingressPath = process.env.ANIMA_INGRESS_PATH;
  if (process.env.ANIMA_INGRESS_HTTPS) config.ingressHttps = process.env.ANIMA_INGRESS_HTTPS === 'true';

  // Personality editing: agent can modify its own identity, voice, rules, personality aspects
  if (process.env.ANIMA_PERSONALITY_EDITABLE === 'true') config.personalityEditable = true;

  // Src editing: bind-mounted src allows the agent to self-modify and have changes persist
  if (process.env.ANIMA_SRC_EDITABLE === 'true') config.srcEditable = true;

  // Super agent orchestration
  if (process.env.MANAGER_URL) config.managerUrl = process.env.MANAGER_URL;
  if (process.env.MANAGER_SERVICE_KEY) config.managerServiceKey = process.env.MANAGER_SERVICE_KEY;
  if (!config.managerUrl) config.managerUrl = 'http://anima-manager:18900';
  if (!config.managerServiceKey) config.managerServiceKey = process.env.MANAGER_SERVICE_KEY || '';

  // Voice pipeline config
  if (process.env.ANIMA_VOICE_ENABLED === 'true') config.voice.enabled = true;
  if (process.env.ANIMA_STT_PROVIDER) config.voice.sttProvider = process.env.ANIMA_STT_PROVIDER;
  if (process.env.ANIMA_TTS_PROVIDER) config.voice.ttsProvider = process.env.ANIMA_TTS_PROVIDER;
  if (process.env.ANIMA_TTS_VOICE) config.voice.ttsVoice = process.env.ANIMA_TTS_VOICE;
  if (process.env.ANIMA_TTS_MODEL) config.voice.ttsModel = process.env.ANIMA_TTS_MODEL;
  if (process.env.ANIMA_TTS_SPEED) config.voice.ttsSpeed = parseFloat(process.env.ANIMA_TTS_SPEED);
  if (process.env.ANIMA_TTS_EDGE_VOICE) config.voice.edgeVoice = process.env.ANIMA_TTS_EDGE_VOICE;

  // Proactive outreach
  if (!config.proactive) config.proactive = { ...DEFAULTS.proactive };
  if (process.env.ANIMA_PROACTIVE_ENABLED) config.proactive.enabled = process.env.ANIMA_PROACTIVE_ENABLED === 'true';
  if (process.env.ANIMA_PROACTIVE_COOLDOWN) config.proactive.cooldownMinutes = parseInt(process.env.ANIMA_PROACTIVE_COOLDOWN, 10);
  if (process.env.ANIMA_PROACTIVE_MAX_DAY) config.proactive.maxPerDay = parseInt(process.env.ANIMA_PROACTIVE_MAX_DAY, 10);
  if (process.env.ANIMA_PROACTIVE_CHANNELS) config.proactive.channels = process.env.ANIMA_PROACTIVE_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);

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
    config.displayName = (config.agentId || 'anima')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  if (!config.discordToken && !config.telegramBotToken && !config.slackBotToken && !config.webPort) {
    console.warn('[config] No platform tokens or web port set — agent will only be reachable via the invoke API');
  }
  // Anthropic key only required when main model is Anthropic-backed
  const mainPrefix = config.model?.split('/')[0];
  const mainBackend = config.model?.startsWith('openrouter/') ? 'openrouter'
    : config.model?.startsWith('local/') ? 'local'
      : config.model?.startsWith('gemini/') ? 'gemini'
        : (config.customProviders?.[mainPrefix]) ? 'custom'
          : 'anthropic';
  if (mainBackend === 'anthropic' && !config.anthropicApiKey) {
    console.error('[config] Missing Anthropic API key. Set ANTHROPIC_API_KEY env var or configure anima.json');
  }
  if (mainBackend === 'openrouter' && !config.openrouterApiKey) {
    console.error('[config] Missing OpenRouter API key. Set OPENROUTER_API_KEY env var or configure anima.json');
  }
  if (mainBackend === 'gemini' && !config.geminiApiKey && !process.env.GEMINI_API_KEY) {
    console.error('[config] Missing Gemini API key. Set GEMINI_API_KEY env var or configure anima.json');
  }
  if (mainBackend === 'custom') {
    const prov = config.customProviders[mainPrefix];
    if (!prov?.url) console.error(`[config] Custom provider '${mainPrefix}' missing URL. Set ANIMA_PROVIDER_${mainPrefix.toUpperCase()}_URL`);
  }

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
