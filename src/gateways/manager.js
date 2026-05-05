const path = require('path');
const fs = require('fs');
const { PairingStore } = require('./pairing');

class GatewayManager {
  constructor(config, logger, agent, tools) {
    this.config = config;
    this.log = logger;
    this.agent = agent;
    this.tools = tools;
    this.gateways = new Map();
    this.meta = new Map();
    this.aliases = new Map();
    this._started = false;

    const dataDir = config.dataDir;
    this.pairing = new PairingStore(dataDir, logger);
    this.pairing.init();
  }

  registerGateway(platform, gateway, opts = {}) {
    const name = this._normalizePlatform(platform);
    if (!name) throw new Error('Gateway platform is required');
    if (!gateway || typeof gateway !== 'object') throw new Error(`Gateway ${name} must be an object`);

    if (this.gateways.has(name)) {
      this.log.warn(`[gateways] Replacing existing gateway: ${name}`);
    }

    gateway.platformManager = this;
    if (!gateway.tools && this.tools) gateway.tools = this.tools;
    this.gateways.set(name, gateway);
    this.meta.set(name, {
      platform: name,
      pluginId: opts.pluginId || null,
      label: opts.label || name,
      aliases: Array.isArray(opts.aliases) ? opts.aliases.map(a => this._normalizePlatform(a)).filter(Boolean) : [],
      connected: false,
      connectResult: null,
      channel: opts.channel || null,
    });

    for (const alias of this.meta.get(name).aliases) {
      this.aliases.set(alias, name);
    }

    this.log.info(`[gateways] Registered channel gateway: ${name}${opts.pluginId ? ` (${opts.pluginId})` : ''}`);
    return gateway;
  }

  // Compatibility with older PluginAPI.registerGateway code that treated
  // appContext.gateways like a Map.
  set(platform, gateway) {
    return this.registerGateway(platform, gateway);
  }

  async unregisterGateway(platform) {
    const name = this._normalizePlatform(platform);
    const gateway = this.gateways.get(name);
    if (!gateway) return false;
    try {
      if (typeof gateway.disconnect === 'function') await gateway.disconnect();
    } catch (e) {
      this.log.warn(`[gateways] ${name} disconnect failed during unregister: ${e.message}`);
    }
    const meta = this.meta.get(name);
    for (const alias of meta?.aliases || []) this.aliases.delete(alias);
    this.gateways.delete(name);
    this.meta.delete(name);
    this.log.info(`[gateways] Unregistered channel gateway: ${name}`);
    return true;
  }

  delete(platform) {
    this.unregisterGateway(platform).catch(e => {
      this.log.warn(`[gateways] unregister ${platform} failed: ${e.message}`);
    });
    return this.gateways.delete(this._normalizePlatform(platform));
  }

  async connectAll() {
    this._started = true;
    for (const name of this.gateways.keys()) {
      await this.connectGateway(name);
    }
    return this;
  }

  async connectGateway(platform) {
    const name = this._normalizePlatform(platform);
    const gateway = this.gateways.get(name);
    if (!gateway) return null;
    const meta = this.meta.get(name) || {};
    const currentStatus = gateway.getStatus ? gateway.getStatus() : null;
    if (meta.connected && (!currentStatus || currentStatus === 'connected')) return gateway;

    let result = null;
    if (typeof gateway.connect === 'function') {
      result = await gateway.connect();
    }

    const status = gateway.getStatus ? gateway.getStatus() : null;
    meta.connected = status ? status === 'connected' : (typeof gateway.connect !== 'function' || !!result);
    meta.connectResult = result;
    this.meta.set(name, meta);

    // Legacy compatibility for old tool paths that still inspect these.
    if (name === 'discord') {
      this.tools.discord = result || gateway.client || null;
      this.tools.discordGateway = gateway;
    }

    this.log.info(`Gateway ${meta.connected ? 'enabled' : (status || 'registered')}: ${name}`);
    return gateway;
  }

  async disconnectAll() {
    this.pairing.close();
    for (const [name, gateway] of this.gateways.entries()) {
      if (gateway.disconnect) {
        try {
          await gateway.disconnect();
        } catch (e) {
          this.log.warn(`Gateway ${name} disconnect failed: ${e.message}`);
        }
      }
    }
  }

  listStatuses() {
    const out = {};
    for (const [name, gateway] of this.gateways.entries()) {
      const meta = this.meta.get(name) || {};
      out[name] = gateway.getStatus ? gateway.getStatus() : (meta.connected ? 'connected' : 'registered');
    }
    return out;
  }

  listChannels() {
    const out = [];
    for (const [name, gateway] of this.gateways.entries()) {
      const meta = this.meta.get(name) || {};
      out.push({
        platform: name,
        label: meta.label || name,
        pluginId: meta.pluginId || null,
        status: gateway.getStatus ? gateway.getStatus() : (meta.connected ? 'connected' : 'registered'),
        aliases: meta.aliases || [],
      });
    }
    return out;
  }

  getGateway(platform) {
    return this.gateways.get(this._resolvePlatform(platform)) || null;
  }

