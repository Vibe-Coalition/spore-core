/**
 * settings/defs.core.js — every core spore-core setting declared once.
 *
 * Ported from src/config.js DEFAULTS object and the env-var loader
 * block (config.js:329-620). Each entry says exactly what it is, what
 * its env override is, where it shows up (server/wizard/settings/
 * runtime), and what type rules apply.
 *
 * Keep this file alphabetized within groups for diff sanity. Plugins
 * extend the registry at register() time — their entries live in
 * `plugins.<id>.<key>` keyspace.
 */

'use strict';

const { register } = require('./registry');

// Helper for repetitive registration patterns ─────────────────────────
function R(def) { return register(def); }

// ──────────────────────────────────────────────────────────────────────
// Bootstrap (read before settings.db opens — env-only)
// ──────────────────────────────────────────────────────────────────────
R({ key: 'dataDir',         type: 'string',  default: null, envVar: 'SPORE_DATA_DIR',
    scope: ['server', 'bootstrap'], group: 'paths', label: 'Data directory' });
R({ key: 'graphDbPath',     type: 'string',  default: null, envVar: 'GRAPH_DB_PATH',
    scope: ['server', 'bootstrap'], group: 'paths', label: 'Graph DB path' });
R({ key: 'sessionDbPath',   type: 'string',  default: null, envVar: 'SESSION_DB_PATH',
    scope: ['server', 'bootstrap'], group: 'paths' });
R({ key: 'settingsDbPath',  type: 'string',  default: null, envVar: 'SETTINGS_DB_PATH',
    scope: ['server', 'bootstrap'], group: 'paths' });
R({ key: 'workspacePath',   type: 'string',  default: null, envVar: 'SPORE_WORKSPACE_PATH',
    scope: ['server'], group: 'paths' });
R({ key: 'sharedGraphsDir', type: 'string',  default: null, envVar: 'SHARED_GRAPHS_DIR',
    scope: ['server'], group: 'paths' });
R({ key: 'sharedSkillsDir', type: 'string',  default: null, envVar: 'SHARED_SKILLS_DIR',
    scope: ['server'], group: 'paths' });

// ──────────────────────────────────────────────────────────────────────
// Identity
// ──────────────────────────────────────────────────────────────────────
R({ key: 'agentId',        type: 'string', default: 'spore', envVar: 'AGENT_ID',
    scope: ['server', 'wizard', 'settings'], group: 'identity', label: 'Agent ID' });
R({ key: 'agentBornDate',  type: 'string', default: null, envVar: 'SPORE_AGENT_BORN_DATE',
    scope: ['server', 'settings'], group: 'identity',
    coerce: v => String(v).trim(),
    validate: v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'expected YYYY-MM-DD' });
R({ key: 'displayName',    type: 'string', default: null, envVar: 'SPORE_DISPLAY_NAME',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'identity', label: 'Display name' });
R({ key: 'nicknames',      type: 'array<string>', default: [], envVar: 'SPORE_NICKNAMES',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'identity', label: 'Nicknames',
    coerce: arr => Array.isArray(arr) ? arr.map(n => String(n).toLowerCase().trim()).filter(Boolean) : arr });

// ──────────────────────────────────────────────────────────────────────
// Models — the big fallback chain area
// ──────────────────────────────────────────────────────────────────────
// Model tier defs. `tierKind: 'main' | 'vlm'` controls which wizard
// step renders the tier (main models step vs the VLM/multimodal step).
// Adding a tier is a one-line change here — the wizard's rendering
// list and the settings UI both iterate the registry.
R({ key: 'models.casual',    type: 'string', default: null, envVar: 'SPORE_CASUAL_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Casual model',
    fallbackChain: ['models.normal', 'models.planner'] });
R({ key: 'models.normal',    type: 'string', default: null, envVar: 'SPORE_NORMAL_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Normal model',
    fallbackChain: ['models.planner', 'models.casual'] });
R({ key: 'models.planner',   type: 'string', default: null, envVar: 'SPORE_PLANNER_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Planner model',
    legacyAlias: ['SPORE_MODEL'],
    fallbackChain: ['models.normal', 'models.casual'] });
