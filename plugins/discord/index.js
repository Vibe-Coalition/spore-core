const { DiscordGateway } = require('./lib/gateway');

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function toList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeConfig(host, slot = {}) {
  const legacy = host.channels?.discord || {};
  const token = String(firstDefined(slot.token, legacy.token, host.discordToken, process.env.DISCORD_TOKEN, '') || '').trim();
  const admins = firstDefined(slot.admins, legacy.admins, host.discordAdmins, process.env.SPORE_DISCORD_ADMINS, []);
  return {
    enabled: toBool(firstDefined(slot.enabled, legacy.enabled), !!token),
    token,
    admins: toList(admins),
    sessionMode: String(firstDefined(slot.sessionMode, legacy.sessionMode, 'channel') || 'channel'),
    maxMessageLength: toInt(firstDefined(slot.maxMessageLength, legacy.maxMessageLength, host.maxMessageLength), 2000),
    typingInterval: toInt(firstDefined(slot.typingInterval, legacy.typingInterval, host.typingInterval), 5000),
    maxQueuePerChannel: toInt(firstDefined(slot.maxQueuePerChannel, legacy.maxQueuePerChannel, host.maxQueuePerChannel), 3),
    messageDebounceMs: toInt(firstDefined(slot.messageDebounceMs, legacy.messageDebounceMs, host.messageDebounceMs), 800),
  };
}

function mirrorToHost(host, cfg) {
  host.channels = host.channels || {};
  host.channels.discord = {
    ...(host.channels.discord || {}),
    enabled: !!cfg.enabled,
    token: cfg.token || '',
    admins: cfg.admins || [],
    sessionMode: cfg.sessionMode || 'channel',
    maxMessageLength: cfg.maxMessageLength,
    typingInterval: cfg.typingInterval,
    maxQueuePerChannel: cfg.maxQueuePerChannel,
    messageDebounceMs: cfg.messageDebounceMs,
  };
  host.discordToken = cfg.token || null;
  host.discordAdmins = cfg.admins || [];
  host.maxMessageLength = cfg.maxMessageLength;
  host.typingInterval = cfg.typingInterval;
  host.maxQueuePerChannel = cfg.maxQueuePerChannel;
  host.messageDebounceMs = cfg.messageDebounceMs;
  host.plugins = host.plugins || {};
  host.plugins.discord = { ...(host.plugins.discord || {}), ...cfg };
}

async function reconcileGateway(api, gateway, cfg) {
  const manager = api._appContext?.gateways;
  if (!manager?._started || !gateway) return;
  if (cfg.enabled) {
    if (gateway.getStatus?.() !== 'connected') {
      await manager.connectGateway('discord');
    }
  } else if (gateway.client) {
    await gateway.disconnect();
  }
}

module.exports = function register(api) {
  const host = api.getHostConfig();
  mirrorToHost(host, normalizeConfig(host, api.getConfig()));

  api.registerSettingsPane({
    tab: 'channels',
    title: 'Discord',
    description: 'Connect a Discord bot as a channel plugin. DMs, mentions, replies, reactions, attachments, lull responses, task progress, and optional voice join/leave are handled here, not in core.',
    schema: [
      { key: 'enabled', label: 'Enable Discord channel', type: 'toggle', default: false },
      { key: 'token', label: 'Bot token', type: 'password', secret: true, envFallback: 'DISCORD_TOKEN',
        help: 'Discord bot token. Leave blank to keep the stored value.' },
      { key: 'admins', label: 'Admin user/role IDs', type: 'text', envFallback: 'SPORE_DISCORD_ADMINS',
        help: 'Comma-separated Discord user IDs or role IDs allowed to use admin commands.' },
      { key: 'sessionMode', label: 'Session mode', type: 'select', default: 'channel',
        options: [
          { value: 'channel', label: 'One session per channel/thread' },
          { value: 'user', label: 'One session per user per channel' },
        ],
        help: 'Controls how Discord conversations map to agent memory sessions.' },
      { key: 'maxMessageLength', label: 'Max message length', type: 'number', default: 2000 },
      { key: 'typingInterval', label: 'Typing refresh ms', type: 'number', default: 5000 },
      { key: 'maxQueuePerChannel', label: 'Max queued turns/channel', type: 'number', default: 3 },
      { key: 'messageDebounceMs', label: 'Message debounce ms', type: 'number', default: 800 },
    ],
  });

  const gateway = api.registerChannelGateway('discord', ({ config, log, agent }) => new DiscordGateway(config, log, agent), {
    label: 'Discord',
    aliases: ['dc'],
  });

  api.onConfigChange(async (newCfg) => {
    const cfg = normalizeConfig(host, { ...api.getConfig(), ...newCfg });
    mirrorToHost(host, cfg);
    await reconcileGateway(api, gateway, cfg);
  });

  api.onShutdown(() => gateway.disconnect?.());
};
