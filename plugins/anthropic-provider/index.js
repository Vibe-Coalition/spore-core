// anthropic-provider plugin — Anthropic Claude chat completions.
//
// Last vendor extraction. After this plugin is loaded, core's
// `src/providers/index.js` has zero in-tree backends — every model
// string routes through a plugin. The walker's anthropic fallback
// is preserved for safety while the plugin is uninstalled, but with
// the plugin installed it always wins (longest-prefix rule).
//
// Owns @anthropic-ai/sdk in its own package.json (this plugin's
// node_modules). Core's package.json drops the dep entirely.

const { createAnthropicClient } = require('./lib/anthropic-client');

function backfillLegacyConfig(api) {
  const current = api.getConfig();
  if (Object.keys(current).length > 0) return;
  const host = api.getHostConfig();
  const apiKey = host?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    api.setConfig({ apiKey })
      .catch(e => api.getLogger().warn('legacy backfill failed: ' + e.message));
    api.getLogger().info('Migrated legacy ANTHROPIC_API_KEY into plugins.anthropic-provider.apiKey');
  }
}

module.exports = function register(api) {
  api.registerReferenceNodes({
    install:   './sql/install.sql',
    uninstall: './sql/uninstall.sql',
    schemaVersion: 1,
  });

  backfillLegacyConfig(api);

  api.registerProvider('anthropic', (config) => {
    const slot = config?.plugins?.['anthropic-provider'] || {};
    const apiKey = slot.apiKey || config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
    return createAnthropicClient({
      apiKey,
      displayName: config.displayName || 'SPORE',
      apiTimeoutMs: config.apiTimeoutMs || 120000,
    });
  }, {
    prefixes: ['claude'],
    capabilities: { tools: true, vision: true, audio: false, video: false },
    isConfigured: (config) => {
      const slot = config?.plugins?.['anthropic-provider'] || {};
      return !!(slot.apiKey || config?.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
    },
  });

  api.registerSettingsPane({
    title: 'Anthropic (Claude)',
    description: 'Claude Opus / Sonnet / Haiku via api.anthropic.com. Use model strings like `claude-haiku-4-5` (no prefix needed) in tier routing. Supports both standard API keys and Claude.ai OAuth tokens (sk-ant-oat-…).',
    schema: [
      { key: 'apiKey', label: 'ANTHROPIC_API_KEY', type: 'password', secret: true,
        help: 'Standard sk-ant-api03-… key OR Claude.ai OAuth token (sk-ant-oat-…) from Pro / Max plans.' },
    ],
  });

  api.onConfigChange((newCfg) => {
    // Only mirror non-empty values. Empty form input = "leave alone".
    if (!newCfg.apiKey) return;
    const host = api.getHostConfig();
    host.anthropicApiKey = newCfg.apiKey;
    try {
      const gw = api._appContext?.tools?.gateway;
      if (gw && typeof gw._applyEnvUpdates === 'function') {
        gw._applyEnvUpdates({ ANTHROPIC_API_KEY: newCfg.apiKey });
      }
    } catch (e) { api.getLogger().warn('ANTHROPIC env mirror failed: ' + e.message); }
  });

  api.registerWebRoute('POST', '/test', async (req, res) => {
    const slot = api.getConfig();
    const host = api.getHostConfig();
    const apiKey = slot.apiKey || host.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key configured' }));
      return;
    }
    try {
      const t0 = Date.now();
      const client = createAnthropicClient({ apiKey, apiTimeoutMs: 10000 });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Respond with a single word: ok' }],
      });
      const text = (resp.content || []).find(b => b.type === 'text')?.text || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, latency_ms: Date.now() - t0, model: 'claude-haiku-4-5', excerpt: text.slice(0, 80) }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
    }
  });

  api.getLogger().info(`Plugin ready — provider 'anthropic' (prefix: claude) registered.`);
};