R({ key: 'models.subagent',  type: 'string', default: null, envVar: 'SPORE_SUBAGENT_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Sub-agent model',
    fallbackChain: ['models.planner', 'models.normal', 'models.casual'] });
R({ key: 'models.learner',   type: 'string', default: null, envVar: 'SPORE_LEARNER_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Learner model',
    fallbackChain: ['models.casual', 'models.normal'] });
R({ key: 'models.recall',    type: 'string', default: null, envVar: 'SPORE_RECALL_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'main',
    label: 'Recall model',
    fallbackChain: ['models.learner', 'models.casual'] });
R({ key: 'models.imageVlm',  type: 'string', default: null, envVar: 'SPORE_IMAGE_VLM_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'vlm',
    label: 'Image VLM model' });
R({ key: 'models.videoVlm',  type: 'string', default: null, envVar: 'SPORE_VIDEO_VLM_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'vlm',
    label: 'Video VLM model' });
R({ key: 'models.audioVlm',  type: 'string', default: null, envVar: 'SPORE_AUDIO_VLM_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'models', tierKind: 'vlm',
    label: 'Audio VLM model' });
R({ key: 'models.visionFallback', type: 'string', default: null, envVar: 'SPORE_VISION_FALLBACK_MODEL',
    scope: ['server', 'runtime'], group: 'models' });
R({ key: 'models.audioFallback',  type: 'string', default: null, envVar: 'SPORE_AUDIO_FALLBACK_MODEL',
    scope: ['server', 'runtime'], group: 'models' });
R({ key: 'models.videoFallback',  type: 'string', default: null, envVar: 'SPORE_VIDEO_FALLBACK_MODEL',
    scope: ['server', 'runtime'], group: 'models' });
R({ key: 'modelLimits',      type: 'json',   default: null, envVar: 'SPORE_MODEL_LIMITS',
    scope: ['server', 'settings', 'runtime'], group: 'models', label: 'Per-model context limits' });