  _normalizePlatform(value) {
    return String(value || '').trim().toLowerCase();
  }

  _resolvePlatform(value) {
    const raw = this._normalizePlatform(value);
    if (!raw) return null;
    return this.aliases.get(raw) || raw;
  }

  parseTarget(input = {}) {
    const raw = input.target || input.channelId || input.chatId || null;
    let platform = this._resolvePlatform(input.platform || null);
    if (!raw) return { platform, id: null, target: null };

    const text = String(raw);
    const idx = text.indexOf(':');
    if (idx > 0) {
      const prefixed = this._resolvePlatform(text.slice(0, idx));
      const id = text.slice(idx + 1);
      if (prefixed && this.gateways.has(prefixed)) return { platform: prefixed, id, target: text };
    }

    if (!platform && this.gateways.size === 1) {
      platform = this.gateways.keys().next().value;
    }

    return { platform, id: text, target: text };
  }

  async sendMessage(input) {
    const { platform, id } = this.parseTarget(input);
    if (!platform) return { error: 'No target platform specified and no current conversation platform available' };
    const gateway = this.getGateway(platform);
    if (!gateway?.sendMessage) return { error: `Gateway unavailable for ${platform}` };

    let filePath = input.filePath || null;
    if (filePath) {
      const workspace = this.config.workspacePath || process.cwd();
      let resolved;
      try {
        resolved = fs.realpathSync(path.resolve(filePath));
      } catch (e) {
        return { error: `Blocked: filePath does not exist or cannot be resolved: ${e.message}` };
      }
      const realWorkspace = (() => { try { return fs.realpathSync(workspace); } catch { return path.resolve(workspace); } })();
      const realTmp = (() => { try { return fs.realpathSync('/tmp'); } catch { return '/tmp'; } })();
      const inWorkspace = resolved === realWorkspace || resolved.startsWith(realWorkspace + path.sep);
      const inTmp = resolved === realTmp || resolved.startsWith(realTmp + path.sep);
      if (!inWorkspace && !inTmp) {
        return { error: `Blocked: filePath must be under ${realWorkspace} or /tmp` };
      }
      filePath = resolved;
    }

    return gateway.sendMessage(id, input.content || '', filePath, input);
  }

  async readMessages(input) {
    const { platform, id } = this.parseTarget(input);
    if (!platform) return { error: 'No target platform specified and no current conversation platform available' };
    const gateway = this.getGateway(platform);
    if (!gateway?.readMessages) return { error: `Gateway unavailable for ${platform}` };
    return gateway.readMessages(id, input.limit || 10, input);
  }

  async reactToMessage(input) {
    const { platform, id } = this.parseTarget(input);
    if (!platform) return { error: 'No target platform specified and no current conversation platform available' };
    const gateway = this.getGateway(platform);
    if (!gateway?.reactToMessage) return { error: `Gateway unavailable for ${platform}` };
    return gateway.reactToMessage(id, input.messageId, input.emoji, input);
  }

  async editMessage(input) {
    const { platform, id } = this.parseTarget(input);
    if (!platform) return { error: 'No target platform specified and no current conversation platform available' };
    const gateway = this.getGateway(platform);
    if (!gateway?.editMessage) return { error: `Gateway unavailable for ${platform}` };
    return gateway.editMessage(id, input.messageId, input.content, input);
  }

  getActiveChannelHints() {
    const hints = [];
    for (const [name, gateway] of this.gateways.entries()) {
      if (typeof gateway.getActiveChannelIds !== 'function') continue;
      for (const h of gateway.getActiveChannelIds() || []) {
        hints.push({ ...h, platform: name, _gw: name });
      }
    }
    return hints;
  }

  async notifyUser(message, opts = {}) {
    const delivered = [];
    for (const [name, gateway] of this.gateways.entries()) {
      try {
        const explicitTargets = typeof gateway.getNotificationTargets === 'function'
          ? gateway.getNotificationTargets(opts) || []
          : [];
        const targets = explicitTargets.length
          ? explicitTargets
          : (typeof gateway.getActiveChannelIds === 'function' ? (gateway.getActiveChannelIds() || []).slice(0, 1) : []);
        for (const target of targets.slice(0, opts.maxPerGateway || 1)) {
          const id = target.target || target.id || target.channelId || target.chatId;
          if (!id || typeof gateway.sendMessage !== 'function') continue;
          const result = await gateway.sendMessage(id, message, null, { notify: true, urgent: !!opts.urgent });
          if (!result?.error && result?.ok !== false) delivered.push(`${name}:${id}`);
        }
      } catch (e) {
        this.log.warn(`[notify_user] ${name} delivery failed: ${e.message}`);
      }
    }
    return delivered;
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/pairing')) {
      return this.pairing.handleHttp(req, res);
    }

    for (const gateway of this.gateways.values()) {
      if (typeof gateway.handleHttp !== 'function') continue;
      const handled = await gateway.handleHttp(req, res, url);
      if (handled) return true;
    }

    return false;
  }
}

module.exports = { GatewayManager };
