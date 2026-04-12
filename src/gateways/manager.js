const { DiscordGateway } = require('./discord');
const { TelegramGateway } = require('./telegram');
const { PairingStore } = require('./pairing');
const path = require('path');

let SlackGateway = null;
try {
  ({ SlackGateway } = require('./slack'));
} catch {
  // @slack/bolt not installed — Slack gateway unavailable
}

class GatewayManager {
  constructor(config, logger, agent, tools) {
    this.config = config;
    this.log = logger;
    this.agent = agent;
    this.tools = tools;
    this.gateways = new Map();

    const dataDir = config.dataDir;
    this.pairing = new PairingStore(dataDir, logger);
    this.pairing.init();
  }

  async connectAll() {
    await this._maybeAddDiscord();
    await this._maybeAddTelegram();
    await this._maybeAddSlack();
    return this;
  }

  async _maybeAddDiscord() {
    if (!this.config.discordToken) return;
    const gateway = new DiscordGateway(this.config, this.log, this.agent);
    gateway.platformManager = this;
    const client = await gateway.connect();
    this.gateways.set('discord', gateway);
    this.tools.discord = client;
    this.tools.discordGateway = gateway;
    this.log.info('Gateway enabled: discord');
  }

  async _maybeAddTelegram() {
    const telegramCfg = this.config.channels?.telegram || {};
    if (!telegramCfg.enabled || !telegramCfg.botToken) return;
    const gateway = new TelegramGateway(this.config, this.log, this.agent, this.pairing);
    gateway.platformManager = this;
    await gateway.connect();
    this.gateways.set('telegram', gateway);
    this.log.info('Gateway enabled: telegram');
  }

  async _maybeAddSlack() {
    const slackCfg = this.config.channels?.slack || {};
    if (!slackCfg.enabled || !slackCfg.botToken || !slackCfg.appToken) return;
    if (!SlackGateway) {
      this.log.warn('Slack credentials present but @slack/bolt is not installed — run npm install');
      return;
    }
    const gateway = new SlackGateway(this.config, this.log, this.agent);
    gateway.platformManager = this;
    await gateway.connect();
    this.gateways.set('slack', gateway);
    this.log.info('Gateway enabled: slack');
  }

  listStatuses() {
    const out = {};
    for (const [name, gateway] of this.gateways.entries()) {
      out[name] = gateway.getStatus ? gateway.getStatus() : 'connected';
    }
    return out;
  }

  getGateway(platform) {
    return this.gateways.get(platform) || null;
  }

  parseTarget(input) {
    const raw = input?.target || input?.channelId || input?.chatId || null;
    if (!raw) return { platform: 'discord', id: null };
    const idx = raw.indexOf(':');
    if (idx > 0) {
      let platform = raw.slice(0, idx);
      const id = raw.slice(idx + 1);
      if (platform === 'tg') platform = 'telegram';
      if (this.gateways.has(platform)) return { platform, id };
    }
    return { platform: input?.platform || 'discord', id: raw };
  }

  async sendMessage(input) {
    const { platform, id } = this.parseTarget(input);
    const gateway = this.getGateway(platform);
    if (!gateway?.sendMessage) return { error: `Gateway unavailable for ${platform}` };

    let filePath = input.filePath || null;
    if (filePath) {
      const resolved = require('path').resolve(filePath);
      const workspace = this.config.workspacePath || process.cwd();
      if (!resolved.startsWith(workspace) && !resolved.startsWith('/tmp')) {
        return { error: `Blocked: filePath must be under ${workspace} or /tmp` };
      }
    }
    return gateway.sendMessage(id, input.content || '', filePath, input);
  }

  async readMessages(input) {
    const { platform, id } = this.parseTarget(input);
    const gateway = this.getGateway(platform);
    if (!gateway?.readMessages) return { error: `Gateway unavailable for ${platform}` };
    return gateway.readMessages(id, input.limit || 10, input);
  }

  async reactToMessage(input) {
    const { platform, id } = this.parseTarget(input);
    const gateway = this.getGateway(platform);
    if (!gateway?.reactToMessage) return { error: `Gateway unavailable for ${platform}` };
    return gateway.reactToMessage(id, input.messageId, input.emoji, input);
  }

  async editMessage(input) {
    const { platform, id } = this.parseTarget(input);
    const gateway = this.getGateway(platform);
    if (!gateway?.editMessage) return { error: `Gateway unavailable for ${platform}` };
    return gateway.editMessage(id, input.messageId, input.content, input);
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Pairing API
    if (url.pathname.startsWith('/api/pairing')) {
      return this.pairing.handleHttp(req, res);
    }

    // Telegram webhook
    if (url.pathname === (this.config.channels?.telegram?.webhookPath || '/webhooks/telegram')) {
      const gateway = this.getGateway('telegram');
      if (!gateway) {
        res.writeHead(404);
        res.end('Telegram gateway not configured');
        return true;
      }
      await gateway.handleWebhook(req, res, url);
      return true;
    }

    return false;
  }

  async disconnectAll() {
    this.pairing.close();
    for (const gateway of this.gateways.values()) {
      if (gateway.disconnect) {
        try {
          await gateway.disconnect();
        } catch (e) {
          this.log.warn(`Gateway disconnect failed: ${e.message}`);
        }
      }
    }
  }
}

module.exports = { GatewayManager };