// ──────────────────────────────────────────────────────────────────────
// Providers (host-level keys; voice/embedder/email keys live in plugins)
// ──────────────────────────────────────────────────────────────────────
R({ key: 'providers.anthropic.apiKey', type: 'secret', default: null, envVar: 'ANTHROPIC_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'Anthropic API key' });
R({ key: 'providers.openai.apiKey',    type: 'secret', default: null, envVar: 'OPENAI_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'OpenAI API key' });
R({ key: 'providers.openai.baseUrl',   type: 'string', default: null, envVar: 'OPENAI_BASE_URL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'OpenAI base URL',
    placeholder: 'https://api.openai.com/v1' });
R({ key: 'providers.openrouter.apiKey',  type: 'secret', default: null, envVar: 'OPENROUTER_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'OpenRouter API key' });
R({ key: 'providers.openrouter.baseUrl', type: 'string', default: null, envVar: 'OPENROUTER_BASE_URL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers' });
R({ key: 'providers.openrouter.referer', type: 'string', default: null, envVar: 'OPENROUTER_REFERER',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers' });
R({ key: 'providers.local.apiKey',     type: 'secret', default: null, envVar: 'LOCAL_MODEL_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'Local model API key' });
R({ key: 'providers.local.baseUrl',    type: 'string', default: null, envVar: 'LOCAL_MODEL_BASE_URL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers', label: 'Local model base URL' });
R({ key: 'providers.local.authHeader', type: 'string', default: null,
    envVar: 'LOCAL_MODEL_AUTH_HEADER',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers',
    validate: v => v == null || ['bearer', 'x-api-key', 'x-key'].includes(v) ? null : 'bearer | x-api-key | x-key' });
R({ key: 'providers.gemini.apiKey',    type: 'secret', default: null, envVar: 'GEMINI_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers' });
R({ key: 'providers.custom',           type: 'json',   default: [],
    secret: true, structuredSecret: true,
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'providers',
    label: 'Custom OAI-compatible providers' });

// ──────────────────────────────────────────────────────────────────────
// Embeddings
// ──────────────────────────────────────────────────────────────────────
R({ key: 'embedder', type: 'string', default: null, envVar: 'SPORE_EMBEDDER',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'embeddings',
    label: 'Active embedder' });

// ──────────────────────────────────────────────────────────────────────
// Web search
// ──────────────────────────────────────────────────────────────────────
R({ key: 'webSearch.searxngUrl',    type: 'string', default: null, envVar: 'SEARXNG_URL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'webSearch' });
R({ key: 'webSearch.searxngApiKey', type: 'secret', default: null, envVar: 'SEARXNG_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'webSearch' });
R({ key: 'webSearch.braveApiKey',   type: 'secret', default: null, envVar: 'BRAVE_API_KEY',
    secret: true, scope: ['server', 'wizard', 'settings', 'runtime'], group: 'webSearch' });

// ──────────────────────────────────────────────────────────────────────
// Voice pipeline
// ──────────────────────────────────────────────────────────────────────
R({ key: 'voice.enabled',           type: 'boolean', default: false, envVar: 'SPORE_VOICE_ENABLED',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'voice', label: 'Voice enabled' });
R({ key: 'voice.sttProvider',       type: 'string', default: null, envVar: 'SPORE_STT_PROVIDER',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'voice', label: 'STT provider' });
R({ key: 'voice.ttsProvider',       type: 'string', default: null, envVar: 'SPORE_TTS_PROVIDER',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'voice', label: 'TTS provider' });
R({ key: 'voice.ttsVoice',          type: 'string', default: null, envVar: 'SPORE_TTS_VOICE',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'voice' });
R({ key: 'voice.ttsModel',          type: 'string', default: null, envVar: 'SPORE_TTS_MODEL',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'voice' });
R({ key: 'voice.ttsSpeed',          type: 'number', default: 1.0, envVar: 'SPORE_TTS_SPEED',
    scope: ['server', 'settings', 'runtime'], group: 'voice',
    validate: v => v >= 0.25 && v <= 4.0 ? null : '0.25..4.0' });
R({ key: 'voice.edgeVoice',         type: 'string', default: 'en-US-AriaNeural', envVar: 'SPORE_TTS_EDGE_VOICE',
    scope: ['server', 'settings', 'runtime'], group: 'voice' });
R({ key: 'voice.silenceThresholdMs', type: 'integer', default: 400,
    scope: ['server', 'settings', 'runtime'], group: 'voice', label: 'Silence threshold (ms)',
    validate: v => v >= 100 && v <= 5000 ? null : '100..5000' });
R({ key: 'voice.maxUtteranceSecs',  type: 'integer', default: 30,
    scope: ['server', 'settings', 'runtime'], group: 'voice', label: 'Max utterance (s)',
    validate: v => v >= 1 && v <= 120 ? null : '1..120' });

// ──────────────────────────────────────────────────────────────────────
// Proactive outreach
// ──────────────────────────────────────────────────────────────────────
R({ key: 'proactive.enabled',         type: 'boolean', default: true, envVar: 'SPORE_PROACTIVE_ENABLED',
    scope: ['server', 'settings', 'runtime'], group: 'proactive' });
R({ key: 'proactive.cooldownMinutes', type: 'integer', default: 60, envVar: 'SPORE_PROACTIVE_COOLDOWN',
    scope: ['server', 'settings', 'runtime'], group: 'proactive',
    validate: v => v >= 1 ? null : 'must be ≥1' });
R({ key: 'proactive.maxPerDay',       type: 'integer', default: 5, envVar: 'SPORE_PROACTIVE_MAX_DAY',
    scope: ['server', 'settings', 'runtime'], group: 'proactive',
    validate: v => v >= 1 ? null : 'must be ≥1' });
R({ key: 'proactive.channels',        type: 'array<string>', default: [], envVar: 'SPORE_PROACTIVE_CHANNELS',
    scope: ['server', 'settings', 'runtime'], group: 'proactive' });

// ──────────────────────────────────────────────────────────────────────
// Channels — Telegram, Slack, Discord
// ──────────────────────────────────────────────────────────────────────
R({ key: 'channels.telegram.enabled',         type: 'boolean', default: false,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.botToken',        type: 'secret', default: null, envVar: 'TELEGRAM_BOT_TOKEN',
    secret: true, scope: ['server', 'settings', 'runtime'], group: 'channels',
    legacyAlias: ['telegramBotToken'] });
R({ key: 'channels.telegram.dmPolicy',        type: 'enum', default: 'pairing',
    enum: ['pairing', 'open', 'closed'], scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.groupPolicy',     type: 'enum', default: 'open',
    enum: ['open', 'allowlist', 'closed'], scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.allowFrom',       type: 'array<string>', default: [],
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.groupAllowFrom',  type: 'array<string>', default: [],
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.requireMention',  type: 'boolean', default: true,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.streaming',       type: 'enum', default: 'partial',
    enum: ['off', 'partial', 'on'], scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.textChunkLimit',  type: 'integer', default: 4000,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.chunkMode',       type: 'enum', default: 'length',
    enum: ['length', 'sentence'], scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.telegram.reactions',       type: 'boolean', default: false,
    scope: ['server', 'settings'], group: 'channels' });

R({ key: 'channels.slack.enabled',         type: 'boolean', default: false,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.slack.botToken',        type: 'secret', default: null, envVar: 'SLACK_BOT_TOKEN',
    secret: true, scope: ['server', 'settings', 'runtime'], group: 'channels' });
R({ key: 'channels.slack.appToken',        type: 'secret', default: null, envVar: 'SLACK_APP_TOKEN',
    secret: true, scope: ['server', 'settings', 'runtime'], group: 'channels' });
R({ key: 'channels.slack.requireMention',  type: 'boolean', default: true,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.slack.textChunkLimit',  type: 'integer', default: 3000,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.slack.dmPolicy',        type: 'enum', default: 'open',
    enum: ['pairing', 'open', 'closed'], scope: ['server', 'settings'], group: 'channels' });

R({ key: 'channels.discord.token',         type: 'secret', default: null, envVar: 'DISCORD_TOKEN',
    secret: true, scope: ['server', 'settings', 'runtime'], group: 'channels',
    legacyAlias: ['discordToken'] });
R({ key: 'channels.discord.maxMessageLength', type: 'integer', default: 2000,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.discord.typingInterval',   type: 'integer', default: 5000,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.discord.maxQueuePerChannel', type: 'integer', default: 3,
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.discord.messageDebounceMs', type: 'integer', default: 800, envVar: 'SPORE_DEBOUNCE_MS',
    scope: ['server', 'settings'], group: 'channels' });
R({ key: 'channels.discord.admins',           type: 'array<string>', default: [], envVar: 'SPORE_DISCORD_ADMINS',
    scope: ['server', 'settings'], group: 'channels' });

// ──────────────────────────────────────────────────────────────────────
// Privacy (single nested-object def — too complex to flatten cleanly)
// ──────────────────────────────────────────────────────────────────────
R({ key: 'privacy', type: 'json',
    default: {
      default: { private: false, learn: true, shareToFeed: true, respond: true },
      platforms: {},
      sources: {},
    },
    scope: ['server', 'settings', 'runtime'], group: 'privacy' });

// ──────────────────────────────────────────────────────────────────────
// Agent loop
// ──────────────────────────────────────────────────────────────────────
R({ key: 'agentTimeoutMs',                  type: 'integer', default: 1800000,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'intermediateTextThrottleSeconds', type: 'integer', default: 30, envVar: 'SPORE_INTERMEDIATE_THROTTLE',
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'dmMaxIterations',                 type: 'integer', default: 75,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'tokenBudgetPressure',             type: 'integer', default: 120000,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'agentEffort',                     type: 'enum', default: 'balanced',
    enum: ['quick', 'balanced', 'deep'], envVar: 'SPORE_AGENT_EFFORT',
    scope: ['server', 'settings', 'runtime'], group: 'agent', label: 'Agent effort',
    coerce: v => String(v).toLowerCase() });
R({ key: 'maxSubagentChildren',             type: 'integer', default: 8,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'subagentMaxIter',                 type: 'integer', default: 100,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'subagentTimeoutSeconds',          type: 'integer', default: 3600,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'subagentMaxTokens',               type: 'integer', default: null, envVar: 'SPORE_SUBAGENT_MAX_TOKENS',
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'lullMaxIterations',               type: 'integer', default: 4,
    scope: ['server', 'settings'], group: 'agent' });
R({ key: 'openaiReasoningEffort',           type: 'string', default: null, envVar: 'SPORE_OPENAI_REASONING_EFFORT',
    scope: ['server', 'settings', 'runtime'], group: 'agent' });
R({ key: 'casualMessageBudget',             type: 'integer', default: null, envVar: 'SPORE_CASUAL_MESSAGE_BUDGET',
    scope: ['server', 'settings'], group: 'agent',
    validate: v => v == null || v > 0 ? null : 'must be > 0' });
R({ key: 'complexMessageBudget',            type: 'integer', default: null, envVar: 'SPORE_COMPLEX_MESSAGE_BUDGET',
    scope: ['server', 'settings'], group: 'agent',
    validate: v => v == null || v > 0 ? null : 'must be > 0' });
R({ key: 'maxToolResultChars',              type: 'integer', default: null, envVar: 'SPORE_MAX_TOOL_RESULT_CHARS',
    scope: ['server', 'settings'], group: 'agent',
    validate: v => v == null || v > 0 ? null : 'must be > 0' });
R({ key: 'loopDetection',                   type: 'json',
    default: { warn: 8, critical: 15, pingPong: 8, ceiling: 200, budgetPressure: 60 },
    scope: ['server', 'settings'], group: 'agent' });

// ──────────────────────────────────────────────────────────────────────
// Sessions + compaction
// ──────────────────────────────────────────────────────────────────────
R({ key: 'maxSessionMessages',       type: 'integer', default: 200,
    scope: ['server', 'settings'], group: 'sessions' });
R({ key: 'sessionIdleTimeoutMinutes',type: 'integer', default: 60,
    scope: ['server', 'settings'], group: 'sessions' });
R({ key: 'sessionDailyResetHour',    type: 'integer', default: 4,
    scope: ['server', 'settings'], group: 'sessions',
    validate: v => v >= 0 && v <= 23 ? null : '0..23' });
R({ key: 'maxTokens',                type: 'integer', default: 16384,
    scope: ['server', 'settings'], group: 'sessions' });
R({ key: 'contextWindow',            type: 'integer', default: 200000, envVar: 'SPORE_CONTEXT_WINDOW',
    scope: ['server', 'settings'], group: 'sessions' });
R({ key: 'compactTokenThreshold',    type: 'integer', default: 120000, envVar: 'SPORE_COMPACT_THRESHOLD',
    scope: ['server', 'settings'], group: 'sessions' });

// ──────────────────────────────────────────────────────────────────────
// Learning + recall
// ──────────────────────────────────────────────────────────────────────
R({ key: 'learningMode',       type: 'enum', default: 'always',
    enum: ['always', 'flush_only', 'disabled'], envVar: 'SPORE_LEARNING_MODE',
    scope: ['server', 'settings', 'runtime'], group: 'learning' });
R({ key: 'maintainerIdleOnly', type: 'boolean', default: false, envVar: 'SPORE_MAINTAINER_IDLE_ONLY',
    scope: ['server', 'settings'], group: 'learning' });
R({ key: 'enhancedRecall',     type: 'boolean', default: false,
    scope: ['server', 'settings', 'runtime'], group: 'learning', label: 'Enhanced recall' });

// ──────────────────────────────────────────────────────────────────────
// Prompt budgets
// ──────────────────────────────────────────────────────────────────────
R({ key: 'sectionBudgets',    type: 'json',    default: {}, envVar: 'SPORE_SECTION_BUDGETS',
    scope: ['server', 'settings', 'runtime'], group: 'budgets' });
R({ key: 'totalPromptBudget', type: 'integer', default: null, envVar: 'SPORE_TOTAL_BUDGET',
    scope: ['server', 'settings', 'runtime'], group: 'budgets',
    validate: v => v == null || v > 0 ? null : 'must be > 0' });

// ──────────────────────────────────────────────────────────────────────
// Heartbeat
// ──────────────────────────────────────────────────────────────────────
R({ key: 'heartbeatIntervalMinutes', type: 'integer', default: 45, envVar: 'SPORE_HEARTBEAT_MINUTES',
    scope: ['server', 'settings'], group: 'heartbeat' });

// ──────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────
R({ key: 'healthPort',     type: 'integer', default: 18790, envVar: 'SPORE_HEALTH_PORT',
    scope: ['server', 'bootstrap'], group: 'health' });
R({ key: 'healthBindAddr', type: 'string',  default: '0.0.0.0', envVar: 'HEALTH_BIND_ADDR',
    scope: ['server', 'bootstrap'], group: 'health' });

// ──────────────────────────────────────────────────────────────────────
// Janitor + temp nodes
// ──────────────────────────────────────────────────────────────────────
R({ key: 'tempNodeTtlHours',          type: 'number',  default: 48, envVar: 'SPORE_TEMP_NODE_TTL_HOURS',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'janitorMode',               type: 'enum',    default: 'moderate',
    enum: ['conservative', 'moderate', 'aggressive'], envVar: 'SPORE_JANITOR_MODE',
    scope: ['server', 'settings'], group: 'janitor',
    coerce: v => String(v).toLowerCase() });
R({ key: 'janitorIntervalMinutes',    type: 'integer', default: 360, envVar: 'SPORE_JANITOR_INTERVAL_MINUTES',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'janitorRecycleBinTtlDays',  type: 'integer', default: 14, envVar: 'SPORE_JANITOR_RECYCLE_BIN_TTL_DAYS',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v >= 0 ? null : 'must be ≥ 0' });
R({ key: 'janitorPruneBatchSize',     type: 'integer', default: 5, envVar: 'SPORE_JANITOR_PRUNE_BATCH',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'janitorBootDelayMinutes',   type: 'integer', default: 8,
    scope: ['server', 'settings'], group: 'janitor' });
R({ key: 'janitorEnabled',            type: 'boolean', default: true, envVar: 'SPORE_JANITOR_ENABLED',
    scope: ['server', 'settings'], group: 'janitor' });
R({ key: 'graphMaintenanceEnabled',   type: 'boolean', default: true, envVar: 'SPORE_GRAPH_MAINTENANCE_ENABLED',
    scope: ['server', 'settings'], group: 'janitor' });
R({ key: 'graphMaintenanceIntervalMinutes', type: 'integer', default: 120, envVar: 'SPORE_GRAPH_MAINTENANCE_INTERVAL_MINUTES',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'graphMaintenanceBatchSize',  type: 'integer', default: 4, envVar: 'SPORE_GRAPH_MAINTENANCE_BATCH_SIZE',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'generalKbResearchEnabled', type: 'boolean', default: true, envVar: 'SPORE_GENERAL_KB_RESEARCH_ENABLED',
    scope: ['server', 'settings'], group: 'janitor' });
R({ key: 'generalKbResearchIntervalHours', type: 'number', default: 24, envVar: 'SPORE_GENERAL_KB_RESEARCH_INTERVAL_HOURS',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'generalKbResearchBatchSize', type: 'integer', default: 1, envVar: 'SPORE_GENERAL_KB_RESEARCH_BATCH_SIZE',
    scope: ['server', 'settings'], group: 'janitor',
    validate: v => v > 0 ? null : 'must be > 0' });

// ──────────────────────────────────────────────────────────────────────
// Backups
// ──────────────────────────────────────────────────────────────────────
R({ key: 'graphBackupEnabled',          type: 'boolean', default: true, envVar: 'SPORE_BACKUP_ENABLED',
    scope: ['server', 'settings'], group: 'backups' });
R({ key: 'graphBackupIntervalMinutes',  type: 'integer', default: 60, envVar: 'SPORE_BACKUP_INTERVAL_MINUTES',
    scope: ['server', 'settings'], group: 'backups',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'graphBackupRetention',        type: 'integer', default: 20, envVar: 'SPORE_BACKUP_RETENTION',
    scope: ['server', 'settings'], group: 'backups',
    validate: v => v > 0 ? null : 'must be > 0' });
R({ key: 'graphBackupDir',              type: 'string',  default: null, envVar: 'SPORE_BACKUP_DIR',
    scope: ['server', 'settings'], group: 'backups' });
R({ key: 'graphBackupOnChangeOnly',     type: 'boolean', default: true, envVar: 'SPORE_BACKUP_ON_CHANGE_ONLY',
    scope: ['server', 'settings'], group: 'backups' });

// ──────────────────────────────────────────────────────────────────────
// Cluster / Tailscale
// ──────────────────────────────────────────────────────────────────────
R({ key: 'clusterUsername',  type: 'string', default: null, envVar: 'SPORE_CLUSTER_USERNAME',
    scope: ['server', 'settings'], group: 'cluster',
    coerce: v => String(v).trim() });
R({ key: 'clusterLoginHost', type: 'string', default: null, envVar: 'SPORE_CLUSTER_LOGIN_HOST',
    scope: ['server', 'settings'], group: 'cluster',
    coerce: v => String(v).trim() });
R({ key: 'clusterTmuxPrefix',type: 'string', default: 'spore', envVar: 'SPORE_CLUSTER_TMUX_PREFIX',
    scope: ['server', 'settings'], group: 'cluster',
    coerce: v => String(v).trim() });
R({ key: 'clusterHosts',     type: 'json',   default: [], envVar: 'SPORE_CLUSTER_HOSTS',
    scope: ['server', 'settings'], group: 'cluster' });
R({ key: 'tailscaleEnabled', type: 'boolean', default: false, envVar: 'SPORE_TAILSCALE_ENABLED',
    scope: ['server', 'settings'], group: 'tailscale' });
R({ key: 'tailscaleHostname',type: 'string',  default: null, envVar: 'SPORE_TAILSCALE_HOSTNAME',
    scope: ['server', 'settings'], group: 'tailscale',
    coerce: v => String(v).trim() });

// ──────────────────────────────────────────────────────────────────────
// Filesystem access
// ──────────────────────────────────────────────────────────────────────
R({ key: 'hostReadPaths', type: 'array<string>', default: [], envVar: 'SPORE_HOST_READ_PATHS',
    scope: ['server', 'settings'], group: 'paths' });
R({ key: 'extraPaths',    type: 'array<string>', default: [], envVar: 'SPORE_EXTRA_PATHS',
    scope: ['server', 'settings'], group: 'paths' });

// ──────────────────────────────────────────────────────────────────────
// Web server + ingress
// ──────────────────────────────────────────────────────────────────────
R({ key: 'webPort',       type: 'integer', default: null, envVar: 'SPORE_WEB_PORT',
    scope: ['server', 'settings'], group: 'web',
    coerce: v => { const n = parseInt(String(v), 10); return Number.isFinite(n) && n > 0 ? n : null; } });
R({ key: 'publicUrl',     type: 'string',  default: null, envVar: 'SPORE_PUBLIC_URL',
    scope: ['server', 'settings'], group: 'web',
    coerce: v => String(v).replace(/\/+$/, '') });
R({ key: 'ingressMode',   type: 'string',  default: null, envVar: 'SPORE_INGRESS_MODE',
    scope: ['server', 'settings'], group: 'web' });
R({ key: 'ingressDomain', type: 'string',  default: null, envVar: 'SPORE_INGRESS_DOMAIN',
    scope: ['server', 'settings'], group: 'web' });
R({ key: 'ingressPath',   type: 'string',  default: null, envVar: 'SPORE_INGRESS_PATH',
    scope: ['server', 'settings'], group: 'web' });
R({ key: 'ingressHttps',  type: 'boolean', default: null, envVar: 'SPORE_INGRESS_HTTPS',
    scope: ['server', 'settings'], group: 'web' });
R({ key: 'webAuthUser',   type: 'string',  default: null, envVar: 'SPORE_WEB_AUTH_USER',
    scope: ['server', 'settings'], group: 'security' });
R({ key: 'webAuthPass',   type: 'secret',  default: null, envVar: 'SPORE_WEB_AUTH_PASS',
    secret: true, scope: ['server', 'settings'], group: 'security' });
R({ key: 'inviteKey',     type: 'secret',  default: null, envVar: 'SPORE_INVITE_KEY',
    secret: true, scope: ['server', 'settings'], group: 'security' });

// ──────────────────────────────────────────────────────────────────────
// Browser tooling
// ──────────────────────────────────────────────────────────────────────
R({ key: 'browserBackend', type: 'string', default: 'zendriver', envVar: 'SPORE_BROWSER_BACKEND',
    scope: ['server', 'wizard', 'settings', 'runtime'], group: 'browser', label: 'Browser backend',
    coerce: v => String(v).trim().toLowerCase() });

// ──────────────────────────────────────────────────────────────────────
// Manager orchestration (super-agent)
// ──────────────────────────────────────────────────────────────────────
R({ key: 'managerUrl',        type: 'string', default: 'http://spore-manager:18900', envVar: 'MANAGER_URL',
    scope: ['server'], group: 'manager' });
R({ key: 'managerServiceKey', type: 'secret', default: null, envVar: 'MANAGER_SERVICE_KEY',
    secret: true, scope: ['server'], group: 'manager' });

// ──────────────────────────────────────────────────────────────────────
// Personality / src editing
// ──────────────────────────────────────────────────────────────────────
R({ key: 'personalityEditable', type: 'boolean', default: false, envVar: 'SPORE_PERSONALITY_EDITABLE',
    scope: ['server', 'settings'], group: 'security' });
R({ key: 'srcEditable',         type: 'boolean', default: false, envVar: 'SPORE_SRC_EDITABLE',
    scope: ['server', 'settings'], group: 'security' });
R({ key: 'credentialGuard',     type: 'enum',    default: 'block',
    enum: ['block', 'warn', 'off'], envVar: 'SPORE_CREDENTIAL_GUARD',
    scope: ['server', 'settings', 'runtime'], group: 'security',
    coerce: v => String(v).toLowerCase() });

// ──────────────────────────────────────────────────────────────────────
// Plugin system
// ──────────────────────────────────────────────────────────────────────
R({ key: 'pluginsDir',       type: 'string', default: null, envVar: 'SPORE_PLUGINS_DIR',
    scope: ['server'], group: 'plugins-meta' });
R({ key: 'pluginsUserDir',   type: 'string', default: null, envVar: 'SPORE_PLUGINS_USER_DIR',
    scope: ['server'], group: 'plugins-meta' });
R({ key: 'pluginsEnabled',   type: 'boolean', default: false, envVar: 'SPORE_PLUGINS_ENABLED',
    scope: ['server', 'settings'], group: 'plugins-meta' });
R({ key: 'pluginsHotReload', type: 'boolean', default: true, envVar: 'SPORE_PLUGINS_HOT_RELOAD',
    scope: ['server', 'settings'], group: 'plugins-meta' });

// ──────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────
R({ key: 'logLevel', type: 'enum', default: 'info',
    enum: ['debug', 'info', 'warn', 'error'], envVar: 'SPORE_LOG_LEVEL',
    scope: ['server', 'settings'], group: 'logging' });

// ──────────────────────────────────────────────────────────────────────
// Appearance (theme — wizard + settings; consumed by the UI bundle)
// ──────────────────────────────────────────────────────────────────────
R({ key: 'appearance.theme', type: 'enum', default: 'dark',
    enum: ['dark', 'light'],
    scope: ['settings', 'wizard', 'runtime'], group: 'appearance', label: 'Theme',
    // Anything not explicitly 'light' lands on 'dark'. Cleans up stale
    // values from earlier multi-theme builds without rejecting saves.
    coerce: v => String(v || '').toLowerCase() === 'light' ? 'light' : 'dark' });

module.exports = {};
