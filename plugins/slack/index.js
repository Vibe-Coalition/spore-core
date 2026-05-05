const { SlackGateway } = require('./lib/gateway');

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

function normalizeConfig(host, slot = {}) {
  const legacy = host.channels?.slack || {};
  const botToken = String(firstDefined(slot.botToken, legacy.botToken, host.slackBotToken, process.env.SLACK_BOT_TOKEN, '') || '').trim();
  const appToken = String(firstDefined(slot.appToken, legacy.appToken, host.slackAppToken, process.env.SLACK_APP_TOKEN, '') || '').trim();
  return {
    enabled: toBool(firstDefined(slot.enabled, legacy.enabled), !!(botToken && appToken)),
    botToken,
    appToken,
    requireMention: toBool(firstDefined(slot.requireMention, legacy.requireMention), true),
    textChunkLimit: toInt(firstDefined(slot.textChunkLimit, legacy.textChunkLimit), 3000),
    dmPolicy: String(firstDefined(slot.dmPolicy, legacy.dmPolicy, 'open') || 'open'),
    sessionMode: String(firstDefined(slot.sessionMode, legacy.sessionMode, 'channel') || 'channel'),
  };
}

function mirrorToHost(host, cfg) {
  host.channels = host.channels || {};
  host.channels.slack = {
    ...(host.channels.slack || {}),
    ...cfg,
  };
  host.slackBotToken = cfg.botToken || null;
  host.slackAppToken = cfg.appToken || null;
  host.plugins = host.plugins || {};
  host.plugins.slack = { ...(host.plugins.slack || {}), ...cfg };
}

async function reconcileGateway(api, gateway, cfg) {
  const manager = api._appContext?.gateways;
  if (!manager?._started || !gateway) return;
  if (cfg.enabled) {
    if (gateway.getStatus?.() !== 'connected') {
      await manager.connectGateway('slack');
    }
  } else if (gateway.app) {
    await gateway.disconnect();
  }
}

module.exports = function register(api) {
  const host = api.getHostConfig();
  mirrorToHost(host, normalizeConfig(host, api.getConfig()));

  api.registerSettingsPane({
    tab: 'channels',
    title: 'Slack',
    description: 'Connect Slack through Socket Mode as a channel plugin. Supports DMs, mentions, threads, file uploads, reactions, task progress, and optional thread-scoped sessions.',
    schema: [
      { key: 'enabled', label: 'Enable Slack channel', type: 'toggle', default: false },
      { key: 'botToken', label: 'Bot token', type: 'password', secret: true, envFallback: 'SLACK_BOT_TOKEN',
        help: 'xoxb-... Bot User OAuth Token. Leave blank to keep the stored value.' },
      { key: 'appToken', label: 'App token', type: 'password', secret: true, envFallback: 'SLACK_APP_TOKEN',
        help: 'xapp-... App-level token for Socket Mode.' },
      { key: 'requireMention', label: 'Require mention in channels', type: 'toggle', default: true },
      { key: 'dmPolicy', label: 'DM policy', type: 'select', default: 'open',
        options: [
          { value: 'open', label: 'Allow DMs' },
          { value: 'block', label: 'Block DMs' },
        ] },
      { key: 'sessionMode', label: 'Session mode', type: 'select', default: 'channel',
        options: [
          { value: 'channel', label: 'One session per channel' },
          { value: 'thread', label: 'One session per Slack thread' },
        ],
        help: 'Use thread mode if you want each Slack thread to be its own memory session.' },
      { key: 'textChunkLimit', label: 'Text chunk limit', type: 'number', default: 3000 },
    ],
  });

  const gateway = api.registerChannelGateway('slack', ({ config, log, agent }) => new SlackGateway(config, log, agent), {
    label: 'Slack',
  });

  api.onConfigChange(async (newCfg) => {
    const cfg = normalizeConfig(host, { ...api.getConfig(), ...newCfg });
    mirrorToHost(host, cfg);
    await reconcileGateway(api, gateway, cfg);
  });

  api.onShutdown(() => gateway.disconnect?.());
};
